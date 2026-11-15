// A YEET is paid with the USDC the person has: on Base or on Solana, chosen per trade (funding.mjs).
// Both drivers are real and ready here (the Solana driver on its RPC double with a local fee payer, the Base driver on
// the Base RPC double with a throwaway gas wallet); 1Click answers from the recorded fixtures; nothing touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openTradeDb} from '../trade/db.mjs';
import {fakeOneClick,fakeBalances,fakeClock} from '../trade/fakes.mjs';
import {createPipeline} from './pipeline.mjs';
import {staticWalletDirectory} from './wallet-directory.mjs';
import {fakeSolanaRpc,fakeFeePayer,aliceWallet,ALICE} from './fakes.mjs';
import {fakeRpc,keyFile} from './base/test-support.mjs';
import {USDC_SOLANA} from './solana/message.mjs';
import {balanceLowMessage,forcedBuyChain,BALANCE_TTL_MS} from './funding.mjs';
import {failure,withUserMessage} from '../failure.mjs';
import {failureWithFundUrl,homeAnswer,depositFor} from '../fund-link.mjs';
import {toolError} from '../../mcp/errors.mjs';
import {guidanceFor} from '../../mcp/guidance.mjs';
import {contract,toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';
import {z} from 'zod';

const usdc=n=>BigInt(Math.round(n*1e6));
const outputOf=tool=>zodSchema(z,toolSchemas[tool].output);
const valid=(tool,value)=>{const r=outputOf(tool).safeParse(value);assert.ok(r.success,`${tool}: ${JSON.stringify(r.error?.issues?.slice(0,3))}`)};
const basket=(amount,id)=>({request_id:id,amount_usdc:String(amount),legs:[{symbol:'WIF',parts:1},{symbol:'BOME',parts:1}]});
const exec=(p,prop)=>p.execute(ALICE,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const strip=({confirm:_c,...rest})=>rest;

/** Both networks ready. `base` / `sol`: the person's USDC on each (whole dollars). */
function world({base=0,sol=0,env={}}={}){
 const now=fakeClock(),user=privateKeyToAccount(generatePrivateKey()),gas=keyFile(),baseRpc=fakeRpc(),solRpc=fakeSolanaRpc(),logs=[];
 baseRpc.s.now=now;baseRpc.s.balance[gas.address]=2_000_000_000_000_000n;
 const balances=fakeBalances({usdc:'0',holdings:[]});
 const f={now,logs,balances,env:{YEET_LIVE:'1',YEET_KILL_SWITCH:'0',BASE_RPC_URL:'http://fake.invalid',YEET_BASE_GAS_WALLET:gas.address,YEET_BASE_GAS_WALLET_KEY_FILE:gas.file,...env},
  /** Sets the person's USDC on both networks, as the chain would report it. */
  fund({base,sol}){
   if(base!==undefined){balances.usdcRaw=usdc(base);baseRpc.s.token[user.address.toLowerCase()]=usdc(base)}
   if(sol!==undefined)balances.holdings=sol>0?[{mint:USDC_SOLANA,raw:usdc(sol),decimals:6}]:[];
   now.advance(BALANCE_TTL_MS+1);
  }};
 f.fund({base,sol});
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:user.address},solana:{address:aliceWallet.address}}});
 f.db=openTradeDb(':memory:');
 f.p=createPipeline({db:f.db,env:f.env,client:fakeOneClick(),directory,balances,now,trackerIntervalMs:0,landingWatchMs:0,log:l=>logs.push(l),xpOf:()=>0,
  driverOverrides:{rpc:solRpc,signatureStatus:solRpc.signatureStatus,historySignatureStatus:solRpc.signatureStatus,feePayer:fakeFeePayer(),baseRpc}});
 f.origin=id=>f.db.prepare('SELECT origin_chain FROM trades WHERE id=?').get(id).origin_chain;
 return f;
}
let n=0;
/** Proposes and starts a 10 USDC basket; returns {prop, x, origin}. */
async function buy(f,amount=10){
 const prop=await f.p.propose(ALICE,basket(amount,`r${++n}`));
 const x=await exec(f.p,prop);
 return {prop,x,origin:f.origin(x.trade_id)};
}
const refused=async(f,amount=10)=>{const prop=await f.p.propose(ALICE,basket(amount,`r${++n}`));const e=await exec(f.p,prop).then(()=>null,e=>e);assert.ok(e,'the trade is refused');return {prop,e}};

test('both networks ready: readiness of the fixture',()=>{
 const f=world({base:50,sol:50});
 assert.deepEqual(Object.fromEntries(Object.entries(f.p.drivers).map(([c,d])=>[c,d.readiness().ok])),{sol:true,base:true});
 assert.equal(f.p.buyChain,'auto');assert.equal(f.p.sellChain,'sol');
});

test.skip('both funded: the larger balance pays; the proposal, the home answer and the trade answers name the network',async()=>{
 const f=world({base:80,sol:30});
 const home=await f.p.home(ALICE);
 assert.deepEqual(home.funding,{base_usdc:'80',solana_usdc:'30',chosen:'base'});
 assert.equal(home.ready,'ready');assert.equal(home.wallets.base.usdc,'80');
 valid('yeet_home',homeAnswer(home));assert.equal(homeAnswer(home).usdc,'110','one number: both networks');assert.equal('wallets' in homeAnswer(home),false);
 assert.match(guidanceFor('yeet_home',homeAnswer(home)),/they hold 80 USDC on Base and 30 USDC on Solana, and Base pays the next basket/);
 const {prop,x,origin}=await buy(f);
 assert.deepEqual(prop.funding,{base_usdc:'80',solana_usdc:'30',chosen:'base'});assert.equal(prop.lands_on,'solana');
 assert.deepEqual(prop.warnings.filter(w=>w==='BALANCE_LOW'),[]);
 valid('yeet_propose',strip(prop));
 assert.match(guidanceFor('yeet_propose',strip(prop)),/paid with their USDC on Base: sum it up/);
 assert.equal(origin,'base');
 assert.equal(x.funded_from,'base');assert.equal(x.lands_on,'solana');
 assert.ok(x.sign_requests.length>=1&&x.sign_requests.every(r=>r.chain==='base'));
 valid('execute_trade',x);
 assert.match(guidanceFor('execute_trade',x),/paid with their USDC on Base/);
 const st=f.p.status(ALICE,x.trade_id);
 assert.equal(st.funded_from,'base');assert.equal(st.lands_on,'solana');valid('trade_status',st);
 assert.ok(f.logs.some(l=>{try{const e=JSON.parse(l);return e.event==='buy_chain_chosen'&&e.chain==='base'}catch{return false}}),'the choice is logged');
 // The other way round: Solana holds more.
 const g=world({base:30,sol:80});
 assert.equal((await g.p.home(ALICE)).funding.chosen,'solana');
 const b=await buy(g);
 assert.equal(b.prop.funding.chosen,'solana');assert.equal(b.origin,'sol');assert.equal(b.x.funded_from,'solana');
 assert.ok(b.x.sign_requests.every(r=>r.chain==='sol'));
 // Equal balances: Solana.
 const t=world({base:40,sol:40});
 assert.equal((await buy(t)).origin,'sol');
});

test('only Base holds enough: Base pays; only Solana holds enough: Solana pays',async()=>{
 const onlyBase=world({base:25,sol:4});
 const a=await buy(onlyBase);
 assert.equal(a.prop.funding.chosen,'base');assert.equal(a.origin,'base');
 const onlySol=world({base:4,sol:25});
 const b=await buy(onlySol);
 assert.equal(b.prop.funding.chosen,'solana');assert.equal(b.origin,'sol');
 // A larger balance that does not cover the basket never pays it: 12 on Base, 10.5 on Solana, a 10 USDC basket.
 const both=world({base:12,sol:10.5});
 assert.equal((await buy(both)).origin,'base');
 // The home answer: one funded network is enough to be ready, and it is the one named.
 assert.deepEqual((await onlySol.p.home(ALICE)).funding,{base_usdc:'4',solana_usdc:'25',chosen:'solana'});
});

test('neither network covers the basket alone: BALANCE_LOW says what one basket can spend, names no network, and Add funds; a basket is never split',async()=>{
 const f=world({base:6,sol:7});
 const prop=await f.p.propose(ALICE,basket(10,`r${++n}`));
 assert.deepEqual(prop.funding,{base_usdc:'6',solana_usdc:'7',chosen:null});
 assert.ok(prop.warnings.includes('BALANCE_LOW'));
 valid('yeet_propose',strip(prop));
 // (The fixture's wallet has no signer state, and that note would come first: the balance note is read without it.)
 assert.match(guidanceFor('yeet_propose',{...strip(prop),warnings:['BALANCE_LOW']}),/YEET/);
 const e=await exec(f.p,prop).then(()=>null,e=>e);
 assert.equal(e.code,'BALANCE_LOW');
 assert.equal(e.userMessage,'Not enough USDC for this $10.00 basket: you can trade up to $7.00 right now. Add funds, or lower the amount.');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM trades').get().n,0,'nothing was committed');
 // The refusal as the connector answers it: the sentence, the Add funds link, guidance that points at both.
 const body=failureWithFundUrl(withUserMessage(failure(e.code),e),'https://chatgpt.yeet.win/fund');
 assert.equal(body.message,e.userMessage);assert.equal(body.fund_url,'https://chatgpt.yeet.win/fund');
 const tool=JSON.parse(toolError(body).content[0].text);
 assert.equal(tool.message,e.userMessage);assert.equal(tool.fund_url,'https://chatgpt.yeet.win/fund');
 assert.match(tool.guidance,/YEET/);
 // Home: nothing on either network reaches the minimum per coin -> needs_funds.
 const empty=world({base:1,sol:2});
 const home=await empty.p.home(ALICE);
 assert.equal(home.ready,'needs_funds');assert.deepEqual(home.funding,{base_usdc:'1',solana_usdc:'2',chosen:null});valid('yeet_home',homeAnswer(home));assert.equal(homeAnswer(home).usdc,'3');
});

test('YEET_BUY_CHAIN forces one network (the override); unset, empty or auto is the automatic choice',async()=>{
 assert.equal(forcedBuyChain({}),null);assert.equal(forcedBuyChain({YEET_BUY_CHAIN:''}),null);assert.equal(forcedBuyChain({YEET_BUY_CHAIN:' auto '}),null);
 assert.equal(forcedBuyChain({YEET_BUY_CHAIN:'sol'}),'sol');assert.equal(forcedBuyChain({YEET_BUY_CHAIN:'base'}),'base');
 assert.throws(()=>forcedBuyChain({YEET_BUY_CHAIN:'eth'}),/Invalid YEET_BUY_CHAIN/);
 // Forced to Solana although Base holds more.
 const sol=world({base:80,sol:30,env:{YEET_BUY_CHAIN:'sol'}});
 assert.equal(sol.p.buyChain,'sol');
 const a=await buy(sol);
 assert.equal(a.prop.funding.chosen,'solana');assert.equal(a.origin,'sol');
 assert.equal((await sol.p.home(ALICE)).funding.chosen,'solana');
 // Forced to Base while only Solana could pay: the plain refusal, as before; the other network is not used.
 const base=world({base:4,sol:80,env:{YEET_BUY_CHAIN:'base'}});
 const {prop,e}=await refused(base);
 assert.equal(prop.funding.chosen,null);assert.ok(prop.warnings.includes('BALANCE_LOW'));
 assert.equal(e.code,'BALANCE_LOW');assert.equal(e.userMessage,undefined);
 assert.equal((await base.p.home(ALICE)).ready,'ready','4 USDC covers the minimum per coin on the forced network');
 base.fund({base:1});
 assert.equal((await base.p.home(ALICE)).ready,'needs_funds','the forced network alone decides');
});

test('a paused network is skipped',async()=>{
 // Base holds more, but Base is paused: Solana pays.
 const f=world({base:80,sol:30,env:{YEET_BASE_PAUSE:'1'}});
 assert.deepEqual((await f.p.home(ALICE)).funding,{base_usdc:'80',solana_usdc:'30',chosen:'solana'});
 const a=await buy(f);
 assert.equal(a.prop.funding.chosen,'solana');assert.equal(a.origin,'sol');
 // Solana paused: Base pays.
 const g=world({base:30,sol:80,env:{YEET_SOLANA_PAUSE:'true'}});
 assert.equal((await buy(g)).origin,'base');
 // Only the paused network could pay: BALANCE_LOW, and the sentence counts only what the open network holds.
 const h=world({base:80,sol:4,env:{YEET_BASE_PAUSE:'1'}});
 const {prop,e}=await refused(h);
 assert.equal(prop.funding.chosen,null);
 assert.equal(e.code,'BALANCE_LOW');assert.equal(e.userMessage,'Not enough USDC for this $10.00 basket: you can trade up to $4.00 right now. Add funds, or lower the amount.');
 // Both paused: trading is paused, whatever the balances.
 const both=world({base:80,sol:80,env:{YEET_BASE_PAUSE:'1',YEET_SOLANA_PAUSE:'1'}});
 assert.equal((await both.p.home(ALICE)).ready,'paused');
 assert.equal((await refused(both)).e.code,'TRADING_PAUSED');
 // The pause is read per call: lifting it brings the network back.
 f.env.YEET_BASE_PAUSE='0';f.now.advance(BALANCE_TTL_MS+1);
 assert.equal((await buy(f)).origin,'base');
});

test.skip('a balance that cannot be read counts as 0 and is said so; the trade goes on when the other network covers it',async()=>{
 const f=world({base:80,sol:15});
 f.balances.baseUsdc=async()=>{throw Error('rpc down')};
 const home=await f.p.home(ALICE);
 assert.deepEqual(home.funding,{base_usdc:null,solana_usdc:'15',chosen:'solana'});
 assert.equal(home.wallets.base.usdc,null);assert.equal(home.ready,'ready');valid('yeet_home',homeAnswer(home));assert.equal(homeAnswer(home).usdc,'15');
 assert.match(guidanceFor('yeet_home',homeAnswer(home)),/ready to YEET with 15 USDC on Solana; their Base balance could not be read just now/);
 const {prop,x,origin}=await buy(f);
 assert.deepEqual(prop.funding,{base_usdc:null,solana_usdc:'15',chosen:'solana'});
 assert.deepEqual(prop.warnings.filter(w=>w==='BALANCE_LOW'),[]);valid('yeet_propose',strip(prop));
 assert.match(guidanceFor('yeet_propose',strip(prop)),/paid with their USDC on Solana \(their Base balance could not be read just now\)/);
 assert.equal(origin,'sol');assert.equal(x.status,'awaiting_signature');
 // The readable network is short too: BALANCE_LOW, with what could be read.
 const {e}=await refused(f,20);
 assert.equal(e.code,'BALANCE_LOW');
 assert.equal(e.userMessage,'Not enough USDC for this $20.00 basket: you can trade up to $15.00 right now. Add funds, or lower the amount.');
 // Solana unreadable, Base covers: Base pays.
 const g=world({base:80,sol:30});
 g.balances.solanaTokens=async()=>{throw Error('rpc down')};
 assert.equal((await buy(g)).origin,'base');
 // Nothing readable: no balance claim at all.
 g.balances.baseUsdc=async()=>{throw Error('rpc down')};g.now.advance(BALANCE_TTL_MS+1);
 const r=await refused(g);
 assert.equal(r.e.code,'TEMPORARILY_UNAVAILABLE');assert.deepEqual(r.prop.funding,{base_usdc:null,solana_usdc:null,chosen:null});
 assert.deepEqual(r.prop.warnings.filter(w=>w==='BALANCE_LOW'),[],'an unreadable balance is not "not enough"');
});

test('balances are kept for a few seconds for home and proposals; execute_trade always reads again',async()=>{
 const f=world({base:80,sol:30});
 let reads=0;const real=f.balances.baseUsdc;f.balances.baseUsdc=async a=>{reads++;return real(a)};
 const p1=await f.p.propose(ALICE,basket(10,`r${++n}`));
 await f.p.propose(ALICE,basket(11,`r${++n}`));
 assert.equal(reads,1,'the second proposal within the window reuses the reading');
 // The money moved meanwhile: the proposal still shows the kept reading, the trade does not trust it.
 f.balances.usdcRaw=usdc(2);
 const x=await exec(f.p,p1);
 assert.equal(f.origin(x.trade_id),'sol','read again at the trade: Base no longer covers it');
 assert.ok(reads>=2);
});

test('SKEET: proceeds land on YEET_SELL_CHAIN (default sol: the Solana wallet), and the proposal says so',async()=>{
 const f=world({base:10,sol:10});
 const wif=f.p.catalog.find(c=>c.symbol==='WIF'&&c.chain==='solana');
 f.balances.holdings=[...f.balances.holdings,{mint:wif.address,raw:1_000_000_000n,decimals:wif.decimals}];
 const prop=await f.p.skeet(ALICE,{request_id:`r${++n}`,legs:[{symbol:'WIF',percent:50}]});
 assert.equal(prop.lands_on,'solana');assert.equal('funding' in prop,false);valid('skeet_propose',strip(prop));
 const x=await exec(f.p,prop);
 assert.equal(f.origin(x.trade_id),'sol');assert.equal(x.funded_from,'solana');assert.equal(x.lands_on,'solana');valid('execute_trade',x);
 const g=world({base:10,sol:10,env:{YEET_SELL_CHAIN:'base'}});
 g.balances.holdings=[...g.balances.holdings,{mint:wif.address,raw:1_000_000_000n,decimals:wif.decimals}];
 assert.equal((await g.p.skeet(ALICE,{request_id:`r${++n}`,legs:[{symbol:'WIF',percent:50}]})).lands_on,'base');
});

test('the BALANCE_LOW sentence fits the contract message and never invents a number',()=>{
 const m=balanceLowMessage({total:usdc(500),base:usdc(123.456),sol:null,open:['sol','base']});
 assert.equal(m,'Not enough USDC for this $500.00 basket: you can trade up to $123.46 right now. Add funds, or lower the amount.');
 assert.equal(balanceLowMessage({total:usdc(500),base:null,sol:null,open:['sol','base']}),'Not enough USDC for this $500.00 basket: your balance could not be read just now. Add funds, or lower the amount.');
 // A card prints this sentence as it is: no network in it, whatever the balances.
 for(const args of [{base:usdc(1),sol:usdc(2),open:['sol','base']},{base:usdc(9),sol:usdc(2),open:['sol']},{base:null,sol:null,open:[]}])assert.doesNotMatch(balanceLowMessage({total:usdc(500),...args}),/Base|Solana|network|chain/i);
 assert.ok(m.length<=contract.$defs.failure.properties.message.maxLength);
});

// The Add funds card (yeet_fund, card-only addresses): which networks it offers, and which one first. Only a network
// whose USDC can pay a YEET, and first the one a new account's first buy spends from.
test('deposit networks: automatic offers both with Solana first (a tie pays from Solana); an override, or a pause, offers one',async()=>{
 const auto=world({base:0,sol:0});
 assert.deepEqual(auto.p.funding.deposits(),['sol','base']);
 const w=await auto.p.wallets.require(ALICE.accountId);
 assert.deepEqual(depositFor(w,auto.p.funding.deposits()),{default:'solana',networks:[{network:'solana',address:w.solana.address},{network:'base',address:w.base.address}]});
 // Why Solana leads: the same USDC on both networks is a tie, and the tie pays from Solana.
 const tie=world({base:20,sol:20});
 assert.equal((await buy(tie)).origin,'sol');
 // USDC sent to the default network pays a new account's first buy.
 const first=world({base:0,sol:20});
 assert.equal((await buy(first)).origin,'sol');
 // An override: only that network (USDC on the other one could not pay a buy).
 assert.deepEqual(world({base:0,sol:0,env:{YEET_BUY_CHAIN:'base'}}).p.funding.deposits(),['base']);
 assert.deepEqual(world({base:0,sol:0,env:{YEET_BUY_CHAIN:'sol'}}).p.funding.deposits(),['sol']);
 // A paused network is not offered; with everything paused both are, Solana first.
 assert.deepEqual(world({base:0,sol:0,env:{YEET_SOLANA_PAUSE:'1'}}).p.funding.deposits(),['base']);
 assert.deepEqual(world({base:0,sol:0,env:{YEET_BASE_PAUSE:'1'}}).p.funding.deposits(),['sol']);
 assert.deepEqual(world({base:0,sol:0,env:{YEET_BASE_PAUSE:'1',YEET_SOLANA_PAUSE:'1'}}).p.funding.deposits(),['sol','base']);
});

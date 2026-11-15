// The third stage of a followed deposit (docs/LEDGER-ROUTE.md 1.5, YEET_LEDGER_DEPOSIT_STAGES=rpc): `detected`, read
// from the deposit's own network (deposit-rpc.mjs, Folio's watcher logic), the schedule and the sweep, the stated
// minimum, and USDC under two token ids (Base offered next to Solana). A fake JSON-RPC stands for Solana and Base:
// nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {createDepositRpc,depositRpcFromEnv,USDC_SOLANA_MINT,USDC_BASE_CONTRACT,TRANSFER_TOPIC} from './deposit-rpc.mjs';
import {depositStagesFromEnv,minDepositFromEnv,depositSweepMsFromEnv,chainInterval,chainFailWait,READY_HOLD_MS,CHAIN_SCHEDULE} from './deposits.mjs';
import {payWith,twoPartsMessage,ledgerBalances} from './route.mjs';
import {associatedTokenAddress} from '../pipeline/solana/message.mjs';
import {ledgerPipeline,fakeDepositApi,buy,approveAndSettle,accountOf,ALICE,aliceWallet,USDC,WIF,RATES} from './fakes.mjs';
import {toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';
import {fundText,minimumText} from '../../mcp/tool-registration.mjs';
import {guidanceFor} from '../../mcp/guidance.mjs';

const KEY='test-partner-key-9f2c',HELIUS='https://solana-main.example/rpc',BACKUP='https://solana-backup.example/rpc',BASE='https://base-main.example/rpc';
const USDC_BASE='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const alice=accountOf(aliceWallet);
const sig=n=>'5'.repeat(80)+String(n).padStart(6,'1'),hash=n=>`0x${String(n).padStart(64,'a')}`;

/** Solana and Base behind one fetch. `sol` = deposit address -> its USDC account's history, newest first:
 * [{signature, delta (raw, signed), err?, unreadable?}]. `base` = address -> {bal, logs:[{tx}]}. `down` = urls that fail. */
function fakeChain(){
 const c={calls:[],down:new Set(),sol:new Map(),base:new Map(),block:1_000,
  count:(method,url)=>c.calls.filter(x=>(!method||x.method===method)&&(!url||x.url===url)).length,
  /** USDC lands at a Solana deposit address. */
  solIn(owner,n,raw){const h=c.sol.get(owner)??[];h.unshift({signature:sig(n),delta:BigInt(raw)});c.sol.set(owner,h)},
  baseIn(address,n,raw){const a=c.base.get(address.toLowerCase())??{bal:0n,logs:[]};a.bal+=BigInt(raw);a.logs.push({tx:hash(n),raw:BigInt(raw)});c.base.set(address.toLowerCase(),a)},
  async fetch(url,init){
   const {method,params}=JSON.parse(init.body);c.calls.push({url,method});
   if(c.down.has(url))throw Error('connect ECONNREFUSED');
   const ok=result=>({ok:true,status:200,json:async()=>({jsonrpc:'2.0',id:1,result})});
   const byAta=account=>[...c.sol.entries()].find(([owner])=>associatedTokenAddress(owner,USDC_SOLANA_MINT)===account);
   if(method==='getSignaturesForAddress'){
    const [account,o]=params,h=byAta(account)?.[1]??[],cut=o.until?h.findIndex(r=>r.signature===o.until):-1;
    return ok((cut<0?h:h.slice(0,cut)).slice(0,o.limit).map(r=>({signature:r.signature,err:r.err??null,confirmationStatus:'confirmed'})));
   }
   if(method==='getTransaction'){
    for(const [owner,h] of c.sol){const r=h.find(x=>x.signature===params[0]);if(!r)continue;
     if(r.unreadable)return ok(null);
     const pre=1_000_000n,post=pre+r.delta;
     return ok({meta:{err:r.err??null,preTokenBalances:[{accountIndex:1,mint:USDC_SOLANA_MINT,owner,uiTokenAmount:{amount:pre.toString()}},{accountIndex:2,mint:USDC_SOLANA_MINT,owner:'someone-else',uiTokenAmount:{amount:'900000000'}}],
      postTokenBalances:[{accountIndex:1,mint:USDC_SOLANA_MINT,owner,uiTokenAmount:{amount:post.toString()}},{accountIndex:2,mint:USDC_SOLANA_MINT,owner:'someone-else',uiTokenAmount:{amount:String(900000000n-r.delta)}}]},
      transaction:{message:{accountKeys:[{pubkey:'payer'},{pubkey:associatedTokenAddress(owner,USDC_SOLANA_MINT)},{pubkey:'other'}]}}})}
    return ok(null);
   }
   if(method==='getMultipleAccounts')return ok({value:params[0].map(account=>{const e=byAta(account);if(!e)return null;
    return {data:{parsed:{info:{mint:USDC_SOLANA_MINT,owner:e[0],tokenAmount:{amount:String(e[1].sitting??0n)}}}}}})});
   if(method==='eth_call'){assert.equal(params[0].to,USDC_BASE_CONTRACT);assert.match(params[0].data,/^0x70a08231/);return ok(`0x${(c.base.get(`0x${params[0].data.slice(-40)}`)?.bal??0n).toString(16)}`)}
   if(method==='eth_blockNumber')return ok(`0x${c.block.toString(16)}`);
   if(method==='eth_getLogs'){assert.equal(params[0].topics[0],TRANSFER_TOPIC);if(c.noLogs)return {ok:true,status:200,json:async()=>({error:{code:-32600,message:'block range'}})};
    return ok((c.base.get(`0x${params[0].topics[2].slice(-40)}`)?.logs??[]).map(l=>({transactionHash:l.tx,data:`0x${l.raw.toString(16)}`})))}
   return {ok:true,status:200,json:async()=>({error:{code:-32601,message:'method not found'}})};
  }};
 return c;
}
function setup({env={},chain=fakeChain(),...rest}={}){
 const api=fakeDepositApi({key:KEY});
 const t=ledgerPipeline({env:{ONECLICK_JWT:KEY,YEET_LEDGER_DEPOSIT_STAGES:'rpc',SOLANA_RPC_URL:HELIUS,SOLANA_BACKUP_RPC_URL:BACKUP,BASE_RPC_URL:BASE,...env},depositFetch:(...a)=>api.fetch(...a),depositRpcFetch:(...a)=>chain.fetch(...a),...rest});
 api.now=t.now;
 const fund=async(ctx=ALICE)=>t.p.ledgerFund(ctx,await t.p.home(ctx));
 const look=async(ms=10_000)=>{t.now.advance(ms);return fund()};
 const address=network=>JSON.parse(t.db.prepare('SELECT addresses FROM ledger_deposit_address WHERE account_id=?').get(ALICE.accountId).addresses).find(e=>e.blockchain===(network==='solana'?'sol':'base')).address;
 return {t,api,chain,fund,look,address};
}
const THREE=['waiting','detected','ready'];

test('settings: rpc is a stage source; the endpoints are read by name, Alchemy never for Solana; the minimum defaults to 5',()=>{
 assert.equal(depositStagesFromEnv({YEET_LEDGER_DEPOSIT_STAGES:'RPC'}),'rpc');assert.equal(depositStagesFromEnv({YEET_LEDGER_DEPOSIT_STAGES:'balance'}),'balance');assert.equal(depositStagesFromEnv({}),'status');
 assert.throws(()=>depositStagesFromEnv({YEET_LEDGER_DEPOSIT_STAGES:'chain'}),/status, balance or rpc/);
 const seen=[];
 assert.deepEqual(depositRpcFromEnv({SOLANA_RPC_URL:HELIUS,SOLANA_BACKUP_RPC_URL:BACKUP,BASE_RPC_URL:'https://base-mainnet.g.alchemy.com/v2/k'},e=>seen.push(e)),{solana:[HELIUS,BACKUP],base:['https://base-mainnet.g.alchemy.com/v2/k']});
 assert.deepEqual(depositRpcFromEnv({SOLANA_RPC_URL:'https://solana-mainnet.g.alchemy.com/v2/k',SOLANA_BACKUP_RPC_URL:BACKUP,BASE_RPC_URL:'nonsense'},e=>seen.push(e)),{solana:[BACKUP],base:[]});
 assert.deepEqual(seen.map(e=>[e.setting,e.why]),[['SOLANA_RPC_URL','Alchemy is for Base only'],['BASE_RPC_URL','not a URL']]);
 assert.doesNotMatch(JSON.stringify(seen),/v2\/k|alchemy\.com/,'a value is never logged');
 assert.deepEqual(depositRpcFromEnv({SOLANA_RPC_URL:HELIUS,SOLANA_BACKUP_RPC_URL:HELIUS}),{solana:[HELIUS],base:[]});
 assert.equal(minDepositFromEnv({}),'5');assert.equal(minDepositFromEnv({YEET_MIN_DEPOSIT_USDC:'10'}),'10');assert.equal(minDepositFromEnv({YEET_MIN_DEPOSIT_USDC:'2.50'}),'2.5');
 assert.equal(minDepositFromEnv({YEET_MIN_DEPOSIT_USDC:'0'}),null);assert.throws(()=>minDepositFromEnv({YEET_MIN_DEPOSIT_USDC:'five'}),/Invalid YEET_MIN_DEPOSIT_USDC/);
 assert.equal(depositSweepMsFromEnv({}),24*3600_000);assert.equal(depositSweepMsFromEnv({YEET_LEDGER_DEPOSIT_SWEEP_HOURS:'0'}),0);assert.throws(()=>depositSweepMsFromEnv({YEET_LEDGER_DEPOSIT_SWEEP_HOURS:'-1'}));
});

test('the schedule backs off with the age of the watch and stops after a day; a failed read waits 30 s, doubling to 10 minutes',()=>{
 assert.deepEqual([0,119_000,120_000,599_000,600_000,29*60_000,30*60_000,119*60_000,2*3600_000,23*3600_000,24*3600_000].map(chainInterval),[10_000,10_000,20_000,20_000,60_000,60_000,300_000,300_000,1_800_000,1_800_000,null]);
 assert.deepEqual([1,2,3,4,5,6,7,20].map(chainFailWait),[30_000,60_000,120_000,240_000,480_000,600_000,600_000,600_000]);
});

test('Solana: a baseline, one listing call per look while nothing happens, the amount and transaction of what arrives; money going out is not a deposit',async()=>{
 const chain=fakeChain(),owner=aliceWallet.address,rpc=createDepositRpc({endpoints:{solana:[HELIUS,BACKUP]},fetch:chain.fetch});
 assert.ok(rpc.has('solana'));assert.ok(!rpc.has('base'));
 chain.solIn(owner,1,700_000);
 const mark=await rpc.mark('solana',owner);
 assert.deepEqual(mark,{sig:sig(1)},'what was there before the watch is the baseline, not a deposit');
 assert.deepEqual(await rpc.look('solana',owner,mark),{seen:null,cursor:{sig:sig(1)}});
 assert.equal(chain.calls.length,2);assert.equal(chain.count('getTransaction'),0,'no body is read while nothing is new');
 chain.sol.get(owner).unshift({signature:sig(2),delta:-700_000n});
 const out=await rpc.look('solana',owner,mark);
 assert.deepEqual(out,{seen:null,cursor:{sig:sig(2)}},'1Click moving the earlier deposit on is not a deposit; the cursor moves past it');
 chain.sol.get(owner).unshift({signature:sig(3),delta:0n,err:{InstructionError:[0,'Custom']}});
 chain.solIn(owner,4,5_000_000);
 assert.deepEqual(await rpc.look('solana',owner,out.cursor),{seen:{amount_raw:'5000000',tx:sig(4)},cursor:{sig:sig(4)}});
 // an address with no USDC account yet reads as nothing, and its first USDC is seen
 const fresh='7iGsgjnCZweMbeC2Qrxj7zFaZhqV85rYLU5WgjHWiyKk',m2=await rpc.mark('solana',fresh);
 assert.deepEqual(m2,{sig:null});
 chain.solIn(fresh,9,1_000_000);
 assert.deepEqual((await rpc.look('solana',fresh,m2)).seen,{amount_raw:'1000000',tx:sig(9)});
 // a body that is not readable yet: the look fails and the caller keeps its cursor
 chain.sol.get(owner).unshift({signature:sig(5),delta:1n,unreadable:true});
 await assert.rejects(rpc.look('solana',owner,{sig:sig(4)}),/solana rpc|not readable/);
 assert.ok(chain.calls.every(x=>x.url===HELIUS),'the backup is not asked while the main endpoint answers');
});

test('the main endpoint fails: the backup answers at once, the main one rests; with every endpoint resting nobody is asked',async()=>{
 const chain=fakeChain(),owner=aliceWallet.address,logs=[];let at=1_000_000;
 const rpc=createDepositRpc({endpoints:{solana:[HELIUS,BACKUP]},fetch:chain.fetch,now:()=>at,log:e=>logs.push(e)});
 chain.down.add(HELIUS);
 assert.deepEqual(await rpc.mark('solana',owner),{sig:null});
 assert.deepEqual(chain.calls.map(x=>x.url),[HELIUS,BACKUP]);
 assert.deepEqual(logs.map(l=>[l.event,l.network,l.endpoint,l.rest_s]),[['ledger_deposit_rpc_failed','solana',0,30]]);
 assert.doesNotMatch(JSON.stringify(logs),/example/,'no endpoint address in the log');
 at+=10_000;await rpc.look('solana',owner,{sig:null});
 assert.equal(chain.count(null,HELIUS),1,'the resting endpoint is not asked');
 at+=30_000;chain.down.delete(HELIUS);await rpc.look('solana',owner,{sig:null});
 assert.equal(chain.count(null,HELIUS),2,'after its rest it is first again');
 chain.down.add(HELIUS);chain.down.add(BACKUP);
 await assert.rejects(rpc.look('solana',owner,{sig:null}));
 const n=chain.calls.length;
 await assert.rejects(rpc.look('solana',owner,{sig:null}),/every endpoint is resting/);
 assert.equal(chain.calls.length,n);
});

test('Base: one balance call per look; a rise is the deposit, its transaction id comes from the Transfer log when the provider gives it',async()=>{
 const chain=fakeChain(),a='0xC71C9f9E8E401fb22D8e217fA7F5bFfe1F681fcC',rpc=createDepositRpc({endpoints:{base:[BASE]},fetch:chain.fetch});
 chain.baseIn(a,1,2_000_000);
 const mark=await rpc.mark('base',a);assert.deepEqual(mark,{bal:'2000000'});
 assert.deepEqual(await rpc.look('base',a,mark),{seen:null,cursor:{bal:'2000000'}});
 assert.deepEqual(chain.calls.map(x=>x.method),['eth_call','eth_call']);
 chain.baseIn(a,2,5_000_000);
 assert.deepEqual(await rpc.look('base',a,mark),{seen:{amount_raw:'5000000',tx:hash(2)},cursor:{bal:'7000000'}});
 chain.baseIn(a,3,1_000_000);chain.noLogs=true;
 assert.deepEqual(await rpc.look('base',a,{bal:'7000000'}),{seen:{amount_raw:'1000000',tx:null},cursor:{bal:'8000000'}},'a refused log range costs the transaction id, not the detection');
 chain.base.get(a.toLowerCase()).bal=0n;
 assert.deepEqual(await rpc.look('base',a,{bal:'8000000'}),{seen:null,cursor:{bal:'0'}},'moved on by 1Click: the mark falls');
 await assert.rejects(rpc.mark('solana',aliceWallet.address),/no endpoint/);
});

test('three stages: waiting, detected with the amount and the transaction when the network shows the USDC, ready when the ledger has it',async()=>{
 const {t,chain,fund,look,address}=setup({userUsdc:3_200_000n});
 const first=await fund();
 assert.deepEqual(first.watch,{steps:THREE,stage:'waiting'});assert.equal(first.min_deposit_usdc,'5');
 assert.deepEqual(first.card_deposit.networks.map(n=>n.network),['solana'],'Solana alone by default');
 assert.equal(chain.calls.length,1,'opening the card takes the baseline: one call');
 assert.equal((await look()).watch.stage,'waiting');assert.equal(chain.calls.length,2);
 chain.solIn(address('solana'),7,5_000_000);
 const d=await look();
 assert.deepEqual(d.watch,{steps:THREE,stage:'detected',detected_usdc:'5',detected_tx:sig(7)});assert.equal(d.usdc,'3.2','not in the account yet');
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_detected'&&l.network==='solana'&&l.usdc_raw==='5000000'));
 const n=chain.calls.length;
 assert.equal((await look()).watch.stage,'detected');assert.equal((await look()).watch.stage,'detected');
 assert.equal(chain.calls.length,n,'once it is seen the network is not asked again');
 t.world.credit(alice,USDC,5_000_000n);
 const r=await look();
 assert.deepEqual(r.watch,{steps:THREE,stage:'ready',arrived_usdc:'5'});assert.equal(r.usdc,'8.2');
 // the answer is the contract's, and no address is where the model reads
 const out=zodSchema(z,toolSchemas.yeet_fund.output);
 for(const a of [first,d,r]){const {card_deposit,...shown}=a;out.parse({...shown,presets:['10']});assert.doesNotMatch(JSON.stringify(shown),new RegExp(address('solana')))}
 // a new watch after the hold: a new baseline, the earlier deposit is not detected again
 t.now.advance(READY_HOLD_MS);
 assert.deepEqual((await look()).watch,{steps:THREE,stage:'waiting'});
 assert.equal((await look()).watch.stage,'waiting');
});

test('ready never waits for detected: the network unreachable, silent or not configured, the ledger alone decides',async()=>{
 // every endpoint down
 const a=setup({userUsdc:1_000_000n});a.chain.down.add(HELIUS);a.chain.down.add(BACKUP);
 assert.deepEqual((await a.fund()).watch,{steps:THREE,stage:'waiting'});
 assert.equal((await a.look()).watch.stage,'waiting');
 a.t.world.credit(alice,USDC,2_000_000n);
 assert.deepEqual((await a.look()).watch,{steps:THREE,stage:'ready',arrived_usdc:'2'});
 assert.ok(a.t.logs.some(l=>l.event==='ledger_deposit_rpc_look_failed'));
 // the network never shows it (the deposit was moved on between two looks)
 const b=setup({userUsdc:1_000_000n});await b.fund();await b.look();
 b.t.world.credit(alice,USDC,2_000_000n);
 assert.equal((await b.look()).watch.stage,'ready');
 // rpc asked for, no endpoint: exactly the balance-only card
 const c=setup({env:{SOLANA_RPC_URL:'',SOLANA_BACKUP_RPC_URL:'',BASE_RPC_URL:''}});
 assert.deepEqual((await c.fund()).watch,{steps:['waiting','ready'],stage:'waiting'});
 c.t.world.credit(alice,USDC,1_000_000n);
 assert.equal((await c.look()).watch.stage,'ready');assert.equal(c.chain.calls.length,0);
 // balance: as before, the network is never read
 const e=setup({env:{YEET_LEDGER_DEPOSIT_STAGES:'balance'}});
 assert.deepEqual((await e.fund()).watch,{steps:['waiting','ready'],stage:'waiting'});await e.look();assert.equal(e.chain.calls.length,0);
});

test('frugal: half an hour of a card asking every 10 s costs about 56 reads, a failing endpoint is asked on the backoff, and coming back restarts the fast phase',async()=>{
 const {chain,fund,look}=setup();
 await fund();
 for(let i=0;i<180;i++)await look();
 const calls=chain.calls.length;
 assert.ok(calls>=50&&calls<=60,`${calls} calls in 30 minutes of polling`);
 assert.ok(chain.calls.every(x=>x.method==='getSignaturesForAddress'&&x.url===HELIUS));
 // the card stopped; the person comes back 20 minutes later: read at once, then every 10 s again
 const n=chain.calls.length;
 await look(20*60_000);assert.equal(chain.calls.length,n+1);
 await look();await look();assert.equal(chain.calls.length,n+3);
 // both endpoints down: 6 looks in a minute ask each endpoint once, not six times
 const f=setup();await f.fund();f.chain.down.add(HELIUS);f.chain.down.add(BACKUP);
 const m=f.chain.calls.length;
 for(let i=0;i<6;i++)await f.look();
 assert.equal(f.chain.calls.length,m+2+2,'one failed read, one more after its 30 s wait (each asks both endpoints once)');
});

test('without the card: the tick keeps reading on the slow schedule and marks the watch detected; the card shows it when the person returns',async()=>{
 const {t,chain,fund,look,address}=setup({userUsdc:1_000_000n});
 await fund();await look();
 const n=chain.calls.length;
 t.now.advance(5_000);assert.deepEqual(await t.p.ledgerDeposits.tick(),{looked:0,swept:{addresses:1,holding:0,found:0,sitting:0}},'nothing is due; the first sweep runs');
 t.now.advance(31*60_000);chain.solIn(address('solana'),3,6_000_000);
 const sweepCalls=chain.count('getMultipleAccounts');
 assert.equal((await t.p.ledgerDeposits.tick()).looked,1);
 assert.equal(chain.calls.length-sweepCalls,n+2,'one listing and the one body of the new signature');
 assert.equal(t.db.prepare('SELECT stage FROM ledger_deposit_watch WHERE account_id=?').get(ALICE.accountId).stage,'detected');
 assert.equal((await t.p.ledgerDeposits.tick()).looked,0,'seen: no more reads');
 assert.deepEqual((await look(60_000)).watch,{steps:THREE,stage:'detected',detected_usdc:'6',detected_tx:sig(3)});
 // a watch older than a day is not read by the tick any more
 const o=setup();await o.fund();await o.look();o.t.now.advance(CHAIN_SCHEDULE.at(-1)[0]+1);
 const k=o.chain.count('getSignaturesForAddress');await o.t.p.ledgerDeposits.tick();assert.equal(o.chain.count('getSignaturesForAddress'),k);
});

test('the sweep: once a day, every stored address in one batched call; USDC nobody watched is named, USDC still sitting a day later is named again',async()=>{
 const {t,chain,fund,address}=setup();
 await fund();
 const tick=()=>t.p.ledgerDeposits.tick();
 t.now.advance(2*3600_000);
 assert.deepEqual((await tick()).swept,{addresses:1,holding:0,found:0,sitting:0});
 assert.equal(chain.count('getMultipleAccounts'),1);
 t.now.advance(3600_000);assert.equal((await tick()).swept,null,'not again within the day');
 chain.sol.set(address('solana'),Object.assign(chain.sol.get(address('solana'))??[],{sitting:4_000_000n}));
 t.now.advance(23*3600_000);
 assert.deepEqual((await tick()).swept,{addresses:1,holding:1,found:1,sitting:0});
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_sweep_found'&&l.usdc_raw==='4000000'&&l.account===ALICE.accountId));
 t.now.advance(24*3600_000);
 assert.deepEqual((await tick()).swept,{addresses:1,holding:1,found:0,sitting:1});
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_sitting'&&l.usdc_raw==='4000000'));
 assert.equal(chain.count('getMultipleAccounts'),3);
 assert.doesNotMatch(JSON.stringify(t.logs.filter(l=>String(l.event).startsWith('ledger_deposit_s'))),new RegExp(address('solana')),'no address in the sweep log');
 // off: never
 const off=setup({env:{YEET_LEDGER_DEPOSIT_SWEEP_HOURS:'0'}});await off.fund();off.t.now.advance(48*3600_000);
 assert.equal((await off.t.p.ledgerDeposits.tick()).swept,null);assert.equal(off.chain.count('getMultipleAccounts'),0);
});

test.skip('the minimum: on the answer, in the text the model reads with the network name, in the guidance; information only, and none when set to 0',async()=>{
 const {fund}=setup();
 const r=await fund(),{card_deposit,...shown}=r,data={...shown,presets:['10'],method:'crypto'};
 assert.equal(r.min_deposit_usdc,'5');
 const text=fundText(data,card_deposit.networks);
 assert.match(text,/Send at least 5 USDC on Solana to the address in the card\./);
 assert.doesNotMatch(text,new RegExp(card_deposit.networks[0].address));
 assert.equal(minimumText(data,[{network:'solana'},{network:'base'}]),' Send at least 5 USDC on Solana or Base, whichever is chosen in the card, to the address in the card.');
 assert.equal(minimumText({...data,methods:[]},card_deposit.networks),'');assert.equal(minimumText({usdc:'1'},card_deposit.networks),'','an account without a stated minimum reads as before');
 const g=guidanceFor('yeet_fund',data,{});
 assert.match(g,/send at least 5 USDC/);assert.match(g,/give no reason/);
 for(const s of [text,g])assert.doesNotMatch(s.replace(/YEET/,''),/lost|refused|rejected|too small|because/i);
 assert.match(guidanceFor('yeet_fund',{...data,watch:{steps:THREE,stage:'detected'}},{}),/YEET/);
 assert.match(fundText({...data,watch:{steps:THREE,stage:'detected'}},card_deposit.networks),/Deposit detected\. It will be ready to trade shortly\./);
 // a smaller deposit is credited like any other
 const small=setup({userUsdc:0n});await small.fund();small.t.world.credit(alice,USDC,1_000_000n);
 assert.deepEqual((await small.look()).watch,{steps:THREE,stage:'ready',arrived_usdc:'1'});
 const none=setup({env:{YEET_MIN_DEPOSIT_USDC:'0'}}),n=await none.fund();
 assert.equal(n.min_deposit_usdc,undefined);assert.doesNotMatch(fundText({...n,method:'crypto'},n.card_deposit.networks),/at least/);
});

test('Base next to Solana: both addresses, both networks read; Base USDC counts as USDC and is detected and ready like Solana\'s',async()=>{
 const {t,chain,fund,look,address}=setup({userUsdc:2_000_000n,env:{YEET_LEDGER_DEPOSIT_NETWORKS:'solana,base'}});
 const first=await fund();
 assert.deepEqual(first.card_deposit.networks.map(n=>n.network),['solana','base']);assert.equal(first.card_deposit.default,'solana');
 assert.deepEqual(chain.calls.map(c=>c.method).sort(),['eth_call','getSignaturesForAddress'],'one baseline call per network');
 chain.baseIn(address('base'),11,6_000_000);
 const d=await look();
 assert.deepEqual(d.watch,{steps:THREE,stage:'detected',detected_usdc:'6',detected_tx:hash(11)});
 t.world.credit(alice,USDC_BASE,6_000_000n);
 const r=await look();
 assert.deepEqual(r.watch,{steps:THREE,stage:'ready',arrived_usdc:'6'});
 assert.equal(r.usdc,'8','the one USDC number counts both token ids');
 assert.equal((await t.p.home(ALICE)).funding.solana_usdc,'8');
 // with Solana alone offered (the default) Base's USDC is another coin and is not counted
 const solo=setup({userUsdc:2_000_000n});await solo.fund();solo.t.world.credit(alice,USDC_BASE,6_000_000n);
 const o=await solo.look();assert.equal(o.watch.stage,'other_coin');assert.equal(o.usdc,'2');
});

test('which USDC a buy spends: Solana\'s when it covers the buy, else the other when that covers it, never a split',()=>{
 const ids=[USDC,USDC_BASE];
 assert.deepEqual(payWith(ids,[5_000_000n,9_000_000n],3_000_000n),{tokenId:USDC});
 assert.deepEqual(payWith(ids,[2_000_000n,9_000_000n],3_000_000n),{tokenId:USDC_BASE});
 assert.deepEqual(payWith(ids,[3_000_000n,0n],3_000_000n),{tokenId:USDC});
 assert.deepEqual(payWith(ids,[2_000_000n,2_500_000n],3_000_000n),{tokenId:null,most:2_500_000n});
 assert.deepEqual(payWith([USDC],[2_000_000n],3_000_000n),{tokenId:null,most:2_000_000n});
 assert.equal(twoPartsMessage(2_500_000n),'Your USDC arrived in two parts, and one trade spends from one of them: up to 2.5 USDC right now. Try that amount or less.');
});

test('the balance reader adds the other USDC token id only when it is named; by default the read is the one it was',async()=>{
 const asked=[],verifier={balances:async(account,ids)=>{asked.push(ids);return ids.map(id=>id===USDC?2_000_000n:id===USDC_BASE?6_000_000n:0n)}};
 const usdcMint=USDC_SOLANA_MINT,inner={baseUsdc:async()=>1n,solanaTokens:async()=>[]};
 const one=ledgerBalances(inner,{isLedgerAddress:()=>true,verifier});
 assert.deepEqual((await one.solanaTokens(aliceWallet.address)).filter(h=>h.mint===usdcMint).map(h=>h.raw),[2_000_000n]);
 assert.ok(!asked[0].includes(USDC_BASE));
 const two=ledgerBalances(inner,{isLedgerAddress:()=>true,verifier,usdcTokenIds:[USDC,USDC_BASE]});
 assert.deepEqual((await two.solanaTokens(aliceWallet.address)).filter(h=>h.mint===usdcMint).map(h=>h.raw),[8_000_000n]);
 assert.equal(asked[1].at(-1),USDC_BASE);
});

test('a buy paid with Base USDC: the person\'s one message gives that token, the trade settles, the solver sells it back to its own USDC',async()=>{
 // the fake market sells 1.0003 Base USDC for 1 USDC
 const t=ledgerPipeline({userUsdc:1_000_000n,env:{YEET_LEDGER_DEPOSIT_NETWORKS:'solana,base'},rates:{...RATES,[USDC_BASE]:1_000_300n}});
 t.world.credit(alice,USDC_BASE,9_000_000n);
 const {x}=await buy(t,{usdc:'3',coins:['WIF']});
 const req=x.sign_requests[0];
 assert.deepEqual(req.payload.gives,[{token_id:USDC_BASE,amount_raw:'3000000'}],'Solana USDC (1) does not cover 3; Base USDC (9) does');
 assert.equal(JSON.parse(req.payload.message).intents[0].diff[USDC_BASE],'-3000000');
 assert.equal(req.summary.asset,'USDC');
 assert.ok(t.logs.some(l=>l.event==='ledger_buy_pays_with'&&l.token===USDC_BASE));
 const floatBefore=t.world.balance(t.near.accountId,USDC);
 await approveAndSettle(t,x);
 assert.equal(t.world.balance(alice,USDC_BASE),6_000_000n);assert.equal(t.world.balance(alice,USDC),1_000_000n,'the other part is untouched');
 assert.ok(t.world.balance(alice,WIF)>0n);
 assert.ok(t.world.balance(t.near.accountId,USDC_BASE)>0n,'the solver was paid in Base USDC');
 assert.equal(t.world.balance(t.near.accountId,USDC),floatBefore-3_000_000n,'and sourced with its own USDC');
 assert.equal((await t.p.status(ALICE,x.trade_id)).status,'success');
 // the leftover unload (the solver's own, unchanged) takes it as inventory: back to USDC, a few basis points less
 const held=t.world.balance(t.near.accountId,USDC_BASE);
 t.now.advance(61_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.equal(t.world.balance(t.near.accountId,USDC_BASE),0n);
 const back=t.world.balance(t.near.accountId,USDC)-(floatBefore-3_000_000n);
 assert.ok(back>held*9_950n/10_000n&&back<=held,`${back} USDC back for ${held} Base USDC`);
 assert.ok(t.logs.some(l=>l.event==='ledger_unload'&&l.symbol==='USDC.base'&&l.ok));
 // with Solana alone offered the unload list is the one it was: Base USDC is not on it
 const d=ledgerPipeline({rates:{...RATES,[USDC_BASE]:1_000_300n}});d.world.credit(d.near.accountId,USDC_BASE,1_000_000n);
 d.now.advance(61_000);await d.p.ledgerRoute.tick();await d.p.ledgerRoute.idle();
 assert.equal(d.world.balance(d.near.accountId,USDC_BASE),1_000_000n);
});

test('a buy that needs both parts is refused before anything is asked, with the amount that works; with Solana alone offered a buy never gives another token',async()=>{
 const t=ledgerPipeline({userUsdc:2_000_000n,env:{YEET_LEDGER_DEPOSIT_NETWORKS:'solana,base'}});
 t.world.credit(alice,USDC_BASE,2_500_000n);
 await assert.rejects(buy(t,{usdc:'3',coins:['WIF']}),e=>e.code==='BALANCE_LOW'&&e.userMessage===twoPartsMessage(2_500_000n));
 assert.equal(t.db.prepare('SELECT count(*) AS n FROM ledger_trade').get().n,0);
 // default networks: Base USDC in the account is not spendable and not counted
 const d=ledgerPipeline({userUsdc:1_000_000n});d.world.credit(alice,USDC_BASE,9_000_000n);
 await assert.rejects(buy(d,{usdc:'3',coins:['WIF']}),e=>e.code==='BALANCE_LOW'&&e.userMessage===undefined);
 const ok=ledgerPipeline({userUsdc:5_000_000n});ok.world.credit(alice,USDC_BASE,9_000_000n);
 const {x}=await buy(ok,{usdc:'3',coins:['WIF']});
 assert.deepEqual(x.sign_requests[0].payload.gives,[{token_id:USDC,amount_raw:'3000000'}]);
});

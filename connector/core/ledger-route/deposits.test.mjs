// Funding on the ledger route (deposits.mjs, docs/LEDGER-ROUTE.md 1.5): the permanent deposit address set (made once,
// for the account's own ledger account and nothing else, never twice) and the watch of a deposit, on the real pipeline
// over the in-memory ledger and a fake of 1Click's reusable-address endpoints. Nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeposits,setRequest,networksOf,stageFromStatus,depositNetworksFromEnv,depositStagesFromEnv,SET_DEADLINE,RETRY_MS,READY_HOLD_MS} from './deposits.mjs';
import {CANNOT_FILL} from './route.mjs';
import {ledgerPipeline,fakeDepositApi,buy,approveAndSettle,accountOf,ALICE,BOB,aliceWallet,bobWallet,USDC,WIF} from './fakes.mjs';
import {fakePipeline} from '../pipeline/fakes.mjs';
import {failure,withUserMessage} from '../failure.mjs';
import {toolError} from '../../mcp/errors.mjs';
import {z} from 'zod';
import {toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';

const KEY='test-partner-key-9f2c';
const alice=accountOf(aliceWallet),bob=accountOf(bobWallet);
const SOL_NATIVE='nep141:sol.omft.near',USDC_OTHER='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
function setup({env={},api=fakeDepositApi({key:KEY}),...rest}={}){
 const t=ledgerPipeline({env:{ONECLICK_JWT:KEY,...env},depositFetch:(...a)=>api.fetch(...a),...rest});
 api.now=t.now;
 const fund=async(ctx=ALICE)=>t.p.ledgerFund(ctx,await t.p.home(ctx));
 /** The next look of the card: 10 s later. */
 const look=async(ctx=ALICE)=>{t.now.advance(10_000);return fund(ctx)};
 const row=(id=ALICE.accountId)=>t.db.prepare('SELECT * FROM ledger_deposit_address WHERE account_id=?').get(id);
 return {t,api,fund,look,row};
}
const solOf=set=>set.addresses.find(e=>e.blockchain==='sol').address;

test('the request for a set is the documented one, with the account on both sides and the 2038 deadline',()=>{
 assert.deepEqual(setRequest(alice),{dry:false,swapType:'ANY_INPUT',originAsset:'1cs_v1:any',depositType:'INTENTS',destinationAsset:'1cs_v1:original',amount:'0',slippageTolerance:50,
  recipient:alice,recipientType:'INTENTS',refundTo:alice,refundType:'INTENTS',deadline:'2038-01-01T00:00:00.000Z'});
 assert.equal(SET_DEADLINE,'2038-01-01T00:00:00.000Z');
});

test('the networks shown: Solana alone by default; an entry with a memo, of another shape or listed twice is never offered',()=>{
 const S='7iGsgjnCZweMbeC2Qrxj7zFaZhqV85rYLU5WgjHWiyKk',E='0xc71c9F9E8e401FB22D8E217Fa7f5BffE1f681FCc';
 const all=[{blockchain:'eth',address:E},{blockchain:'base',address:E},{blockchain:'sol',address:S},{blockchain:'stellar',address:'GDJ4',memo:'237260638'}];
 assert.deepEqual(networksOf(all),{default:'solana',networks:[{network:'solana',address:S}]});
 assert.deepEqual(networksOf(all,['solana','base']),{default:'solana',networks:[{network:'solana',address:S},{network:'base',address:E}]});
 assert.deepEqual(networksOf(all,['base']),{default:'base',networks:[{network:'base',address:E}]});
 assert.equal(networksOf([{blockchain:'sol',address:S,memo:'1'}]),null,'a memo: never offered');
 assert.equal(networksOf([{blockchain:'sol',address:E}]),null,'not a Solana address');
 assert.equal(networksOf([{blockchain:'sol',address:S},{blockchain:'sol',address:S}]),null,'two entries for one network');
 assert.equal(networksOf([{blockchain:'stellar',address:'GDJ4',memo:'1'}],['solana','base']),null);
 assert.equal(networksOf(null),null);assert.equal(networksOf(all,['tron']),null);
 assert.deepEqual(depositNetworksFromEnv({}),['solana']);
 assert.deepEqual(depositNetworksFromEnv({YEET_LEDGER_DEPOSIT_NETWORKS:' Solana , base '}),['solana','base']);
 for(const bad of ['tron','solana,solana',','])assert.throws(()=>depositNetworksFromEnv({YEET_LEDGER_DEPOSIT_NETWORKS:bad}),/Invalid YEET_LEDGER_DEPOSIT_NETWORKS/);
 assert.equal(depositStagesFromEnv({}),'status');assert.equal(depositStagesFromEnv({YEET_LEDGER_DEPOSIT_STAGES:'Balance'}),'balance');
 assert.throws(()=>depositStagesFromEnv({YEET_LEDGER_DEPOSIT_STAGES:'four'}),/Invalid YEET_LEDGER_DEPOSIT_STAGES/);
});

test('with the route off nothing of this exists: no object, no table, no call',async()=>{
 const {p,db}=fakePipeline();
 assert.equal(p.ledgerDeposits,null);
 assert.equal(await p.ledgerFund(ALICE,await p.home(ALICE)),null);
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'ledger_deposit%'").get().n,0);
});

test('first yeet_fund makes the set once, for the account\'s own ledger account; it is stored and never made again, in this process or after a restart',async()=>{
 const {t,api,fund,look,row}=setup();
 const r=await fund();
 assert.equal(api.posts(),1);
 const post=api.calls.find(c=>c.method==='POST');
 assert.deepEqual(post.body,setRequest(alice),'recipient and refund account are the account\'s own ledger account');
 assert.ok(api.calls.findIndex(c=>c.path==='/v0/quotes')<api.calls.indexOf(post),'the partner\'s sets are listed before anything is made');
 assert.ok(api.calls.every(c=>c.key===KEY));
 assert.deepEqual(r.methods,['crypto']);
 assert.deepEqual(r.card_deposit,{default:'solana',networks:[{network:'solana',address:solOf(api.sets[0])}]},'Solana alone; the entry with a memo and every other chain stay out');
 assert.deepEqual(r.watch,{steps:['waiting','found','preparing','ready'],stage:'waiting'});
 assert.equal(r.usdc,'20');
 const stored=row();
 assert.equal(stored.ledger_account,alice);assert.equal(stored.recipient,alice);assert.equal(stored.refund_to,alice);
 assert.equal(stored.state,'ready');assert.equal(stored.source,'created');assert.equal(stored.correlation_id,'corr-set-1');assert.equal(stored.internal_address,api.sets[0].internal);
 assert.equal(JSON.parse(stored.addresses).length,4,'the whole answer is kept');
 assert.equal(stored.created_at,t.now()-0);
 // again and again, and after a restart: the stored set, no create, not even a listing
 const lists=()=>api.calls.filter(c=>c.path==='/v0/quotes').length,before=lists();
 for(let i=0;i<3;i++)assert.deepEqual((await look()).card_deposit,r.card_deposit);
 t.restart();
 assert.deepEqual((await look()).card_deposit,r.card_deposit);
 assert.equal(api.posts(),1);assert.equal(lists(),before);
 // another account gets its own set, for its own ledger account
 const b=await fund(BOB);
 assert.equal(api.posts(),2);assert.deepEqual(api.calls.filter(c=>c.method==='POST')[1].body,setRequest(bob));
 assert.notEqual(b.card_deposit.networks[0].address,r.card_deposit.networks[0].address);
 // the key is nowhere but in the request header
 const dump=JSON.stringify([t.logs,t.db.prepare('SELECT * FROM ledger_deposit_address').all(),t.db.prepare('SELECT * FROM ledger_deposit_watch').all(),r,b]);
 assert.ok(!dump.includes(KEY),'the partner key is never logged, stored or answered');
});

test('many calls at once make one set',async()=>{
 const {api,fund}=setup();
 const all=await Promise.all([fund(),fund(),fund(),fund(),fund()]);
 assert.equal(api.posts(),1);
 for(const r of all)assert.deepEqual(r.card_deposit,all[0].card_deposit);
});

test('a set that already exists at 1Click for this account is taken over, not made again; its own record must be our request',async()=>{
 const {api,fund,row}=setup();
 api.add(setRequest(bob));const mine=api.add(setRequest(alice));
 const r=await fund();
 assert.equal(api.posts(),0);assert.equal(r.card_deposit.networks[0].address,solOf(mine));
 assert.equal(row().source,'adopted');assert.equal(row().internal_address,mine.internal);
 // a listed set that names this account but was made another way (paid out to a chain address): not ours, never shown
 const odd=setup();
 odd.api.add({...setRequest(alice),recipientType:'DESTINATION_CHAIN'});
 const no=await odd.fund();
 assert.deepEqual(no,{methods:[]});assert.equal(odd.api.posts(),0,'and no second set is made beside it');
 assert.equal(odd.row().state,'failed');assert.match(odd.row().last_error,/not made with our request/);
 assert.ok(odd.t.logs.some(l=>l.event==='ledger_fund_unavailable'));
 // the list is paged: a set on a later page is still found
 const paged=setup({api:fakeDepositApi({key:KEY,pageSize:2})});
 for(let i=0;i<5;i++)paged.api.add(setRequest(String(i).repeat(64)));
 const late=paged.api.add(setRequest(alice));
 assert.equal((await paged.fund()).card_deposit.networks[0].address,solOf(late));
 assert.equal(paged.api.posts(),0);assert.equal(paged.api.calls.filter(c=>c.path==='/v0/quotes').length,3);
});

test('a create answered HTTP 400 is never repeated: the list is read once more, and the set found there is used',async()=>{
 const {t,api,fund,look,row}=setup();
 api.create=400;
 assert.deepEqual(await fund(),{methods:[]});
 assert.equal(api.posts(),1);assert.equal(row().state,'failed');assert.match(row().last_error,/HTTP 400/);
 // every look of the card in the next minutes: no call at all
 const calls=api.calls.length;
 for(let i=0;i<5;i++)assert.deepEqual(await look(),{methods:[]});
 assert.equal(api.calls.length,calls,'no blind retry');
 // the overlapping create (someone else\'s, for the same account) has finished meanwhile: the next try finds it
 const theirs=api.add(setRequest(alice));
 t.now.advance(RETRY_MS);
 const r=await fund();
 assert.equal(api.posts(),1,'never a second create');assert.equal(r.card_deposit.networks[0].address,solOf(theirs));assert.equal(row().source,'adopted');
 // 400 while the other create is already listed: taken over in the same call
 const same=setup();
 same.api.create=400;
 const origFetch=same.api.fetch;let lists=0;
 same.api.fetch=async(url,init)=>{if(String(url).includes('/v0/quotes?')&&++lists===2)same.api.add(setRequest(alice));return origFetch(url,init)};
 const got=await same.fund();
 assert.equal(got.methods[0],'crypto');assert.equal(same.api.posts(),1);assert.equal(same.row().source,'adopted');
});

test('a create with no answer, or a server error: nothing is shown, nothing is repeated blindly, and a set that was made after all is found later',async()=>{
 for(const mode of ['drop',500]){
  const {t,api,fund,look,row}=setup();
  api.create=mode;
  assert.deepEqual(await fund(),{methods:[]},String(mode));
  assert.equal(row().state,'failed');assert.match(row().last_error,mode==='drop'?/outcome unknown/:/HTTP 500/);
  assert.deepEqual(await look(),{methods:[]});assert.equal(api.posts(),1);
  api.create='ok';t.now.advance(RETRY_MS);
  const r=await fund();
  assert.equal(r.methods[0],'crypto');
  // drop: the set was made, so it is taken over; 500: none exists, so one is made now
  assert.equal(api.posts(),mode==='drop'?1:2);assert.equal(api.sets.length,1,'one set at 1Click either way');
  assert.equal(row().source,mode==='drop'?'adopted':'created');
 }
 // the list cannot be read: nothing is made (a set might exist)
 const blind=setup();blind.api.listFails=true;
 assert.deepEqual(await blind.fund(),{methods:[]});assert.equal(blind.api.posts(),0);assert.match(blind.row().last_error,/list of sets could not be read/);
});

test('an answer that names another account, or no usable address, is refused',async()=>{
 const other=setup();other.api.create='other';
 assert.deepEqual(await other.fund(),{methods:[]});assert.match(other.row().last_error,/another request than ours/);assert.equal(other.row().addresses,null);
 // an answer that does not repeat its request is checked against 1Click's own record of the set instead
 const quiet=setup();quiet.api.echoRequest=false;
 const r=await quiet.fund();
 assert.equal(r.methods[0],'crypto');assert.equal(quiet.row().source,'adopted');assert.ok(quiet.api.calls.some(c=>c.path==='/v0/status'));
 // a set whose Solana entry asks for a memo
 const memo=setup();const orig=memo.api.addressesFor;
 memo.api.addressesFor=n=>orig(n).map(e=>e.blockchain==='sol'?{...e,memo:'77'}:e);
 assert.deepEqual(await memo.fund(),{methods:[]});assert.match(memo.row().last_error,/no address this route can show/);
});

test('the hard check: a stored set that is not for exactly this account\'s ledger account shows nothing',async()=>{
 for(const [column,value] of [['ledger_account',bob],['recipient',bob],['refund_to','0'.repeat(64)]]){
  const {t,api,fund,look}=setup();
  assert.equal((await fund()).methods[0],'crypto');
  t.db.prepare(`UPDATE ledger_deposit_address SET ${column}=? WHERE account_id=?`).run(value,ALICE.accountId);
  const calls=api.calls.length;
  assert.deepEqual(await look(),{methods:[]},column);
  assert.equal(api.calls.length,calls,'and nothing is made in its place');
  assert.ok(t.logs.some(l=>l.event==='ledger_deposit_set_mismatch'&&l.account===ALICE.accountId));
 }
 // two YEET accounts can never share one ledger account's set
 const {t,fund}=setup();
 await fund();
 t.db.prepare('UPDATE ledger_deposit_address SET account_id=? WHERE account_id=?').run('someone-else',ALICE.accountId);
 assert.deepEqual(await fund(),{methods:[]});
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_set_refused'));
});

test('without the partner key funding answers "not available" cleanly: no call, nothing stored; an account on the chain route is not touched',async()=>{
 const api=fakeDepositApi({key:KEY});
 const t=ledgerPipeline({depositFetch:(...a)=>api.fetch(...a)});
 assert.equal(t.p.ledgerDeposits.enabled,false);
 assert.deepEqual(await t.p.ledgerFund(ALICE,await t.p.home(ALICE)),{methods:[]});
 assert.deepEqual(api.calls,[]);assert.equal(t.db.prepare('SELECT count(*) AS n FROM ledger_deposit_address').get().n,0);
 // only the listed account is on the ledger route: the other one gets today's funding card (null here)
 const one=setup({env:{YEET_ROUTE:'chain',YEET_LEDGER_ACCOUNTS:ALICE.accountId}});
 assert.equal(await one.t.p.ledgerFund(BOB,await one.t.p.home(BOB)),null);
 assert.equal((await one.fund()).methods[0],'crypto');
 assert.ok(one.api.calls.every(c=>c.method!=='POST'||c.body.recipient===alice));
});

test('the watch: USDC that arrives in the ledger account is "ready" with the amount; it holds for a short while, then a new watch begins',async()=>{
 const {t,fund,look}=setup({userUsdc:3_200_000n});
 assert.deepEqual((await fund()).watch,{steps:['waiting','found','preparing','ready'],stage:'waiting'});
 assert.equal((await look()).watch.stage,'waiting');
 t.world.credit(alice,USDC,1_000_000n);
 const r=await look();
 assert.deepEqual(r.watch,{steps:['waiting','found','preparing','ready'],stage:'ready',arrived_usdc:'1'});assert.equal(r.usdc,'4.2');
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_arrived'&&l.usdc_raw==='1000000'));
 assert.equal((await look()).watch.stage,'ready','the card that asks again still reads ready');
 t.now.advance(READY_HOLD_MS);
 assert.deepEqual((await look()).watch,{steps:['waiting','found','preparing','ready'],stage:'waiting'},'later a new watch starts from the new balance');
 t.world.credit(alice,USDC,250_000n);
 assert.equal((await look()).watch.arrived_usdc,'0.25');
});

test('the watch: another coin than USDC is named and claims no stage; USDC after it is ready',async()=>{
 const {t,fund,look}=setup();
 await fund();
 t.world.credit(alice,SOL_NATIVE,50_000_000n);
 assert.deepEqual((await look()).watch,{steps:['waiting','found','preparing','ready'],stage:'other_coin',coin:'SOL'});
 assert.equal((await look()).watch.stage,'other_coin');
 t.world.credit(alice,USDC,2_000_000n);
 assert.deepEqual((await look()).watch,{steps:['waiting','found','preparing','ready'],stage:'ready',arrived_usdc:'2'});
 // a token with no plain name (USDC sent on another network is such a token): no coin is named
 const o=setup();await o.fund();
 o.t.world.credit(alice,USDC_OTHER,5_000_000n);
 const w=(await o.look()).watch;
 assert.equal(w.stage,'other_coin');assert.equal(w.coin,undefined);
 // a catalogue coin is named by its symbol
 const c=setup();await c.fund();
 c.t.world.credit(alice,WIF,1_000n);
 assert.equal((await c.look()).watch.coin,'WIF');
});

test('the middle stages come only from 1Click\'s own status of the set, never backwards, and never without it',async()=>{
 const {t,api,fund,look}=setup();
 await fund();
 const s=api.sets[0].status,touch=()=>{s.updatedAt=new Date(t.now()).toISOString()};
 assert.equal((await look()).watch.stage,'waiting');
 touch();
 assert.equal((await look()).watch.stage,'waiting','a status that only got a new time shows nothing');
 s.status='KNOWN_DEPOSIT_TX';s.swapDetails.originChainTxHashes=[{hash:'x'}];touch();
 assert.equal((await look()).watch.stage,'found');
 s.status='PROCESSING';touch();
 assert.equal((await look()).watch.stage,'preparing');
 s.status='PENDING_DEPOSIT';touch();
 assert.equal((await look()).watch.stage,'preparing','not backwards');
 t.world.credit(alice,USDC,1_000_000n);
 assert.equal((await look()).watch.stage,'ready');
 // the pure rule
 const base={status:'SUCCESS',updatedAt:'a',deposited:'5',amountIn:'5',origins:2,near:3,dests:0};
 assert.equal(stageFromStatus(base,{...base}),null,'an old success is not a new deposit');
 assert.equal(stageFromStatus(base,{...base,origins:3}),'found');assert.equal(stageFromStatus(base,{...base,deposited:'6'}),'found');
 assert.equal(stageFromStatus(base,{...base,near:4}),'preparing');assert.equal(stageFromStatus(base,{...base,updatedAt:'b'}),'preparing','SUCCESS at a new time');
 assert.equal(stageFromStatus(null,base),null);assert.equal(stageFromStatus(base,null),null);
 // YEET_LEDGER_DEPOSIT_STAGES=balance: two stages, and 1Click's status is not read at all
 const two=setup({env:{YEET_LEDGER_DEPOSIT_STAGES:'balance'}});
 assert.deepEqual((await two.fund()).watch,{steps:['waiting','ready'],stage:'waiting'});
 two.api.sets[0].status.status='PROCESSING';
 assert.equal((await two.look()).watch.stage,'waiting');
 assert.equal(two.api.calls.filter(c=>c.path==='/v0/status').length,0);
 two.t.world.credit(alice,USDC,1_000_000n);
 assert.deepEqual((await two.look()).watch,{steps:['waiting','ready'],stage:'ready',arrived_usdc:'1'});
 // a status that cannot be read changes nothing: the balance still decides
 const down=setup();await down.fund();
 const orig=down.api.fetch;down.api.fetch=async(url,init)=>String(url).includes('/v0/status')?{ok:false,status:503,text:async()=>'{}'}:orig(url,init);
 assert.equal((await down.look()).watch.stage,'waiting');
 down.t.world.credit(alice,USDC,1_000_000n);
 assert.equal((await down.look()).watch.stage,'ready');
});

test('a trade of the account is not a deposit: what it moves re-bases the watch',async()=>{
 const {t,fund,look}=setup({env:{YEET_MIN_LEG_USDC:'1'}});
 await fund();
 const {x}=await buy(t,{usdc:'3',coins:['WIF']});
 await approveAndSettle(t,x);
 assert.ok(t.world.balance(alice,WIF)>0n&&t.world.balance(alice,USDC)<20_000_000n);
 const w=(await look()).watch;
 assert.equal(w.stage,'waiting','the coin the trade bought is not "another coin", and nothing arrived');
 t.now.advance(60_000);
 t.world.credit(alice,USDC,1_500_000n);
 assert.deepEqual((await look()).watch.arrived_usdc,'1.5','a deposit after the trade shows as a rise over the lower balance');
});

test('the ledger cannot be read: the address is still shown, without a watch',async()=>{
 const {t,fund,look}=setup();
 const first=await fund();
 const v=t.world.verifier,orig=v.holdings;
 v.holdings=async()=>{throw Error('rpc down')};
 const r=await look();
 v.holdings=orig;
 assert.deepEqual(r.card_deposit,first.card_deposit);assert.deepEqual(r.methods,['crypto']);assert.equal(r.watch,undefined);assert.equal(r.usdc,undefined,'the balance then comes from the home answer');
 assert.ok(t.logs.some(l=>l.event==='ledger_deposit_watch_failed'));
 assert.equal((await look()).watch.stage,'waiting','and the watch is back with the ledger');
});

test('the fund answer of a ledger account fits the contract; no address where the model reads',async()=>{
 const {fund}=setup();
 const r=await fund();
 const {card_deposit,usdc,...rest}=r;
 const shown={usdc,presets:['10','25','50','100'],method:'crypto',...rest};
 const out=zodSchema(z,toolSchemas.yeet_fund.output);
 assert.equal(out.safeParse(shown).success,true,JSON.stringify(out.safeParse(shown).error?.issues));
 assert.doesNotMatch(JSON.stringify(shown),/[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40}/);
 assert.equal(out.safeParse({usdc:'0',presets:['10'],methods:[]}).success,true);
 assert.equal(out.safeParse({...shown,watch:{...shown.watch,address:'x'}}).success,false,'the watch has no place for an address');
});

test('an empty solver float is refused in plain words at the tap; any other outage keeps the catalogue sentence',async()=>{
 const t=ledgerPipeline({float:0n});
 const d=await t.p.propose(ALICE,{request_id:'r1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});
 let err;
 await t.p.execute(ALICE,{proposal_id:d.proposal_id,revision:d.revision,confirm:d.confirm.code}).catch(e=>{err=e});
 assert.equal(err?.code,'TEMPORARILY_UNAVAILABLE');assert.match(err.detail,/solver float 0 is below/);
 assert.equal(err.userMessage,'YEET cannot fill this right now. Nothing was traded.');assert.equal(CANNOT_FILL,err.userMessage);
 assert.equal(t.db.prepare('SELECT count(*) AS n FROM trades').get().n,0,'nothing was committed');
 // core -> connector -> card and model: that sentence, and only that one, replaces the catalogue text
 const f=withUserMessage(failure(err.code),err);
 assert.equal(f.message,CANNOT_FILL);
 assert.equal(JSON.parse(toolError(f).content[0].text).message,CANNOT_FILL);
 const plain=failure('TEMPORARILY_UNAVAILABLE').message;
 assert.equal(withUserMessage(failure('TEMPORARILY_UNAVAILABLE'),{userMessage:'host-internal:38316 down'}).message,plain);
 assert.equal(JSON.parse(toolError({error:'TEMPORARILY_UNAVAILABLE',message:'host-internal:38316 down'}).content[0].text).message,plain);
 assert.equal(JSON.parse(toolError({error:'SOMETHING_ELSE',message:CANNOT_FILL}).content[0].text).message,plain,'an unknown failure never carries words of its own');
 assert.doesNotMatch(CANNOT_FILL,/solver|float|sign|wallet/i);
});

test('createDeposits alone: a ledger account that is not 64 hex, or no wallet address, shows nothing and calls nothing',async()=>{
 const api=fakeDepositApi({key:KEY}),t=ledgerPipeline();
 const d=createDeposits({db:t.db,key:KEY,verifier:t.world.verifier,accountOf:()=>'not-hex',fetch:(...a)=>api.fetch(...a),now:t.now});
 assert.deepEqual(await d.fund('acct','whatever'),{methods:[]});
 const thrower=createDeposits({db:t.db,key:KEY,verifier:t.world.verifier,accountOf:()=>{throw Error('bad address')},fetch:(...a)=>api.fetch(...a),now:t.now});
 assert.deepEqual(await thrower.fund('acct',undefined),{methods:[]});
 assert.deepEqual(api.calls,[]);
});

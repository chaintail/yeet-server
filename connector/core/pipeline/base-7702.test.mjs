// Base baskets in ONE EIP-7702 transaction through the whole pipeline on fakes (BASE-7702-PRODUCTION-PLAN.md 5.2):
// one evm_7702 request, one submit, one hash, N deposit notices; every fallback gives today's per-leg evm_tx requests;
// restarts, replacement, deadline and the deposit-unseen switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,parseTransaction} from 'viem';
import {fakeBasePipeline,ALICE} from './fakes.mjs';
import {fakeOneClick} from '../trade/fakes.mjs';
import {mine,delegate} from './base/test-support.mjs';
import {loadGasWallet} from './base/gas-wallet.mjs';
import {AUTO_LEGACY_FLAG} from './base/batch-driver.mjs';
import {spentToday} from '../trade/limits.mjs';

const USER_KEY='0x'+'5a'.repeat(32);
const FIVE=['WIF','BOME','TRUMP','PENGU','SPX'];
const buy=(n,extra={})=>({request_id:`b7702-${n}-${extra.tag??''}`,amount_usdc:String(3*n),legs:FIVE.slice(0,n).map(symbol=>({symbol,parts:1}))});
const exec=(p,prop)=>p.execute(ALICE,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const sub=(p,req,signed,opts)=>p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed},opts);
const legs=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const statuses=(db,id)=>legs(db,id).map(l=>l.send_status);
const batchRow=(db,id)=>db.prepare('SELECT * FROM base_batch WHERE id=?').get(id);
const strip=r=>{const {trade_id:_t,attempt_id:_a,...rest}=r;return rest};

for(const n of [2,5]){
 test(`${n}-leg BUY: one evm_7702 request, dry run simulates ${n} transfers, one submit, one type-4 hash for every leg, ${n} notices, never twice across 10 replays`,async()=>{
  const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc,oneclick}=f;
  const prop=await p.propose(ALICE,buy(n));
  const x=await exec(p,prop);
  assert.equal(x.sign_requests.length,1);
  const r=x.sign_requests[0];
  assert.equal(r.kind,'evm_7702');assert.deepEqual(r.legs,[...Array(n).keys()]);
  assert.deepEqual(r.leg_summaries.map(s=>s.to),legs(db,x.trade_id).map(l=>l.deposit_address));
  assert.deepEqual(r.summary,(({leg:_,...s})=>s)(r.leg_summaries[0]));
  assert.equal(r.payload.type,'calibur_batch');assert.ok(r.payload.authorization);
  const signed=await f.sign(r);
  assert.equal(signed.length,262);
  const dry=await sub(p,r,signed,{dryRun:true});
  assert.equal(dry.dry_run.state,'not_sent');assert.equal(dry.dry_run.simulation.legs_transferred,n);
  assert.ok(BigInt(dry.dry_run.simulation.max_cost_wei)>0n);assert.equal(rpc.s.broadcasts.length,0);
  const s=await sub(p,r,signed);
  assert.deepEqual(s.legs.map(l=>l.send_status),Array(n).fill('signing'));
  assert.equal(new Set(s.legs.map(l=>l.tx_hash)).size,1,'one hash for every leg');
  assert.equal(rpc.s.broadcasts.length,1,'one transaction, no top-up');
  assert.equal(parseTransaction(rpc.s.broadcasts[0]).type,'eip7702');
  assert.equal(oneclick.calls.submit.length,0,'not before the receipt');
  const hash=await mine(rpc,rpc.s.broadcasts[0]);
  await f.tick(x.trade_id);
  assert.deepEqual(statuses(db,x.trade_id),Array(n).fill('sent'));
  assert.ok(legs(db,x.trade_id).every(l=>l.tx_hash===hash));
  assert.equal(oneclick.calls.submit.length,n);assert.equal(new Set(oneclick.calls.submit.map(c=>c.txHash)).size,1);
  for(let i=0;i<10;i++){
   const again=await sub(p,r,signed);assert.equal(again.legs[0].tx_hash,hash);
   await exec(p,prop);await f.tick(x.trade_id);await p.tracker.pollOnce();
  }
  assert.equal(oneclick.calls.submit.length,n,'never a second notice');
  assert.equal(rpc.s.broadcasts.length,1);
  assert.equal(spentToday(db,ALICE.accountId,f.now()),BigInt(3*n)*1_000_000n);
  // Events: each leg has one signing and one sent event with the same hash.
  const ev=db.prepare("SELECT leg_id,to_status,evidence_json FROM trade_events WHERE trade_id=? AND kind='leg' AND from_status<>to_status").all(x.trade_id);
  for(let i=0;i<n;i++){assert.equal(ev.filter(e=>e.leg_id===i&&e.to_status==='signing').length,1);assert.equal(JSON.parse(ev.find(e=>e.leg_id===i&&e.to_status==='sent').evidence_json).tx_hash,hash)}
 });
}

test('a second trade from the now-delegated wallet asks only for the batch signature (type 2, 132 characters)',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,rpc}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 await sub(p,x.sign_requests[0],await f.sign(x.sign_requests[0]));
 await mine(rpc,rpc.s.broadcasts[0]);await f.tick(x.trade_id);
 const y=await exec(p,await p.propose(ALICE,buy(2,{tag:'2'})));
 const r=y.sign_requests[0];
 assert.equal(r.kind,'evm_7702');assert.equal(r.payload.authorization,null);
 const signed=await f.sign(r);assert.equal(signed.length,132);
 await sub(p,r,signed);
 assert.equal(parseTransaction(rpc.s.broadcasts[1]).type,'eip1559');
});

/** The per-leg requests a legacy pipeline issues for the same basket (the reference for "byte-identical to today"). */
async function legacyRequests(n){
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'legacy'},userKey:USER_KEY});
 const x=await exec(f.p,await f.p.propose(ALICE,buy(n)));
 return x.sign_requests.map(strip);
}
test('fallbacks give N evm_tx requests byte-identical to today: legacy mode, YEET_BASE_MODE unset, auto-legacy, an RPC without eth_simulateV1, a memo',async()=>{
 const ref=await legacyRequests(3);
 assert.equal(ref.length,3);assert.ok(ref.every(r=>r.kind==='evm_tx'&&!('legs' in r)));
 const variants=[
  async()=>fakeBasePipeline({env:{YEET_BASE_MODE:'legacy'},userKey:USER_KEY}),
  async()=>fakeBasePipeline({env:{},userKey:USER_KEY}),
  async()=>{const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'},userKey:USER_KEY});f.db.exec("CREATE TABLE IF NOT EXISTS base_driver_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER NOT NULL) STRICT");f.db.prepare('INSERT INTO base_driver_state VALUES(?,?,?)').run(AUTO_LEGACY_FLAG,'1',0);return f},
  async()=>{const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'},userKey:USER_KEY});f.rpc.s.simulateError='Method not found: eth_simulateV1';return f},
 ];
 for(const v of variants){
  const f=await v();
  const x=await exec(f.p,await f.p.propose(ALICE,buy(3)));
  assert.deepEqual(x.sign_requests.map(strip),ref);
 }
 const memo=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'},oneclick:fakeOneClick({mutate:res=>{if(!res.quoteRequest.dry)res.quote.depositMemo='memo-1';return res}})});
 const x=await exec(memo.p,await memo.p.propose(ALICE,buy(3)));
 assert.equal(x.sign_requests.length,3);assert.ok(x.sign_requests.every(r=>r.kind==='evm_tx'&&!('legs' in r)));
 assert.ok(memo.logs.some(l=>l.includes('"basket_fallback"')&&l.includes('deposit_memo')));
});

test('`unsupported` from the card: the attempt is abandoned, the wallet flagged, the same answer carries per-leg evm_tx requests (today\'s bytes); they sign and send as today',async()=>{
 const ref=await legacyRequests(2);
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'},userKey:USER_KEY});const {p,db,rpc}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 const r=x.sign_requests[0];assert.equal(r.kind,'evm_7702');
 const out=await sub(p,r,'unsupported');
 assert.equal(out.sign_requests.length,2);
 assert.deepEqual(out.sign_requests.map(strip),ref);
 assert.equal(db.prepare('SELECT status FROM client_trade WHERE attempt_id=?').get(r.attempt_id).status,'abandoned');
 assert.equal(batchRow(db,r.attempt_id).state,'cancelled');
 for(const q of out.sign_requests)await sub(p,q,await f.sign(q));
 assert.ok(rpc.s.broadcasts.length>=1,'the top-up path runs');
 // Later trades from this wallet stay legacy.
 const y=await exec(p,await p.propose(ALICE,buy(2,{tag:'later'})));
 assert.ok(y.sign_requests.every(q=>q.kind==='evm_tx'));
});

test('SIGN_EXPIRED and AUTH_NONCE_STALE answer one fresh evm_7702 request with the same trade nonce',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,rpc}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 const r=x.sign_requests[0];
 rpc.s.latest[f.wallet]=1;// the wallet's own transaction moved its nonce
 const out=await sub(p,r,await f.sign(r));
 assert.equal(out.sign_requests.length,1);
 const q=out.sign_requests[0];
 assert.equal(q.kind,'evm_7702');assert.notEqual(q.attempt_id,r.attempt_id);
 assert.equal(q.payload.authorization.nonce,1);
 assert.equal(q.payload.typed_data.message.nonce,r.payload.typed_data.message.nonce,'the old and new signatures exclude each other');
 f.now.advance(11*60_000);
 const late=await sub(p,q,await f.sign(q));
 assert.ok(!late.sign_requests,'past the sign window nothing new is issued');
});

for(const where of ['signed','submitted','uncertain']){
 test(`restart with the batch ${where}: recovery confirms it once and tells 1Click once per leg`,async()=>{
  let env,pauseOnce=true;// the pause closes once, right after the first outer signature
  const loadWallet=where==='signed'?c=>{const g=loadGasWallet(c);return {address:g.address,sign:async tx=>{const r=await g.sign(tx);if(pauseOnce){pauseOnce=false;env.YEET_BASE_PAUSE='1'}return r}}}:undefined;
  const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'},loadWallet});env=f.env;const {db,rpc,oneclick}=f;
  const x=await exec(f.p,await f.p.propose(ALICE,buy(2)));
  const r=x.sign_requests[0];
  if(where==='uncertain')rpc.s.broadcastError='socket hang up';
  await sub(f.p,r,await f.sign(r)).catch(()=>{});
  assert.equal(batchRow(db,r.attempt_id).state,where);
  rpc.s.broadcastError=null;env.YEET_BASE_PAUSE='0';
  const p2=f.restart();
  if(where==='signed'){await f.tick(x.trade_id);assert.equal(batchRow(db,r.attempt_id).state,'submitted')}
  if(where==='uncertain'){await f.tick(x.trade_id);assert.equal(batchRow(db,r.attempt_id).state,'submitted','the same bytes again')}
  assert.equal(statuses(db,x.trade_id).join(),'signing,signing');
  const hashes=new Set(rpc.s.broadcasts.map(b=>keccak256(b)));
  assert.equal(hashes.size,1,'one outer transaction');
  await mine(rpc,rpc.s.broadcasts.at(-1));
  await f.tick(x.trade_id);await f.tick(x.trade_id);await p2.tracker.pollOnce();
  assert.deepEqual(statuses(db,x.trade_id),['sent','sent']);
  assert.equal(oneclick.calls.submit.length,2);
 });
}

test('RBF: a stuck batch is replaced (+12.5%), the second hash lands and every leg follows it',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc,oneclick}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 await sub(p,x.sign_requests[0],await f.sign(x.sign_requests[0]));
 f.now.advance(31_000);await p.recoverTrade(x.trade_id);
 assert.equal(rpc.s.broadcasts.length,2);
 const second=await mine(rpc,rpc.s.broadcasts[1]);
 await f.tick(x.trade_id);
 assert.deepEqual(statuses(db,x.trade_id),['sent','sent']);
 assert.ok(legs(db,x.trade_id).every(l=>l.tx_hash===second));
 assert.ok(oneclick.calls.submit.every(c=>c.txHash===second));
});

test('a batch signed while the gas wallet is busy waits with its legs in signing (no hash), then sends, lands and notifies once per leg',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc,oneclick}=f;
 // Another gas-wallet transaction in flight (a top-up for some other trade).
 const t0=f.now();
 db.prepare("INSERT INTO base_attempt(id,kind,trade_id,leg_idx,account_id,wallet,sender,nonce,tx_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
  .run('busy-topup','gas_topup','t_busy',0,'other','0x'+'99'.repeat(20),f.gas.address,0,'{}','submitted',t0,t0);
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 const r=x.sign_requests[0];
 const s=await sub(p,r,await f.sign(r));
 assert.deepEqual(s.legs.map(l=>l.send_status),['signing','signing']);
 assert.ok(s.legs.every(l=>l.tx_hash==null));assert.equal(rpc.s.broadcasts.length,0);
 assert.equal(batchRow(db,r.attempt_id).state,'signed');
 db.prepare("UPDATE base_attempt SET state='confirmed' WHERE id='busy-topup'").run();
 await f.tick(x.trade_id);
 assert.equal(rpc.s.broadcasts.length,1);
 const hash=keccak256(rpc.s.broadcasts[0]);
 assert.ok(legs(db,x.trade_id).every(l=>l.tx_hash===hash),'the legs carry the hash once it is sent');
 await mine(rpc,rpc.s.broadcasts[0]);await f.tick(x.trade_id);
 assert.deepEqual(statuses(db,x.trade_id),['sent','sent']);
 assert.equal(oneclick.calls.submit.length,2);assert.ok(oneclick.calls.submit.every(c=>c.txHash===hash));
});

test('deadline passed while unsent: the batch is cancelled and the legs end not_sent, amounts held',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 rpc.s.broadcastError='socket hang up';
 const r=x.sign_requests[0];
 await sub(p,r,await f.sign(r)).catch(()=>{});
 const b=batchRow(db,r.attempt_id);
 f.now.set(b.deadline*1000+1);
 await p.recoverTrade(x.trade_id);
 assert.equal(batchRow(db,r.attempt_id).code,'DEADLINE_PASSED_UNSENT');
 assert.deepEqual(statuses(db,x.trade_id),['not_sent','not_sent']);
 assert.deepEqual(p.ledger.holds(x.trade_id).map(h=>h.state),['held','held']);
});

test('base_7702_deposit_unseen: a leg still PENDING_DEPOSIT 5 min after landing sets base_mode_auto_legacy; new trades go legacy',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc,oneclick}=f;
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 for(const l of legs(db,x.trade_id))oneclick.deposits.get(l.deposit_address).script=['status-pending.json'];
 await sub(p,x.sign_requests[0],await f.sign(x.sign_requests[0]));
 await mine(rpc,rpc.s.broadcasts[0]);await f.tick(x.trade_id);
 assert.deepEqual(statuses(db,x.trade_id),['sent','sent']);
 await p.tracker.pollOnce();
 assert.equal(db.prepare('SELECT value FROM base_driver_state WHERE key=?').get(AUTO_LEGACY_FLAG)?.value??null,null,'not before DEPOSIT_SEEN_MS');
 f.now.advance(300_001);
 await p.tracker.pollOnce();
 assert.equal(db.prepare('SELECT value FROM base_driver_state WHERE key=?').get(AUTO_LEGACY_FLAG).value,'1');
 const alert=db.prepare("SELECT * FROM trade_alerts WHERE dedup_key LIKE 'base_7702_deposit_unseen:%'").get();
 assert.equal(JSON.parse(alert.detail_json).alert,'base_7702_deposit_unseen');
 const y=await exec(p,await p.propose(ALICE,buy(2,{tag:'after'})));
 assert.ok(y.sign_requests.every(q=>q.kind==='evm_tx'));
});

test('base_7702_deposit_unseen: a /deposit/submit error naming the batch hash also switches to legacy',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'7702'}});const {p,db,rpc,oneclick}=f;
 oneclick.submitDeposit=async(addr,hash)=>{oneclick.calls.submit.push({depositAddress:addr,txHash:hash});throw Error(`deposit tx ${hash} not found for ${addr}`)};
 const x=await exec(p,await p.propose(ALICE,buy(2)));
 await sub(p,x.sign_requests[0],await f.sign(x.sign_requests[0]));
 await mine(rpc,rpc.s.broadcasts[0]);await f.tick(x.trade_id);
 assert.equal(db.prepare('SELECT value FROM base_driver_state WHERE key=?').get(AUTO_LEGACY_FLAG).value,'1');
});

test('a wallet delegated by YEET still trades on the legacy path (YEET_BASE_MODE=legacy): guard 5 passes, the top-up is 40000 gas',async()=>{
 const f=await fakeBasePipeline({env:{YEET_BASE_MODE:'legacy'},userKey:USER_KEY});const {p,rpc}=f;
 delegate(rpc,f.wallet);
 const x=await exec(p,await p.propose(ALICE,buy(1)));
 assert.equal(x.sign_requests[0].kind,'evm_tx');
 await sub(p,x.sign_requests[0],await f.sign(x.sign_requests[0]));
 assert.equal(parseTransaction(rpc.s.broadcasts[0]).gas,40_000n);
});

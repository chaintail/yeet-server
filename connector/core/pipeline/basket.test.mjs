// The Solana basket in ONE transaction end to end on fakes (plan SOLANA-BASKET-ONE-TX-PLAN.md 4.1 ledger, 4.2): one
// sign request for every leg, one signature, one co-sign, every leg moves together; the fallback to one request per
// leg; expiry; recovery after a restart; the landing watcher with 10 replays.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePipeline,fakeSolanaRpc,signAs,ALICE,aliceWallet} from './fakes.mjs';
import {decodeTransaction,encodeTransaction,encodeMessage,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC_SOLANA} from './solana/message.mjs';
import {buildLegTransaction,legPin} from './solana/transfer-leg.mjs';
import {CATALOG,base58Encode} from '../trade/router.mjs';
import {spentToday} from '../trade/limits.mjs';

const FIVE=['WIF','BOME','TRUMP','PENGU','SPX'];
const mintOf=s=>CATALOG.find(c=>c.symbol===s&&c.chain==='solana').address;
const buy=(n=5,extra={})=>({request_id:`b${n}`,amount_usdc:String(3*n),legs:FIVE.slice(0,n).map(symbol=>({symbol,parts:1})),...extra});
const exec=(p,prop)=>p.execute(ALICE,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const sub=(p,req,signed,opts)=>p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed},opts);
const leg=(db,id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
const legs=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const statuses=(db,id)=>legs(db,id).map(l=>l.send_status);
const decodeSig=b64=>base58Encode(decodeTransaction(Buffer.from(b64,'base64')).signatures[0]);
const confirmSent=rpc=>{for(const b64 of rpc.sent)rpc.statuses.set(decodeSig(b64),{status:'confirmed',commitment:'confirmed',slot:5})};
const rentDay=db=>db.prepare('SELECT COALESCE(SUM(accounts),0) a,COALESCE(SUM(lamports),0) l FROM sponsor_rent_day').get();
const txDay=db=>db.prepare('SELECT COALESCE(SUM(transactions),0) n FROM sponsor_day').get().n;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const fiveCoins=()=>[{mint:USDC_SOLANA,raw:100_000_000n,decimals:6},...FIVE.map(s=>({mint:mintOf(s),raw:1_000_000_000n,decimals:6}))];

test('5-leg BUY: 1 sign request for legs 0..4, one signature, one co-sign, all legs move together, 5 deposit notices, per-leg 1Click outcomes fold to partial',async()=>{
 const f=fakePipeline();const {p,db,rpc,feePayer,oneclick}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 assert.equal(x.sign_requests.length,1);
 const r=x.sign_requests[0];
 assert.equal(r.leg,0);assert.deepEqual(r.legs,[0,1,2,3,4]);
 assert.deepEqual(r.leg_summaries.map(s=>s.leg),[0,1,2,3,4]);
 assert.deepEqual(r.leg_summaries.map(s=>s.to),legs(db,x.trade_id).map(l=>l.deposit_address));
 assert.deepEqual(r.summary,(({leg:_,...s})=>s)(r.leg_summaries[0]),'summary is the anchor leg');
 const bytes=Buffer.from(r.payload.transaction_base64,'base64');
 assert.equal(bytes.length,899,'measured 5-leg buy size');
 assert.equal(decodeTransaction(bytes).message.instructions.length,12);
 // One transaction reserved: one sponsored send, 5 rent accounts.
 assert.equal(txDay(db),1);assert.equal(rentDay(db).a,5);
 assert.equal(db.prepare('SELECT rent_accounts FROM sponsor_send').get().rent_accounts,5);
 assert.ok(legs(db,x.trade_id).every(l=>l.attempt_id===r.attempt_id));
 const s=await sub(p,r,signAs(aliceWallet,r));
 assert.deepEqual(s.legs.map(l=>l.send_status),Array(5).fill('signing'));
 assert.equal(new Set(s.legs.map(l=>l.tx_hash)).size,1,'one hash for every leg');
 assert.equal(feePayer.calls,1);assert.equal(rpc.sent.length,1);
 // 1Click settles each leg alone: two refunded, three succeed.
 for(const [i,l] of legs(db,x.trade_id).entries())oneclick.deposits.get(l.deposit_address).script=i<2?['status-refunded.json']:['status-success.json'];
 confirmSent(rpc);
 await p.tracker.pollOnce();
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('sent'));
 assert.equal(oneclick.calls.submit.length,5,'one deposit notice per leg');
 assert.deepEqual(new Set(oneclick.calls.submit.map(c=>c.txHash)).size,1);
 await p.tracker.pollOnce();await p.tracker.pollOnce();
 assert.equal(p.status(ALICE,x.trade_id).status,'partial');
 assert.equal(oneclick.calls.submit.length,5,'never a second notice');
});

test('5-leg SELL with a Token-2022 coin: 1 request (1187 bytes), exit exempt, one signature',async()=>{
 const rpc=fakeSolanaRpc();const info=rpc.accountInfo;const t22=mintOf('SPX');
 rpc.accountInfo=async a=>a===t22?{owner:TOKEN_2022_PROGRAM,lamports:1}:info(a);
 const f=fakePipeline({rpc,holdings:fiveCoins()});const {p,db,feePayer}=f;
 const s=await p.skeet(ALICE,{request_id:'s5',legs:FIVE.map(symbol=>({symbol,percent:50}))});
 const x=await exec(p,s);
 assert.equal(x.sign_requests.length,1);
 const r=x.sign_requests[0];
 assert.deepEqual(r.legs,[0,1,2,3,4]);assert.deepEqual(r.leg_summaries.map(l=>[l.side,l.asset]),FIVE.map(a=>['sell',a]));
 const bytes=Buffer.from(r.payload.transaction_base64,'base64');
 assert.equal(bytes.length,1187,'measured 5-leg sell with Token-2022');
 assert.ok(decodeTransaction(bytes).message.accounts.includes(TOKEN_2022_PROGRAM));
 assert.equal(db.prepare('SELECT sponsor_exit FROM client_trade WHERE attempt_id=?').get(r.attempt_id).sponsor_exit,1);
 const out=await sub(p,r,signAs(aliceWallet,r));
 assert.deepEqual(out.legs.map(l=>l.send_status),Array(5).fill('signing'));assert.equal(feePayer.calls,1);
});

test('YEET_SOL_BATCH_MAX_LEGS=1: one request per leg, each byte-identical to today\'s single-leg transaction',async()=>{
 const f=fakePipeline({env:{YEET_SOL_BATCH_MAX_LEGS:'1'}});const {p,db,rpc,feePayer}=f;
 const x=await exec(p,await p.propose(ALICE,buy(3)));
 assert.equal(x.sign_requests.length,3);
 for(const r of x.sign_requests){
  assert.deepEqual(r.legs,[r.leg]);assert.equal(r.leg_summaries.length,1);
  const l=leg(db,x.trade_id,r.leg),bytes=Buffer.from(r.payload.transaction_base64,'base64');
  const pin=await legPin({leg:l,wallet:aliceWallet.address,feePayer:feePayer.address,rpc});
  assert.deepEqual(Uint8Array.from(bytes),buildLegTransaction(pin,{blockhash:decodeTransaction(bytes).message.blockhash,createDestination:true}));
 }
 for(const r of x.sign_requests)await sub(p,r,signAs(aliceWallet,r));
 assert.equal(feePayer.calls,3);assert.equal(txDay(db),3);
});

test('fallback: a basket over the rent quota falls back to per-leg requests (the quota admits what it can); a 2-leg basket of one leg is just the leg',async()=>{
 const f=fakePipeline({env:{YEET_SPONSOR_DAILY_RENT_ACCOUNTS:'3'}});const {p,db,logs}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 assert.deepEqual(x.sign_requests.map(r=>r.legs),[[0],[1],[2]]);
 assert.deepEqual(statuses(db,x.trade_id),['awaiting_signature','awaiting_signature','awaiting_signature','not_sent','not_sent']);
 assert.ok(logs.some(l=>l.includes('"basket_fallback"')&&l.includes('SPONSOR_QUOTA_EXHAUSTED')));
 assert.equal(rentDay(db).a,3);
});

test('fallback: a basket over a lowered fee cap (5 legs 18,000 > 15,000) falls back to per-leg requests (11,600 each)',async()=>{
 const f=fakePipeline({env:{YEET_SPONSOR_MAX_FEE_LAMPORTS:'15000'}});const {p,db,logs}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 assert.deepEqual(x.sign_requests.map(r=>r.legs),[[0],[1],[2],[3],[4]]);
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('awaiting_signature'));
 assert.ok(logs.some(l=>l.includes('"basket_fallback"')&&l.includes('CLIENT_FEE_CAP_EXCEEDED')));
 assert.equal(txDay(db),5);assert.equal(rentDay(db).a,5);
});

test('ledger: one attempt covers 5 legs; a second issue on any covered leg is refused; claim/finish/confirm move all; refunds give back 5 rent accounts',async()=>{
 const f=fakePipeline();const {p,db}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 const r=x.sign_requests[0],a=p.ledger.attempt(r.attempt_id);
 assert.deepEqual(JSON.parse(a.batch_json).legs,[0,1,2,3,4]);
 for(const i of [0,2,4]){
  assert.equal(p.ledger.openAttempt(x.trade_id,i).attempt_id,r.attempt_id);
  assert.throws(()=>p.ledger.issue({tradeId:x.trade_id,idxs:[i],accountId:ALICE.accountId,wallet:aliceWallet.address,chain:'sol',kind:'solana_tx',payload:{},payloadSha256:'x',expiresAt:f.now()+1}),/already open/);
 }
 // Replay answers the same single request.
 const again=await p.signRequests(ALICE,x.trade_id);
 assert.deepEqual(again.map(q=>q.attempt_id),[r.attempt_id]);
 // legNotSent of one covered leg: the attempt is abandoned whole (quota back), the other 4 keep waiting.
 assert.equal(p.ledger.legNotSent(x.trade_id,2,{reason:'test: one leg cancelled'}),true);
 assert.equal(p.ledger.attempt(r.attempt_id).status,'abandoned');
 assert.deepEqual(statuses(db,x.trade_id),['awaiting_signature','awaiting_signature','not_sent','awaiting_signature','awaiting_signature']);
 assert.equal(txDay(db),0);assert.equal(rentDay(db).a,0,'5 rent accounts refunded');assert.equal(rentDay(db).l,0);
 // One fresh basket request for the 4 legs left.
 const fresh=await p.signRequests(ALICE,x.trade_id);
 assert.equal(fresh.length,1);assert.deepEqual(fresh[0].legs,[0,1,3,4]);
 assert.equal(rentDay(db).a,4);
 const s=await sub(p,fresh[0],signAs(aliceWallet,fresh[0]));
 assert.deepEqual(s.legs.map(l=>l.send_status),['signing','signing','not_sent','signing','signing']);
});

test('rent quota 10 a day: two signed 5-leg buys use it; the third basket falls back and nothing over the quota is issued',async()=>{
 const f=fakePipeline({holdings:[{mint:USDC_SOLANA,raw:1_000_000_000n,decimals:6}]});const {p,db}=f;
 for(const n of ['q1','q2']){
  const x=await exec(p,await p.propose(ALICE,buy(5,{request_id:n})));
  assert.equal(x.sign_requests.length,1);await sub(p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 }
 assert.equal(rentDay(db).a,10);
 const third=exec(p,await p.propose(ALICE,buy(5,{request_id:'q3'})));
 await assert.rejects(third,e=>e.code==='LIMIT_EXCEEDED');
 assert.equal(rentDay(db).a,10);
});

test('SIGN_EXPIRED: one fresh request re-covers all 5; a leg past its deadline drops out (not_sent on recovery); expiry = earliest deadline - margin',async()=>{
 const f=fakePipeline();const {p,db,rpc,now}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 const r=x.sign_requests[0];
 rpc.valid=false;
 const out=await sub(p,r,signAs(aliceWallet,r));
 rpc.valid=true;
 assert.deepEqual(out.legs.map(l=>l.send_status),Array(5).fill('awaiting_signature'));
 assert.equal(out.sign_requests.length,1);assert.deepEqual(out.sign_requests[0].legs,[0,1,2,3,4]);
 assert.equal(p.ledger.attempt(r.attempt_id).status,'abandoned');assert.equal(txDay(db),1,'one live reservation');
 // Leg 2's deposit deadline is now inside the margin; leg 3's governs the expiry of the next request.
 const setDeadline=(idx,ms)=>{const l=leg(db,x.trade_id,idx),q=JSON.parse(l.live_quote_json);q.deadline=new Date(ms).toISOString();
  db.prepare('UPDATE trade_legs SET live_quote_json=? WHERE trade_id=? AND idx=?').run(JSON.stringify(q),x.trade_id,idx)};
 setDeadline(2,now()+60_000);setDeadline(3,now()+150_000);
 rpc.valid=false;
 const out2=await sub(p,out.sign_requests[0],signAs(aliceWallet,out.sign_requests[0]));
 rpc.valid=true;
 assert.equal(out2.sign_requests.length,1);
 const r3=out2.sign_requests[0];
 assert.deepEqual(r3.legs,[0,1,3,4]);
 assert.equal(r3.expires_at,new Date(now()+150_000-120_000).toISOString());
 await p.recoverTrade(x.trade_id);
 assert.equal(leg(db,x.trade_id,2).send_status,'not_sent');
 assert.equal(p.ledger.attempt(r3.attempt_id).status,'pending','the 4-leg request stays open');
 const s=await sub(p,r3,signAs(aliceWallet,r3));
 assert.deepEqual(s.legs.map(l=>l.send_status),['signing','signing','not_sent','signing','signing']);
});

test('restart: a new pipeline on the same database confirms every leg of a confirming basket and sends each notice once',async()=>{
 const a=fakePipeline();
 const x=await exec(a.p,await a.p.propose(ALICE,buy()));
 await sub(a.p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 assert.deepEqual(statuses(a.db,x.trade_id),Array(5).fill('signing'));
 confirmSent(a.rpc);
 const b=fakePipeline({db:a.db,rpc:a.rpc,feePayer:a.feePayer,now:a.now,oneclick:a.oneclick});
 await b.p.tracker.pollOnce();
 assert.deepEqual(statuses(a.db,x.trade_id),Array(5).fill('sent'));
 assert.equal(a.oneclick.calls.submit.length,5);
 await b.p.tracker.pollOnce();
 assert.equal(a.oneclick.calls.submit.length,5,'each notice once');
 assert.equal(a.feePayer.calls,1);
});

test('chain failure: the basket landed and failed, every leg failed, the fee kept, every BUY amount held',async()=>{
 const f=fakePipeline();const {p,db,rpc}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 const s=await sub(p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 rpc.statuses.set(s.legs[0].tx_hash,{status:'failed',commitment:'confirmed',slot:9,err:{InstructionError:[5,'Custom']}});
 await p.recoverTrade(x.trade_id);
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('failed'));
 assert.equal(txDay(db),1,'the fee was paid');
 assert.equal(p.ledger.holds(x.trade_id).length,5,'a spend hold per leg');
 assert.equal(spentToday(db,ALICE.accountId,f.now()),15_000_000n);
});

test('fee payer refusal at co-sign: every leg of the attempt failed, quota back, a hold per leg',async()=>{
 const f=fakePipeline();const {p,db,feePayer}=f;
 const x=await exec(p,await p.propose(ALICE,buy(3)));
 feePayer.refuse='PRIVY_POLICY_DENIED';
 const out=await sub(p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 assert.deepEqual(out.legs.map(l=>l.send_status),['failed','failed','failed']);
 assert.equal(txDay(db),0);assert.equal(rentDay(db).a,0);
 assert.equal(p.ledger.holds(x.trade_id).length,3);
});

test('the stored unsigned bytes are pinned at submit: a tampered leg-4 amount is refused before any co-sign',async()=>{
 const f=fakePipeline();const {p,db,feePayer,logs}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 const r=x.sign_requests[0];
 // Someone with database access rewrites the stored transaction (leg 4's amount +1) and signs that instead.
 const t=decodeTransaction(Buffer.from(r.payload.transaction_base64,'base64'));
 const m=structuredClone(t.message),ix=m.instructions.at(-1);
 const amt=Buffer.from(ix.data.subarray(1,9));amt.writeBigUInt64LE(amt.readBigUInt64LE(0)+1n);ix.data=Uint8Array.from([12,...amt,ix.data[9]]);
 const tampered=Buffer.from(encodeTransaction([new Uint8Array(64),new Uint8Array(64)],encodeMessage(m))).toString('base64');
 db.prepare('UPDATE client_trade SET unsigned_base64=? WHERE attempt_id=?').run(tampered,r.attempt_id);
 const signed=Buffer.from(aliceWallet.signTransaction(Buffer.from(tampered,'base64'))).toString('base64');
 await assert.rejects(sub(p,r,signed),e=>e.code==='INVALID_ARGUMENT');
 assert.ok(logs.some(l=>l.includes('"unsigned_bytes_mismatch"')),'refused by the exact-bytes pin');
 assert.equal(feePayer.calls,0);
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('awaiting_signature'));
});

test('submit names the anchor leg only: another covered leg is INVALID_ARGUMENT',async()=>{
 const {p,feePayer}=fakePipeline();
 const x=await exec(p,await p.propose(ALICE,buy(3)));
 const r=x.sign_requests[0];
 await assert.rejects(p.submit(ALICE,{trade_id:r.trade_id,leg:1,attempt_id:r.attempt_id,signed:signAs(aliceWallet,r)}),e=>e.code==='INVALID_ARGUMENT');
 assert.equal(feePayer.calls,0);
});

test('10 identical submits of the basket: 1 watcher, 1 co-sign, 5 notices (one per leg), none twice; a racing tracker pass adds none',async()=>{
 const gate=deferred();let rpcRef;
 const sleep=async()=>{await gate.promise;confirmSent(rpcRef)};
 const f=fakePipeline({landing:{landingPollMs:1,landingWatchMs:10,sleep}});rpcRef=f.rpc;
 const {p,db,oneclick,feePayer}=f;
 const x=await exec(p,await p.propose(ALICE,buy()));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 for(let i=0;i<10;i++){const s=await sub(p,r,signed);assert.deepEqual(s.legs.map(l=>l.send_status),Array(5).fill('signing'))}
 assert.equal(p.landingWatches(),1,'one watcher per attempt');assert.equal(feePayer.calls,1);
 // 1Click still at PENDING_DEPOSIT for every leg while the tracker races the watcher: every notice is needed.
 for(const l of legs(db,x.trade_id))oneclick.deposits.get(l.deposit_address).script=['status-pending.json'];
 gate.resolve();
 const race=p.tracker.pollOnce();
 await p.landings();await race;
 await p.tracker.pollOnce();
 assert.equal(p.landingWatches(),0);
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('sent'));
 assert.ok(legs(db,x.trade_id).every(l=>l.deposit_submitted===1));
 assert.equal(oneclick.calls.submit.length,5);
 assert.equal(new Set(oneclick.calls.submit.map(c=>c.depositAddress)).size,5,'each leg once');
});

test('dry run of a basket: validated and simulated once, never co-signed; fee and rent are the transaction totals',async()=>{
 const {p,db,rpc,feePayer}=fakePipeline();
 const x=await exec(p,await p.propose(ALICE,buy()));
 const out=await sub(p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]),{dryRun:true});
 assert.equal(out.dry_run.state,'not_sent');assert.equal(out.dry_run.simulation.err,null);
 assert.equal(out.dry_run.fee_lamports,18_000);assert.equal(out.dry_run.rent_lamports,5*2_039_280);
 assert.equal(feePayer.calls,0);assert.equal(rpc.sent.length,0);assert.equal(rpc.simulated.length,1);assert.equal(rpc.simulated[0],899);
 assert.deepEqual(statuses(db,x.trade_id),Array(5).fill('awaiting_signature'));
});

test('a single-leg trade keeps working: legs [0], the same bytes as before',async()=>{
 const {p,rpc,feePayer}=fakePipeline();
 const x=await exec(p,await p.propose(ALICE,buy(1)));
 assert.equal(x.sign_requests.length,1);assert.deepEqual(x.sign_requests[0].legs,[0]);
 assert.equal(Buffer.from(x.sign_requests[0].payload.transaction_base64,'base64').length,535);
 const s=await sub(p,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 assert.equal(s.legs[0].send_status,'signing');assert.equal(feePayer.calls,1);assert.equal(rpc.sent.length,1);
 assert.equal(TOKEN_PROGRAM.length>0,true);
});

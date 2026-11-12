// Review fixes (yeet-engine-review-20261113): send recovery, crash recovery, tracker robustness, live-quote acceptance
// and confirm-code minting, all against the fakes (no network, no signer, no funds).
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeEngine} from './fakes.mjs';
import {fakeSigner,fakeOneClick} from './fakes.mjs';
import {legIdempotencyKey} from './signer.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const basket={request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:3},{symbol:'TRUMP',parts:2}]};
const exec=(engine,ctx,p,c=p.confirm.code)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:c});
const legRows=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const spent=db=>db.prepare('SELECT usdc_raw FROM daily_spend').get()?.usdc_raw;

test('fix 1: a transfer broadcast but answered without a hash stays sending, is not refunded, and a retry with the same key moves nothing twice',async()=>{
 const signer=fakeSigner({lostLegs:[1]});
 const {engine,db,oneclick,now}=await fakeEngine({signer});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'submitted');
 assert.deepEqual(r.legs.map(l=>l.status),['sent','sent','sent'],'an unconfirmed transfer is never reported as failed');
 assert.equal(r.legs[1].tx_hash,null);
 let legs=legRows(db,r.trade_id);
 assert.equal(legs[1].send_status,'sending');
 assert.equal(legs[1].idempotency_key,legIdempotencyKey('wallet-base',r.trade_id,1),'the key is stored before the signer call');
 assert.equal(spent(db),'20000000','the unconfirmed leg still counts against the daily cap');
 assert.equal(engine.status(alice,r.trade_id).status,'signing');
 assert.equal(signer.sent.length,3);
 // 1Click has not seen the deposit yet: recovery re-issues the same idempotency key; the provider answers the first hash.
 oneclick.deposits.get(legs[1].deposit_address).script=['status-pending.json','status-pending.json','status-processing.json'];
 await engine.tracker.pollOnce();
 assert.equal(legRows(db,r.trade_id)[1].send_status,'sending','not re-issued within 15 s of the last attempt');
 assert.equal(signer.replays,0);
 now.advance(20_000);
 await engine.tracker.pollOnce();
 legs=legRows(db,r.trade_id);
 assert.equal(legs[1].send_status,'sent');
 assert.equal(signer.sent.length,3,'the retry did not produce a second transfer');
 assert.equal(signer.replays,1);
 assert.equal(legs[1].tx_hash,signer.hashes.get(legs[1].idempotency_key),'the hash of the first (only) transfer');
 assert.ok(oneclick.calls.submit.some(s=>s.depositAddress===legs[1].deposit_address&&s.txHash===legs[1].tx_hash),'deposit submitted after recovery');
 assert.equal(spent(db),'20000000');
});

test('fix 1: an unconfirmed transfer that 1Click already sees is resolved by lookup, without calling the signer again',async()=>{
 const signer=fakeSigner({lostLegs:[0]});
 const {engine,db}=await fakeEngine({signer});
 const p=await engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]});
 const r=await exec(engine,alice,p);
 assert.equal(legRows(db,r.trade_id)[0].send_status,'sending');
 await engine.tracker.pollOnce();// fake 1Click answers PROCESSING with the origin tx hash
 const [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sent');assert.match(leg.tx_hash,/^0x[0-9a-f]{64}$/);
 assert.equal(signer.replays,0);assert.equal(signer.sent.length,1);
 await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r.trade_id).status,'success');
});

test('fix 1: transfer sent but deposit/submit failed: the leg is tracked and the submit is retried',async()=>{
 const oneclick=fakeOneClick({submitFailures:1});
 const {engine,db}=await fakeEngine({oneclick});
 const p=await engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]});
 const r=await exec(engine,alice,p);
 let [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sent');assert.equal(leg.deposit_submitted,0);
 oneclick.deposits.get(leg.deposit_address).script=['status-pending.json','status-success.json'];
 await engine.tracker.pollOnce();
 [leg]=legRows(db,r.trade_id);
 assert.equal(leg.deposit_submitted,1);assert.equal(oneclick.calls.submit.length,2,'deposit/submit retried once');
 await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r.trade_id).status,'success');
});

test('fix 1: only a positive "nothing broadcast" refusal marks a leg failed and returns its amount',async()=>{
 const signer=fakeSigner({failLegs:[0]});
 const {engine,db}=await fakeEngine({signer});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.deepEqual(legRows(db,r.trade_id).map(l=>l.send_status),['failed','sent','sent']);
 assert.equal(spent(db),'10000000');
});

test('fix 1: the Privy adapter marks only definite refusals as nothing-broadcast (notSent); timeouts, 5xx and a missing hash stay unknown',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {createDelegatedSigner}=await import('./signer-privy.mjs');
 const {BASE_WALLET}=await import('./fakes.mjs');
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const ENV={PRIVY_APP_ID:'test-app-id-123',PRIVY_APP_SECRET:'s',YEET_PRIVY_AUTHORIZATION_KEY:`wallet-auth:${privateKey.export({format:'der',type:'pkcs8'}).toString('base64')}`};
 const reply=r=>async()=>{if(r==='timeout')throw new Error('aborted');return new Response(JSON.stringify(r.body),{status:r.status})};
 const cases=[[{status:400,body:{code:'policy_violation'}},true],[{status:401,body:{error:'No valid authorization signatures were provided.'}},true],
  [{status:500,body:{}},undefined],[{status:200,body:{data:{}}},undefined],['timeout',undefined]];
 for(const [r,notSent] of cases){
  const s=createDelegatedSigner({env:ENV,fetch:reply(r)});
  await assert.rejects(s.transferUsdcBase({walletId:'w1',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'1',idempotencyKey:'d'.repeat(64)}),e=>e.notSent===notSent,JSON.stringify(r));
 }
 const s=createDelegatedSigner({env:ENV,fetch:reply({status:200,body:{}})});
 await assert.rejects(s.transferUsdcBase({walletId:'bad id',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'1',idempotencyKey:'d'.repeat(64)}),e=>e.notSent===true,'refused before any request');
 await assert.rejects(s.transferSpl({walletId:'w1'}),e=>e.code==='WALLET_NOT_READY'&&e.notSent===true,'no fee payer: nothing built');
});

const until=async(fn,what)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setImmediate(r))}throw Error(`timed out waiting for ${what}`)};
/** An engine that "dies" right after the commit (the send never starts), and a restarted engine on the same state. */
async function crashAfterCommit(){
 const {createEngine}=await import('./engine.mjs');
 const first=await fakeEngine({hooks:{afterCommit:()=>new Promise(()=>{})}});
 const p=await first.engine.propose(alice,basket);
 exec(first.engine,alice,p).catch(()=>{});
 const tradeRow=()=>first.db.prepare('SELECT * FROM trades').get();
 await until(()=>tradeRow()?.status==='signing','the commit');
 const signer=fakeSigner();
 const engine=await createEngine({db:first.db,env:{YEET_LIVE:'1'},client:first.oneclick,signer,balances:first.balances,now:first.now,trackerIntervalMs:60_000});
 return {p,db:first.db,now:first.now,tradeId:tradeRow().id,engine,signer,oneclick:first.oneclick};
}

test('fix 2: crash between commit and send, deadline open: the restarted engine sweeps on start and sends every leg once',async()=>{
 const {p,db,tradeId,engine,signer,oneclick}=await crashAfterCommit();
 assert.deepEqual(legRows(db,tradeId).map(l=>l.send_status),['queued','queued','queued']);
 assert.equal(spent(db),'20000000');
 engine.tracker.start();
 try{await until(()=>legRows(db,tradeId).every(l=>l.send_status==='sent'),'the startup sweep')}finally{engine.tracker.stop()}
 assert.equal(signer.sent.length,3);assert.equal(oneclick.calls.submit.length,3);
 assert.deepEqual(signer.sent.map(s=>s.idempotencyKey),[0,1,2].map(i=>legIdempotencyKey('wallet-base',tradeId,i)));
 const replay=await exec(engine,alice,p);
 assert.equal(replay.trade_id,tradeId);assert.deepEqual(replay.legs.map(l=>l.status),['sent','sent','sent']);
 assert.ok(replay.legs.every(l=>l.tx_hash));
 assert.equal(db.prepare('SELECT status FROM proposals').get().status,'executed');
 assert.equal(signer.sent.length,3);
});

test('fix 2: crash between commit and send, deadline passed: legs not_sent, cap returned, and the replayed code answers the true state',async()=>{
 const {p,db,now,tradeId,engine,signer}=await crashAfterCommit();
 now.advance(31*60_000);// past the 30 min 1Click deadline
 await assert.rejects(exec(engine,alice,p),e=>e.code==='TEMPORARILY_UNAVAILABLE','nothing was traded; not a stale `submitted`');
 assert.deepEqual(legRows(db,tradeId).map(l=>l.send_status),['not_sent','not_sent','not_sent']);
 assert.equal(spent(db),'0');
 assert.equal(signer.sent.length,0);
 assert.equal(db.prepare('SELECT status FROM proposals').get().status,'failed');
 assert.equal(engine.status(alice,tradeId).status,'failed');
 await assert.rejects(exec(engine,alice,p),e=>e.code==='TEMPORARILY_UNAVAILABLE','replay answers the same');
});

test('fix 3: one trade failing to refresh does not stop the tick for the others; the error is recorded on that trade',async()=>{
 const {engine,db}=await fakeEngine();
 const a=await exec(engine,alice,await engine.propose(alice,{...basket,request_id:'a',legs:[{symbol:'WIF',parts:10}]}));
 const b=await exec(engine,alice,await engine.propose(alice,{...basket,request_id:'b',legs:[{symbol:'BOME',parts:10}]}));
 db.prepare('UPDATE trade_legs SET receipt_leg_json=? WHERE trade_id=?').run('{',a.trade_id);// unparsable stored receipt
 db.prepare('UPDATE trades SET created_at=created_at-1 WHERE id=?').run(a.trade_id);// polled first
 await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,b.trade_id).status,'settling','the other trade moved on');
 assert.match(db.prepare('SELECT last_error FROM trades WHERE id=?').get(a.trade_id).last_error,/JSON/);
 await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,b.trade_id).status,'success');
});

test('fix 3: an unfinished trade is polled until deadline + YEET_TRACK_MAX_HOURS, then marked stale with a reason the card shows',async()=>{
 const oneclick=fakeOneClick({statuses:['status-processing.json']});
 const {engine,db,now}=await fakeEngine({oneclick,env:{YEET_LIVE:'1',YEET_TRACK_MAX_HOURS:'2'}});
 const r=await exec(engine,alice,await engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]}));
 now.advance(30*60_000+2*3600_000-60_000);// a minute before the horizon: still tracked (the old 2 h cap would have stopped)
 assert.equal(await engine.tracker.pollOnce(),1);
 assert.equal(engine.status(alice,r.trade_id).status,'settling');
 now.advance(120_000);
 await engine.tracker.pollOnce();
 const s=engine.status(alice,r.trade_id);
 assert.equal(s.status,'failed');assert.equal(s.legs[0].status,'PROCESSING');
 assert.match(s.legs[0].refund_reason,/^Tracking stopped after 2 h/);
 assert.ok(db.prepare('SELECT stale_at FROM trades').get().stale_at);
 const calls=oneclick.calls.status.length;
 assert.equal(await engine.tracker.pollOnce(),0);assert.equal(oneclick.calls.status.length,calls,'no longer polled');
 await assert.rejects(fakeEngine({env:{YEET_TRACK_MAX_HOURS:'forever'}}),/Invalid YEET_TRACK_MAX_HOURS/);
});

test('fix 3: INCOMPLETE_DEPOSIT is not final while the deposit deadline is open, and final (refunded) after it',async()=>{
 const oneclick=fakeOneClick({statuses:['status-incomplete.json']});
 const {engine,now}=await fakeEngine({oneclick});
 const r=await exec(engine,alice,await engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]}));
 await engine.tracker.pollOnce();
 let s=engine.status(alice,r.trade_id);
 assert.equal(s.legs[0].status,'INCOMPLETE_DEPOSIT');assert.equal(s.status,'settling');
 now.advance(31*60_000);
 assert.equal(await engine.tracker.pollOnce(),1);
 s=engine.status(alice,r.trade_id);
 assert.equal(s.status,'refunded');
 assert.equal(await engine.tracker.pollOnce(),0,'final: no longer polled');
});

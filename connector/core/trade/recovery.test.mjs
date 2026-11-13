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
async function crashAfterCommit({env={YEET_LIVE:'1'},signer:firstSigner}={}){
 const {createEngine}=await import('./engine.mjs');
 const first=await fakeEngine({signer:firstSigner,hooks:{afterCommit:()=>new Promise(()=>{})}});
 const p=await first.engine.propose(alice,basket);
 exec(first.engine,alice,p).catch(()=>{});
 const tradeRow=()=>first.db.prepare('SELECT * FROM trades').get();
 await until(()=>tradeRow()?.status==='signing','the commit');
 const signer=fakeSigner();
 const engine=await createEngine({db:first.db,env,client:first.oneclick,signer,balances:first.balances,now:first.now,trackerIntervalMs:60_000});
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

for(const [label,env] of [['kill switch on',{YEET_LIVE:'1',YEET_KILL_SWITCH:'1'}],['YEET_LIVE unset',{}]]){
 test(`recovery while paused (${label}): queued legs are released as not_sent, nothing is sent, the cap is returned`,async()=>{
  const {db,tradeId,engine,signer}=await crashAfterCommit({env});
  await engine.tracker.pollOnce();
  assert.equal(signer.sent.length,0,'no transfer while trading is paused');
  assert.deepEqual(legRows(db,tradeId).map(l=>l.send_status),['not_sent','not_sent','not_sent']);
  assert.equal(spent(db),'0');
  assert.equal(db.prepare('SELECT status FROM proposals').get().status,'failed');
  const ev=db.prepare("SELECT evidence_json FROM trade_events WHERE trade_id=? AND to_status='not_sent'").all(tradeId);
  assert.ok(ev.length===3&&ev.every(e=>JSON.parse(e.evidence_json).reason==='trading paused'));
 });
 test(`recovery while paused (${label}): a sending leg is looked up but never re-issued`,async()=>{
  const {createEngine}=await import('./engine.mjs');
  const signer=fakeSigner({lostLegs:[0]});
  const first=await fakeEngine({signer});
  const p=await first.engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]});
  const r=await exec(first.engine,alice,p);
  const dep=legRows(first.db,r.trade_id)[0].deposit_address;
  first.oneclick.deposits.get(dep).script=['status-pending.json','status-pending.json','status-pending.json'];
  const s2=fakeSigner();
  const engine=await createEngine({db:first.db,env,client:first.oneclick,signer:s2,balances:first.balances,now:first.now,trackerIntervalMs:60_000});
  first.now.advance(20_000);
  await engine.tracker.pollOnce();
  assert.equal(s2.sent.length+s2.replays,0,'not re-issued while paused');
  assert.equal(legRows(first.db,r.trade_id)[0].send_status,'sending');
  assert.equal(spent(first.db),'20000000','still counted as spent');
 });
}

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

test('fix 4: a live leg more than YEET_REQUOTE_TOLERANCE_BPS under the previewed estimate is a REQUOTE, even above min_out',async()=>{
 const {engine,oneclick,signer}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 oneclick.liveRatio=0.993;// 70 bps under the estimate, above min_out (99%)
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'requote_required');assert.equal(r.requote.revision,2);assert.equal(signer.sent.length,0);
 const {engine:loose,oneclick:o2,signer:s2}=await fakeEngine({env:{YEET_LIVE:'1',YEET_REQUOTE_TOLERANCE_BPS:'100'}});
 const q=await loose.propose(alice,basket);
 o2.liveRatio=0.993;
 assert.equal((await exec(loose,alice,q)).status,'submitted');assert.equal(s2.sent.length,3);
 await assert.rejects(fakeEngine({env:{YEET_REQUOTE_TOLERANCE_BPS:'-1'}}),/Invalid YEET_REQUOTE_TOLERANCE_BPS/);
});

test('fix 4: a deposit address that is the own wallet, the USDC contract, zero, malformed or repeated refuses the whole trade before any send',async()=>{
 const {BASE_WALLET}=await import('./fakes.mjs');
 const {USDC_BASE}=await import('./signer.mjs');
 const bad=[()=>BASE_WALLET,()=>USDC_BASE.toLowerCase(),()=>'0x'+'0'.repeat(40),()=>'0x1234',()=>'0x'+'22'.repeat(20)];
 for(const depositFor of bad){
  const {engine,oneclick,signer,db}=await fakeEngine();
  const p=await engine.propose(alice,basket);
  oneclick.depositFor=n=>n===2||depositFor===bad[4]?depositFor():undefined;// second leg only; the last case: every leg the same
  await assert.rejects(exec(engine,alice,p),e=>e.code==='TEMPORARILY_UNAVAILABLE',String(depositFor));
  assert.equal(signer.sent.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM trades').get().n,0,'nothing committed');
  assert.equal(spent(db),undefined,'no spend recorded');
 }
});

test('fix 4: assertLivePlan checks origin asset, exact amountIn, destination coin, recipient and refund address per leg',async()=>{
 const {assertLivePlan}=await import('./executor.mjs');
 const {FUNDING,CATALOG}=await import('./router.mjs');
 const {BASE_WALLET,SOL_WALLET}=await import('./fakes.mjs');
 const wif=CATALOG.find(c=>c.symbol==='WIF'&&c.chain==='solana');
 const w={base:{address:BASE_WALLET},solana:{address:SOL_WALLET}};
 const legs=[{symbol:'WIF',asset_id:wif.assetId,amount_in_raw:'10000000'}];
 const leg={index:0,symbol:'WIF',origin:{assetId:FUNDING.assetId,chain:'base',symbol:'USDC'},destination:{assetId:wif.assetId,chain:'solana',symbol:'WIF'},amountIn:'10000000',depositAddress:'0x'+'33'.repeat(20),correlationId:'cid-x'};
 const plan={direction:'yeet',recipient:SOL_WALLET,refundTo:BASE_WALLET,legs:[leg]};
 assert.doesNotThrow(()=>assertLivePlan({direction:'yeet',live:plan,legs,w}));
 const variants=[
  {legs:[{...leg,origin:{...leg.origin,assetId:'nep141:eth.omft.near'}}]},
  {legs:[{...leg,amountIn:'10000001'}]},
  {legs:[{...leg,destination:{...leg.destination,assetId:'nep141:other.near'}}]},
  {recipient:'7'.repeat(44)},
  {refundTo:'0x'+'44'.repeat(20)},
  {legs:[{...leg,depositAddress:SOL_WALLET}]},
  {legs:[]},
 ];
 for(const v of variants)assert.throws(()=>assertLivePlan({direction:'yeet',live:{...plan,...v},legs,w}),e=>e.code==='TEMPORARILY_UNAVAILABLE',JSON.stringify(v));
 // SKEET: origin is the coin on Solana, destination USDC on Base; the deposit address must not be the coin's mint.
 const {base58Encode}=await import('./router.mjs');
 const skeetLeg={...leg,origin:{assetId:wif.assetId,chain:'solana',symbol:'WIF'},destination:{assetId:FUNDING.assetId,chain:'base',symbol:'USDC'},depositAddress:base58Encode(Buffer.alloc(32,9))};
 const skeet={direction:'skeet',recipient:BASE_WALLET,refundTo:SOL_WALLET,legs:[skeetLeg]};
 assert.doesNotThrow(()=>assertLivePlan({direction:'skeet',live:skeet,legs,w}));
 for(const v of [{legs:[{...skeetLeg,depositAddress:wif.address}]},{legs:[{...skeetLeg,depositAddress:'11111111111111111111111111111111'}]},{legs:[{...skeetLeg,origin:{...skeetLeg.origin,assetId:FUNDING.assetId}}]},{recipient:'0x'+'55'.repeat(20)}])
  assert.throws(()=>assertLivePlan({direction:'skeet',live:{...skeet,...v},legs,w}),e=>e.code==='TEMPORARILY_UNAVAILABLE',JSON.stringify(v));
});

const liveCodes=(db,proposalId,at)=>db.prepare('SELECT count(*) n FROM confirm_codes WHERE proposal_id=? AND used_at IS NULL AND expires_at>?').get(proposalId,at).n;

test('fix 5: re-calling propose (same request_id) or quote invalidates the earlier unused code: one live code per proposal',async()=>{
 const {engine,db,now,signer}=await fakeEngine();
 const first=await engine.propose(alice,basket);
 const second=await engine.propose(alice,basket);
 assert.equal(second.proposal_id,first.proposal_id);
 assert.equal(liveCodes(db,first.proposal_id,now()),1);
 await assert.rejects(exec(engine,alice,first),e=>e.code==='CONFIRMATION_REQUIRED','the earlier code no longer works');
 const q=await engine.quote(alice,{proposal_id:first.proposal_id});
 assert.equal(liveCodes(db,first.proposal_id,now()),1);
 await assert.rejects(exec(engine,alice,second),e=>e.code==='CONFIRMATION_REQUIRED');
 assert.equal(signer.sent.length,0);
 assert.equal((await exec(engine,alice,q)).status,'submitted');
});

test('fix 5: code minting is rate limited per account (YEET_CODE_MINT_LIMIT per 10 minutes)',async()=>{
 const {engine,now,oneclick}=await fakeEngine({env:{YEET_LIVE:'1',YEET_CODE_MINT_LIMIT:'3'}});
 for(let i=0;i<3;i++)await engine.propose(alice,basket);
 await assert.rejects(engine.propose(alice,basket),e=>e.code==='TEMPORARILY_UNAVAILABLE');
 const quotes=oneclick.calls.quote.length;
 await assert.rejects(engine.propose(alice,{...basket,request_id:'other'}),e=>e.code==='TEMPORARILY_UNAVAILABLE');
 assert.equal(oneclick.calls.quote.length,quotes,'refused before asking 1Click');
 assert.ok((await engine.propose({...alice,accountId:'yeet-privy-bob'},basket)).confirm,'per account');
 now.advance(10*60_000+1);
 assert.ok((await engine.propose(alice,basket)).confirm,'the window moves on');
 await assert.rejects(fakeEngine({env:{YEET_CODE_MINT_LIMIT:'many'}}),/Invalid YEET_CODE_MINT_LIMIT/);
});

test('review M1: a code that expires between the check and the commit is refused at consume; nothing moves',async()=>{
 const {engine,oneclick,now,signer,db}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 now.advance(119_000);
 oneclick.mutate=(res,req)=>{if(!req.dry)now.advance(2_000)};// live quotes take 6 s: the code is 125 s old at the commit
 await assert.rejects(exec(engine,alice,p),e=>e.code==='CONFIRMATION_REQUIRED');
 assert.equal(signer.sent.length,0);assert.equal(db.prepare('SELECT count(*) n FROM trades').get().n,0);
});

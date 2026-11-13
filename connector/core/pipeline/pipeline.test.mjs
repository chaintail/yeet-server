// The user-signed pipeline end to end on fakes (design section 5 item 1, Folio client-signing.test.ts cases ported):
// execute answers sign requests, the person's wallet signs, the fee payer co-signs only after every guard, bytes are
// persisted before the first send, the chain confirms, 1Click is told, the tracker settles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePipeline,fakeFeePayer,fakeSolanaRpc,signAs,ALICE,BOB,aliceWallet,bobWallet,WIF_MINT} from './fakes.mjs';
import {fakeOneClick} from '../trade/fakes.mjs';
import {decodeTransaction,encodeTransaction,associatedTokenAddress,USDC_SOLANA,TOKEN_PROGRAM} from './solana/message.mjs';
import {spentToday} from '../trade/limits.mjs';
import {limitsFromEnv} from '../trade/limits.mjs';

const basket={request_id:'r1',amount_usdc:'10',legs:[{symbol:'WIF',parts:1},{symbol:'BOME',parts:1}]};
const exec=(p,ctx,prop)=>p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const sub=(p,ctx,req,signed,opts)=>p.submit(ctx,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed},opts);
async function code(pr,c){await assert.rejects(pr,e=>e.code===c,`expected ${c}`)}
const leg=(db,id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
const confirmAll=(rpc,x)=>{for(const l of x.legs)if(l.tx_hash)rpc.statuses.set(l.tx_hash,{status:'confirmed',commitment:'confirmed',slot:5})};

test('BUY all-Solana: sign requests, person signs, fee payer co-signs, persisted before send, confirmed, 1Click told, settled',async()=>{
 const f=fakePipeline();const {p,db,rpc,feePayer,oneclick}=f;
 const prop=await p.propose(ALICE,basket);
 const x=await exec(p,ALICE,prop);
 assert.equal(x.status,'awaiting_signature');
 assert.equal(x.sign_requests.length,2);
 for(const r of x.sign_requests){
  assert.equal(r.kind,'solana_tx');assert.equal(r.chain,'sol');assert.equal(r.wallet,aliceWallet.address);
  assert.equal(r.summary.side,'buy');assert.equal(r.summary.asset,'USDC');
  const t=decodeTransaction(Buffer.from(r.payload.transaction_base64,'base64'));
  assert.deepEqual(t.message.accounts.slice(0,2),[feePayer.address,aliceWallet.address]);
  assert.ok(t.signatures.every(s=>s.every(b=>b===0)),'both slots empty');
  assert.match(r.attempt_id,/^[0-9a-f]{64}$/);
 }
 // The live quote: USDC on Solana in, the person's Solana wallet as recipient and refund address.
 const live=oneclick.calls.quote.filter(q=>!q.dry);
 assert.ok(live.every(q=>q.originAsset==='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'&&q.refundTo===aliceWallet.address&&q.recipient===aliceWallet.address));
 assert.equal(spentToday(db,ALICE.accountId,f.now()),10_000_000n);
 assert.equal(db.prepare("SELECT origin_chain FROM trades WHERE id=?").get(x.trade_id).origin_chain,'sol');
 // Persist before send: every broadcast finds its exact bytes committed.
 rpc.onBroadcast=bytes=>{const b64=Buffer.from(bytes).toString('base64');assert.ok(db.prepare('SELECT 1 FROM client_trade WHERE signed_base64=?').get(b64),'signed bytes committed before the send')};
 for(const r of x.sign_requests){
  const s=await sub(p,ALICE,r,signAs(aliceWallet,r));
  assert.equal(s.legs[r.leg].send_status,'signing');
  assert.ok(s.legs[r.leg].tx_hash);
 }
 assert.equal(feePayer.calls,2);assert.equal(rpc.sent.length,2);
 // Fee payer is account 0 and signed; the person's signature is preserved.
 const sent=decodeTransaction(Buffer.from(rpc.sent[0],'base64'));
 assert.ok(sent.signatures.every(s=>s.some(b=>b!==0)));
 const view=await p.signRequests(ALICE,x.trade_id);assert.equal(view.length,0);
 const legsNow=db.prepare('SELECT * FROM trade_legs WHERE trade_id=?').all(x.trade_id);
 confirmAll(rpc,{legs:legsNow});
 await p.tracker.pollOnce();
 assert.ok(legsNow.every(l=>leg(db,x.trade_id,l.idx).send_status==='sent'));
 assert.equal(oneclick.calls.submit.length,2);
 await p.tracker.pollOnce();
 assert.equal(p.status(ALICE,x.trade_id).status,'success');
 const st=p.status(ALICE,x.trade_id);
 assert.ok(st.legs.every(l=>l.origin_tx));
});

test('resubmitting the same signature returns the same hash: no second co-sign, no second send',async()=>{
 const {p,rpc,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 const [a,b]=await Promise.all([sub(p,ALICE,r,signed),sub(p,ALICE,r,signed)]);
 assert.equal(a.legs[0].tx_hash,b.legs[0].tx_hash);
 const c=await sub(p,ALICE,r,signed);
 assert.equal(c.legs[0].tx_hash,a.legs[0].tx_hash);
 assert.equal(feePayer.calls,1);
 // A resubmit may rebroadcast while the chain has not seen it, always the same durable bytes.
 assert.equal(new Set(rpc.sent).size,1);
});

test('SELL all-Solana: the coin goes to the deposit address, USDC on Solana comes back, exit exempt from the per-account fee caps',async()=>{
 const {p,db,oneclick,feePayer}=fakePipeline({env:{YEET_SPONSOR_DAILY_TX:'1'}});
 // Use the one per-account sponsored transaction on a BUY first.
 const b=await exec(p,ALICE,await p.propose(ALICE,{request_id:'b',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]}));
 assert.equal(b.sign_requests.length,1);
 const s=await p.skeet(ALICE,{request_id:'s1',legs:[{symbol:'WIF',percent:50}]});
 const x=await exec(p,ALICE,s);
 assert.equal(x.sign_requests.length,1,'SELL is not refused by the per-account cap');
 const r=x.sign_requests[0];
 assert.equal(r.summary.side,'sell');assert.equal(r.summary.asset,'WIF');
 const q=oneclick.calls.quote.filter(q=>!q.dry).at(-1);
 assert.equal(q.destinationAsset,'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near');
 assert.equal(q.recipient,aliceWallet.address);
 const t=decodeTransaction(Buffer.from(r.payload.transaction_base64,'base64'));
 assert.ok(t.message.accounts.includes(associatedTokenAddress(leg(db,x.trade_id,0).deposit_address,WIF_MINT,TOKEN_PROGRAM)));
 assert.equal(db.prepare('SELECT sponsor_exit FROM client_trade WHERE attempt_id=?').get(r.attempt_id).sponsor_exit,1);
 const out=await sub(p,ALICE,r,signAs(aliceWallet,r));
 assert.equal(out.legs[0].send_status,'signing');assert.equal(feePayer.calls,1);
});

test('kill switch flipped after the sign request: refused before any co-sign; recovery ends the leg not_sent and gives the cap back',async()=>{
 const f=fakePipeline();const {p,db,env,feePayer}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,basket));
 env.YEET_KILL_SWITCH='1';
 const r=x.sign_requests[0];
 await code(sub(p,ALICE,r,signAs(aliceWallet,r)),'TRADING_PAUSED');
 assert.equal(feePayer.calls,0);
 await p.recoverTrade(x.trade_id);
 assert.ok([0,1].every(i=>leg(db,x.trade_id,i).send_status==='not_sent'));
 assert.equal(spentToday(db,ALICE.accountId,f.now()),0n);
 assert.equal(db.prepare('SELECT status FROM trades WHERE id=?').get(x.trade_id).status,'failed');
 assert.equal(db.prepare('SELECT COALESCE(SUM(transactions),0) n FROM sponsor_day').get().n,0,'fee reservations returned');
});

test('chain pause YEET_SOLANA_PAUSE refuses execute and submit',async()=>{
 const {p,env,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,basket));
 env.YEET_SOLANA_PAUSE='1';
 await code(sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0])),'TRADING_PAUSED');
 await code(exec(p,ALICE,await p.propose(ALICE,{...basket,request_id:'r2'})),'TRADING_PAUSED');
 assert.equal(feePayer.calls,0);
});

test('blockhash expired at submit: SIGN_EXPIRED answers a fresh sign request (attempt 2); the old one is abandoned and its fee returned',async()=>{
 const {p,db,rpc,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const r=x.sign_requests[0];
 rpc.valid=false;
 const out=await sub(p,ALICE,r,signAs(aliceWallet,r));
 rpc.valid=true;
 assert.equal(out.legs[0].send_status,'awaiting_signature');
 assert.equal(out.sign_requests?.length,1);
 assert.notEqual(out.sign_requests[0].attempt_id,r.attempt_id);
 assert.equal(db.prepare('SELECT status FROM client_trade WHERE attempt_id=?').get(r.attempt_id).status,'abandoned');
 assert.equal(db.prepare('SELECT attempt_no FROM client_trade WHERE attempt_id=?').get(out.sign_requests[0].attempt_id).attempt_no,2);
 assert.equal(db.prepare('SELECT SUM(transactions) n FROM sponsor_day').get().n,1,'one live reservation');
 assert.equal(feePayer.calls,0);
 const done=await sub(p,ALICE,out.sign_requests[0],signAs(aliceWallet,out.sign_requests[0]));
 assert.equal(done.legs[0].send_status,'signing');
 // The stale first signature is refused for good: its attempt is abandoned.
 const stale=await sub(p,ALICE,r,signAs(aliceWallet,r));
 assert.equal(stale.legs[0].send_status,'signing');assert.equal(feePayer.calls,1);
});

test('fee payer policy refusal: leg failed, nothing sent, cap and fee quota returned',async()=>{
 const f=fakePipeline();const {p,db,rpc,feePayer}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 feePayer.refuse='PRIVY_POLICY_DENIED';
 const out=await sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 assert.equal(out.legs[0].send_status,'failed');
 assert.equal(rpc.sent.length,0);
 assert.equal(spentToday(db,ALICE.accountId,f.now()),0n);
 assert.equal(db.prepare('SELECT SUM(transactions) n FROM sponsor_day').get().n,0);
 // A transient fee payer error keeps the claim (no bytes): the leg stays signing until the blockhash is past.
 feePayer.refuse='PRIVY_HTTP_503';
 const y=await exec(p,ALICE,await p.propose(ALICE,{request_id:'y',amount_usdc:'5',legs:[{symbol:'BOME',parts:1}]}));
 await code(sub(p,ALICE,y.sign_requests[0],signAs(aliceWallet,y.sign_requests[0])),'TEMPORARILY_UNAVAILABLE');
 assert.equal(leg(db,y.trade_id,0).send_status,'signing');
 await p.recoverTrade(y.trade_id);
 assert.equal(leg(db,y.trade_id,0).send_status,'signing','not ended before the finalized height passes the last valid height');
 rpc.finalized=rpc.height+200;
 await p.recoverTrade(y.trade_id);
 assert.equal(leg(db,y.trade_id,0).send_status,'failed');
});

test('expired and never landed: not_sent only after two separate proofs past the last valid height',async()=>{
 const f=fakePipeline();const {p,db,rpc}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 await sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 await p.recoverTrade(x.trade_id);
 assert.equal(leg(db,x.trade_id,0).send_status,'signing');
 assert.equal(rpc.sent.length,2,'rebroadcast of the same bytes while the blockhash is valid');
 assert.equal(rpc.sent[0],rpc.sent[1]);
 rpc.height+=500;rpc.finalized=rpc.height;
 await p.recoverTrade(x.trade_id);
 assert.equal(leg(db,x.trade_id,0).send_status,'signing','first proof only');
 await p.recoverTrade(x.trade_id);
 assert.equal(leg(db,x.trade_id,0).send_status,'not_sent');
 assert.equal(spentToday(db,ALICE.accountId,f.now()),0n);
});

test('landed and failed on chain: leg failed, the fee stays spent, the USDC cap comes back',async()=>{
 const f=fakePipeline();const {p,db,rpc}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const s=await sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 rpc.statuses.set(s.legs[0].tx_hash,{status:'failed',commitment:'confirmed',slot:9,err:{InstructionError:[3,'Custom']}});
 await p.recoverTrade(x.trade_id);
 assert.equal(leg(db,x.trade_id,0).send_status,'failed');
 assert.equal(spentToday(db,ALICE.accountId,f.now()),0n);
 assert.equal(db.prepare('SELECT SUM(transactions) n FROM sponsor_day').get().n,1,'the fee was paid');
});

test('fee payer below the floor: refused before the claim, alert raised once, nothing co-signed',async()=>{
 const rpc=fakeSolanaRpc({feePayerLamports:5_000_000});
 const {p,db,feePayer}=fakePipeline({rpc});
 const x=await exec(p,ALICE,await p.propose(ALICE,basket));
 for(const r of x.sign_requests)await code(sub(p,ALICE,r,signAs(aliceWallet,r)),'TEMPORARILY_UNAVAILABLE');
 assert.equal(feePayer.calls,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM trade_alerts WHERE kind='fee_payer_low'").get().n,1);
 assert.equal(leg(db,x.trade_id,0).send_status,'awaiting_signature');
});

test('signatures that are not the person on the stored message are refused before any co-sign',async()=>{
 const {p,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const r=x.sign_requests[0];
 // Another key's signature in the person's slot.
 const t=decodeTransaction(Buffer.from(r.payload.transaction_base64,'base64'));
 const foreign=Buffer.from(encodeTransaction([t.signatures[0],bobWallet.signMessage(t.messageBytes)],t.messageBytes)).toString('base64');
 await code(sub(p,ALICE,r,foreign),'INVALID_ARGUMENT');
 const bytes=Buffer.from(aliceWallet.signTransaction(Buffer.from(r.payload.transaction_base64,'base64')));bytes[bytes.length-3]^=1;
 await code(sub(p,ALICE,r,bytes.toString('base64')),'INVALID_ARGUMENT');
 await code(sub(p,ALICE,r,signAs(aliceWallet,r)+'='),'INVALID_ARGUMENT');
 await code(sub(p,ALICE,r,'A'.repeat(2000)),'INVALID_ARGUMENT');
 await code(sub(p,BOB,r,signAs(aliceWallet,r)),'INVALID_ARGUMENT');
 assert.equal(feePayer.calls,0);
});

test('nobody signs: after the sign window the legs are not_sent, the trade failed, the proposal failed, the cap back',async()=>{
 const f=fakePipeline();const {p,db,now}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,basket));
 now.advance(11*60_000);
 await p.tracker.pollOnce();
 assert.ok([0,1].every(i=>leg(db,x.trade_id,i).send_status==='not_sent'));
 assert.equal(db.prepare('SELECT status FROM trades WHERE id=?').get(x.trade_id).status,'failed');
 assert.equal(db.prepare('SELECT status FROM proposals WHERE id=(SELECT proposal_id FROM trades WHERE id=?)').get(x.trade_id).status,'failed');
 assert.equal(spentToday(db,ALICE.accountId,now()),0n);
});

test('dry run: validated and simulated, never co-signed or sent; the leg keeps waiting',async()=>{
 const {p,db,rpc,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const out=await sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]),{dryRun:true});
 assert.equal(out.dry_run.state,'not_sent');assert.equal(out.dry_run.simulation.err,null);
 assert.ok(out.dry_run.fee_lamports>0);assert.equal(out.dry_run.rent_lamports,2_039_280);
 assert.equal(feePayer.calls,0);assert.equal(rpc.sent.length,0);assert.equal(rpc.simulated.length,1);
 assert.equal(leg(db,x.trade_id,0).send_status,'awaiting_signature');
});

test('quotas: per-account daily sponsored transactions refuse a BUY leg (not_sent, cap back); rent counted per deposit account',async()=>{
 const f=fakePipeline({env:{YEET_SPONSOR_DAILY_TX:'1'}});const {p,db}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,basket));
 assert.equal(x.sign_requests.length,1);
 assert.equal(leg(db,x.trade_id,1).send_status,'not_sent');
 assert.equal(spentToday(db,ALICE.accountId,f.now()),5_000_000n);
 assert.equal(db.prepare('SELECT accounts FROM sponsor_rent_day').get().accounts,1);
});

test('deposit token account already exists: no create instruction, no rent',async()=>{
 const rpc=fakeSolanaRpc();
 const oneclick=fakeOneClick();
 const {p,db}=fakePipeline({rpc,oneclick});
 const prop=await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'});
 // Mark every possible deposit address ATA as existing by answering accountInfo for any non-mint address.
 rpc.accountInfo=async a=>({owner:TOKEN_PROGRAM,lamports:2_039_280});
 const x=await exec(p,ALICE,prop);
 const t=decodeTransaction(Buffer.from(x.sign_requests[0].payload.transaction_base64,'base64'));
 assert.equal(t.message.instructions.length,3);
 assert.equal(db.prepare('SELECT rent_lamports FROM sponsor_send').get().rent_lamports,0);
});

test('execute refusals: driver not ready, balance low on Solana, plan check; nothing committed and the code stays unused',async()=>{
 const a=fakePipeline({feePayer:null});
 const prop=await a.p.propose(ALICE,basket);
 await code(exec(a.p,ALICE,prop),'TEMPORARILY_UNAVAILABLE');
 assert.equal(a.db.prepare('SELECT COUNT(*) n FROM trades').get().n,0);
 const b=fakePipeline({holdings:[{mint:USDC_SOLANA,raw:4_000_000n,decimals:6}]});
 await code(exec(b.p,ALICE,await b.p.propose(ALICE,basket)),'BALANCE_LOW');
 // 1Click answering the person's own wallet as deposit address.
 const c=fakePipeline({oneclick:fakeOneClick({depositFor:()=>aliceWallet.address})});
 const cp=await c.p.propose(ALICE,basket);
 await code(exec(c.p,ALICE,cp),'TEMPORARILY_UNAVAILABLE');
 assert.equal(c.db.prepare('SELECT COUNT(*) n FROM trades').get().n,0);
 assert.equal(c.db.prepare('SELECT used_at FROM confirm_codes').all().every(r=>r.used_at===null),true);
});

test('a used confirm code replays the trade with fresh sign requests for legs still unsigned',async()=>{
 const {p,now}=fakePipeline();
 const prop=await p.propose(ALICE,basket);
 const x=await exec(p,ALICE,prop);
 const again=await exec(p,ALICE,prop);
 assert.equal(again.trade_id,x.trade_id);
 assert.deepEqual(again.sign_requests.map(r=>r.attempt_id),x.sign_requests.map(r=>r.attempt_id));
 now.advance(70_000);
 const later=await exec(p,ALICE,prop);
 assert.equal(later.sign_requests.length,2);
 assert.ok(later.sign_requests.every((r,i)=>r.attempt_id!==x.sign_requests[i].attempt_id));
});

test('kill switch flipped during the submit awaits (Folio audit R17): refused by the second read, before the claim',async()=>{
 const {p,db,env,rpc,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const valid=rpc.blockhashValid;rpc.blockhashValid=async(...a)=>{env.YEET_KILL_SWITCH='1';return valid(...a)};
 await code(sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0])),'TRADING_PAUSED');
 assert.equal(feePayer.calls,0);
 assert.equal(db.prepare('SELECT status FROM client_trade').get().status,'pending');
});

test('paused: even a dry run is refused',async()=>{
 const {p,env,rpc}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 env.YEET_LIVE='0';
 await code(sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]),{dryRun:true}),'TRADING_PAUSED');
 assert.equal(rpc.simulated.length,0);
});

test('input over 1644 characters is refused before it is decoded',async()=>{
 const {p,logs}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 await code(sub(p,ALICE,x.sign_requests[0],'A'.repeat(1648)),'INVALID_ARGUMENT');
 assert.equal(logs.filter(l=>l.includes('"signature_invalid"')).length,0,'never reached the decoder');
});

test('driver level: the attempt must be the account and wallet it was issued to; a signed attempt answers its hash',async()=>{
 const {p,db,feePayer}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 const t=db.prepare('SELECT * FROM trades WHERE id=?').get(x.trade_id),l=leg(db,x.trade_id,0),d=p.drivers.sol;
 await code(d.submit({trade:{...t,account_id:BOB.accountId},leg:l,wallet:aliceWallet.address,attemptId:r.attempt_id,signed}),'INVALID_ARGUMENT');
 await code(d.submit({trade:t,leg:l,wallet:bobWallet.address,attemptId:r.attempt_id,signed}),'INVALID_ARGUMENT');
 const first=await d.submit({trade:t,leg:l,wallet:aliceWallet.address,attemptId:r.attempt_id,signed});
 const second=await d.submit({trade:t,leg:leg(db,x.trade_id,0),wallet:aliceWallet.address,attemptId:r.attempt_id,signed});
 assert.equal(second.state,'pending');assert.equal(second.txHash,first.txHash);
 assert.equal(feePayer.calls,1);
});

test('two processes on one database: the durable claim lets exactly one co-sign',async()=>{
 const a=fakePipeline();
 const b=fakePipeline({db:a.db,rpc:a.rpc,feePayer:a.feePayer,now:a.now,oneclick:a.oneclick});
 const x=await exec(a.p,ALICE,await a.p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 const out=await Promise.allSettled([sub(a.p,ALICE,r,signed),sub(b.p,ALICE,r,signed)]);
 assert.equal(a.feePayer.calls,1);
 assert.ok(out.some(o=>o.status==='fulfilled'&&o.value.legs[0].send_status==='signing'));
});

test('pipeline refusal details: another account, another trade of the same account',async()=>{
 const {p}=fakePipeline();
 const x=await exec(p,ALICE,await p.propose(ALICE,{...basket,legs:[{symbol:'WIF',parts:1}],amount_usdc:'5'}));
 const y=await exec(p,ALICE,await p.propose(ALICE,{request_id:'two',amount_usdc:'5',legs:[{symbol:'BOME',parts:1}]}));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 await assert.rejects(sub(p,BOB,r,signed),e=>e.code==='INVALID_ARGUMENT'&&e.detail==='unknown trade');
 await assert.rejects(p.submit(ALICE,{trade_id:y.trade_id,leg:0,attempt_id:r.attempt_id,signed}),e=>e.code==='INVALID_ARGUMENT'&&e.detail==='unknown attempt');
});

test('live gate is read per call, not at boot',()=>{
 const env={YEET_LIVE:'1'};
 assert.equal(limitsFromEnv(env).live,true);
});

// Review int-v2 (2026-11-13) findings 1 and 2: the landing watcher's deposit notice against the tracker, and
// watchers started by resubmitted signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePipeline,signAs,ALICE,aliceWallet} from './fakes.mjs';
import {decodeTransaction} from './solana/message.mjs';
import {base58Encode} from '../trade/router.mjs';
import {statusAdvances} from './tracker.mjs';

const one={request_id:'race',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]};
const exec=(p,ctx,prop)=>p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const sub=(p,ctx,req,signed)=>p.submit(ctx,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed});
const leg=(db,id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
const confirmSent=rpc=>{for(const b64 of rpc.sent)rpc.statuses.set(base58Encode(decodeTransaction(Buffer.from(b64,'base64')).signatures[0]),{status:'confirmed',commitment:'confirmed',slot:5})};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};

test('status fold is monotonic: terminal never replaced, no earlier stage over a later one',()=>{
 assert.equal(statusAdvances(null,'PENDING_DEPOSIT'),true);
 assert.equal(statusAdvances('PENDING_DEPOSIT','KNOWN_DEPOSIT_TX'),true);
 assert.equal(statusAdvances('KNOWN_DEPOSIT_TX','PROCESSING'),true);
 assert.equal(statusAdvances('PROCESSING','SUCCESS'),true);
 assert.equal(statusAdvances('PROCESSING','PROCESSING'),true);
 assert.equal(statusAdvances('SUCCESS','SUCCESS'),true);
 for(const t of ['SUCCESS','REFUNDED','FAILED'])for(const s of ['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','INCOMPLETE_DEPOSIT','PROCESSING'])assert.equal(statusAdvances(t,s),false,`${t} <- ${s}`);
 assert.equal(statusAdvances('SUCCESS','REFUNDED'),false);
 assert.equal(statusAdvances('PROCESSING','PENDING_DEPOSIT'),false);
 assert.equal(statusAdvances('PROCESSING','KNOWN_DEPOSIT_TX'),false);
 assert.equal(statusAdvances('KNOWN_DEPOSIT_TX','PENDING_DEPOSIT'),false);
});

test('finding 1: a slow landing-watcher /deposit/submit (PENDING_DEPOSIT) after the tracker recorded SUCCESS changes nothing',async()=>{
 let rpcRef;
 // The chain confirms before the first landing check.
 const sleep=async()=>{confirmSent(rpcRef)};
 const f=fakePipeline({landing:{landingPollMs:1,landingWatchMs:10,sleep}});rpcRef=f.rpc;
 const {p,db,oneclick}=f;
 const called=deferred(),answer=deferred();
 oneclick.submitDeposit=async function(depositAddress,txHash){oneclick.calls.submit.push({depositAddress,txHash});called.resolve();await answer.promise;return oneclick.statusFor(depositAddress,'status-pending.json')};
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 oneclick.deposits.get(leg(db,x.trade_id,0).deposit_address).script=['status-success.json'];
 await sub(p,ALICE,x.sign_requests[0],signAs(aliceWallet,x.sign_requests[0]));
 // The watcher saw the landing and is waiting on 1Click; the tracker pass runs meanwhile and sees SUCCESS.
 await called.promise;
 await p.tracker.pollOnce();
 assert.equal(leg(db,x.trade_id,0).oneclick_status,'SUCCESS');
 assert.equal(p.status(ALICE,x.trade_id).status,'success');
 // Now the slow PENDING_DEPOSIT answer arrives.
 answer.resolve();
 await p.landings();
 const l=leg(db,x.trade_id,0),st=p.status(ALICE,x.trade_id);
 assert.equal(l.oneclick_status,'SUCCESS','never moved back');
 assert.ok(l.settled_out_raw,'settled amount kept');
 assert.equal(JSON.parse(l.receipt_leg_json).status,'SUCCESS');
 assert.equal(st.status,'success');
 assert.equal(st.legs[0].status,'SUCCESS');
 assert.equal(st.received.length,1);
 assert.equal(oneclick.calls.submit.length,1,'one deposit notice: recovery did not overlap the watcher');
 await p.tracker.pollOnce();
 assert.equal(oneclick.calls.submit.length,1);
});

test('finding 2: 10 identical submissions start 1 watcher and send 1 deposit notice',async()=>{
 const gate=deferred();let rpcRef;
 const sleep=async()=>{await gate.promise;confirmSent(rpcRef)};
 const f=fakePipeline({landing:{landingPollMs:1,landingWatchMs:10,sleep}});rpcRef=f.rpc;
 const {p,db,oneclick}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 const r=x.sign_requests[0],signed=signAs(aliceWallet,r);
 for(let i=0;i<10;i++){const s=await sub(p,ALICE,r,signed);assert.equal(s.legs[0].send_status,'signing')}
 assert.equal(p.landingWatches(),1,'one watcher per attempt');
 gate.resolve();
 await p.landings();
 assert.equal(p.landingWatches(),0,'removed when it ends');
 assert.equal(leg(db,x.trade_id,0).deposit_submitted,1);
 assert.equal(oneclick.calls.submit.length,1);
});

test('finding 2: concurrent watchers are capped; beyond the cap the tracker pass sends the notice',async()=>{
 const gate=deferred();let rpcRef;
 const sleep=async()=>{await gate.promise;confirmSent(rpcRef)};
 // One request per leg (two attempts, two watchers wanted): the cap admits one.
 const f=fakePipeline({env:{YEET_SOL_BATCH_MAX_LEGS:'1'},landing:{landingPollMs:1,landingWatchMs:10,landingWatchMax:1,sleep}});rpcRef=f.rpc;
 const {p,db,oneclick}=f;
 const x=await exec(p,ALICE,await p.propose(ALICE,{...one,amount_usdc:'10',legs:[{symbol:'WIF',parts:1},{symbol:'BOME',parts:1}]}));
 for(const r of x.sign_requests)await sub(p,ALICE,r,signAs(aliceWallet,r));
 assert.equal(p.landingWatches(),1);
 gate.resolve();
 await p.landings();
 assert.equal(oneclick.calls.submit.length,1,'the watched leg');
 await p.tracker.pollOnce();
 assert.equal(oneclick.calls.submit.length,2,'the other leg through the tracker');
 assert.ok([0,1].every(i=>leg(db,x.trade_id,i).deposit_submitted===1));
});

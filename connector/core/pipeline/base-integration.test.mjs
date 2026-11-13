// Review finding 8: the Base driver wired into the pipeline through base/leg-driver.mjs, end to end on fakes. The leg
// is `sent` (and 1Click is told) only once the receipt carries the pinned Transfer log; a broadcast alone is `signing`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createPipeline} from './pipeline.mjs';
import {staticWalletDirectory} from './wallet-directory.mjs';
import {fakeOneClick,fakeBalances,fakeClock} from '../trade/fakes.mjs';
import {openTradeDb} from '../trade/db.mjs';
import {spentToday} from '../trade/limits.mjs';
import {fakeRpc,keyFile,mine} from './base/test-support.mjs';
import {txFromPayload} from './base/source-executor.mjs';
import {aliceWallet,ALICE} from './fakes.mjs';

const one={request_id:'b1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]};
const exec=(p,ctx,prop)=>p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const sub=(p,req,signed,opts)=>p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed},opts);
const legOf=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=0').get(id);

function basePipeline({env={}}={}){
 const db=openTradeDb(':memory:'),now=fakeClock(),user=privateKeyToAccount(generatePrivateKey()),wallet=user.address;
 const gas=keyFile(),rpc=fakeRpc(),oneclick=fakeOneClick(),logs=[];
 rpc.s.balance[gas.address]=2_000_000_000_000_000n;rpc.s.token[wallet.toLowerCase()]=20_000_000n;
 const fullEnv={YEET_LIVE:'1',YEET_KILL_SWITCH:'0',YEET_LIVE_ACCOUNTS:ALICE.accountId,YEET_BUY_CHAIN:'base',BASE_RPC_URL:'http://fake.invalid',
  YEET_BASE_GAS_WALLET:gas.address,YEET_BASE_GAS_WALLET_KEY_FILE:gas.file,...env};
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:wallet},solana:{address:aliceWallet.address}}});
 const balances=fakeBalances({usdc:20_000_000n,holdings:[]});
 const p=createPipeline({db,env:fullEnv,client:oneclick,directory,balances,now,trackerIntervalMs:0,log:l=>logs.push(l),driverOverrides:{baseRpc:rpc,feePayer:null}});
 const sign=req=>user.signTransaction(txFromPayload(req.payload));
 const tick=async id=>{now.advance(3_000);await p.recoverTrade(id)};
 return {p,db,now,rpc,oneclick,env:fullEnv,sign,tick,wallet,logs,user};
}

test('Base BUY: evm_tx sign request, dry run validates, live submit tops up, broadcast is signing, the Transfer receipt is sent',async()=>{
 const w=basePipeline(),{p,db,rpc,oneclick}=w;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 assert.equal(x.status,'awaiting_signature');
 const [r]=x.sign_requests;
 assert.equal(r.kind,'evm_tx');assert.equal(r.chain,'base');assert.equal(r.wallet,w.wallet);
 assert.equal(r.payload.chainId,8453);assert.equal(r.payload.to,'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
 assert.equal(r.summary.to,legOf(db,x.trade_id).deposit_address);
 const signed=await w.sign(r);
 const dry=await sub(p,r,signed,{dryRun:true});
 assert.equal(dry.dry_run.state,'not_sent');assert.equal(dry.dry_run.simulation.transfer_eth_call,'true');
 assert.ok(BigInt(dry.dry_run.simulation.topup.amount_wei)>0n);
 assert.equal(rpc.s.broadcasts.length,0);assert.equal(legOf(db,x.trade_id).send_status,'awaiting_signature');

 const live=await sub(p,r,signed);
 assert.equal(live.legs[0].send_status,'awaiting_gas');
 assert.equal(rpc.s.broadcasts.length,1,'the top-up only');
 await mine(rpc,rpc.s.broadcasts[0]);
 await w.tick(x.trade_id);
 assert.equal(rpc.s.broadcasts.at(-1),signed,'the stored user bytes');
 assert.equal(legOf(db,x.trade_id).send_status,'signing','broadcast is not landed');
 assert.equal(oneclick.calls.submit.length,0,'1Click is not told before the receipt');
 await mine(rpc,signed);
 await w.tick(x.trade_id);
 const l=legOf(db,x.trade_id);
 assert.equal(l.send_status,'sent');assert.equal(l.tx_hash,keccak256(signed));
 assert.equal(oneclick.calls.submit.length,1);
 // Resubmitting the same bytes returns the stored hash; nothing new is signed or sent.
 const n=rpc.s.broadcasts.length,again=await sub(p,r,signed);
 assert.equal(again.legs[0].tx_hash,keccak256(signed));assert.equal(rpc.s.broadcasts.length,n);
 assert.equal(spentToday(db,ALICE.accountId,w.now()),5_000_000n);
});

test('Base BUY: a reverted transfer ends the leg failed, 1Click is never told, the amount stays held until the deadline',async()=>{
 const w=basePipeline(),{p,db,rpc,oneclick}=w;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 const signed=await w.sign(x.sign_requests[0]);
 await sub(p,x.sign_requests[0],signed);
 await mine(rpc,rpc.s.broadcasts[0]);await w.tick(x.trade_id);
 await mine(rpc,signed,{success:false});await w.tick(x.trade_id);
 assert.equal(legOf(db,x.trade_id).send_status,'failed');
 assert.equal(oneclick.calls.submit.length,0);
 assert.equal(spentToday(db,ALICE.accountId,w.now()),5_000_000n);
 assert.equal(p.ledger.holds(x.trade_id)[0].state,'held');
});

test('Base BUY: the wallet pays the deposit address with its own twin; the leg is sent with the observed hash, spend kept',async()=>{
 const w=basePipeline(),{p,db,rpc,oneclick}=w;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 const r=x.sign_requests[0],signed=await w.sign(r);
 await sub(p,r,signed);
 await mine(rpc,rpc.s.broadcasts[0]);
 // A twin with a higher tip at the same nonce, broadcast by the wallet itself (review finding 1).
 const t=txFromPayload(r.payload);t.maxPriorityFeePerGas+=1n;
 const twin=await w.user.signTransaction(t),twinHash=await mine(rpc,twin);
 await w.tick(x.trade_id);
 const l=legOf(db,x.trade_id);
 assert.equal(l.send_status,'sent');assert.equal(l.tx_hash,twinHash);
 assert.equal(oneclick.calls.submit.length,1);
 assert.equal(spentToday(db,ALICE.accountId,w.now()),5_000_000n);
});

test('Base BUY: the kill switch refuses submit before any top-up; YEET_BASE_PAUSE refuses execute',async()=>{
 const w=basePipeline(),{p,rpc,env}=w;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 env.YEET_KILL_SWITCH='1';
 await assert.rejects(sub(p,x.sign_requests[0],await w.sign(x.sign_requests[0])),e=>e.code==='TRADING_PAUSED');
 assert.equal(rpc.s.broadcasts.length,0);
 env.YEET_KILL_SWITCH='0';env.YEET_BASE_PAUSE='1';
 await assert.rejects(exec(p,ALICE,await p.propose(ALICE,{...one,request_id:'b2'})),e=>e.code==='TRADING_PAUSED');
});

test('Base BUY: an unsigned attempt past its window is abandoned on both sides and its nonce is reused by the next request',async()=>{
 const w=basePipeline(),{p,db}=w;
 const x=await exec(p,ALICE,await p.propose(ALICE,one));
 const first=x.sign_requests[0];
 w.now.advance(11*60_000);
 await p.recoverTrade(x.trade_id);
 assert.equal(legOf(db,x.trade_id).send_status,'not_sent');
 const y=await exec(p,ALICE,await p.propose(ALICE,{...one,request_id:'b3'}));
 assert.equal(y.sign_requests[0].payload.nonce,first.payload.nonce);
 assert.equal(db.prepare('SELECT state FROM base_attempt WHERE id=?').get(first.attempt_id).state,'cancelled');
});

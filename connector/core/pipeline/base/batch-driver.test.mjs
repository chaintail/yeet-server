// The 7702 batch driver on the Calibur model of test-support.mjs (BASE-7702-PRODUCTION-PLAN.md 5.1). No network: the
// fake RPC runs authorizations, executor, deadline, nonce and signature checks the way Calibur v1.1.0 does (the same
// cases ran on Base mainnet in ops/base-7702-spike.mjs; batch-driver.network-test.mjs repeats them on mainnet behind a flag).
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTransaction,keccak256} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {batchWorld,basket,batchPrepared,signBatch,delegate,mine,caliburCall,asSignRequest,T0,ACCOUNT,world,preparedAndSigned,tradeLeg} from './test-support.mjs';
import {BatchFallback,gasCapFor,AUTO_LEGACY_FLAG,unsupportedFlag} from './batch-driver.mjs';
import {attemptIdFor} from './driver.mjs';
import {CALIBUR,CALIBUR_ERRORS,delegationCode,caliburSalt,batchNonce,tradeNonceKey,buildBatch,executeCalldata,wrapSignature,typedDataForSigning,decodeExecuteCalldata} from './calibur-7702.mjs';
import {loadGasWallet} from './gas-wallet.mjs';
import {MAX_TOPUPS_PER_ACCOUNT_DAY,TOPUP_GAS_DELEGATED,USDC_BASE} from './config.mjs';
import {checkBatch,privyRpcBodies,signedFromWallets,privyRpcBody} from '../wallet-request.mjs';
import {utcDay} from '../../trade/util.mjs';

const fb=reason=>e=>e instanceof BatchFallback&&e.reason===reason;
const code=c=>e=>e?.code===c;
const row=(w,id)=>w.batch.row(id);
const sent=w=>w.rpc.s.broadcasts.length;
const swap=(s,i,ch)=>s.slice(0,i)+(s[i]===ch?'0':ch)+s.slice(i+1);

test('2-leg first trade: one evm_7702 request with an authorization, 262-character signed, one type-4 transaction from the gas wallet, both Transfer logs confirm',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 assert.equal(p.req.kind,'evm_7702');assert.deepEqual(p.req.legs,[0,1]);
 assert.deepEqual(p.req.payload.authorization,{contract:CALIBUR,chain_id:8453,nonce:0});
 const td=p.req.payload.typed_data;
 assert.equal(td.primary_type,'SignedBatchedCall');assert.equal(td.domain.verifyingContract.toLowerCase(),w.wallet);
 assert.equal(td.domain.salt,caliburSalt(0n));assert.equal(td.message.executor.toLowerCase(),w.gas.address);
 assert.equal(td.message.nonce,String(batchNonce(tradeNonceKey(p.trade.id),0n)));
 assert.equal(td.message.batchedCall.calls.length,2);
 assert.equal(p.signed.length,262);
 const r=await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.equal(r.state,'sent');assert.equal(sent(w),1);
 const tx=parseTransaction(w.rpc.s.broadcasts[0]);
 assert.equal(tx.type,'eip7702');assert.equal(tx.to.toLowerCase(),w.wallet);assert.equal(tx.authorizationList.length,1);
 assert.ok(tx.gas<=gasCapFor(2));
 assert.equal(row(w,p.attemptId).state,'submitted');
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 await w.batch.recover({now:w.clock.t});
 const b=row(w,p.attemptId),ev=JSON.parse(b.evidence_json);
 assert.equal(b.state,'confirmed');assert.deepEqual(ev.legs_ok,[0,1]);assert.equal(ev.delegated,true);assert.equal(ev.seq_advanced,true);
 assert.equal(w.rpc.s.code[w.wallet],delegationCode(CALIBUR));
 assert.equal(w.rpc.s.token[w.wallet],10_000_000n);
});

test('a delegated wallet: no authorization, 132-character signed, type 2; the salt comes from eip712Domain()',async()=>{
 const w=batchWorld();delegate(w.rpc,w.wallet);w.rpc.s.saltPrefix={[w.wallet]:5n};
 const p=await batchPrepared(w);
 assert.equal(p.req.payload.authorization,null);assert.equal(p.signed.length,132);
 assert.equal(p.req.payload.typed_data.domain.salt,caliburSalt(5n));
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.equal(parseTransaction(w.rpc.s.broadcasts[0]).type,'eip1559');
 await mine(w.rpc,w.rpc.s.broadcasts[0]);await w.batch.recover({now:w.clock.t});
 assert.equal(row(w,p.attemptId).state,'confirmed');
});

test('one nonce across attempts of a trade: attempt 2 reuses the key and seq, so only one signed batch can ever run',async()=>{
 const w=batchWorld();delegate(w.rpc,w.wallet);
 const a=await batchPrepared(w,{attemptNo:1}),b=await batchPrepared(w,{attemptNo:2});
 assert.equal(a.req.payload.typed_data.message.nonce,b.req.payload.typed_data.message.nonce);
 assert.equal(row(w,a.attemptId).state,'cancelled','superseded');
 // Both signatures on chain (the model): the first runs, the second is InvalidNonce.
 const gas=w.gas.address,data=s=>executeCalldata(typedDataForSigning(JSON.parse(row(w,a.attemptId).typed_json).typed_data).message,wrapSignature('0x'+s.slice(2,132)));
 const st={token:{[w.wallet]:20_000_000n},code:{[w.wallet]:delegationCode(CALIBUR)},latest:{},seq:new Map(),saltPrefix:{},time:Math.floor(T0/1000)};
 assert.equal((await caliburCall(st,{from:gas,to:w.wallet,data:data(a.signed)})).ok,true);
 const second=await caliburCall(st,{from:gas,to:w.wallet,data:data(b.signed)});
 assert.equal(second.ok,false);assert.equal(CALIBUR_ERRORS[second.revertData],'InvalidNonce');
});

test('spike negatives on the model: wrong executor (Unauthorized), executor rewritten / recipient / amount altered (InvalidSignature), expired (SignatureExpired), replay (InvalidNonce)',async()=>{
 const w=batchWorld();delegate(w.rpc,w.wallet);
 const p=await batchPrepared(w);
 const batch=typedDataForSigning(p.req.payload.typed_data).message,sig='0x'+p.signed.slice(2,132),stranger='0x'+'99'.repeat(20);
 const st=()=>({token:{[w.wallet]:20_000_000n},code:{[w.wallet]:delegationCode(CALIBUR)},latest:{},seq:new Map(),saltPrefix:{},time:Math.floor(T0/1000)});
 const run=(s,from,b)=>caliburCall(s,{from,to:w.wallet,data:executeCalldata(b,wrapSignature(sig))});
 const why=r=>r.ok?'success':CALIBUR_ERRORS[r.revertData]??r.revertData;
 assert.equal(why(await run(st(),stranger,batch)),'Unauthorized');
 assert.equal(why(await run(st(),stranger,{...batch,executor:stranger})),'InvalidSignature');
 const calls=batch.batchedCall.calls;
 const altTo=buildBatch({legs:[{to:stranger,amountRaw:5_000_000n},{to:p.legs[1].deposit_address,amountRaw:5_000_000n}],nonce:batch.nonce,executor:batch.executor,deadline:batch.deadline});
 const altAmt=buildBatch({legs:[{to:p.legs[0].deposit_address,amountRaw:5_000_001n},{to:p.legs[1].deposit_address,amountRaw:5_000_000n}],nonce:batch.nonce,executor:batch.executor,deadline:batch.deadline});
 assert.equal(calls.length,2);
 assert.equal(why(await run(st(),w.gas.address,altTo)),'InvalidSignature');
 assert.equal(why(await run(st(),w.gas.address,altAmt)),'InvalidSignature');
 assert.equal(why(await run({...st(),time:Number(batch.deadline)+1},w.gas.address,batch)),'SignatureExpired');
 const s=st();assert.equal(why(await run(s,w.gas.address,batch)),'success');assert.equal(why(await run(s,w.gas.address,batch)),'InvalidNonce');
});

test('server refuses a batch signed with a wrong executor, an altered recipient or amount (signer recovery), before anything is stored',async()=>{
 for(const edit of [m=>({...m,executor:'0x'+'99'.repeat(20)}),
  m=>({...m,batchedCall:{...m.batchedCall,calls:m.batchedCall.calls.map((c,i)=>i?c:{...c,data:c.data.slice(0,-1)+'7'})}})]){
  const w=batchWorld();
  const p=await batchPrepared(w,{tamper:{typed:td=>({...td,message:edit(td.message)})}});
  await assert.rejects(w.batch.submit({...p.args,dryRun:false,now:w.clock.t}),code('SIGNED_SOURCE_MISMATCH'));
  assert.equal(row(w,p.attemptId).state,'prepared');assert.equal(sent(w),0);
 }
});

test('the card refuses a misstated batch (checkBatch): a non-USDC call, a changed amount, a wrong executor/verifyingContract, a non-Calibur authorization',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w),good=asSignRequest(p.req,p.legs);
 assert.equal(checkBatch(good),true);
 const td=good.payload.typed_data,clone=()=>JSON.parse(JSON.stringify(good));
 const bad=[
  r=>{r.payload.typed_data.message.batchedCall.calls[0].to='0x'+'12'.repeat(20)},
  r=>{r.leg_summaries[1].amount_raw='5000001'},
  r=>{r.payload.typed_data.message.executor='0x'+'00'.repeat(20)},
  r=>{r.payload.typed_data.domain.verifyingContract='0x'+'34'.repeat(20)},
  r=>{r.payload.authorization.contract='0x'+'56'.repeat(20)},
  r=>{r.payload.typed_data.message.batchedCall.revertOnFailure=false},
 ];
 for(const f of bad){const r=clone();f(r);assert.throws(()=>checkBatch(r),TypeError)}
 assert.equal(td.message.batchedCall.calls.length,2);
 assert.deepEqual(privyRpcBodies(good).map(b=>b.method),['eth_sign7702Authorization','eth_signTypedData_v4']);
 assert.throws(()=>privyRpcBody(good),/privyRpcBodies/);
 // A bad authorization echo from the wallet is refused.
 assert.throws(()=>signedFromWallets(good,[{data:{authorization:{contract:CALIBUR,chain_id:8453,nonce:7,r:'0x1',s:'0x2',y_parity:0}}},{data:{signature:'0x'+'ab'.repeat(65)}}]),/echo/);
 assert.throws(()=>signedFromWallets(good,[{data:{authorization:{contract:CALIBUR,chain_id:8453,nonce:0,r:'0x1',s:'0x2',y_parity:2}}},{data:{signature:'0x'+'ab'.repeat(65)}}]),/y_parity/);
});

test('authorization: signed for chain 0 or chain 1, for another contract, or by another key is refused; nothing sent',async()=>{
 const cases=[{authorization:{chain_id:0}},{authorization:{chain_id:1}},{authorization:{contract:'0x'+'77'.repeat(20)}}];
 for(const tamper of cases){
  const w=batchWorld();
  const p=await batchPrepared(w,{tamper});
  await assert.rejects(w.batch.submit({...p.args,dryRun:false,now:w.clock.t}),code('SIGNED_SOURCE_MISMATCH'));
  assert.equal(sent(w),0);
 }
 const w=batchWorld();
 const p=await batchPrepared(w),other=await signBatch(privateKeyToAccount(generatePrivateKey()),p.req,p.legs);
 const mixed=p.signed.slice(0,132)+other.slice(132);
 await assert.rejects(w.batch.submit({...p.args,signed:mixed,dryRun:false,now:w.clock.t}),code('SIGNED_SOURCE_MISMATCH'));
});

test('authorization: the wallet became Calibur meanwhile -> type 2 without it; foreign or non-designator code -> WALLET_HAS_CODE',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 delegate(w.rpc,w.wallet);
 const r=await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.equal(r.state,'sent');assert.equal(parseTransaction(w.rpc.s.broadcasts[0]).type,'eip1559');
 assert.equal(JSON.parse(row(w,p.attemptId).evidence_json).auth_dropped,true);
 for(const c of [delegationCode('0x'+'ab'.repeat(20)),'0x6080604052']){
  const v=batchWorld();v.rpc.s.code[v.wallet]=c;
  const {trade,legs}=basket();
  await assert.rejects(v.batch.prepare({trade,legs,wallet:v.wallet,attemptId:attemptIdFor(trade.id,0,1),attemptNo:1,now:v.clock.t}),code('WALLET_HAS_CODE'));
  const u=batchWorld(),q=await batchPrepared(u);u.rpc.s.code[u.wallet]=c;
  await assert.rejects(u.batch.submit({...q.args,dryRun:false,now:u.clock.t}),code('WALLET_HAS_CODE'));
 }
});

test('stale authorization nonce: refused before send (AUTH_NONCE_STALE, expired); a stale one that lands is a 0-log success -> NOTHING_MOVED',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 w.rpc.s.latest[w.wallet]=1;// the wallet sent its own transaction
 const r=await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.deepEqual(r,{state:'expired',code:'AUTH_NONCE_STALE'});
 assert.equal(row(w,p.attemptId).state,'cancelled');assert.equal(sent(w),0);
 const v=batchWorld(),q=await batchPrepared(v);
 await v.batch.submit({...q.args,dryRun:false,now:v.clock.t});
 v.rpc.s.latest[v.wallet]=1;// moved after our send, before inclusion
 await mine(v.rpc,v.rpc.s.broadcasts[0]);
 await v.batch.recover({now:v.clock.t});
 const b=row(v,q.attemptId);
 assert.equal(b.state,'failed');assert.equal(b.code,'NOTHING_MOVED');assert.equal(b.never_send,1);
 assert.equal(v.rpc.s.token[v.wallet],20_000_000n);
});

test('revoke, then execute: the batch lands with 0 logs -> NOTHING_MOVED, never judged by status alone',async()=>{
 const w=batchWorld();delegate(w.rpc,w.wallet);
 const p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 w.rpc.s.code[w.wallet]='0x';// revoked before inclusion
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 assert.equal(w.rpc.s.receipts.get(keccak256(w.rpc.s.broadcasts[0])).status,'success');
 await w.batch.recover({now:w.clock.t});
 assert.equal(row(w,p.attemptId).code,'NOTHING_MOVED');
});

test('expired deadline: submit after expires_at answers expired (SIGN_EXPIRED); a signed row past deadline-30 s is never broadcast',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 w.clock.t=p.req.expiresAt+1;
 assert.deepEqual(await w.batch.submit({...p.args,dryRun:false,now:w.clock.t}),{state:'expired',code:'SIGN_EXPIRED'});
 assert.equal(row(w,p.attemptId).state,'cancelled');
 const v=batchWorld(),q=await batchPrepared(v);
 v.env.YEET_KILL_SWITCH='1';
 await assert.rejects(v.batch.submit({...q.args,dryRun:false,now:v.clock.t}),code('TRADING_PAUSED'));
 v.env.YEET_KILL_SWITCH='0';
 // Signed, then the pause closes before the broadcast: the row stays signed; past deadline - 30 s it is cancelled, unsent.
 let env;
 const u=batchWorld({batchOpts:{loadWallet:c=>{const g=loadGasWallet(c);return {address:g.address,sign:async tx=>{const r=await g.sign(tx);env.YEET_BASE_PAUSE='1';return r}}}}});env=u.env;
 const r=await batchPrepared(u);
 assert.equal((await u.batch.submit({...r.args,dryRun:false,now:u.clock.t})).state,'pending');
 assert.equal(row(u,r.attemptId).state,'signed');assert.equal(sent(u),0);
 u.env.YEET_BASE_PAUSE='0';u.clock.t=row(u,r.attemptId).deadline*1000-29_000;
 await u.batch.recover({now:u.clock.t});
 assert.equal(row(u,r.attemptId).state,'cancelled');assert.equal(row(u,r.attemptId).code,'DEADLINE_PASSED_UNSENT');assert.equal(sent(u),0);
 assert.equal(u.batch.store.day(utcDay(T0),ACCOUNT).count,0,'the reservation went back');
 // Broadcast but never seen by the chain, past the on-chain deadline: cancelled (a late copy can only revert).
 const x=batchWorld(),y=await batchPrepared(x);
 x.rpc.s.broadcastError='connection reset';
 await x.batch.submit({...y.args,dryRun:false,now:x.clock.t});
 assert.equal(row(x,y.attemptId).state,'uncertain');
 x.clock.t=row(x,y.attemptId).deadline*1000+1;
 await x.batch.recover({now:x.clock.t});
 assert.equal(row(x,y.attemptId).code,'DEADLINE_PASSED_UNSENT');
});

test('signed: wrong length, `unsupported`, an exact replay (same result, nothing new), different bytes (SOURCE_ATTEMPT_BLOCKED)',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 for(const bad of [p.signed.slice(0,132),p.signed+'00','0x02'+p.signed.slice(4),p.signed.toUpperCase().replace('0X','0x').replace(/^0x/,'0y')])
  await assert.rejects(w.batch.submit({...p.args,signed:bad,dryRun:false,now:w.clock.t}),code('SIGNED_SOURCE_MISMATCH'));
 assert.deepEqual(await w.batch.submit({...p.args,signed:'unsupported',dryRun:false,now:w.clock.t}),{state:'unsupported'});
 const first=await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 const again=await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.equal(again.state,'sent');assert.equal(again.txHash,first.txHash);assert.equal(sent(w),1);
 const other=swap(p.signed,140,'f');
 await assert.rejects(w.batch.submit({...p.args,signed:other,dryRun:false,now:w.clock.t}),code('SOURCE_ATTEMPT_BLOCKED'));
});

test('caps: gas over 120000+45000N, gas price over the cap, cost over the cap, the floor (alert), the account count',async()=>{
 const tries=[
  [w=>{w.rpc.estimateGasAuth=async()=>200_000n},'INVALID_TRANSACTION_BUDGET'],
  [w=>{w.rpc.s.gasPrice=200_000_000n},'INVALID_TRANSACTION_BUDGET'],
  [w=>{w.env.YEET_BASE_BATCH_MAX_COST_WEI='1000'},'INVALID_TRANSACTION_BUDGET'],
  [w=>{w.rpc.s.balance[w.gas.address]=500_000_000_000_100n},'TOPUP_UNAVAILABLE'],
  [w=>{for(let i=0;i<MAX_TOPUPS_PER_ACCOUNT_DAY;i++)w.batch.store.bumpDay(utcDay(w.clock.t),ACCOUNT,1,0n)},'TOPUP_CAP_EXCEEDED'],
  [w=>{w.env.YEET_BASE_TOPUP_GLOBAL_DAILY_RAW='1000'},'TOPUP_CAP_EXCEEDED'],
 ];
 for(const [f,c] of tries){
  const w=batchWorld();
  const p=await batchPrepared(w);f(w);
  await assert.rejects(w.batch.submit({...p.args,dryRun:false,now:w.clock.t}),code(c),c);
  assert.equal(row(w,p.attemptId).state,'prepared');assert.equal(sent(w),0);
  if(c==='TOPUP_UNAVAILABLE')assert.ok(w.alerts.some(a=>a.kind==='gas_wallet_low'));
 }
 // At prepare the same quota (or cost) sends the basket to the per-leg path instead.
 const w=batchWorld();for(let i=0;i<MAX_TOPUPS_PER_ACCOUNT_DAY;i++)w.batch.store.bumpDay(utcDay(w.clock.t),ACCOUNT,1,0n);
 const {trade,legs}=basket();
 await assert.rejects(w.batch.prepare({trade,legs,wallet:w.wallet,attemptId:attemptIdFor(trade.id,0,1),attemptNo:1,now:w.clock.t}),fb('quota'));
 const v=batchWorld({env:{YEET_BASE_BATCH_MAX_COST_WEI:'1000'}});
 await assert.rejects(v.batch.prepare({trade,legs,wallet:v.wallet,attemptId:attemptIdFor(trade.id,0,1),attemptNo:1,now:v.clock.t}),fb('cost_cap'));
});

test('global wei: maxCost is reserved at sign (one count), then settled to the real cost at the receipt',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 const b=row(w,p.attemptId),day=utcDay(w.clock.t);
 assert.equal(w.batch.store.day(day,ACCOUNT).count,1);assert.equal(w.batch.store.dayTotal(day),BigInt(b.max_cost_raw));
 await mine(w.rpc,w.rpc.s.broadcasts[0],{price:4_000_000n,l1Fee:2_000_000_000n});
 await w.batch.recover({now:w.clock.t});
 const c=row(w,p.attemptId);
 assert.equal(w.batch.store.dayTotal(day),BigInt(c.gas_paid_raw));assert.ok(BigInt(c.gas_paid_raw)<BigInt(b.max_cost_raw));
 assert.equal(w.batch.store.day(day,ACCOUNT).count,1);
});

test('fallback reasons at prepare: legacy mode, auto-legacy, a flagged wallet, a memo, more than 5 legs, an RPC without eth_simulateV1, a failing preflight; USDC short is a refusal',async()=>{
 const prep=(w,o={})=>{const {trade,legs}=basket(o);return w.batch.prepare({trade,legs,wallet:w.wallet,attemptId:attemptIdFor(trade.id,0,1),attemptNo:1,now:w.clock.t})};
 await assert.rejects(prep(batchWorld({env:{YEET_BASE_MODE:'legacy'}})),fb('mode_legacy'));
 await assert.rejects(prep(batchWorld({env:{YEET_BASE_MODE:''}})),fb('mode_legacy'),'unset = legacy');
 let w=batchWorld();w.batch.store.setFlag(AUTO_LEGACY_FLAG,'1');await assert.rejects(prep(w),fb('auto_legacy'));
 w=batchWorld();w.batch.flagUnsupported(w.wallet);assert.equal(w.batch.store.flag(unsupportedFlag(w.wallet)),'1');await assert.rejects(prep(w),fb('wallet_unsupported'));
 await assert.rejects(prep(batchWorld(),{memo:'m-1'}),fb('deposit_memo'));
 await assert.rejects(prep(batchWorld(),{n:6}),fb('leg_count'));
 w=batchWorld({rpc:{simulateError:'the method eth_simulateV1 does not exist'}});await assert.rejects(prep(w),fb('simulate_unavailable'));
 w=batchWorld();w.rpc.simulateCalls=async({calls})=>calls.map(()=>({ok:false,gasUsed:1n,logs:[],revertData:'0x'}));await assert.rejects(prep(w),fb('preflight'));
 w=batchWorld();w.rpc.s.token[w.wallet]=9_000_000n;await assert.rejects(prep(w),code('PRINCIPAL_SHORT'));
});

test('dry run: steps 1-8 with the simulation, nothing signed by the gas wallet, nothing stored or sent',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 const d=await w.batch.submit({...p.args,dryRun:true,now:w.clock.t});
 assert.equal(d.state,'pending');assert.equal(d.dryRun,true);
 assert.equal(d.simulation.legs_transferred,2);assert.equal(d.simulation.type,4);assert.ok(BigInt(d.simulation.max_cost_wei)>0n);
 assert.ok(BigInt(d.simulation.gas_limit)<=gasCapFor(2));
 assert.equal(row(w,p.attemptId).state,'prepared');assert.equal(sent(w),0);
});

test('stuck outer transaction: replaced at the same nonce with fees +12.5%; the second hash is found and confirms',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 const first=parseTransaction(w.rpc.s.broadcasts[0]);
 w.clock.t+=31_000;
 await w.batch.recover({now:w.clock.t});
 assert.equal(sent(w),2);
 const second=parseTransaction(w.rpc.s.broadcasts[1]);
 assert.equal(second.nonce,first.nonce);assert.ok(second.maxFeePerGas>=first.maxFeePerGas*1125n/1000n);
 assert.equal(JSON.parse(row(w,p.attemptId).evidence_json).sends.length,2);
 await mine(w.rpc,w.rpc.s.broadcasts[1]);
 await w.batch.recover({now:w.clock.t});
 const b=row(w,p.attemptId);
 assert.equal(b.state,'confirmed');assert.equal(b.tx_hash,keccak256(w.rpc.s.broadcasts[1]));
});

test('reverted and partial-log receipts; a nonce taken by an unknown hash',async()=>{
 let w=batchWorld(),p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 await mine(w.rpc,w.rpc.s.broadcasts[0],{success:false});await w.batch.recover({now:w.clock.t});
 assert.equal(row(w,p.attemptId).code,'REVERTED');
 w=batchWorld();p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 const pad=a=>'0x'+a.slice(2).padStart(64,'0');
 await mine(w.rpc,w.rpc.s.broadcasts[0],{logs:[{address:USDC_BASE,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',pad(w.wallet),pad(p.legs[1].deposit_address)],data:'0x'+(5_000_000n).toString(16).padStart(64,'0')}]});
 await w.batch.recover({now:w.clock.t});
 const b=row(w,p.attemptId);
 assert.equal(b.state,'confirmed');assert.equal(b.code,'PARTIAL_LOGS');assert.deepEqual(JSON.parse(b.evidence_json).legs_ok,[1]);
 assert.ok(w.alerts.some(a=>a.kind==='base_batch_partial_logs'));
 w=batchWorld();p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 w.rpc.s.latest[w.gas.address]=5;
 await w.batch.recover({now:w.clock.t});
 assert.equal(row(w,p.attemptId).code,'NONCE_CONSUMED');assert.ok(w.alerts.some(a=>a.kind==='base_batch_nonce_consumed'));
});

test('legacy path: a Calibur-delegated wallet passes guard 5, and its top-up uses 40000 gas (pinned in assertTopupBytes)',async()=>{
 const w=world();delegate(w.rpc,w.wallet);
 const s=await preparedAndSigned(w);
 const r=await w.driver.submit({...s.args,dryRun:false,now:w.clock.t});
 assert.ok(r.topupTxHash,'a top-up was sent');
 const top=parseTransaction(w.rpc.s.broadcasts[0]);
 assert.equal(top.gas,TOPUP_GAS_DELEGATED);assert.equal(top.to.toLowerCase(),w.wallet);
 // A non-designator code is still refused.
 const v=world();v.rpc.s.code[v.wallet]='0x6080';
 const {trade,leg}=tradeLeg();
 await assert.rejects(v.driver.prepare({trade,leg,wallet:v.wallet,attemptId:attemptIdFor(trade.id,0,0),attemptNo:0,now:v.clock.t}),code('WALLET_HAS_CODE'));
});

test('legacy path waits while a batch of the gas wallet is in flight (guard 12 counts batches); a leg covered by a live batch gets no transfer',async()=>{
 const w=batchWorld();
 const p=await batchPrepared(w);
 await w.batch.submit({...p.args,dryRun:false,now:w.clock.t});
 assert.equal(w.batch.store.gasInFlight(),1);
 const leg=p.legs[0];
 await assert.rejects(w.driver.prepare({trade:p.trade,leg,wallet:w.wallet,attemptId:attemptIdFor(p.trade.id,0,2),attemptNo:2,now:w.clock.t}),code('SOURCE_ATTEMPT_BLOCKED'));
 assert.equal(decodeExecuteCalldata(parseTransaction(w.rpc.s.broadcasts[0]).data).batch.batchedCall.calls.length,2);
});

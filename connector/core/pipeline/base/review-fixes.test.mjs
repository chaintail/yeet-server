// One test per confirmed review finding on the Base driver (gas-workflow/review-security.md findings 1, 3, 4, 5, 7).
// Each fails on the unfixed driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {world,preparedAndSigned,mine,T0,DEPOSIT} from './test-support.mjs';
import {txFromPayload} from './source-executor.mjs';

const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code} (${e.message})`);return true};
const row=(w,id)=>w.db.prepare('SELECT * FROM base_attempt WHERE id=?').get(id);
const topups=w=>w.db.prepare("SELECT * FROM base_attempt WHERE kind='gas_topup' ORDER BY rowid").all();
const SECRET='https://base.example/v2/SECRETKEY123';

test('F1: a fee-bumped twin sent by the wallet itself confirms the attempt with the observed hash; it is not cancelled', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);// our top-up lands
 const twin=await w.userAccount.signTransaction({...txFromPayload(f.req.payload),maxPriorityFeePerGas:BigInt(f.req.payload.maxPriorityFeePerGas)+1n});
 const twinHash=await mine(w.rpc,twin);// the wallet pays the deposit address with its own bytes
 const out=await w.driver.recover({now:T0+5_000});
 const a=row(w,f.attemptId);
 assert.equal(a.state,'confirmed');assert.equal(a.code,'OBSERVED_TRANSFER');assert.equal(a.tx_hash,twinHash);
 assert.deepEqual(out.map(x=>[x.state,x.txHash]),[['confirmed',twinHash]]);
 assert.ok(w.alerts.some(x=>x.kind==='base_transfer_outside_bytes'));
});

test('F1: when the Transfer search cannot run, the attempt is neither cancelled nor confirmed', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 const twin=await w.userAccount.signTransaction({...txFromPayload(f.req.payload),maxPriorityFeePerGas:BigInt(f.req.payload.maxPriorityFeePerGas)+1n});
 await mine(w.rpc,twin);
 w.rpc.s.logsError='rate limited';
 await w.driver.recover({now:T0+5_000});
 assert.equal(row(w,f.attemptId).state,'awaiting_gas');
});

test('F7: the nonce spent on a non-YEET transaction after our top-up cancels NONCE_CHANGED and blocks further top-ups', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 const other=await w.userAccount.signTransaction({type:'eip1559',chainId:8453,to:'0x2222222222222222222222222222222222222222',value:0n,data:'0x',
  nonce:f.req.payload.nonce,gas:21000n,maxFeePerGas:100_000_000n,maxPriorityFeePerGas:1_000_000n});
 await mine(w.rpc,other);
 await w.driver.recover({now:T0+5_000});
 const a=row(w,f.attemptId);assert.equal(a.state,'cancelled');assert.equal(a.code,'NONCE_CHANGED');
 assert.ok(w.alerts.some(x=>x.kind==='base_topup_misused'));
 w.rpc.s.balance[w.wallet]=0n;
 const g=await preparedAndSigned(w,{tradeId:'t_bbbbbbbbbbbbbbbbbbbb'});
 await assert.rejects(w.driver.submit({...g.args,dryRun:false}),code('TOPUP_CAP_EXCEEDED'));
 assert.equal(topups(w).length,1);
});

test('F3: a broadcast transfer unknown to the chain past its deadline is cancelled and its nonce is reused', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 await w.driver.recover({now:T0+5_000});// broadcasts the user bytes
 assert.equal(row(w,f.attemptId).state,'submitted');
 w.clock.t=T0+29*60_000;
 await w.driver.recover({now:w.clock.t});
 const a=row(w,f.attemptId);assert.equal(a.state,'cancelled');assert.equal(a.code,'DEADLINE_PASSED_UNSENT');
 const g=await preparedAndSigned(w,{tradeId:'t_cccccccccccccccccccc',deadline:w.clock.t+30*60_000});
 assert.equal(g.req.payload.nonce,f.req.payload.nonce);
});

test('F3: a transfer still pending in the mempool past its deadline alerts once and blocks new prepares for the wallet', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 await w.driver.recover({now:T0+5_000});
 const h=keccak256(f.signed);
 w.rpc.s.txs.set(h,{from:w.wallet,to:'x',value:0n,input:'0x',nonce:f.req.payload.nonce,blockNumber:null});
 w.clock.t=T0+29*60_000;
 await w.driver.recover({now:w.clock.t});await w.driver.recover({now:w.clock.t+1000});
 assert.equal(row(w,f.attemptId).state,'submitted');
 assert.equal(w.alerts.filter(x=>x.kind==='base_transfer_stuck').length,1);
 await assert.rejects(preparedAndSigned(w,{tradeId:'t_dddddddddddddddddddd',deadline:w.clock.t+30*60_000}),code('SOURCE_ATTEMPT_BLOCKED'));
});

test('F4: a top-up stuck at the regular fee cap is replaced under the replacement ceiling and alerts after 3 replacements', async()=>{
 const w=world({rpc:{gasPrice:60_000_000n}}),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 for(const s of [31,62,93,124])await w.driver.recover({now:T0+s*1000});
 const rows=topups(w);
 assert.ok(rows.length>=4,`replacements signed: ${rows.length-1}`);
 assert.ok(rows.every(r=>r.nonce===rows[0].nonce));
 assert.equal(w.alerts.filter(x=>x.kind==='gas_topup_stuck').length,1);
});

test('F5: an RPC URL inside an error reaches neither the refusal detail nor any log line', async()=>{
 const w=world();
 w.rpc.estimateGas=async()=>{throw Object.assign(Error(`HTTP request failed. URL: ${SECRET} Request body: {}`),{shortMessage:undefined})};
 let err;try{await preparedAndSigned(w)}catch(e){err=e}
 assert.equal(err?.code,'SIMULATION_FAILED');
 assert.ok(!JSON.stringify({m:err.message,d:err.detail}).includes('SECRETKEY'));
 const v=world({rpc:{broadcastError:`HTTP request failed. URL: ${SECRET}`}}),g=await preparedAndSigned(v);
 await v.driver.submit({...g.args,dryRun:false});
 assert.ok(v.logs.some(l=>l.stage==='uncertain'));
 assert.ok(!JSON.stringify(v.logs).includes('SECRETKEY'));
 assert.equal(DEPOSIT.length,42);
});

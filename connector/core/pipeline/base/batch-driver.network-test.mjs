// Network checks of the 7702 batch path against Base mainnet (BASE-7702-PRODUCTION-PLAN.md 5.1), behind a flag so the
// default suite (npm test) stays offline; this file is not in its glob. Throwaway keys, state overrides, no funds, no
// broadcast.
//   YEET_BASE_NET_TESTS=1 [BASE_RPC_URL=...] node --test core/pipeline/base/batch-driver.network-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {dryRunBasket} from './basket-dry-run.mjs';
import {CALIBUR,delegationCode} from './calibur-7702.mjs';
import {TOPUP_GAS,TOPUP_GAS_DELEGATED} from './config.mjs';
import {gasCapFor} from './batch-driver.mjs';

const NET=process.env.YEET_BASE_NET_TESTS==='1';
const url=String(process.env.BASE_RPC_URL??'').trim()||'https://mainnet.base.org';
const opts={skip:NET?false:'set YEET_BASE_NET_TESTS=1 (Base mainnet RPC)',timeout:180_000};
// The public endpoint rate-limits (HTTP 429): a short pause between the checks.
if(NET)test.beforeEach(()=>new Promise(r=>setTimeout(r,5_000)));
const rpc=async(method,params)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw Error(j.error.message);return j.result};

for(const [n,delegated] of [[1,false],[2,false],[5,false],[2,true],[5,true]])
 test(`mainnet dry run: ${n}-leg basket${delegated?' (delegated, type 2)':' (first trade, type 4)'} transfers every leg in eth_simulateV1, gas under the cap`,opts,async()=>{
  const out=await dryRunBasket({url,legs:n,delegated});
  assert.equal(out.state,'pending');assert.equal(out.request.kind,'evm_7702');
  assert.equal(out.request.authorization===null,delegated);assert.equal(out.request.signed_chars,delegated?132:262);
  assert.equal(out.simulation.type,delegated?2:4);assert.equal(out.simulation.legs_transferred,n);
  assert.ok(out.simulation.legs.every(l=>l.ok));
  assert.ok(BigInt(out.simulation.gas_limit)<=gasCapFor(n));
 });

test('mainnet spike negatives (ops/base-7702-spike.mjs plan): wrong executor, rewritten executor, replay, altered recipient/amount, expired, stale authorization, revoke',opts,()=>{
 const script=fileURLToPath(new URL('../../../../ops/base-7702-spike.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[script,'--legs','2','--rpc',url],{encoding:'utf8',timeout:170_000,env:{PATH:process.env.PATH}});
 const out=JSON.parse(r.stdout);
 assert.equal(out.pass,true,JSON.stringify(Object.fromEntries(Object.entries(out.cases??{}).map(([k,v])=>[k,v.pass]))));
 for(const k of ['wrong_executor','executor_rewritten_by_stranger','replay_same_nonce','altered_recipient','altered_amount','expired_deadline','stale_authorization_nonce','revoke_then_execute'])assert.equal(out.cases[k].pass,true,k);
});

test('a top-up to a Calibur-delegated wallet needs more than 21000 gas and fits in 40000 (eth_estimateGas, code override)',opts,async()=>{
 const from=privateKeyToAccount(generatePrivateKey()).address,to=privateKeyToAccount(generatePrivateKey()).address;
 const q=v=>'0x'+BigInt(v).toString(16);
 const est=BigInt(await rpc('eth_estimateGas',[{from,to,value:q(10n**13n)},'latest',{[from]:{balance:q(10n**18n)},[to]:{code:delegationCode(CALIBUR)}}]));
 assert.ok(est>TOPUP_GAS,`estimate ${est}`);assert.ok(est<=TOPUP_GAS_DELEGATED,`estimate ${est}`);
 const plain=BigInt(await rpc('eth_estimateGas',[{from,to,value:q(10n**13n)},'latest',{[from]:{balance:q(10n**18n)}}]));
 assert.equal(plain,TOPUP_GAS);
});

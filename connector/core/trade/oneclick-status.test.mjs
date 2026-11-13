// 1Click status answers with null for not-yet-known fields (first-trade review 2026-11-13: core refused the live
// PENDING_DEPOSIT answer because swapDetails.amountIn was null). Every status of the OpenAPI enum, through the real
// router OneClickClient with core's statusTolerantFetch, then folded by the router's applyStatus. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OneClickClient,applyStatus,ReceiptLegSchema,STATUSES} from './router.mjs';
import {normalizeStatusBody,statusTolerantFetch,ONECLICK_STATUSES} from './oneclick-status.mjs';
import {receiptLeg} from './tracker.mjs';

const FIX=JSON.parse(readFileSync(new URL('./fixtures/oneclick-status-nulls.json',import.meta.url),'utf8'));
const serve=body=>async()=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
const client=(body,tolerant=true)=>new OneClickClient({jwt:undefined,retryDelayMs:0,fetch:tolerant?statusTolerantFetch(serve(body)):serve(body)});
const DEPOSIT='0x1111111111111111111111111111111111111111';
const leg=()=>receiptLeg({index:0,symbol:'WIF',depositAddress:DEPOSIT,amountIn:'5000000',amountOut:'31461517',minAmountOut:'31146901',correlationId:'c',signature:'s'});

test('fixtures cover every 1Click status, the same seven the router knows',()=>{
 assert.deepEqual(Object.keys(FIX).filter(k=>!k.startsWith('_')).sort(),[...ONECLICK_STATUSES].sort());
 assert.deepEqual([...STATUSES].sort(),[...ONECLICK_STATUSES].sort());
});

test('control: the vendored parser alone refuses the live PENDING_DEPOSIT answer (amountIn null)',async()=>{
 await assert.rejects(client(FIX.PENDING_DEPOSIT,false).status(DEPOSIT),e=>/amountIn/.test(e.message)&&e.kind==='invalid-response');
});

for(const status of ONECLICK_STATUSES){
 test(`${status} with null not-yet-known fields parses and folds into a valid receipt leg`,async()=>{
  const res=await client(FIX[status]).status(DEPOSIT);
  assert.equal(res.status,status);
  for(const [k,v] of Object.entries(res.swapDetails??{}))assert.notEqual(v,null,`${k} is never null after normalising`);
  const folded=applyStatus(leg(),res,'2026-11-13T09:00:00.000Z');
  ReceiptLegSchema.parse(folded);
  assert.equal(folded.status,status);
  if(status==='SUCCESS')assert.equal(folded.settled.amountOut,'31461517');
  else assert.equal(folded.settled.amountOut,undefined,'an unknown amount stays unknown, never "null"');
 });
}

test('deposit/submit answers are normalised too; other paths and non-2xx answers pass through untouched',async()=>{
 const res=await client(FIX.PENDING_DEPOSIT).submitDeposit(DEPOSIT,'0x'+'2'.repeat(64));
 assert.equal(res.status,'PENDING_DEPOSIT');
 const raw={a:null};
 const f=statusTolerantFetch(async()=>new Response(JSON.stringify(raw),{status:200}));
 assert.deepEqual(await (await f('https://1click.chaindefuser.com/v0/tokens')).json(),raw);
 const e=statusTolerantFetch(async()=>new Response(JSON.stringify({message:'Deposit address not found'}),{status:404}));
 assert.equal((await e('https://1click.chaindefuser.com/v0/status?depositAddress=x')).status,404);
});

test('normalising stays strict on what matters: status, correlationId, updatedAt, and non-null wrong types',async()=>{
 assert.deepEqual(normalizeStatusBody({status:'PENDING_DEPOSIT',swapDetails:{intentHashes:null,amountIn:null,originChainTxHashes:[{hash:'0x1',explorerUrl:null}]}}),
  {status:'PENDING_DEPOSIT',swapDetails:{intentHashes:[],originChainTxHashes:[{hash:'0x1'}]}});
 await assert.rejects(client({...FIX.PENDING_DEPOSIT,status:'WAITING'}).status(DEPOSIT),e=>e.kind==='invalid-response');
 await assert.rejects(client({...FIX.PENDING_DEPOSIT,correlationId:null}).status(DEPOSIT),e=>e.kind==='invalid-response');
 await assert.rejects(client({...FIX.PENDING_DEPOSIT,updatedAt:null}).status(DEPOSIT),e=>e.kind==='invalid-response');
 await assert.rejects(client({...FIX.PENDING_DEPOSIT,swapDetails:{...FIX.PENDING_DEPOSIT.swapDetails,amountIn:5}}).status(DEPOSIT),e=>e.kind==='invalid-response');
 await assert.rejects(client({...FIX.PROCESSING,swapDetails:{...FIX.PROCESSING.swapDetails,originChainTxHashes:[{hash:null}]}}).status(DEPOSIT),e=>e.kind==='invalid-response','a tx entry without a hash');
});

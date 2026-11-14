// Live finding 2026-11-13: the spike's 1Click /status polls answered with null for swapDetails fields not known yet
// (refundReason, amountInUsd, amountOut*, depositedAmount*, slippage), the router refused the body on every poll, and
// the step waited its whole timeout. The spike now builds its OneClickClient with statusTolerantFetch, and when a poll
// still cannot be read the funding step falls back to the on-chain balance. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OneClickClient,base58Encode} from '../trade/router.mjs';
import {statusTolerantFetch} from '../pipeline/oneclick-status.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {TOKEN_PROGRAM,USDC_SOLANA} from '../pipeline/solana/message.mjs';
import {fundVia1Click} from './funding.mjs';

const USDC='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
const BLOCKHASH=base58Encode(Uint8Array.from({length:32},(_,i)=>i+3));
const DEPOSIT=localSigner(Uint8Array.from({length:32},(_,i)=>90+i)).address;
const wallet=localSigner(Uint8Array.from({length:32},(_,i)=>i+1));
const NULLS={amountIn:null,amountInFormatted:null,amountInUsd:null,amountOut:null,amountOutFormatted:null,amountOutUsd:null,depositedAmount:null,depositedAmountFormatted:null,depositedAmountUsd:null,slippage:null,refundReason:null,
 intentHashes:[],nearTxHashes:[],originChainTxHashes:[],destinationChainTxHashes:[]};
const body=(status,details={})=>({correlationId:'c1',status,updatedAt:'2026-11-13T17:00:00.000Z',swapDetails:{...NULLS,...details}});
const VARIANTS=[body('PENDING_DEPOSIT'),body('PROCESSING',{amountIn:'2000000',amountInFormatted:'2'}),body('SUCCESS',{amountIn:'2000000',amountOut:'1999000',amountOutFormatted:'1.999'})];
const sequence=bodies=>{let i=0;return async url=>{
 if(new URL(String(url)).pathname.endsWith('/status'))return new Response(JSON.stringify(bodies[Math.min(i++,bodies.length-1)]),{status:200,headers:{'content-type':'application/json'}});
 return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
}};
const spikeClient=fetch=>new OneClickClient({jwt:undefined,retryDelayMs:0,fetch:statusTolerantFetch(fetch)});
const rawClient=fetch=>new OneClickClient({jwt:undefined,retryDelayMs:0,fetch});

function harness(client,{watch,state={}}={}){
 const lines=[],sent=[];let t=Date.parse('2026-11-13T17:00:00Z');
 const rpc={accountInfo:async a=>a===USDC_SOLANA?{owner:TOKEN_PROGRAM,lamports:1}:null,tokenBalance:async()=>10_000_000n,latestBlockhash:async()=>({blockhash:BLOCKHASH,lastValidBlockHeight:'100'}),
  blockhashValid:async()=>true,balance:async()=>10_000_000,broadcast:async b=>{sent.push(b);return 'sig'}};
 const wrapped={quote:async req=>({correlationId:'c1',quote:{depositAddress:DEPOSIT,amountIn:req.amount,amountOut:'1999000',minAmountOut:'1990000',deadline:req.deadline}}),
  submitDeposit:async()=>({}),status:a=>client.status(a)};
 const run=()=>fundVia1Click({label:'deposit_user',state,save:()=>{},client:wrapped,rpc,signatureStatus:async()=>({status:'confirmed'}),wallet,
  request:{destinationAsset:USDC,amount:2_000_000n,recipient:'a'.repeat(64),recipientType:'INTENTS'},emit:l=>lines.push(l),now:()=>t+=1000,sleep:async()=>{t+=3000},waitMs:600_000,watch});
 return {lines,run,state};
}

test('spike client: PENDING_DEPOSIT, PROCESSING and SUCCESS answers full of nulls (refundReason: null) parse and the leg ends SUCCESS from the status',async()=>{
 const h=harness(spikeClient(sequence(VARIANTS)));
 const r=await h.run();
 assert.equal(r.status,'SUCCESS');
 assert.equal(r.status_source,undefined,'read from 1Click, not from the balance');
 assert.ok(!h.lines.some(l=>l.stage==='status_unavailable'),JSON.stringify(h.lines.filter(l=>l.stage==='status_unavailable')));
 assert.deepEqual(h.lines.filter(l=>l.stage==='oneclick_status').map(l=>l.status),['PENDING_DEPOSIT','PROCESSING','SUCCESS']);
});

test('control: without the tolerant fetch the same answers are refused on refundReason',async()=>{
 await assert.rejects(rawClient(sequence(VARIANTS)).status(DEPOSIT),/refundReason|invalid/i);
});

test('a status that cannot be read falls back to the balance: credited -> SUCCESS, status_source balance, timings set, no full wait',async()=>{
 let bal=5_000_000n,reads=0;
 const watch={read:async()=>{reads++;if(reads>=4)bal=7_000_000n;return bal}};
 const h=harness(rawClient(sequence(VARIANTS)),{watch});
 const r=await h.run();
 assert.equal(r.status,'SUCCESS');assert.equal(r.status_source,'balance');
 assert.equal(r.balance_before,'5000000');
 assert.equal(r.amount_out,'2000000');
 assert.ok(r.at.oneclick_success&&r.at.transfer_sent);
 const secs=(Date.parse(r.at.oneclick_success)-Date.parse(r.at.transfer_sent))/1000;
 assert.ok(secs>0&&secs<60,`seconds from send to credited: ${secs}`);
 const un=h.lines.filter(l=>l.stage==='status_unavailable').length;
 assert.ok(un>=1&&un<=5,`${un} failed polls, not a 10 minute wait`);
 assert.deepEqual(h.lines.at(-1),{step:'deposit_user',stage:'oneclick_status',status:'SUCCESS',status_source:'balance',amount_out:'2000000',at:r.at.oneclick_success});
});

test('a status that cannot be read and no credit seen keeps waiting until waitMs, then reports still_pending',async()=>{
 const h=harness(rawClient(sequence(VARIANTS)),{watch:{read:async()=>5_000_000n}});
 const r=await h.run();
 assert.equal(r.status,undefined);
 assert.equal(h.lines.at(-1).stage,'still_pending');
});

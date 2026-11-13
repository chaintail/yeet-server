// Test doubles for every external system the engine uses: 1Click (answers built from the router's recorded fixtures,
// vendor/yeet-win/router/test/fixtures), the signer adapter and the wallet balances. Nothing here touches a network.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openTradeDb} from './db.mjs';
import {createEngine} from './engine.mjs';
import {refuse} from './util.mjs';
import {base58Encode} from './router.mjs';
import {USDC_KEY} from './accounting.mjs';

const fixture=name=>JSON.parse(readFileSync(new URL(`../../vendor/yeet-win/router/test/fixtures/${name}`,import.meta.url),'utf8'));
// Well-formed addresses (the router tests' own: random bytes, not funded wallets).
export const SOL_WALLET='G4Xr9SPQWYmkXnTB7r4tienHXYU19TYfsff7wfScjNRt';
export const BASE_WALLET='0x17602fd697f91d31fe551b26a3b12b113789477e';
const hex=(s,n=64)=>createHash('sha256').update(s).digest('hex').slice(0,n);

/**
 * Fake 1Click. quote() answers like the router test helper quoteReply: the recorded quote2-B response scaled to the
 * requested amount, times `ratio.dry` / `ratio.live`, minAmountOut 99% of amountOut. A live quote gets a fresh
 * deposit address. status() walks a per-deposit script of fixture names (default: processing, then success).
 */
export function fakeOneClick({dryRatio=1,liveRatio=1,cost=0,statuses=['status-processing.json','status-success.json'],tokens,depositFor,submitFailures=0,mutate}={}){
 const tpl=fixture('quote2-B-intents-res.json');
 const calls={quote:[],submit:[],status:[]};let n=0;
 const deposits=new Map();
 const scale=(v,r)=>BigInt(Math.floor(Number(v)*r));
 const client={
  authenticated:false,calls,deposits,
  set dryRatio(v){dryRatio=v},set liveRatio(v){liveRatio=v},set cost(v){cost=v},
  set depositFor(f){depositFor=f},set submitFailures(v){submitFailures=v},set mutate(f){mutate=f},
  async quote(req){
   calls.quote.push(req);
   const r=Number(req.amount)/Number(tpl.quote.amountIn),k=req.dry?dryRatio:liveRatio;
   const out=scale(tpl.quote.amountOut,r*k);
   const quote={...tpl.quote,amountIn:req.amount,amountInFormatted:String(Number(req.amount)/1e6),amountInUsd:(Number(tpl.quote.amountInUsd)*r).toFixed(12),
    minAmountIn:req.amount,amountOut:out.toString(),amountOutFormatted:String(Number(out)/1e6),amountOutUsd:(Number(tpl.quote.amountOutUsd)*r*k*(1-cost)).toFixed(12),
    minAmountOut:(out*99n/100n).toString()};
   if(!req.dry){
    n++;quote.depositAddress=depositFor?.(n,req)??(req.originAsset.includes('base-')?`0x${hex(`deposit-${n}`,40)}`:base58Encode(createHash('sha256').update(`deposit-${n}`).digest()));quote.deadline=req.deadline;
    deposits.set(quote.depositAddress,{step:0,amountIn:req.amount,amountOut:out.toString()});
   }
   const res={...tpl,quoteRequest:req,quote,correlationId:`cid-${n}-${req.destinationAsset.slice(-8)}`};
   return mutate?mutate(res,req)??res:res;
  },
  async submitDeposit(depositAddress,txHash){
   calls.submit.push({depositAddress,txHash});
   if(submitFailures>0){submitFailures--;throw Error('fake: deposit/submit unavailable')}
   return this.statusFor(depositAddress,'status-pending.json');
  },
  statusFor(depositAddress,name){
   const d=deposits.get(depositAddress),f=fixture(name);
   const res={...f,correlationId:`st-${depositAddress.slice(-6)}`,updatedAt:new Date().toISOString()};
   if(res.swapDetails)res.swapDetails={...res.swapDetails,amountIn:d.amountIn,...(res.status==='SUCCESS'?{amountOut:d.amountOut,amountOutFormatted:String(Number(d.amountOut)/1e6)}:{amountOut:undefined,amountOutFormatted:undefined}),
    originChainTxHashes:(res.swapDetails.originChainTxHashes??[]).map(()=>({hash:`0x${hex(depositAddress)}`})),
    destinationChainTxHashes:(res.swapDetails.destinationChainTxHashes??[]).map(()=>({hash:'5VfYmGBjvQKe3xgLtTQPkMeAZJcMBdkdhtQ1WtABpbQV3Q6yZ8NnHcRmw7pS4u9vKcXbNfLwDtYr2aE6hJ1gMxoP'}))};
   return res;
  },
  async status(depositAddress){
   calls.status.push(depositAddress);
   const d=deposits.get(depositAddress);if(!d)throw Error('unknown deposit');
   const script=d.script??statuses;
   const name=script[Math.min(d.step++,script.length-1)];
   return this.statusFor(depositAddress,name);
  },
  async getTokens(){return tokens??fixture('tokens.json')},
 };
 return client;
}

/**
 * Fake signer adapter: wallets for every account, recorded transfers, and failures per attempt index. It models the
 * provider's idempotency: a call with an idempotency key already broadcast answers the first transfer's hash and moves
 * nothing again (`replays` counts those).
 *   failLegs  refused before anything is broadcast (error carries notSent: true, like a policy denial)
 *   lostLegs  broadcast (recorded in `sent`), then the answer is lost (timeout, missing hash)
 *   hangLegs  the call never returns (a process that dies mid-send)
 */
export function fakeSigner({signerState='granted',failLegs=[],failCode='TEMPORARILY_UNAVAILABLE',lostLegs=[],hangLegs=[],onSend}={}){
 const sent=[],byKey=new Map();let leg=0;
 const wallet=chain=>({address:chain==='base'?BASE_WALLET:SOL_WALLET,walletId:`wallet-${chain}`,signerState,policyId:'policy-1'});
 const s={
  kind:'fake',sent,replays:0,hashes:byKey,
  directory:{stable:false,lookup:async()=>({base:wallet('base'),solana:wallet('solana')})},
  set signerState(v){signerState=v},
  transferUsdcBase:args=>transfer('base',args,`0x${hex(`${args.to}:${args.amountRaw}:${args.idempotencyKey}`)}`),
  transferSpl:args=>transfer('solana',args,base58Encode(createHash('sha256').update(`spl:${args.idempotencyKey}`).digest())),
 };
 async function transfer(chain,args,txHash){
  if(byKey.has(args.idempotencyKey)){s.replays++;return {txHash:byKey.get(args.idempotencyKey)}}
  const i=leg++;onSend?.(i,args);
  if(hangLegs.includes(i))return new Promise(()=>{});
  if(failLegs.includes(i)){try{refuse(failCode,'fake refusal')}catch(e){e.notSent=true;throw e}}
  sent.push({chain,...args});byKey.set(args.idempotencyKey,txHash);
  if(lostLegs.includes(i))refuse('TEMPORARILY_UNAVAILABLE','fake: broadcast, answer lost');
  return {txHash};
 }
 return s;
}

/** Fake balances: USDC on Base and SPL holdings on Solana. */
export function fakeBalances({usdc='100',holdings=[]}={}){
 const b={usdcRaw:BigInt(Math.round(Number(usdc)*1e6)),holdings,
  async baseUsdc(){return b.usdcRaw},async baseEth(){return 10n**16n},
  async solanaTokens(){return b.holdings},async recentBlockhash(){return '11111111111111111111111111111111'}};
 return b;
}

/**
 * Fake chain reader for the balance check (accounting.mjs): the fake balances minus what the fake signer broadcast,
 * so before/after reads move like the chain would. `adjust[asset]` adds to a balance (negative: an unexplained
 * debit), `failReads` makes the next n reads throw.
 */
export function fakeChain({balances,signer,adjust={},failReads=0}={}){
 const c={adjust,reads:0,set failReads(v){failReads=v},
  async source({chain,address,assets}){
   c.reads++;
   if(failReads>0){failReads--;throw Error('fake: rpc unavailable')}
   const sentOn=(ch,pred)=>(signer?.sent??[]).filter(x=>x.chain===ch&&pred(x)).reduce((a,x)=>a+BigInt(x.amountRaw),0n);
   if(chain==='base')return {[USDC_KEY]:balances.usdcRaw-sentOn('base',()=>true)+BigInt(c.adjust[USDC_KEY]??0)};
   return Object.fromEntries(assets.map(a=>[a,balances.holdings.filter(h=>h.mint===a).reduce((s,h)=>s+h.raw,0n)-sentOn('solana',x=>x.mint===a)+BigInt(c.adjust[a]??0)]));
  }};
 return c;
}

/** A clock tests can move. */
export function fakeClock(start=Date.parse('2026-11-12T12:00:00.000Z')){let t=start;const now=()=>t;now.advance=ms=>{t+=ms};now.set=ms=>{t=ms};return now}

/** An engine over an in-memory database with fakes for every external system. */
export async function fakeEngine({env={YEET_LIVE:'1'},oneclick,signer,balances,chain,now=fakeClock(),onSettled,budgetMs,hooks}={}){
 const db=openTradeDb(':memory:');
 oneclick??=fakeOneClick();signer??=fakeSigner();balances??=fakeBalances();chain??=fakeChain({balances,signer});
 const engine=await createEngine({db,env,client:oneclick,signer,balances,chain,now,onSettled,trackerIntervalMs:0,budgetMs,hooks});
 return {engine,db,oneclick,signer,balances,chain,now};
}

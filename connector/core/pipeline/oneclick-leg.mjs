// The swap provider call: NEAR Intents 1Click, through the vendored router's OneClickClient. This replaces Folio's
// assemble() (client-signing.ts:354): instead of a swap instruction, a leg is a plain transfer to the per-quote deposit
// address 1Click answers.
//   chain 'sol'  BUY: USDC on Solana -> coin, SELL: coin -> USDC on Solana; recipient and refundTo = the person's
//                Solana wallet. Request and leg shape are the router's own (plan.js quoteLegs / toPlanLeg), so the
//                tracker, receipts and applyStatus work unchanged.
//   chain 'base' BUY: USDC on Base -> coin, SELL: coin -> USDC on Base: the router's buildYeetPlan / buildSkeetPlan.
// assertLivePlan checks the answer leg by leg against the proposal and the person's own wallets before anything is
// committed (YEET executor.mjs rules, generalised over the origin chain).
import {createHash} from 'node:crypto';
import {buildYeetPlan,buildSkeetPlan,findToken,FUNDING,CATALOG,PlanQuoteError,formatUnits,isEvmAddress,isSolanaAddress} from '../trade/router.mjs';
import {routed} from '../trade/proposals.mjs';
import {refuse} from '../trade/util.mjs';

/** USDC on Base (the router catalogue's funding asset). */
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const DEADLINE_MINUTES=30;
/** The USDC a trade is paid with (BUY) or paid out in (SELL) per driver chain. */
export const usdcOn=(chain,catalog=CATALOG)=>chain==='sol'?findToken('USDC','solana',catalog):(findToken(FUNDING.symbol,'base',catalog)??FUNDING);
const brief=t=>({symbol:t.symbol,chain:t.chain,assetId:t.assetId,decimals:t.decimals});

async function quoteLegs(client,legs,common){
 const settled=await Promise.allSettled(legs.map(leg=>client.quote({dry:false,swapType:'EXACT_INPUT',slippageTolerance:common.slippageBps,originAsset:leg.origin.assetId,
  depositType:'ORIGIN_CHAIN',destinationAsset:leg.destination.assetId,amount:leg.amount.toString(),refundTo:common.refundTo,refundType:'ORIGIN_CHAIN',
  recipient:common.recipient,recipientType:'DESTINATION_CHAIN',deadline:common.deadline})));
 const failures=[],out=[];
 settled.forEach((r,i)=>{
  const leg=legs[i];
  if(r.status==='rejected'){failures.push({symbol:leg.symbol,error:r.reason instanceof Error?r.reason:Error(String(r.reason))});return}
  const res=r.value,q=res.quote;
  try{
   if(q.amountIn!==leg.amount.toString())throw Error(`quote amountIn ${q.amountIn} differs from requested ${leg.amount} (correlationId ${res.correlationId})`);
   if(!q.depositAddress)throw Error(`live quote returned no depositAddress (correlationId ${res.correlationId})`);
   const l={index:i,symbol:leg.symbol,origin:brief(leg.origin),destination:brief(leg.destination),amountIn:q.amountIn,amountInFormatted:q.amountInFormatted,amountInUsd:q.amountInUsd,
    amountOut:q.amountOut,amountOutFormatted:q.amountOutFormatted,amountOutUsd:q.amountOutUsd,minAmountOut:q.minAmountOut,
    minAmountOutFormatted:formatUnits(BigInt(q.minAmountOut),leg.destination.decimals),timeEstimate:q.timeEstimate,deadline:q.deadline??common.deadline,
    correlationId:res.correlationId,signature:res.signature,quoteTimestamp:res.timestamp,depositAddress:q.depositAddress};
   if(leg.parts!==undefined)l.parts=leg.parts;
   if(q.depositMemo)l.depositMemo=q.depositMemo;
   if(q.timeWhenInactive)l.timeWhenInactive=q.timeWhenInactive;
   out.push(l);
  }catch(e){failures.push({symbol:leg.symbol,error:e})}
 });
 if(failures.length)throw new PlanQuoteError(failures);
 return out;
}

/**
 * Live plan (dry:false: one deposit address per leg) for the proposal legs. `legs` are proposal_legs rows (symbol,
 * asset_id, parts, amount_in_raw, amount_in). Router errors become catalogue codes (proposals.routed).
 */
export async function livePlan({direction,legs,w,chain,slippageBps,client,now=Date.now,catalog=CATALOG}){
 const deps={client,catalog,now:()=>new Date(now())};
 if(chain==='base'){
  if(direction==='yeet')return routed(()=>buildYeetPlan({amountUsdc:formatUnits(legs.reduce((a,l)=>a+BigInt(l.amount_in_raw),0n),6),legs:legs.map(l=>({symbol:l.symbol,parts:l.parts})),
   recipientSol:w.solana.address,refundBase:w.base.address,slippageBps,dry:false},deps));
  return routed(()=>buildSkeetPlan({legs:legs.map(l=>({symbol:l.symbol,amount:l.amount_in})),recipientBase:w.base.address,refundSol:w.solana.address,slippageBps,dry:false},deps));
 }
 if(chain!=='sol')refuse('TEMPORARILY_UNAVAILABLE',`no plan for chain ${chain}`);
 const usdc=usdcOn('sol',catalog);
 if(!usdc)refuse('TEMPORARILY_UNAVAILABLE','catalogue is missing USDC on Solana');
 const coinOf=l=>{const c=catalog.find(e=>e.assetId===l.asset_id&&e.chain==='solana');if(!c)refuse('COIN_NOT_SUPPORTED',l.symbol);return c};
 const planLegs=legs.map(l=>{const coin=coinOf(l);return direction==='yeet'
  ?{symbol:coin.symbol,parts:l.parts??undefined,origin:usdc,destination:coin,amount:BigInt(l.amount_in_raw)}
  :{symbol:coin.symbol,origin:coin,destination:usdc,amount:BigInt(l.amount_in_raw)}});
 const recipient=w.solana.address,refundTo=w.solana.address,at=new Date(now());
 const deadline=new Date(at.getTime()+DEADLINE_MINUTES*60_000).toISOString();
 const id=`${direction}_${createHash('sha256').update(JSON.stringify({direction,chain,legs:planLegs.map(l=>[l.origin.assetId,l.destination.assetId,l.amount.toString()]),recipient,refundTo,slippageBps,at:at.toISOString()})).digest('hex').slice(0,24)}`;
 const out=await routed(()=>quoteLegs(client,planLegs,{recipient,refundTo,slippageBps,deadline}));
 return {id,direction,dry:false,createdAt:at.toISOString(),recipient,refundTo,slippageBps,authenticated:!!client.authenticated,legs:out,originChain:'sol'};
}

const SOLANA_ZERO='11111111111111111111111111111111';
const EVM_ZERO='0x'+'0'.repeat(40);
const same=(chain,a,b)=>typeof a==='string'&&typeof b==='string'&&(chain==='base'?a.toLowerCase()===b.toLowerCase():a===b);

/**
 * executor.mjs assertLivePlan, over the origin chain: same coins in order, amountIn equal to the proposal, origin and
 * destination assets as the direction and chain require, recipient and refundTo the person's own wallets, and a
 * well-formed deposit address on the origin chain that is no wallet, token contract, mint or zero address and is not
 * shared between legs. Any mismatch is TEMPORARILY_UNAVAILABLE, logged with the 1Click correlationId.
 */
export function assertLivePlan({direction,chain,live,legs,w,catalog=CATALOG,log=console.error}){
 const fail=(why,l)=>{log(JSON.stringify({event:'trade_plan_refused',reason:why,leg:l?.index??null,symbol:l?.symbol??null,correlationId:l?.correlationId??null}));refuse('TEMPORARILY_UNAVAILABLE',`live plan: ${why}`)};
 const usdc=usdcOn(chain,catalog);
 const origin=direction==='yeet'?(chain==='sol'?'solana':'base'):'solana';
 const dest=direction==='yeet'?'solana':(chain==='sol'?'solana':'base');
 if(live?.direction!==undefined&&live.direction!==direction)fail('direction');
 if(!Array.isArray(live?.legs)||live.legs.length!==legs.length||!legs.length)fail('leg count');
 if(!same(dest,live.recipient,w[dest].address))fail('recipient is not the own wallet');
 if(!same(origin,live.refundTo,w[origin].address))fail('refund address is not the own wallet');
 const seen=new Set();
 for(const [i,l] of live.legs.entries()){
  const p=legs[i];
  if(l.index!==i||l.symbol!==p.symbol)fail('leg order or coin',l);
  if(l.amountIn!==p.amount_in_raw)fail('amountIn differs from the proposal',l);
  const coin=catalog.find(c=>c.assetId===p.asset_id&&c.chain==='solana');
  if(!coin)fail('coin not in catalogue',l);
  const [wantOrigin,wantDest]=direction==='yeet'?[usdc.assetId,p.asset_id]:[p.asset_id,usdc.assetId];
  if(l.origin?.assetId!==wantOrigin)fail('origin asset',l);
  if(l.destination?.assetId!==wantDest)fail('destination asset',l);
  const dep=l.depositAddress;
  if(typeof dep!=='string'||!(origin==='base'?isEvmAddress(dep):isSolanaAddress(dep)))fail('deposit address malformed',l);
  const forbidden=origin==='base'?[w.base.address,USDC_BASE,EVM_ZERO]:[w.solana.address,coin.address,usdc.address,SOLANA_ZERO];
  if(forbidden.some(a=>same(origin,dep,a))||dep===w.solana.address||same('base',dep,w.base.address))fail('deposit address is a known non-deposit address',l);
  const k=origin==='base'?dep.toLowerCase():dep;
  if(seen.has(k))fail('deposit address repeated',l);
  seen.add(k);
 }
}

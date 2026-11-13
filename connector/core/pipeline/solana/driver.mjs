// The Solana driver (driver-interface.mjs): BUY (USDC on Solana) and SELL (the coin) are the same code, one
// TransferChecked from the person's wallet to the leg's 1Click deposit address, signed by the person (signer 1) and
// co-signed by the YEET fee payer (signer 0) through client-signing.mjs. A basket's legs share ONE transaction (one
// signature by the person, one co-sign) when they fit; otherwise one transaction per leg (prepareLegs).
// Env: SOLANA_RPC_URL, SOLANA_BROADCAST_RPC_URL (optional), YEET_SOL_FEE_PAYER_ID, YEET_SOL_FEE_PAYER_ADDRESS,
// YEET_FEE_PAYER_SOL_FLOOR, YEET_SOLANA_PAUSE, YEET_SOL_PRIORITY_MICRO_LAMPORTS, YEET_SOL_BATCH_MAX_LEGS,
// YEET_SPONSOR_* (sponsorship.mjs).
import {assertDriver} from '../driver-interface.mjs';
import {createClientSigning} from './client-signing.mjs';
import {legPin,DEFAULT_PRIORITY_MICRO_LAMPORTS,MAX_BASKET_LEGS} from './transfer-leg.mjs';
import {legDeadline} from '../tracker.mjs';
import {refuse,TradeError} from '../../trade/util.mjs';
import {legsOfAttempt} from '../ledger.mjs';

export const SEND_MARGIN_MS=120_000;
/** Why a basket chunk falls back to one request per leg. */
const BATCH_FALLBACK=['BATCH_TOO_LARGE','BATCH_UNSUPPORTED','SPONSOR_QUOTA_EXHAUSTED','CLIENT_FEE_CAP_EXCEEDED'];
/** YEET_SOL_BATCH_MAX_LEGS: legs per Solana transaction, 1..5, default 5 (1 = one request per leg, as before). */
export const batchMaxFromEnv=env=>{const v=env.YEET_SOL_BATCH_MAX_LEGS?.trim();if(!v)return MAX_BASKET_LEGS;if(!/^[1-5]$/.test(v))throw Error('Invalid YEET_SOL_BATCH_MAX_LEGS (1..5)');return Number(v)};
const priorityFromEnv=env=>{const v=env.YEET_SOL_PRIORITY_MICRO_LAMPORTS?.trim();if(!v)return DEFAULT_PRIORITY_MICRO_LAMPORTS;if(!/^\d{1,6}$/.test(v))throw Error('Invalid YEET_SOL_PRIORITY_MICRO_LAMPORTS');return BigInt(v)};

/**
 * `gate(accountId)` throws TRADING_PAUSED when the kill switch, YEET_LIVE, YEET_LIVE_ACCOUNTS or YEET_SOLANA_PAUSE says
 * so; it is read again before every issue and twice before every co-sign. `feePayer` is {address, signTransaction};
 * null leaves the driver loaded but not ready (FEE_PAYER_NOT_CONFIGURED).
 */
export function createSolanaDriver({ledger,rpc,signatureStatus,historySignatureStatus,feePayer,floor,gate,env=process.env,now=Date.now,log=()=>{},liveBroadcast=true,sponsorLimits}){
 const signing=feePayer?createClientSigning({ledger,rpc,signatureStatus,historySignatureStatus,feePayer,floor,gate,now,log,liveBroadcast,
  priorityMicroLamports:priorityFromEnv(env),maxFeeLamports:sponsorLimits?.max_fee_lamports}):null;
 const ready=()=>{if(!signing)refuse('TEMPORARILY_UNAVAILABLE','FEE_PAYER_NOT_CONFIGURED')};
 const pinFor=(leg,wallet)=>legPin({leg,wallet,feePayer:feePayer.address,rpc});
 const batchMax=batchMaxFromEnv(env);
 const exitOf=trade=>trade.direction==='skeet';
 /** One attempt for `chunk` (rows, ascending idx, pins resolved); the earliest deposit deadline governs its expiry. */
 const issueChunk=(trade,chunk)=>signing.issueBasket({trade,legs:chunk.map(c=>c.leg),accountId:trade.account_id,pins:chunk.map(c=>c.pin),exit:exitOf(trade),
  expiresCap:Math.min(...chunk.map(c=>c.deadline))-SEND_MARGIN_MS});
 /**
  * Sign requests for several legs: [{attemptId, legs:[idx], ...issue result} | {legs:[idx], error}], never throws for a
  * leg. Eligible legs (deadline past the margin) go in chunks of at most YEET_SOL_BATCH_MAX_LEGS, in idx order, ONE
  * transaction per chunk. A chunk that does not fit (BATCH_TOO_LARGE), cannot share a transaction (BATCH_UNSUPPORTED)
  * is over the sponsorship quota as a whole (SPONSOR_QUOTA_EXHAUSTED) or whose fee (compute limit grows with N) is
  * over YEET_SPONSOR_MAX_FEE_LAMPORTS (CLIENT_FEE_CAP_EXCEEDED) falls back to one request per leg (today's semantics:
  * the quota admits what it can). Any other error is that chunk's legs' error. All are refused before anything is
  * reserved.
  */
 async function prepareLegs({trade,legs,wallet}){
  ready();
  const out=[],eligible=[];
  for(const leg of [...legs].sort((a,b)=>a.idx-b.idx)){
   const deadline=legDeadline(leg);
   if(!(now()+SEND_MARGIN_MS<deadline)){out.push({legs:[leg.idx],error:new TradeError('TEMPORARILY_UNAVAILABLE','deposit deadline too close')});continue}
   try{eligible.push({leg,deadline,pin:await pinFor(leg,wallet)})}catch(e){out.push({legs:[leg.idx],error:e})}
  }
  const single=async c=>{try{out.push(await issueChunk(trade,[c]))}catch(e){out.push({legs:[c.leg.idx],error:e})}};
  for(let i=0;i<eligible.length;i+=batchMax){
   const chunk=eligible.slice(i,i+batchMax);
   if(chunk.length===1){await single(chunk[0]);continue}
   try{out.push(await issueChunk(trade,chunk))}
   catch(e){
    if(BATCH_FALLBACK.includes(e?.reason??e?.code)){
     log({event:'basket_fallback',trade:trade.id,legs:chunk.map(c=>c.leg.idx),reason:e?.reason??e?.code,scope:e?.scope??null});
     for(const c of chunk)await single(c);
    }else for(const c of chunk)out.push({legs:[c.leg.idx],error:e});
   }
  }
  return out;
 }
 return assertDriver({
  chain:'sol',kind:'solana_tx',
  feePayerAddress:feePayer?.address??null,
  readiness(){
   const reasons=[];
   if(!feePayer)reasons.push('FEE_PAYER_NOT_CONFIGURED');
   if(!rpc)reasons.push('SOLANA_RPC_NOT_CONFIGURED');
   if(['1','true','on','yes'].includes(String(env.YEET_SOLANA_PAUSE??'').toLowerCase()))reasons.push('SOURCE_PAUSED');
   return {ok:!reasons.length,reasons};
  },
  prepareLegs,
  async prepare({trade,leg,wallet}){
   const [r]=await prepareLegs({trade,legs:[leg],wallet});
   if(r.error)throw r.error;
   return r;
  },
  async submit({trade,leg,wallet,attemptId,signed,dryRun=false}){
   ready();
   // The pins are every leg the attempt pays, in its order (a legacy or unknown attempt: the leg alone; signed()
   // refuses an unknown attempt).
   const a=ledger.attempt(attemptId);
   const rows=a&&a.trade_id===trade.id?legsOfAttempt(a).map(i=>ledger.leg(trade.id,i)):[leg];
   if(rows.some(r=>!r))refuse('INVALID_ARGUMENT','unknown attempt');
   const pins=[];for(const r of rows)pins.push(await pinFor(r,wallet));
   return signing.signed(attemptId,signed,{accountId:trade.account_id,wallet,pins,dryRun});
  },
  async recover(){
   if(!signing)return [];
   const out=[];
   for(const a of ledger.unresolved('sol'))out.push(await signing.recoverAttempt(a.attempt_id).catch(e=>({tradeId:a.trade_id,legIdx:a.leg_idx,legs:legsOfAttempt(a),state:'pending',error:String(e?.message??e).slice(0,120)})));
   return out;
  },
  recoverAttempt:id=>signing?signing.recoverAttempt(id):Promise.resolve({state:'pending'}),
 });
}

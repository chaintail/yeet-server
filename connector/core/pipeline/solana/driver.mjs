// The Solana driver (driver-interface.mjs): BUY (USDC on Solana) and SELL (the coin) are the same code, one
// TransferChecked from the person's wallet to the leg's 1Click deposit address, signed by the person (signer 1) and
// co-signed by the YEET fee payer (signer 0) through client-signing.mjs.
// Env: SOLANA_RPC_URL, SOLANA_BROADCAST_RPC_URL (optional), YEET_SOL_FEE_PAYER_ID, YEET_SOL_FEE_PAYER_ADDRESS,
// YEET_FEE_PAYER_SOL_FLOOR, YEET_SOLANA_PAUSE, YEET_SOL_PRIORITY_MICRO_LAMPORTS, YEET_SPONSOR_* (sponsorship.mjs).
import {assertDriver} from '../driver-interface.mjs';
import {createClientSigning} from './client-signing.mjs';
import {legPin,DEFAULT_PRIORITY_MICRO_LAMPORTS} from './transfer-leg.mjs';
import {legDeadline} from '../tracker.mjs';
import {refuse} from '../../trade/util.mjs';

export const SEND_MARGIN_MS=120_000;
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
  async prepare({trade,leg,wallet}){
   ready();
   const deadline=legDeadline(leg);
   if(!(now()+SEND_MARGIN_MS<deadline))refuse('TEMPORARILY_UNAVAILABLE','deposit deadline too close');
   return signing.issue({trade,leg,accountId:trade.account_id,pin:await pinFor(leg,wallet),exit:trade.direction==='skeet',expiresCap:deadline-SEND_MARGIN_MS});
  },
  async submit({trade,leg,wallet,attemptId,signed,dryRun=false}){
   ready();
   return signing.signed(attemptId,signed,{accountId:trade.account_id,wallet,pin:await pinFor(leg,wallet),dryRun});
  },
  async recover(){
   if(!signing)return [];
   const out=[];
   for(const a of ledger.unresolved('sol'))out.push(await signing.recoverAttempt(a.attempt_id).catch(e=>({tradeId:a.trade_id,legIdx:a.leg_idx,state:'pending',error:String(e?.message??e).slice(0,120)})));
   return out;
  },
  recoverAttempt:id=>signing?signing.recoverAttempt(id):Promise.resolve({state:'pending'}),
 });
}

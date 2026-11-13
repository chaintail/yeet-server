// The Base driver as the pipeline sees it (driver-interface.mjs). Review finding 8 (security): the Base driver keeps
// its own durable attempts (base_attempt), and its `sent` means "broadcast", not "landed". This adapter is the only
// bridge between that state and the pipeline ledger (client_trade, trade_legs):
//   prepare  attempt n = 1 + the highest number either side has used for the leg; the Base driver prepares the pinned
//            USDC transfer under that id, then ledger.issue records it (no fee reservation: Base gas is top-up gas)
//   submit   the person's 0x02... bytes go to the Base driver (guards 1-12, top-up after validation); the leg then
//            follows the Base attempt through sync()
//   sync     base state -> ledger: signed/awaiting_gas -> leg awaiting_gas; submitted/uncertain -> leg signing;
//            confirmed (receipt status 1 with the pinned Transfer log, or an observed Transfer, finding 1) -> leg sent;
//            failed -> leg failed; cancelled after signing -> leg not_sent; cancelled before signing -> the attempt
//            is abandoned and the leg waits for a fresh request. Only `confirmed` is answered as `sent`, so the
//            pipeline posts /deposit/submit only for a landed transfer. Every amount a not-sent leg frees is held
//            until the deposit deadline (ledger releaseSpend, finding 2).
// Non-TradeError failures (RPC) become TEMPORARILY_UNAVAILABLE with a redacted detail (finding 5).
import {assertDriver} from '../driver-interface.mjs';
import {attemptIdOf} from '../ledger.mjs';
import {TradeError,refuse} from '../../trade/util.mjs';
import {createBaseDriver} from './driver.mjs';
import {createBaseRpc} from './rpc.mjs';
import {safeError} from './safe-error.mjs';

/** How often recover() runs the Base driver's global reconcile at most (the tracker asks once per open trade). */
export const BASE_RECOVER_MIN_INTERVAL_MS=2_000;

const wrap=e=>e instanceof TradeError?e:new TradeError('TEMPORARILY_UNAVAILABLE',`base: ${safeError(e)}`);

export function createBaseLegDriver({db,ledger,env=process.env,now=Date.now,log=()=>{},gate,liveBroadcast=true,rpc,loadWallet,base}={}){
 if(!db||!ledger)throw Error('createBaseLegDriver needs db and ledger');
 const url=String(env.BASE_RPC_URL??'').trim();
 rpc??=url?createBaseRpc({url,env}):null;
 const alert=a=>{
  const key=`${a.kind}:${a.attempt_id??a.account_id??a.wallet??'-'}${String(a.kind).startsWith('gas_wallet')?`:${now()}`:''}`;
  try{ledger.raiseAlert({key,tradeId:'-',kind:a.kind,detail:a})}catch(e){log({event:'base_alert_failed',kind:a.kind,error:safeError(e)})}
 };
 base??=rpc?createBaseDriver({db,rpc,env,now,alert,log:(event,fields)=>log({event,...fields}),...(loadWallet?{loadWallet}:{})}):null;
 let lastRecover=-Infinity;

 const ready=()=>{if(!base)refuse('TEMPORARILY_UNAVAILABLE','BASE_RPC_NOT_CONFIGURED')};
 /** Moves the ledger to where the Base attempt is. Returns a driver-interface state. */
 function sync(id){
  const a=ledger.attempt(id),b=base?.attempt(id);
  if(!a||!b)return {state:'pending'};
  const ev=JSON.parse(b.evidence_json||'{}'),signedHash=ev.signed_hash??b.tx_hash,signed=b.signed_raw?{signedHex:b.signed_raw,txHash:signedHash}:{};
  const legRef={tradeId:a.trade_id,legIdx:a.leg_idx};
  switch(b.state){
   case 'prepared':return {...legRef,state:'awaiting_signature'};
   case 'signed':case 'awaiting_gas':ledger.evmProgress(id,'signed',signed);return {...legRef,state:'pending',txHash:signedHash};
   case 'submitted':case 'uncertain':ledger.evmProgress(id,'broadcast',signed);return {...legRef,state:'pending',txHash:signedHash};
   case 'confirmed':ledger.evmProgress(id,'confirmed',{...signed,txHash:b.tx_hash,evidence:{code:b.code??null}});return {...legRef,state:'sent',txHash:b.tx_hash};
   case 'failed':
    if(!b.signed_raw){if(a.status==='pending')ledger.endAttempt(id,'pending',b.code??'FAILED');return {...legRef,state:'expired'}}
    ledger.evmProgress(id,'failed',{...signed,reason:b.code});return {...legRef,state:'not_sent',code:b.code};
   case 'cancelled':
    if(!b.signed_raw){if(a.status==='pending')ledger.endAttempt(id,'pending',b.code??'CANCELLED');return {...legRef,state:'expired',code:b.code}}
    ledger.evmProgress(id,'not_sent',{...signed,reason:b.code});return {...legRef,state:'not_sent',code:b.code};
  }
  return {...legRef,state:'pending'};
 }
 async function baseRecover(force=false){
  if(!base)return [];
  if(!force&&now()-lastRecover<BASE_RECOVER_MIN_INTERVAL_MS)return [];
  lastRecover=now();
  try{return await base.recover({now:now()})}catch(e){log({event:'base_recover_failed',error:safeError(e)});return []}
 }

 return assertDriver({
  chain:'base',kind:'evm_tx',
  readiness(){
   if(!base)return {ok:false,reasons:['BASE_RPC_NOT_CONFIGURED']};
   return base.readiness();
  },
  async prepare({trade,leg,wallet}){
   ready();
   gate?.(trade.account_id);
   // A Base attempt the ledger already abandoned (window closed, superseded) gives its nonce back first.
   for(const p of base.preparedFor(wallet)){const la=ledger.attempt(p.id);if(!la||la.status!=='pending')base.abandonPrepared(p.id,'SUPERSEDED')}
   const n=Math.max(ledger.lastAttempt(trade.id,leg.idx)?.attempt_no??0,base.maxAttemptNo(trade.id,leg.idx))+1;
   const attemptId=attemptIdOf(trade.id,leg.idx,n);
   let r;try{r=await base.prepare({trade,leg,wallet,attemptId,attemptNo:n,now:now()})}catch(e){throw wrap(e)}
   let row;
   try{row=ledger.issue({tradeId:trade.id,idx:leg.idx,accountId:trade.account_id,wallet,chain:'base',kind:'evm_tx',payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt})}
   catch(e){base.abandonPrepared(attemptId,'LEDGER_REFUSED');throw wrap(e)}
   if(row.attempt_id!==attemptId){base.abandonPrepared(attemptId,'LEDGER_REFUSED');refuse('TEMPORARILY_UNAVAILABLE','attempt id mismatch')}
   log({event:'execute_issued',chain:'base',attempt:attemptId.slice(0,12),trade:trade.id,leg:leg.idx,nonce:r.payload.nonce});
   return {attemptId,payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt};
  },
  async submit({trade,leg,wallet,attemptId,signed,dryRun=false}){
   ready();
   const a=ledger.attempt(attemptId);
   if(!a||a.chain!=='base'||a.account_id!==trade.account_id||a.wallet!==wallet)refuse('INVALID_ARGUMENT','unknown attempt');
   if(a.status==='abandoned')return {state:'expired'};
   if(a.status==='pending'&&now()>a.expires_at){ledger.endAttempt(attemptId,'pending','SIGN_EXPIRED');base.abandonPrepared(attemptId,'SIGN_EXPIRED');return {state:'expired'}}
   if(dryRun){
    let r;try{r=await base.submit({trade,leg,wallet,attemptId,signed,dryRun:true,now:now()})}catch(e){throw wrap(e)}
    const topup=r.topup?{needed_wei:String(r.topup.needed),shortfall_wei:String(r.topup.shortfall),amount_wei:String(r.topup.amount),fee_wei:r.topup.fee===undefined?null:String(r.topup.fee)}:null;
    return {state:r.state==='expired'?'expired':'not_sent',dryRun:true,txHash:r.txHash,
     simulation:{err:null,transfer_eth_call:r.state==='pending'?'true':null,blocked:r.blocked??[],topup,code:r.code??null}};
   }
   if(!liveBroadcast)refuse('TRADING_PAUSED','LIVE_BROADCAST_DISABLED');
   gate?.(trade.account_id);
   let r;
   try{r=await base.submit({trade,leg,wallet,attemptId,signed,dryRun:false,now:now()})}
   catch(e){sync(attemptId);throw wrap(e)}
   const s=sync(attemptId);
   log({event:'base_submit',attempt:String(attemptId).slice(0,12),base_state:r.state,state:s.state,topup:r.topupTxHash?String(r.topupTxHash).slice(0,12):null});
   return {state:s.state==='awaiting_signature'?'pending':s.state,txHash:s.txHash??r.txHash};
  },
  async recover(){
   await baseRecover(true);
   return ledger.unresolved('base').map(a=>sync(a.attempt_id));
  },
  async recoverAttempt(id){
   await baseRecover();
   return sync(id);
  },
  /** ops/gas-e2e.mjs --plan and readiness pages. */
  gasWallet:()=>String(env.YEET_BASE_GAS_WALLET??'').trim()||null,
 });
}

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
// EIP-7702 baskets (BASE-7702-PRODUCTION-PLAN.md): prepareLegs tries ONE Calibur batch for every leg (batch-driver.mjs)
// and falls back to the per-leg path above (2.7). A batch attempt is one client_trade row with batch_json
// {legs, mode:'7702'}; sync moves every covered leg together: prepared -> awaiting_signature, signed/submitted/uncertain
// -> signing (no awaiting_gas: there is no top-up), confirmed -> sent (only the legs with a Transfer log), failed or
// cancelled after signing -> not_sent/failed. A card answer `unsupported` abandons the attempt, flags the wallet and
// answers expired, so the pipeline returns per-leg requests in the same answer.
import {assertDriver} from '../driver-interface.mjs';
import {attemptIdOf} from '../ledger.mjs';
import {TradeError,refuse} from '../../trade/util.mjs';
import {createBaseDriver} from './driver.mjs';
import {createBaseBatchDriver,BatchFallback} from './batch-driver.mjs';
import {createBaseRpc} from './rpc.mjs';
import {safeError} from './safe-error.mjs';
import {readBaseConfig} from './config.mjs';

/** How often recover() runs the Base driver's global reconcile at most (the tracker asks once per open trade). */
export const BASE_RECOVER_MIN_INTERVAL_MS=2_000;

const wrap=e=>e instanceof TradeError?e:new TradeError('TEMPORARILY_UNAVAILABLE',`base: ${safeError(e)}`);

/** Alert kinds of the batch path mapped onto the kinds trade_alerts accepts (no trade/db.mjs migration, plan 2.9);
 * the original kind stays in detail.alert and in the dedup key. */
export const ALERT_KIND_MAP=Object.freeze({base_7702_deposit_unseen:'deposit_outside_pipeline',base_batch_partial_logs:'partial',
 base_batch_nonce_consumed:'stuck',base_batch_stuck:'stuck',base_batch_check:'sponsor_review',base_batch_receipt_mismatch:'sponsor_review'});
const is7702=a=>{if(!a?.batch_json)return false;try{return JSON.parse(a.batch_json).mode==='7702'}catch{return false}};

export function createBaseLegDriver({db,ledger,env=process.env,now=Date.now,log=()=>{},gate,liveBroadcast=true,rpc,loadWallet,base,batch}={}){
 if(!db||!ledger)throw Error('createBaseLegDriver needs db and ledger');
 const url=String(env.BASE_RPC_URL??'').trim();
 rpc??=url?createBaseRpc({url,env}):null;
 const alert=a=>{
  const key=`${a.kind}:${a.attempt_id??a.account_id??a.wallet??'-'}${String(a.kind).startsWith('gas_wallet')?`:${now()}`:''}`;
  try{ledger.raiseAlert({key,tradeId:'-',kind:ALERT_KIND_MAP[a.kind]??a.kind,detail:{...a,alert:a.kind}})}catch(e){log({event:'base_alert_failed',kind:a.kind,error:safeError(e)})}
 };
 base??=rpc?createBaseDriver({db,rpc,env,now,alert,log:(event,fields)=>log({event,...fields}),...(loadWallet?{loadWallet}:{})}):null;
 batch??=rpc?createBaseBatchDriver({db,rpc,env,now,alert,log:(event,fields)=>log({event,...fields}),...(loadWallet?{loadWallet}:{})}):null;
 let lastRecover=-Infinity;

 const ready=()=>{if(!base)refuse('TEMPORARILY_UNAVAILABLE','BASE_RPC_NOT_CONFIGURED')};
 /** Moves the ledger to where the Base attempt is. Returns a driver-interface state. */
 /** The ledger follows a batch row (plan 2.5). */
 function syncBatch(id,a,b){
  const legRef={tradeId:a.trade_id,legIdx:a.leg_idx,legs:ledger.legsOfAttempt(a)};
  // A signed batch waiting for the gas wallet has the person's signatures but no outer transaction yet.
  const signed=b.signed_raw?{signedHex:b.signed_raw,txHash:b.tx_hash}:b.batch_sig?{signedHex:'0x'+b.batch_sig+(b.auth_sig??''),txHash:null}:{};
  switch(b.state){
   case 'prepared':return {...legRef,state:'awaiting_signature'};
   case 'signed':case 'submitted':case 'uncertain':ledger.evmProgress(id,b.signed_raw?'broadcast':'signed',signed);return {...legRef,state:'pending',txHash:b.tx_hash??undefined};
   case 'confirmed':{const ev=JSON.parse(b.evidence_json||'{}');
    ledger.evmProgress(id,'confirmed',{...signed,txHash:b.tx_hash,legsOk:ev.legs_ok??null,evidence:{code:b.code??null,batch:'7702'}});
    return {...legRef,state:'sent',txHash:b.tx_hash}}
   case 'failed':case 'cancelled':
    if(!b.batch_sig){if(a.status==='pending')ledger.endAttempt(id,'pending',b.code??'CANCELLED');return {...legRef,state:'expired',code:b.code}}
    ledger.evmProgress(id,b.state==='failed'&&b.code==='REVERTED'?'failed':'not_sent',{...signed,reason:b.code});return {...legRef,state:'not_sent',code:b.code};
  }
  return {...legRef,state:'pending'};
 }
 function sync(id){
  const la=ledger.attempt(id);
  if(la&&is7702(la)){const bb=batch?.row(id);return bb?syncBatch(id,la,bb):{state:'pending'}}
  const a=la,b=base?.attempt(id);
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
  try{await batch?.recover({now:now()})}catch(e){log({event:'base_batch_recover_failed',error:safeError(e)})}
  try{return await base.recover({now:now()})}catch(e){log({event:'base_recover_failed',error:safeError(e)});return []}
 }

 /** Abandoned ledger attempts give their prepared Base rows (and the wallet nonce) back first. */
 function releaseStale(wallet){
  for(const p of base.preparedFor(wallet)){const la=ledger.attempt(p.id);if(!la||la.status!=='pending')base.abandonPrepared(p.id,'SUPERSEDED')}
  for(const p of batch?.preparedFor(wallet)??[]){const la=ledger.attempt(p.id);if(!la||la.status!=='pending')batch.abandonPrepared(p.id,'SUPERSEDED')}
 }
 const nextAttemptNo=(tradeId,idx)=>Math.max(ledger.lastAttempt(tradeId,idx)?.attempt_no??0,base.maxAttemptNo(tradeId,idx),batch?.maxAttemptNo(tradeId,idx)??0)+1;
 /** One 7702 batch for every leg (plan 2.1), or null when the basket falls back to the per-leg path (2.7). */
 async function prepareBatch(trade,legs,wallet){
  if(!batch)return null;
  const idxs=legs.map(l=>l.idx),anchor=idxs[0],n=nextAttemptNo(trade.id,anchor),attemptId=attemptIdOf(trade.id,anchor,n);
  let r;
  try{r=await batch.prepare({trade,legs,wallet,attemptId,attemptNo:n,now:now()})}
  catch(e){
   if(e instanceof BatchFallback){log({event:'basket_fallback',chain:'base',trade:trade.id,legs:idxs,reason:e.reason,detail:e.detail===e.reason?null:String(e.detail??'').slice(0,120)});return null}
   throw wrap(e);
  }
  let row;
  try{row=ledger.issue({tradeId:trade.id,idxs,accountId:trade.account_id,wallet,chain:'base',kind:'evm_tx',payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt,batch:{legs:idxs,mode:'7702'}})}
  catch(e){batch.abandonPrepared(attemptId,'LEDGER_REFUSED');throw wrap(e)}
  if(row.attempt_id!==attemptId){batch.abandonPrepared(attemptId,'LEDGER_REFUSED');refuse('TEMPORARILY_UNAVAILABLE','attempt id mismatch')}
  log({event:'execute_issued',chain:'base',kind:'evm_7702',attempt:attemptId.slice(0,12),trade:trade.id,legs:idxs,authorization:!!r.payload.authorization});
  return {attemptId,legs:idxs,payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt};
 }
 async function prepareOne({trade,leg,wallet}){
   ready();
   gate?.(trade.account_id);
   releaseStale(wallet);
   const n=nextAttemptNo(trade.id,leg.idx);
   const attemptId=attemptIdOf(trade.id,leg.idx,n);
   let r;try{r=await base.prepare({trade,leg,wallet,attemptId,attemptNo:n,now:now()})}catch(e){throw wrap(e)}
   let row;
   try{row=ledger.issue({tradeId:trade.id,idx:leg.idx,accountId:trade.account_id,wallet,chain:'base',kind:'evm_tx',payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt})}
   catch(e){base.abandonPrepared(attemptId,'LEDGER_REFUSED');throw wrap(e)}
   if(row.attempt_id!==attemptId){base.abandonPrepared(attemptId,'LEDGER_REFUSED');refuse('TEMPORARILY_UNAVAILABLE','attempt id mismatch')}
   log({event:'execute_issued',chain:'base',attempt:attemptId.slice(0,12),trade:trade.id,leg:leg.idx,nonce:r.payload.nonce});
   return {attemptId,payload:r.payload,payloadSha256:r.payloadSha256,expiresAt:r.expiresAt};
 }
 /** submit for a 7702 batch attempt (plan 1.2, 2.2). */
 async function submitBatch({trade,wallet,attemptId,signed,dryRun},a){
  if(!batch)refuse('TEMPORARILY_UNAVAILABLE','BASE_RPC_NOT_CONFIGURED');
  const rows=ledger.legsOfAttempt(a).map(i=>ledger.leg(trade.id,i));
  if(rows.some(r=>!r))refuse('INVALID_ARGUMENT','unknown attempt');
  if(typeof signed==='string'&&signed.trim().toLowerCase()==='unsupported'){
   // Plan 3.2: Privy refused eth_sign7702Authorization. The wallet goes legacy; the answer carries per-leg requests.
   if(dryRun)return {state:'not_sent',dryRun:true,simulation:{unsupported:true}};
   if(a.status!=='pending')refuse('SOURCE_ATTEMPT_BLOCKED','attempt already signed');
   batch.flagUnsupported(wallet);
   batch.abandonPrepared(attemptId,'WALLET_METHOD_REFUSED');
   ledger.endAttempt(attemptId,'pending','WALLET_METHOD_REFUSED');
   log({event:'base_7702_unsupported',attempt:String(attemptId).slice(0,12),trade:trade.id});
   return {state:'expired',code:'WALLET_METHOD_REFUSED'};
  }
  if(dryRun){
   let r;try{r=await batch.submit({trade,legs:rows,wallet,attemptId,signed,dryRun:true,now:now()})}catch(e){throw wrap(e)}
   if(r.state==='expired')return {state:'expired',dryRun:true,code:r.code,simulation:null};
   const {legs:_l,...sim}=r.simulation??{};
   return {state:'not_sent',dryRun:true,txHash:null,simulation:{...sim,legs_evidence:r.simulation?.legs??[],blocked:r.blocked??[]}};
  }
  if(!liveBroadcast)refuse('TRADING_PAUSED','LIVE_BROADCAST_DISABLED');
  gate?.(trade.account_id);
  let r;
  try{r=await batch.submit({trade,legs:rows,wallet,attemptId,signed,dryRun:false,now:now()})}
  catch(e){sync(attemptId);throw wrap(e)}
  const s=sync(attemptId);
  log({event:'base_submit',kind:'evm_7702',attempt:String(attemptId).slice(0,12),base_state:r.state,state:s.state,code:r.code??null});
  if(r.state==='expired'||s.state==='expired')return {state:'expired',code:r.code??s.code};
  return {state:s.state==='awaiting_signature'?'pending':s.state,txHash:s.txHash??r.txHash};
 }

 return assertDriver({
  chain:'base',kind:'evm_tx',
  readiness(){
   if(!base)return {ok:false,reasons:['BASE_RPC_NOT_CONFIGURED']};
   return base.readiness();
  },
  prepare:prepareOne,
  /** Plan 2.1 / 2.7: one batch for the basket when eligible, else today's per-leg loop. Never throws for a leg. */
  async prepareLegs({trade,legs,wallet}){
   const sorted=[...legs].sort((x,y)=>x.idx-y.idx);
   if(!sorted.length)return [];
   try{
    ready();
    gate?.(trade.account_id);
    releaseStale(wallet);
    const b=await prepareBatch(trade,sorted,wallet);
    if(b)return [b];
   }catch(e){return [{legs:sorted.map(l=>l.idx),error:wrap(e)}]}
   const out=[];
   for(const l of sorted){try{out.push({...await prepareOne({trade,leg:l,wallet}),legs:[l.idx]})}catch(e){out.push({legs:[l.idx],error:e})}}
   return out;
  },
  async submit({trade,leg,wallet,attemptId,signed,dryRun=false}){
   ready();
   const a=ledger.attempt(attemptId);
   if(!a||a.chain!=='base'||a.account_id!==trade.account_id||a.wallet!==wallet)refuse('INVALID_ARGUMENT','unknown attempt');
   if(a.status==='abandoned')return {state:'expired'};
   if(a.status==='pending'&&now()>a.expires_at){ledger.endAttempt(attemptId,'pending','SIGN_EXPIRED');base.abandonPrepared(attemptId,'SIGN_EXPIRED');batch?.abandonPrepared(attemptId,'SIGN_EXPIRED');return {state:'expired'}}
   if(is7702(a))return submitBatch({trade,wallet,attemptId,signed,dryRun},a);
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
  /** Plan 2.5 detection, from the tracker's accounting tick: a 7702 leg still PENDING_DEPOSIT (or never answered)
   * YEET_BASE_DEPOSIT_SEEN_MS after its batch landed sets base_mode_auto_legacy and raises base_7702_deposit_unseen. */
  accountingTick(){
   if(!batch)return 0;
   let seenMs;try{seenMs=readBaseConfig(env).depositSeenMs}catch{return 0}
   let n=0;
   for(const b of batch.confirmedUnchecked()){
    const ev=JSON.parse(b.evidence_json||'{}'),at=Number(ev.confirmed_at??b.updated_at);
    if(now()-at<seenMs)continue;
    const legs=(ev.legs_ok??batch.legsOf(b).map(l=>l.idx)).map(i=>ledger.leg(b.trade_id,i)).filter(Boolean);
    const unseen=legs.filter(l=>!l.oneclick_status||l.oneclick_status==='PENDING_DEPOSIT').map(l=>l.idx);
    if(unseen.length&&batch.autoLegacy({why:'pending_deposit',attempt_id:b.id,trade_id:b.trade_id,tx_hash:b.tx_hash,legs:unseen}))n++;
    batch.markDepositChecked(b.id,{deposit_unseen_legs:unseen});
   }
   return n;
  },
  /** Plan 2.5 detection: a /deposit/submit error naming the batch hash. */
  depositFailed({tradeId,idx,txHash,error}){
   if(!batch||!txHash)return false;
   const a=ledger.openAttempt(tradeId,idx)??ledger.attempt(ledger.leg(tradeId,idx)?.attempt_id);
   if(!a||!is7702(a))return false;
   if(!String(error?.message??error??'').toLowerCase().includes(String(txHash).toLowerCase()))return false;
   return batch.autoLegacy({why:'deposit_submit_error',attempt_id:a.attempt_id,trade_id:tradeId,tx_hash:txHash,legs:[idx]});
  },
 });
}

// Status loop: folds 1Click /status into each sent trade leg with the router's applyStatus, keeps the trade's receipt
// JSON (router ReceiptSchema, so `yeet-router replay` can re-check it) and the trade status, and emits onSettled once
// when every sent leg reaches a final state. Awards nothing itself (XP is lane E).
//
// A trade is polled until every leg is final or its latest 1Click deposit deadline plus YEET_TRACK_MAX_HOURS (default
// 24) has passed; then it is stale: no longer polled, trade status `partial` (some leg succeeded) or `failed` (the
// contract has no "unknown"), and each unfinished leg says why in `refund_reason`. One trade failing to refresh never
// stops the others: the error is kept in trades.last_error.
import {applyStatus,ReceiptSchema,isTerminal,formatUnits} from './router.mjs';
import {refuse,iso} from './util.mjs';
import {transitionTrade,TransitionRefused} from './audit.mjs';
import {destinationAmounts} from './accounting.mjs';

export const TRACK_MAX_HOURS=24;

/** A router ReceiptLeg for a live plan leg (same fields as the router's own emptyLeg). */
export function receiptLeg(l){
 const leg={index:l.index,symbol:l.symbol,depositAddress:l.depositAddress,status:null,final:false,updatedAt:null,
  quote:{amountIn:l.amountIn,amountOut:l.amountOut,minAmountOut:l.minAmountOut,correlationId:l.correlationId,signature:l.signature},
  settled:{},originTxHashes:[],destinationTxHashes:[],nearTxHashes:[],correlationIds:[l.correlationId],history:[],anomalies:[]};
 if(l.depositMemo)leg.depositMemo=l.depositMemo;
 return leg;
}

/** The leg's 1Click deposit deadline (ms), NaN when unknown. */
export const legDeadline=l=>{try{return Date.parse(JSON.parse(l.live_quote_json).deadline)}catch{return NaN}};
/** Final 1Click state: SUCCESS, REFUNDED, FAILED; INCOMPLETE_DEPOSIT only once the deposit deadline has passed (1Click
 * then refunds, ONECLICK-REFERENCE section 5). */
export function legFinal(l,nowMs){
 const s=l.oneclick_status;
 if(!s)return false;
 if(isTerminal(s))return true;
 return s==='INCOMPLETE_DEPOSIT'&&nowMs>legDeadline(l);
}

/** Trade status from its legs (contract trade_status enum). Unsent or failed sends never settle. */
export function foldStatus(legs,nowMs=Date.now()){
 // A leg still queued or being sent keeps the trade in `signing` (recovery resolves it).
 if(legs.some(l=>l.send_status==='queued'||l.send_status==='sending'))return 'signing';
 const sent=legs.filter(l=>l.send_status==='sent');
 const missing=legs.length-sent.length;
 if(!sent.length)return 'failed';
 if(!sent.every(l=>legFinal(l,nowMs))){
  if(missing)return 'partial';
  return sent.some(l=>l.oneclick_status&&l.oneclick_status!=='PENDING_DEPOSIT')?'settling':'submitted';
 }
 const st=sent.map(l=>l.oneclick_status);
 const ok=st.filter(s=>s==='SUCCESS').length;
 if(ok===legs.length)return 'success';
 if(ok>0)return 'partial';
 return st.some(s=>s==='REFUNDED'||s==='INCOMPLETE_DEPOSIT')?'refunded':'failed';
}
/** A stale trade's status: the closest contract value, the detail is in each unfinished leg's refund_reason. */
export const staleStatus=legs=>legs.some(l=>l.send_status==='sent'&&l.oneclick_status==='SUCCESS')?'partial':'failed';

const NO_ACCOUNTING={raiseAlert(){return false},async tick(){}};

export function createTracker({db,client,now=Date.now,onSettled=()=>{},intervalMs=5000,trackMaxHours=TRACK_MAX_HOURS,accounting=NO_ACCOUNTING}){
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
 const tradeRow=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
 const graceMs=trackMaxHours*3600_000;

 /** Recomputes status and receipt for a trade from its legs; emits onSettled on the first complete receipt. */
 function refresh(tradeId){
  const t=tradeRow(tradeId);if(!t||t.status==='requote_required')return t;
  const legs=legsOf(tradeId),prior=t.receipt_json?JSON.parse(t.receipt_json):null,at=now();
  const sent=legs.filter(l=>l.send_status==='sent');
  const complete=sent.length>0&&legs.every(l=>!['queued','sending'].includes(l.send_status))&&sent.every(l=>legFinal(l,at));
  const receipt=ReceiptSchema.parse({...prior,writtenAt:iso(at),legs:sent.map(l=>JSON.parse(l.receipt_leg_json)),
   complete,timedOut:!!prior?.timedOut||(t.stale_at!==null&&!complete)});
  // Beside the router receipt: destination amounts from 1Click /status, and the source movement once checked.
  receipt.accounting={destination:destinationAmounts(sent),...(prior?.accounting?.source?{source:prior.accounting.source}:{})};
  const status=t.stale_at!==null&&!complete?staleStatus(legs):foldStatus(legs,at);
  const set={receipt_json:JSON.stringify(receipt),updated_at:at};
  if(status===t.status){
   if(db.prepare('UPDATE trades SET receipt_json=?,updated_at=? WHERE id=? AND status=?').run(set.receipt_json,at,tradeId,t.status).changes!==1)
    throw new TransitionRefused(`trade ${tradeId} changed meanwhile`);
  }else{
   const evidence={legs:legs.map(l=>({idx:l.idx,send_status:l.send_status,oneclick_status:l.oneclick_status,tx_hash:l.tx_hash,settled_out_raw:l.settled_out_raw})),
    complete,stale:t.stale_at!==null};
   if(!transitionTrade(db,{tradeId,from:t.status,to:status,evidence,set,at}))throw new TransitionRefused(`trade ${tradeId} changed meanwhile`);
  }
  if(status==='partial'&&(complete||t.stale_at!==null))
   accounting.raiseAlert({key:`partial:${tradeId}`,tradeId,kind:'partial',detail:{legs:legs.map(l=>({idx:l.idx,send_status:l.send_status,oneclick_status:l.oneclick_status}))}});
  if(receipt.complete&&!prior?.complete){
   try{onSettled({tradeId,accountId:t.account_id,proposalId:t.proposal_id,direction:t.direction,status,receipt})}catch{}
  }
  return tradeRow(tradeId);
 }

 /** Folds one /status (or /deposit/submit) answer into a leg. */
 function apply(tradeId,idx,res){
  const leg=db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(tradeId,idx);
  const r=applyStatus(JSON.parse(leg.receipt_leg_json),res,iso(now()));
  db.prepare('UPDATE trade_legs SET oneclick_status=?,settled_out_raw=?,refund_reason=?,receipt_leg_json=?,updated_at=? WHERE trade_id=? AND idx=?')
   .run(r.status,r.settled.amountOut??null,r.settled.refundReason??null,JSON.stringify(r),now(),tradeId,idx);
 }
 const noteTrade=(tradeId,message)=>db.prepare('UPDATE trades SET last_error=? WHERE id=?').run(String(message).slice(0,300),tradeId);

 /** Tracking ends: unfinished legs get a reason, the trade a final contract status; nothing is given back to the cap
  * (a leg whose transfer was attempted may have moved funds). */
 function markStale(tradeId){
  const at=now(),hours=trackMaxHours;
  for(const l of legsOf(tradeId)){
   if(l.send_status==='sending')db.prepare('UPDATE trade_legs SET refund_reason=?,updated_at=? WHERE trade_id=? AND idx=?')
    .run(`Tracking stopped after ${hours} h: the transfer was never confirmed. Check your wallet history.`,at,tradeId,l.idx);
   else if(l.send_status==='sent'&&!legFinal(l,at))db.prepare('UPDATE trade_legs SET refund_reason=?,updated_at=? WHERE trade_id=? AND idx=?')
    .run(`Tracking stopped after ${hours} h without a final status (last: ${l.oneclick_status??'PENDING_DEPOSIT'}). Check the explorer link.`,at,tradeId,l.idx);
  }
  const t=tradeRow(tradeId);
  db.prepare('UPDATE trades SET stale_at=? WHERE id=?').run(at,tradeId);
  accounting.raiseAlert({key:`stale:${tradeId}`,tradeId,kind:'stale',detail:{status:t.status,hours,last_error:t.last_error??null,
   legs:legsOf(tradeId).map(l=>({idx:l.idx,send_status:l.send_status,oneclick_status:l.oneclick_status}))}});
  db.prepare("UPDATE proposals SET status='executed',updated_at=? WHERE id=? AND status='executing'").run(at,t.proposal_id);
  refresh(tradeId);
 }

 async function pollTrade(id){
  await recovery(id);
  const at=now(),legs=legsOf(id);
  const horizon=Math.max(tradeRow(id).created_at,...legs.map(legDeadline).filter(Number.isFinite))+graceMs;
  if(at>horizon){markStale(id);return}
  const open=legs.filter(l=>l.send_status==='sent'&&!legFinal(l,at));
  await Promise.all(open.map(async l=>{
   try{apply(id,l.idx,await client.status(l.deposit_address,l.deposit_memo??undefined))}
   catch(e){noteTrade(id,`leg ${l.idx}: status: ${e?.message??'failed'}`)}
  }));
  refresh(id);
 }

 let running=false,timer,recovery=async()=>{};
 /** One tick over every unfinished trade; returns how many were looked at. */
 async function pollOnce(){
  if(running)return 0;running=true;
  try{
   const open=db.prepare("SELECT id FROM trades WHERE status IN('signing','submitted','settling','partial') AND stale_at IS NULL AND receipt_json IS NOT NULL AND json_extract(receipt_json,'$.complete')=0 ORDER BY created_at").all();
   for(const t of open){
    try{await pollTrade(t.id)}
    catch(e){try{noteTrade(t.id,e?.message??'refresh failed')}catch{}}
   }
   try{await accounting.tick()}catch{}
   return open.length;
  }finally{running=false}
 }

 return {
  refresh,apply,pollOnce,
  /** The executor's per-trade send recovery, run before each trade is polled. */
  useRecovery(fn){recovery=fn},
  /** Sweeps once at start (trades a crash left in `signing` are recovered), then every intervalMs. */
  start(){if(!timer&&intervalMs>0){pollOnce().catch(()=>{});timer=setInterval(()=>{pollOnce().catch(()=>{})},intervalMs);timer.unref?.()}},
  stop(){if(timer)clearInterval(timer);timer=undefined},
  /** trade_status for the trade's owner. */
  status(ctx,tradeId){
   const t=tradeRow(tradeId);
   if(!t||t.account_id!==ctx.accountId||t.status==='requote_required')refuse('INVALID_ARGUMENT','unknown trade');
   const legs=legsOf(tradeId);
   const view=legs.map(l=>{
    const q=JSON.parse(l.live_quote_json),r=l.receipt_leg_json?JSON.parse(l.receipt_leg_json):null;
    const out=l.settled_out_raw?formatUnits(BigInt(l.settled_out_raw),q.destination.decimals):null;
    const moving=['sent','sending','queued'].includes(l.send_status);
    return {symbol:l.symbol,status:moving?l.oneclick_status??'PENDING_DEPOSIT':'FAILED',
     amount_in:formatUnits(BigInt(l.amount_in_raw),q.origin.decimals),amount_out:out,origin_tx:l.tx_hash??null,
     destination_tx:r?.destinationTxHashes?.[0]??null,
     refund_reason:moving?(l.refund_reason?String(l.refund_reason).slice(0,200):null):(l.send_status==='failed'?'Not sent: the transfer failed':'Not sent'),
     _dest:q.destination.symbol};
   });
   return {trade_id:t.id,direction:t.direction,status:t.status,
    legs:view.map(({_dest,...v})=>v),
    received:view.filter(v=>v.status==='SUCCESS'&&v.amount_out).map(v=>({symbol:t.direction==='yeet'?v.symbol:v._dest,amount:v.amount_out})),
    updated_at:iso(t.updated_at),xp_award:null};
  },
 };
}

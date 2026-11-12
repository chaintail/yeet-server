// Status loop: folds 1Click /status into each sent trade leg with the router's applyStatus, keeps the trade's receipt
// JSON (router ReceiptSchema, so `yeet-router replay` can re-check it) and the trade status, and emits onSettled once
// when every sent leg reaches a terminal state. Awards nothing itself (XP is lane E).
import {applyStatus,ReceiptSchema,isTerminal,formatUnits} from './router.mjs';
import {refuse,iso} from './util.mjs';

export const TRACK_MAX_AGE_MS=2*60*60_000;

/** A router ReceiptLeg for a live plan leg (same fields as the router's own emptyLeg). */
export function receiptLeg(l){
 const leg={index:l.index,symbol:l.symbol,depositAddress:l.depositAddress,status:null,final:false,updatedAt:null,
  quote:{amountIn:l.amountIn,amountOut:l.amountOut,minAmountOut:l.minAmountOut,correlationId:l.correlationId,signature:l.signature},
  settled:{},originTxHashes:[],destinationTxHashes:[],nearTxHashes:[],correlationIds:[l.correlationId],history:[],anomalies:[]};
 if(l.depositMemo)leg.depositMemo=l.depositMemo;
 return leg;
}

/** Trade status from its legs (contract trade_status enum). Unsent or failed sends never settle. */
export function foldStatus(legs){
 // A leg still queued or being sent keeps the trade in `signing` (recovery resolves it).
 if(legs.some(l=>l.send_status==='queued'||l.send_status==='sending'))return 'signing';
 const sent=legs.filter(l=>l.send_status==='sent');
 const missing=legs.length-sent.length;
 if(!sent.length)return 'failed';
 const st=sent.map(l=>l.oneclick_status);
 if(!st.every(s=>s&&isTerminal(s))){
  if(missing)return 'partial';
  return st.some(s=>s&&s!=='PENDING_DEPOSIT')?'settling':'submitted';
 }
 const ok=st.filter(s=>s==='SUCCESS').length;
 if(ok===legs.length)return 'success';
 if(ok>0)return 'partial';
 return st.includes('REFUNDED')?'refunded':'failed';
}

export function createTracker({db,client,now=Date.now,onSettled=()=>{},intervalMs=5000,maxAgeMs=TRACK_MAX_AGE_MS}){
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
 const tradeRow=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);

 /** Recomputes status and receipt for a trade from its legs; emits onSettled on the first complete receipt. */
 function refresh(tradeId){
  const t=tradeRow(tradeId);if(!t||t.status==='requote_required')return t;
  const legs=legsOf(tradeId),prior=t.receipt_json?JSON.parse(t.receipt_json):null;
  const sent=legs.filter(l=>l.send_status==='sent');
  const receipt=ReceiptSchema.parse({...prior,writtenAt:iso(now()),legs:sent.map(l=>JSON.parse(l.receipt_leg_json)),
   complete:sent.length>0&&sent.every(l=>l.oneclick_status&&isTerminal(l.oneclick_status)),
   timedOut:prior?.timedOut||(now()-t.created_at>maxAgeMs&&!sent.every(l=>l.oneclick_status&&isTerminal(l.oneclick_status)))});
  const status=foldStatus(legs);
  db.prepare('UPDATE trades SET status=?,receipt_json=?,updated_at=? WHERE id=?').run(status,JSON.stringify(receipt),now(),tradeId);
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
 function noteError(tradeId,idx,message){
  const leg=db.prepare('SELECT receipt_leg_json FROM trade_legs WHERE trade_id=? AND idx=?').get(tradeId,idx);
  const r=JSON.parse(leg.receipt_leg_json);r.lastError=String(message).slice(0,300);
  db.prepare('UPDATE trade_legs SET receipt_leg_json=? WHERE trade_id=? AND idx=?').run(JSON.stringify(r),tradeId,idx);
 }

 let running=false,timer,recovery=async()=>{};
 async function pollOnce(){
  if(running)return 0;running=true;
  try{
   const open=db.prepare("SELECT id,created_at FROM trades WHERE status IN('signing','submitted','settling','partial') AND receipt_json IS NOT NULL AND json_extract(receipt_json,'$.complete')=0 AND json_extract(receipt_json,'$.timedOut')=0").all();
   for(const t of open){
    await recovery(t.id);
    const legs=legsOf(t.id).filter(l=>l.send_status==='sent'&&!(l.oneclick_status&&isTerminal(l.oneclick_status)));
    await Promise.all(legs.map(async l=>{
     try{apply(t.id,l.idx,await client.status(l.deposit_address,l.deposit_memo??undefined))}
     catch(e){noteError(t.id,l.idx,e?.message??'status failed')}
    }));
    refresh(t.id);
   }
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

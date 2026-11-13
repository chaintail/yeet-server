// The pipeline's durable state, one SQLite handle (trade/db.mjs migration 6):
//   - leg and trade transitions, each checked against an edge table, written as a guarded UPDATE and recorded in the
//     append-only trade_events table in the same transaction (YEET's audit.mjs pattern, edges for the user-signed flow);
//   - sign attempts (client_trade) and sponsored sends (sponsor_send), lifted from Folio (stock-app origin/main
//     70848f097) apps/server/src/trade/sponsorship.ts createSponsorshipQuota: reserve (quota + attempt row in one
//     transaction), claimClientTrade, finishClientSigning, recordClientSent, abandonClientTrade, failClientTrade;
//   - fee quotas per account, chain and UTC day with Folio's exit (SELL) exemption and reserve, plus a separate rent
//     ledger for the deposit-address token accounts the fee payer creates (new: Folio's rent budget is per person);
//   - the daily USDC cap release (trade/limits.mjs recordSpend) when a BUY leg never moved funds;
//   - the ops alert outbox (trade_alerts).
// Every state change of money happens here and nowhere else.
import {createHash} from 'node:crypto';
import {tx} from '../trade/db.mjs';
import {recordSpend} from '../trade/limits.mjs';
import {utcDay,iso} from '../trade/util.mjs';
import {sponsorshipCeilings,SponsorshipRefusal,DEFAULT_SPONSORSHIP_LIMITS} from './solana/sponsorship.mjs';

/** trades.status (unchanged from audit.mjs). */
export const TRADE_EDGES=Object.freeze({
 [null]:['signing','requote_required'],
 signing:['submitted','settling','success','partial','refunded','failed'],
 submitted:['settling','success','partial','refunded','failed'],
 settling:['success','partial','refunded','failed'],
 partial:['refunded','failed'],
 requote_required:[],success:[],refunded:[],failed:[],
});
/**
 * trade_legs.send_status for user-signed legs:
 *   awaiting_signature  committed; a sign request is out; nothing can move without the person's signature
 *   signing             the person's bytes verified and the co-sign claimed; signed bytes persisted, then sent
 *   awaiting_gas        Base: signed and validated; the gas top-up is on its way (package B)
 *   sent                landed on chain (confirmed), tx_hash set
 *   failed / not_sent   nothing moved (co-sign refused, chain failure, expired and proven never landed, paused)
 * The legacy edges (queued, sending) stay for rows the old engine wrote.
 */
export const LEG_EDGES=Object.freeze({
 [null]:['awaiting_signature'],
 awaiting_signature:['signing','awaiting_gas','not_sent'],
 awaiting_gas:['signing','sent','failed','not_sent'],
 signing:['sent','failed','not_sent'],
 queued:['sending','failed','not_sent'],sending:['sent','failed'],
 sent:[],failed:[],not_sent:[],
});
export const OPEN_LEG=Object.freeze(['awaiting_signature','signing','awaiting_gas','queued','sending']);
export const TRADE_TERMINAL=Object.freeze(['requote_required','success','partial','refunded','failed']);
const LEG_TERMINAL=['sent','failed','not_sent'];

export class TransitionRefused extends Error{constructor(d){super(`transition refused: ${d}`);this.name='TransitionRefused';this.code='TRANSITION_REFUSED'}}
const legal=(edges,from,to)=>(edges[from??null]??[]).includes(to);
const atomic=(db,fn)=>db.isTransaction?fn():tx(db,fn);

export function appendEvent(db,{tradeId,legIdx=null,kind,from=null,to,evidence=null,at}){
 db.prepare('INSERT INTO trade_events(trade_id,leg_id,kind,from_status,to_status,evidence_json,at) VALUES(?,?,?,?,?,?,?)')
  .run(tradeId,legIdx,kind,from,to,evidence===null?null:JSON.stringify(evidence),at);
}
export function recordLegEvent(db,{tradeId,idx,status,evidence,at}){
 if(!evidence||typeof evidence!=='object'||!Object.keys(evidence).length)throw new TransitionRefused(`leg ${status} event needs evidence`);
 appendEvent(db,{tradeId,legIdx:idx,kind:'leg',from:status,to:status,evidence,at});
}
const COLUMN=/^[a-z_]+$/;
function guarded(db,{table,status,key,keyArgs,from,to,set}){
 const cols=Object.keys(set);
 if(!cols.every(c=>COLUMN.test(c)))throw Error('bad column');
 return db.prepare(`UPDATE ${table} SET ${[status,...cols].map(c=>`${c}=?`).join(',')} WHERE ${key} AND ${status}=?`).run(to,...cols.map(c=>set[c]),...keyArgs,from).changes;
}
export function transitionTrade(db,{tradeId,from,to,evidence,set={},at}){
 if(!legal(TRADE_EDGES,from,to))throw new TransitionRefused(`trade ${from} -> ${to}`);
 if(TRADE_TERMINAL.includes(to)&&(!evidence||!Object.keys(evidence).length))throw new TransitionRefused(`trade -> ${to} needs evidence`);
 return atomic(db,()=>{
  if(guarded(db,{table:'trades',status:'status',key:'id=?',keyArgs:[tradeId],from,to,set})!==1)return false;
  appendEvent(db,{tradeId,kind:'trade',from,to,evidence,at});return true;
 });
}
/** One leg from -> to. A terminal state needs evidence; `sent` needs the chain hash or a 1Click status. */
export function transitionLeg(db,{tradeId,idx,from,to,evidence,set={},at}){
 if(!legal(LEG_EDGES,from,to))throw new TransitionRefused(`leg ${from} -> ${to}`);
 if(LEG_TERMINAL.includes(to)&&(!evidence||!Object.keys(evidence).length))throw new TransitionRefused(`leg -> ${to} needs evidence`);
 if(to==='sent'&&!evidence.tx_hash&&!evidence.oneclick_status)throw new TransitionRefused('a sent leg needs a transfer hash or a 1Click status');
 return atomic(db,()=>{
  if(guarded(db,{table:'trade_legs',status:'send_status',key:'trade_id=? AND idx=?',keyArgs:[tradeId,idx],from,to,set})!==1)return false;
  appendEvent(db,{tradeId,legIdx:idx,kind:'leg',from,to,evidence,at});return true;
 });
}

/** Design 1.2: sha256("yeet-attempt:" + trade_id + ":" + leg + ":" + n), hex. */
export const attemptIdOf=(tradeId,idx,n)=>createHash('sha256').update(`yeet-attempt:${tradeId}:${idx}:${n}`).digest('hex');

/** spend_hold is created by trade/db.mjs migration 7. 1Click statuses that prove nothing was deposited at the address. */
const NO_DEPOSIT=['PENDING_DEPOSIT'];

export function createLedger({db,now=Date.now,sponsorLimits=DEFAULT_SPONSORSHIP_LIMITS,log=console.log}){
 const ceilings=sponsorshipCeilings(sponsorLimits);
 const trade=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
 const leg=(id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
 const attempt=id=>db.prepare('SELECT * FROM client_trade WHERE attempt_id=?').get(id);
 const send=id=>db.prepare('SELECT * FROM sponsor_send WHERE attempt_id=?').get(id);
 const used=(day,account,chain)=>db.prepare('SELECT transactions,lamports FROM sponsor_day WHERE day=? AND account_id=? AND chain=?').get(day,account,chain)??{transactions:0,lamports:0};
 const globalUsed=(day,chain)=>Number(db.prepare('SELECT COALESCE(SUM(lamports),0) AS n FROM sponsor_day WHERE day=? AND chain=?').get(day,chain).n);
 const rentUsed=(day,account)=>db.prepare('SELECT accounts,lamports FROM sponsor_rent_day WHERE day=? AND account_id=?').get(day,account)??{accounts:0,lamports:0};
 const rentGlobal=day=>Number(db.prepare('SELECT COALESCE(SUM(lamports),0) AS n FROM sponsor_rent_day WHERE day=?').get(day).n);
 const event=(e)=>{try{log(JSON.stringify(e))}catch{}};
 const setAttempt=(id,from,to,set={})=>{
  const cols=Object.keys(set);
  return db.prepare(`UPDATE client_trade SET status=?,${[...cols,'updated_at'].map(c=>`${c}=?`).join(',')} WHERE attempt_id=? AND status=?`).run(to,...cols.map(c=>set[c]),now(),id,from).changes===1;
 };
 /** Fee and rent back to the day the send was reserved on (Folio abandon/fail). */
 function refund(s){
  db.prepare('UPDATE sponsor_day SET transactions=transactions-1,lamports=lamports-? WHERE day=? AND account_id=? AND chain=?').run(s.lamports,s.day,s.account_id,'sol');
  if(s.rent_lamports>0)db.prepare('UPDATE sponsor_rent_day SET accounts=accounts-1,lamports=lamports-? WHERE day=? AND account_id=?').run(s.rent_lamports,s.day,s.account_id);
 }
 /**
  * A BUY leg that never moved funds through the pipeline goes back to the daily USDC cap, but not yet (review finding
  * 2): the 1Click deposit address stays live until the quote deadline, and the wallet can pay it directly. The amount
  * is held (spend_hold) and released by releaseDue once the deadline has passed and 1Click still reports
  * PENDING_DEPOSIT; any other status keeps it spent and raises `deposit_outside_pipeline`.
  */
 function releaseSpend(t,l){
  if(t.direction!=='yeet')return;
  let deadline;try{deadline=Date.parse(JSON.parse(l.live_quote_json).deadline)}catch{deadline=NaN}
  if(!Number.isFinite(deadline))deadline=now();
  db.prepare("INSERT INTO spend_hold(trade_id,idx,account_id,spent_at,amount_raw,deposit_address,deposit_memo,release_after,state,created_at) VALUES(?,?,?,?,?,?,?,?,'held',?) ON CONFLICT(trade_id,idx) DO NOTHING")
   .run(t.id,l.idx,t.account_id,t.created_at,String(l.amount_in_raw),l.deposit_address,l.deposit_memo??null,deadline,now());
 }

 return {
  attempt,send,trade,leg,
  openAttempt:(tradeId,idx)=>db.prepare("SELECT * FROM client_trade WHERE trade_id=? AND leg_idx=? AND status IN('pending','signing','confirming')").get(tradeId,idx),
  attemptsOf:tradeId=>db.prepare('SELECT * FROM client_trade WHERE trade_id=? ORDER BY leg_idx,attempt_no').all(tradeId),
  lastAttempt:(tradeId,idx)=>db.prepare('SELECT * FROM client_trade WHERE trade_id=? AND leg_idx=? ORDER BY attempt_no DESC LIMIT 1').get(tradeId,idx),
  unresolved:chain=>db.prepare("SELECT * FROM client_trade WHERE chain=? AND status IN('pending','signing','confirming') ORDER BY created_at").all(chain),
  quotaUsed:(account,chain='sol',at=now())=>({...used(utcDay(at),account,chain),global:globalUsed(utcDay(at),chain),rent:rentUsed(utcDay(at),account),rentGlobal:rentGlobal(utcDay(at))}),

  /**
   * A new sign attempt for a leg in awaiting_signature (Folio `reserve` with a client trade): attempt row, the leg's
   * attempt_id and, on Solana, the fee and rent reservation and the pending sponsor_send, all in one transaction.
   * Refuses SPONSOR_QUOTA_EXHAUSTED (scoped) when a cap would be passed; an exit (SELL) is never refused by the
   * per-account fee caps but is bound by the exit allowance and the whole global budget (Folio audit R9).
   */
  issue({tradeId,idx,accountId,wallet,chain,kind,payload,payloadSha256,unsignedBase64=null,lastValidBlockHeight=null,expiresAt,
   sponsor=null/* {lamports, rentLamports, idempotencyKey, exit} */}){
   return tx(db,()=>{
    const l=leg(tradeId,idx);
    if(!l||l.send_status!=='awaiting_signature')throw new TransitionRefused('leg is not awaiting a signature');
    if(db.prepare("SELECT 1 FROM client_trade WHERE trade_id=? AND leg_idx=? AND status IN('pending','signing','confirming')").get(tradeId,idx))throw new TransitionRefused('an attempt is already open');
    // Review finding 6: one trade per account holds unsigned reservations at a time. Unsigned attempts of the
    // account's other trades are abandoned with their fee and rent back (their legs keep awaiting a signature and get
    // a fresh request on replay), so replaying execute_trade cannot pin the global rent budget.
    for(const o of db.prepare("SELECT * FROM client_trade WHERE account_id=? AND trade_id<>? AND status='pending'").all(accountId,tradeId)){
     setAttempt(o.attempt_id,'pending','abandoned',{failure_reason:'SUPERSEDED_BY_NEWER_TRADE'});
     const s=send(o.attempt_id);
     if(s&&s.state==='pending'){db.prepare("UPDATE sponsor_send SET state='not_submitted',updated_at=? WHERE attempt_id=?").run(now(),o.attempt_id);refund(s)}
     recordLegEvent(db,{tradeId:o.trade_id,idx:o.leg_idx,status:leg(o.trade_id,o.leg_idx).send_status,evidence:{attempt_id:o.attempt_id,abandoned:'SUPERSEDED_BY_NEWER_TRADE'},at:now()});
    }
    const n=(db.prepare('SELECT MAX(attempt_no) AS n FROM client_trade WHERE trade_id=? AND leg_idx=?').get(tradeId,idx).n??0)+1;
    const id=attemptIdOf(tradeId,idx,n),t=now(),day=utcDay(t);
    db.prepare(`INSERT INTO client_trade(attempt_id,trade_id,leg_idx,attempt_no,account_id,wallet,chain,kind,status,payload_json,payload_sha256,unsigned_base64,last_valid_block_height,expires_at,sponsor_exit,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)`).run(id,tradeId,idx,n,accountId,wallet,chain,kind,JSON.stringify(payload),payloadSha256,unsignedBase64,lastValidBlockHeight,expiresAt,sponsor?.exit?1:0,t,t);
    if(sponsor){
     const exit=!!sponsor.exit,mine=used(day,accountId,'sol'),lam=sponsor.lamports;
     if(!Number.isSafeInteger(lam)||lam<0)throw Error('fee must be whole lamports');
     if(!exit&&mine.transactions+1>sponsorLimits.daily_transactions)throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','identity_transactions');
     if(!exit&&mine.lamports+lam>sponsorLimits.daily_lamports)throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','identity_lamports');
     if(exit&&(mine.transactions+1>ceilings.exit_identity_transactions||mine.lamports+lam>ceilings.exit_identity_lamports))throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','identity_exit');
     if(globalUsed(day,'sol')+lam>(exit?ceilings.exit_global_lamports:ceilings.entry_global_lamports))throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','global_lamports');
     if(sponsor.rentLamports>0){
      const r=rentUsed(day,accountId);
      if(r.accounts+1>sponsorLimits.daily_rent_accounts)throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','identity_rent');
      if(rentGlobal(day)+sponsor.rentLamports>sponsorLimits.global_daily_rent_lamports)throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED','global_rent');
      db.prepare('INSERT INTO sponsor_rent_day(day,account_id,accounts,lamports) VALUES(?,?,1,?) ON CONFLICT(day,account_id) DO UPDATE SET accounts=accounts+1,lamports=lamports+excluded.lamports').run(day,accountId,sponsor.rentLamports);
     }
     db.prepare('INSERT INTO sponsor_day(day,account_id,chain,transactions,lamports) VALUES(?,?,?,1,?) ON CONFLICT(day,account_id,chain) DO UPDATE SET transactions=transactions+1,lamports=lamports+excluded.lamports').run(day,accountId,'sol',lam);
     db.prepare("INSERT INTO sponsor_send(attempt_id,account_id,day,lamports,rent_lamports,idempotency_key,state,signature,updated_at) VALUES(?,?,?,?,?,?,'pending',NULL,?)")
      .run(id,accountId,day,lam,sponsor.rentLamports??0,sponsor.idempotencyKey,t);
    }
    db.prepare('UPDATE trade_legs SET attempt_id=?,sign_kind=?,updated_at=? WHERE trade_id=? AND idx=?').run(id,kind,t,tradeId,idx);
    recordLegEvent(db,{tradeId,idx,status:'awaiting_signature',evidence:{attempt_id:id,attempt_no:n,kind,expires_at:iso(expiresAt),payload_sha256:payloadSha256,
     ...(sponsor?{fee_lamports:sponsor.lamports,rent_lamports:sponsor.rentLamports??0,exit:!!sponsor.exit}:{})},at:t});
    return attempt(id);
   });
  },

  /**
   * Folio claimClientTrade: pending -> signing for the attempt and its send, awaiting_signature -> signing for the leg,
   * with the quota re-checked under the caps the reservation was admitted with. False when the attempt is not pending
   * (another submit holds or finished it). Called right before the fee payer is asked to sign.
   */
  claim(id,{lamports}={}){
   return tx(db,()=>{
    const a=attempt(id),s=send(id);
    if(!a||a.status!=='pending'||(a.chain==='sol'&&(!s||s.state!=='pending')))return false;
    if(s){
     const mine=used(s.day,s.account_id,'sol'),exit=a.sponsor_exit===1;
     if((lamports??0)>s.lamports||mine.transactions>(exit?ceilings.exit_identity_transactions:sponsorLimits.daily_transactions)
      ||mine.lamports>(exit?ceilings.exit_identity_lamports:sponsorLimits.daily_lamports)||globalUsed(s.day,'sol')>sponsorLimits.global_daily_lamports)
      throw new SponsorshipRefusal('SPONSOR_QUOTA_EXHAUSTED');
     db.prepare("UPDATE sponsor_send SET state='signing',updated_at=? WHERE attempt_id=? AND state='pending'").run(now(),id);
    }
    if(!setAttempt(id,'pending','signing'))return false;
    if(!transitionLeg(db,{tradeId:a.trade_id,idx:a.leg_idx,from:'awaiting_signature',to:'signing',evidence:{attempt_id:id,stage:'claim'},set:{updated_at:now()},at:now()}))
     throw new TransitionRefused('leg left awaiting_signature');
    return true;
   });
  },
  /** Folio finishClientSigning: the final signed bytes and their signature are committed before anything is sent. */
  finishSigning(id,{signedBase64,signature}){
   tx(db,()=>{
    const a=attempt(id);
    if(!a||a.status!=='signing'||a.signed_base64||!signedBase64||!signature)throw new TransitionRefused('relay signing conflict');
    setAttempt(id,'signing','confirming',{signed_base64:signedBase64,signature});
    db.prepare("UPDATE sponsor_send SET state='submitted',signature=?,updated_at=? WHERE attempt_id=?").run(signature,now(),id);
    db.prepare('UPDATE trade_legs SET tx_hash=?,updated_at=? WHERE trade_id=? AND idx=?').run(signature,now(),a.trade_id,a.leg_idx);
    recordLegEvent(db,{tradeId:a.trade_id,idx:a.leg_idx,status:'signing',evidence:{attempt_id:id,signed_bytes_persisted:true,tx_hash:signature},at:now()});
   });
  },
  recordSent(id){db.prepare('UPDATE client_trade SET sent_at=COALESCE(sent_at,?),resends=resends+1,updated_at=? WHERE attempt_id=?').run(now(),now(),id)},
  /** confirming -> confirmed, leg signing -> sent with the chain hash. */
  confirmed(id,{commitment}){
   return tx(db,()=>{
    const a=attempt(id);if(!a||a.status!=='confirming')return false;
    setAttempt(id,'confirming','confirmed');
    return transitionLeg(db,{tradeId:a.trade_id,idx:a.leg_idx,from:'signing',to:'sent',evidence:{attempt_id:id,tx_hash:a.signature,commitment,source:'signature_status'},set:{tx_hash:a.signature,updated_at:now()},at:now()});
   });
  },
  /**
   * The attempt ends with nothing moved. `stage`:
   *   'pending'    never claimed (paused, quota, expired before signing): attempt abandoned, quota back, leg unchanged
   *   'signing'    claimed but no bytes persisted (fee payer refused, co-sign interrupted): quota back, leg -> failed
   *   'expired'    persisted and sent, proven never landed after expiry: quota back, leg -> not_sent
   *   'chain'      landed and failed on chain: the fee was paid (quota kept), leg -> failed
   * The leg's BUY amount goes back to the daily cap in the same transaction for every ending that changes the leg.
   */
  endAttempt(id,stage,reason,extra={}){
   return tx(db,()=>{
    const a=attempt(id);if(!a)return false;
    const from={pending:'pending',signing:'signing',expired:'confirming',chain:'confirming'}[stage];
    if(a.status!==from)return false;
    if(stage==='signing'&&(a.signed_base64||a.signature))return false;
    if((stage==='expired'||stage==='chain')&&!a.signed_base64)return false;
    setAttempt(id,from,stage==='pending'?'abandoned':'failed',{failure_reason:String(reason).slice(0,200)});
    const s=send(id);
    if(s&&s.state!=='not_submitted'){db.prepare("UPDATE sponsor_send SET state='not_submitted',updated_at=? WHERE attempt_id=?").run(now(),id);if(stage!=='chain')refund(s)}
    const t=trade(a.trade_id),l=leg(a.trade_id,a.leg_idx);
    if(stage==='pending'){recordLegEvent(db,{tradeId:a.trade_id,idx:a.leg_idx,status:l.send_status,evidence:{attempt_id:id,abandoned:reason,...extra},at:now()});return true}
    const to=stage==='expired'?'not_sent':'failed';
    if(!transitionLeg(db,{tradeId:a.trade_id,idx:a.leg_idx,from:'signing',to,evidence:{attempt_id:id,reason,stage,released_raw:t.direction==='yeet'?l.amount_in_raw:null,...extra},set:{updated_at:now()},at:now()}))
     throw new TransitionRefused('leg left signing');
    releaseSpend(t,l);
    return true;
   });
  },
  /** awaiting_signature -> not_sent (window closed, paused, deadline near, operator cancel): the open attempt is
   * abandoned with its reservation, and the BUY amount goes back to the daily cap. */
  legNotSent(tradeId,idx,evidence){
   return tx(db,()=>{
    const l=leg(tradeId,idx);if(!l||l.send_status!=='awaiting_signature')return false;
    const open=db.prepare("SELECT * FROM client_trade WHERE trade_id=? AND leg_idx=? AND status IN('pending','signing','confirming')").get(tradeId,idx);
    if(open&&open.status!=='pending')return false;
    if(open){setAttempt(open.attempt_id,'pending','abandoned',{failure_reason:String(evidence.reason??'not sent').slice(0,200)});const s=send(open.attempt_id);
     if(s&&s.state==='pending'){db.prepare("UPDATE sponsor_send SET state='not_submitted',updated_at=? WHERE attempt_id=?").run(now(),open.attempt_id);refund(s)}}
    const t=trade(tradeId);
    if(!transitionLeg(db,{tradeId,idx,from:'awaiting_signature',to:'not_sent',evidence:{...evidence,released_raw:t.direction==='yeet'?l.amount_in_raw:null},set:{updated_at:now()},at:now()}))return false;
    releaseSpend(t,l);
    return true;
   });
  },
  holds:tradeId=>db.prepare('SELECT * FROM spend_hold WHERE trade_id=? ORDER BY idx').all(tradeId),
  /** Review finding 2: held BUY amounts past their deposit deadline. `statusOf(depositAddress, memo)` is the 1Click
   * status call; PENDING_DEPOSIT releases the amount to the daily cap, any other status keeps it spent and alerts, an
   * error leaves the hold for the next tick. Returns {released, kept}. */
  async releaseDue(statusOf){
   const due=db.prepare("SELECT * FROM spend_hold WHERE state='held' AND release_after<? ORDER BY release_after LIMIT 50").all(now());
   let released=0,kept=0;
   for(const h of due){
    let st;try{st=(await statusOf(h.deposit_address,h.deposit_memo??undefined))?.status}catch{continue}
    if(typeof st!=='string')continue;
    tx(db,()=>{
     if(db.prepare("UPDATE spend_hold SET state=?,oneclick_status=?,resolved_at=? WHERE trade_id=? AND idx=? AND state='held'").run(NO_DEPOSIT.includes(st)?'released':'kept',st,now(),h.trade_id,h.idx).changes!==1)return;
     if(NO_DEPOSIT.includes(st)){recordSpend(db,h.account_id,h.spent_at,-BigInt(h.amount_raw));released++}
     else kept++;
     recordLegEvent(db,{tradeId:h.trade_id,idx:h.idx,status:leg(h.trade_id,h.idx)?.send_status??'not_sent',evidence:{spend_hold:NO_DEPOSIT.includes(st)?'released':'kept',oneclick_status:st,amount_raw:h.amount_raw},at:now()});
    });
    if(!NO_DEPOSIT.includes(st))this.raiseAlert({key:`deposit_outside:${h.trade_id}:${h.idx}`,tradeId:h.trade_id,kind:'deposit_outside_pipeline',detail:{leg:h.idx,oneclick_status:st,amount_raw:h.amount_raw}});
   }
   return {released,kept};
  },
  /** Ops outbox: one row per dedup key; true when new. */
  raiseAlert({key,tradeId='-',kind,detail}){
   const fresh=db.prepare('INSERT INTO trade_alerts(dedup_key,trade_id,kind,detail_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING').run(key,tradeId,kind,JSON.stringify(detail??{}),now()).changes===1;
   if(fresh)event({event:'trade_alert',kind,key,trade:tradeId});
   return fresh;
  },
  note:(tradeId,message)=>db.prepare('UPDATE trades SET last_error=? WHERE id=?').run(String(message).slice(0,300),tradeId),
 };
}

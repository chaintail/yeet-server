// State changes of trades.status and trade_legs.send_status, each one checked against an allowed-transition table,
// written as a guarded `UPDATE ... WHERE status=?` and recorded in the append-only trade_events table in the same
// transaction. A transition to a terminal state carries evidence (the leg states, the transfer hash, the reason).
//
//   legalTransition(from,to,table)  table 'trades' (default) or 'trade_legs'; `from` null means the row is created
//   transitionTrade / transitionLeg  true when applied; false when the row was no longer in `from` (0 rows changed,
//                                    nothing written); an illegal edge or missing evidence throws TransitionRefused
import {tx} from './db.mjs';

/** trades.status: every status the tracker can fold to from each status. requote_required is a dead end. */
export const TRADE_EDGES=Object.freeze({
 [null]:['signing','requote_required'],
 signing:['submitted','settling','success','partial','refunded','failed'],
 submitted:['settling','success','partial','refunded','failed'],
 settling:['success','partial','refunded','failed'],
 // A partial trade with an unsent leg settles its other legs: still partial, or refunded/failed when none succeeded.
 partial:['refunded','failed'],
 requote_required:[],success:[],refunded:[],failed:[],
});
/** trade_legs.send_status (migration 2): queued -> sending -> sent, with failed/not_sent only before funds can move. */
export const LEG_EDGES=Object.freeze({
 [null]:['queued'],
 queued:['sending','failed','not_sent'],
 sending:['sent','failed'],
 sent:[],failed:[],not_sent:[],
});
export const TRADE_TERMINAL=Object.freeze(['requote_required','success','partial','refunded','failed']);
export const LEG_TERMINAL=Object.freeze(['sent','failed','not_sent']);

const EDGES={trades:TRADE_EDGES,trade_legs:LEG_EDGES};
export function legalTransition(from,to,table='trades'){
 const edges=EDGES[table];
 if(!edges)throw Error(`unknown table ${table}`);
 return (edges[from??null]??[]).includes(to);
}
export const evidenceRequired=(to,table='trades')=>(table==='trades'?TRADE_TERMINAL:LEG_TERMINAL).includes(to);

export class TransitionRefused extends Error{
 constructor(detail){super(`transition refused: ${detail}`);this.name='TransitionRefused';this.code='TRANSITION_REFUSED'}
}

/** Runs fn in the caller's transaction, or in a new one. */
export const atomic=(db,fn)=>db.isTransaction?fn():tx(db,fn);

function checkEvidence(table,to,evidence){
 if(!evidenceRequired(to,table))return;
 if(!evidence||typeof evidence!=='object'||!Object.keys(evidence).length)throw new TransitionRefused(`${table} -> ${to} needs evidence`);
 if(table==='trade_legs'&&to==='sent'&&!evidence.tx_hash&&!evidence.oneclick_status)throw new TransitionRefused('a sent leg needs a transfer hash or a 1Click status');
}

/** Appends one audit row. kind: 'trade' and 'leg' for transitions, 'review' for accounting flags (no status change). */
export function appendEvent(db,{tradeId,legIdx=null,kind,from=null,to,evidence=null,at}){
 db.prepare('INSERT INTO trade_events(trade_id,leg_id,kind,from_status,to_status,evidence_json,at) VALUES(?,?,?,?,?,?,?)')
  .run(tradeId,legIdx,kind,from,to,evidence===null?null:JSON.stringify(evidence),at);
}

const COLUMN=/^[a-z_]+$/;
function guarded(db,{table,status,key,keyArgs,from,to,set,at}){
 const cols=Object.keys(set);
 if(!cols.every(c=>COLUMN.test(c)))throw Error('bad column');
 const sql=`UPDATE ${table} SET ${[status,...cols].map(c=>`${c}=?`).join(',')} WHERE ${key} AND ${status}=?`;
 return db.prepare(sql).run(to,...cols.map(c=>set[c]),...keyArgs,from).changes;
}

/** trades.status from -> to, with extra columns in `set` (receipt_json, updated_at, ...). */
export function transitionTrade(db,{tradeId,from,to,evidence,set={},at}){
 if(!legalTransition(from,to,'trades'))throw new TransitionRefused(`trade ${from} -> ${to}`);
 checkEvidence('trades',to,evidence);
 return atomic(db,()=>{
  if(guarded(db,{table:'trades',status:'status',key:'id=?',keyArgs:[tradeId],from,to,set,at})!==1)return false;
  appendEvent(db,{tradeId,kind:'trade',from,to,evidence,at});
  return true;
 });
}

/** trade_legs.send_status from -> to for one leg, with extra columns in `set`. */
export function transitionLeg(db,{tradeId,idx,from,to,evidence,set={},at}){
 if(!legalTransition(from,to,'trade_legs'))throw new TransitionRefused(`leg ${from} -> ${to}`);
 checkEvidence('trade_legs',to,evidence);
 return atomic(db,()=>{
  if(guarded(db,{table:'trade_legs',status:'send_status',key:'trade_id=? AND idx=?',keyArgs:[tradeId,idx],from,to,set,at})!==1)return false;
  appendEvent(db,{tradeId,legIdx:idx,kind:'leg',from,to,evidence,at});
  return true;
 });
}

/** The audit trail of one trade, oldest first. */
export function tradeEvents(db,tradeId){
 return db.prepare('SELECT * FROM trade_events WHERE trade_id=? ORDER BY id').all(tradeId)
  .map(e=>({...e,evidence:e.evidence_json===null?null:JSON.parse(e.evidence_json)}));
}

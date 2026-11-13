// Trade accounting: the source-balance check and the ops alert outbox.
//
// Balance check. When a trade is committed (before any leg is signed) the person's source balance is read through an
// injectable chain reader: USDC on Base for YEET, each sold coin's mint on Solana for SKEET. Once the trade is final
// (receipt complete, stale, or success/refunded/failed) it is read again and the debit is compared with what the
// legs say moved: a SUCCESS leg is a certain debit, any other sent or sending leg may have come back as a refund, so
// the debit must fall in [certain - tolerance, certain + uncertain + tolerance]. Other trades of the same account and
// direction that overlap the window move the same balance: each widens the range by its own possible movement (up to
// its sent amount out, or back as a refund). A debit above the range gets a 'needs_review' row in trade_events and a
// balance_mismatch alert; the person's receipt and status are not touched. A debit below the range is an inflow (a
// deposit or a refund) and is inconclusive: the check is 'unavailable'. Only an 'ok' check with no overlapping trade
// writes the observed source movement into the receipt. A failed read is retried on later ticks, then 'unavailable'.
//
// Alerts. trade_alerts is an outbox keyed by a dedup string, one row per (kind, trade): 'stuck' (not final after
// YEET_STUCK_AFTER_MINUTES), 'stale' (tracking stopped), 'partial' (a final partial trade), 'balance_mismatch'.
// core/scripts/trade-alerts.mjs reads and acknowledges them.
import {USDC_BASE} from './signer.mjs';
import {appendEvent,atomic} from './audit.mjs';

export const BALANCE_TOLERANCE_BPS=100;
export const STUCK_AFTER_MINUTES=30;
export const MAX_READ_ATTEMPTS=5;
export const USDC_KEY=USDC_BASE.toLowerCase();

/** YEET_BALANCE_TOLERANCE_BPS (default 100) and YEET_STUCK_AFTER_MINUTES (default 30); throws on a malformed value. */
export function accountingFromEnv(env=process.env){
 const int=(name,fallback,max)=>{
  const v=env[name]===undefined||env[name]===''?fallback:Number(env[name]);
  if(!Number.isSafeInteger(v)||v<0||v>max)throw Error(`Invalid ${name}`);
  return v;
 };
 return {toleranceBps:int('YEET_BALANCE_TOLERANCE_BPS',BALANCE_TOLERANCE_BPS,10_000),stuckAfterMs:int('YEET_STUCK_AFTER_MINUTES',STUCK_AFTER_MINUTES,7*24*60)*60_000};
}

/**
 * Chain reader over the wallets.mjs balances interface (real JSON-RPC in production, fakes in tests):
 * source({chain,address,assets}) -> {assetKey: bigint raw}.
 */
export function balanceReader(balances){
 return {
  async source({chain,address,assets}){
   if(chain==='base')return {[USDC_KEY]:await balances.baseUsdc(address)};
   const held=await balances.solanaTokens(address);
   return Object.fromEntries(assets.map(a=>[a,held.filter(h=>h.mint===a).reduce((s,h)=>s+h.raw,0n)]));
  },
 };
}

const big=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,BigInt(v)]));
const str=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,String(v)]));

/** Per asset, the debit range the legs account for: {asset: {low, high}} (bigint raw). */
export function expectedDebit(legs,legAssets){
 const out={};
 for(const asset of new Set(Object.values(legAssets)))out[asset]={low:0n,high:0n};
 for(const l of legs){
  const asset=legAssets[l.idx];if(!asset)continue;
  const amt=BigInt(l.amount_in_raw);
  if(l.send_status==='sent'&&l.oneclick_status==='SUCCESS'){out[asset].low+=amt;out[asset].high+=amt}
  else if(l.send_status==='sent'||l.send_status==='sending')out[asset].high+=amt;
 }
 return out;
}

/** Compares before/after balances with the expected debit range; tolerance in bps of the upper bound (rounded up).
 * `over`: some asset lost more than the range explains; `under`: some asset lost less (an inflow). */
export function compareDebit({before,after,expected,toleranceBps=BALANCE_TOLERANCE_BPS}){
 const assets={};let ok=true,over=false,under=false;
 for(const [asset,{low,high}] of Object.entries(expected)){
  const b=before[asset]??0n,a=after[asset]??0n,debit=b-a;
  const tolerance=(high*BigInt(toleranceBps)+9_999n)/10_000n;
  const isOver=debit>high+tolerance,isUnder=debit<low-tolerance,within=!isOver&&!isUnder;
  if(!within)ok=false;
  if(isOver)over=true;
  if(isUnder)under=true;
  assets[asset]={before:String(b),after:String(a),debit:String(debit),low:String(low),high:String(high),tolerance:String(tolerance),ok:within};
 }
 return {ok,over,under,assets};
}

/** Destination amounts per leg for the receipt: quoted, minimum and settled (from 1Click /status) amounts. */
export function destinationAmounts(legs){
 return legs.map(l=>{
  let q={},r=null;
  try{q=JSON.parse(l.live_quote_json)}catch{}
  try{r=l.receipt_leg_json?JSON.parse(l.receipt_leg_json):null}catch{}
  return {index:l.idx,symbol:l.symbol,asset:q.destination?.assetId??null,decimals:q.destination?.decimals??null,
   quotedOut:q.amountOut??null,minOut:q.minAmountOut??null,settledOut:l.settled_out_raw??null,
   refunded:r?.settled?.refundedAmount??null,status:l.oneclick_status??null};
 });
}

/** Inserts an alert once per dedup key; true when it is new. */
export function raiseAlert(db,{key,tradeId,kind,detail,at}){
 return db.prepare('INSERT INTO trade_alerts(dedup_key,trade_id,kind,detail_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING')
  .run(key,tradeId,kind,JSON.stringify(detail??{}),at).changes===1;
}
/** Alerts for ops, oldest first: open ones only unless `all`. */
export function listAlerts(db,{all=false,limit=200}={}){
 return db.prepare(`SELECT * FROM trade_alerts ${all?'':'WHERE acked_at IS NULL'} ORDER BY id LIMIT ?`).all(limit)
  .map(({detail_json,...a})=>({...a,detail:JSON.parse(detail_json)}));
}
export function ackAlert(db,id,at=Date.now()){
 return db.prepare('UPDATE trade_alerts SET acked_at=? WHERE id=? AND acked_at IS NULL').run(at,id).changes===1;
}

/** Trades not final after `ageMs`: each gets one 'stuck' alert. Returns the trade ids newly alerted. */
export function sweepStuck(db,{now=Date.now(),ageMs=STUCK_AFTER_MINUTES*60_000}={}){
 const rows=db.prepare(`SELECT id,status,account_id,created_at,last_error FROM trades
   WHERE stale_at IS NULL AND created_at<=? AND (status IN('signing','submitted','settling')
    OR (status='partial' AND (receipt_json IS NULL OR json_extract(receipt_json,'$.complete')=0)))
   ORDER BY created_at`).all(now-ageMs);
 const raised=[];
 for(const t of rows){
  const legs=db.prepare('SELECT idx,send_status,oneclick_status FROM trade_legs WHERE trade_id=? ORDER BY idx').all(t.id);
  const detail={status:t.status,account_id:t.account_id,age_minutes:Math.floor((now-t.created_at)/60_000),last_error:t.last_error??null,
   legs:legs.map(l=>({idx:l.idx,send_status:l.send_status,oneclick_status:l.oneclick_status}))};
  if(raiseAlert(db,{key:`stuck:${t.id}`,tradeId:t.id,kind:'stuck',detail,at:now}))raised.push(t.id);
 }
 return raised;
}

export function createAccounting({db,chain,now=Date.now,toleranceBps=BALANCE_TOLERANCE_BPS,stuckAfterMs=STUCK_AFTER_MINUTES*60_000,maxReadAttempts=MAX_READ_ATTEMPTS,log=console.error}){
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);

 /** Reads the source balance before signing. Never throws: a failed read is recorded as unavailable. */
 async function readBefore({chain:chainName,address,legAssets}){
  const at=now();
  try{
   const before=await chain.source({chain:chainName,address,assets:[...new Set(Object.values(legAssets))]});
   return {chain:chainName,address,legAssets,before,at};
  }catch(e){
   log(JSON.stringify({event:'balance_snapshot_failed',chain:chainName,error:String(e?.message??e).slice(0,200)}));
   return {chain:chainName,address,legAssets,before:null,at};
  }
 }
 /** Stores the snapshot; call inside the transaction that commits the trade. */
 function recordSnapshot(tradeId,s){
  db.prepare('INSERT INTO trade_balance_checks(trade_id,chain,address,legs_json,before_json,before_at,verdict,detail_json) VALUES(?,?,?,?,?,?,?,?)')
   .run(tradeId,s.chain,s.address,JSON.stringify(s.legAssets),s.before?JSON.stringify(str(s.before)):null,s.at,
    s.before?'pending':'unavailable',s.before?null:JSON.stringify({reason:'balance read before signing failed'}));
 }

 /** Checks every pending trade that is final. Returns the number of checks concluded. */
 async function verifyPending(){
  const rows=db.prepare(`SELECT c.*,t.status,t.account_id,t.direction,t.receipt_json FROM trade_balance_checks c JOIN trades t ON t.id=c.trade_id
    WHERE c.verdict='pending' AND (t.stale_at IS NOT NULL OR t.status IN('success','refunded','failed')
     OR (t.receipt_json IS NOT NULL AND json_extract(t.receipt_json,'$.complete')=1)) ORDER BY c.before_at`).all();
  let done=0;
  for(const c of rows){
   const legAssets=JSON.parse(c.legs_json),before=big(JSON.parse(c.before_json));
   let after;
   try{after=await chain.source({chain:c.chain,address:c.address,assets:Object.keys(before)})}
   catch(e){
    const attempts=c.attempts+1,give=attempts>=maxReadAttempts;
    db.prepare("UPDATE trade_balance_checks SET attempts=?,verdict=?,detail_json=? WHERE trade_id=? AND verdict='pending'")
     .run(attempts,give?'unavailable':'pending',JSON.stringify({reason:'balance read after settlement failed',error:String(e?.message??e).slice(0,200)}),c.trade_id);
    if(give)done++;
    continue;
   }
   const at=now(),legs=legsOf(c.trade_id);
   const expected=expectedDebit(legs,legAssets);
   // Other trades of the same account and direction that overlap this one also move the balance: each may have debited
   // up to its sent amount inside the window, or had it refunded into the window, so it widens the range both ways.
   const overlapping=db.prepare("SELECT id FROM trades WHERE account_id=? AND direction=? AND id<>? AND status<>'requote_required' AND created_at<=? AND updated_at>=? ORDER BY created_at")
    .all(c.account_id,c.direction,c.trade_id,at,c.before_at).map(r=>r.id);
   let unknownOverlap=false;
   for(const id of overlapping){
    const o=db.prepare('SELECT address,legs_json FROM trade_balance_checks WHERE trade_id=?').get(id);
    if(!o||o.address!==c.address){unknownOverlap=true;continue}
    for(const [asset,{high}] of Object.entries(expectedDebit(legsOf(id),JSON.parse(o.legs_json)))){
     if(!expected[asset])continue;// does not touch the assets checked here
     expected[asset].low-=high;expected[asset].high+=high;
    }
   }
   const result=compareDebit({before,after,expected,toleranceBps});
   // Over the range: an unexplained debit. Under it: an inflow (deposit or refund), inconclusive, as is an overlapping
   // trade whose own legs cannot be attributed.
   const verdict=result.over?'needs_review':result.ok&&!unknownOverlap?'ok':'unavailable';
   const reason=verdict==='unavailable'?(result.under?'inflow during the trade (deposit or refund)':'overlapping movement'):undefined;
   const detail={...result,overlapping,toleranceBps,...(reason?{reason}:{})};
   const applied=atomic(db,()=>{
    if(db.prepare("UPDATE trade_balance_checks SET after_json=?,after_at=?,verdict=?,detail_json=?,attempts=attempts+1 WHERE trade_id=? AND verdict='pending'")
     .run(JSON.stringify(str(after)),at,verdict,JSON.stringify(detail),c.trade_id).changes!==1)return false;
    appendEvent(db,{tradeId:c.trade_id,kind:'review',from:c.status,to:verdict==='ok'?'balance_ok':verdict==='needs_review'?'needs_review':'balance_unavailable',evidence:detail,at});
    if(verdict==='needs_review')raiseAlert(db,{key:`balance_mismatch:${c.trade_id}`,tradeId:c.trade_id,kind:'balance_mismatch',detail,at});
    // The observed source movement goes into the receipt beside the destination amounts, only when it is this trade's
    // alone (ok, no overlapping trade); the verdict stays internal.
    const receipt=verdict==='ok'&&!overlapping.length&&c.receipt_json?JSON.parse(c.receipt_json):null;
    if(receipt){
     receipt.accounting={...receipt.accounting,source:Object.fromEntries(Object.entries(result.assets).map(([k,v])=>[k,{before:v.before,after:v.after,debit:v.debit}]))};
     db.prepare('UPDATE trades SET receipt_json=? WHERE id=?').run(JSON.stringify(receipt),c.trade_id);
    }
    return true;
   });
   if(applied){
    done++;
    if(verdict==='needs_review')log(JSON.stringify({event:'trade_needs_review',trade:c.trade_id,reason:'balance_mismatch'}));
   }
  }
  return done;
 }

 return {
  readBefore,recordSnapshot,verifyPending,
  raiseAlert:a=>raiseAlert(db,{at:now(),...a}),
  sweepStuck:()=>sweepStuck(db,{now:now(),ageMs:stuckAfterMs}),
  alerts:opts=>listAlerts(db,opts),
  ack:id=>ackAlert(db,id,now()),
  check:tradeId=>db.prepare('SELECT * FROM trade_balance_checks WHERE trade_id=?').get(tradeId),
  /** One accounting pass, run after each tracker tick: conclude final balance checks, then raise stuck alerts. */
  async tick(){
   let verified=0;
   try{verified=await verifyPending()}catch(e){log(JSON.stringify({event:'balance_check_failed',error:String(e?.message??e).slice(0,200)}))}
   return {verified,stuck:sweepStuck(db,{now:now(),ageMs:stuckAfterMs})};
  },
 };
}

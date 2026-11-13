// XP for core: ledger + streak + spin + boards, and trade settlement. On only with YEET_P2=1; state in
// $STATE_DIR/xp.sqlite (its own file, so the trade database and its migrations stay untouched).
//
// Trade XP is paid exactly once per trade: `xp_trade` (trade_id primary key) is written in the same transaction as the
// awards, and each award's dedupe key is the trade id. The tracker's onSettled hook is the normal path; trade_status
// settles too when it sees a final trade with no row yet (an event lost to a crash between the tracker's write and
// the hook), and either path repeated adds nothing.
import path from 'node:path';
import {openLedger,dayOf} from './ledger.mjs';
import {streakDays} from './streak.mjs';
import {createSpin} from './spin.mjs';
import {leaderboard} from './board.mjs';

export const p2On=(env=process.env)=>env.YEET_P2==='1';
const FINAL_LEG=new Set(['SUCCESS','REFUNDED','FAILED']);
/** A trade earns XP when at least one leg delivered. */
export const tradeEarns=status=>status==='success'||status==='partial';

/** The xp fields the pinned contract's yeet_home output schema allows (pass the resolved output schema). Its xp object
 * is closed (additionalProperties false), so a summary field the contract does not list yet would fail the connector's
 * output check and blank the card. */
export const homeXpKeys=homeOutput=>Object.freeze(Object.keys(homeOutput.properties.xp.anyOf.find(s=>s.type==='object').properties));
export const homeXp=(summary,keys)=>Object.fromEntries(keys.filter(k=>k in summary).map(k=>[k,summary[k]]));

export function openXp({file=':memory:',secret,now=Date.now}={}){
 const ledger=openLedger(file,{now});
 const db=ledger.db;
 db.exec(`CREATE TABLE IF NOT EXISTS xp_trade(
   trade_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
   points INTEGER NOT NULL, settled_at TEXT NOT NULL);`);
 const spin=createSpin({ledger,secret});
 const tradeRow=id=>db.prepare('SELECT * FROM xp_trade WHERE trade_id=?').get(id);

 /** Records a settled trade and pays its XP; a second call for the same trade returns the first result. */
 function settleTrade({tradeId,accountId,direction,status}){
  return ledger.tx(()=>{
   const prior=tradeRow(tradeId);
   if(prior)return {points:Number(prior.points),fresh:false};
   const at=ledger.iso();
   let points=0;
   if(tradeEarns(status)){
    if(direction==='yeet'){points+=ledger.awardIn(accountId,'first_yeet',tradeId,{at});points+=ledger.awardIn(accountId,'yeet_settled',tradeId,{at})}
    else if(direction==='skeet')points+=ledger.awardIn(accountId,'skeet_settled',tradeId,{at});
   }
   db.prepare('INSERT INTO xp_trade VALUES(?,?,?,?,?,?)').run(tradeId,accountId,direction,status,points,at);
   return {points,fresh:true};
  });
 }

 return {
  ledger,spin,settleTrade,
  close:()=>ledger.close(),
  /** onSettled subscriber (tracker event shape). Never throws. */
  onSettled(e){
   try{settleTrade(e)}
   catch(err){console.error(JSON.stringify({event:'xp_settle_failed',trade:e?.tradeId,error:String(err?.message??err).slice(0,200)}))}
  },
  /** A verified sign-in: once per UTC day. */
  signIn:who=>ledger.award(who,'sign_in',dayOf(ledger.iso())),
  /** trade_status's xp_award: null until the trade is final; then {points this trade earned, account total}. */
  tradeAward(who,view){
   if(view.trade_id&&!tradeRow(view.trade_id)){
    const final=['success','refunded','failed'].includes(view.status)||(view.status==='partial'&&view.legs.every(l=>FINAL_LEG.has(l.status)));
    if(!final)return null;
    settleTrade({tradeId:view.trade_id,accountId:who,direction:view.direction,status:view.status});
   }
   const row=tradeRow(view.trade_id);
   return row&&row.account_id===who?{points:Number(row.points),total:ledger.total(who)}:null;
  },
  /** The XP summary behind yeet_home's xp block (homeXp cuts it to the contract). next_streak_milestone: {days, xp} of
   * the next streak length that pays a bonus, or null when the spin is off. */
  summary(who){
   const at=ledger.iso();
   return {total:ledger.total(who),streak_days:streakDays(db,who,dayOf(at)),spin_available:spin.available(who,at),
    next_streak_milestone:spin.nextMilestone(who,at)};
  },
  /** yeet_home's recent_wins. The contract asks for {symbol, pct}; the stored data has what a leg paid and received
   * but no later price, so no gain since the buy can be stated truthfully. An empty list until a price history exists. */
  recentWins:()=>[],
  doSpin:who=>spin.spin(who),
  board:(kind,who)=>leaderboard(db,{kind,me:who,at:now()}),
 };
}

let instance;
/** The core process's XP, opened on first use from the environment. */
export function xpRuntime(env=process.env){
 return instance??=openXp({file:path.join(env.STATE_DIR||'/state','xp.sqlite'),secret:env.YEET_XP_SECRET});
}

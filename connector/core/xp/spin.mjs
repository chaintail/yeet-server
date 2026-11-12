// Daily spin: one per account per UTC day. The draw is deterministic, HMAC-SHA256(YEET_XP_SECRET, account|day) mapped
// onto a weighted bonus table, so a repeat (or a restart) can never reroll it. XP won = the daily_spin rule's base
// points + the draw + a streak bonus on milestone days. The spin is stored as that day's daily_spin xp_event row.
import {createHmac} from 'node:crypto';
import {dayOf} from './ledger.mjs';
import {streakDays,runEndingOn,addDays} from './streak.mjs';

/** Weighted draw table: 11 values from 0 to 40 XP, weights sum to 100, mean 7.52. */
export const BONUS_TABLE=Object.freeze([
 [0,23],[2,21],[5,15],[7,10],[9,8],[12,6],[15,5],[19,4],[24,2],[31,2],[40,4],
].map(([xp,weight])=>Object.freeze({xp,weight})));
/** Streak bonus: paid when the streak (counting today's spin) reaches 3 days, then on every 7th day (7, 14, 21, ...). */
export const STREAK_BONUS=25;
export const streakMilestone=days=>days===3||(days>=7&&days%7===0);

/** The draw for one seed: the first 32 bits of the HMAC as a fraction of 100, walked down the table's weights. */
export function roll(secret,seed,table=BONUS_TABLE){
 let draw=createHmac('sha256',secret).update(seed).digest().readUInt32BE(0)/2**32*100;
 for(const row of table){draw-=row.weight;if(draw<0)return row.xp}
 return 0;
}

export const nextSpinAt=day=>`${addDays(day,1)}T00:00:00.000Z`;

export function createSpin({ledger,secret}){
 const db=ledger.db;
 const todays=(who,day)=>db.prepare("SELECT points FROM xp_event WHERE identity_id=? AND event='daily_spin' AND substr(ts,1,10)=? ORDER BY ts LIMIT 1").get(who,day);
 const ready=()=>typeof secret==='string'&&secret.length>=16&&!!ledger.rule('daily_spin')?.enabled;
 return {
  ready,
  /** Whether `who` can still spin today. */
  available(who,at=ledger.iso()){return ready()&&!todays(who,dayOf(at))},
  /** Spins once per UTC day; a repeat the same day returns the stored spin. Throws when no secret is configured. */
  spin(who,at=ledger.iso()){
   if(!ready())throw Object.assign(Error('spin not configured'),{name:'TradeError',code:'TEMPORARILY_UNAVAILABLE'});
   const day=dayOf(at);
   const xp_won=ledger.tx(()=>{
    const prior=todays(who,day);
    if(prior)return Number(prior.points);
    // The spin itself is today's event, so the streak it completes is yesterday's streak plus today.
    // Other XP earned earlier today (a sign-in, a trade) already makes today active; it counts once either way.
    const days=runEndingOn(db,who,addDays(day,-1))+1;
    const base=Number(ledger.rule('daily_spin').points);
    const points=base+roll(secret,`${who}|${day}`)+(streakMilestone(days)?STREAK_BONUS:0);
    return ledger.awardIn(who,'daily_spin',day,{at,points});
   });
   return {xp_won,total:ledger.total(who),streak_days:streakDays(db,who,day),next_spin_at:nextSpinAt(day)};
  },
 };
}

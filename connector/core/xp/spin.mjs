// Daily spin: one per account per UTC day. The draw is deterministic, HMAC-SHA256(YEET_XP_SECRET, account|day) mapped
// onto a weighted bonus table, so a repeat (or a restart) can never reroll it. XP won = the daily_spin rule's base
// points + the draw + a streak bonus on milestone days. The streak bonus is the fixed XP of every STREAK_RULES row that
// fires on that streak length plus its own draw on the same table, seeded `account|day|streak` (as the contest streak spin does), so
// it is independent of the daily draw. The spin is stored as that day's daily_spin xp_event row.
import {createHmac} from 'node:crypto';
import {dayOf} from './ledger.mjs';
import {streakDays,runEndingOn,addDays} from './streak.mjs';

/** Weighted draw table: 11 values from 0 to 40 XP, weights sum to 100, mean 7.52. */
export const BONUS_TABLE=Object.freeze([
 [0,23],[2,21],[5,15],[7,10],[9,8],[12,6],[15,5],[19,4],[24,2],[31,2],[40,4],
].map(([xp,weight])=>Object.freeze({xp,weight})));
/** Streak bonus: fixed XP of each milestone (the bonus draw comes on top). */
export const STREAK_BONUS=25;
/**
 * Streak milestones, one row per rule (founder decision 2026-10-14): `days` is the first streak
 * length that pays, `repeat_every` repeats it every N days after that (null: once), `xp` is its fixed XP, `roll` adds the
 * streak draw. Combined they pay on day 3 and then every 7th day (7, 14, 21, 28, 35, ...).
 */
export const STREAK_RULES=Object.freeze([
 {days:3,repeat_every:null,xp:STREAK_BONUS,roll:true},
 {days:7,repeat_every:28,xp:STREAK_BONUS,roll:true},
 {days:14,repeat_every:28,xp:STREAK_BONUS,roll:true},
 {days:21,repeat_every:28,xp:STREAK_BONUS,roll:true},
 {days:28,repeat_every:28,xp:STREAK_BONUS,roll:true},
].map(r=>Object.freeze(r)));
const fires=(r,days)=>days===r.days||(r.repeat_every!==null&&days>r.days&&(days-r.days)%r.repeat_every===0);
/** The rules that pay on a streak of exactly `days`. */
export const streakMilestones=(days,rules=STREAK_RULES)=>rules.filter(r=>fires(r,days));
export const streakMilestone=days=>streakMilestones(days).length>0;
/** The next streak length past `days` that pays, with the fixed XP of every rule firing on it (draws excluded); null when
 * no rule can fire again. */
export function nextStreakMilestone(days,rules=STREAK_RULES){
 const at=rules.map(r=>r.days>days?r.days:r.repeat_every?r.days+Math.ceil((days+1-r.days)/r.repeat_every)*r.repeat_every:null);
 const next=Math.min(...at.filter(d=>d!==null));
 return Number.isFinite(next)?{days:next,xp:rules.reduce((sum,r,i)=>sum+(at[i]===next?r.xp:0),0)}:null;
}

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
  /** The next milestone the spin can pay. Until today's spin, today's spin is the one that extends the streak, so a
   * milestone it would reach is still ahead even when other XP already made today active. Null without a spin. */
  nextMilestone(who,at=ledger.iso()){
   if(!ready())return null;
   const day=dayOf(at);
   return nextStreakMilestone(todays(who,day)?streakDays(db,who,day):runEndingOn(db,who,addDays(day,-1)));
  },
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
    const milestones=streakMilestones(days);
    const streak=milestones.reduce((sum,r)=>sum+r.xp,0)+(milestones.some(r=>r.roll)?roll(secret,`${who}|${day}|streak`):0);
    const points=base+roll(secret,`${who}|${day}`)+streak;
    return ledger.awardIn(who,'daily_spin',day,{at,points});
   });
   return {xp_won,total:ledger.total(who),streak_days:streakDays(db,who,day),next_spin_at:nextSpinAt(day)};
  },
 };
}

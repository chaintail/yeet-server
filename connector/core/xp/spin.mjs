// Daily spin: one per account per UTC day. The draw is deterministic, HMAC-SHA256(YEET_XP_SECRET, account|day) mapped
// onto a weighted bonus table, so a repeat (or a restart) can never reroll it. XP won = the daily_spin rule's base
// points + the draw + a streak bonus on milestone days. The streak bonus is the fixed XP of every STREAK_RULES row that
// fires on that streak length plus its own draw on the same table, seeded `account|day|streak` (as the contest streak spin does), so
// it is independent of the daily draw. The spin is stored as that day's daily_spin xp_event row.
//
// Every wheel slice is one catalog meme coin (stamps.mjs stampCoins; never SOL or USDC). The coin won is a second keyed draw (`account|day|coin`), stored with the stamp
// (stamps.mjs) in the same transaction as the XP row, so a repeat returns the same coin even if the catalog changed.
import {createHmac,createHash} from 'node:crypto';
import {dayOf} from './ledger.mjs';
import {streakDays,runEndingOn,addDays} from './streak.mjs';
import {createStamps,spinStamp} from './stamps.mjs';

/** Weighted draw table: 11 values from 0 to 40 XP, weights sum to 100, mean 7.52. */
export const BONUS_TABLE=Object.freeze([
 [0,23],[2,21],[5,15],[7,10],[9,8],[12,6],[15,5],[19,4],[24,2],[31,2],[40,4],
].map(([xp,weight])=>Object.freeze({xp,weight})));
/** Streak bonus: fixed XP of each milestone (the bonus draw comes on top). */
export const STREAK_BONUS=25;
/**
 * Streak milestones, one row per rule: `days` is the first streak length that pays, `repeat_every` repeats it every N
 * days after that (null: once), `xp` is its fixed XP, `roll` adds the streak draw. Owner decision 2026-11-13:
 * the 3rd and the 7th day of every 7-day block, repeating (3, 7, 10, 14, 17, 21, 24, 28, ...). Every milestone
 * also grants one extra spin that day (SPIN_GRANT_REASONS.streak_milestone).
 */
export const STREAK_RULES=Object.freeze([
 {days:3,repeat_every:7,xp:STREAK_BONUS,roll:true},
 {days:7,repeat_every:7,xp:STREAK_BONUS,roll:true},
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

const u32=(secret,seed)=>createHmac('sha256',secret).update(seed).digest().readUInt32BE(0);
/** The draw for one seed: the first 32 bits of the HMAC as a fraction of 100, walked down the table's weights. */
export function roll(secret,seed,table=BONUS_TABLE){
 let draw=u32(secret,seed)/2**32*100;
 for(const row of table){draw-=row.weight;if(draw<0)return row.xp}
 return 0;
}

/** The day's coin: a second keyed draw, seeded `account|day|coin`, uniform over the wheel coins. */
export const rollCoin=(secret,who,day,coins)=>coins[u32(secret,`${who}|${day}|coin`)%coins.length];
/**
 * The wheel for one spin: one slice per coin (catalog order; a stored coin no longer listed is added at the end). The
 * landing slice carries the coin won and the day's draw; every other slice shows another bonus value, in an order keyed
 * on `account|day|wheel|value`, so a repeat draws the same wheel. Returns {wheel:[{coin,xp}], slice}.
 */
export function wheelFor(secret,who,day,coins,coin,draw_xp,table=BONUS_TABLE){
 const list=coins.includes(coin)?[...coins]:[...coins,coin];
 const others=[...new Set(table.map(r=>r.xp))].filter(v=>v!==draw_xp)
  .map(v=>[u32(secret,`${who}|${day}|wheel|${v}`),v]).sort((a,b)=>a[0]-b[0]).map(([,v])=>v);
 const slice=list.indexOf(coin);
 let k=0;
 return {wheel:list.map((c,i)=>({coin:c,xp:i===slice?draw_xp:others[k++%others.length]})),slice};
}

export const nextSpinAt=day=>`${addDays(day,1)}T00:00:00.000Z`;

/** Why an extra spin was granted. trade_bonus: the lucky wheel's claim (lucky.mjs; unique_ref = the lucky_id). */
export const SPIN_GRANT_REASONS=Object.freeze(['streak_milestone','trade_bonus']);
/** A grant's id is derived from its cause, so the same cause always names the same grant (and the same draws). */
export const grantId=(who,day,reason,ref)=>'g_'+createHash('sha256').update(JSON.stringify(['yeet-spin-grant',who,day,reason,String(ref)])).digest('hex').slice(0,24);
const GRANT_SCHEMA=`CREATE TABLE IF NOT EXISTS xp_spin_grant(
  id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, day TEXT NOT NULL, reason TEXT NOT NULL, unique_ref TEXT NOT NULL,
  created_at TEXT NOT NULL, used_at TEXT, UNIQUE(identity_id,reason,unique_ref));
 CREATE INDEX IF NOT EXISTS xp_spin_grant_day ON xp_spin_grant(identity_id,day,used_at);`;
const unavailable=msg=>Object.assign(Error(msg),{name:'TradeError',code:'TEMPORARILY_UNAVAILABLE'});

export function createSpin({ledger,secret,coins}){
 const db=ledger.db;
 db.exec(GRANT_SCHEMA);
 const stamps=createStamps({ledger,...(coins?{coins}:{})});
 const todays=(who,day)=>db.prepare("SELECT points FROM xp_event WHERE identity_id=? AND event='daily_spin' AND substr(ts,1,10)=? ORDER BY ts LIMIT 1").get(who,day);
 const ready=()=>typeof secret==='string'&&secret.length>=16&&!!ledger.rule('daily_spin')?.enabled&&stamps.coins.length>0;
 /** Unused grants for `day` only: a grant is good for the UTC day it names, so unused extra spins never carry over. */
 const openGrants=(who,day)=>db.prepare('SELECT id,reason FROM xp_spin_grant WHERE identity_id=? AND day=? AND used_at IS NULL ORDER BY created_at,id').all(who,day);
 /** Inside the caller's transaction: one grant per (account, reason, unique_ref), ever. Returns {id, granted}. */
 function grantSpinIn(who,day,reason,ref,at=ledger.iso()){
  if(!SPIN_GRANT_REASONS.includes(reason))throw Error(`Unknown spin grant reason ${reason}`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||ref===undefined||ref===null||String(ref)==='')throw Error('grantSpin needs a day and a unique ref');
  const id=grantId(who,day,reason,ref);
  const r=db.prepare('INSERT OR IGNORE INTO xp_spin_grant(id,identity_id,day,reason,unique_ref,created_at,used_at) VALUES(?,?,?,?,?,?,NULL)').run(id,who,day,reason,String(ref),at);
  return {id,granted:Number(r.changes)===1};
 }
 /** Spins left on `day` (1 daily spin until it is used, plus unused grants for that day) and the next extra's reason. */
 function left(who,day){
  if(!ready())return {spins_available:0,extra_spin_reason:null};
  const grants=openGrants(who,day);
  return {spins_available:(todays(who,day)?0:1)+grants.length,extra_spin_reason:grants[0]?.reason??null};
 }
 const base=()=>Number(ledger.rule('daily_spin').points);
 /** The full result of one stored spin (`key`: the day for the daily spin, the grant id for an extra one). */
 function result(who,day,key,stamp,parts){
  const seedDay=key===day?day:`${day}|${key}`;
  return {...parts,total:ledger.total(who),streak_days:streakDays(db,who,day),next_spin_at:nextSpinAt(day),
   ...wheelFor(secret,who,seedDay,stamps.coins,stamp.coin,parts.draw_xp),stamp:spinStamp(stamp),set_bonus_xp:Number(stamp.set_bonus_xp),
   stamps:stamps.list(who),sets_completed:stamps.setsCompleted(who),...left(who,day)};
 }
 /** A stored spin's XP parts: the draws are deterministic, so they are recomputed; the XP is the stored row. */
 function parts(who,day,key,reason){
  if(key===day){
   const draw_xp=roll(secret,`${who}|${day}`),won=Number(todays(who,day).points);
   return {spin_kind:'daily',spin_reason:null,xp_won:won,draw_xp,streak_xp:Math.max(0,won-base()-draw_xp)};
  }
  return {spin_kind:'extra',spin_reason:reason,xp_won:ledger.pointsFor(who,'extra_spin',key),draw_xp:roll(secret,`${who}|${day}|${key}`),streak_xp:0};
 }
 return {
  ready,stamps,
  /** {spins_available, extra_spin_reason} for `who` today. */
  left:(who,at=ledger.iso())=>left(who,dayOf(at)),
  /**
   * Grants `who` one extra spin on `day` (UTC 'YYYY-MM-DD') for `reason` (SPIN_GRANT_REASONS). `uniqueRef` names the
   * cause (a day for a streak milestone, a trade id for a future trade bonus): the same (account, reason, uniqueRef)
   * never grants twice. The spin is good only on `day`. Returns {id, granted}; granted is false for a repeat.
   */
  grantSpin:(who,day,reason,uniqueRef)=>ledger.tx(()=>grantSpinIn(who,day,reason,uniqueRef)),
  /** The next milestone the spin can pay. Until today's spin, today's spin is the one that extends the streak, so a
   * milestone it would reach is still ahead even when other XP already made today active. Null without a spin. */
  nextMilestone(who,at=ledger.iso()){
   if(!ready())return null;
   const day=dayOf(at);
   return nextStreakMilestone(todays(who,day)?streakDays(db,who,day):runEndingOn(db,who,addDays(day,-1)));
  },
  /**
   * yeet_home's xp.wheel: the [{coin, xp}] the next daily_spin call returns today, so the card can draw the slices
   * before the spin. The landing slice is not revealed. Same order of choice as spin(): today's daily spin if unused,
   * else the oldest unused extra spin, else (nothing left) the day's latest spin again. Null without a spin.
   */
  nextWheel(who,at=ledger.iso()){
   if(!ready())return null;
   const day=dayOf(at);
   const of=(key,coin)=>{
    const seedDay=key===day?day:`${day}|${key}`;
    const draw=roll(secret,key===day?`${who}|${day}`:`${who}|${day}|${key}`);
    return wheelFor(secret,who,seedDay,stamps.coins,coin??rollCoin(secret,who,seedDay,stamps.coins),draw).wheel;
   };
   if(!todays(who,day))return of(day);
   const daily=stamps.forSpin(who,day);
   if(!daily)return of(day);
   const grant=openGrants(who,day)[0];
   if(grant)return of(grant.id);
   const last=stamps.lastOn(who,day)??daily;
   return of(last.spin_key,last.coin);
  },
  /** Whether `who` can still spin today (the daily spin or an extra one). */
  available(who,at=ledger.iso()){return left(who,dayOf(at)).spins_available>0},
  /**
   * One spin: today's daily spin if unused, else the oldest unused extra spin granted for today, else (nothing left) a
   * repeat of today's latest spin, adding nothing. Each spin pays its XP and one stamp in one transaction.
   * Throws when no secret is configured.
   */
  spin(who,at=ledger.iso()){
   if(!ready())throw unavailable('spin not configured');
   const day=dayOf(at);
   // Everything below is one transaction: the XP row, the stamp, a streak grant and the grant's use stand or fall together.
   return ledger.tx(()=>{
    if(todays(who,day)){
     // A daily spin stored before stamps existed gets its stamp on its first repeat, still only once.
     if(!stamps.forSpin(who,day))return result(who,day,day,stamps.grantIn(who,day,day,rollCoin(secret,who,day,stamps.coins),at),parts(who,day,day));
     const grant=openGrants(who,day)[0];
     if(!grant){
      // Nothing left today: the latest spin again.
      const last=stamps.lastOn(who,day);
      const reason=last.spin_key===day?null:db.prepare('SELECT reason FROM xp_spin_grant WHERE id=?').get(last.spin_key)?.reason??null;
      return result(who,day,last.spin_key,last,parts(who,day,last.spin_key,reason));
     }
     // An extra spin: its own draws, keyed on the grant id; base + draw, no streak part (the daily spin carries that).
     const seedDay=`${day}|${grant.id}`;
     const draw_xp=roll(secret,`${who}|${day}|${grant.id}`);
     const xp_won=ledger.awardIn(who,'extra_spin',grant.id,{at,points:base()+draw_xp});
     if(!xp_won)throw unavailable('extra spin rule did not pay');
     if(Number(db.prepare('UPDATE xp_spin_grant SET used_at=? WHERE id=? AND used_at IS NULL').run(at,grant.id).changes)!==1)throw unavailable('grant already used');
     const stamp=stamps.grantIn(who,grant.id,day,rollCoin(secret,who,seedDay,stamps.coins),at);
     return result(who,day,grant.id,stamp,{spin_kind:'extra',spin_reason:grant.reason,xp_won,draw_xp,streak_xp:0});
    }
    // The spin itself is today's event, so the streak it completes is yesterday's streak plus today.
    // Other XP earned earlier today (a sign-in, a trade) already makes today active; it counts once either way.
    const days=runEndingOn(db,who,addDays(day,-1))+1;
    const draw_xp=roll(secret,`${who}|${day}`);
    const milestones=streakMilestones(days);
    const streak=milestones.reduce((sum,r)=>sum+r.xp,0)+(milestones.some(r=>r.roll)?roll(secret,`${who}|${day}|streak`):0);
    const xp_won=ledger.awardIn(who,'daily_spin',day,{at,points:base()+draw_xp+streak});
    // No XP row (the rule is not live yet, or capped): no stamp either; the spin is refused and nothing is written.
    if(!xp_won)throw unavailable('spin rule did not pay');
    const stamp=stamps.grantIn(who,day,day,rollCoin(secret,who,day,stamps.coins),at);
    // A streak milestone also grants one extra spin for today.
    if(milestones.length)grantSpinIn(who,day,'streak_milestone',day,at);
    // draw_xp: the landing slice's value (xp_won = base + draw_xp + streak_xp); streak_xp: the milestone bonus including
    // its own draw, shown apart. set_bonus_xp: XP this spin's stamp paid by completing a card (0 otherwise), not in xp_won.
    return result(who,day,day,stamp,{spin_kind:'daily',spin_reason:null,xp_won,draw_xp,streak_xp:streak});
   });
  },
 };
}

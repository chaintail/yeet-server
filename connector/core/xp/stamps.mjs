// Coin stamps: every daily spin lands on one wheel slice, each slice is one tradable catalog coin, and the spin adds one
// stamp of that coin to the account. A card has STAMP_SLOTS slots; the stamp that fills a card completes a set, which is
// recorded once (xp_stamp_set) and pays SET_COMPLETE_XP once through the ledger's set_completed rule. The count keeps
// going into the next card: card = floor(count/7)+1, progress = count%7.
//
// Stamps are only written by grantIn, which spin.mjs calls inside the same transaction as the spin's xp_event row
// (daily_spin or extra_spin), so a spin can never pay XP without its stamp, and xp_stamp_spin (one row per spin: the day
// for the daily spin, the grant id for an extra spin) makes a replay return the stored stamp instead of adding another. A coin that later leaves the catalog keeps its stored count and is
// still listed (after the catalog coins). The lucky wheel's claim (lucky.mjs) also calls grantIn, keyed on the lucky_id,
// in the same transaction as its spin grant.
import {tradable} from '../coins.mjs';
/** XP paid once per completed card (a set), on top of that day's spin; the set_completed rule's default points. */
export {SET_COMPLETE_XP} from './ledger.mjs';

export const STAMP_SLOTS=7;

/** The wheel coins: the server's tradable Solana catalog meme coins, in catalog order. Owner rule: every slice of the
 * daily wheel is a meme coin, so SOL (and USDC) are never slices and never stamped by a spin (they stay tradable). */
export const stampCoins=(entries=tradable())=>Object.freeze(entries.filter(e=>e.kind==='meme').map(e=>e.symbol));

const SCHEMA=`CREATE TABLE IF NOT EXISTS xp_stamp(
  identity_id TEXT NOT NULL, coin TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>=0),
  first_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(identity_id,coin));
 CREATE TABLE IF NOT EXISTS xp_stamp_spin(
  identity_id TEXT NOT NULL, spin_key TEXT NOT NULL, day TEXT NOT NULL, coin TEXT NOT NULL,
  count_after INTEGER NOT NULL CHECK(count_after>0), set_bonus_xp INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL,
  PRIMARY KEY(identity_id,spin_key));
 CREATE INDEX IF NOT EXISTS xp_stamp_spin_day ON xp_stamp_spin(identity_id,day,ts);
 CREATE TABLE IF NOT EXISTS xp_stamp_set(
  identity_id TEXT NOT NULL, coin TEXT NOT NULL, card INTEGER NOT NULL CHECK(card>0), bonus_xp INTEGER NOT NULL,
  ts TEXT NOT NULL, PRIMARY KEY(identity_id,coin,card));`;

/** One stamps-list entry for a stored count. */
export const stampCard=(coin,count)=>({coin,count,slots:STAMP_SLOTS,card:Math.floor(count/STAMP_SLOTS)+1,
 progress:count%STAMP_SLOTS,complete:count>=STAMP_SLOTS});
/** The spin's own stamp: the card it landed on and how many of that card's slots are now filled (1..7). */
export const spinStamp=row=>{
 const n=Number(row.count_after);
 return {coin:row.coin,count_after:n,slots:STAMP_SLOTS,card:Math.ceil(n/STAMP_SLOTS),filled:(n-1)%STAMP_SLOTS+1,
  set_completed:n%STAMP_SLOTS===0};
};

export function createStamps({ledger,coins=stampCoins()}){
 const db=ledger.db;
 db.exec(SCHEMA);
 const spinRow=(who,key)=>db.prepare('SELECT spin_key,coin,count_after,set_bonus_xp FROM xp_stamp_spin WHERE identity_id=? AND spin_key=?').get(who,key);
 return {
  coins,
  /** The stamp one spin gave (`key`: the day for the daily spin, the grant id for an extra spin), or undefined. */
  forSpin:spinRow,
  /** The latest stamp a spin gave `who` on `day`, or undefined. A lucky-wheel stamp (key `l_...`, lucky.mjs) is not a
   * spin and is skipped. */
  lastOn:(who,day)=>db.prepare("SELECT spin_key,coin,count_after,set_bonus_xp FROM xp_stamp_spin WHERE identity_id=? AND day=? AND spin_key NOT LIKE 'l\\_%' ESCAPE '\\' ORDER BY ts DESC,rowid DESC LIMIT 1").get(who,day),
  /** Inside the caller's transaction: one stamp of `coin` for the spin `key` on `day`, once. A repeat returns the stored row. */
  grantIn(who,key,day,coin,at){
   const prior=spinRow(who,key);
   if(prior)return prior;
   db.prepare(`INSERT INTO xp_stamp(identity_id,coin,count,first_at,updated_at) VALUES(?,?,1,?,?)
    ON CONFLICT(identity_id,coin) DO UPDATE SET count=count+1,updated_at=excluded.updated_at`).run(who,coin,at,at);
   const count=Number(db.prepare('SELECT count FROM xp_stamp WHERE identity_id=? AND coin=?').get(who,coin).count);
   let bonus=0;
   if(count%STAMP_SLOTS===0){
    const card=count/STAMP_SLOTS;
    bonus=ledger.awardIn(who,'set_completed',`${coin}|${card}`,{at});
    db.prepare('INSERT INTO xp_stamp_set(identity_id,coin,card,bonus_xp,ts) VALUES(?,?,?,?,?)').run(who,coin,card,bonus,at);
   }
   db.prepare('INSERT INTO xp_stamp_spin(identity_id,spin_key,day,coin,count_after,set_bonus_xp,ts) VALUES(?,?,?,?,?,?,?)').run(who,key,day,coin,count,bonus,at);
   return spinRow(who,key);
  },
  /** Every catalog coin in catalog order (zero counts included), then any stored coin no longer in the catalog. */
  list(who){
   const stored=db.prepare('SELECT coin,count FROM xp_stamp WHERE identity_id=? ORDER BY first_at,coin').all(who);
   const counts=new Map(stored.map(r=>[r.coin,Number(r.count)]));
   return [...coins,...stored.map(r=>r.coin).filter(c=>!coins.includes(c))].map(c=>stampCard(c,counts.get(c)??0));
  },
  setsCompleted:who=>Number(db.prepare('SELECT COUNT(*) n FROM xp_stamp_set WHERE identity_id=?').get(who).n),
 };
}

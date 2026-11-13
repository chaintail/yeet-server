// The lucky wheel (yeet-win docs/WHEEL-CARD.md "Server additions needed"). Owner rules: the lucky wheel has 5 hot
// coins; the person spins it; it lands on one coin; if they YEET at least LUCKY_USDC into that coin, they get one bonus
// spin of the daily wheel (grantSpin 'trade_bonus', unique per lucky_id) plus one stamp of that coin. Nothing else.
//
// - One lucky wheel per account per UTC day: lucky_id = 'l_' + HMAC(secret, account|day|lucky-id), stored with its
//   five coins the first time lucky_wheel is asked that day, so the wheel never changes once shown.
// - Hot coins: the catalog's meme coins, ranked per UTC day by HMAC(secret, day|hot|coin) (the same ranking for every
//   account), keeping only coins 1Click can quote now (availability.mjs), the first LUCKY_SLICES of them.
// - The slice is the server's draw, HMAC(secret, account|day|lucky) mod the wheel size, stored on the first lucky_spin;
//   a repeat returns the stored slice.
// - yeet_propose with lucky_id links the proposal to the wheel (xp_lucky_proposal). When a linked trade has its leg
//   into the landed coin at SUCCESS with at least LUCKY_USDC in, the claim runs once in one transaction: claimed_at is
//   set, grantSpin(account, settle day, 'trade_bonus', lucky_id) and one stamp of the coin (stamp key = lucky_id).
import {createHmac} from 'node:crypto';
import {dayOf} from './ledger.mjs';
import {nextSpinAt} from './spin.mjs';
import {tradable} from '../coins.mjs';
import {parseUnits} from '../trade/router.mjs';

export const LUCKY_SLICES=5;
export const LUCKY_USDC='5';
const LUCKY_RAW=parseUnits(LUCKY_USDC,6);
export const LUCKY_ID=/^l_[a-z0-9]{8,40}$/;

/** The lucky wheel's candidate coins: the server's Solana catalog meme coins, catalog order. */
export const luckyCoins=(entries=tradable())=>Object.freeze(entries.filter(e=>e.kind==='meme').map(e=>e.symbol));
const mac=(secret,seed)=>createHmac('sha256',secret).update(seed).digest();
export const luckyIdFor=(secret,who,day)=>'l_'+mac(secret,`${who}|${day}|lucky-id`).toString('hex').slice(0,24);
/** The day's ranking of `coins`, hottest first: the same for every account on one UTC day. */
export const hotRanking=(secret,day,coins)=>[...coins].map(c=>[mac(secret,`${day}|hot|${c}`).readUInt32BE(0),c]).sort((a,b)=>a[0]-b[0]||(a[1]<b[1]?-1:1)).map(([,c])=>c);
export const luckySlice=(secret,who,day,n)=>mac(secret,`${who}|${day}|lucky`).readUInt32BE(0)%n;

const SCHEMA=`CREATE TABLE IF NOT EXISTS xp_lucky(
  lucky_id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, day TEXT NOT NULL, wheel_json TEXT NOT NULL,
  slice INTEGER, coin TEXT, spun_at TEXT, created_at TEXT NOT NULL,
  claimed_at TEXT, claim_trade_id TEXT, grant_id TEXT, UNIQUE(identity_id,day));
 CREATE TABLE IF NOT EXISTS xp_lucky_proposal(
  proposal_id TEXT PRIMARY KEY, lucky_id TEXT NOT NULL, identity_id TEXT NOT NULL, created_at TEXT NOT NULL);`;
const fail=(code,msg)=>Object.assign(Error(msg),{name:'TradeError',code});

export function createLucky({ledger,secret,spin,coins=luckyCoins()}){
 const db=ledger.db;
 db.exec(SCHEMA);
 const byId=id=>db.prepare('SELECT * FROM xp_lucky WHERE lucky_id=?').get(id);
 const view=r=>({lucky:{lucky_id:r.lucky_id,wheel:JSON.parse(r.wheel_json).map(coin=>({coin})),slice:r.slice===null?null:Number(r.slice),
  amount_usdc:LUCKY_USDC,claimed:r.claimed_at!==null,expires_at:nextSpinAt(r.day)}});
 /** The caller's own lucky wheel row, or INVALID_ARGUMENT (unknown and someone else's read the same). */
 const own=(who,id)=>{const r=typeof id==='string'&&LUCKY_ID.test(id)?byId(id):undefined;if(!r||r.identity_id!==who)throw fail('INVALID_ARGUMENT','unknown lucky_id');return r};
 const ready=()=>spin.ready();
 return {
  coins,
  /** Today's lucky wheel for `who`; created on the first call of the day from `available(coins)` (async, 1Click). */
  async wheel(who,available,at=ledger.iso()){
   if(!ready())throw fail('TEMPORARILY_UNAVAILABLE','lucky wheel not configured');
   const day=dayOf(at),id=luckyIdFor(secret,who,day);
   const stored=byId(id);
   if(stored)return view(stored);
   const ok=new Set(await available(coins));
   const wheel=hotRanking(secret,day,coins).filter(c=>ok.has(c)).slice(0,LUCKY_SLICES);
   if(wheel.length<2)throw fail('TEMPORARILY_UNAVAILABLE','not enough tradeable coins');
   db.prepare('INSERT OR IGNORE INTO xp_lucky(lucky_id,identity_id,day,wheel_json,slice,coin,spun_at,created_at) VALUES(?,?,?,?,NULL,NULL,NULL,?)')
    .run(id,who,day,JSON.stringify(wheel),at);
   return view(byId(id));
  },
  /** lucky_spin: the server's slice, drawn and stored once; a repeat returns it. Only today's wheel can be spun. */
  spin(who,id,at=ledger.iso()){
   if(!ready())throw fail('TEMPORARILY_UNAVAILABLE','lucky wheel not configured');
   return ledger.tx(()=>{
    const r=own(who,id);
    if(r.slice!==null)return view(r);
    if(r.day!==dayOf(at))throw fail('INVALID_ARGUMENT','lucky wheel expired');
    const wheel=JSON.parse(r.wheel_json),slice=luckySlice(secret,who,r.day,wheel.length);
    db.prepare('UPDATE xp_lucky SET slice=?,coin=?,spun_at=? WHERE lucky_id=? AND slice IS NULL').run(slice,wheel[slice],at,id);
    return view(byId(id));
   });
  },
  /** yeet_propose with lucky_id: the wheel must be the caller's, spun, and from today. Throws INVALID_ARGUMENT. */
  check(who,id,at=ledger.iso()){
   const r=own(who,id);
   if(r.slice===null)throw fail('INVALID_ARGUMENT','lucky wheel not spun');
   if(r.day!==dayOf(at))throw fail('INVALID_ARGUMENT','lucky wheel expired');
   return view(r);
  },
  /** Records that `proposalId` was proposed for the lucky wheel `id` (first link wins; a repeat adds nothing). */
  link(who,id,proposalId,at=ledger.iso()){
   own(who,id);
   db.prepare('INSERT OR IGNORE INTO xp_lucky_proposal(proposal_id,lucky_id,identity_id,created_at) VALUES(?,?,?,?)').run(proposalId,id,who,at);
  },
  /** Whether a proposal carries a lucky wheel (cheap check before reading the trade). */
  linked:proposalId=>!!db.prepare('SELECT 1 FROM xp_lucky_proposal WHERE proposal_id=?').get(proposalId),
  /**
   * A trade of `who` for `proposalId` reached `view` (trade_status shape: direction, legs[{symbol,status,amount_in}]).
   * Claims once when the BUY leg into the landed coin is SUCCESS with amount_in >= LUCKY_USDC. Returns
   * {claimed, fresh, grant}: fresh is true only for the call that claimed.
   */
  settle(who,proposalId,view,at=ledger.iso()){
   return ledger.tx(()=>{
    const link=db.prepare('SELECT * FROM xp_lucky_proposal WHERE proposal_id=? AND identity_id=?').get(proposalId,who);
    if(!link)return {claimed:false,fresh:false};
    const r=byId(link.lucky_id);
    if(!r||r.identity_id!==who||r.slice===null)return {claimed:false,fresh:false};
    if(r.claimed_at!==null)return {claimed:true,fresh:false};
    if(view?.direction!=='yeet')return {claimed:false,fresh:false};
    const leg=(view.legs??[]).find(l=>l.symbol===r.coin&&l.status==='SUCCESS');
    let raw=0n;try{raw=leg?parseUnits(String(leg.amount_in),6):0n}catch{raw=0n}
    if(raw<LUCKY_RAW)return {claimed:false,fresh:false};
    const day=dayOf(at);
    if(Number(db.prepare('UPDATE xp_lucky SET claimed_at=?,claim_trade_id=? WHERE lucky_id=? AND claimed_at IS NULL').run(at,view.trade_id??null,r.lucky_id).changes)!==1)
     return {claimed:true,fresh:false};
    const grant=spin.grantSpin(who,day,'trade_bonus',r.lucky_id);
    db.prepare('UPDATE xp_lucky SET grant_id=? WHERE lucky_id=?').run(grant.id,r.lucky_id);
    spin.stamps.grantIn(who,r.lucky_id,day,r.coin,at);
    return {claimed:true,fresh:true,grant};
   });
  },
  /** A stored lucky wheel by id for its owner (tests, ops). */
  get:(who,id)=>view(own(who,id)),
 };
}

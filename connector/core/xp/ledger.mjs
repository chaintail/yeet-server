// XP ledger: rules (`xp_rule`) say what an event is worth and how often it may pay; every award is one `xp_event` row.
// Caps (per UTC day and for life, counted per rule and account) and dedupe are checked in the same transaction as the
// insert, so a replayed or concurrent award adds nothing. Points are XP only: no money, no prizes.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

/** XP for completing a stamp card (7 stamps of one coin). Modest: below first_yeet (50), above the streak bonus (25). */
export const SET_COMPLETE_XP=30;

export const XP_EVENTS=Object.freeze(['sign_in','first_yeet','yeet_settled','skeet_settled','daily_spin','set_completed']);

/** Default rules, written on first open only (an operator may edit the rows later; a restart never overwrites them).
 * daily_spin's points are the base of a spin; spin.mjs adds the draw and the streak bonus to that event's row.
 * set_completed pays once per filled stamp card (stamps.mjs; its key is coin|card). */
export const DEFAULT_RULES=Object.freeze([
 {rule_id:'sign_in',event:'sign_in',points:5,per_day_cap:1,lifetime_cap:null,title:'Sign in'},
 {rule_id:'first_yeet',event:'first_yeet',points:50,per_day_cap:null,lifetime_cap:1,title:'First YEET'},
 {rule_id:'yeet_settled',event:'yeet_settled',points:20,per_day_cap:5,lifetime_cap:null,title:'YEET settled'},
 {rule_id:'skeet_settled',event:'skeet_settled',points:10,per_day_cap:5,lifetime_cap:null,title:'SKEET settled'},
 {rule_id:'daily_spin',event:'daily_spin',points:5,per_day_cap:1,lifetime_cap:null,title:'Daily spin'},
 {rule_id:'set_completed',event:'set_completed',points:SET_COMPLETE_XP,per_day_cap:null,lifetime_cap:null,title:'Stamp set completed'},
].map(r=>Object.freeze(r)));

const SCHEMA=`CREATE TABLE IF NOT EXISTS xp_rule(
  rule_id TEXT PRIMARY KEY, event TEXT NOT NULL, points INTEGER NOT NULL CHECK(points>0),
  per_day_cap INTEGER, lifetime_cap INTEGER, starts_at TEXT NOT NULL, ends_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'server', title TEXT NOT NULL, route TEXT);
 CREATE TABLE IF NOT EXISTS xp_event(
  id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, event TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL, points INTEGER NOT NULL, ts TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS xp_event_person_rule ON xp_event(identity_id,rule_id,ts);
 CREATE INDEX IF NOT EXISTS xp_event_ts ON xp_event(ts);`;

export const dayOf=iso=>iso.slice(0,10);

/** Opens the ledger on a file path, ':memory:' or an open DatabaseSync. `now()` returns epoch ms. */
export function openLedger(target,{now=Date.now}={}){
 const owned=typeof target==='string';
 const db=owned?new DatabaseSync(target,{defensive:true,allowExtension:false,timeout:2000}):target;
 if(owned&&target!==':memory:')db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 db.exec('PRAGMA busy_timeout=2000;'+SCHEMA);
 const seed=db.prepare(`INSERT OR IGNORE INTO xp_rule(rule_id,event,points,per_day_cap,lifetime_cap,starts_at,ends_at,enabled,source,title,route)
  VALUES(?,?,?,?,?,'1970-01-01T00:00:00.000Z',NULL,1,'server',?,NULL)`);
 for(const r of DEFAULT_RULES)seed.run(r.rule_id,r.event,r.points,r.per_day_cap,r.lifetime_cap,r.title);

 const iso=()=>new Date(now()).toISOString();
 const count=(who,rule,day)=>Number((day===undefined
  ?db.prepare('SELECT COUNT(*) n FROM xp_event WHERE identity_id=? AND rule_id=?').get(who,rule)
  :db.prepare('SELECT COUNT(*) n FROM xp_event WHERE identity_id=? AND rule_id=? AND substr(ts,1,10)=?').get(who,rule,day)).n);
 const live=(r,at)=>r.starts_at<=at&&(r.ends_at===null||at<r.ends_at);

 /** Inside the caller's transaction: every enabled, live rule for `event` that is not capped and has not already paid
  * for this `key` adds one row. `points` (optional) replaces the rule's points for this award (the spin). Returns the
  * points added. */
 function awardIn(who,event,key,{at=iso(),points}={}){
  if(!XP_EVENTS.includes(event))throw Error(`Unknown XP event ${event}`);
  let added=0;
  for(const r of db.prepare('SELECT * FROM xp_rule WHERE event=? AND enabled=1 ORDER BY rule_id').all(event)){
   if(!live(r,at))continue;
   const dedupe=JSON.stringify([r.rule_id,who,event,String(key)]);
   if(db.prepare('SELECT 1 FROM xp_event WHERE dedupe_key=?').get(dedupe))continue;
   if(r.lifetime_cap!==null&&count(who,r.rule_id)>=r.lifetime_cap)continue;
   if(r.per_day_cap!==null&&count(who,r.rule_id,dayOf(at))>=r.per_day_cap)continue;
   const p=Number.isSafeInteger(points)&&points>0?points:Number(r.points);
   db.prepare('INSERT INTO xp_event(id,identity_id,event,dedupe_key,rule_id,points,ts) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),who,event,dedupe,r.rule_id,p,at);
   added+=p;
  }
  return added;
 }
 /** Runs fn in BEGIN IMMEDIATE ... COMMIT; nested calls join the outer transaction. */
 let depth=0;
 function tx(fn){
  if(depth)return fn();
  db.exec('BEGIN IMMEDIATE');depth++;
  try{const out=fn();depth--;db.exec('COMMIT');return out}
  catch(e){depth--;try{db.exec('ROLLBACK')}catch{}throw e}
 }
 const total=who=>Number(db.prepare('SELECT COALESCE(SUM(points),0) t FROM xp_event WHERE identity_id=?').get(who).t);

 return {
  db,tx,awardIn,total,iso,
  /** One award in its own transaction; returns the points added (0 when capped, deduped or no rule). */
  award:(who,event,key,opts)=>tx(()=>awardIn(who,event,key,opts)),
  /** Sum of the rows one dedupe key produced for an event (e.g. a trade id). */
  pointsFor(who,event,key){
   let n=0;
   for(const r of db.prepare('SELECT rule_id FROM xp_rule WHERE event=?').all(event))
    n+=Number(db.prepare('SELECT COALESCE(SUM(points),0) p FROM xp_event WHERE dedupe_key=?').get(JSON.stringify([r.rule_id,who,event,String(key)])).p);
   return n;
  },
  rule:id=>db.prepare('SELECT * FROM xp_rule WHERE rule_id=?').get(id),
  close(){if(owned)db.close()},
 };
}

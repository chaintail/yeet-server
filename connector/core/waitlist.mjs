// The limited-beta waitlist (YEET_BETA_USER_CAP, identity-store.mjs betaFull), in identities.sqlite beside the
// accounts. The "beta is full" page (as/beta-full.mjs) posts the email here through the core; nothing is sent to the
// person (no confirmation email). ops/waitlist-export.mjs prints the count and writes the rows to a CSV file.
//
//   waitlist(email)   one row per address, lowercased; the FIRST join stands (a second join changes nothing)
//     created_at      ms
//     source          'chatgpt' (the page shown inside the ChatGPT connect flow) or 'web' (the YEET sign-in page)
//
// Created with CREATE TABLE IF NOT EXISTS when first used: no migration step.
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
let db;
function database(){
 if(db)return db;
 db=new DatabaseSync(path.join(process.env.STATE_DIR||'/state','identities.sqlite'),{defensive:true,allowExtension:false,timeout:2000});
 db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS waitlist(email TEXT PRIMARY KEY,created_at INTEGER NOT NULL,source TEXT NOT NULL CHECK(source IN ('chatgpt','web'))) STRICT;");
 return db;
}
/** The "beta is full" page with the waitlist form, on the sign-in server (as/beta-full.mjs). */
export const WAITLIST_PATH='/account/waitlist';
/** <origin>/account/waitlist?from=<source> when the origin is plain https; null otherwise (no link is handed out). */
export function waitlistUrlFor(origin,source='chatgpt'){
 try{
  const u=new URL(WAITLIST_PATH,origin);
  u.searchParams.set('from',source);
  return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=500?u.href:null;
 }catch{return null}
}
export const WAITLIST_SOURCES=Object.freeze(['chatgpt','web']);
export class WaitlistError extends Error{constructor(code){super(code);this.name='WaitlistError';this.code=code}}
// One address: a local part and a domain with at least one dot and a 2+ letter last label. No spaces, quotes, angle
// brackets, commas or semicolons (the CSV export and any later mail tool get a plain address).
const EMAIL=/^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;
/** The address as stored (trimmed, lowercased), or null when it is not one. */
export function waitlistEmail(value){
 if(typeof value!=='string')return null;
 const v=value.trim().toLowerCase();
 if(v.length>254||!EMAIL.test(v)||v.includes('..')||v.startsWith('.')||v.split('@')[0].endsWith('.'))return null;
 return v;
}
/** Adds the address once. {email, fresh}: fresh is false when it was already on the list (nothing changes then).
 *  Throws WaitlistError INVALID_EMAIL or INVALID_SOURCE. */
export function joinWaitlist({email,source},{now=Date.now()}={}){
 const e=waitlistEmail(email);
 if(!e)throw new WaitlistError('INVALID_EMAIL');
 if(!WAITLIST_SOURCES.includes(source))throw new WaitlistError('INVALID_SOURCE');
 const out=database().prepare('INSERT INTO waitlist VALUES(?,?,?) ON CONFLICT(email) DO NOTHING').run(e,now,source);
 return {email:e,fresh:out.changes===1};
}
export function waitlistCount(){return database().prepare('SELECT COUNT(*) n FROM waitlist').get().n}
/** Every row, oldest first: {email, created_at, source}. */
export function waitlistRows(){return database().prepare('SELECT email,created_at,source FROM waitlist ORDER BY created_at,email').all().map(r=>({email:r.email,created_at:r.created_at,source:r.source}))}

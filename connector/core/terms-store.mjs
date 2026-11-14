// Terms acceptances and the win code, per account, in identities.sqlite beside the accounts (identity-store.mjs).
//
//   terms_acceptances(account_id, version)   one row per account and version; the FIRST acceptance stands (a retry,
//                                            a second tab or a second conversation returns the same moment).
//     statements   JSON array of the statement ids the person confirmed
//     accepted_at  ms
//     source       'chat' (yeet_accept_terms), 'page' (/account/terms, signed in) or 'terms-link' (/account/terms
//                  through the account's signed link with no sign-in: the required statements only)
//     client_id    the OAuth client the call came through (chat); 'terms-page' (the page, signed in) or 'terms-link'
//                  (the page, through the account's signed link with no sign-in)
//     session      ChatGPT's anonymized conversation id (_meta["openai/session"]) when it sent one, else NULL
//   terms_links_used(token_id)               the id of a terms link token that recorded (or met) an acceptance: a
//                                            link is used once. Rows older than a day are dropped (a token lives
//                                            10 minutes).
//   referrals(account_id)                    the win code: applied once (stands), or skipped (may still be applied).
//
// Both tables are created with CREATE TABLE IF NOT EXISTS when the core starts: no migration step. Accounts that
// passed the old connect-page checkboxes have no row here and are asked like everyone else.
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {validAccount} from './identity-store.mjs';
let db;
function database(){
 if(db)return db;
 db=new DatabaseSync(path.join(process.env.STATE_DIR||'/state','identities.sqlite'),{defensive:true,allowExtension:false,timeout:2000});
 db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS terms_acceptances(account_id TEXT NOT NULL,version TEXT NOT NULL,statements TEXT NOT NULL,accepted_at INTEGER NOT NULL,source TEXT NOT NULL,client_id TEXT,session TEXT,PRIMARY KEY(account_id,version)) STRICT; CREATE TABLE IF NOT EXISTS terms_links_used(token_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,used_at INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS referrals(account_id TEXT PRIMARY KEY,code TEXT,status TEXT NOT NULL,decided_at INTEGER NOT NULL) STRICT;");
 return db;
}
const row=r=>r?{account_id:r.account_id,version:r.version,statements:JSON.parse(r.statements),accepted_at:r.accepted_at,source:r.source,client_id:r.client_id,session:r.session}:null;
/** The account's acceptance of one version, or null. */
export function acceptanceOf(accountId,version){
 if(!validAccount(accountId))return null;
 return row(database().prepare('SELECT * FROM terms_acceptances WHERE account_id=? AND version=?').get(accountId,version));
}
export const TERMS_SOURCES=Object.freeze(['chat','page','terms-link']);
const TOKEN_ID=/^[A-Za-z0-9_-]{16,32}$/;
/**
 * Marks a terms link token used. Returns true the first time, false when that id was used before (by any account).
 * Throws on a malformed id.
 */
export function useTermsLink(tokenId,accountId,{now=Date.now()}={}){
 if(typeof tokenId!=='string'||!TOKEN_ID.test(tokenId))throw Error('Invalid token id');
 if(!validAccount(accountId))throw Error('Invalid account');
 const conn=database();
 conn.prepare('DELETE FROM terms_links_used WHERE used_at<?').run(now-24*3600_000);
 return conn.prepare('INSERT OR IGNORE INTO terms_links_used VALUES(?,?,?)').run(tokenId,accountId,now).changes===1;
}
/** Records an acceptance; the first one for (account, version) stands. Returns {record, fresh}. */
export function recordAcceptance({accountId,version,statements,source,clientId=null,session=null,now=Date.now()}){
 if(!validAccount(accountId))throw Error('Invalid account');
 if(!TERMS_SOURCES.includes(source))throw Error('Invalid source');
 const s=typeof session==='string'&&session.length>=1&&session.length<=200?session:null;
 const c=typeof clientId==='string'&&clientId.length>=1&&clientId.length<=2048?clientId:null;
 const r=database().prepare('INSERT OR IGNORE INTO terms_acceptances VALUES(?,?,?,?,?,?,?)').run(accountId,version,JSON.stringify(statements),now,source,c,s);
 return {record:acceptanceOf(accountId,version),fresh:r.changes===1};
}
export const DEFAULT_CODE='WIN';
/** The win code screen's rule (the connect page it came from): 1 to 16 of A-Z0-9, case folded. Otherwise null. */
export function referralCode(value){
 if(typeof value!=='string')return null;
 const code=value.trim().toUpperCase();
 return /^[A-Z0-9]{1,16}$/.test(code)?code:null;
}
/** {status: open|applied|skipped, code, default_code}. */
export function referralOf(accountId){
 const r=validAccount(accountId)?database().prepare('SELECT code,status FROM referrals WHERE account_id=?').get(accountId):null;
 return {status:r?r.status:'open',code:r?.status==='applied'?r.code:null,default_code:DEFAULT_CODE};
}
/** Applies a code (once: an applied code stands) or records a skip (never over an applied code). */
export function decideReferral(accountId,{code=null,skip=false},{now=Date.now()}={}){
 if(!validAccount(accountId))throw Error('Invalid account');
 const conn=database();
 conn.exec('BEGIN IMMEDIATE');
 try{
  const prior=conn.prepare('SELECT status FROM referrals WHERE account_id=?').get(accountId);
  if(prior?.status!=='applied'){
   if(code)conn.prepare('INSERT INTO referrals VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET code=excluded.code,status=excluded.status,decided_at=excluded.decided_at').run(accountId,code,'applied',now);
   else if(skip&&!prior)conn.prepare('INSERT INTO referrals VALUES(?,?,?,?)').run(accountId,null,'skipped',now);
  }
  conn.exec('COMMIT');
 }catch(e){conn.exec('ROLLBACK');throw e}
 return referralOf(accountId);
}

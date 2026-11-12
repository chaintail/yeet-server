// One-time confirm codes (port plan 2.3). A code is 32 random bytes in base64url (43 characters); only its SHA-256 is
// stored, bound to account, client, proposal, revision and a hash of the quoted legs, for 120 s. A code is used once:
// presenting a used code again returns the trade it started (the request-ledger replay pattern).
import {randomBytes,createHash} from 'node:crypto';
import {refuse,iso} from './util.mjs';

export const CONFIRM_TTL_MS=120_000;
const CODE_RE=/^[A-Za-z0-9_-]{43}$/;
const hash=code=>createHash('sha256').update(code,'utf8').digest('hex');

export function createConfirmCodes({db,now=Date.now,ttlMs=CONFIRM_TTL_MS,random=randomBytes}){
 return {
  /** A new code for (account, client, proposal, revision, quote hash). Returns the card-only `_meta` value. */
  mint({accountId,clientId,proposalId,revision,quoteSha}){
   const code=random(32).toString('base64url'),expires=now()+ttlMs;
   db.prepare('INSERT INTO confirm_codes(code_sha256,proposal_id,revision,account_id,client_id,quote_sha256,expires_at,used_at,trade_id) VALUES(?,?,?,?,?,?,?,NULL,NULL)')
    .run(hash(code),proposalId,revision,accountId,clientId,quoteSha,expires);
   return {code,expires_at:iso(expires)};
  },
  /**
   * The code's row when it belongs to this account, client, proposal and revision; CONFIRMATION_REQUIRED otherwise.
   * A used code is returned as is (the caller replays its trade); an unused, expired code is refused.
   */
  check({code,accountId,clientId,proposalId,revision}){
   if(typeof code!=='string'||!CODE_RE.test(code))refuse('CONFIRMATION_REQUIRED','malformed code');
   const row=db.prepare('SELECT * FROM confirm_codes WHERE code_sha256=?').get(hash(code));
   if(!row)refuse('CONFIRMATION_REQUIRED','unknown code');
   if(row.account_id!==accountId||row.client_id!==clientId)refuse('CONFIRMATION_REQUIRED','code bound to another account or client');
   if(row.proposal_id!==proposalId||row.revision!==revision)refuse('CONFIRMATION_REQUIRED','code bound to another proposal or revision');
   if(row.used_at!==null)return {...row,used:true};
   if(row.expires_at<=now())refuse('CONFIRMATION_REQUIRED','code expired');
   return {...row,used:false};
  },
  /** Marks an unused code used by `tradeId`. Must run inside the caller's transaction. False when another tap won. */
  consume({code,tradeId}){
   return db.prepare('UPDATE confirm_codes SET used_at=?,trade_id=? WHERE code_sha256=? AND used_at IS NULL').run(now(),tradeId,hash(code)).changes===1;
  },
 };
}

// One-time confirm codes (port plan 2.3). A code is 32 random bytes in base64url (43 characters); only its SHA-256 is
// stored, bound to account, client, proposal, revision and a hash of the quoted legs, for 120 s. A code is used once:
// presenting a used code again returns the trade it started (the request-ledger replay pattern). At most one unused
// code per proposal is live: minting a new one (propose replayed with the same request_id, yeet_quote, a requote)
// expires the earlier ones. Minting is rate limited per account (YEET_CODE_MINT_LIMIT per 10 minutes, default 20).
//
// Threat model, stated plainly. The code travels in the tool result's `_meta`, which the card reads and the connector
// strips from the model-visible content. That the model (or anything acting for it) cannot read `_meta` is a property
// of the host, not of this server: it is documented for ChatGPT, and must be confirmed in the live host test. If a
// host does expose `_meta`, the code stops separating "the person tapped" from "the model called execute_trade",
// because a caller that can see it can also mint a fresh one by re-proposing. Either way the damage is bounded
// server-side by the per-trade and daily USDC caps, the per-coin minimum, the cost ceiling, the requote rule, the
// own-wallet recipient check, and the kill switch: a code can only move the person's own funds into the coins they
// proposed, to their own wallet.
import {randomBytes,createHash} from 'node:crypto';
import {refuse,iso} from './util.mjs';
import {tx} from './db.mjs';

export const CONFIRM_TTL_MS=120_000;
export const MINT_WINDOW_MS=10*60_000;
export const MINT_LIMIT=20;
const CODE_RE=/^[A-Za-z0-9_-]{43}$/;
const hash=code=>createHash('sha256').update(code,'utf8').digest('hex');

export function createConfirmCodes({db,now=Date.now,ttlMs=CONFIRM_TTL_MS,random=randomBytes,mintLimit=MINT_LIMIT,windowMs=MINT_WINDOW_MS}){
 const mintedRecently=(accountId,t)=>db.prepare('SELECT count(*) n FROM confirm_codes WHERE account_id=? AND minted_at>?').get(accountId,t-windowMs).n;
 /** TEMPORARILY_UNAVAILABLE (retryable, nothing traded) when the account minted mintLimit codes in the window. */
 const checkRate=(accountId,t=now())=>{if(mintedRecently(accountId,t)>=mintLimit)refuse('TEMPORARILY_UNAVAILABLE','confirm code rate limit')};
 return {
  checkRate,
  /**
   * A new code for (account, client, proposal, revision, quote hash); every earlier unused code of the proposal expires
   * now. Returns the card-only `_meta` value. `rateLimited: false` only for the requote answer, which follows a used code.
   */
  mint({accountId,clientId,proposalId,revision,quoteSha},{rateLimited=true}={}){
   const code=random(32).toString('base64url'),t=now(),expires=t+ttlMs;
   tx(db,()=>{
    if(rateLimited)checkRate(accountId,t);
    db.prepare('UPDATE confirm_codes SET expires_at=? WHERE proposal_id=? AND used_at IS NULL AND expires_at>?').run(t,proposalId,t);
    db.prepare('INSERT INTO confirm_codes(code_sha256,proposal_id,revision,account_id,client_id,quote_sha256,expires_at,used_at,trade_id,minted_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,?)')
     .run(hash(code),proposalId,revision,accountId,clientId,quoteSha,expires,t);
   });
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
  /** Marks an unused, unexpired code used by `tradeId`. Must run inside the caller's transaction. False when another
   * tap won or the code expired meanwhile (the caller's re-check then refuses it). */
  consume({code,tradeId}){
   const t=now();// expiry is enforced here too: execute awaits balances and live quotes between check and consume
   return db.prepare('UPDATE confirm_codes SET used_at=?,trade_id=? WHERE code_sha256=? AND used_at IS NULL AND expires_at>?').run(t,tradeId,hash(code),t).changes===1;
  },
 };
}

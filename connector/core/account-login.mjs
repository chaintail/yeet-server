// What the cards need to know about the connected account's sign-in, for the one-time device check in the trade card
// (yeet-win docs/CARDS.md "The device check"): the Privy user id, the email a code can be sent to, a masked form of it
// to show, and whether the account came through Google or Apple. It rides in card-only `_meta["yeet/account"]`; the
// model never reads it.
//
// A code can be emailed only to an address that is a linked `email` account of the Privy user: the card's code login
// (js-sdk-core, existing users only) finds the user by that linked account. An address known only from a Google or
// Apple account is NOT such an account (Privy's documentation describes no merging by address and no server call that
// links an email without a code), so for those accounts `email` is null and the trade finishes on the YEET page.
import {createPrivyApi,privyConfig} from './trade/privy-api.mjs';
import {mintLinkToken,HINT_LINK_TTL_S} from '#shared/link-token.mjs';
/** l•••@c•••.xyz: the first letter of the name and of the domain, the last label kept. */
export function maskEmail(email){
 const m=typeof email==='string'?/^([^\s@])[^\s@]*@([^\s@.])[^\s@]*\.([^\s@.]+)$/.exec(email):null;
 return m?`${m[1]}•••@${m[2]}•••.${m[3]}`:null;
}
/** From a Privy user (GET /v1/users/{did}): {user, email, masked, google, apple}. */
export function loginFacts(user){
 const accounts=Array.isArray(user?.linked_accounts)?user.linked_accounts:[];
 const email=accounts.find(a=>a?.type==='email'&&typeof a.address==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address))?.address??null;
 return {user:typeof user?.id==='string'?user.id:null,email,masked:maskEmail(email),google:accounts.some(a=>a?.type==='google_oauth'),apple:accounts.some(a=>a?.type==='apple_oauth')};
}
/** The sign-in methods a Privy user actually has, in page order (google, apple, email), from loginFacts. */
export const methodsOf=facts=>facts?[...(facts.google?['google']:[]),...(facts.apple?['apple']:[]),...(facts.email?['email']:[])]:[];
/**
 * The signed hint an account-bound page link carries (shared/link-token.mjs, purpose `hint`): the account id and the
 * methods its Privy user has. The funding and trade pages then show only those methods and refuse any other account.
 * Null when the methods are not known (Privy did not answer) or there is no key: no link is handed out then.
 */
export function hintFor(accountId,facts,{key,now=Date.now()}={}){
 const m=methodsOf(facts);
 if(!key||!m.length)return null;
 try{return mintLinkToken(key,{purpose:'hint',account:accountId,ttl:HINT_LINK_TTL_S,claims:{m},now})}catch{return null}
}
// An account WITH an email login keeps it (a person may link at most one email, Privy linking-accounts): 10 minutes.
// An account without one can gain it on the YEET page (the optional "confirm your email once" step after a Google or
// Apple trade): the page tells the server at once (lookup.forget), and the answer is kept for one minute only, so the
// card's emailed code starts working for that person even when that notice is lost.
const TTL_MS=10*60_000,NO_EMAIL_TTL_MS=60_000,MAX=2000;
/** lookup(did) -> loginFacts or null (never throws: the card then falls back to its own check). Cached (see above).
 *  lookup.forget(did) drops the cached answer.
 *  lookup.peek(did) answers at once: the cached facts while they are fresh, else null, and then starts one read in
 *  the background (one at a time per user) so the next peek has them. For answers that are asked every few seconds
 *  (trade_status while a card follows a trade): they never wait for Privy. */
export function createAccountLogin({env=process.env,fetch=globalThis.fetch,api,now=Date.now}={}){
 const cache=new Map(),reading=new Set();
 const config=api?null:privyConfig(env);
 const client=api??(config?createPrivyApi({config,fetch,timeoutMs:4000}):null);
 const known=did=>!!client&&typeof did==='string'&&/^did:privy:[A-Za-z0-9_-]{1,128}$/.test(did);
 const fresh=did=>{const hit=cache.get(did);return hit&&now()-hit.at<(hit.value.email?TTL_MS:NO_EMAIL_TTL_MS)?hit.value:null};
 async function lookup(did){
  if(!known(did))return null;
  const hit=fresh(did);
  if(hit)return hit;
  try{
   const value=loginFacts(await client.app('GET',`/v1/users/${did}`));
   cache.set(did,{at:now(),value});if(cache.size>MAX)cache.delete(cache.keys().next().value);
   return value;
  }catch{return null}
 }
 lookup.forget=did=>{cache.delete(did)};
 lookup.peek=did=>{
  if(!known(did))return null;
  const hit=fresh(did);
  if(hit)return hit;
  if(!reading.has(did)){reading.add(did);lookup(did).finally(()=>reading.delete(did))}
  return null;
 };
 return lookup;
}
/**
 * The basket card's answers (yeet_propose, skeet_propose, yeet_quote) with the same card-only facts as the overview,
 * as `card_account` (the connector moves it to `_meta["yeet/account"]` and never shows it to the model). The basket
 * holds the YEET / SKEET button, so it is the card that meets the first trade on a device: with the facts it emails
 * the code (an account with an email login) or hands the trade to the YEET page (Google or Apple). Only when Privy
 * answered: with no facts the answer is returned as it is and the card keeps its own step. The facts are read while
 * the handler runs; they never delay a refusal and never fail the call.
 *   withCardAccount({lookup: () => lookup function, didOf: ctx => did or null})(handler) -> handler
 *
 * `wait: false` (trade_status, which a card asks every few seconds while it follows a trade): only facts that are
 * already known are added (lookup.peek), so the answer never waits for Privy. That is how a card that is following a
 * trade learns that the person confirmed their email on the YEET page meanwhile: the page's notice drops the cached
 * facts, the next status answer starts a fresh read, and the one after it carries the email.
 *
 * `hint: (ctx, facts) => token or null` adds `card_hint`: the signed hint for the trade page link (hintFor). The
 * connector puts it on the card-only signer's page address; the model never reads it. `account: false` adds only the
 * hint (execute_trade and submit_trade_signature: their card already holds the account facts).
 */
export function withCardAccount({lookup,didOf,wait=true,hint=null,account:withAccount=true}){
 const facts=async ctx=>{
  try{
   const did=didOf(ctx),login=did?(wait?await lookup()(did):lookup().peek(did)):null;
   if(!login)return null;
   let token=null;
   try{token=hint?hint(ctx,login):null}catch{token=null}
   return {account:withAccount?{user:did,email:login.email,masked:login.masked,google:login.google===true,apple:login.apple===true,wallets:[]}:null,hint:typeof token==='string'?token:null};
  }catch{return null}
 };
 return fn=>async(e,ctx,a,q)=>{
  const reading=facts(ctx),out=await fn(e,ctx,a,q),known=await reading;
  if(!known||!out||typeof out!=='object'||Array.isArray(out))return out;
  return {...out,...(known.account?{card_account:known.account}:{}),...(known.hint?{card_hint:known.hint}:{})};
 };
}

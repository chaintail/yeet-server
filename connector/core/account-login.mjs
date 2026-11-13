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
const TTL_MS=10*60_000,MAX=2000;
/** lookup(did) -> loginFacts or null (never throws: the card then falls back to its own check). Cached 10 minutes. */
export function createAccountLogin({env=process.env,fetch=globalThis.fetch,api,now=Date.now}={}){
 const cache=new Map();
 const config=api?null:privyConfig(env);
 const client=api??(config?createPrivyApi({config,fetch,timeoutMs:4000}):null);
 return async function lookup(did){
  if(!client||typeof did!=='string'||!/^did:privy:[A-Za-z0-9_-]{1,128}$/.test(did))return null;
  const hit=cache.get(did);
  if(hit&&now()-hit.at<TTL_MS)return hit.value;
  try{
   const value=loginFacts(await client.app('GET',`/v1/users/${did}`));
   cache.set(did,{at:now(),value});if(cache.size>MAX)cache.delete(cache.keys().next().value);
   return value;
  }catch{return null}
 };
}

// Account-bound pages. A funding or trade page link that the core minted for the account connected to ChatGPT
// carries a signed hint (shared/link-token.mjs, purpose `hint`): the account id and the sign-in methods that
// account's Privy user has. What the sign-in server does with it, in one place:
//
//   - the page offers ONLY those methods (data-methods); with NO hint on the link, the default ones (login-methods.mjs);
//   - a hint that was SUPPLIED but does not verify (expired, altered, another purpose) is never dropped in favour of
//     whatever session the browser holds: the page and its routes answer EXPIRED_LINK_LINE and stop. The binding
//     fails closed;
//   - nothing is ever created from such a page: the person who signs in is looked up (core /identity/lookup, which
//     never creates an account), never resolved;
//   - after the sign-in the server compares the account behind the signed-in Privy user with the hint's account.
//     Another account, or a Privy user with no YEET account, is refused with MISMATCH_LINE and a way to try again.
//     The refusal says nothing about the right account (not its methods, not its address): whoever holds a link has
//     not shown that the account is theirs. No account is linked, switched or changed.
//
// The hint is not a credential. It decides which buttons show and which account the page is for; every money route
// still asks for the person's own verified Privy token.
import {html} from './auth-pages.mjs';
import {knownMethods} from './login-methods.mjs';

export const MISMATCH_CODE='ACCOUNT_MISMATCH';
export const MISMATCH_LINE='This is a different YEET account than the one in your ChatGPT.';
export const EXPIRED_CODE='LINK_EXPIRED';
export const EXPIRED_LINK_LINE='This link has expired. Go back to ChatGPT and ask for a new one.';
/**
 * hintReader(verify) -> read. verify(text): the claims of a valid `hint` token ({a, m}) or null.
 *   read(text)        -> {token, account, methods} or null
 *   read.state(value) -> {supplied, hint}: `supplied` is true when the link or the form carried the parameter at all
 *                        (any value, also an empty or repeated one). supplied with hint null means: refuse.
 * A hint with no known method is no hint.
 */
export function hintReader(verify){
 const read=text=>{
  if(typeof text!=='string'||!text)return null;
  let claims=null;
  try{claims=verify(text)}catch{claims=null}
  if(!claims)return null;
  const methods=knownMethods(claims.m);
  return methods.length?{token:text,account:claims.a,methods}:null;
 };
 read.state=value=>({supplied:value!==undefined&&value!==null,hint:read(value)});
 return read;
}
/** A reader for a server with no hints: nothing supplied is fine, anything supplied is refused. */
export const NO_HINTS=hintReader(()=>null);
const samePath=v=>typeof v==='string'&&/^\/[A-Za-z0-9/_?&=.~%-]*$/.test(v)&&!v.startsWith('//')?v:null;
/** The refusal as a page body: the one line and one button to try again. `retry`: a same-origin path. */
export function mismatchBody({retry}={}){
 const safe=samePath(retry);
 return `<p class="notice" role="alert">${html(MISMATCH_LINE)}</p><p>Nothing was changed.</p>${safe?`<a class="button" href="${html(safe)}">Try again</a>`:''}`;
}
/** A link whose token or hint no longer verifies: one plain state, nothing else on the page. */
export const expiredBody=()=>`<p class="notice" role="alert">${html(EXPIRED_LINK_LINE)}</p>`;
/**
 * The person IS the link's account, but this browser holds a YEET session of another account. Nothing is replaced
 * until they press the button: the form posts the same sign-in again with `switch=yes`.
 * fields: [name, value] pairs to post again (csrf, next, hint, the credential).
 */
export const SWITCH_LABEL='Switch to the account in your ChatGPT';
export function switchBody({fields}){
 const hidden=fields.filter(([,v])=>typeof v==='string'&&v).map(([k,v])=>`<input type="hidden" name="${html(k)}" value="${html(v)}">`).join('');
 return `<p class="lead">This browser is using another YEET account.</p><p>Switch to use this link. Nothing else changes.</p><form method="POST" action="/account/login">${hidden}<input type="hidden" name="switch" value="yes"><button type="submit">${html(SWITCH_LABEL)}</button></form>`;
}

// ---- The way back from Google or Apple for a sign-in that started on a bound page --------------------------------
// The provider returns to ONE fixed address with no query (Privy matches allowed redirect addresses exactly, and a
// hint is different in every link): BOUND_RETURN_PATH. Nothing but a bound sign-in ever returns there, so a request
// for it IS a bound return. What it is bound to is kept by the SERVER'S cookie, set when the bound page was served:
// httpOnly, SameSite=Lax, 15 minutes, holding the destination and the signed hint itself (so nothing is trusted from
// it that the signature does not cover). When the return arrives and that cookie is missing, stale or altered, the
// answer is the expired state and nothing else: never the ordinary sign-in, which could create an account.
export const BOUND_RETURN_PATH='/account/login/bound';
export const BOUND_COOKIE='yeet_bound';
export const BOUND_COOKIE_AGE=900;
/** The cookie's value for a destination and a verified hint. */
export const boundCookieValue=(next,hint)=>`${next}.${hint.token}`;
/**
 * What a return is bound to, from the request's Cookie header.
 *   readHint: hintReader(...)      allowed(next): the destinations a hint may ride to
 * -> {next, hint} or null (no cookie, an unknown destination, or a hint that does not verify now).
 */
export function readBoundCookie(header,readHint,allowed){
 const raw=typeof header==='string'?header.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${BOUND_COOKIE}=`))?.slice(BOUND_COOKIE.length+1):undefined;
 if(!raw||raw.length>600)return null;
 const dot=raw.indexOf('.'),next=dot>0?raw.slice(0,dot):'',hint=dot>0?readHint(raw.slice(dot+1)):null;
 return hint&&allowed(next)?{next,hint}:null;
}

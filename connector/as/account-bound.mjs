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

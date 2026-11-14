// Account-bound pages. A funding or trade page link that the core minted for the account connected to ChatGPT
// carries a signed hint (shared/link-token.mjs, purpose `hint`): the account id and the sign-in methods that
// account's Privy user has. What the sign-in server does with it, in one place:
//
//   - the page offers ONLY those methods (data-methods); with no valid hint, the default ones (login-methods.mjs);
//   - nothing is ever created from such a page: the person who signs in is looked up (core /identity/lookup, which
//     never creates an account), never resolved;
//   - after the sign-in the server compares the account behind the signed-in Privy user with the hint's account.
//     Another account, or a Privy user with no YEET account, is refused with MISMATCH_LINE, the right method with
//     its address masked (useLine), and a way to try again. No account is linked, switched or changed.
//
// The hint is not a credential. It decides which buttons show and which account the page is for; every money route
// still asks for the person's own verified Privy token.
import {html} from './auth-pages.mjs';
import {knownMethods} from './login-methods.mjs';

export const MISMATCH_CODE='ACCOUNT_MISMATCH';
export const MISMATCH_LINE='This is a different YEET account than the one in your ChatGPT.';
export const EXPIRED_LINK_LINE='This link is too old to use. Go back to ChatGPT and open it again.';
const joinOr=words=>words.length<2?words.join(''):`${words.slice(0,-1).join(', ')} or ${words.at(-1)}`;
const MASKED=/^[^\s@<>]•••@[^\s@.<>]•••\.[^\s@.<>]{1,24}$/;
const label=v=>typeof v==='string'&&MASKED.test(v)?v:null;
/**
 * "Use Google (g•••@g•••.com)." from the methods of the right account and the masked address behind each
 * ({google, apple, email}, core /account/sign-in). An address is shown only in its masked form; without one the
 * method alone is named. Null when no method is known.
 */
export function useLine({methods,labels={}}={}){
 const parts=knownMethods(methods).map(m=>{
  const at=label(labels?.[m]);
  if(m==='email')return at?`the email ${at}`:'the email you joined YEET with';
  return `${m==='google'?'Google':'Apple'}${at?` (${at})`:''}`;
 });
 return parts.length?`Use ${joinOr(parts)}.`:null;
}
/**
 * hintReader(verify) -> text => {token, account, methods} or null.
 * verify(text): the claims of a valid `hint` token ({a, m}) or null (shared/link-token.mjs verifyLinkToken).
 * A hint with no known method is no hint.
 */
export function hintReader(verify){
 return text=>{
  if(typeof text!=='string'||!text)return null;
  let claims=null;
  try{claims=verify(text)}catch{claims=null}
  if(!claims)return null;
  const methods=knownMethods(claims.m);
  return methods.length?{token:text,account:claims.a,methods}:null;
 };
}
/**
 * expectedReader(core) -> async hint => {message, use}: what to tell a person who is not the hint's account.
 * core(route, account) -> {status, body}. The methods come from Privy through the core when it answers, else from
 * the hint itself (no address then).
 */
export function expectedReader(core){
 return async hint=>{
  let facts=null;
  try{const {status,body}=await core('/account/sign-in',hint.account);if(status===200&&body?.known===true)facts=body}catch{facts=null}
  const methods=facts&&knownMethods(facts.methods).length?facts.methods:hint.methods;
  return {message:MISMATCH_LINE,use:useLine({methods,labels:facts?.labels??{}})};
 };
}
/** The refusal as a page body: the line, the right method, one button to try again. `retry`: a same-origin path. */
export function mismatchBody({use,retry}){
 const safe=typeof retry==='string'&&/^\/[A-Za-z0-9/_?&=.~%-]*$/.test(retry)&&!retry.startsWith('//')?retry:null;
 return `<p class="notice" role="alert">${html(MISMATCH_LINE)}</p>${use?`<p class="lead">${html(use)}</p>`:''}<p>Nothing was changed.</p>${safe?`<a class="button" href="${html(safe)}">Try again</a>`:''}`;
}

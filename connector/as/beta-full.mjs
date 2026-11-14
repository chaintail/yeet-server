// The "beta is full" page (YEET_BETA_USER_CAP, core/identity-store.mjs betaFull): what a person WITHOUT a YEET account
// sees at sign-up while every beta spot is taken, on the web sign-in page and in the ChatGPT connect flow alike. It is
// the ordinary sign-in page (auth-pages.mjs document, the same card, fields and buttons) with the waitlist form:
// one email field, one button, the line back to the sign-in for people who already have an account.
//
// Where it is shown:
//   - the sign-in pages ask Privy to sign in existing users only while the beta is full (identity-config `signup`;
//     login/src.jsx), so Privy creates no user there; a refusal for an unknown person, or Privy's own user limit
//     (max_accounts_reached), sends the page here (data-full on the sign-in field);
//   - the server's own check: a sign-in whose identity has no account while the beta is full is answered with this
//     page (web /account/login, ChatGPT /interaction/:uid) or BETA_FULL (/account/wallets), and no account or wallet
//     is created (core /identity/resolve);
//   - a ChatGPT tool call with no account behind it: BETA_FULL with this page's address (core.mjs, mcp/errors.mjs).
//
// The form: the same cookie-and-field CSRF check as the sign-in form, the exact origin, a per-address rate limit. The
// address goes to the core (core/waitlist.mjs): validated, lowercased, kept once. No email is sent to anyone.
import {html} from './auth-pages.mjs';
import {randomBytes} from 'node:crypto';
import {WAITLIST_PATH} from '../core/waitlist.mjs';
export {WAITLIST_PATH};
export const BETA_FULL_TITLE='The beta is full';
export const BETA_FULL_LINE='YEET is in a limited beta and every spot is taken right now. Leave your email and we will tell you when new spots open.';
export const WAITLIST_BUTTON='Join the waitlist';
export const WAITLIST_DONE='You are on the list. We will email you when a spot opens.';
export const WAITLIST_COOKIE='yeet_waitlist';
const BAD_EMAIL='Enter your email address, like name@example.com.';
const NOT_SAVED='That could not be saved just now. Try again in a moment.';
const TOO_MANY='Too many tries from here. Try again in a minute.';
/** Where "Sign in" goes back to: the connect flow's own page, or the web sign-in. Anything else is the web sign-in. */
export function backPath(value){
 return typeof value==='string'&&/^\/interaction\/[A-Za-z0-9_-]{1,128}$/.test(value)?value:'/account/login';
}
export const sourceOf=value=>value==='chatgpt'?'chatgpt':'web';
/** The page's address for one entry path: ?from=chatgpt|web, and the page to sign in on. */
export function betaFullHref({source='web',back}={}){
 const p=new URLSearchParams({from:sourceOf(source)});
 const b=backPath(back);
 if(b!=='/account/login')p.set('back',b);
 return `${WAITLIST_PATH}?${p}`;
}
const signInLine=back=>`<p class="hint">Already have an account? <a href="${html(backPath(back))}">Sign in</a></p>`;
/** The page body: the line, the email field, Join the waitlist, and the way back to the sign-in. */
export function betaFullBody({csrf,source='web',back,email='',error=''}){
 return `<form method="POST" action="${WAITLIST_PATH}" data-yeet-waitlist><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="source" value="${sourceOf(source)}"><input type="hidden" name="back" value="${html(backPath(back))}"><p class="lead">${html(BETA_FULL_LINE)}</p><label for="waitlist-email">Email</label><input id="waitlist-email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" required value="${html(email)}"${error?' aria-invalid="true"':''}>${error?`<p class="notice" role="alert">${html(error)}</p>`:''}<button type="submit">${html(WAITLIST_BUTTON)}</button>${signInLine(back)}</form>`;
}
/** After the form: the same answer whether the address was new or already on the list. */
export const waitlistDoneBody=back=>`<p class="lead" role="status">${html(WAITLIST_DONE)}</p>${signInLine(back)}`;
/**
 * app: the sign-in server. document(res,title,body): the page (authDocument). cookie(res,name,value,age). equal: the
 * constant-time compare. originOK(q). formBody: the urlencoded parser. core(body): POST to core /waitlist ->
 * {status, body}. limit(q): true when this address may post now (rate limit per client address).
 * Returns send(res, {source, back, status}): the page as the answer of a refused sign-in.
 */
export function betaFullRoutes(app,{document,cookie,equal,originOK,formBody,core,limit}){
 const sealed=r=>r.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
 const page=(r,{status=200,...fields})=>{
  const c=randomBytes(24).toString('hex');
  cookie(r,WAITLIST_COOKIE,c,1800);
  sealed(r).status(status).type('html').send(document(r,BETA_FULL_TITLE,betaFullBody({csrf:c,...fields})));
 };
 app.get(WAITLIST_PATH,(q,r)=>page(r,{source:q.query.from,back:q.query.back}));
 app.post(WAITLIST_PATH,formBody,async(q,r)=>{
  const source=sourceOf(q.body?.source),back=backPath(q.body?.back);
  if(!limit(q))return sealed(r).set('Retry-After','60').status(429).type('html').send(document(r,BETA_FULL_TITLE,`<p class="notice" role="alert">${html(TOO_MANY)}</p>${signInLine(back)}`));
  const c=q.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(`${WAITLIST_COOKIE}=`))?.slice(WAITLIST_COOKIE.length+1);
  if(!c||!equal(c,q.body?.csrf)||!originOK(q))return r.sendStatus(403);
  const email=typeof q.body?.email==='string'?q.body.email.slice(0,320):'';
  let status=503,body=null;
  try{({status,body}=await core({email,source}))}catch{}
  if(status===200){cookie(r,WAITLIST_COOKIE,'',0);return sealed(r).type('html').send(document(r,BETA_FULL_TITLE,waitlistDoneBody(back)))}
  if(status===400&&(body?.error==='INVALID_EMAIL'||body?.error==='INVALID_SOURCE'))return page(r,{status:400,source,back,email:email.slice(0,254),error:BAD_EMAIL});
  page(r,{status:503,source,back,email:email.slice(0,254),error:NOT_SAVED});
 });
 return (r,{source,back,status=403}={})=>page(r,{status,source,back});
}

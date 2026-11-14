// The YEET terms as a first-party page at /account/terms: every statement of the current version with its link and a
// checkbox, one Accept button. It records the SAME versioned acceptance as yeet_accept_terms (core terms_acceptances,
// source 'page'). Structure after Folio's consent screen (chaintail/stock-app ConsentScreen.kt / ConsentText.kt): each
// line names what the person agrees to and links the document; the required boxes gate the button; one optional
// product-email line that is never ticked for the person; the server checks again.
//
// It is the reliable fallback for the in-chat flow: with YEET_TERMS_MODE=page the TERMS_REQUIRED result tells the
// assistant and the cards to send the person here. With the default (chat) the page still works when opened.
//
// The account's own link (docs/TERMS-IN-CHAT.md "The link that needs no sign-in"). The link the core gives ChatGPT
// is /account/terms?t=<token>: a signed token (shared/link-token.mjs) for purpose `terms`, bound to the account and
// the terms version, good for 10 minutes. With a valid one this page shows the statements, each with its link, and
// ONE Accept button at once, records the acceptance for that account (source `terms-link`: the required statements
// only, never the optional product-email choice) and ends on "go back to ChatGPT". The token does nothing else: this
// page sets no cookie and opens no session for it, and no other route reads it. It is used once: the core marks its
// id with the acceptance, and a second Accept with it records nothing ("You already accepted"). An expired or altered
// token, or one for another terms version, shows "This link has expired…" unless the link also carries a valid hint
// for the account, in which case that account (and only that account) may sign in. It never falls back to whatever
// session the browser holds.
import {html} from './auth-pages.mjs';
import {NO_HINTS,expiredBody,mismatchBody} from './account-bound.mjs';
export const TERMS_PATH='/account/terms';
export const TERMS_NEXT='terms';
export const TERMS_TITLE='YEET terms';
/** The id of one terms link token (claim `j`): the core marks it used with the acceptance. */
export const TOKEN_ID=/^[A-Za-z0-9_-]{16,32}$/;
const safeUrl=u=>typeof u==='string'&&/^https:\/\/[^\s"<>]{1,500}$/.test(u)?u:null;
/** The page body. terms: the contract `terms` object from core. */
export function termsBody({csrf,terms,error=''}){
 if(terms.accepted)return `<p class="lead">You accepted the YEET terms (version ${html(terms.version)}).</p><p>Go back to ChatGPT and carry on.</p>`;
 const rows=terms.statements.map(s=>{
  const url=safeUrl(s.url);
  return `<label><input type="checkbox" name="agree_${html(s.id)}" value="yes"${s.required?' required':''}> <span>${html(s.text)}${s.required?'':' (optional)'}${url?` <a href="${html(url)}" target="_blank" rel="noopener">Read</a>`:''}</span></label>`;
 }).join('');
 return `<form method="POST" data-yeet-agreements><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="version" value="${html(terms.version)}"><p class="lead">Open each link, then agree.</p><fieldset class="agreements"><legend>Version ${html(terms.version)}</legend>${rows}</fieldset>${error?`<p class="notice" role="alert">${html(error)}</p>`:''}<button type="submit">Accept</button></form><script type="module" src="/account/consent.js"></script>`;
}
/** The page for a valid link token: the REQUIRED statements as plain lines with their links and one Accept button.
 * The optional product-email line is not here: the link is a bearer, so it records only what using YEET needs. That
 * choice stays in the chat (yeet_accept_terms) or on this page for a signed-in person. */
export function termsLinkBody({token,terms,error=''}){
 if(terms.accepted)return TERMS_DONE;
 const rows=terms.statements.filter(s=>s.required).map(s=>{
  const url=safeUrl(s.url),read=url?` <a href="${html(url)}" target="_blank" rel="noopener noreferrer">Read</a>`:'';
  return `<p class="statement"><span>${html(s.text)}${read}</span></p>`;
 }).join('');
 return `<form method="POST" action="${TERMS_PATH}" data-yeet-terms-link><input type="hidden" name="t" value="${html(token)}"><input type="hidden" name="version" value="${html(terms.version)}"><p class="lead">Accept once to use YEET in ChatGPT.</p><fieldset class="agreements"><legend>By accepting, you confirm each line.</legend>${rows}</fieldset>${error?`<p class="notice" role="alert">${html(error)}</p>`:''}<button type="submit">Accept</button></form>`;
}
/** The end of the link path. Nothing else is on the page: there is no session here to go on with. */
export const TERMS_DONE='<p class="lead">Done. You accepted the YEET terms.</p><p>Go back to ChatGPT and carry on.</p>';
/** The link was already used and the terms are accepted: the same end, said as it is. */
export const TERMS_ALREADY='<p class="lead">You already accepted the YEET terms.</p><p>Go back to ChatGPT and carry on.</p>';
/**
 * session(q): the YEET sign-in session; core(route, account, body): the core as the sign-in server; document(res,title,body).
 * linkToken(text): the claims of a valid `terms` link token ({a: account id, v: version, j: token id}) or null.
 * hint: account-bound.mjs hintReader (the link's signed hint, ?h=).
 *
 * Which account a visit is for, in this order, and it never falls back from a link to "whoever is signed in here":
 *   1. a valid terms token: its account, with no sign-in;
 *   2. a hint that was supplied and does not verify: the expired state;
 *   3. a valid hint: that account. A browser signed in as that account gets its page; anyone else goes to the
 *      sign-in page bound to the hint (which lets only that account in);
 *   4. a token that was supplied and does not verify, with no hint: the expired state;
 *   5. nothing supplied: the YEET session's account, or the plain sign-in page.
 */
export function termsRoutes(app,{session,originOK,core,document,equal=(a,b)=>typeof a==='string'&&a===b,formBody,linkToken=()=>null,hint=NO_HINTS}){
 const read=async id=>{try{const {status,body}=await core('/terms',id);return status===200&&body?.terms?body.terms:null}catch{return null}};
 // The token's account, only while the token is good, carries its id AND names the version the core now asks for.
 const linked=async value=>{
  const claims=typeof value==='string'&&value?linkToken(value):null;
  if(!claims||typeof claims.j!=='string'||!TOKEN_ID.test(claims.j))return null;
  const terms=await read(claims.a);
  return terms&&terms.version===claims.v?{account:claims.a,terms,id:claims.j}:null;
 };
 // The token is in this page's address: never send it on with a click on a statement's link.
 const sealed=r=>r.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
 const expired=r=>r.status(410).type('html').send(document(r,TERMS_TITLE,expiredBody()));
 const boundSignIn=h=>`/account/login?next=${TERMS_NEXT}&h=${encodeURIComponent(h.token)}`;
 app.get(TERMS_PATH,async(q,r)=>{
  sealed(r);
  const hasToken=q.query.t!==undefined;
  const link=hasToken?await linked(q.query.t):null;
  if(link)return r.type('html').send(document(r,TERMS_TITLE,termsLinkBody({token:q.query.t,terms:link.terms})));
  const {supplied,hint:bound}=hint.state(q.query.h),s=session(q);
  if(supplied&&!bound)return expired(r);
  // The link names an account: only that account's own session shows its page here. Anyone else signs in, bound.
  if(bound&&(!s||s.id!==bound.account))return r.redirect(303,boundSignIn(bound));
  if(hasToken&&!bound)return expired(r);
  if(!s)return r.redirect(303,`/account/login?next=${TERMS_NEXT}`);
  const terms=await read(s.id);
  if(!terms)return r.status(503).type('html').send(document(r,TERMS_TITLE,'<p>The terms could not be loaded just now. Try again in a moment.</p>'));
  r.type('html').send(document(r,TERMS_TITLE,termsBody({csrf:s.csrf,terms})));
 });
 app.post(TERMS_PATH,formBody,async(q,r)=>{
  sealed(r);
  // The link path: the token is the only thing that names the account, and it is used once. It records the
  // required lines the page showed for this version and nothing else, whatever else the form carries.
  if(q.body?.t!==undefined){
   if(!originOK(q))return r.sendStatus(403);
   const link=await linked(q.body.t);
   // Expired while the page was open, or altered: the expired state. Never the session this browser may hold.
   if(!link)return expired(r);
   const confirmed=link.terms.statements.filter(s=>s.required).map(s=>s.id);
   let status=503,body=null;
   try{({status,body}=await core('/terms/accept',link.account,{version:String(q.body.version??''),confirmed,via:'link',token_id:link.id}))}catch{}
   if(status===200)return r.type('html').send(document(r,TERMS_TITLE,TERMS_DONE));
   // The token was used before: nothing is recorded again. Accepted already is the harmless end; otherwise it is spent.
   if(status===409&&body?.error==='LINK_USED')return body.terms?.accepted?r.type('html').send(document(r,TERMS_TITLE,TERMS_ALREADY)):expired(r);
   if(body?.reason==='version')return r.status(400).type('html').send(document(r,TERMS_TITLE,'<p>These terms changed. Go back to ChatGPT and ask for the YEET terms again.</p>'));
   return r.status(503).type('html').send(document(r,TERMS_TITLE,termsLinkBody({token:q.body.t,terms:link.terms,error:'That could not be saved just now. Try again in a moment.'})));
  }
  const s=session(q);
  if(!s)return r.redirect(303,`/account/login?next=${TERMS_NEXT}`);
  if(!equal(q.body?.csrf,s.csrf)||!originOK(q))return r.sendStatus(403);
  const confirmed=Object.entries(q.body??{}).filter(([k,v])=>k.startsWith('agree_')&&v==='yes').map(([k])=>k.slice(6)).filter(id=>/^[a-z0-9_]{1,40}$/.test(id));
  let status=503,body=null;
  try{({status,body}=await core('/terms/accept',s.id,{version:String(q.body?.version??''),confirmed,source:'page'}))}catch{}
  if(status===200)return r.redirect(303,TERMS_PATH);
  const terms=body?.terms??await read(s.id);
  if(!terms)return r.status(503).type('html').send(document(r,TERMS_TITLE,'<p>That could not be saved just now. Try again in a moment.</p>'));
  r.status(400).type('html').send(document(r,TERMS_TITLE,termsBody({csrf:s.csrf,terms,error:body?.reason==='version'?'These terms changed. Read them again, then agree.':'Agree to each required line to continue.'})));
 });
}

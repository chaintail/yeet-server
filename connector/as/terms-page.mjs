// The YEET terms as a first-party page at /account/terms: every statement of the current version with its link and a
// checkbox, one Accept button. It records the SAME versioned acceptance as yeet_accept_terms (core terms_acceptances,
// source 'page'). Structure after Folio's consent screen (chaintail/stock-app ConsentScreen.kt / ConsentText.kt): each
// line names what the person agrees to and links the document; the required boxes gate the button; one optional
// product-email line that is never ticked for the person; the server checks again.
//
// It is the reliable fallback for the in-chat flow: with YEET_TERMS_MODE=page the TERMS_REQUIRED result tells the
// assistant and the cards to send the person here. With the default (chat) the page still works when opened.
import {html} from './auth-pages.mjs';
export const TERMS_PATH='/account/terms';
export const TERMS_NEXT='terms';
export const TERMS_TITLE='YEET terms';
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
/** session(q): the YEET sign-in session; core(route, account, body): the core as the sign-in server; document(res,title,body). */
export function termsRoutes(app,{session,originOK,core,document,equal=(a,b)=>typeof a==='string'&&a===b,formBody}){
 const read=async id=>{try{const {status,body}=await core('/terms',id);return status===200&&body?.terms?body.terms:null}catch{return null}};
 app.get(TERMS_PATH,async(q,r)=>{
  r.set('Cache-Control','no-store');
  const s=session(q);
  if(!s)return r.redirect(303,`/account/login?next=${TERMS_NEXT}`);
  const terms=await read(s.id);
  if(!terms)return r.status(503).type('html').send(document(r,TERMS_TITLE,'<p>The terms could not be loaded just now. Try again in a moment.</p>'));
  r.type('html').send(document(r,TERMS_TITLE,termsBody({csrf:s.csrf,terms})));
 });
 app.post(TERMS_PATH,formBody,async(q,r)=>{
  r.set('Cache-Control','no-store');
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

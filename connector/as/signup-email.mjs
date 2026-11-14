// The email step of the connect screen, server side (the page: login/email-step.js and email-step.jsx).
//
// Right after a Google or Apple sign-in, a person whose Privy user has no email login is asked for the code that was
// just emailed to them; with it the email becomes a login of the SAME Privy user (Privy links it inside the person's
// own session; there is no server call that does it). The trade card inside ChatGPT can then email its one code.
//
// One setting, read when a page asks for /account/identity-config (a new value needs a restart of the sign-in
// server, never a rebuild of the sign-in bundle):
//
//   YEET_SIGNUP_EMAIL_STEP   on by default. 0, off, false or no turns the step off: the page never shows it and
//                            POST /account/email-step answers 404. Anything else that is not 1, on, true or yes
//                            stops the server at start, so a mistyped "off" is never read as on.
//
// What the server does, in one place:
//
//   - POST /account/email-step {privy_access_token} -> {step}. The caller's Privy token is verified; the account
//     already linked to that Privy user is LOOKED UP (core /identity/lookup, never resolved: nothing is created
//     here). The answer is a signed note of who started the step: the Privy user id, that account or none, 15
//     minutes. It records nothing and grants nothing: no session, no account, no route but the sign-in reads it;
//   - the page posts the note back with the sign-in form (field `email_step`), whether the person entered the code
//     or pressed Skip for now. The sign-in then holds (stepGuard, stepAccount): the Privy user who signs in must be
//     the user of the note, and the account the sign-in opens must be the note's account when it named one. A
//     different user (the session changed while the email was being added) is refused with CHANGED_LINE; nothing is
//     created, linked or switched for them;
//   - a note that was SUPPLIED but does not verify (expired, altered) is refused the same way. It is never dropped
//     in favour of whoever is signed in. A sign-in with no note at all is the sign-in as it always was;
//   - with the setting off the field is not read at all: no refusal, no call to the core, whatever an old page posts;
//   - the server never links, merges or moves an email, and keeps no record of the step. Whether an account has an
//     email login is read from Privy when a card needs it (core/account-login.mjs).
//
// The note is not a credential and not an authorization: the Privy access token is, on every route. The note only
// makes the page's own promise checkable: "the person who connects is the person who was asked for the code".
import {createHmac,timingSafeEqual} from 'node:crypto';
import express from 'express';
import {html} from './auth-pages.mjs';

/** The setting. Throws on a value that is neither on nor off. */
export function signupEmailStep(value=process.env.YEET_SIGNUP_EMAIL_STEP){
 const v=value===undefined||value===null?'':String(value).trim().toLowerCase();
 if(v===''||v==='1'||v==='on'||v==='true'||v==='yes')return true;
 if(v==='0'||v==='off'||v==='false'||v==='no')return false;
 throw Error('Invalid YEET_SIGNUP_EMAIL_STEP');
}

export const STEP_PATH='/account/email-step';
export const STEP_FIELD='email_step';
export const STEP_TTL_S=900;
export const STEP_TOKEN_MAX=500;
export const CHANGED_CODE='ACCOUNT_CHANGED';
export const CHANGED_LINE='Something changed with your account, so nothing was connected.';
const PURPOSE='signup-email';
const DID=/^did:privy:[a-zA-Z0-9_-]{1,128}$/;
const ACCOUNT=/^yeet-privy-[a-zA-Z0-9_-]{1,80}$/;
const SHAPE=/^e1\.([A-Za-z0-9_-]{8,400})\.([A-Za-z0-9_-]{43})$/;
// The same derivation as shared/link-token.mjs (base key, then one key per purpose), with a purpose that module
// does not know: a link token never verifies as a step note, and a step note never as a link token.
const mac=(key,body)=>createHmac('sha256',createHmac('sha256',key).update(PURPOSE).digest()).update(`e1.${body}`).digest();

/** mintStepToken(key, {did, account, now}) -> the note. `account`: the YEET account already linked to `did`, or null. */
export function mintStepToken(key,{did,account=null,now=Date.now()}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Invalid step key');
 if(typeof did!=='string'||!DID.test(did))throw Error('Invalid step user');
 if(account!==null&&(typeof account!=='string'||!ACCOUNT.test(account)))throw Error('Invalid step account');
 const body=Buffer.from(JSON.stringify({d:did,a:account,e:Math.floor(now/1000)+STEP_TTL_S})).toString('base64url');
 return `e1.${body}.${mac(key,body).toString('base64url')}`;
}
/** verifyStepToken(key, token, {now}) -> {d, a, e} or null. Anything wrong answers null, with no reason. */
export function verifyStepToken(key,token,{now=Date.now()}={}){
 if(!Buffer.isBuffer(key)||key.length!==32)return null;
 if(typeof token!=='string'||token.length>STEP_TOKEN_MAX)return null;
 const m=SHAPE.exec(token);
 if(!m)return null;
 const given=Buffer.from(m[2],'base64url'),expected=mac(key,m[1]);
 if(given.length!==expected.length||!timingSafeEqual(given,expected))return null;
 let claims;
 try{claims=JSON.parse(Buffer.from(m[1],'base64url').toString('utf8'))}catch{return null}
 if(!claims||typeof claims!=='object'||Array.isArray(claims))return null;
 if(typeof claims.d!=='string'||!DID.test(claims.d))return null;
 if(claims.a!==null&&(typeof claims.a!=='string'||!ACCOUNT.test(claims.a)))return null;
 if(!Number.isSafeInteger(claims.e)||claims.e*1000<=now)return null;
 return {d:claims.d,a:claims.a,e:claims.e};
}
/**
 * stepReader(key) -> read. read(text): the note's claims or null. read.state(value) -> {supplied, step}: `supplied`
 * is true when the form carried the field at all (any value, also an empty or repeated one); supplied with step null
 * means: refuse. The same shape as the hint reader of account-bound.mjs.
 */
export function stepReader(key,{now=Date.now}={}){
 const read=text=>verifyStepToken(key,text,{now:now()});
 read.state=value=>({supplied:value!==undefined&&value!==null,step:read(value)});
 return read;
}

/** The sign-in is not the person the step was started by (`why`: expired | user | account; never shown). */
export class StepChanged extends Error{
 constructor(why){super('Email step: the sign-in changed');this.name='StepChanged';this.why=why}
}
/**
 * Before the sign-in resolves anyone: the note on the form against the verified Privy user who is signing in.
 *   body      the sign-in form            read: stepReader(key)
 *   identity  (body) -> {did}: the verified identity behind the form's credential (shared/common.mjs
 *             verifiedIdentity; it throws when the credential does not verify, and so does this)
 *   on        () -> the setting. Off: the field is not read at all, whatever a form still carries (a page that was
 *             open when the step was turned off): the sign-in is exactly the sign-in without the step
 * -> null (no note, or the step is off: the sign-in as it always was) or the note's claims. Throws StepChanged.
 */
export async function stepGuard(body,{read,identity,on}){
 if(typeof on!=='function'||on()!==true)return null;
 const {supplied,step}=read.state(body?.[STEP_FIELD]);
 if(!supplied)return null;
 if(!step)throw new StepChanged('expired');
 const who=await identity(body);
 if(typeof who?.did!=='string'||who.did!==step.d)throw new StepChanged('user');
 return step;
}
/** After the sign-in found its account: it must be the account the note named, when it named one. */
export function stepAccount(step,account){
 if(step&&step.a!==null&&account!==step.a)throw new StepChanged('account');
}
/** The refusal as a page body: what happened and what to do. Nothing about any account. */
export const changedBody=()=>`<p class="notice" role="alert">${html(CHANGED_LINE)}</p><p>Go back to ChatGPT and connect YEET again.</p>`;

/**
 * signupEmailRoutes(app, {enabled, on, key, identity, lookup, originOK})
 *   enabled   () -> the sign-in page runs on Privy here        on: () -> the setting (signupEmailStep)
 *   key       the link key of this process (shared/link-token.mjs requireLinkKey)
 *   identity  (input) -> {did}; throws when the credential does not verify
 *   lookup    (input) -> the account already linked to that identity, or null. Never creates one.
 */
export function signupEmailRoutes(app,{enabled,on,key,identity,lookup,originOK}){
 app.post(STEP_PATH,express.json({limit:'32kb'}),async(q,r)=>{
  r.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  if(!enabled()||!on())return r.sendStatus(404);
  if(!originOK(q))return r.sendStatus(403);
  const input={privy_access_token:q.body?.privy_access_token,identity_token:q.body?.identity_token};
  let who;
  try{who=await identity(input)}
  catch{return r.status(401).json({code:'SIGN_IN_REQUIRED',message:'Your session here ended. Please start again.'})}
  // The account this Privy user already has, when there is one. A core that does not answer leaves it unnamed: the
  // note then binds the Privy user alone, which is what the account is derived from.
  let account=null;
  try{account=await lookup(input)}catch{account=null}
  try{r.json({step:mintStepToken(key,{did:who.did,account:typeof account==='string'?account:null})})}
  catch{r.status(401).json({code:'SIGN_IN_REQUIRED',message:'Your session here ended. Please start again.'})}
 });
}

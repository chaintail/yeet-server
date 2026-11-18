import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {log,setAccount,requestIdHeader} from './log.mjs';
export const AS = process.env.ISSUER || 'http://127.0.0.1:38312';
export const RESOURCE = process.env.RESOURCE || 'http://127.0.0.1:38313';
export const AS_INTERNAL = process.env.AS_INTERNAL || 'http://as:38312';
export const CORE = process.env.CORE_INTERNAL || 'http://core:38316';
export const PUBLIC = process.env.PUBLIC_MODE === '1';
export const TEST = process.env.TEST_PROFILE === '1' && !PUBLIC;
// Listen ports inside the container; overridable so in-process tests can use the reserved 38860-38869 range.
export const port = (name, fallback) => Number(process.env[name] || fallback);
export const dir = path.resolve(process.env.STATE_DIR || '/state');
export const read = (name,fallback={}) => {try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}};
export const write = (name,value) => {const dest=path.join(dir,name);fs.writeFileSync(dest+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(dest+'.tmp',dest)};
export function secret(name){return fs.readFileSync(path.join(process.env.SECRETS_DIR||'/secrets',name),'utf8').trim()}
export function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)}
export async function coreCall(route,subject,credential,body){const r=await fetch(CORE+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${credential}`,'x-yeet-subject':subject,'content-type':'application/json',...requestIdHeader()},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error(`core denied ${r.status}`);return r.json()}
/** Core's server-side wallet setup (core.mjs /wallets/ensure): {status, body}; Privy creation can take several seconds. */
/** A core call that keeps core's answer on refusal: {status, body}. body is null when it is not JSON. */
export async function coreSend(route,subject,credential,body,timeoutMs=4000){const r=await fetch(CORE+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${credential}`,'x-yeet-subject':subject,'content-type':'application/json',...requestIdHeader()},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs)});let out=null;try{out=await r.json()}catch{}return {status:r.status,body:out}}
export async function coreEnsureWallets(subject,credential,timeoutMs=45000){const r=await fetch(CORE+'/wallets/ensure',{method:'POST',headers:{authorization:`Bearer ${credential}`,'x-yeet-subject':subject,'content-type':'application/json',...requestIdHeader()},body:'{}',signal:AbortSignal.timeout(timeoutMs)});let body=null;try{body=await r.json()}catch{}return {status:r.status,body}}
/** Development identities (TEST_PROFILE=1 and DEV_IDENTITY_STUB=1 only): `DEV:did:privy:<id>` stands in for a verified Privy token. */
export const DEV_APP_ID = 'dev-identity-stub';
/** The verified identity behind a sign-in credential: a Privy access token checked against the app's JWKS (issuer,
 *  audience = PRIVY_APP_ID, lifetime), or the development stub. Throws when it does not verify. */
export async function verifiedIdentity(input){
 if(process.env.PRIVY_LOGIN==='1'){
  const {verifiedPrivy}=await import('./privy-identity.mjs');
  return verifiedPrivy(input.privy_access_token);
 }
 if(TEST&&process.env.DEV_IDENTITY_STUB==='1'&&typeof input.identity_token==='string'){
  const did=input.identity_token.match(/^DEV:(did:privy:[a-zA-Z0-9_-]{1,128})$/)?.[1];
  if(!did)throw Error('invalid development identity');
  return {provider:'privy.io',app_id:DEV_APP_ID,did};
 }
 throw Error('Identity verifier unavailable or credential invalid');
}
/** A new person while the limited beta is full (core /identity/resolve 403 BETA_FULL): no account was created. */
export class BetaFull extends Error{constructor(){super('BETA_FULL');this.name='BetaFull'}}
export async function verifyIdentity(input){
 let identity;
 try{identity=await verifiedIdentity(input)}catch(e){log.warn('sign_in_failed',{flow:'login',reason:'credential_invalid'});throw e}
 // Core creates the account on first verified login (capped by YEET_MAX_ACCOUNTS and, while set, YEET_BETA_USER_CAP)
 // and returns its stable id.
 let status,body;
 try{({status,body}=await coreSend('/identity/resolve','',secret('core-as'),identity,2000))}catch(e){log.warn('sign_in_failed',{flow:'login',reason:'core_unavailable'});throw e}
 if(status===403&&body?.error==='BETA_FULL'){log.warn('sign_in_failed',{flow:'login',reason:'beta_full'});throw new BetaFull()}
 if(status<200||status>=300||!body){log.warn('sign_in_failed',{flow:'login',reason:'core_denied',status});throw Error(`core denied ${status}`)}
 if(typeof body.id!=='string'){log.warn('sign_in_failed',{flow:'login',reason:'not_eligible'});throw Error('Identity not eligible')}
 setAccount(body.id);log.warn('sign_in_ok',{flow:'login',account:body.id});
 return body.id;
}
/** Verified credential -> the account already linked to that identity, or null (no account, or suspended). Never
 *  creates an account. Throws only when the credential does not verify. */
export async function lookupAccount(input){
 let identity;
 try{identity=await verifiedIdentity(input)}catch(e){log.warn('sign_in_failed',{flow:'lookup',reason:'credential_invalid'});throw e}
 const r=await coreSend('/identity/lookup','',secret('core-as'),identity);
 const id=r.status===200&&typeof r.body?.id==='string'?r.body.id:null;
 if(id){setAccount(id);log.warn('sign_in_ok',{flow:'lookup',account:id})}else log.warn('sign_in_failed',{flow:'lookup',reason:'no_account',status:r.status});
 return id;
}

// Privy REST client for the signer adapters and the wallet directory. The request shape and the authorization
// signature are copied from Folio (stock-app origin/dev packages/wallet-privy/src/transport.ts `signedRequest`,
// authorization-signature.ts, json.ts `canonical`, evm.ts `createPrivyAdmin`):
//   - origin https://api.privy.io, paths /v1/...
//   - headers: privy-app-id, privy-idempotency-key (optional), content-type application/json,
//     authorization Basic base64(app_id:app_secret), privy-authorization-signature
//   - signature: canonical JSON (sorted keys) of {version:1, method, url (full, no trailing slash), body, headers:
//     every privy- header}, ECDSA P-256 / SHA-256, ASN.1 DER, standard base64
//   - refusals (docs.privy.io api-errors, checked 2026-11-13): code policy_violation = policy denial; the authorization
//     codes zero_correct_authorization_signatures, insufficient_correct_authorization_signatures,
//     incorrect_quantity_of_authorization_signatures, missing_or_empty_authorization_header (and the older
//     invalid_authorization_signature, or invalid_data with the "No valid authorization signatures" message) = signer
//     not authorised. Both are definite: Privy did not act on the request.
//   - idempotency (docs.privy.io idempotency keys): a key reused with a different body answers 400; on /rpc a 4xx or
//     5xx is cached against the key for 24 h, so a 5xx is surfaced with its status for the caller to look up first.
// Secrets are read once from env names and kept non-enumerable; nothing here logs a value.
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {canonical} from './util.mjs';

export const PRIVY_ORIGIN='https://api.privy.io';
export class PrivyApiError extends Error{constructor(code,status){super(code);this.name='PrivyApiError';this.code=code;this.status=status}}

/** Env names: PRIVY_APP_ID, PRIVY_APP_SECRET, YEET_PRIVY_AUTHORIZATION_KEY, YEET_PRIVY_KEY_QUORUM_ID. Null when any of
 * the first three is missing (the adapters then answer WALLET_NOT_READY). */
export function privyConfig(env=process.env){
 const v=n=>env[n]?.trim()||undefined;
 const appId=v('PRIVY_APP_ID'),appSecret=v('PRIVY_APP_SECRET'),authorizationKey=v('YEET_PRIVY_AUTHORIZATION_KEY');
 if(!appId||!appSecret||!authorizationKey)return null;
 const out={appId};
 Object.defineProperties(out,{appSecret:{value:appSecret,enumerable:false},authorizationKey:{value:authorizationKey,enumerable:false},keyQuorumId:{value:v('YEET_PRIVY_KEY_QUORUM_ID'),enumerable:true}});
 return Object.freeze(out);
}

/** Folio authorization-signature.ts: PEM, base64 PKCS#8 or SEC1 DER, optionally prefixed `wallet-auth:`; P-256 only. */
export function authorizationPrivateKey(key){
 const value=key.trim(),encoded=value.startsWith('wallet-auth:')?value.slice('wallet-auth:'.length):value;
 let k;
 if(encoded.includes('-----BEGIN'))k=createPrivateKey(encoded);
 else{const der=Buffer.from(encoded,'base64');try{k=createPrivateKey({key:der,format:'der',type:'pkcs8'})}catch{k=createPrivateKey({key:der,format:'der',type:'sec1'})}}
 if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new PrivyApiError('INVALID_PRIVY_AUTHORIZATION_KEY');
 return k;
}
/** Base64 DER SPKI of the authorization key: the `owner.public_key` form Privy accepts (Folio evm.ts). */
export const authorizationPublicKey=key=>createPublicKey(authorizationPrivateKey(key)).export({format:'der',type:'spki'}).toString('base64');

export function authorizationSignature(key,{method,url,body,headers}){
 const bytes=canonical({version:1,method,url,body,headers:{'privy-app-id':headers['privy-app-id'],...(headers['privy-idempotency-key']===undefined?{}:{'privy-idempotency-key':headers['privy-idempotency-key']})}});
 return sign('sha256',Buffer.from(bytes,'utf8'),{key:authorizationPrivateKey(key),dsaEncoding:'der'}).toString('base64');
}

const REFUSALS=['No valid authorization signatures were provided','No valid authorization keys or user signing keys available','Missing `privy-authorization-signature` header','Not enough valid authorization signatures'];
/** Privy's documented authorization error codes: the request was refused before anything was signed. */
export const AUTHORIZATION_CODES=new Set(['zero_correct_authorization_signatures','insufficient_correct_authorization_signatures',
 'incorrect_quantity_of_authorization_signatures','missing_or_empty_authorization_header','invalid_authorization_signature']);
const QUERY_VALUE=/^[A-Za-z0-9_-]{1,128}$/;

/** Maps a non-2xx Privy answer onto a PrivyApiError code. */
export function privyErrorCode(status,json){
 const code=typeof json?.code==='string'?json.code:'',error=[json?.error,json?.message].find(v=>typeof v==='string')??'';
 if(status>=400&&status<500){
  if(code==='policy_violation')return 'PRIVY_POLICY_DENIED';
  if(AUTHORIZATION_CODES.has(code)||(code==='invalid_data'&&error.startsWith('No valid authorization signatures'))||((status===401||status===403)&&REFUSALS.some(p=>error.startsWith(p))))return 'PRIVY_AUTHORIZATION_DENIED';
  if(status===400&&/idempotency/i.test(error))return 'PRIVY_IDEMPOTENCY_CONFLICT';
 }
 return `PRIVY_HTTP_${status}`;
}

export function createPrivyApi({config,fetch=globalThis.fetch,timeoutMs=15_000}){
 const basic=()=>`Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString('base64')}`;
 async function send(method,path,body,{idempotencyKey,signed,query}){
  if(!/^\/v1\/[A-Za-z0-9_/:-]+$/.test(path))throw new PrivyApiError('INVALID_PRIVY_PATH');
  if(idempotencyKey!==undefined&&!/^[a-f0-9]{64}$/.test(idempotencyKey))throw new PrivyApiError('INVALID_IDEMPOTENCY_KEY');
  const q=Object.entries(query??{});
  if(!q.every(([k,v])=>/^[a-z_]{1,32}$/.test(k)&&QUERY_VALUE.test(String(v))))throw new PrivyApiError('INVALID_PRIVY_PATH');
  const url=PRIVY_ORIGIN+path+(q.length?`?${new URLSearchParams(q)}`:'');
  const privyHeaders={'privy-app-id':config.appId,...(idempotencyKey?{'privy-idempotency-key':idempotencyKey}:{})};
  const headers={...privyHeaders,authorization:basic(),...(body!==undefined?{'content-type':'application/json'}:{})};
  if(signed)headers['privy-authorization-signature']=authorizationSignature(config.authorizationKey,{method,url,body:body??{},headers:privyHeaders});
  let res;
  try{res=await fetch(url,{method,headers,...(body!==undefined?{body:canonical(body)}:{}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)})}
  catch{throw new PrivyApiError('PRIVY_TRANSPORT_UNAVAILABLE')}
  let json;try{json=await res.json()}catch{json=null}
  if(res.status<200||res.status>=300)throw new PrivyApiError(privyErrorCode(res.status,json),res.status);
  return json;
 }
 return {
  /** Authorization-signed request (wallet RPC, wallet creation owned by the YEET key). */
  signed:(method,path,body,opts={})=>send(method,path,body,{...opts,signed:true}),
  /** App-authenticated request (reads). */
  app:(method,path,body,opts={})=>send(method,path,body,{...opts,signed:false}),
 };
}

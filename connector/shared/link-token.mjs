// Signed link tokens: what the core puts on a YEET page link it hands to ChatGPT for ONE account, and what the
// sign-in server reads back when the person opens that link.
//
//   token   = "v1." + payload + "." + mac
//   payload = base64url(JSON {p, a, e, ...claims})     p: purpose   a: account id (yeet-privy-...)   e: expiry, unix s
//   mac     = base64url(HMAC-SHA256(key(p), "v1." + payload))
//
// Purposes and their claims:
//   terms   {p:'terms', a, v, e}   v: the terms version. The terms page shows the statements and Accept with no
//           sign-in, and records the acceptance for `a`. 10 minutes. It grants nothing else: no session, no wallet,
//           no other route reads it.
//   hint    {p:'hint', a, m, e}    m: the login methods the account's Privy user has (google, apple, email). The
//           funding and trade pages show only those methods and refuse any other account. It is a hint and a
//           binding, never a credential: the person still signs in, and the server compares who signed in with `a`.
//
// The key. No new secret: both servers already share `core-as` (the bearer the sign-in server calls the core with).
// The token key is derived from it with a fixed label, then once more per purpose, so a token of one purpose never
// verifies as another and the bearer itself is never used as a MAC key:
//   base     = HMAC-SHA256(core-as, "yeet-link-token/v1")
//   key(p)   = HMAC-SHA256(base, p)
// Rotating core-as (both servers restart) ends every outstanding link token.
//
// Verification: the format, the purpose's own key, the MAC compared in constant time, then the claims (purpose,
// account id shape, expiry). Anything wrong answers null, with no reason: the page then behaves as if there were no token.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {secret} from './common.mjs';

export const LINK_TOKEN_LABEL='yeet-link-token/v1';
export const LINK_PURPOSES=Object.freeze(['terms','hint']);
export const TERMS_LINK_TTL_S=600;
/** A hint grants nothing, so it may outlive a trade: a funding link in the chat still names the right methods a day later. */
export const HINT_LINK_TTL_S=24*3600;
export const LINK_TOKEN_MAX=400;
const ACCOUNT=/^yeet-privy-[a-zA-Z0-9_-]{1,80}$/;
const SHAPE=/^v1\.([A-Za-z0-9_-]{8,300})\.([A-Za-z0-9_-]{43})$/;

/** The base key from the shared secret's text. */
export function deriveLinkKey(sharedSecret){
 if(typeof sharedSecret!=='string'||sharedSecret.length<16)throw Error('Link token secret unavailable');
 return createHmac('sha256',sharedSecret).update(LINK_TOKEN_LABEL).digest();
}
let cached;
/** The base key of this process (from /secrets/core-as), read once. */
export function linkKey(){return cached??=deriveLinkKey(secret('core-as'))}
const purposeKey=(key,purpose)=>createHmac('sha256',key).update(purpose).digest();
const mac=(key,purpose,body)=>createHmac('sha256',purposeKey(key,purpose)).update(`v1.${body}`).digest();

/** mintLinkToken(key, {purpose, account, ttl, claims, now}) -> token. Throws on a wrong purpose or account. */
export function mintLinkToken(key,{purpose,account,ttl,claims={},now=Date.now()}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Invalid link key');
 if(!LINK_PURPOSES.includes(purpose))throw Error('Invalid link purpose');
 if(typeof account!=='string'||!ACCOUNT.test(account))throw Error('Invalid link account');
 if(!Number.isSafeInteger(ttl)||ttl<1||ttl>7*24*3600)throw Error('Invalid link lifetime');
 const body=Buffer.from(JSON.stringify({...claims,p:purpose,a:account,e:Math.floor(now/1000)+ttl})).toString('base64url');
 const token=`v1.${body}.${mac(key,purpose,body).toString('base64url')}`;
 if(token.length>LINK_TOKEN_MAX)throw Error('Link token too long');
 return token;
}
/**
 * verifyLinkToken(key, token, {purpose, now}) -> the claims {p, a, e, ...} or null. `purpose` is required: the caller
 * says what it is about to do, and only a token minted for exactly that verifies.
 */
export function verifyLinkToken(key,token,{purpose,now=Date.now()}={}){
 if(!Buffer.isBuffer(key)||key.length!==32||!LINK_PURPOSES.includes(purpose))return null;
 if(typeof token!=='string'||token.length>LINK_TOKEN_MAX)return null;
 const m=SHAPE.exec(token);
 if(!m)return null;
 const given=Buffer.from(m[2],'base64url'),expected=mac(key,purpose,m[1]);
 if(given.length!==expected.length||!timingSafeEqual(given,expected))return null;
 let claims;
 try{claims=JSON.parse(Buffer.from(m[1],'base64url').toString('utf8'))}catch{return null}
 if(!claims||typeof claims!=='object'||Array.isArray(claims))return null;
 if(claims.p!==purpose||typeof claims.a!=='string'||!ACCOUNT.test(claims.a))return null;
 if(!Number.isSafeInteger(claims.e)||claims.e*1000<=now)return null;
 return claims;
}
/** <url>?<name>=<token> (or &), for an https page URL; the URL unchanged when there is no token. */
export function withLinkToken(url,name,token){
 if(typeof url!=='string'||!token)return url;
 return `${url}${url.includes('?')?'&':'?'}${name}=${token}`;
}

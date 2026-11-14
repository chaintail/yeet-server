// Signed link tokens (shared/link-token.mjs): the format, the derived key, and every way a token must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {deriveLinkKey,mintLinkToken,verifyLinkToken,withLinkToken,LINK_TOKEN_LABEL,TERMS_LINK_TTL_S,HINT_LINK_TTL_S} from '../link-token.mjs';

const SECRET='s'.repeat(40),key=deriveLinkKey(SECRET);
const A='yeet-privy-AAAAAAAAAAAAAAAAAAAAAA',B='yeet-privy-BBBBBBBBBBBBBBBBBBBBBB';
const T0=Date.parse('2026-11-14T12:00:00Z');
const terms=(extra={})=>mintLinkToken(key,{purpose:'terms',account:A,ttl:TERMS_LINK_TTL_S,claims:{v:'2026-11-13'},now:T0,...extra});
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');

test('the format: v1.<payload>.<mac>, HMAC-SHA256 with a key derived from the shared secret, per purpose',()=>{
 const t=terms(),[v,body,sig]=t.split('.');
 assert.equal(v,'v1');
 assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{v:'2026-11-13',p:'terms',a:A,e:T0/1000+600});
 const base=createHmac('sha256',SECRET).update(LINK_TOKEN_LABEL).digest();
 const k=createHmac('sha256',base).update('terms').digest();
 assert.equal(sig,createHmac('sha256',k).update(`v1.${body}`).digest('base64url'));
 assert.equal(LINK_TOKEN_LABEL,'yeet-link-token/v1');
 assert.ok(t.length<200,`a terms token is short (${t.length})`);
 assert.ok(`https://chatgpt.yeet.win/account/terms?t=${t}`.length<=508,'the link fits the contract https_url');
 assert.notDeepEqual(key,Buffer.from(SECRET),'the bearer itself is never the MAC key');
});

test('a good token verifies for its purpose until it expires',()=>{
 const t=terms();
 assert.deepEqual(verifyLinkToken(key,t,{purpose:'terms',now:T0}),{v:'2026-11-13',p:'terms',a:A,e:T0/1000+600});
 assert.ok(verifyLinkToken(key,t,{purpose:'terms',now:T0+599_000}));
 assert.equal(TERMS_LINK_TTL_S,600);assert.equal(HINT_LINK_TTL_S,86400);
});

test('expired: refused at the expiry second and after',()=>{
 const t=terms();
 assert.equal(verifyLinkToken(key,t,{purpose:'terms',now:T0+600_000}),null);
 assert.equal(verifyLinkToken(key,t,{purpose:'terms',now:T0+86_400_000}),null);
});

test('tampered: any change to the payload or the mac is refused',()=>{
 const t=terms(),[v,body,sig]=t.split('.');
 const claims=JSON.parse(Buffer.from(body,'base64url'));
 // Another account, a later expiry, another version: the old mac does not cover them.
 for(const changed of [{...claims,a:B},{...claims,e:claims.e+3600},{...claims,v:'2027-01-01'},{...claims,p:'hint'}])
  assert.equal(verifyLinkToken(key,`${v}.${b64(changed)}.${sig}`,{purpose:changed.p,now:T0}),null);
 const flipped=sig.slice(0,-1)+(sig.endsWith('A')?'B':'A');
 assert.equal(verifyLinkToken(key,`${v}.${body}.${flipped}`,{purpose:'terms',now:T0}),null);
 assert.equal(verifyLinkToken(key,`${v}.${body}.${sig.slice(0,20)}`,{purpose:'terms',now:T0}),null,'a short mac');
 assert.equal(verifyLinkToken(key,`${v}.${body}.`,{purpose:'terms',now:T0}),null);
 assert.equal(verifyLinkToken(key,`v2.${body}.${sig}`,{purpose:'terms',now:T0}),null);
 assert.equal(verifyLinkToken(key,`${t}x`,{purpose:'terms',now:T0}),null);
});

test('wrong purpose: a hint never verifies as a terms token, and the other way round',()=>{
 const hint=mintLinkToken(key,{purpose:'hint',account:A,ttl:HINT_LINK_TTL_S,claims:{m:['google']},now:T0});
 assert.ok(verifyLinkToken(key,hint,{purpose:'hint',now:T0}));
 assert.equal(verifyLinkToken(key,hint,{purpose:'terms',now:T0}),null);
 assert.equal(verifyLinkToken(key,terms(),{purpose:'hint',now:T0}),null);
 // A payload that claims the other purpose but carries this purpose's mac (the per-purpose key refuses it first;
 // the claim check refuses it again).
 const [v,body,sig]=hint.split('.');
 const claims={...JSON.parse(Buffer.from(body,'base64url')),p:'terms',v:'2026-11-13'};
 assert.equal(verifyLinkToken(key,`${v}.${b64(claims)}.${sig}`,{purpose:'terms',now:T0}),null);
 assert.equal(verifyLinkToken(key,terms(),{now:T0}),null,'the caller must name the purpose');
 assert.equal(verifyLinkToken(key,terms(),{purpose:'session',now:T0}),null);
});

test('wrong account: the account is what the mac covers; a token for A is never one for B',()=>{
 const a=terms(),b=terms({account:B});
 assert.equal(verifyLinkToken(key,a,{purpose:'terms',now:T0}).a,A);
 assert.equal(verifyLinkToken(key,b,{purpose:'terms',now:T0}).a,B);
 // B's payload under A's mac.
 assert.equal(verifyLinkToken(key,`v1.${b.split('.')[1]}.${a.split('.')[2]}`,{purpose:'terms',now:T0}),null);
 assert.throws(()=>terms({account:'someone'}),/Invalid link account/);
 assert.throws(()=>terms({account:undefined}),/Invalid link account/);
});

test('another key (another deployment, or a rotated secret) refuses every token',()=>{
 const other=deriveLinkKey('t'.repeat(40));
 assert.equal(verifyLinkToken(other,terms(),{purpose:'terms',now:T0}),null);
 assert.throws(()=>deriveLinkKey(''),/secret unavailable/);
 assert.throws(()=>deriveLinkKey(undefined),/secret unavailable/);
 assert.equal(verifyLinkToken(Buffer.alloc(0),terms(),{purpose:'terms',now:T0}),null);
});

test('junk is refused quietly',()=>{
 for(const junk of [undefined,null,'',0,{}, 'v1..','a.b.c','v1.'+'A'.repeat(500)+'.'+'A'.repeat(43),'v1.e30.'+'A'.repeat(43)])
  assert.equal(verifyLinkToken(key,junk,{purpose:'terms',now:T0}),null);
 // A correctly signed payload that is not an object with the claims.
 const body=Buffer.from('"just a string"').toString('base64url');
 const k=createHmac('sha256',key).update('terms').digest();
 const sig=createHmac('sha256',k).update(`v1.${body}`).digest('base64url');
 assert.equal(verifyLinkToken(key,`v1.${body}.${sig}`,{purpose:'terms',now:T0}),null);
});

test('mint refuses an unknown purpose and a lifetime out of range',()=>{
 assert.throws(()=>mintLinkToken(key,{purpose:'session',account:A,ttl:60}),/Invalid link purpose/);
 assert.throws(()=>mintLinkToken(key,{purpose:'terms',account:A,ttl:0}),/Invalid link lifetime/);
 assert.throws(()=>mintLinkToken(key,{purpose:'terms',account:A,ttl:8*24*3600}),/Invalid link lifetime/);
 // The caller's claims cannot replace the purpose, the account or the expiry.
 const t=mintLinkToken(key,{purpose:'terms',account:A,ttl:60,claims:{p:'hint',a:B,e:9e9},now:T0});
 assert.deepEqual(verifyLinkToken(key,t,{purpose:'terms',now:T0}),{p:'terms',a:A,e:T0/1000+60});
});

test('withLinkToken adds one query parameter',()=>{
 assert.equal(withLinkToken('https://x.example/fund','h','tok'),'https://x.example/fund?h=tok');
 assert.equal(withLinkToken('https://x.example/sign?a=1','h','tok'),'https://x.example/sign?a=1&h=tok');
 assert.equal(withLinkToken('https://x.example/fund','h',null),'https://x.example/fund');
 assert.equal(withLinkToken(null,'h','tok'),null);
});

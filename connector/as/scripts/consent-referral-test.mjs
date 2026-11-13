// Consent agreements and the one-time referral screen, end to end against the sign-in server and core in this
// process (ports 38870-38873, throwaway state and secrets). Nothing outside the temp directory is touched.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const ORIGIN='https://chatgpt.yeet.win';
const PORTS={AS_PORT:38870,CORE_PORT:38871,ADMIN_PORT:38872,CONNECTOR_PORT:38873};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-consent-referral-'));
const secrets=join(root,'secrets'),state=join(root,'state');
mkdirSync(secrets);mkdirSync(state);
for(const name of ['core-introspection','introspection','core-as','core-mcp','core-operator','operator','csrf'])
 writeFileSync(join(secrets,name),randomBytes(32).toString('base64url'),{mode:0o600});
Object.assign(process.env,{
 ISSUER:ORIGIN,RESOURCE:ORIGIN,AS_INTERNAL:AS,CORE_INTERNAL:`http://127.0.0.1:${PORTS.CORE_PORT}`,
 STATE_DIR:state,SECRETS_DIR:secrets,LISTEN_HOST:'127.0.0.1',TEST_PROFILE:'1',DEV_IDENTITY_STUB:'1',ACCESS_TTL:'300',REFRESH_CONSENT_COMPAT:'1',
 ...Object.fromEntries(Object.entries(PORTS).map(([k,v])=>[k,String(v)])),
});
for(const name of ['PUBLIC_MODE','PRIVY_LOGIN','MOCK_PASSWORD_LOGIN','PUBLIC_BASE_URL','COOKIE_SECURE','TRUST_PROXY'])delete process.env[name];
const core=await import('../../core/core.mjs');
const as=await import('../as.mjs');
const {consentForm,requireAgreements,referralCode,referralForm,AGREEMENTS}=await import('../consent-selection.mjs');
after(async()=>{
 for(const s of [as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:trade'];
const AGREED={agree_wallet:'yes',agree_chatgpt:'yes',agree_near:'yes',agree_terms:'yes',agree_privacy:'yes'};
const REDIRECT='http://127.0.0.1:38314/callback';
const local=url=>{const u=new URL(url,ORIGIN);return u.origin===ORIGIN?`${AS}${u.pathname}${u.search}`:u.href};
const extras=()=>{try{return JSON.parse(readFileSync(join(state,'account-consents.json'),'utf8'))}catch{return {}}};
function jar(){const c=new Map();return {header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '),add(r){for(const s of r.headers.getSetCookie()){const p=s.split(';')[0],i=p.indexOf('=');c.set(p.slice(0,i),p.slice(i+1))}}}}
const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});

/** Browser for one person: starts an authorization and stops at the consent prompt. */
function browser(did){
 const cookies=jar();
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 return {step,async toConsent(){
  const verifier=randomBytes(32).toString('base64url');
  const auth=new URL(AS+'/auth');
  auth.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:REDIRECT,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1'});
  let r=await step(auth.href);assert.equal(r.status,303);
  let page=r.headers.get('location'),d=await (await step(page)).json();
  if(d.prompt==='login'){
   r=await step(page,form({csrf:d.csrf,identity_token:`DEV:did:privy:${did}`}));assert.equal(r.status,303);
   r=await step(r.headers.get('location'));assert.equal(r.status,303);
   page=r.headers.get('location');d=await (await step(page)).json();
  }
  assert.equal(d.prompt,'consent');
  return {page,csrf:d.csrf,verifier};
 }};
}
/** Follows the provider resume to the callback and exchanges the code. */
async function finish(b,r,verifier){
 assert.equal(r.status,303);
 r=await b.step(r.headers.get('location'));assert.equal(r.status,303);
 const callback=new URL(r.headers.get('location'));assert.equal(callback.origin+callback.pathname,REDIRECT);
 const code=callback.searchParams.get('code');assert.ok(code);
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:REDIRECT,client_id:'local-chatgpt-fixture',resource:ORIGIN})})).json();
 assert.ok(token.access_token,JSON.stringify(Object.keys(token)));
 return token;
}
const accountOf=async token=>(await (await fetch(AS+'/me',{headers:{authorization:`Bearer ${token.access_token}`}})).json()).sub;

test('consent page lists five required agreements and one optional email line; the helpers enforce them',()=>{
 const html=consentForm({csrf:'x',accountId:'a',clientId:'c',resource:ORIGIN,requested:SCOPES});
 assert.equal(AGREEMENTS.length,5);
 for(const [name] of AGREEMENTS)assert.match(html,new RegExp(`name="${name}" value="yes" required>`));
 assert.match(html,/name="product_email" value="yes">/);
 assert.match(html,/Privy/);assert.match(html,/ChatGPT/);assert.match(html,/NEAR Intents/);assert.match(html,/Terms of Service/);assert.match(html,/Privacy Policy/);
 assert.match(html,/<script type="module" src="\/account\/consent\.js"><\/script>/);
 assert.deepEqual(requireAgreements({...AGREED}),{product_email:false});
 assert.deepEqual(requireAgreements({...AGREED,product_email:'yes'}),{product_email:true});
 for(const [name] of AGREEMENTS)assert.throws(()=>requireAgreements({...AGREED,[name]:undefined}),/Required agreements/);
 const r=referralForm({csrf:'x'});
 assert.match(r,/value="WIN"/);assert.match(r,/>Let's win!<\/button>/);assert.match(r,/>Skip<\/button>/);
 assert.equal(referralCode({referral_action:'win',referral_code:' win42 '}),'WIN42');
 for(const code of ['bad-code!','X'.repeat(17),'','ÄB'])assert.equal(referralCode({referral_action:'win',referral_code:code}),null,code);
 assert.equal(referralCode({referral_action:'skip',referral_code:'WIN'}),null);
});

test('server rejects a consent POST missing any required agreement; no grant, no referral step',async()=>{
 const b=browser('agree-bob');
 const {page,csrf}=await b.toConsent();
 for(const [name] of AGREEMENTS){
  const r=await b.step(page,form({csrf,consent:'yes',...AGREED,[name]:'no'}));
  assert.equal(r.status,400,name);
 }
 assert.equal((await b.step(page,form({csrf,consent:'yes'}))).status,400);
 // Still on the consent prompt, and a referral POST before consent is refused.
 assert.equal((await (await b.step(page)).json()).prompt,'consent');
 assert.equal((await b.step(page,form({csrf,step:'referral',referral_action:'skip'}))).status,400);
});

test('referral screen: shown after consent on the same interaction, survives reload, stores a valid code once',async()=>{
 const b=browser('ref-carol');
 const {page,csrf,verifier}=await b.toConsent();
 let r=await b.step(page,form({csrf,consent:'yes',...AGREED,product_email:'yes',renewable_consent:'yes'}));
 assert.equal(r.status,303);assert.equal(local(r.headers.get('location')),local(page));
 let d=await (await b.step(page)).json();
 assert.deepEqual(d,{uid:d.uid,prompt:'referral',csrf,referral_code:'WIN'});
 // Reload, and a repeated consent submit, both land on the same screen; the CSRF check is the consent one.
 assert.equal((await (await b.step(page)).json()).prompt,'referral');
 r=await b.step(page,form({csrf,consent:'yes',...AGREED}));assert.equal(r.status,303);assert.equal(local(r.headers.get('location')),local(page));
 assert.equal((await b.step(page,form({csrf:'wrong',step:'referral',referral_action:'win',referral_code:'WIN'}))).status,403);
 r=await b.step(page,form({csrf,step:'referral',referral_action:'win',referral_code:'Win2'}));
 const token=await finish(b,r,verifier);
 const account=await accountOf(token);
 assert.equal(extras()[account].referral,'WIN2');assert.equal(extras()[account].product_email,true);assert.equal(extras()[account].referral_shown,true);
 // Token refresh does not touch the interaction or the stored record.
{
 assert.ok(token.refresh_token,'renewable consent carried through the referral step');
  const before=JSON.stringify(extras());
  const t=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token,client_id:'local-chatgpt-fixture'})})).json();
  assert.ok(t.access_token);assert.equal(JSON.stringify(extras()),before);
 }
 // A second authorization of the same account: consent goes straight back to ChatGPT, no referral screen.
 const again=await b.toConsent();
 r=await b.step(again.page,form({csrf:again.csrf,consent:'yes',...AGREED}));
 assert.equal(r.status,303);assert.notEqual(local(r.headers.get('location')),local(again.page));
 const second=await finish(b,r,again.verifier);
 assert.equal(await accountOf(second),account);
 assert.equal(extras()[account].referral,'WIN2');assert.equal(extras()[account].product_email,false);
});

test('Skip continues the flow and stores no code',async()=>{
 const b=browser('ref-dave');
 const {page,csrf,verifier}=await b.toConsent();
 assert.equal((await b.step(page,form({csrf,consent:'yes',...AGREED}))).status,303);
 assert.equal((await (await b.step(page)).json()).prompt,'referral');
 const token=await finish(b,await b.step(page,form({csrf,step:'referral',referral_action:'skip',referral_code:'ABC'})),verifier);
 const row=extras()[await accountOf(token)];
 assert.equal(row.referral,undefined);assert.equal(row.referral_shown,true);assert.equal(row.product_email,false);
});

test('an invalid referral string is ignored and the flow still completes',async()=>{
 for(const [did,code] of [['ref-erin','bad-code!'],['ref-frank','X'.repeat(17)]]){
  const b=browser(did);
  const {page,csrf,verifier}=await b.toConsent();
  assert.equal((await b.step(page,form({csrf,consent:'yes',...AGREED}))).status,303);
  const token=await finish(b,await b.step(page,form({csrf,step:'referral',referral_action:'win',referral_code:code})),verifier);
  const row=extras()[await accountOf(token)];
  assert.equal(row.referral,undefined,code);assert.equal(row.referral_shown,true);
 }
});

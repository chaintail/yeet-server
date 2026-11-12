// A-4 in-process: the sign-in server (38860), connector (38861), core (38862) and operator admin (38863) run in this
// process on 127.0.0.1 with throwaway state and service secrets; nothing outside the test's temp directory is touched.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const ORIGIN='https://chatgpt.yeet.win';
const PORTS={AS_PORT:38860,CONNECTOR_PORT:38861,CORE_PORT:38862,ADMIN_PORT:38863};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`,CONNECTOR=`http://127.0.0.1:${PORTS.CONNECTOR_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-acceptance-'));
const secrets=join(root,'secrets'),state=join(root,'state');
mkdirSync(secrets);mkdirSync(state);
for(const name of ['core-introspection','introspection','core-as','core-mcp','core-operator','operator','csrf'])
 writeFileSync(join(secrets,name),randomBytes(32).toString('base64url'),{mode:0o600});
Object.assign(process.env,{
 ISSUER:ORIGIN,RESOURCE:ORIGIN,AS_INTERNAL:AS,CORE_INTERNAL:`http://127.0.0.1:${PORTS.CORE_PORT}`,
 STATE_DIR:state,SECRETS_DIR:secrets,LISTEN_HOST:'127.0.0.1',TEST_PROFILE:'1',DEV_IDENTITY_STUB:'1',ACCESS_TTL:'300',
 ...Object.fromEntries(Object.entries(PORTS).map(([k,v])=>[k,String(v)])),
});
for(const name of ['PUBLIC_MODE','PRIVY_LOGIN','MOCK_PASSWORD_LOGIN','PUBLIC_BASE_URL','COOKIE_SECURE','TRUST_PROXY'])delete process.env[name];
const core=await import('../core/core.mjs');
const as=await import('../as/as.mjs');
const connector=await import('../mcp/mcp.mjs');
after(async()=>{
 for(const s of [connector.server,as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

const LISTED=['execute_trade','skeet_propose','trade_status','yeet_coins','yeet_home','yeet_portfolio','yeet_propose','yeet_quote'];
const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:trade'];
const local=url=>{const u=new URL(url,ORIGIN);return u.origin===ORIGIN?`${AS}${u.pathname}${u.search}`:u.href};
function jar(){const c=new Map();return {header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '),add(r){for(const s of r.headers.getSetCookie()){const p=s.split(';')[0],i=p.indexOf('=');c.set(p.slice(0,i),p.slice(i+1))}}}}
async function rpc(body,bearer){
 return fetch(CONNECTOR+'/',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(bearer?{authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(body)});
}

test('A-4: protected-resource metadata names the bare origin as resource and issuer with the yeet scopes',async()=>{
 const r=await fetch(CONNECTOR+'/.well-known/oauth-protected-resource');
 assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{resource:ORIGIN,authorization_servers:[ORIGIN],scopes_supported:SCOPES,bearer_methods_supported:['header']});
 assert.equal((await fetch(CONNECTOR+'/.well-known/oauth-protected-resource/mcp')).status,404);
});

test('A-4: unauthenticated POST / is 401 with resource_metadata pointing at the bare metadata path',async()=>{
 for(const bearer of [undefined,'not-a-real-token']){
  const r=await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},bearer);
  assert.equal(r.status,401);
  assert.equal(r.headers.get('www-authenticate'),`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
 }
});

test('A-4: authorization-server metadata has the issuer, S256 only and client id metadata documents on',async()=>{
 for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration']){
  const m=await (await fetch(AS+path)).json();
  assert.equal(m.issuer,ORIGIN,path);
  assert.deepEqual(m.code_challenge_methods_supported,['S256'],path);
  assert.equal(m.client_id_metadata_document_supported,true,path);
  for(const s of SCOPES)assert.ok(m.scopes_supported.includes(s),`${path} ${s}`);
 }
});

test('A-4: POST /mcp is 404 on the connector and on the sign-in server; GET /health is 200',async()=>{
 assert.equal((await fetch(CONNECTOR+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 assert.equal((await fetch(AS+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 const h=await fetch(CONNECTOR+'/health');assert.equal(h.status,200);assert.deepEqual(await h.json(),{ok:true});
 assert.equal((await fetch(CONNECTOR+'/',{method:'GET'})).status,405);
});

test('sign-in pages use yeet cookies and YEET titles; identity config is off without Privy',async()=>{
 const r=await fetch(AS+'/demo/login');
 assert.equal(r.status,200);
 assert.match(r.headers.getSetCookie().join(';'),/^yeet_login=[0-9a-f]{48}; HttpOnly; SameSite=Lax/);
 assert.match(await r.text(),/<title>Sign in to YEET \(local\)<\/title>/);
 assert.equal((await fetch(AS+'/demo/identity-config')).status,404);
 assert.equal((await fetch(AS+'/demo/api/profile')).status,404);
 const css=await fetch(AS+'/demo/auth-pages.css');assert.equal(css.status,200);
 // The sign-in bundle is served from login/dist once `npm run build:login` has run.
 if(existsSync(new URL('../login/dist/login.js',import.meta.url))){
  const js=await fetch(AS+'/demo/privy-login/login.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
 }
});

/** Signs in (development identity), consents to every scope and returns the token answer. */
let signedIn;
async function signIn(){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const redirect='http://127.0.0.1:38314/callback';
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1'});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=(body)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);assert.equal(r.status,303);
 // Login: the development identity stands in for a verified Privy token; core creates the account on first sign-in.
 let page=r.headers.get('location');let d=await (await step(page)).json();assert.equal(d.prompt,'login');assert.equal(d.identity,'YEET');
 r=await step(page,form({csrf:d.csrf,identity_token:'DEV:did:privy:acceptance-alice'}));assert.equal(r.status,303);
 r=await step(r.headers.get('location'));assert.equal(r.status,303);
 page=r.headers.get('location');d=await (await step(page)).json();assert.equal(d.prompt,'consent');
 assert.deepEqual(d.consent_selection,{trade_requested:true,requires_confirm:true});
 r=await step(page,form({csrf:d.csrf,consent:'yes',agree_wallet:'yes',agree_chatgpt:'yes',agree_near:'yes',agree_terms:'yes',agree_privacy:'yes'}));assert.equal(r.status,303);
 // A new account sees the referral screen once on the same interaction; Skip continues the flow.
 d=await (await step(r.headers.get('location'))).json();assert.equal(d.prompt,'referral');
 r=await step(page,form({csrf:d.csrf,step:'referral',referral_action:'skip',referral_code:'WIN'}));assert.equal(r.status,303);
 r=await step(r.headers.get('location'));assert.equal(r.status,303);
 const callback=new URL(r.headers.get('location'));assert.equal(callback.origin+callback.pathname,redirect);
 const code=callback.searchParams.get('code');assert.ok(code);
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,client_id:'local-chatgpt-fixture',resource:ORIGIN})})).json();
 assert.ok(token.access_token,JSON.stringify(Object.keys(token)));
 assert.deepEqual(token.scope.split(' ').sort(),['yeet:read','yeet:trade','yeet:write']);
 return token;
}
const token=()=>signedIn??=signIn();

test('A-4: a signed-in, consented token lists the P0 and P1 tools over HTTP, execute_trade hidden, yeet_coins live',async()=>{
 const tok=await token();
 // /me answers the resource-bound token with the new account's subject.
 const me=await (await fetch(AS+'/me',{headers:{authorization:`Bearer ${tok.access_token}`}})).json();
 assert.match(me.sub,/^yeet-privy-[a-zA-Z0-9_-]{22}$/);
 const list=await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},tok.access_token);
 assert.equal(list.status,200);
 const {result:{tools}}=await list.json();
 assert.deepEqual(tools.map(t=>t.name).sort(),LISTED);
 const exec=tools.find(t=>t.name==='execute_trade');
 assert.equal(exec._meta['openai/visibility'],'private');assert.deepEqual(exec._meta.ui.visibility,['app']);assert.equal(exec._meta['openai/widgetAccessible'],true);
 const call=async(name,args)=>(await (await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
 const coins=await call('yeet_coins',{});
 assert.equal(coins.isError,undefined);assert.ok(coins.structuredContent.coins.some(c=>c.symbol==='WIF'));
 // No Privy credentials in this process: the default delegated adapter cannot find wallets.
 const home=await call('yeet_home',{});
 assert.equal(home.isError,true);assert.equal(JSON.parse(home.content[0].text).error,'WALLET_NOT_READY');
 const trade=await call('execute_trade',{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)});
 assert.equal(JSON.parse(trade.content[0].text).error,'CONFIRMATION_REQUIRED');
 const templates=await (await rpc({jsonrpc:'2.0',id:4,method:'resources/list'},tok.access_token)).json();
 assert.deepEqual(templates.result.resources.map(x=>x.uri).sort(),['ui://yeet/basket-v1.html','ui://yeet/home-v1.html','ui://yeet/leaderboard-v1.html','ui://yeet/portfolio-v1.html','ui://yeet/receipt-v1.html']);
});

test('B-1 end to end through the connector with a real token: propose, quote, execute (fake signer), trade_status success',async()=>{
 const tok=await token();
 const call=async(name,args)=>(await (await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
 const {configureTradeEngine,tradeEngine}=await import('../core/trade/runtime.mjs');
 const {fakeOneClick,fakeSigner,fakeBalances}=await import('../core/trade/fakes.mjs');
 const oneclick=fakeOneClick(),signer=fakeSigner();
 configureTradeEngine({client:oneclick,signer,balances:fakeBalances(),env:{...process.env,YEET_LIVE:'1'},trackerIntervalMs:0});
 // The confirm code may appear only in result _meta["yeet/confirm"]: never in structuredContent or the text content.
 const modelSees=r=>JSON.stringify(r.structuredContent)+JSON.stringify(r.content);
 const cardOnly=r=>{const c=r._meta?.['yeet/confirm'];assert.match(c.code,/^[A-Za-z0-9_-]{43}$/);assert.ok(!modelSees(r).includes(c.code),'code leaked to the model');assert.doesNotMatch(modelSees(r),/"confirm"|yeet\/confirm/);return c};
 try{
  const home=await call('yeet_home',{});
  assert.equal(home.isError,undefined,JSON.stringify(home.content));assert.equal(home.structuredContent.ready,'ready');
  const p=await call('yeet_propose',{request_id:'e2e-1',amount_usdc:'20',legs:[{symbol:'WIF',parts:6},{symbol:'BOME',parts:4}]});
  assert.equal(p.isError,undefined,JSON.stringify(p.content));
  const c1=cardOnly(p);
  const q=await call('yeet_quote',{proposal_id:p.structuredContent.proposal_id,legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:5}]});
  const c2=cardOnly(q);assert.equal(q.structuredContent.revision,2);assert.notEqual(c2.code,c1.code);
  const stale=await call('execute_trade',{proposal_id:p.structuredContent.proposal_id,revision:1,confirm:c1.code});
  assert.equal(JSON.parse(stale.content[0].text).error,'CONFIRMATION_REQUIRED');
  const x=await call('execute_trade',{proposal_id:p.structuredContent.proposal_id,revision:2,confirm:c2.code});
  assert.equal(x.isError,undefined,JSON.stringify(x.content));
  assert.equal(x.structuredContent.status,'submitted');assert.equal(x._meta,undefined);assert.ok(!modelSees(x).includes(c2.code));
  assert.deepEqual(signer.sent.map(t=>t.amountRaw),['10000000','10000000']);
  // A price move at the tap: the requote's new code also goes to the card only.
  const p2=await call('yeet_propose',{request_id:'e2e-2',amount_usdc:'5',legs:[{symbol:'WIF',parts:10}]});
  oneclick.liveRatio=0.9;
  const rq=await call('execute_trade',{proposal_id:p2.structuredContent.proposal_id,revision:1,confirm:cardOnly(p2).code});
  assert.equal(rq.structuredContent.status,'requote_required');cardOnly(rq);
  oneclick.liveRatio=1;
  const engine=await tradeEngine();
  await engine.tracker.pollOnce();await engine.tracker.pollOnce();
  const st=await call('trade_status',{trade_id:x.structuredContent.trade_id});
  assert.equal(st.isError,undefined,JSON.stringify(st.content));
  assert.equal(st.structuredContent.status,'success');assert.deepEqual(st.structuredContent.received.map(r=>r.symbol),['WIF','BOME']);
  const port=await call('yeet_portfolio',{});assert.equal(port.isError,undefined,JSON.stringify(port.content));
 }finally{configureTradeEngine({})}
});

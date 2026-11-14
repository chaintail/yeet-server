// A-4 in-process: the sign-in server (38874), connector (38875), core (38876) and operator admin (38877; 38860-38861 are the deployed stack's host ports) run in this
// process on 127.0.0.1 with throwaway state and service secrets; nothing outside the test's temp directory is touched.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const ORIGIN='https://chatgpt.yeet.win';
const PORTS={AS_PORT:38874,CONNECTOR_PORT:38875,CORE_PORT:38876,ADMIN_PORT:38877};
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
// https://cimd.test/<name> answers with fixture client metadata documents (as.mjs, TEST only).
process.env.CIMD_TEST_FIXTURES='1';
// oidc-provider's notices about defaults it wants changed, and its warning about a body parsed upstream.
const providerNotices=[];
for(const level of ['info','warn']){const orig=console[level];console[level]=(m,...rest)=>{if(String(m).includes('oidc-provider'))providerNotices.push(String(m));orig(m,...rest)}}
const core=await import('../core/core.mjs');
const as=await import('../as/as.mjs');
const connector=await import('../mcp/mcp.mjs');
after(async()=>{
 for(const s of [connector.server,as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

const LISTED=['apply_referral','execute_trade','skeet_propose','submit_trade_signature','trade_status','yeet_accept_terms','yeet_coins','yeet_fund','yeet_home','yeet_overview','yeet_portfolio','yeet_profile','yeet_propose','yeet_quote','yeet_referral','yeet_set_username','yeet_terms'];
const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:prepare'];
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
 // JWT-shaped bearers (alg none, or RS256 with a junk signature) make the sign-in server answer 4xx; still 401.
 const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const jwtNone=`${b64({alg:'none',typ:'JWT'})}.${b64({sub:'x',aud:ORIGIN})}.`;
 const jwtJunk=`${b64({alg:'RS256',typ:'JWT',kid:'research-key-1'})}.${b64({sub:'x',aud:ORIGIN,exp:9999999999})}.${'A'.repeat(342)}`;
 for(const bearer of [undefined,'not-a-real-token',jwtNone,jwtJunk]){
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

test('registration stores only ChatGPT clients; other redirect hosts get 400 and nothing is stored',async()=>{
 const reg=(redirect_uris)=>fetch(AS+'/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],application_type:'web'})});
 const good=await reg(['https://chatgpt.com/connector_platform_oauth_redirect']);
 assert.equal(good.status,201);const c=await good.json();assert.ok(c.client_id);
 for(const uris of [['https://evil.example/cb'],['https://chatgpt.com.evil.example/cb'],['http://localhost:3000/cb'],['https://chatgpt.com/ok','https://evil.example/cb'],['https://chatgpt.com/some/other/path']]){
  const r=await reg(uris);assert.equal(r.status,400,JSON.stringify(uris));assert.equal((await r.json()).error,'invalid_redirect_uri');
 }
 const r=await fetch(AS+'/reg',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'redirect_uris=https%3A%2F%2Fevil.example%2Fcb'});
 assert.equal(r.status,400);
});

test('provider errors use the YEET page; no x-powered-by on any server; favicon served',async()=>{
 const bad=await fetch(AS+'/auth?'+new URLSearchParams({client_id:'no-such-client',response_type:'code',redirect_uri:'https://evil.example/cb',scope:'openid',code_challenge:'x'.repeat(43),code_challenge_method:'S256'}));
 assert.equal(bad.status,400);assert.match(bad.headers.get('content-type'),/text\/html/);
 const body=await bad.text();
 assert.match(body,/<title>Connection refused<\/title>/);assert.match(body,/href="\/account\/auth-pages\.css"/);assert.match(body,/Error code: invalid_client/);
 assert.doesNotMatch(body,/oops|fonts\.googleapis|something went wrong/i);
 const core=`http://127.0.0.1:${PORTS.CORE_PORT}`,admin=`http://127.0.0.1:${PORTS.ADMIN_PORT}`;
 for(const url of [AS+'/account/login',AS+'/nope',CONNECTOR+'/health',CONNECTOR+'/',core+'/health',admin+'/policy'])
  assert.equal((await fetch(url)).headers.get('x-powered-by'),null,url);
 const icon=await fetch(AS+'/favicon.ico');assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/image\/svg\+xml/);
 assert.equal((await fetch(AS+'/account/icon.svg')).status,200);
 assert.match(await (await fetch(AS+'/account/login')).text(),/<link rel="icon" type="image\/svg\+xml" href="\/account\/icon\.svg">/);
});

test('A-4: POST /mcp is 404 on the connector and on the sign-in server; GET /health is 200',async()=>{
 assert.equal((await fetch(CONNECTOR+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 assert.equal((await fetch(AS+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
 const h=await fetch(CONNECTOR+'/health');assert.equal(h.status,200);assert.deepEqual(await h.json(),{ok:true});
 assert.equal((await fetch(CONNECTOR+'/',{method:'GET'})).status,405);
});

test('GET /version: public deployment facts, cached 60 s, no secret or internal host',async()=>{
 const {vendoredPin}=await import('../core/version.mjs');
 const r=await fetch(CONNECTOR+'/version');
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'public, max-age=60');
 const raw=await r.text(),v=JSON.parse(raw);
 assert.deepEqual(Object.keys(v),['service','server_commit','yeet_win_commit','trading','limits','catalog_coins']);
 assert.equal(v.service,'yeet');assert.equal(v.yeet_win_commit,vendoredPin());assert.match(v.yeet_win_commit,/^[0-9a-f]{40}$/);
 assert.equal(v.trading,'paused');
 // max_trade / daily_cap are the global ceilings (the VIP caps by default); tiers are the BUY caps by XP (trade/limits.mjs).
 assert.deepEqual(v.limits,{max_trade_usdc:'500',daily_cap_usdc:'6767',min_leg_usdc:'3',tiers:[{name:'Noob',min_xp:0,max_trade_usdc:'25',daily_cap_usdc:'100'},{name:'Winner',min_xp:69,max_trade_usdc:'100',daily_cap_usdc:'420'},{name:'VIP',min_xp:1001,max_trade_usdc:'500',daily_cap_usdc:'6767'}]});
 assert.ok(Number.isInteger(v.catalog_coins)&&v.catalog_coins>0);
 assert.doesNotMatch(raw,/127\.0\.0\.1|localhost|core:|as:|http:/);
 assert.equal((await fetch(CONNECTOR+'/version',{headers:{authorization:'Bearer x'}})).status,200);
});

test('sign-in pages use yeet cookies and YEET titles; identity config is off without Privy',async()=>{
 const r=await fetch(AS+'/account/login');
 assert.equal(r.status,200);
 assert.match(r.headers.getSetCookie().join(';'),/^yeet_login=[0-9a-f]{48}; HttpOnly; SameSite=Lax/);
 assert.match(await r.text(),/<title>Sign in to YEET \(local\)<\/title>/);
 assert.equal((await fetch(AS+'/account/identity-config')).status,404);
 assert.equal((await fetch(AS+'/account/api/profile')).status,404);
 const css=await fetch(AS+'/account/auth-pages.css');assert.equal(css.status,200);
 // Without a session /account/ never says the person is signed in; it sends them to the sign-in page.
 const home=await fetch(AS+'/account/',{redirect:'manual'});assert.equal(home.status,303);assert.equal(home.headers.get('location'),'/account/login');
 // The old route prefix is gone, with no alias left behind.
 for(const p of ['/demo/login','/demo/','/demo/auth-pages.css','/demo/identity-config','/demo/privy-login/login.js'])assert.equal((await fetch(AS+p,{redirect:'manual'})).status,404,p);
 // The sign-in bundle is served from login/dist once `npm run build:login` has run.
 if(existsSync(new URL('../login/dist/login.js',import.meta.url))){
  const js=await fetch(AS+'/account/privy-login/login.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
 }
});

/** Signs in (development identity), consents to every scope and returns the token answer. */
let signedIn;
/** scopes: what the client asks for (an older client still asks for yeet:trade). terms: accept the YEET terms through
 * the connector afterwards, as the assistant does once the person agreed (false: the account has not accepted). */
async function signIn({clientId='local-chatgpt-fixture',redirect='http://127.0.0.1:38314/callback',identity='DEV:did:privy:acceptance-alice',prompt,scopes=SCOPES,terms=true}={}){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',scope:scopes.join(' '),resource:ORIGIN,state:'s1',...(prompt?{prompt}:{})});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=(body)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);assert.equal(r.status,303);
 // Login: the development identity stands in for a verified Privy token; core creates the account on first sign-in.
 let page=r.headers.get('location');let d=await (await step(page)).json();assert.equal(d.prompt,'login');assert.equal(d.identity,'YEET');
 r=await step(page,form({csrf:d.csrf,identity_token:identity}));assert.equal(r.status,303);
 r=await step(r.headers.get('location'));assert.equal(r.status,303);
 page=r.headers.get('location');
 const next=await step(page);
 // ChatGPT (its connector redirect URI) after a sign-in inside this authorization: no connect page, straight back.
 const chatgpt=/^https:\/\/chatgpt\.com\//.test(redirect);
 if(chatgpt){assert.equal(next.status,303,'no screen between the sign-in and the redirect');r=next}
 else{
  // Any other client gets the connect page: one press, no agreements, no other screen.
  d=await next.json();assert.equal(d.prompt,'consent');
  assert.deepEqual(d.consent_selection,{prepare_requested:true,requires_confirm:true});
  r=await step(page,form({csrf:d.csrf,consent:'yes'}));assert.equal(r.status,303);
 }
 r=await step(r.headers.get('location'));assert.equal(r.status,303);
 const callback=new URL(r.headers.get('location'));assert.equal(callback.origin+callback.pathname,redirect);
 const code=callback.searchParams.get('code');assert.ok(code);
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,client_id:clientId,resource:ORIGIN})})).json();
 assert.ok(token.access_token,JSON.stringify(Object.keys(token)));
 assert.deepEqual(token.scope.split(' ').sort(),scopes.filter(s=>s.startsWith('yeet:')).sort());
 if(terms){
  const {TERMS_VERSION,REQUIRED_IDS}=await import('../core/terms.mjs');
  const a=(await (await rpc({jsonrpc:'2.0',id:90,method:'tools/call',params:{name:'yeet_accept_terms',arguments:{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}}},token.access_token)).json()).result;
  assert.equal(a.isError,undefined,JSON.stringify(a.content));
 }
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
 const served=templates.result.resources.map(x=>x.uri).sort();
 assert.deepEqual(served,Object.values((await import('../mcp/tool-contract.mjs')).CARDS).map(c=>c.uri).sort(),'one template per contract card');
 for(const uri of ['ui://yeet/overview-v1.html','ui://yeet/basket-v1.html','ui://yeet/home-v1.html','ui://yeet/leaderboard-v1.html','ui://yeet/portfolio-v1.html','ui://yeet/receipt-v1.html'])assert.ok(served.includes(uri),uri);
});

test('B-1 end to end through the connector with a real token: propose, quote, execute, the wallet signs, submit_trade_signature, trade_status success',async()=>{
 const tok=await token();
 const call=async(name,args)=>(await (await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
 const {configureTradeEngine,tradeEngine}=await import('../core/trade/runtime.mjs');
 const {fakeRuntime,signAs}=await import('../core/pipeline/fakes.mjs');
 const f=fakeRuntime(),{oneclick,rpc:chain,feePayer,wallet}=f;
 configureTradeEngine(f.overrides);
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
  assert.equal(x.structuredContent.status,'awaiting_signature');assert.deepEqual(Object.keys(x._meta),['yeet/build']);assert.ok(!modelSees(x).includes(c2.code));
  const reqs=x.structuredContent.sign_requests;
  // The Solana basket is ONE transaction: one sign request naming both legs (the contract's legs / leg_summaries
  // pass the vendored output schema).
  assert.deepEqual(reqs.map(r=>[r.kind,r.wallet,r.summary.amount_raw,r.legs]),[['solana_tx',wallet.address,'10000000',[0,1]]]);
  assert.deepEqual(reqs[0].leg_summaries.map(s=>[s.leg,s.amount_raw]),[[0,'10000000'],[1,'10000000']]);
  assert.equal(feePayer.calls,0,'nothing is co-signed before the person signs');
  // The card hands the signed bytes to submit_trade_signature once per request; the fee payer co-signs only then.
  const hashes=[];
  for(const r of reqs){
   const s=await call('submit_trade_signature',{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(wallet,r)});
   assert.equal(s.isError,undefined,JSON.stringify(s.content));
   assert.deepEqual(s.structuredContent.legs.map(l=>l.send_status),['signing','signing']);hashes.push(s.structuredContent.legs[r.leg].tx_hash);
   assert.equal(s.structuredContent.legs[1].tx_hash,s.structuredContent.legs[0].tx_hash);
  }
  assert.equal(feePayer.calls,1);assert.equal(chain.sent.length,1);
  // A leg inside `legs` that is not the anchor is refused (submit names the request's leg).
  const notAnchor=await call('submit_trade_signature',{trade_id:reqs[0].trade_id,leg:1,attempt_id:reqs[0].attempt_id,signed:signAs(wallet,reqs[0])});
  assert.equal(JSON.parse(notAnchor.content[0].text).error,'INVALID_ARGUMENT');
  // A repeated submit with the same bytes answers the stored hash: no second co-sign; at most the same bytes again.
  const again=await call('submit_trade_signature',{trade_id:reqs[0].trade_id,leg:reqs[0].leg,attempt_id:reqs[0].attempt_id,signed:signAs(wallet,reqs[0])});
  assert.equal(again.isError,undefined,JSON.stringify(again.content));assert.equal(feePayer.calls,1);
  assert.equal(again.structuredContent.legs[reqs[0].leg].tx_hash,hashes[0]);
  assert.equal(new Set(chain.sent).size,1,'a replay never sends new bytes');
  f.confirmSent();
  // A price move at the tap: the requote's new code also goes to the card only.
  const p2=await call('yeet_propose',{request_id:'e2e-2',amount_usdc:'5',legs:[{symbol:'WIF',parts:10}]});
  oneclick.liveRatio=0.9;
  const rq=await call('execute_trade',{proposal_id:p2.structuredContent.proposal_id,revision:1,confirm:cardOnly(p2).code});
  assert.equal(rq.structuredContent.status,'requote_required');cardOnly(rq);
  oneclick.liveRatio=1;
  const engine=await tradeEngine();
  await engine.tracker.pollOnce();await engine.tracker.pollOnce();await engine.tracker.pollOnce();
  const st=await call('trade_status',{trade_id:x.structuredContent.trade_id});
  assert.equal(st.isError,undefined,JSON.stringify(st.content));
  assert.equal(st.structuredContent.status,'success');assert.deepEqual(st.structuredContent.received.map(r=>r.symbol),['WIF','BOME']);
  const port=await call('yeet_portfolio',{});assert.equal(port.isError,undefined,JSON.stringify(port.content));
 }finally{configureTradeEngine({})}
});

test('card signing: signer script and /sign page on the public origin; the page signs only its own account\'s trade',async()=>{
 const tok=await token();
 const call=async(name,args)=>(await (await rpc({jsonrpc:'2.0',id:6,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
 const {configureTradeEngine}=await import('../core/trade/runtime.mjs');
 const {fakeRuntime,signAs}=await import('../core/pipeline/fakes.mjs');
 const {accountCount}=await import('../core/identity-store.mjs');
 const {signerAsset}=await import('#shared/signing.mjs');
 const asset=signerAsset();
 const page=(path,body)=>fetch(AS+'/sign/api/'+path,{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify(body)});
 const f=fakeRuntime(),{feePayer,wallet}=f;
 configureTradeEngine(f.overrides);
 process.env.PRIVY_APP_ID='cmzyxwvutsrqponmlkjihgfed';
 try{
  // The connector tells the card where the signer and the page are (RESOURCE is the public origin here).
  const p=await call('yeet_propose',{request_id:'sign-1',amount_usdc:'10',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:5}]});
  assert.deepEqual(p._meta['yeet/signer'],{privy_app_id:'cmzyxwvutsrqponmlkjihgfed',script_url:`${ORIGIN}${asset.path}`,sign_page_url:`${ORIGIN}/sign`});
  const x=await call('execute_trade',{proposal_id:p.structuredContent.proposal_id,revision:1,confirm:p._meta['yeet/confirm'].code});
  assert.equal(x.structuredContent.status,'awaiting_signature',JSON.stringify(x.content));
  assert.equal(x._meta['yeet/signer'].script_url,`${ORIGIN}${asset.path}`);
  const id=x.structuredContent.trade_id,reqs=x.structuredContent.sign_requests;
  // The sign-in server serves the script and the page on the same origin.
  const js=await fetch(AS+asset.path);assert.equal(js.status,200);assert.equal(js.headers.get('access-control-allow-origin'),'*');
  const html=await (await fetch(`${AS}/sign?trade_id=${id}`)).text();
  assert.match(html,new RegExp(`data-app-id="cmzyxwvutsrqponmlkjihgfed" data-trade-id="${id}"`));assert.match(html,new RegExp(asset.path.replace('.','\\.')));
  // The person signed in on the page as the same Privy user: the same open requests as the card got.
  const alice={trade_id:id,identity_token:'DEV:did:privy:acceptance-alice'};
  const open=await page('requests',alice);assert.equal(open.status,200);
  const o=await open.json();
  assert.deepEqual(o.sign_requests.map(r=>r.attempt_id),reqs.map(r=>r.attempt_id));
  assert.deepEqual(o.legs.map(l=>[l.symbol,l.send_status]),[['WIF','awaiting_signature'],['BOME','awaiting_signature']]);
  // Another existing account, an identity with no account, a forged credential: refused, nothing created.
  await signIn({identity:'DEV:did:privy:acceptance-bob'});
  const n=accountCount();
  for(const [identity_token,status] of [['DEV:did:privy:acceptance-bob',404],['DEV:did:privy:acceptance-nobody',404],['not-a-credential',401]]){
   const r=await page('requests',{trade_id:id,identity_token});assert.equal(r.status,status,identity_token);
   const s=await page('signature',{trade_id:id,identity_token,leg:0,attempt_id:reqs[0].attempt_id,signed:signAs(wallet,reqs[0])});assert.equal(s.status,status,identity_token);
  }
  assert.equal(accountCount(),n,'the page never creates an account');
  assert.equal(feePayer.calls,0,'nothing was co-signed for a refused caller');
  assert.equal((await fetch(AS+'/sign/api/requests',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:JSON.stringify(alice)})).status,403);
  // The page submits each request (here one, paying both legs) through the same engine call as the card.
  assert.deepEqual(o.sign_requests.map(r=>r.legs),[[0,1]]);
  for(const r of o.sign_requests){
   const s=await page('signature',{...alice,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(wallet,r)});
   assert.equal(s.status,200);assert.deepEqual((await s.json()).legs.map(l=>l.send_status),['signing','signing']);
  }
  assert.equal(feePayer.calls,1);
  // Nothing left to sign; the card reads the same trade through trade_status.
  assert.deepEqual((await (await page('requests',alice)).json()).sign_requests,[]);
  const st=await call('trade_status',{trade_id:id});assert.equal(st.isError,undefined,JSON.stringify(st.content));assert.equal(st.structuredContent.trade_id,id);
  assert.ok(st._meta['yeet/signer']);
 }finally{delete process.env.PRIVY_APP_ID;configureTradeEngine({})}
});

test('operator trades (ops/first-trade.mjs): only with the operator secret, only for an account in YEET_LIVE_ACCOUNTS, same engine',async()=>{
 const tok=await token();
 const me=await (await fetch(AS+'/me',{headers:{authorization:`Bearer ${tok.access_token}`}})).json();
 const CORE_URL=`http://127.0.0.1:${PORTS.CORE_PORT}`;
 const {readFileSync}=await import('node:fs');
 const as=(role,path,body)=>fetch(CORE_URL+path,{method:'POST',headers:{authorization:`Bearer ${readFileSync(join(secrets,role),'utf8').trim()}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const op=(path,body)=>as('core-operator',path,body);
 const {configureTradeEngine}=await import('../core/trade/runtime.mjs');
 const {fakeRuntime}=await import('../core/pipeline/fakes.mjs');
 const basket={request_id:'op-1',amount_usdc:'5',legs:[{symbol:'WIF',parts:10}]};
 const setup=extra=>{const f=fakeRuntime({env:{BASE_RPC_URL:'',...extra}});configureTradeEngine(f.overrides);return f};
 try{
  // No allowlist: the operator can read, never trade.
  setup({});
  assert.equal((await as('core-mcp','/operator/trading',{account:me.sub})).status,403,'only the operator role');
  assert.equal((await op('/operator/trading',{account:'yeet-privy-nobody'})).status,400);
  assert.deepEqual(await (await op('/operator/trading',{account:me.sub})).json(),{trading:'live',live:true,kill_switch:false,scope:'all',live_accounts:0,account_allowed:false,operator_trades:false,
   signing:'user_wallet',buy_chain:'auto',sell_chain:'sol',drivers:{sol:{ok:true,reasons:[]},base:{ok:false,reasons:['BASE_RPC_NOT_CONFIGURED']}}});
  const refused=await op('/operator/trades/propose',{account:me.sub,...basket});
  assert.equal(refused.status,403);assert.equal((await refused.json()).error,'TRADING_PAUSED');
  // Listed: propose, execute with the minted code, follow the status; the trade is the engine's own.
  const f=setup({YEET_LIVE_ACCOUNTS:me.sub});
  assert.equal((await (await op('/operator/trading',{account:me.sub})).json()).operator_trades,true);
  assert.equal((await op('/operator/trades/propose',{account:me.sub,...basket,extra:1})).status,400,'contract input only');
  const p=await (await op('/operator/trades/propose',{account:me.sub,...basket})).json();
  assert.match(p.proposal_id,/^p_/);assert.match(p.confirm.code,/^[A-Za-z0-9_-]{43}$/);
  const x=await (await op('/operator/trades/execute',{account:me.sub,proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code})).json();
  // The operator route never signs: it answers the sign request the person's wallet must sign.
  assert.equal(x.status,'awaiting_signature');assert.deepEqual(x.sign_requests.map(r=>r.summary.amount_raw),['5000000']);
  assert.equal(f.feePayer.calls,0);assert.equal(f.rpc.sent.length,0);
  const st=await (await op('/operator/trades/status',{account:me.sub,trade_id:x.trade_id})).json();
  assert.equal(st.trade_id,x.trade_id);assert.ok(Array.isArray(st.record.events)&&st.record.events.some(e=>e.to==='awaiting_signature'));
  assert.equal(st.record.proposal_id,p.proposal_id);
  // The engine's own code check: the code is single use; presenting it again replays the same trade.
  const again=await (await op('/operator/trades/execute',{account:me.sub,proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code})).json();
  assert.equal(again.trade_id,x.trade_id);assert.equal(again.sign_requests[0].attempt_id,x.sign_requests[0].attempt_id,'a replayed code answers the same open attempt');
  assert.equal(f.rpc.sent.length,0,'a replayed code sends nothing');
  assert.equal((await op('/operator/trades/status',{account:me.sub,trade_id:'t_nope'})).status,409);
  // Trading off again (allowlist removed): status stays readable, nothing new can start.
  setup({});
  assert.equal((await op('/operator/trades/status',{account:me.sub,trade_id:x.trade_id})).status,200);
  assert.equal((await op('/operator/trades/execute',{account:me.sub,proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code})).status,403);
 }finally{configureTradeEngine({})}
});

test('add funds: sign-in carries only the fund return target; /fund is off without the Privy sign-in',async()=>{
 assert.equal((await fetch(AS+'/fund',{redirect:'manual'})).status,404);
 const cookies=jar();
 const page=async(path)=>{const r=await fetch(AS+path,{headers:{cookie:cookies.header()}});cookies.add(r);return r.text()};
 assert.match(await page('/account/login?next=fund'),/<input type="hidden" name="next" value="fund">/);
 assert.doesNotMatch(await page('/account/login?next=https%3A%2F%2Fexample.com'),/name="next"/);
 const csrf=(await page('/account/login?next=fund')).match(/name="csrf" value="([0-9a-f]+)"/)[1];
 const r=await fetch(AS+'/account/login',{method:'POST',redirect:'manual',headers:{cookie:cookies.header(),origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,next:'fund',identity_token:'DEV:did:privy:acceptance-fund'})});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/fund');
});

const STABLE='https://chatgpt.com/connector_platform_oauth_redirect';
const register=async(extra={})=>{const r=await fetch(AS+'/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[STABLE],response_types:['code'],grant_types:['authorization_code','refresh_token'],application_type:'web',...extra})});return {status:r.status,body:await r.json()}};
const authorize=(clientId,redirect=STABLE)=>fetch(AS+'/auth?'+new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,scope:SCOPES.join(' '),resource:ORIGIN,code_challenge:'x'.repeat(43),code_challenge_method:'S256',state:'s'}),{redirect:'manual'});
async function clientRow(id){const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(state,'oauth.sqlite'),{readOnly:true});try{return db.prepare("SELECT expires_at FROM models WHERE model='Client' AND id=?").get(id)}finally{db.close()}}

test('discovery advertises only what ChatGPT uses: code + refresh, none and private_key_jwt, no end-session',async()=>{
 for(const path of ['/.well-known/oauth-authorization-server','/.well-known/openid-configuration']){
  const m=await (await fetch(AS+path)).json();
  assert.deepEqual(m.grant_types_supported.sort(),['authorization_code','refresh_token'],path);
  assert.deepEqual(m.response_types_supported,['code'],path);
  assert.deepEqual(m.token_endpoint_auth_methods_supported,['none','private_key_jwt'],path);
  assert.ok(!m.token_endpoint_auth_signing_alg_values_supported?.some(a=>a.startsWith('HS')),path);
  assert.equal(m.end_session_endpoint,undefined,path);
  assert.equal(m.authorization_response_iss_parameter_supported,true,path);
 }
 assert.equal((await fetch(AS+'/session/end')).status,404);
 assert.equal((await fetch(AS+'/session/end',{method:'POST'})).status,404);
});

test("ChatGPT's client metadata document (verbatim shape, private_key_jwt, jwt-bearer listed) still reaches sign-in",async()=>{
 const r=await authorize('https://cimd.test/chatgpt');
 assert.equal(r.status,303,await r.clone().text());
 const page=new URL(r.headers.get('location'),ORIGIN);assert.match(page.pathname,/^\/interaction\//);
 const d=await (await fetch(AS+page.pathname,{headers:{cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')}})).json();
 assert.equal(d.prompt,'login');assert.equal(d.client_auth_method,'private_key_jwt');
});

test('registration: public client by default, shared-secret methods refused, no secret issued',async()=>{
 const plain=await register();assert.equal(plain.status,201);
 assert.equal(plain.body.token_endpoint_auth_method,'none');assert.equal(plain.body.client_secret,undefined);
 for(const method of ['client_secret_basic','client_secret_post','client_secret_jwt']){
  const r=await register({token_endpoint_auth_method:method});assert.equal(r.status,400,method);assert.equal(r.body.error,'invalid_client_metadata',method);
 }
 const implicit=await register({response_types:['id_token'],grant_types:['implicit']});assert.equal(implicit.status,400);
 const cb=await register({redirect_uris:['https://chatgpt.com/connector/oauth/cb_1-2']});assert.equal(cb.status,201);
});

test('a registered client that never completes an authorization expires after 1 hour; one that does is kept',async()=>{
 const {PENDING_CLIENT_TTL}=await import('../as/adapter.mjs');assert.equal(PENDING_CLIENT_TTL,3600);
 const idle=(await register()).body.client_id;
 const row=await clientRow(idle);assert.ok(Math.abs(row.expires_at-(Date.now()+3600000))<60000,JSON.stringify(row));
 assert.equal((await authorize(idle)).status,303);
 // An hour later: the client is gone and the authorization request is refused.
 {const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(state,'oauth.sqlite'));db.prepare("UPDATE models SET expires_at=? WHERE model='Client' AND id=?").run(Date.now()-1,idle);db.close()}
 const gone=await authorize(idle);assert.equal(gone.status,400);assert.match(await gone.text(),/Error code: invalid_client/);
 // The next registration deletes the expired row.
 const used=(await register()).body.client_id;
 assert.equal(await clientRow(idle),undefined);
 // A client that redeems a code is kept for good. prompt=consent makes the provider honour offline_access for a
 // registered client, so this also checks a refresh that carries ChatGPT's scope parameter through /token.
 const tok=await signIn({clientId:used,redirect:STABLE,identity:'DEV:did:privy:acceptance-dcr',prompt:'consent'});
 assert.equal((await clientRow(used)).expires_at,null);
 assert.ok(tok.refresh_token);
 const refreshed=await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tok.refresh_token,client_id:used,resource:ORIGIN,scope:[...SCOPES,'yeet:unlisted'].join(' ')})});
 const body=await refreshed.json();assert.equal(refreshed.status,200,JSON.stringify(body));assert.ok(body.access_token);
});

test('terms in the chat, end to end: gated until accepted, the overview answers, a missing statement and an old version are refused, then everything works',async()=>{
 const {TERMS_VERSION,REQUIRED_IDS,STATEMENTS}=await import('../core/terms.mjs');
 const tok=await signIn({identity:'DEV:did:privy:acceptance-terms',terms:false});
 const call=async(name,args={})=>(await (await rpc({jsonrpc:'2.0',id:31,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
 const refused=r=>{assert.equal(r.isError,true);return JSON.parse(r.content[0].text)};
 // Every tool that does something for the person is refused with the terms; nothing reaches the engine.
 for(const [name,args] of [['yeet_home',{}],['yeet_coins',{}],['yeet_portfolio',{}],['yeet_fund',{}],['yeet_referral',{}],['trade_status',{trade_id:'t_abcdefghij0123456789'}],
  ['yeet_propose',{request_id:'11111111-1111-4111-8111-111111111111',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}],['execute_trade',{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)}]]){
  const b=refused(await call(name,args));
  assert.equal(b.error,'TERMS_REQUIRED',name+': '+JSON.stringify(b).slice(0,160));assert.equal(b.terms.accepted,false);assert.equal(b.terms.version,TERMS_VERSION);
  assert.deepEqual(b.terms.statements.map(s=>s.id),STATEMENTS.map(s=>s.id));assert.match(b.guidance,/YEET/);assert.doesNotMatch(b.guidance,/unlock|device|6-digit/i);
 }
 // The overview and the terms themselves answer.
 // (This fixture account has no wallets, so the overview itself answers WALLET_NOT_READY: the point here is that the
 // terms gate does not stand in front of it. Its terms block and first suggestion: mcp/scripts/terms-test.mjs.)
 const ov=await call('yeet_overview');assert.notEqual(ov.isError&&JSON.parse(ov.content[0].text).error,'TERMS_REQUIRED');
 assert.equal((await call('yeet_terms')).structuredContent.terms.accepted,false);
 // Refused: a required statement missing; another version. Nothing is recorded.
 assert.deepEqual(refused(await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:REQUIRED_IDS.filter(id=>id!=='privacy')})).missing,['privacy']);
 assert.equal(refused(await call('yeet_accept_terms',{version:'2026-10-01',confirmed:[...REQUIRED_IDS]})).error,'TERMS_REQUIRED');
 assert.equal(refused(await call('yeet_home')).error,'TERMS_REQUIRED');
 // Accepted: recorded, the overview comes back, and the tools answer.
 const ok=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS,'product_email']});
 assert.equal(ok.isError,undefined,JSON.stringify(ok.content));assert.equal(ok.structuredContent.terms.accepted,true);assert.ok(ok.structuredContent.terms.accepted_at);
 assert.ok('overview' in ok.structuredContent,'the overview rides along (null when it cannot be read just now; the acceptance stands)');
 assert.equal((await call('yeet_terms')).structuredContent.terms.accepted,true);
 const home=await call('yeet_home');assert.notEqual(home.isError&&JSON.parse(home.content[0].text).error,'TERMS_REQUIRED');
 {const c=await call('yeet_coins');assert.notEqual(c.isError&&JSON.parse(c.content[0].text).error,'TERMS_REQUIRED')}
 // The win code card's tools: open, then applied once.
 assert.deepEqual((await call('yeet_referral')).structuredContent.status,'open');
 const applied=await call('apply_referral',{code:'win',card_build:(await import('../mcp/refresh.mjs')).CARD_BUILD});
 assert.deepEqual([applied.structuredContent.status,applied.structuredContent.code],['applied','WIN']);
 assert.deepEqual((await call('yeet_referral')).structuredContent.status,'applied');
 // Another account is still asked.
 const other=await signIn({identity:'DEV:did:privy:acceptance-terms-2',terms:false});
 const b=JSON.parse((await (await rpc({jsonrpc:'2.0',id:32,method:'tools/call',params:{name:'yeet_home',arguments:{}}},other.access_token)).json()).result.content[0].text);
 assert.equal(b.error,'TERMS_REQUIRED');
});

test('the account\'s terms link, end to end: the core signs it, the page accepts with no sign-in, and only for that account',async()=>{
 const {TERMS_VERSION,REQUIRED_IDS}=await import('../core/terms.mjs');
 const {acceptanceOf}=await import('../core/terms-store.mjs');
 const tok=await signIn({identity:'DEV:did:privy:acceptance-terms-link',terms:false});
 const other=await signIn({identity:'DEV:did:privy:acceptance-terms-other',terms:false});
 const call=async(name,t=tok)=>(await (await rpc({jsonrpc:'2.0',id:41,method:'tools/call',params:{name,arguments:{}}},t.access_token)).json()).result;
 const terms=(await call('yeet_terms')).structuredContent.terms;
 assert.equal(terms.accepted,false);
 assert.match(terms.page_url,/^https:\/\/chatgpt\.yeet\.win\/account\/terms\?t=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
 assert.ok(terms.page_url.length<=508);
 const t=new URL(terms.page_url).searchParams.get('t');
 const claims=JSON.parse(Buffer.from(t.split('.')[1],'base64url'));
 assert.equal(claims.p,'terms');assert.equal(claims.v,TERMS_VERSION);assert.match(claims.a,/^yeet-privy-/);
 const now=Math.floor(Date.now()/1000);assert.ok(claims.e>now+590&&claims.e<=now+600,'10 minutes');
 // The refusal of a gated tool carries the same account's link; another account's link names another account.
 const gated=JSON.parse((await call('yeet_home')).content[0].text);
 assert.equal(gated.error,'TERMS_REQUIRED');
 assert.equal(JSON.parse(Buffer.from(new URL(gated.terms.page_url).searchParams.get('t').split('.')[1],'base64url')).a,claims.a);
 const theirs=new URL((await call('yeet_terms',other)).structuredContent.terms.page_url).searchParams.get('t');
 const otherAccount=JSON.parse(Buffer.from(theirs.split('.')[1],'base64url')).a;
 assert.notEqual(otherAccount,claims.a);
 // The page, with no cookie at all: the statements and Accept.
 const page=await fetch(AS+'/account/terms?t='+t,{redirect:'manual'});
 assert.equal(page.status,200);assert.equal(page.headers.get('set-cookie'),null);
 const html=await page.text();
 assert.match(html,/<button type="submit">Accept<\/button>/);assert.match(html,/You are at least 18/);
 // Their payload under our signature, and our payload cut short: the sign-in page, nothing recorded.
 const forged=`v1.${theirs.split('.')[1]}.${t.split('.')[2]}`;
 for(const bad of [forged,t.slice(0,-1),'']){
  const r=await fetch(AS+'/account/terms?t='+bad,{redirect:'manual'});
  assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/account/login?next=terms');
  const p=await fetch(AS+'/account/terms',{method:'POST',redirect:'manual',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({t:bad,version:TERMS_VERSION})});
  assert.notEqual(p.status,200);
 }
 assert.equal(acceptanceOf(claims.a,TERMS_VERSION),null);assert.equal(acceptanceOf(otherAccount,TERMS_VERSION),null);
 // Accept: recorded for the token's account, source page, through the link; the other account is untouched.
 const done=await fetch(AS+'/account/terms',{method:'POST',redirect:'manual',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({t,version:TERMS_VERSION})});
 assert.equal(done.status,200);assert.equal(done.headers.get('set-cookie'),null,'no session comes with it');
 assert.match(await done.text(),/Done\. You accepted the YEET terms\.<\/p><p>Go back to ChatGPT/);
 const row=acceptanceOf(claims.a,TERMS_VERSION);
 assert.equal(row.source,'page');assert.equal(row.client_id,'terms-link');assert.deepEqual(row.statements,[...REQUIRED_IDS]);
 assert.equal(acceptanceOf(otherAccount,TERMS_VERSION),null);
 // Reuse: the first acceptance stands.
 const again=await fetch(AS+'/account/terms',{method:'POST',redirect:'manual',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({t,version:TERMS_VERSION,agree_product_email:'yes'})});
 assert.equal(again.status,200);assert.equal(acceptanceOf(claims.a,TERMS_VERSION).accepted_at,row.accepted_at);
 // ChatGPT sees it at once, and the gate is open for this account only.
 assert.equal((await call('yeet_terms')).structuredContent.terms.accepted,true);
 assert.notEqual(JSON.parse((await call('yeet_home')).content[0].text).error,'TERMS_REQUIRED');
 assert.equal(JSON.parse((await call('yeet_home',other)).content[0].text).error,'TERMS_REQUIRED');
 // The token is good for nothing else: it is no bearer for the connector and no session for the account page.
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},t)).status,401);
 const acct=await fetch(AS+'/account/',{redirect:'manual',headers:{cookie:`yeet_session=${t}`}});assert.equal(acct.status,303);
});

test('a sign-in page opened from an account-bound link lets only that account in and creates nothing',async()=>{
 const {readFileSync}=await import('node:fs');
 const {deriveLinkKey,mintLinkToken}=await import('#shared/link-token.mjs');
 const {accountCount}=await import('../core/identity-store.mjs');
 const {TERMS_VERSION}=await import('../core/terms.mjs');
 // An existing account, and its id (from its own terms link).
 const tok=await signIn({identity:'DEV:did:privy:acceptance-bound',terms:false});
 const link=(await (await rpc({jsonrpc:'2.0',id:51,method:'tools/call',params:{name:'yeet_terms',arguments:{}}},tok.access_token)).json()).result.structuredContent.terms.page_url;
 const account=JSON.parse(Buffer.from(new URL(link).searchParams.get('t').split('.')[1],'base64url')).a;
 const key=deriveLinkKey(readFileSync(join(secrets,'core-as'),'utf8').trim());
 const hint=mintLinkToken(key,{purpose:'hint',account,ttl:600,claims:{m:['email']}});
 const open=async(query)=>{const cookies=jar();const r=await fetch(AS+'/account/login?'+query,{headers:{cookie:cookies.header()}});cookies.add(r);const html=await r.text();return {cookies,html,csrf:html.match(/name="csrf" value="([0-9a-f]+)"/)[1]}};
 const submit=({cookies,csrf},body)=>fetch(AS+'/account/login',{method:'POST',redirect:'manual',headers:{cookie:cookies.header(),origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...body})});
 let page=await open('next=fund&h='+hint);
 assert.ok(page.html.includes(`<input type="hidden" name="hint" value="${hint}">`));
 // A hint that does not verify, or one aimed at a destination it is not for, is not carried.
 assert.doesNotMatch((await open('next=fund&h='+hint.slice(0,-2)+'AA')).html,/name="hint"/);
 assert.doesNotMatch((await open('h='+hint)).html,/name="hint"/);
 await token();
 const before=accountCount();
 // Someone who has no YEET account at all, and another existing account: refused, and nothing is created.
 for(const identity of ['DEV:did:privy:acceptance-bound-stranger','DEV:did:privy:acceptance-alice']){
  page=await open('next=fund&h='+hint);
  const r=await submit(page,{next:'fund',hint,identity_token:identity});
  assert.equal(r.status,403,identity);
  assert.ok(!r.headers.getSetCookie().some(c=>c.startsWith('yeet_session=')&&!c.startsWith('yeet_session=;')),'no session for the wrong account');
  const html=await r.text();
  assert.match(html,/This is a different YEET account than the one in your ChatGPT\./);
  assert.match(html,/Use the email you joined YEET with\./);
  assert.ok(html.includes(`href="/account/login?next=fund&amp;h=${hint}&amp;again=1">Try again</a>`));
 }
 assert.equal(accountCount(),before,'no account was created from the bound page');
 // The right account comes in and lands on its own funding page link.
 page=await open('next=fund&h='+hint);
 let r=await submit(page,{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),`/fund?h=${hint}`);
 assert.ok(r.headers.getSetCookie().some(c=>/^yeet_session=[A-Za-z0-9_-]{20,}/.test(c)));
 page=await open('next=terms&h='+hint);
 r=await submit(page,{next:'terms',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/account/terms');
 // A hint that stopped verifying between the page and the form: refused, never treated as a plain sign-in.
 page=await open('next=fund&h='+hint);
 for(const bad of [hint.slice(0,-2)+'AA',mintLinkToken(key,{purpose:'terms',account,ttl:600,claims:{v:TERMS_VERSION,m:['email']}}),mintLinkToken(key,{purpose:'hint',account,ttl:1,claims:{m:['email']},now:Date.now()-5000})]){
  page=await open('next=fund&h='+hint);
  r=await submit(page,{next:'fund',hint:bad,identity_token:'DEV:did:privy:acceptance-bound-stranger-2'});
  assert.equal(r.status,400);assert.match(await r.text(),/This link is too old to use\. Go back to ChatGPT and open it again\./);
 }
 assert.equal(accountCount(),before);
});

test('scopes end to end: discovery advertises yeet:prepare only; a client that still asks for yeet:trade gets a token that reaches the same tools',async()=>{
 const meta=await (await fetch(AS+'/.well-known/oauth-authorization-server',{headers:{host:new URL(ORIGIN).host}})).json();
 assert.ok(meta.scopes_supported.includes('yeet:prepare'));
 const old=await signIn({identity:'DEV:did:privy:acceptance-oldscope',scopes:['openid','offline_access','yeet:read','yeet:write','yeet:trade']});
 assert.deepEqual(old.scope.split(' ').sort(),['yeet:read','yeet:trade','yeet:write']);
 const fresh=await token();assert.ok(fresh.scope.split(' ').includes('yeet:prepare'));
 for(const tok of [old,fresh]){
  const call=async(name,args)=>(await (await rpc({jsonrpc:'2.0',id:33,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json()).result;
  const tools=(await (await rpc({jsonrpc:'2.0',id:34,method:'tools/list',params:{}},tok.access_token)).json()).result.tools;
  assert.equal(tools.find(t=>t.name==='execute_trade')._meta.securitySchemes[0].scopes[0],'yeet:prepare');
  const r=await call('execute_trade',{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43),card_build:(await import('../mcp/refresh.mjs')).CARD_BUILD});
  assert.notEqual(JSON.parse(r.content[0].text).error,'REAUTH_REQUIRED',tok===old?'old scope name':'new scope name');
 }
});

test('no oidc-provider default TTL notices and no upstream-parsed body warning',async()=>{
 await token();
 const bad=providerNotices.filter(m=>/ttl\.(Interaction|Session|Grant|IdToken|RefreshToken)|already parsed request body|rpInitiatedLogout/.test(m));
 assert.deepEqual(bad,[]);
});

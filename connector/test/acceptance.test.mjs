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

const LISTED=['execute_trade','skeet_propose','submit_trade_signature','trade_status','yeet_coins','yeet_home','yeet_portfolio','yeet_propose','yeet_quote'];
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
async function signIn({clientId='local-chatgpt-fixture',redirect='http://127.0.0.1:38314/callback',identity='DEV:did:privy:acceptance-alice',prompt}={}){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1',...(prompt?{prompt}:{})});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=(body)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);assert.equal(r.status,303);
 // Login: the development identity stands in for a verified Privy token; core creates the account on first sign-in.
 let page=r.headers.get('location');let d=await (await step(page)).json();assert.equal(d.prompt,'login');assert.equal(d.identity,'YEET');
 r=await step(page,form({csrf:d.csrf,identity_token:identity}));assert.equal(r.status,303);
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
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,client_id:clientId,resource:ORIGIN})})).json();
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
  assert.equal(x.structuredContent.status,'awaiting_signature');assert.equal(x._meta,undefined);assert.ok(!modelSees(x).includes(c2.code));
  const reqs=x.structuredContent.sign_requests;
  assert.deepEqual(reqs.map(r=>[r.kind,r.wallet,r.summary.amount_raw]),[['solana_tx',wallet.address,'10000000'],['solana_tx',wallet.address,'10000000']]);
  assert.equal(feePayer.calls,0,'nothing is co-signed before the person signs');
  // The card hands each leg's signed bytes to submit_trade_signature; the fee payer co-signs only then.
  const hashes=[];
  for(const r of reqs){
   const s=await call('submit_trade_signature',{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(wallet,r)});
   assert.equal(s.isError,undefined,JSON.stringify(s.content));
   assert.equal(s.structuredContent.legs[r.leg].send_status,'signing');hashes.push(s.structuredContent.legs[r.leg].tx_hash);
  }
  assert.equal(feePayer.calls,2);assert.equal(chain.sent.length,2);
  // A repeated submit with the same bytes answers the stored hash: no second co-sign; at most the same bytes again.
  const again=await call('submit_trade_signature',{trade_id:reqs[0].trade_id,leg:reqs[0].leg,attempt_id:reqs[0].attempt_id,signed:signAs(wallet,reqs[0])});
  assert.equal(again.isError,undefined,JSON.stringify(again.content));assert.equal(feePayer.calls,2);
  assert.equal(again.structuredContent.legs[reqs[0].leg].tx_hash,hashes[0]);
  assert.equal(new Set(chain.sent).size,2,'a replay never sends new bytes');
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
   signing:'user_wallet',buy_chain:'sol',sell_chain:'sol',drivers:{sol:{ok:true,reasons:[]},base:{ok:false,reasons:['BASE_RPC_NOT_CONFIGURED']}}});
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

test('no oidc-provider default TTL notices and no upstream-parsed body warning',async()=>{
 await token();
 const bad=providerNotices.filter(m=>/ttl\.(Interaction|Session|Grant|IdToken|RefreshToken)|already parsed request body|rpInitiatedLogout/.test(m));
 assert.deepEqual(bad,[]);
});

// A-4 in-process: the sign-in server (38874), connector (38875), core (38876) and operator admin (38877; 38860-38861 are the deployed stack's host ports) run in this
// process on 127.0.0.1 with throwaway state and service secrets; nothing outside the test's temp directory is touched.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
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
// No market data lookups from the suite (core/market.mjs): prices are null, as when the source is down.
process.env.YEET_MARKET_DATA='off';
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

const LISTED=['apply_referral','execute_trade','skeet_propose','submit_trade_signature','trade_status','yeet_accept_terms','yeet_coin','yeet_coins','yeet_fund','yeet_home','yeet_overview','yeet_portfolio','yeet_profile','yeet_propose','yeet_quote','yeet_referral','yeet_set_username','yeet_terms'];
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
 // yeet_coin over HTTP, through the core route and its scope: one coin by a symbol as a person writes it. No market data
 // in this process and no wallet: every number is null, nothing is held, the limits and the three follow-ups are there.
 const one=await call('yeet_coin',{symbol:' $wif '});
 assert.equal(one.isError,undefined,JSON.stringify(one.content));
 assert.deepEqual([one.structuredContent.symbol,one.structuredContent.name,one.structuredContent.price_usd,one.structuredContent.holding,one.structuredContent.as_of],['WIF','dogwifhat',null,null,null]);
 assert.deepEqual(one.structuredContent.suggestions.map(s=>s.label),['Research WIF deeper','YEET WIF','What else is moving?']);
 assert.deepEqual(one.structuredContent.limits,coins.structuredContent.limits);
 assert.match(one.structuredContent.guidance,/YEET/);
 const tool=tools.find(t=>t.name==='yeet_coin');
 assert.equal(tool._meta['openai/outputTemplate'],'ui://yeet/coin-v1.html');assert.equal(tool.annotations.readOnlyHint,true);assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['yeet:read']}]);
 for(const unknown of ['DOGE','USDT','not a coin','../portfolio']){
  const no=await call('yeet_coin',{symbol:unknown});
  assert.equal(no.isError,true,unknown);assert.equal(Object.hasOwn(no,'structuredContent'),false);
  const body=JSON.parse(no.content[0].text);
  assert.equal(body.error,'COIN_NOT_SUPPORTED',unknown);assert.equal(body.retryable,false);assert.match(body.guidance,/YEET/);
 }
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
  // No trade page address here: this stand-in has no Privy credentials, so no hint can be made for the account, and
  // the page address is only ever handed to the card bound to the account (mcp tool-registration.mjs boundSigner).
  assert.deepEqual(p._meta['yeet/signer'],{privy_app_id:'cmzyxwvutsrqponmlkjihgfed',script_url:`${ORIGIN}${asset.path}`});
  // The funding page's account check asks the core whose wallets these are (core GET /account/wallets): the Privy
  // user linked to the account and that account's own addresses. Sign-in server only.
  {
   const {readFileSync}=await import('node:fs');
   const mine=JSON.parse(Buffer.from(new URL((await call('yeet_terms',{})).structuredContent.terms.page_url).searchParams.get('t').split('.')[1],'base64url')).a;
   const ask=(role,subject)=>fetch(`http://127.0.0.1:${PORTS.CORE_PORT}/account/wallets`,{headers:{authorization:`Bearer ${readFileSync(join(secrets,role),'utf8').trim()}`,'x-yeet-subject':subject}});
   const own=await ask('core-as',mine);assert.equal(own.status,200);
   const w=await own.json();
   assert.equal(w.user,'did:privy:acceptance-alice');
   assert.equal(w.addresses.solana,wallet.address??w.addresses.solana);assert.match(w.addresses.base,/^0x[0-9a-fA-F]{40}$/);
   assert.deepEqual(Object.keys(w).sort(),['addresses','user']);
   assert.equal((await ask('core-as','yeet-privy-nobodynobodynobodynobo')).status,400,'an account that does not exist');
   assert.equal((await ask('core-operator',mine)).status,403);
  }
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

test('agent approval: /approve on the agent host only, off by default, needs YEET_AGENT_ACCESS=on and the Privy sign-in',async()=>{
 const {request}=await import('node:http');
 const AGENT_HOST='mcp.yeet.win',MAIN_HOST=new URL(ORIGIN).host;
 const get=(host,path)=>new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port:PORTS.AS_PORT,path,headers:{host}},r=>{let text='';r.setEncoding('utf8');r.on('data',c=>text+=c);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,text}))});q.on('error',reject);q.end()});
 const status=async(host=AGENT_HOST,path='/approve?user_code=ABCD-1234')=>(await get(host,path)).status;
 const was={a:process.env.YEET_AGENT_ACCESS,p:process.env.PRIVY_LOGIN,i:process.env.PRIVY_APP_ID};
 try{
  delete process.env.YEET_AGENT_ACCESS;assert.equal(await status(),404);
  process.env.YEET_AGENT_ACCESS='on';assert.equal(await status(),404,'no Privy sign-in: off');
  process.env.PRIVY_LOGIN='1';process.env.PRIVY_APP_ID='acceptance-app';
  const r=await get(AGENT_HOST,'/approve?user_code=ABCD-1234');
  assert.equal(r.status,200);assert.equal(r.headers['referrer-policy'],'no-referrer');assert.equal(r.headers['set-cookie'],undefined);
  assert.match(r.text,/<script type="module" src="\/account\/privy-login\/agent\.js"><\/script>/);
  // What the page loads from its own origin, served by the real sign-in server on the agent host.
  for(const p of ['/account/auth-pages.css','/account/brand/tokens.css','/account/page.js','/account/icon.svg'])assert.equal(await status(AGENT_HOST,p),200,p);
  const config=await get(AGENT_HOST,'/account/identity-config');
  assert.equal(config.status,200);assert.equal(JSON.parse(config.text).appId,'acceptance-app');
  // Nothing else of the sign-in server answers there.
  for(const p of ['/account/login','/account/','/fund','/sign','/auth','/.well-known/oauth-authorization-server','/account/consent.js','/agent/approve','/'])assert.equal(await status(AGENT_HOST,p),404,p);
  // The ChatGPT host: no approval page at either address; its own sign-in page as before.
  for(const p of ['/approve?user_code=ABCD-1234','/agent/approve?user_code=ABCD-1234','/approve','/agent/approve'])assert.equal(await status(MAIN_HOST,p),404,p);
  assert.equal(await status(MAIN_HOST,'/account/identity-config'),200);
  process.env.YEET_AGENT_ACCESS='off';assert.equal(await status(),404);assert.equal(await status(AGENT_HOST,'/account/identity-config'),404);
 }finally{
  for(const [k,v] of [['YEET_AGENT_ACCESS',was.a],['PRIVY_LOGIN',was.p],['PRIVY_APP_ID',was.i]])if(v===undefined)delete process.env[k];else process.env[k]=v;
 }
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
 const TOOLS_VERSION=(await import('../mcp/tool-contract.mjs')).contract['x-yeet-app'].tools_version;   // the model copies it from the schema
 const call=async(name,args={})=>(await (await rpc({jsonrpc:'2.0',id:31,method:'tools/call',params:{name,arguments:name==='yeet_overview'?{app_version:TOOLS_VERSION,...args}:args}},tok.access_token)).json()).result;
 const refused=r=>{assert.equal(r.isError,true);return JSON.parse(r.content[0].text)};
 // Every tool that does something for the person is refused with the terms; nothing reaches the engine.
 for(const [name,args] of [['yeet_home',{}],['yeet_coins',{}],['yeet_coin',{symbol:'WIF'}],['yeet_portfolio',{}],['yeet_fund',{}],['yeet_referral',{}],['trade_status',{trade_id:'t_abcdefghij0123456789'}],
  ['yeet_propose',{request_id:'11111111-1111-4111-8111-111111111111',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}],['execute_trade',{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)}]]){
  const b=refused(await call(name,args));
  assert.equal(b.error,'TERMS_REQUIRED',name+': '+JSON.stringify(b).slice(0,160));assert.equal(b.terms.accepted,false);assert.equal(b.terms.version,TERMS_VERSION);
  assert.deepEqual(b.terms.statements.map(s=>s.id),STATEMENTS.map(s=>s.id));assert.match(b.guidance,/YEET/);assert.match(b.guidance,/YEET/);assert.doesNotMatch(b.guidance,/all of them/);assert.doesNotMatch(b.guidance,/unlock|device|6-digit/i);
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

test('yeet_how_it_works end to end: off by default; with YEET_HOW_IT_WORKS=1 it answers before the terms are accepted, from core',async()=>{
 const tok=await signIn({identity:'DEV:did:privy:acceptance-how',terms:false});
 const call=async(name,args={})=>(await (await rpc({jsonrpc:'2.0',id:41,method:'tools/call',params:{name,arguments:args}},tok.access_token)).json());
 const list=async()=>(await (await rpc({jsonrpc:'2.0',id:42,method:'tools/list',params:{}},tok.access_token)).json()).result.tools.map(t=>t.name);
 assert.equal((await list()).includes('yeet_how_it_works'),false,'off by default');
 const off=await call('yeet_how_it_works');assert.ok(off.error||off.result?.isError,'not callable while off');
 process.env.YEET_HOW_IT_WORKS='1';
 try{
  assert.equal((await list()).includes('yeet_how_it_works'),true);
  const r=(await call('yeet_how_it_works')).result;
  assert.notEqual(r.isError,true,JSON.stringify(r).slice(0,200));
  const h=r.structuredContent.how_it_works;
  assert.equal(h.export_url,'https://home.privy.io/');assert.equal(h.custody,'non_custodial');
  assert.ok(h.sections.some(s=>s.id==='export_warning'&&/controls your funds/.test(s.text)));
  // The terms are still not accepted: everything else stays gated.
  assert.equal(JSON.parse((await call('yeet_home')).result.content[0].text).error,'TERMS_REQUIRED');
 }finally{delete process.env.YEET_HOW_IT_WORKS}
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
 assert.match(html,/<button type="submit">Accept<\/button>/);assert.match(html,/I am at least 18\./);
 assert.match(claims.j,/^[A-Za-z0-9_-]{16,32}$/,'the token has its own id (single use)');
 assert.doesNotMatch(html,/agree_product_email/,'the optional opt-in is not on the bearer page');
 // A checkbox for every required statement, none ticked (owner, 2026-11-14: never one accept-all).
 for(const id of REQUIRED_IDS)assert.ok(html.includes(`<input type="checkbox" name="agree_${id}" value="yes" required>`),id);
 assert.equal(html.match(/type="checkbox"/g).length,REQUIRED_IDS.length);
 // Accept with no box ticked: nothing is recorded.
 assert.equal((await fetch(AS+'/account/terms',{method:'POST',redirect:'manual',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({t,version:TERMS_VERSION})})).status,400);
 // Their payload under our signature, our token cut short, an empty one: the expired state. Nothing is recorded,
 // and the page never falls back to a sign-in or a session.
 const forged=`v1.${theirs.split('.')[1]}.${t.split('.')[2]}`;
 const post=body=>fetch(AS+'/account/terms',{method:'POST',redirect:'manual',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
 for(const bad of [forged,t.slice(0,-1),'']){
  const r=await fetch(AS+'/account/terms?t='+bad,{redirect:'manual'});
  assert.equal(r.status,410);assert.match(await r.text(),/This link has expired\. Go back to ChatGPT and ask for a new one\./);
  const p=await post({t:bad,version:TERMS_VERSION});
  assert.equal(p.status,410);
 }
 assert.equal(acceptanceOf(claims.a,TERMS_VERSION),null);assert.equal(acceptanceOf(otherAccount,TERMS_VERSION),null);
 // Accept, with the opt-in slipped into the form: recorded for the token's account, source terms-link, the
 // required statements only; the other account is untouched.
 const done=await post({t,version:TERMS_VERSION,...Object.fromEntries(REQUIRED_IDS.map(id=>[`agree_${id}`,'yes'])),agree_product_email:'yes'});
 assert.equal(done.status,200);assert.equal(done.headers.get('set-cookie'),null,'no session comes with it');
 assert.match(await done.text(),/Done\. You accepted the YEET terms\.<\/p><p>Go back to ChatGPT/);
 const row=acceptanceOf(claims.a,TERMS_VERSION);
 assert.equal(row.source,'terms-link');assert.equal(row.client_id,'terms-link');assert.deepEqual(row.statements,[...REQUIRED_IDS]);
 assert.equal(acceptanceOf(otherAccount,TERMS_VERSION),null);
 // Single use: the same token again records nothing and reads as already accepted.
 const again=await post({t,version:TERMS_VERSION});
 assert.equal(again.status,200);assert.match(await again.text(),/You already accepted the YEET terms\./);
 assert.deepEqual(acceptanceOf(claims.a,TERMS_VERSION),row);
 // ChatGPT sees it at once, and the gate is open for this account only.
 assert.equal((await call('yeet_terms')).structuredContent.terms.accepted,true);
 assert.notEqual(JSON.parse((await call('yeet_home')).content[0].text).error,'TERMS_REQUIRED');
 assert.equal(JSON.parse((await call('yeet_home',other)).content[0].text).error,'TERMS_REQUIRED');
 // The token is good for nothing else: it is no bearer for the connector and no session for the account page.
 assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'tools/list'},t)).status,401);
 const acct=await fetch(AS+'/account/',{redirect:'manual',headers:{cookie:`yeet_session=${t}`}});assert.equal(acct.status,303);
});

test('a sign-in page opened from an account-bound link lets only that account in, creates nothing, and never replaces a session without a press',async()=>{
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
 const open=async(query,cookies=jar())=>{const r=await fetch(AS+'/account/login?'+query,{headers:{cookie:cookies.header()}});cookies.add(r);const html=await r.text();return {status:r.status,cookies,html,csrf:html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1]}};
 const submit=({cookies,csrf},body)=>fetch(AS+'/account/login',{method:'POST',redirect:'manual',headers:{cookie:cookies.header(),origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...body})});
 const EXPIRED=/This link has expired\. Go back to ChatGPT and ask for a new one\./;
 let page=await open('next=fund&h='+hint);
 assert.equal(page.status,200);assert.ok(page.html.includes(`<input type="hidden" name="hint" value="${hint}">`));
 // F1: a hint that is on the link but does not verify, or is aimed at a destination it is not for, is refused. The
 // page never turns into the plain sign-in (which lets any account in and creates one).
 const stale=mintLinkToken(key,{purpose:'hint',account,ttl:1,claims:{m:['email']},now:Date.now()-5000});
 for(const query of ['next=fund&h='+hint.slice(0,-2)+'AA','next=fund&h='+stale,'next=fund&h=','h='+hint,'next=account&h='+hint]){
  const bad=await open(query);
  assert.equal(bad.status,410,query);assert.match(bad.html,EXPIRED);assert.doesNotMatch(bad.html,/name="csrf"|identity_token|privy-login/,query);
 }
 await token();
 const before=accountCount();
 // Someone who has no YEET account at all, and another existing account: refused with the one line. Nothing is
 // created, and nothing about the right account is said (F7); the way back carries no logout flag (F8).
 for(const identity of ['DEV:did:privy:acceptance-bound-stranger','DEV:did:privy:acceptance-alice']){
  page=await open('next=fund&h='+hint);
  const r=await submit(page,{next:'fund',hint,identity_token:identity});
  assert.equal(r.status,403,identity);
  assert.ok(!r.headers.getSetCookie().some(c=>/^yeet_session=[^;]/.test(c)),'no session for the wrong account');
  const html=await r.text();
  assert.match(html,/This is a different YEET account than the one in your ChatGPT\./);
  assert.ok(html.includes(`href="/account/login?next=fund&amp;h=${hint}">Try again</a>`));
  assert.doesNotMatch(html,/Use (Google|Apple|the email)|•|again=1|@/);
 }
 assert.equal(accountCount(),before,'no account was created from the bound page');
 // The right account, in a browser with no YEET session: straight in, to its own funding page link.
 page=await open('next=fund&h='+hint);
 let r=await submit(page,{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),`/fund?h=${hint}`);
 assert.ok(r.headers.getSetCookie().some(c=>/^yeet_session=[A-Za-z0-9_-]{20,}/.test(c)));
 page=await open('next=terms&h='+hint);
 r=await submit(page,{next:'terms',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/account/terms');
 // The right account, in a browser that holds a YEET session of ANOTHER account (alice): nothing is replaced until
 // the person presses "Switch to the account in your ChatGPT".
 const browser=jar();
 let plain=await open('',browser);
 r=await submit(plain,{identity_token:'DEV:did:privy:acceptance-alice'});browser.add(r);
 assert.equal(r.status,302);
 const aliceSession=browser.header().match(/yeet_session=([A-Za-z0-9_-]+)/)[1];
 page=await open('next=fund&h='+hint,browser);
 r=await submit(page,{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,409);
 assert.ok(!r.headers.getSetCookie().some(c=>c.startsWith('yeet_session=')),'the session is untouched');
 const ask=await r.text();
 assert.match(ask,/<button type="submit">Switch to the account in your ChatGPT<\/button>/);assert.match(ask,/name="switch" value="yes"/);
 const still=await fetch(AS+'/account/',{redirect:'manual',headers:{cookie:browser.header()}});assert.equal(still.status,200,'alice is still signed in');
 // The press: the same form with switch=yes. Alice's session ends, the link's account is in.
 r=await submit(page,{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-bound',switch:'yes'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),`/fund?h=${hint}`);
 const fresh=r.headers.getSetCookie().find(c=>/^yeet_session=[A-Za-z0-9_-]{20,}/.test(c)).split(';')[0];
 assert.notEqual(fresh,`yeet_session=${aliceSession}`);
 assert.equal((await fetch(AS+'/account/',{redirect:'manual',headers:{cookie:`yeet_session=${aliceSession}`}})).status,303,'the old session is gone');
 // switch=yes does nothing for someone who is not the link's account.
 page=await open('next=fund&h='+hint);
 r=await submit(page,{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-alice',switch:'yes'});
 assert.equal(r.status,403);
 // N1: the way back from Google or Apple. The bound page set the server's own cookie; the fixed return address is
 // answered from it, with the same bound form (the hint verified again).
 const trip=jar();
 const served=await fetch(AS+'/account/login?next=fund&h='+hint,{headers:{cookie:trip.header()}});trip.add(served);
 const set=served.headers.getSetCookie().find(c=>c.startsWith('yeet_bound='));
 assert.ok(set,'the bound page sets the cookie');
 assert.match(set,/^yeet_bound=fund\.v1\.[A-Za-z0-9_.-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=900/);
 const back=await open('privy_oauth_code=c&privy_oauth_state=s',trip).then(()=>fetch(AS+'/account/login/bound?privy_oauth_code=c&privy_oauth_state=s',{headers:{cookie:trip.header()}}));
 trip.add(back);
 assert.equal(back.status,200);
 const backHtml=await back.text();
 assert.ok(backHtml.includes(`<input type="hidden" name="hint" value="${hint}">`));assert.match(backHtml,/<form method="POST" action="\/account\/login"/);assert.match(backHtml,/name="next" value="fund"/);
 r=await submit({cookies:trip,csrf:backHtml.match(/name="csrf" value="([0-9a-f]+)"/)[1]},{next:'fund',hint,identity_token:'DEV:did:privy:acceptance-bound'});
 assert.equal(r.status,302);assert.equal(r.headers.get('location'),`/fund?h=${hint}`);
 assert.ok(r.headers.getSetCookie().some(c=>/^yeet_bound=; .*Max-Age=0/.test(c)),'the cookie ends with the sign-in');
 // The return arrives and the cookie is missing (storage or cookie lost, more than 15 minutes), stale or altered:
 // the expired state and nothing else. No form, no csrf, no sign-in of any kind, so no account can be created.
 const count=accountCount();
 for(const cookieHeader of [undefined,'yeet_bound=','yeet_bound=fund.'+stale,'yeet_bound=fund.'+hint.slice(0,-2)+'AA','yeet_bound=account.'+hint,'yeet_session=whatever']){
  const lost=await fetch(AS+'/account/login/bound?privy_oauth_code=c&privy_oauth_state=s',{redirect:'manual',headers:cookieHeader?{cookie:cookieHeader}:{}});
  assert.equal(lost.status,410,String(cookieHeader));
  const text=await lost.text();
  assert.match(text,EXPIRED);
  assert.doesNotMatch(text,/name="csrf"|identity_token|privy-login|login\.js|<form|<button/,'nothing else is on the page: no ordinary sign-in');
  assert.ok(!lost.headers.getSetCookie().some(c=>c.startsWith('yeet_login=')),'no sign-in form token is issued');
  assert.ok(lost.headers.getSetCookie().some(c=>/^yeet_bound=; .*Max-Age=0/.test(c)));
 }
 assert.equal(accountCount(),count);
 // The ordinary sign-in page is untouched by the cookie: it stays the plain form at its own address.
 const ordinary=await fetch(AS+'/account/login',{headers:{cookie:'yeet_bound=fund.'+hint}});
 assert.equal(ordinary.status,200);assert.doesNotMatch(await ordinary.text(),/name="hint"/);
 // A hint that stopped verifying between the page and the form: refused, never treated as a plain sign-in.
 for(const bad of ['',hint.slice(0,-2)+'AA',stale,mintLinkToken(key,{purpose:'terms',account,ttl:600,claims:{v:TERMS_VERSION,m:['email'],j:'x'.repeat(16)}})]){
  page=await open('next=fund&h='+hint);
  r=await submit(page,{next:'fund',hint:bad,identity_token:'DEV:did:privy:acceptance-bound-stranger-2'});
  assert.equal(r.status,410,bad.slice(0,12));assert.match(await r.text(),EXPIRED);
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

test('the email step of the connect screen: the note is for one Privy user; a sign-in by anyone else is refused and creates nothing',async()=>{
 const {accountCount}=await import('../core/identity-store.mjs');
 const {CHANGED_LINE}=await import('../as/signup-email.mjs');
 const ALICE='DEV:did:privy:acceptance-step-alice',MALLORY='DEV:did:privy:acceptance-step-mallory';
 const start=(identity_token,origin=ORIGIN)=>fetch(AS+'/account/email-step',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({identity_token})});
 const before=accountCount();
 // The note: for a verified caller on this origin only, and nobody is created by asking for it.
 assert.equal((await start(ALICE,'https://evil.example')).status,403);
 assert.equal((await start('not-a-credential')).status,401);
 let r=await start(ALICE);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const {step}=await r.json();assert.match(step,/^e1\./);
 assert.equal(accountCount(),before,'the step creates no account');
 // The connect sign-in, with the note on the form.
 const login=async(identity,note)=>{
  const cookies=jar();
  const go=async(url,init={})=>{const x=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(x);return x};
  const auth=new URL(AS+'/auth');
  auth.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:'http://127.0.0.1:38314/callback',code_challenge:'x'.repeat(43),code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1'});
  const page=(await go(auth.href)).headers.get('location');
  const d=await (await go(page)).json();assert.equal(d.prompt,'login');
  return go(page,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams({csrf:d.csrf,identity_token:identity,...(note===undefined?{}:{email_step:note})})});
 };
 // Another Privy user than the one the step was started by: refused before anyone is resolved.
 r=await login(MALLORY,step);assert.equal(r.status,409);
 let text=await r.text();assert.ok(text.includes(CHANGED_LINE));assert.doesNotMatch(text,/did:privy|yeet-privy-/);
 assert.equal(accountCount(),before,'nobody was created for the other user');
 // A note that does not verify is refused, never dropped.
 r=await login(ALICE,step+'x');assert.equal(r.status,409);
 r=await login(ALICE,'');assert.equal(r.status,409);
 assert.equal(accountCount(),before);
 // The same person, whether they entered the code or skipped: the sign-in goes on as it always did.
 r=await login(ALICE,step);assert.equal(r.status,303);
 assert.equal(accountCount(),before+1);
 // Now the account exists: a new note names it, and still only its own user passes.
 const again=(await (await start(ALICE)).json()).step;
 r=await login(MALLORY,again);assert.equal(r.status,409);
 r=await login(ALICE,again);assert.equal(r.status,303);
 assert.equal(accountCount(),before+1);
 // No note at all: the sign-in as before (a person for whom the step is off, or never shown).
 r=await login('DEV:did:privy:acceptance-step-plain');assert.equal(r.status,303);
 // The plain sign-in page holds the same check.
 const cookies=jar();
 const html=await (async()=>{const x=await fetch(AS+'/account/login',{headers:{cookie:cookies.header()}});cookies.add(x);return x.text()})();
 const csrf=html.match(/name="csrf" value="([0-9a-f]+)"/)[1];
 const plain=(identity_token,note)=>fetch(AS+'/account/login',{method:'POST',redirect:'manual',headers:{cookie:cookies.header(),origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,identity_token,email_step:note})});
 r=await plain(MALLORY,again);assert.equal(r.status,409);assert.ok((await r.text()).includes(CHANGED_LINE));
 r=await plain(ALICE,again);assert.equal(r.status,302);
 // The setting off: the route is gone (the page is told with /account/identity-config and never asks).
 // A form from a page that was still open carries a note: it is not read. Every sign-in that was refused above
 // goes through exactly as it did before the step existed.
 process.env.YEET_SIGNUP_EMAIL_STEP='0';
 try{
  assert.equal((await start(ALICE)).status,404);
  r=await login(MALLORY,again);assert.equal(r.status,303);
  r=await login(ALICE,step+'x');assert.equal(r.status,303);
  r=await login(ALICE,'');assert.equal(r.status,303);
  r=await plain(ALICE,'nonsense');assert.equal(r.status,302);
 }finally{delete process.env.YEET_SIGNUP_EMAIL_STEP}
 r=await login(ALICE,step+'x');assert.equal(r.status,409);
 assert.equal((await start(ALICE)).status,200);
});

// ---- The limited beta (YEET_BETA_USER_CAP; core/identity-store.mjs betaFull, as/beta-full.mjs, core/waitlist.mjs).
/** Runs fn with the beta cap at `cap` (a number, or undefined for unset) and puts the setting back after. */
async function withBetaCap(cap,fn){
 const before=process.env.YEET_BETA_USER_CAP;
 if(cap===undefined)delete process.env.YEET_BETA_USER_CAP;else process.env.YEET_BETA_USER_CAP=String(cap);
 try{return await fn()}finally{if(before===undefined)delete process.env.YEET_BETA_USER_CAP;else process.env.YEET_BETA_USER_CAP=before}
}
/** One connect flow up to the login POST: the answer to signing in with `identity` inside a ChatGPT authorization. */
async function connectLogin(identity){
 const cookies=jar();
 const go=async(url,init={})=>{const x=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(x);return x};
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:'http://127.0.0.1:38314/callback',code_challenge:randomBytes(32).toString('base64url'),code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1'});
 const page=(await go(auth.href)).headers.get('location');
 const d=await (await go(page)).json();assert.equal(d.prompt,'login');
 const r=await go(page,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams({csrf:d.csrf,identity_token:identity})});
 return {r,uid:new URL(page,ORIGIN).pathname.split('/').pop()};
}
/** The web sign-in (/account/login) with `identity`. */
async function webLogin(identity){
 const cookies=jar();
 const x=await fetch(AS+'/account/login');cookies.add(x);
 const csrf=(await x.text()).match(/name="csrf" value="([0-9a-f]+)"/)[1];
 return fetch(AS+'/account/login',{method:'POST',redirect:'manual',headers:{cookie:cookies.header(),origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,identity_token:identity})});
}
const coreAs=(path,body)=>fetch(`http://127.0.0.1:${PORTS.CORE_PORT}${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${readFileSync(join(secrets,'core-as'),'utf8').trim()}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const BETA_LINE='YEET is in a limited beta and every spot is taken right now. Leave your email and we will tell you when new spots open.';

test('beta cap unset: sign-up is open and a new person gets an account on both entry paths, as before',async()=>{
 const {accountCount}=await import('../core/identity-store.mjs');
 await withBetaCap(undefined,async()=>{
  assert.deepEqual(await (await coreAs('/signup')).json(),{signup:true});
  const before=accountCount();
  const {r}=await connectLogin('DEV:did:privy:beta-unset-chatgpt');assert.equal(r.status,303);
  assert.equal((await webLogin('DEV:did:privy:beta-unset-web')).status,302);
  assert.equal(accountCount(),before+2);
 });
 // A cap above the count changes nothing either.
 await withBetaCap(accountCount()+5,async()=>{
  assert.deepEqual(await (await coreAs('/signup')).json(),{signup:true});
  const before=accountCount();
  assert.equal((await connectLogin('DEV:did:privy:beta-under-cap')).r.status,303);
  assert.equal(accountCount(),before+1);
 });
});

test('beta cap reached: a new person gets the "beta is full" page on the connect flow and the web sign-in, and no account; existing accounts sign in and trade',async()=>{
 const {accountCount}=await import('../core/identity-store.mjs');
 const existing=await token();
 await withBetaCap(accountCount(),async()=>{
  assert.deepEqual(await (await coreAs('/signup')).json(),{signup:false});
  const before=accountCount();
  // ChatGPT connect flow: the page instead of an account, and the way back into this same authorization.
  const {r,uid}=await connectLogin('DEV:did:privy:beta-new-chatgpt');
  assert.equal(r.status,403);assert.match(r.headers.get('content-type'),/text\/html/);
  const page=await r.text();
  assert.match(page,/<title>The beta is full<\/title>/);assert.match(page,/<h1 id="page-title" class="display">The beta is full<\/h1>/);
  assert.ok(page.includes(BETA_LINE));assert.match(page,/<button type="submit">Join the waitlist<\/button>/);
  assert.match(page,/<input id="waitlist-email" name="email" type="email"/);
  assert.ok(page.includes(`<p class="hint">Already have an account? <a href="/interaction/${uid}">Sign in</a></p>`));
  assert.match(page,/name="source" value="chatgpt"/);assert.match(page,/href="\/account\/auth-pages\.css"/);
  assert.doesNotMatch(page,/\b(demo|mock|sample|placeholder)\b/i);
  // The web sign-in.
  const w=await webLogin('DEV:did:privy:beta-new-web');
  assert.equal(w.status,403);const web=await w.text();
  assert.ok(web.includes(BETA_LINE));assert.match(web,/name="source" value="web"/);assert.ok(web.includes('<a href="/account/login">Sign in</a>'));
  // Wallet set-up for a new person: refused with BETA_FULL before any wallet is asked for.
  const ws=await fetch(AS+'/account/wallets',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({identity_token:'DEV:did:privy:beta-new-wallets'})});
  assert.equal(ws.status,403);const wb=await ws.json();
  assert.equal(wb.code,'BETA_FULL');assert.equal(wb.message,BETA_LINE);assert.equal(wb.url,'/account/waitlist?from=web');
  // The core answers the same to a direct resolve, and nobody was created anywhere.
  const res=await coreAs('/identity/resolve',{provider:'privy.io',app_id:'dev-identity-stub',did:'did:privy:beta-new-direct'});
  assert.equal(res.status,403);assert.deepEqual(await res.json(),{error:'BETA_FULL'});
  assert.equal(accountCount(),before,'no account row for anyone new');
  // Existing accounts: the web sign-in, a whole new ChatGPT connection, and a tool call on the old token.
  assert.equal((await webLogin('DEV:did:privy:acceptance-alice')).status,302);
  const again=await signIn({terms:false});
  assert.equal(accountCount(),before);
  for(const tok of [existing,again]){
   const coins=(await (await rpc({jsonrpc:'2.0',id:70,method:'tools/call',params:{name:'yeet_coins',arguments:{}}},tok.access_token)).json()).result;
   assert.equal(coins.isError,undefined,JSON.stringify(coins.content));
  }
  // Back under the cap (a higher cap): the same new person gets an account.
  process.env.YEET_BETA_USER_CAP=String(before+1);
  assert.equal((await connectLogin('DEV:did:privy:beta-new-chatgpt')).r.status,303);
  assert.equal(accountCount(),before+1);
 });
});

test.skip('a tool call with no account behind it while the beta is full: BETA_FULL with the waitlist link, no structuredContent',async()=>{
 const {accountCount,didFor}=await import('../core/identity-store.mjs');
 const {DatabaseSync}=await import('node:sqlite');
 const tok=await signIn({identity:'DEV:did:privy:beta-orphan',terms:false});
 const me=await (await fetch(AS+'/me',{headers:{authorization:`Bearer ${tok.access_token}`}})).json();
 assert.equal(didFor(me.sub),'did:privy:beta-orphan');
 // The account behind the token goes away (the token stays valid): what a ChatGPT person with no account looks like.
 const db=new DatabaseSync(join(state,'identities.sqlite'),{timeout:2000});
 for(const sql of ['DELETE FROM identity_links WHERE account_id=?','DELETE FROM usernames WHERE account_id=?','DELETE FROM accounts WHERE id=?'])db.prepare(sql).run(me.sub);
 db.close();
 const call=async()=>(await (await rpc({jsonrpc:'2.0',id:71,method:'tools/call',params:{name:'yeet_overview',arguments:{}}},tok.access_token)).json()).result;
 await withBetaCap(accountCount(),async()=>{
  const r=await call();
  assert.equal(r.isError,true);assert.equal(Object.hasOwn(r,'structuredContent'),false);
  const data=JSON.parse(r.content[0].text);
  assert.equal(data.error,'BETA_FULL');assert.equal(data.retryable,false);
  assert.equal(data.waitlist_url,`${ORIGIN}/account/waitlist?from=chatgpt`);
  assert.match(data.message,/limited beta/);assert.match(data.guidance,/waitlist_url/);
 });
 // With the cap unset the same call is refused as it always was (the core's bare 400).
 await withBetaCap(undefined,async()=>{
  assert.equal(JSON.parse((await call()).content[0].text).error,'TEMPORARILY_UNAVAILABLE');
 });
});

test('the waitlist form: CSRF and origin checked, the email validated, lowercased and kept once, rate limited per address',async()=>{
 const {waitlistRows}=await import('../core/waitlist.mjs');
 const open=async(query='?from=chatgpt&back=/interaction/abc')=>{
  const cookies=jar(),x=await fetch(AS+'/account/waitlist'+query);cookies.add(x);
  assert.equal(x.status,200);assert.equal(x.headers.get('cache-control'),'no-store');
  return {cookies,html:await x.text()};
 };
 let {cookies,html}=await open();
 assert.ok(html.includes(BETA_LINE));assert.ok(html.includes('<a href="/interaction/abc">Sign in</a>'));
 assert.match(cookies.header(),/yeet_waitlist=[0-9a-f]{48}/);
 // A back link that is not one of the sign-in pages becomes the web sign-in.
 assert.ok((await open('?from=web&back=https://evil.example/')).html.includes('<a href="/account/login">Sign in</a>'));
 const csrf=()=>html.match(/name="csrf" value="([0-9a-f]+)"/)[1];
 const post=(fields,{origin=ORIGIN,c=cookies}={})=>fetch(AS+'/account/waitlist',{method:'POST',headers:{cookie:c.header(),origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:csrf(),source:'chatgpt',back:'/interaction/abc',...fields})});
 // 1: joined.
 let r=await post({email:'  Ada.Lovelace@Example.COM '});assert.equal(r.status,200);
 let text=await r.text();assert.ok(text.includes('You are on the list. We will email you when a spot opens.'));assert.ok(text.includes('Already have an account?'));
 // 2: the same address in other letters: the same answer, still one row.
 ({cookies,html}=await open());
 r=await post({email:'ada.lovelace@example.com'});assert.equal(r.status,200);
 assert.deepEqual(waitlistRows().map(x=>[x.email,x.source]),[['ada.lovelace@example.com','chatgpt']]);
 // 3: not an address: the form again with the line, nothing stored.
 ({cookies,html}=await open());
 r=await post({email:'not an email'});assert.equal(r.status,400);
 text=await r.text();assert.ok(text.includes('Enter your email address, like name@example.com.'));assert.match(text,/aria-invalid="true"/);
 // 4: another origin: refused.
 r=await post({email:'grace@example.com'},{origin:'https://evil.example'});assert.equal(r.status,403);
 assert.equal(waitlistRows().length,1);
 // 5: from the web sign-in.
 r=await post({email:'grace@example.com',source:'web'});assert.equal(r.status,200);
 assert.deepEqual(waitlistRows().map(x=>[x.email,x.source]),[['ada.lovelace@example.com','chatgpt'],['grace@example.com','web']]);
 // 6: the sixth post from this address within the minute: 429, nothing stored.
 r=await post({email:'linus@example.com'});assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');
 assert.equal(waitlistRows().length,2);
});

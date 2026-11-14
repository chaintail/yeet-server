// The sanctions geoblock (shared/region.mjs, YEET_GEOBLOCK): the rules on their own, then end to end in-process like
// test/agent-route.test.mjs: the sign-in server (38940), connector (38941), core (38942) and admin (38943) on 127.0.0.1
// with throwaway state, YEET_GEOBLOCK=on and TRUST_PROXY=1. A request "from" a country carries CF-IPCountry, as
// Cloudflare sets it. Nothing outside the temp directory is touched; no network.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';
import {readGeoblock,blockedCountry,requestCountry,countryCode,regionGatedRoute,regionGatedPath,DEFAULT_BLOCKED} from '../shared/region.mjs';

test('the list and the reading are the ported ones: CU, IR, KP, SY by default; CF-IPCountry only behind the proxy',()=>{
 assert.deepEqual([...DEFAULT_BLOCKED],['CU','IR','KP','SY']);
 assert.deepEqual(readGeoblock({}),{on:false,countries:DEFAULT_BLOCKED,trustProxy:false},'off by default');
 assert.equal(readGeoblock({YEET_GEOBLOCK:'off'}).on,false);assert.equal(readGeoblock({YEET_GEOBLOCK:''}).on,false);
 assert.throws(()=>readGeoblock({YEET_GEOBLOCK:'1'}),/Invalid YEET_GEOBLOCK/);
 assert.throws(()=>readGeoblock({YEET_GEOBLOCK:'on'}),/needs TRUST_PROXY=1/,'on without the proxy trust would block nothing');
 const on=readGeoblock({YEET_GEOBLOCK:'on',TRUST_PROXY:'1'});
 assert.equal(on.on,true);assert.deepEqual([...on.countries],['CU','IR','KP','SY']);
 assert.deepEqual([...readGeoblock({YEET_GEOBLOCK:'on',TRUST_PROXY:'1',YEET_GEOBLOCK_COUNTRIES:' ru, by,RU '}).countries],['RU','BY'],'the list is overridable');
 for(const bad of ['RUS','R1','ru,,x','XX'])assert.throws(()=>readGeoblock({YEET_GEOBLOCK_COUNTRIES:bad}),/Invalid YEET_GEOBLOCK_COUNTRIES/,bad);
 assert.equal(countryCode(' ir '),'IR');for(const c of ['XX','T1','',null,'IRN'])assert.equal(countryCode(c),null,String(c));
 assert.equal(blockedCountry({'cf-ipcountry':'IR'},on),'IR');assert.equal(blockedCountry({'cf-ipcountry':'kp'},on),'KP');
 assert.equal(blockedCountry({'cf-ipcountry':'DE'},on),null);assert.equal(blockedCountry({},on),null,'no country: not blocked');
 assert.equal(blockedCountry({'cf-ipcountry':'IR'},readGeoblock({TRUST_PROXY:'1'})),null,'switch off');
 assert.equal(requestCountry({'cf-ipcountry':'IR'},{trustProxy:false}),null,'not through our proxy: the header is not read');
});

test('what is gated: account creation and trade preparation on both hosts, the sign-in pages; never the reads',()=>{
 for(const [route,body] of [['/proposals',{}],['/proposals/skeet',{}],['/proposals/p_x/quote',{}],['/trades',{}],['/trades/t_x/signature',{}],
  ['/agent/register',{}],['/agent/quote',{}],['/agent/prepare',{}],['/agent/submit',{request_id:'t_abc.def'}]])assert.equal(regionGatedRoute(route,body),true,route);
 for(const [route,body] of [['/overview'],['/portfolio'],['/trades/t_x'],['/terms'],['/terms/accept',{}],['/fund'],['/agent/overview'],['/agent/status',{}],
  ['/agent/balance',{}],['/agent/return',{}],['/agent/submit',{request_id:'a_abcdefghij0123456789.1'}]])assert.equal(regionGatedRoute(route,body),false,route);
 for(const p of ['/account/login','/account/email-step','/account/wallets','/interaction/abc','/approve','/agent/approve','/sign','/sign/api/requests','/fund','/fund/api/check'])assert.equal(regionGatedPath(p),true,p);
 for(const p of ['/account/terms','/account/logout','/account/brand/logo.svg','/auth','/token','/me','/.well-known/openid-configuration','/'])assert.equal(regionGatedPath(p),false,p);
});

// ---- end to end ----
const ORIGIN='https://chatgpt.yeet.win',AGENT='https://mcp.yeet.win';
const PORTS={AS_PORT:38940,CONNECTOR_PORT:38941,CORE_PORT:38942,ADMIN_PORT:38943};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-region-'));
const secrets=join(root,'secrets'),state=join(root,'state');
mkdirSync(secrets);mkdirSync(state);
for(const name of ['core-introspection','introspection','core-as','core-mcp','core-operator','operator','csrf'])
 writeFileSync(join(secrets,name),randomBytes(32).toString('base64url'),{mode:0o600});
const {loadOrCreateNearKey}=await import('../core/intents/near-tx.mjs');
const near=loadOrCreateNearKey(join(secrets,'solver.json'));
Object.assign(process.env,{
 ISSUER:ORIGIN,RESOURCE:ORIGIN,AS_INTERNAL:AS,CORE_INTERNAL:`http://127.0.0.1:${PORTS.CORE_PORT}`,
 STATE_DIR:state,SECRETS_DIR:secrets,LISTEN_HOST:'127.0.0.1',TEST_PROFILE:'1',DEV_IDENTITY_STUB:'1',ACCESS_TTL:'300',
 ...Object.fromEntries(Object.entries(PORTS).map(([k,v])=>[k,String(v)])),
 YEET_AGENT_ROUTE:'on',AGENT_RESOURCE:AGENT,
 YEET_LIVE:'1',YEET_ROUTE:'ledger',YEET_SOLVER_ACCOUNT:near.accountId,YEET_SOLVER_KEY_FILE:join(secrets,'solver.json'),
 YEET_SOLVER_MAX_TRADE_USDC:'25',YEET_SOLVER_MAX_DAY_USDC:'60',YEET_MIN_LEG_USDC:'1',YEET_MARKET_DATA:'off',
 YEET_GEOBLOCK:'on',TRUST_PROXY:'1',
});
for(const name of ['PUBLIC_MODE','PRIVY_LOGIN','MOCK_PASSWORD_LOGIN','PUBLIC_BASE_URL','COOKIE_SECURE','YEET_GEOBLOCK_COUNTRIES','YEET_LIVE_ACCOUNTS','YEET_KILL_SWITCH','YEET_LEDGER_DEPOSIT_NETWORKS'])delete process.env[name];
for(const level of ['info','warn']){const orig=console[level];console[level]=(m,...rest)=>{if(!String(m).includes('oidc-provider'))orig(m,...rest)}}
const blockedLog=[];{const orig=console.log;console.log=(m,...rest)=>{if(String(m).includes('"region_blocked"')){blockedLog.push(JSON.parse(m));return}orig(m,...rest)}}

const {fakeLedger,fakeLedgerOneClick,aliceWallet,accountOf,USDC}=await import('../core/ledger-route/fakes.mjs');
const {fakeClock,fakeBalances,BASE_WALLET}=await import('../core/trade/fakes.mjs');
const {fakeSolanaRpc,fakeFeePayer}=await import('../core/pipeline/fakes.mjs');
const {openTradeDb}=await import('../core/trade/db.mjs');
const {configureTradeEngine}=await import('../core/trade/runtime.mjs');
const now=fakeClock(),world=fakeLedger({now}),oneclick=fakeLedgerOneClick({world,now}),rpc=fakeSolanaRpc();
world.credit(accountOf(aliceWallet),USDC,20_000_000n);world.credit(near.accountId,USDC,30_000_000n);
const wallet={address:aliceWallet.address,walletId:null,signerState:'none',policyId:null};
configureTradeEngine({db:openTradeDb(':memory:'),client:oneclick,now,balances:fakeBalances({usdc:'0',holdings:[]}),xpOf:()=>0,trackerIntervalMs:0,landingWatchMs:0,
 directory:{stable:true,async lookup(id){return /^yeet-privy-/.test(id)?{base:{...wallet,address:BASE_WALLET},solana:wallet}:null}},
 driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer:fakeFeePayer()},
 ledgerOverrides:{rpc:world.rpc,verifier:world.verifier,near,pollMs:0,unloadWaitMs:30_000,sleep:async ms=>{now.advance(Math.max(ms,500))}}});

const core=await import('../core/core.mjs');
const as=await import('../as/as.mjs');
const connector=await import('../mcp/mcp.mjs');
const {REGION_LINE}=await import('../as/region-page.mjs');
const {toolMessage}=await import('../contracts/errors.mjs');
after(async()=>{
 for(const s of [connector.server,as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:prepare'];
const STABLE='https://chatgpt.com/connector_platform_oauth_redirect',LOOPBACK='http://127.0.0.1:53682/callback';
const local=url=>{const u=new URL(url,ORIGIN);return u.origin===ORIGIN?`${AS}${u.pathname}${u.search}`:u.href};
function jar(){const c=new Map();return {header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '),add(r){for(const s of r.headers.getSetCookie()){const p=s.split(';')[0],i=p.indexOf('=');c.set(p.slice(0,i),p.slice(i+1))}}}}
/** A request with a chosen Host and headers (fetch cannot set Host). */
function send(port,host,path,{method='GET',body,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
  const q=request({host:'127.0.0.1',port,path,method,headers:{host,...(data===undefined?{}:{'content-type':typeof body==='string'?'application/x-www-form-urlencoded':'application/json','content-length':Buffer.byteLength(data)}),...headers}},r=>{
   let t='';r.setEncoding('utf8');r.on('data',c=>t+=c);r.on('end',()=>{let json=null;try{json=JSON.parse(t)}catch{}resolve({status:r.statusCode,text:t,json,headers:r.headers})});
  });
  q.on('error',reject);q.end(data);
 });
}
const rpc2=(host,bearer,country)=>async(method,params={})=>send(PORTS.CONNECTOR_PORT,host,'/',{method:'POST',body:{jsonrpc:'2.0',id:1,method,params},
 headers:{accept:'application/json, text/event-stream',authorization:`Bearer ${bearer}`,...(country?{'cf-ipcountry':country}:{})}});
const register=async(redirect_uris)=>{const r=await fetch(AS+'/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris,response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'})});return {status:r.status,body:await r.json()}};
async function signIn({clientId,redirect,resource,identity='DEV:did:privy:region-owner'}){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',scope:SCOPES.join(' '),resource,state:'s1'});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);assert.equal(r.status,303);
 let page=r.headers.get('location');
 let d=await (await step(page)).json();assert.equal(d.prompt,'login');
 r=await step(page,form({csrf:d.csrf,identity_token:identity}));r=await step(r.headers.get('location'));
 page=r.headers.get('location');
 const next=await step(page);
 if(next.status===303)r=next;
 else{d=await next.json();assert.equal(d.prompt,'consent');r=await step(page,form({csrf:d.csrf,consent:'yes'}))}
 r=await step(r.headers.get('location'));
 const callback=new URL(r.headers.get('location'));
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect,client_id:clientId,resource})})).json();
 assert.ok(token.access_token,JSON.stringify(token));
 return token.access_token;
}
const H=new URL(ORIGIN).host;

test('sign-in server: sign-in, consent, approval, trade and funding pages from a blocked country get the 451 page or REGION_BLOCKED; the terms page and other countries go through',async()=>{
 for(const path of ['/account/login','/interaction/abcdefghij','/sign','/fund']){
  const r=await send(PORTS.AS_PORT,H,path,{headers:{'cf-ipcountry':'IR'}});
  assert.equal(r.status,451,path);assert.ok(r.text.includes(REGION_LINE),path);assert.ok(r.text.includes('https://yeet.win/terms#section-2a'),path);
 }
 const approve=await send(PORTS.AS_PORT,new URL(AGENT).host,'/approve',{headers:{'cf-ipcountry':'KP'}});
 assert.equal(approve.status,451,'the agent approval page, on the agent host');
 const wallets=await send(PORTS.AS_PORT,H,'/account/wallets',{method:'POST',body:{},headers:{'cf-ipcountry':'CU'}});
 assert.equal(wallets.status,451);assert.deepEqual(wallets.json,{error:'REGION_BLOCKED',country:'CU'});
 const login=await send(PORTS.AS_PORT,H,'/account/login',{method:'POST',body:'csrf=x&identity_token=DEV:did:privy:x',headers:{'cf-ipcountry':'SY',origin:ORIGIN}});
 assert.equal(login.status,451,'a sign-in form post');
 for(const [path,country] of [['/account/login','DE'],['/account/login',undefined],['/account/terms','IR']]){
  const r=await send(PORTS.AS_PORT,H,path,{headers:country?{'cf-ipcountry':country}:{}});
  assert.notEqual(r.status,451,`${path} ${country}`);
 }
 assert.ok(blockedLog.some(l=>l.country==='IR'&&l.path==='/account/login'));
});

let chatgptToken,agentToken;
test('MCP, both hosts: the tool calls that prepare a trade or create an account answer REGION_BLOCKED from a blocked country; reads go through',async()=>{
 const c=await register([STABLE]),a=await register([LOOPBACK]);assert.equal(c.status,201);assert.equal(a.status,201);
 chatgptToken=await signIn({clientId:c.body.client_id,redirect:STABLE,resource:ORIGIN});
 agentToken=await signIn({clientId:a.body.client_id,redirect:LOOPBACK,resource:AGENT});
 const {TERMS_VERSION,REQUIRED_IDS}=await import('../core/terms.mjs');
 const t=await rpc2(H,chatgptToken)('tools/call',{name:'yeet_accept_terms',arguments:{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}});
 assert.equal(t.status,200);assert.equal(t.json.result.isError,undefined,JSON.stringify(t.json.result));

 const chat=rpc2(H,chatgptToken,'IR');
 const P='p_abcdefghij0123456789';
 for(const [name,args] of [['yeet_propose',{request_id:'r1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]}],['skeet_propose',{request_id:'r2',legs:[{symbol:'WIF',percent:100}]}],
  ['yeet_quote',{proposal_id:P}],['execute_trade',{proposal_id:P,revision:1,confirm:'a'.repeat(43)}]]){
  const r=await chat('tools/call',{name,arguments:args});
  assert.equal(r.status,200,name);
  assert.equal(r.json.result.isError,true,name);
  const v=JSON.parse(r.json.result.content[0].text);
  assert.equal(v.error,'REGION_BLOCKED',name);assert.equal(v.retryable,false);assert.equal(v.message,toolMessage('REGION_BLOCKED'));
  assert.match(v.guidance,/YEET/);
 }
 const read=await chat('tools/call',{name:'yeet_overview',arguments:{}});
 assert.equal(read.status,200);assert.doesNotMatch(read.json.result.content[0].text,/REGION_BLOCKED/,'the overview still answers');
 const elsewhere=await rpc2(H,chatgptToken,'DE')('tools/call',{name:'yeet_propose',arguments:{request_id:'r3',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]}});
 assert.doesNotMatch(elsewhere.json.result.content[0].text,/REGION_BLOCKED/,'another country is not blocked');

 const agent=rpc2(new URL(AGENT).host,agentToken,'KP');
 const reg=await agent('tools/call',{name:'agent_register_key',arguments:{public_key:'a'.repeat(64),budget_usdc:'5'}});
 assert.equal(reg.json.result.isError,true);assert.equal(JSON.parse(reg.json.result.content[0].text).error,'REGION_BLOCKED','an agent account is not created');
 const quote=await agent('tools/call',{name:'agent_quote',arguments:{side:'buy',coins:['WIF'],amount_usdc:'1'}});
 assert.equal(JSON.parse(quote.json.result.content[0].text).error,'REGION_BLOCKED');
 const status=await agent('tools/call',{name:'agent_overview',arguments:{}});
 assert.doesNotMatch(status.json.result.content[0].text,/REGION_BLOCKED/,'agent_overview reads');
 assert.ok(blockedLog.some(l=>l.country==='KP'&&l.route==='/agent/register'));
 // tools/list is the same from a blocked country: no schema depends on the region.
 const l1=await rpc2(H,chatgptToken,'IR')('tools/list'),l2=await rpc2(H,chatgptToken)('tools/list');
 assert.equal(JSON.stringify(l1.json.result),JSON.stringify(l2.json.result));
});

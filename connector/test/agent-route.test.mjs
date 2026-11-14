// The agent route end to end (connector/docs/AGENT-ROUTE.md), in-process like test/acceptance.test.mjs: the sign-in server
// (38878), connector (38879), core (38880) and admin (38881) on 127.0.0.1 with throwaway state, YEET_AGENT_ROUTE=on, the
// ledger route on the in-memory ledger and 1Click of the ledger tests. The agent key is generated here, as an agent
// generates it on its own machine. Nothing outside the temp directory is touched; no network.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';

const ORIGIN='https://chatgpt.yeet.win',AGENT='https://mcp.yeet.win';
const PORTS={AS_PORT:38878,CONNECTOR_PORT:38879,CORE_PORT:38880,ADMIN_PORT:38881};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`,CORE=`http://127.0.0.1:${PORTS.CORE_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-agent-route-'));
const secrets=join(root,'secrets'),state=join(root,'state');
mkdirSync(secrets);mkdirSync(state);
for(const name of ['core-introspection','introspection','core-as','core-mcp','core-operator','operator','csrf'])
 writeFileSync(join(secrets,name),randomBytes(32).toString('base64url'),{mode:0o600});
// A throwaway solver key for this run only (the ledger route refuses to start without one).
const {loadOrCreateNearKey}=await import('../core/intents/near-tx.mjs');
const near=loadOrCreateNearKey(join(secrets,'solver.json'));
Object.assign(process.env,{
 ISSUER:ORIGIN,RESOURCE:ORIGIN,AS_INTERNAL:AS,CORE_INTERNAL:CORE,
 STATE_DIR:state,SECRETS_DIR:secrets,LISTEN_HOST:'127.0.0.1',TEST_PROFILE:'1',DEV_IDENTITY_STUB:'1',ACCESS_TTL:'300',
 ...Object.fromEntries(Object.entries(PORTS).map(([k,v])=>[k,String(v)])),
 YEET_AGENT_ROUTE:'on',AGENT_RESOURCE:AGENT,YEET_AGENT_MAX_TRADE_USDC:'5',YEET_AGENT_MAX_DAY_USDC:'8',
 YEET_LIVE:'1',YEET_ROUTE:'ledger',YEET_SOLVER_ACCOUNT:near.accountId,YEET_SOLVER_KEY_FILE:join(secrets,'solver.json'),
 YEET_SOLVER_MAX_TRADE_USDC:'25',YEET_SOLVER_MAX_DAY_USDC:'60',YEET_MIN_LEG_USDC:'1',YEET_MARKET_DATA:'off',
});
for(const name of ['PUBLIC_MODE','PRIVY_LOGIN','MOCK_PASSWORD_LOGIN','PUBLIC_BASE_URL','COOKIE_SECURE','TRUST_PROXY','YEET_LIVE_ACCOUNTS','YEET_KILL_SWITCH','YEET_LEDGER_DEPOSIT_NETWORKS'])delete process.env[name];
for(const level of ['info','warn']){const orig=console[level];console[level]=(m,...rest)=>{if(!String(m).includes('oidc-provider'))orig(m,...rest)}}

// The trade engine on the in-memory ledger: every YEET account's wallet is Alice's test wallet.
const {fakeLedger,fakeLedgerOneClick,approve,aliceWallet,accountOf,USDC,WIF}=await import('../core/ledger-route/fakes.mjs');
const {fakeClock,fakeBalances,BASE_WALLET}=await import('../core/trade/fakes.mjs');
const {fakeSolanaRpc,fakeFeePayer}=await import('../core/pipeline/fakes.mjs');
const {openTradeDb}=await import('../core/trade/db.mjs');
const {configureTradeEngine}=await import('../core/trade/runtime.mjs');
const {localSigner}=await import('../core/pipeline/solana/verify.mjs');
const {ed25519AccountId}=await import('../core/intents/sign.mjs');
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
const {tradeEngine}=await import('../core/trade/runtime.mjs');
after(async()=>{
 for(const s of [connector.server,as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:prepare'];
const STABLE='https://chatgpt.com/connector_platform_oauth_redirect',LOOPBACK='http://127.0.0.1:53682/callback';
const local=url=>{const u=new URL(url,ORIGIN);return u.origin===ORIGIN?`${AS}${u.pathname}${u.search}`:u.href};
function jar(){const c=new Map();return {header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '),add(r){for(const s of r.headers.getSetCookie()){const p=s.split(';')[0],i=p.indexOf('=');c.set(p.slice(0,i),p.slice(i+1))}}}}
/** POST to the connector with a chosen Host (fetch cannot set it). */
function post(host,path,body,bearer){
 return new Promise((resolve,reject)=>{
  const data=JSON.stringify(body);
  const q=request({host:'127.0.0.1',port:PORTS.CONNECTOR_PORT,path,method:body===undefined?'GET':'POST',headers:{host,'content-type':'application/json',accept:'application/json, text/event-stream',...(bearer?{authorization:`Bearer ${bearer}`}:{}),...(body===undefined?{}:{'content-length':Buffer.byteLength(data)})}},r=>{
   let t='';r.setEncoding('utf8');r.on('data',c=>t+=c);r.on('end',()=>{let json=null;try{json=JSON.parse(t)}catch{}resolve({status:r.statusCode,json,headers:r.headers})});
  });
  q.on('error',reject);q.end(body===undefined?undefined:data);
 });
}
const rpcTo=(host,bearer)=>async(method,params={})=>(await post(host,'/',{jsonrpc:'2.0',id:1,method,params},bearer));
const register=async(redirect_uris)=>{const r=await fetch(AS+'/reg',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris,response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none',application_type:redirect_uris[0].startsWith('http:')?'native':'web'})});return {status:r.status,body:await r.json()}};
/** The authorization: sign in with the development identity, press Connect when the page asks, redeem the code. */
async function signIn({clientId,redirect,resource,identity='DEV:did:privy:agent-owner'}){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',scope:SCOPES.join(' '),resource,state:'s1'});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);
 if(r.status!==303)return {refused:{status:r.status}};
 let page=r.headers.get('location');
 if(page.startsWith(redirect))return {refused:Object.fromEntries(new URL(page).searchParams)};
 let d=await (await step(page)).json();assert.equal(d.prompt,'login');
 r=await step(page,form({csrf:d.csrf,identity_token:identity}));r=await step(r.headers.get('location'));
 page=r.headers.get('location');
 const next=await step(page);
 if(next.status===303)r=next;
 else{d=await next.json();assert.equal(d.prompt,'consent');r=await step(page,form({csrf:d.csrf,consent:'yes'}))}
 r=await step(r.headers.get('location'));
 const callback=new URL(r.headers.get('location'));
 if(callback.searchParams.get('error'))return {refused:Object.fromEntries(callback.searchParams)};
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:callback.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect,client_id:clientId,resource})})).json();
 assert.ok(token.access_token,JSON.stringify(token));
 return token;
}
async function introspect(token){
 const r=await fetch(AS+'/token/introspection',{method:'POST',headers:{host:new URL(ORIGIN).host,'content-type':'application/x-www-form-urlencoded',authorization:'Basic '+Buffer.from(`mcp-resource:${(await import('node:fs')).readFileSync(join(secrets,'introspection'),'utf8').trim()}`).toString('base64')},body:new URLSearchParams({token})});
 return r.json();
}

let chatgpt,agentClient,chatgptToken,agentToken;
test('registration classes every client by its redirect URIs: ChatGPT\'s, an agent\'s loopback callback; a mixed list is refused',async()=>{
 const c=await register([STABLE]);assert.equal(c.status,201);chatgpt=c.body.client_id;
 const a=await register([LOOPBACK]);assert.equal(a.status,201,JSON.stringify(a.body));agentClient=a.body.client_id;
 assert.equal((await register(['https://agent.example/callback'])).status,400,'https callbacks: a web site posing as an agent');
 const mixed=await register([STABLE,LOOPBACK]);
 assert.equal(mixed.status,400);assert.equal(mixed.body.error,'invalid_redirect_uri');
 assert.equal((await register(['http://agent.example/callback'])).status,400,'plain http off loopback');
 assert.equal((await register(['myapp://callback'])).status,400,'custom schemes');
});

test('OAuth step, both directions: an agent asking for the ChatGPT endpoint and ChatGPT asking for the agent endpoint get WRONG_ROUTE with the right URL',async()=>{
 const a=await signIn({clientId:agentClient,redirect:LOOPBACK,resource:ORIGIN});
 assert.equal(a.refused?.error,'invalid_target');assert.match(a.refused.error_description,/^WRONG_ROUTE: This is the ChatGPT version of YEET, installed in a coding agent\. Agents connect to https:\/\/mcp\.yeet\.win/);
 const c=await signIn({clientId:chatgpt,redirect:STABLE,resource:AGENT});
 assert.equal(c.refused?.error,'invalid_target');assert.match(c.refused.error_description,/^WRONG_ROUTE: This is the agent version of YEET \(https:\/\/mcp\.yeet\.win\), installed inside ChatGPT\. In ChatGPT, add YEET with https:\/\/chatgpt\.yeet\.win/);
});

test('tokens carry the class and the resource; the owner accepts the terms in ChatGPT',async()=>{
 chatgptToken=(await signIn({clientId:chatgpt,redirect:STABLE,resource:ORIGIN})).access_token;
 agentToken=(await signIn({clientId:agentClient,redirect:LOOPBACK,resource:AGENT})).access_token;
 const ci=await introspect(chatgptToken),ai=await introspect(agentToken);
 assert.equal(ci.yeet_route,'chatgpt');assert.equal(ci.aud,ORIGIN);
 assert.equal(ai.yeet_route,'agent');assert.equal(ai.aud,AGENT);assert.equal(ai.sub,ci.sub,'the same YEET account');
 const {TERMS_VERSION,REQUIRED_IDS}=await import('../core/terms.mjs');
 const t=await rpcTo(new URL(ORIGIN).host,chatgptToken)('tools/call',{name:'yeet_accept_terms',arguments:{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}});
 assert.equal(t.status,200);assert.equal(t.json.result.isError,undefined,JSON.stringify(t.json.result));
});

test('MCP call, both directions: the agent token on the ChatGPT endpoint and the ChatGPT token on the agent host are refused with WRONG_ROUTE',async()=>{
 const onChatgpt=await rpcTo(new URL(ORIGIN).host,agentToken)('tools/list');
 assert.equal(onChatgpt.status,403);assert.equal(onChatgpt.json.error.data.error,'WRONG_ROUTE');assert.equal(onChatgpt.json.error.data.correct_url,AGENT);
 assert.match(onChatgpt.json.error.message,/installed in a coding agent/);
 const onAgent=await rpcTo(new URL(AGENT).host,chatgptToken)('tools/list');
 assert.equal(onAgent.status,403);assert.equal(onAgent.json.error.data.error,'WRONG_ROUTE');assert.equal(onAgent.json.error.data.correct_url,ORIGIN);
 // core refuses the same way when a token reaches the other class's routes
 const sec=(await import('node:fs')).readFileSync(join(secrets,'core-mcp'),'utf8').trim();
 const viaCore=async(path,bearer)=>{const r=await fetch(CORE+path,{headers:{authorization:`Bearer ${sec}`,'x-delegated-bearer':bearer}});return {status:r.status,body:await r.json().catch(()=>null)}};
 assert.deepEqual([(await viaCore('/agent/overview',chatgptToken)).body?.error,(await viaCore('/overview',agentToken)).body?.error],['WRONG_ROUTE','WRONG_ROUTE']);
 // the agent host serves its own metadata and nothing of the ChatGPT endpoint
 const prm=await post(new URL(AGENT).host,'/.well-known/oauth-protected-resource');
 assert.equal(prm.status,200);assert.equal(prm.json.resource,AGENT);
 assert.equal((await post(new URL(AGENT).host,'/version')).status,404);
 const unauth=await rpcTo(new URL(AGENT).host)('tools/list');
 assert.equal(unauth.status,401);assert.match(unauth.headers['www-authenticate'],/mcp\.yeet\.win\/\.well-known\/oauth-protected-resource/);
});

const sign=(key,message)=>Buffer.from(key.signMessage(Buffer.from(message,'utf8'))).toString('base64');
test('the agent end to end: register its own key, the owner approves the budget on the page, quote, prepare, sign locally, submit, limits, return',async()=>{
 const call=async(name,args={})=>{const r=await rpcTo(new URL(AGENT).host,agentToken)('tools/call',{name,arguments:args});assert.equal(r.status,200,JSON.stringify(r.json));const res=r.json.result;return res.isError?{error:JSON.parse(res.content[0].text)}:res.structuredContent};
 const list=await rpcTo(new URL(AGENT).host,agentToken)('tools/list');
 assert.deepEqual(list.json.result.tools.map(t=>t.name).sort(),['agent_balance','agent_how_it_works','agent_overview','agent_positions','agent_prepare_trade','agent_quote','agent_register_key','agent_return_budget','agent_submit_signature','agent_trade_status']);
 for(const t of list.json.result.tools)assert.equal(t._meta,undefined,`${t.name}: no card metadata`);
 assert.match((await call('agent_how_it_works')).text,/Keep the private key there; YEET never asks for it/);
 assert.equal((await call('agent_overview')).state,'not_registered');
 // YEET_AGENT_OWNER_ACCOUNT unset: account "owner" is refused, machine-readably; the overview is the base overview
 for(const [name,args] of [['agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'3',account:'owner'}],['agent_balance',{account:'owner'}],['agent_positions',{account:'owner'}],['agent_return_budget',{account:'owner'}]])
  assert.deepEqual([(await call(name,args)).error?.error,(await call(name,args)).error?.retryable],['OWNER_ACCOUNT_OFF',false],name);
 assert.equal(Object.hasOwn(await call('agent_overview'),'owner_account'),false);
 const key=localSigner(),agentLedger=ed25519AccountId(key.address);
 const reg=await call('agent_register_key',{public_key:`ed25519:${key.address}`,budget_usdc:'10'});
 assert.equal(reg.state,'awaiting_budget');assert.equal(reg.agent_account,agentLedger);
 const link=new URL(reg.budget_url);assert.equal(link.origin+link.pathname,`${ORIGIN}/sign`);
 // the page: the owner's session (the sign-in server's core credential, as as/sign-page.mjs calls it)
 const asSecret=(await import('node:fs')).readFileSync(join(secrets,'core-as'),'utf8').trim(),owner=(await introspect(agentToken)).sub;
 const page=async(path,body={})=>(await fetch(CORE+path,{method:'POST',headers:{authorization:`Bearer ${asSecret}`,'x-yeet-subject':owner,'content-type':'application/json'},body:JSON.stringify(body)})).json();
 const op=link.searchParams.get('trade_id'),open=await page(`/sign/trades/${op}/requests`),req=open.sign_requests[0];
 assert.equal(open.direction,'fund');assert.equal(JSON.parse(req.payload.message).intents[0].receiver_id,agentLedger);
 const done=await page(`/sign/trades/${op}/signature`,{leg:0,attempt_id:req.attempt_id,signed:approve(aliceWallet,req)});
 assert.equal(done.status,'success',JSON.stringify(done));
 assert.equal((await call('agent_overview')).state,'active');assert.equal((await call('agent_balance')).usdc,'10');
 // limits: 5 per trade, 8 a day
 assert.equal((await call('agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'6'})).error.error,'LIMIT_EXCEEDED');
 const q=await call('agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'5'});
 const x=await call('agent_prepare_trade',{quote_id:q.quote_id});
 assert.equal(JSON.parse(x.request.message).signer_id,agentLedger);
 const bad=await call('agent_submit_signature',{request_id:x.request.request_id,signature:sign(localSigner(),x.request.message)});
 assert.equal(bad.error.error,'INVALID_ARGUMENT');
 const s=await call('agent_submit_signature',{request_id:x.request.request_id,signature:sign(key,x.request.message)});
 assert.equal(s.trade_id,x.trade_id);
 await (await tradeEngine()).ledgerRoute.idle();
 assert.equal((await call('agent_trade_status',{trade_id:x.trade_id})).status,'success');
 assert.equal(world.balance(agentLedger,USDC),5_000_000n);assert.ok(world.balance(agentLedger,WIF)>0n);
 const q2=await call('agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'4'});
 const over=await call('agent_prepare_trade',{quote_id:q2.quote_id});
 assert.equal(over.error.error,'LIMIT_EXCEEDED');assert.match(over.error.message,/3 USDC more today/);
 const pos=await call('agent_positions');assert.equal(pos.holdings[0].symbol,'WIF');assert.equal(pos.recent_trades.length,1);
 // return: USDC first, to the owner's ledger account only, signed by the agent
 const ret=await call('agent_return_budget');
 assert.equal(ret.receiver_id,accountOf(aliceWallet));
 const back=await call('agent_submit_signature',{request_id:ret.request_id,signature:sign(key,ret.message)});
 assert.equal(back.status,'settled');assert.equal(world.balance(agentLedger,USDC),0n);
 assert.equal(world.balance(accountOf(aliceWallet),USDC),15_000_000n);
 assert.equal(ret.remaining_tokens,1,'the WIF is next');
});

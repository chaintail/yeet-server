// Owner account mode of the agent route end to end (connector/docs/AGENT-ROUTE.md, YEET_AGENT_OWNER_ACCOUNT=on), in-process
// like test/agent-route.test.mjs: the sign-in server (38890), connector (38891), core (38892) and admin (38893) on 127.0.0.1
// with throwaway state, the ledger route on the in-memory ledger and 1Click of the ledger tests, XP on (YEET_P2=1).
// aliceWallet (a key made here) stands in for the person's Privy Solana wallet: in production the agent obtains the
// signature from Privy itself. Nothing outside the temp directory is touched; no network.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {request} from 'node:http';

const ORIGIN='https://chatgpt.yeet.win',AGENT='https://mcp.yeet.win';
const PORTS={AS_PORT:38890,CONNECTOR_PORT:38891,CORE_PORT:38892,ADMIN_PORT:38893};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`,CORE=`http://127.0.0.1:${PORTS.CORE_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-agent-owner-'));
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
 YEET_AGENT_ROUTE:'on',YEET_AGENT_OWNER_ACCOUNT:'on',AGENT_RESOURCE:AGENT,YEET_AGENT_MAX_TRADE_USDC:'5',YEET_AGENT_MAX_DAY_USDC:'8',
 YEET_P2:'1',YEET_XP_SECRET:randomBytes(32).toString('base64url'),
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

let chatgpt,agentClient,chatgptToken,agentToken,owner;
const sign=(key,message)=>Buffer.from(key.signMessage(Buffer.from(message,'utf8'))).toString('base64');
const toolCall=(host,bearer)=>async(name,args={})=>{const r=await rpcTo(host,bearer)('tools/call',{name,arguments:args});assert.equal(r.status,200,JSON.stringify(r.json));const res=r.json.result;return res.isError?{error:JSON.parse(res.content[0].text)}:res.structuredContent};

test('setup: a ChatGPT connection and an agent connection of the same YEET account; terms accepted in ChatGPT',async()=>{
 chatgpt=(await register([STABLE])).body.client_id;agentClient=(await register([LOOPBACK])).body.client_id;
 chatgptToken=(await signIn({clientId:chatgpt,redirect:STABLE,resource:ORIGIN})).access_token;
 agentToken=(await signIn({clientId:agentClient,redirect:LOOPBACK,resource:AGENT})).access_token;
 owner=(await introspect(agentToken)).sub;assert.equal((await introspect(chatgptToken)).sub,owner);
 const {TERMS_VERSION,REQUIRED_IDS}=await import('../core/terms.mjs');
 const t=await rpcTo(new URL(ORIGIN).host,chatgptToken)('tools/call',{name:'yeet_accept_terms',arguments:{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}});
 assert.equal(t.json.result.isError,undefined,JSON.stringify(t.json.result));
});

test('owner account end to end: the agent trades the person\'s own account, the person\'s wallet signs; XP and the ChatGPT portfolio see it; transfers and replays refused',async()=>{
 const call=toolCall(new URL(AGENT).host,agentToken),chat=toolCall(new URL(ORIGIN).host,chatgptToken);
 const list=await rpcTo(new URL(AGENT).host,agentToken)('tools/list');
 const quoteTool=list.json.result.tools.find(t=>t.name==='agent_quote');
 assert.deepEqual(quoteTool.inputSchema.properties.account.enum,['agent','owner']);
 const o=await call('agent_overview');
 assert.equal(o.state,'not_registered');assert.equal(o.owner_account.available,true);assert.equal(o.owner_account.ledger_account,accountOf(aliceWallet));
 assert.equal((await call('agent_balance',{account:'owner'})).usdc,'20');
 assert.equal((await call('agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'6',account:'owner'})).error.error,'LIMIT_EXCEEDED');
 const {xpRuntime}=await import('../core/xp/xp.mjs');
 const xpBefore=xpRuntime().ledger.total(owner);
 const q=await call('agent_quote',{side:'buy',coins:['WIF'],amount_usdc:'3',account:'owner'});
 assert.equal(q.account,'owner');
 const x=await call('agent_prepare_trade',{quote_id:q.quote_id,account:'owner'});
 const m=JSON.parse(x.request.message);
 assert.equal(m.signer_id,accountOf(aliceWallet));assert.deepEqual(m.intents.map(i=>i.intent),['token_diff']);
 // the ChatGPT route cannot sign the agent's request
 const leg=0,[tradeId,attemptId]=x.request.request_id.split('.');
 const viaChat=await chat('submit_trade_signature',{trade_id:tradeId,leg,attempt_id:attemptId,signed:sign(aliceWallet,x.request.message)});
 assert.equal(viaChat.error?.error,'INVALID_ARGUMENT',JSON.stringify(viaChat));assert.equal(world.balance(accountOf(aliceWallet),USDC),20_000_000n);
 // a key that is not the person's wallet
 assert.equal((await call('agent_submit_signature',{request_id:x.request.request_id,signature:sign(localSigner(),x.request.message),account:'owner'})).error.error,'SIGNATURE_INVALID');
 const s=await call('agent_submit_signature',{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),account:'owner'});
 assert.equal(s.trade_id,x.trade_id,JSON.stringify(s));
 await (await tradeEngine()).ledgerRoute.idle();
 assert.equal((await call('agent_trade_status',{trade_id:x.trade_id,account:'owner'})).status,'success');
 assert.equal(world.balance(accountOf(aliceWallet),USDC),17_000_000n);assert.ok(world.balance(accountOf(aliceWallet),WIF)>0n);
 // replay
 assert.equal((await call('agent_submit_signature',{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),account:'owner'})).error.error,'REQUEST_USED');
 assert.equal(world.balance(accountOf(aliceWallet),USDC),17_000_000n);
 // the person's own trade: XP, and the ChatGPT portfolio
 assert.ok(xpRuntime().ledger.total(owner)>xpBefore,'the trade earned XP for the person');
 const pf=await chat('yeet_portfolio');
 assert.ok(JSON.stringify(pf).includes('WIF'),JSON.stringify(pf).slice(0,400));
 const pos=await call('agent_positions',{account:'owner'});
 assert.equal(pos.usdc,'17');assert.equal(pos.recent_trades[0].trade_id,x.trade_id);
 // trades only, and the agent-mode default is untouched
 assert.equal((await call('agent_return_budget',{account:'owner'})).error.error,'OWNER_TRADES_ONLY');
 assert.equal((await call('agent_balance')).error.error,'AGENT_NOT_REGISTERED');
 // an account cannot be named: only the two selectors pass the tool's schema
 const named=await rpcTo(new URL(AGENT).host,agentToken)('tools/call',{name:'agent_balance',arguments:{account:'yeet-privy-someone-else'}});
 assert.equal(named.json.result.isError,true);assert.match(named.json.result.content[0].text,/invalid/i);
});

// shared/log.mjs: the access line, the tool line and the scrub never carry a token, a cookie, an OAuth code or an
// email address; health checks are debug and suppressed at the default level.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {log,accessLog,setSink,setAccount,requestIdHeader,pathAndQueryKeys,clientAddress,emailDomain,resultClass,argShape,redactPath,safeClientId,scrub,learnRoutes} from './log.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../mcp/tool-registration.mjs';
import {createAgentMcpServer} from '../mcp/agent.mjs';
import {allScopes} from '#scope-catalog';

const BEARER='eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ5ZWV0LXByaXZ5LWFiYyJ9.c2lnbmF0dXJlLXZhbHVl';
const COOKIE='_session=s3cr3t-cookie-value; _interaction=another-secret-cookie';
const CODE='oauth-code-Zq81mNw3xYvT';
const EMAIL='alice.person@example-mail.com';
const SECRETS=[BEARER,'s3cr3t-cookie-value','another-secret-cookie',CODE,EMAIL,'alice.person',encodeURIComponent(EMAIL)];

function capture(){const lines=[];const prev=setSink(l=>lines.push(l));return {lines,parsed:()=>lines.map(l=>JSON.parse(l)),restore:()=>setSink(prev)}}
async function withServer(app,fn){
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s))});
 try{return await fn(`http://127.0.0.1:${server.address().port}`)}finally{await new Promise(ok=>server.close(ok))}
}
const settle=()=>new Promise(ok=>setTimeout(ok,20));

test('a request with a bearer token, a cookie, a code= query and an email leaves none of them in the lines',async()=>{
 const c=capture();let sentRid;
 try{
  const app=express();app.use(accessLog({svc:'mcp'}));app.use(express.json());
  app.post('/token',(q,r)=>{setAccount('yeet-privy-abc');sentRid=requestIdHeader()['x-request-id'];
   log.warn('sign_in_failed',{email:q.body.email,authorization:q.headers.authorization,cookie:q.headers.cookie,note:`for ${q.body.email} with Bearer ${BEARER}`});
   r.status(401).json({error:'invalid_token'})});
  await withServer(app,base=>fetch(`${base}/token?code=${CODE}&state=st-1&login_hint=${encodeURIComponent(EMAIL)}`,{method:'POST',
   headers:{authorization:`Bearer ${BEARER}`,cookie:COOKIE,'content-type':'application/json','user-agent':'x'.repeat(300),
    'cf-connecting-ip':'203.0.113.7','x-forwarded-for':'198.51.100.1, 10.0.0.1','cf-ipcountry':'DE'},
   body:JSON.stringify({email:EMAIL,code:CODE})}));
  await settle();
 }finally{c.restore()}
 const all=c.lines.join('\n');
 for(const s of SECRETS)assert.ok(!all.includes(s),`leaked: ${s}`);
 const lines=c.parsed();
 const access=lines.find(l=>l.event==='http_request');
 assert.ok(access,'access line written');
 assert.equal(access.method,'POST');assert.equal(access.path,'/token');
 assert.deepEqual(access.query_keys,['code','state','login_hint']);
 assert.equal(access.status,401);assert.equal(access.client,'203.0.113.7');assert.equal(access.country,'DE');
 assert.equal(access.ua.length,200);assert.equal(access.account,'yeet-privy-abc');
 assert.equal(access.rid,sentRid);assert.ok(typeof access.ms==='number');
 for(const k of ['ts','svc','level','event'])assert.ok(k in access,k);
 assert.equal(access.svc,'mcp');
 assert.ok(!Number.isNaN(Date.parse(access.ts))&&access.ts.endsWith('Z'));
 const ev=lines.find(l=>l.event==='sign_in_failed');
 assert.equal(ev.level,'warn');assert.equal(ev.authorization,'[redacted]');assert.equal(ev.cookie,'[redacted]');
 assert.equal(ev.email,'[email]@example-mail.com');assert.equal(ev.rid,sentRid);assert.equal(ev.svc,'mcp');
});

// An MCP client connected in memory to one of our servers: every call goes through the SDK's tools/call dispatch.
async function connected(server){
 const [a,b]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:'log-test',version:'0'});
 await Promise.all([server.connect(a),client.connect(b)]);
 return {call:(name,args)=>client.request({method:'tools/call',params:{name,arguments:args}},{parse:x=>x,safeParse:x=>({success:true,data:x})}).catch(e=>({thrown:e})),close:()=>client.close()};
}
const TOKEN={scope:allScopes.join(' '),sub:'yeet-privy-abc'};

test('the tool line has argument keys, types and sizes, never values',async()=>{
 const c=capture();
 try{
  const m=await connected(createMcpServer({token:TOKEN,callCore:async()=>{throw {error:'LIMIT_EXCEEDED'}},env:{YEET_P2:'1'},log:()=>{}}));
  await m.call('yeet_propose',{legs:[{coin:'BONK'}],amount_usdc:5,note:EMAIL,token:BEARER});
  await m.close();
 }finally{c.restore()}
 const all=c.lines.join('\n');
 for(const s of SECRETS)assert.ok(!all.includes(s),`leaked: ${s}`);
 const lines=c.parsed().filter(l=>l.event==='tool_call');
 assert.equal(lines.length,1);
 const [a]=lines;
 assert.equal(a.tool,'yeet_propose');assert.equal(a.account,'yeet-privy-abc');assert.equal(a.endpoint,'chatgpt');
 assert.deepEqual(a.args.legs,{type:'array',size:1});assert.deepEqual(a.args.amount_usdc,{type:'number',size:0});assert.equal(a.args.note,undefined);
 assert.deepEqual(a.args['(other)'],{type:'keys',size:2},'note and token are not schema keys: counted, never named');
 assert.equal(resultClass({isError:true,structuredContent:{error:'TERMS_REQUIRED'}}),'TERMS_REQUIRED');
});

// Review finding 1: an id in the path (the provider's interaction uid, its /auth resume uid) is a sign-in credential.
test('regression: path ids are never logged; the route template or :id is',async()=>{
 const UID='Xq2k9_LmZ8vB3nT1yR4wAbC',UUID='5f2b1c9d-4e3a-4b6c-8d7e-9f0a1b2c3d4e';
 const c=capture();
 try{
  const app=express();app.use(accessLog({svc:'as'}));
  app.get('/interaction/:uid',(q,r)=>{log.warn('rate_limited',{path:q.originalUrl.split('?')[0]});r.sendStatus(200)});
  // Like the provider's koa app: answered without an Express route.
  app.use((q,r)=>{log.warn('region_blocked',{country:'IR',path:q.path,route:q.path});r.sendStatus(302)});
  await withServer(app,async base=>{await fetch(`${base}/interaction/${UID}?x=1`);await fetch(`${base}/auth/${UID}`);await fetch(`${base}/reg/${UUID}`)});
  await settle();
 }finally{c.restore()}
 const all=c.lines.join('\n');
 assert.ok(!all.includes(UID)&&!all.includes(UUID),'an id from the path was logged');
 const paths=c.parsed().filter(l=>l.event==='http_request').map(l=>l.path);
 assert.deepEqual(paths,['/interaction/:uid','/auth/:id','/reg/:id']);
 assert.equal(redactPath('/sign/trades/t_abcdefghij0123456789/requests'),'/sign/:id/:id/:id','not learned yet');
 {const a=express();a.post('/sign/trades/:id/requests',()=>{});learnRoutes(a)}
 assert.equal(redactPath('/sign/trades/t_abcdefghij0123456789/requests'),'/sign/trades/:id/requests');
 assert.equal(redactPath('/.well-known/oauth-protected-resource'),'/.well-known/oauth-protected-resource');
 // A template-looking segment in a caller's path is not trusted: templates are written only from a matched route.
 assert.equal(redactPath('/auth/:canary'),'/auth/:id');
});

// Second review, finding 1: short lowercase ids (8-12 characters, any position, trailing slash) passed the old
// heuristic. Now only allowlisted words (the provider's paths, our mounts, our own route definitions) are written.
test('regression: path segments are an allowlist; short lowercase ids are redacted',async()=>{
 for(const [raw,want] of [['/auth/abcdefgh/resume','/auth/:id/resume'],['/interaction/abcdefghijkl/','/interaction/:id/'],
  ['/abcdefgh','/:id'],['/session/end/confirm','/session/end/confirm'],['/.well-known/openid-configuration','/.well-known/openid-configuration'],
  ['/account/qwertyuiop/x','/account/:id/:id'],['/token?code=abc','/token']])assert.equal(redactPath(raw),want,raw);
 const ID='abcdefgh';const c=capture();
 try{
  const app=express();app.use(accessLog({svc:'mcp'}));
  app.get('/coins/:symbol',(_q,r)=>r.sendStatus(200));app.get('/zebra-route/list',(_q,r)=>r.sendStatus(200));
  app.use((q,r)=>{log.warn('rate_limited',{path:q.originalUrl.split('?')[0]});r.sendStatus(404)});
  learnRoutes(app);
  await withServer(app,async base=>{
   for(const host of ['chatgpt.yeet.win','mcp.yeet.win']){
    await fetch(`${base}/auth/${ID}/resume`,{headers:{host}});await fetch(`${base}/zebra-route/${ID}/`,{headers:{host}});
   }
   await fetch(`${base}/coins/${ID}`);
  });
  await settle();
 }finally{c.restore()}
 assert.ok(!c.lines.join('\n').includes(ID),'a short id from the path was logged');
 const paths=c.parsed().filter(l=>l.event==='http_request').map(l=>l.path);
 // zebra-route is a word of a registered route (learned); the template answers for a matched route.
 assert.deepEqual(paths,['/auth/:id/resume','/zebra-route/:id/','/auth/:id/resume','/zebra-route/:id/','/coins/:symbol']);
});

// Review finding 2: a CIMD client id is an https URL whose query can carry values and a percent-encoded email.
test('regression: URL client ids are origin + path only; URL queries and %40 emails are scrubbed',()=>{
 const CIMD='https://client.example/cimd/meta.json?owner=alice.person%40example-mail.com&k=v#frag';
 assert.equal(safeClientId(CIMD),'https://client.example/cimd/meta.json');
 assert.equal(safeClientId('chatgpt-registered-123'),'chatgpt-registered-123');
 assert.equal(safeClientId('https://'+'a'.repeat(300)+'.example/x').length<=200,true);
 const c=capture();
 try{log.warn('token_issued',{client_id:CIMD,note:`from ${CIMD}`,other:'alice.person%40example-mail.com'})}finally{c.restore()}
 const all=c.lines.join('\n');
 assert.ok(!all.includes('alice.person')&&!all.includes('owner=')&&!all.includes('frag'),all);
 const [l]=c.parsed();
 assert.equal(l.client_id,'https://client.example/cimd/meta.json');assert.equal(l.other,'[email]@example-mail.com');
 assert.equal(scrub('see https://x.example/a?code=Zz9&e=1 now'),'see https://x.example/a now');
});

// Review finding 3: the logger must never throw into the caller, whatever the input, at any level.
test('regression: a deeply nested argument or a failing logger never changes the tool answer',async()=>{
 let deep=[];for(let i=0;i<12000;i++)deep=[deep];
 assert.deepEqual(argShape({app_version:deep}),{app_version:{type:'array',size:1}});
 const prev=process.env.YEET_LOG_LEVEL;
 for(const level of ['error','info']){
  process.env.YEET_LOG_LEVEL=level;
  const c=capture();let out;
  try{
   const m=await connected(createMcpServer({token:TOKEN,callCore:async()=>{throw {error:'TEMPORARILY_UNAVAILABLE'}},env:{},log:()=>{}}));
   out=await m.call('yeet_overview',{app_version:deep});await m.close();
  }finally{c.restore();if(prev===undefined)delete process.env.YEET_LOG_LEVEL;else process.env.YEET_LOG_LEVEL=prev}
  assert.ok(!out.thrown,`threw: ${out.thrown}`);
  assert.ok(!JSON.stringify(out.content??'').includes('Maximum call stack'),'the answer was replaced by a RangeError');
 }
 // A sink that throws, a field whose getter throws: nothing reaches the caller.
 const prevSink=setSink(()=>{throw Error('sink down')});
 try{assert.doesNotThrow(()=>log.warn('x',{get bad(){throw Error('getter')}}))}finally{setSink(prevSink)}
 const c=capture();
 try{log.warn('x',{get bad(){throw Error('getter')}})}finally{c.restore()}
 assert.deepEqual(c.parsed().map(l=>l.event),['log_error']);
});

// Review finding 4: one tool_call line per tools/call, also when the SDK refuses the input or the tool is unknown.
test('regression: invalid input, unknown tools and ok calls each emit exactly one tool_call line',async()=>{
 const c=capture();
 try{
  const chat=await connected(createMcpServer({token:TOKEN,callCore:async()=>({}),env:{},log:()=>{}}));
  await chat.call('submit_trade_signature',{});
  await chat.call('no_such_tool',{a:1});
  await chat.close();
  const agent=await connected(createAgentMcpServer({token:TOKEN,callCore:async()=>({ok:true})}));
  await agent.call('agent_register_key',{});
  await agent.call('agent_how_it_works',{});
  await agent.close();
 }finally{c.restore()}
 const calls=c.parsed().filter(l=>l.event==='tool_call').map(l=>[l.endpoint,l.tool,l.result]);
 assert.deepEqual(calls,[['chatgpt','submit_trade_signature','invalid_input'],['chatgpt',null,'unknown_tool'],['agent','agent_register_key','invalid_input'],['agent','agent_how_it_works','ok']]);
});

// Second review, finding 2: an unknown tool name is the caller's text (it can be a URL with a password).
test('regression: an unknown tool name, unknown argument names, a forged address or query key are never logged',async()=>{
 const NAME='https://user:canaryPassword@host/';const c=capture();
 try{
  const chat=await connected(createMcpServer({token:TOKEN,callCore:async()=>({}),env:{},log:()=>{}}));
  await chat.call(NAME,{canaryArgKey:1});
  await chat.call('submit_trade_signature',{trade_id:'t_x',canarySecretKey:'v'});
  await chat.close();
  const app=express();app.use(accessLog());app.get('/token',(_q,r)=>r.sendStatus(200));
  await withServer(app,base=>fetch(`${base}/token?canaryQueryKey=1&state=s`,{headers:{'cf-connecting-ip':'canary-not-an-ip','cf-ipcountry':'canary','x-http-method-override':'x'}}));
  await settle();
 }finally{c.restore()}
 const all=c.lines.join('\n');
 assert.ok(!/canary/i.test(all),all);
 const [unknown,known]=c.parsed().filter(l=>l.event==='tool_call');
 assert.equal(unknown.tool,null);assert.equal(unknown.result,'unknown_tool');assert.equal(unknown.tool_name_length,NAME.length);assert.deepEqual(unknown.args,{'(other)':{type:'keys',size:1}});
 assert.equal(known.tool,'submit_trade_signature');assert.deepEqual(known.args['(other)'],{type:'keys',size:1});
 const access=c.parsed().find(l=>l.event==='http_request');
 assert.deepEqual(access.query_keys,['state']);assert.equal(access.query_other,1);assert.equal(access.client,'invalid');assert.equal(access.country,null);
});

test('health checks are debug: off by default and with YEET_LOG_LEVEL empty, on at debug',async()=>{
 const prev=process.env.YEET_LOG_LEVEL;const c=capture();
 try{
  const app=express();app.use(accessLog());app.get('/health',(_q,r)=>r.json({ok:true}));
  await withServer(app,async base=>{
   delete process.env.YEET_LOG_LEVEL;await fetch(`${base}/health`);await settle();
   process.env.YEET_LOG_LEVEL='';await fetch(`${base}/health`);await settle();
   assert.equal(c.lines.length,0);
   process.env.YEET_LOG_LEVEL='debug';await fetch(`${base}/health`);await settle();
  });
 }finally{c.restore();if(prev===undefined)delete process.env.YEET_LOG_LEVEL;else process.env.YEET_LOG_LEVEL=prev}
 assert.equal(c.lines.length,1);assert.equal(JSON.parse(c.lines[0]).level,'debug');
});

test('core takes a well-formed caller request id; privileged and 4xx lines are warn',async()=>{
 const c=capture();
 try{
  const app=express();app.use(accessLog({trustRequestId:true,privileged:q=>q.path.startsWith('/operator'),warnFrom:400}));
  app.post('/operator/x',(_q,r)=>r.json({ok:true}));app.get('/a',(_q,r)=>r.sendStatus(403));
  await withServer(app,async base=>{
   await fetch(`${base}/operator/x`,{method:'POST',headers:{'x-request-id':'11111111-2222-3333-4444-555555555555'}});
   await fetch(`${base}/a`,{headers:{'x-request-id':'bad id with spaces'}});
  });
  await settle();
 }finally{c.restore()}
 const [op,a]=c.parsed();
 assert.equal(op.rid,'11111111-2222-3333-4444-555555555555');assert.equal(op.level,'warn');assert.equal(op.privileged,true);
 assert.notEqual(a.rid,'bad id with spaces');assert.equal(a.level,'warn');assert.equal(a.status,403);
});

test('helpers',()=>{
 assert.deepEqual(pathAndQueryKeys('/auth?client_id=x&code=y&code=z'),{path:'/auth',query_keys:['client_id','code'],query_other:0});
 assert.equal(clientAddress({headers:{'x-forwarded-for':'198.51.100.1, 10.0.0.1'}}),'198.51.100.1');
 assert.equal(clientAddress({headers:{},socket:{remoteAddress:'127.0.0.1'}}),'127.0.0.1');
 assert.equal(emailDomain(EMAIL),'example-mail.com');assert.equal(emailDomain('nope'),null);
});

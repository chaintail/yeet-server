// shared/log.mjs: the access line, the tool line and the scrub never carry a token, a cookie, an OAuth code or an
// email address; health checks are debug and suppressed at the default level.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {log,accessLog,setSink,setAccount,requestIdHeader,pathAndQueryKeys,clientAddress,emailDomain,loggedTool,resultClass} from './log.mjs';

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

test('the tool line has argument keys and sizes, never values',async()=>{
 const c=capture();
 try{
  const ok=loggedTool('yeet_propose',{sub:'yeet-privy-abc'},async()=>({structuredContent:{}}));
  await ok({amount_usdc:'5',note:EMAIL,token:BEARER});
  const bad=loggedTool('execute_trade',{sub:'yeet-privy-abc'},async()=>({isError:true,content:[{type:'text',text:JSON.stringify({error:'LIMIT_EXCEEDED'})}]}));
  await bad({confirm:CODE});
 }finally{c.restore()}
 const all=c.lines.join('\n');
 for(const s of SECRETS)assert.ok(!all.includes(s),`leaked: ${s}`);
 const [a,b]=c.parsed();
 assert.equal(a.event,'tool_call');assert.equal(a.tool,'yeet_propose');assert.equal(a.account,'yeet-privy-abc');assert.equal(a.result,'ok');
 assert.deepEqual(Object.keys(a.args),['amount_usdc','note','token']);assert.equal(a.args.note,JSON.stringify(EMAIL).length);
 assert.equal(b.result,'LIMIT_EXCEEDED');
 assert.equal(resultClass({isError:true,structuredContent:{error:'TERMS_REQUIRED'}}),'TERMS_REQUIRED');
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
 assert.deepEqual(pathAndQueryKeys('/auth?client_id=x&code=y&code=z'),{path:'/auth',query_keys:['client_id','code']});
 assert.equal(clientAddress({headers:{'x-forwarded-for':'198.51.100.1, 10.0.0.1'}}),'198.51.100.1');
 assert.equal(clientAddress({headers:{},socket:{remoteAddress:'127.0.0.1'}}),'127.0.0.1');
 assert.equal(emailDomain(EMAIL),'example-mail.com');assert.equal(emailDomain('nope'),null);
});

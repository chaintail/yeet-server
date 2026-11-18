import {authenticate} from './authenticate.mjs';
import {advertisedScopes} from '#scope-catalog';
import {createMcpServer} from './tool-registration.mjs';
import {createAgentMcpServer} from './agent.mjs';
import {agentRouteOn,agentResource,wrongRoute} from '#shared/agent-route.mjs';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import express from 'express';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {AS,RESOURCE,CORE,secret,PUBLIC,port} from '#shared/common.mjs';
import {readGeoblock,blockedCountry,regionGatedRoute,REGION_BLOCKED} from '#shared/region.mjs';
import {toolMessage} from '#contracts/errors';
import {log,accessLog,setAccount,requestIdHeader,learnRoutes,ERROR_CODE} from '#shared/log.mjs';
const app=express();app.disable('x-powered-by');
// One access line per request on both hosts (shared/log.mjs), health checks included at debug.
app.use(accessLog({svc:'mcp'}));
// The sanctions geoblock (shared/region.mjs, YEET_GEOBLOCK, off by default): on both hosts, a tool call that would
// create an account or prepare or send a trade is refused with REGION_BLOCKED before core is asked. Reads go through.
const GEOBLOCK=readGeoblock();
const regionRefusal=(country,route)=>{log.warn('region_blocked',{country,route:String(route).split('?')[0].slice(0,120)});return {error:REGION_BLOCKED,message:toolMessage(REGION_BLOCKED),retryable:false}};
// Health first: the container check runs without the public Host header.
app.get('/health',(_q,r)=>r.json({ok:true}));
// The agent endpoint (mcp/agent.mjs, connector/docs/AGENT-ROUTE.md) answers only requests whose Host is the agent host; such a
// request never reaches the ChatGPT endpoint. With YEET_AGENT_ROUTE off it answers 404.
const AGENT_ON=agentRouteOn();
const AGENT_HOST=(()=>{try{return new URL(agentResource()).host}catch{return 'mcp.yeet.win'}})();
app.use((q,r,next)=>q.headers.host===AGENT_HOST?(AGENT_ON?agentApp(q,r,next):r.sendStatus(404)):next());
if(PUBLIC)app.use((q,r,next)=>{if(q.headers.host!==new URL(RESOURCE).host)return r.sendStatus(421);next()});app.use(express.json({limit:'32kb'}));
// The protocol endpoint is the resource path only (the bare origin in production); there is no alias path.
const resourcePath=new URL(RESOURCE).pathname||'/';const prmPath='/.well-known/oauth-protected-resource'+resourcePath.replace(/\/$/,'');
// GET /version: core's public deployment facts (core/version.mjs), cached here for 60 s; no credential is sent.
let versionCache={at:0,body:null};
export const VERSION_TTL_MS=60_000;
app.get('/version',async(_q,r)=>{
 if(!versionCache.body||Date.now()-versionCache.at>=VERSION_TTL_MS){
  try{
   const c=await fetch(CORE+'/version',{redirect:'error',signal:AbortSignal.timeout(2000)});
   const raw=await c.text();if(!c.ok||Buffer.byteLength(raw)>4096)throw Error('core');
   versionCache={at:Date.now(),body:JSON.parse(raw)};
  }catch{r.set('Cache-Control','no-store');return r.status(503).json({error:'TEMPORARILY_UNAVAILABLE'})}
 }
 r.set('Cache-Control','public, max-age=60').json(versionCache.body);
});
app.get(prmPath,(_q,r)=>r.json({resource:RESOURCE,authorization_servers:[AS],scopes_supported:advertisedScopes(),bearer_methods_supported:['header']}));
const challenge=res=>res.set('WWW-Authenticate',`Bearer resource_metadata="${new URL(RESOURCE).origin}${prmPath}"`);
/** Core deadline per route: proposals (YEET and SKEET) and quotes 15 s, trade execution 25 s, the overview (wallets,
 * balances and holdings in one answer) 8 s, everything else 4.5 s. */
export const coreTimeout=(route,method)=>method==='GET'&&route==='/overview'?8000:method==='POST'&&route==='/trades'?25_000:method==='POST'&&/^\/proposals(\/skeet|\/[^/]+\/quote)?$/.test(route)?15_000:method==='GET'&&/^\/coins(\/|$)/.test(route)?10_000:4500;
app.post(resourcePath,async(req,res)=>{
 const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
 const auth=await authenticate(bearer,{introspect:b=>introspectBearer(b,'mcp-resource','introspection'),validate:validatePrincipal});
 if(auth.status){authFailed(auth,bearer,'chatgpt');if(auth.status===401)challenge(res);return res.status(auth.status).json({error:auth.error})}
 const token=auth.token;setAccount(token.sub);
 const blocked=blockedCountry(req.headers,GEOBLOCK);
 // The agent route: a token of an agent client never reaches the ChatGPT tools (WRONG_ROUTE, with the agent URL).
 if(AGENT_ON&&validatePrincipal(token).route==='agent')return wrongRouteAnswer(req,res,'agent');
 if(AGENT_ON&&token.aud!==RESOURCE){log.warn('token_rejected',{endpoint:'chatgpt',reason:'audience'});challenge(res);return res.status(401).json({error:'invalid_token'})}
 async function callCore(route,body){
  const method=body===undefined?'GET':'POST';
  if(blocked&&regionGatedRoute(route,body))throw regionRefusal(blocked,route);
  try{
   const r=await fetch(CORE+route,{method,redirect:'error',headers:{authorization:`Bearer ${secret('core-mcp')}`,'x-delegated-bearer':bearer,'content-type':'application/json',...requestIdHeader()},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(coreTimeout(route,method))});
   const raw=await r.text();if(Buffer.byteLength(raw)>128*1024)throw Error('Bound');
   const result=JSON.parse(raw);if(!r.ok){coreRefused(route,method,r.status,result?.error);throw {error:result.error??(r.status===401?'REAUTH_REQUIRED':'TEMPORARILY_UNAVAILABLE'),fund_url:result.fund_url,waitlist_url:result.waitlist_url,message:result.message,terms:result.terms,missing:result.missing,reason:result.reason}}return result;
  }catch(e){if(!e.error)log.warn('core_call_failed',{route:String(route).split('?')[0].slice(0,60),method,status:null,error:/^[A-Za-z]{1,40}$/.test(e?.name??'')?e.name:'other'});throw {error:e.error??'TEMPORARILY_UNAVAILABLE',fund_url:e.fund_url,waitlist_url:e.waitlist_url,message:e.error?e.message:undefined,terms:e.terms,missing:e.missing,reason:e.reason}}
 }
 const server=createMcpServer({token,callCore});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 res.on('close',()=>{transport.close();server.close()});await server.connect(transport);await transport.handleRequest(req,res,req.body);
});
app.all(resourcePath,(_q,r)=>r.sendStatus(405));app.use((_e,_q,r,_n)=>r.sendStatus(400));
/** WRONG_ROUTE on the protocol: 403 with a JSON-RPC error whose message is the sentence for the person and whose data
 * names the code and the right URL (shared/agent-route.mjs wrongRoute). */
function wrongRouteAnswer(req,res,expected){
 const w=wrongRoute(expected);
 log.warn('wrong_route',{expected});
 return res.status(403).json({jsonrpc:'2.0',id:req.body?.id??null,error:{code:-32003,message:w.message,data:w}});
}
// ---- the agent endpoint (only with YEET_AGENT_ROUTE=on) ----
const agentApp=express.Router();
/** A bearer the AS did not vouch for (401) or could not be checked (503): a security line, never the bearer. */
function authFailed(auth,bearer,endpoint){
 if(auth.status===401)log.warn('token_rejected',{endpoint,bearer_present:!!bearer});
 else log.warn('token_check_unavailable',{endpoint,status:auth.status});
}
/** Core answered 4xx/5xx: a warn line with the route (no query), status and the error code. */
const coreRefused=(route,method,status,error)=>log.warn('core_call_failed',{route:String(route).split('?')[0].slice(0,120),method,status,error:typeof error==='string'&&ERROR_CODE.test(error)?error:error==null?null:'other'});
if(AGENT_ON){
 const AGENT_RESOURCE=agentResource(),agentPath=new URL(AGENT_RESOURCE).pathname||'/';
 const agentPrm='/.well-known/oauth-protected-resource'+agentPath.replace(/\/$/,'');
 const agentChallenge=res=>res.set('WWW-Authenticate',`Bearer resource_metadata="${new URL(AGENT_RESOURCE).origin}${agentPrm}"`);
 agentApp.use(express.json({limit:'32kb'}));
 agentApp.get(agentPrm,(_q,r)=>r.json({resource:AGENT_RESOURCE,authorization_servers:[AS],scopes_supported:advertisedScopes(),bearer_methods_supported:['header']}));
 agentApp.post(agentPath,async(req,res)=>{
  const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  const auth=await authenticate(bearer,{introspect:b=>introspectBearer(b,'mcp-resource','introspection'),validate:validatePrincipal});
  if(auth.status){authFailed(auth,bearer,'agent');if(auth.status===401)agentChallenge(res);return res.status(auth.status).json({error:auth.error})}
  const principal=validatePrincipal(auth.token);setAccount(principal.subject);
  // A ChatGPT token here: WRONG_ROUTE with the ChatGPT URL. An agent token for another resource: not valid here.
  if(principal.route!=='agent')return wrongRouteAnswer(req,res,'chatgpt');
  if(auth.token.aud!==AGENT_RESOURCE){log.warn('token_rejected',{endpoint:'agent',reason:'audience'});agentChallenge(res);return res.status(401).json({error:'invalid_token'})}
  const blocked=blockedCountry(req.headers,GEOBLOCK);
  async function callCore(route,body){
   const method=body===undefined?'GET':'POST';let r,raw;
   if(blocked&&regionGatedRoute(route,body))throw regionRefusal(blocked,route);
   try{
    r=await fetch(CORE+route,{method,redirect:'error',headers:{authorization:`Bearer ${secret('core-mcp')}`,'x-delegated-bearer':bearer,'content-type':'application/json',...requestIdHeader()},
     ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(route==='/agent/submit'||route==='/agent/prepare'?25_000:route==='/agent/quote'?15_000:8000)});
    raw=await r.text();if(Buffer.byteLength(raw)>128*1024)throw Error('Bound');
   }catch(e){log.warn('core_call_failed',{route:String(route).split('?')[0].slice(0,60),method,status:null,error:/^[A-Za-z]{1,40}$/.test(e?.name??'')?e.name:'other'});throw {error:'TEMPORARILY_UNAVAILABLE',retryable:true}}
   let out;try{out=JSON.parse(raw)}catch{coreRefused(route,method,r.status,'not_json');throw {error:r.status===401?'REAUTH_REQUIRED':'TEMPORARILY_UNAVAILABLE',retryable:r.status!==401}}
   if(!r.ok){coreRefused(route,method,r.status,out?.error);throw {...out,error:out?.error??(r.status===401?'REAUTH_REQUIRED':'TEMPORARILY_UNAVAILABLE')}}
   return out;
  }
  const server=createAgentMcpServer({token:auth.token,callCore});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close',()=>{transport.close();server.close()});await server.connect(transport);await transport.handleRequest(req,res,req.body);
 });
 agentApp.all(agentPath,(_q,r)=>r.sendStatus(405));
 agentApp.use((_q,r)=>r.sendStatus(404));
}
// The path words the access line may write (shared/log.mjs): both endpoints' own route definitions.
learnRoutes(app,agentApp);
export const server=app.listen(port('CONNECTOR_PORT',38313),process.env.LISTEN_HOST||'0.0.0.0');

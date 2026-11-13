import {authenticate} from './authenticate.mjs';
import {advertisedScopes} from '#scope-catalog';
import {createMcpServer} from './tool-registration.mjs';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import express from 'express';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {AS,RESOURCE,CORE,secret,PUBLIC,port} from '#shared/common.mjs';
const app=express();app.disable('x-powered-by');
// Health first: the container check runs without the public Host header.
app.get('/health',(_q,r)=>r.json({ok:true}));
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
/** Core deadline per route: proposals (YEET and SKEET) and quotes 15 s, trade execution 25 s, everything else 4.5 s. */
export const coreTimeout=(route,method)=>method==='POST'&&route==='/trades'?25_000:method==='POST'&&/^\/proposals(\/skeet|\/[^/]+\/quote)?$/.test(route)?15_000:4500;
app.post(resourcePath,async(req,res)=>{
 const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
 const auth=await authenticate(bearer,{introspect:b=>introspectBearer(b,'mcp-resource','introspection'),validate:validatePrincipal});
 if(auth.status){if(auth.status===401)challenge(res);return res.status(auth.status).json({error:auth.error})}
 const token=auth.token;
 async function callCore(route,body){
  const method=body===undefined?'GET':'POST';
  try{
   const r=await fetch(CORE+route,{method,redirect:'error',headers:{authorization:`Bearer ${secret('core-mcp')}`,'x-delegated-bearer':bearer,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(coreTimeout(route,method))});
   const raw=await r.text();if(Buffer.byteLength(raw)>128*1024)throw Error('Bound');
   const result=JSON.parse(raw);if(!r.ok)throw {error:result.error??(r.status===401?'REAUTH_REQUIRED':'TEMPORARILY_UNAVAILABLE'),fund_url:result.fund_url,message:result.message};return result;
  }catch(e){throw {error:e.error??'TEMPORARILY_UNAVAILABLE',fund_url:e.fund_url,message:e.error?e.message:undefined}}
 }
 const server=createMcpServer({token,callCore});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 res.on('close',()=>{transport.close();server.close()});await server.connect(transport);await transport.handleRequest(req,res,req.body);
});
app.all(resourcePath,(_q,r)=>r.sendStatus(405));app.use((_e,_q,r,_n)=>r.sendStatus(400));
export const server=app.listen(port('CONNECTOR_PORT',38313),process.env.LISTEN_HOST||'0.0.0.0');

import {authenticate} from './authenticate.mjs';
import {advertisedScopes} from '#scope-catalog';
import {createMcpServer} from './tool-registration.mjs';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import express from 'express';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {AS,RESOURCE,CORE,secret,PUBLIC} from '#shared/common.mjs';
import {toolError,accountError} from './errors.mjs';
const app=express();if(PUBLIC)app.use((q,r,next)=>{if(q.headers.host!==new URL(RESOURCE).host)return r.sendStatus(421);next()});app.use(express.json({limit:'32kb'}));
const resourcePath=new URL(RESOURCE).pathname||'/';const prmPath='/.well-known/oauth-protected-resource'+resourcePath.replace(/\/$/,'');
const mcpPaths=[...new Set([resourcePath,'/mcp'])];const prmPaths=[...new Set([prmPath,'/.well-known/oauth-protected-resource/mcp'])];
app.get(prmPaths,(_q,r)=>r.json({resource:RESOURCE,authorization_servers:[AS],scopes_supported:advertisedScopes(),bearer_methods_supported:['header']}));
const challenge=res=>res.set('WWW-Authenticate',`Bearer resource_metadata="${new URL(RESOURCE).origin}${prmPath}"`);
app.post(mcpPaths,async(req,res)=>{
 const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
 const auth=await authenticate(bearer,{introspect:b=>introspectBearer(b,'mcp-resource','introspection'),validate:validatePrincipal});
 if(auth.status){if(auth.status===401)challenge(res);return res.status(auth.status).json({error:auth.error})}
 const token=auth.token;
 async function callCore(route,body){
  try{
   const r=await fetch(CORE+route,{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:`Bearer ${secret('core-mcp')}`,'x-delegated-bearer':bearer,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(route==='/research'?15_000:4500)});
   const raw=await r.text();if(Buffer.byteLength(raw)>128*1024)throw Error('Bound');
   const result=JSON.parse(raw);if(!r.ok)throw {error:result.error??(r.status===401?'REAUTH_REQUIRED':'TEMPORARILY_UNAVAILABLE')};return result;
  }catch(e){throw {error:e.error??'TEMPORARILY_UNAVAILABLE'}}
 }
 // Intercept before SDK schema validation, preserving the standard tool-error envelope.
 const invalid=accountError(req.body);if(invalid)return res.json({jsonrpc:'2.0',id:req.body.id,result:invalid});
 const server=createMcpServer({token,callCore});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
 res.on('close',()=>{transport.close();server.close()});await server.connect(transport);await transport.handleRequest(req,res,req.body);
});
app.all(mcpPaths,(_q,r)=>r.sendStatus(405));app.use((_e,_q,r,_n)=>r.sendStatus(400));
app.listen(38313,'0.0.0.0');

// One JSON object per line on stdout, for every role (core, as, mcp): {ts, svc, level, event, ...fields}. The same
// event lines core already wrote ({event, ...}), now with time, service and level. YEET_LOG_LEVEL (debug, info, warn,
// error; unset or empty = info) drops lines below it; health checks are debug.
//
// Never logged: tokens, authorization headers, cookies, OAuth codes, full email addresses, keys, signatures, signed
// payloads. Request lines carry the path without the query (query KEYS only) and no header besides the few named
// below; tool lines carry argument KEYS and sizes only. scrub() below is the last net over every field.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const LEVELS={debug:10,info:20,warn:30,error:40};
const SVC=new Set(['core','as','mcp']);
// The request's own service (accessLog's svc), else the role the process was started as (node <role>/server.mjs <role>).
const service=()=>als.getStore()?.svc??(SVC.has(process.argv[2])?process.argv[2]:'unknown');
const threshold=()=>LEVELS[process.env.YEET_LOG_LEVEL?.trim().toLowerCase()||'info']??LEVELS.info;
export const enabled=level=>(LEVELS[level]??LEVELS.info)>=threshold();

// Keys whose values are never written, at any depth.
const SECRET_KEY=/^(authorization|cookie|set-cookie|x-delegated-bearer|bearer|token|access_token|refresh_token|id_token|privy_access_token|identity_token|client_secret|password|secret|private_key|privatekey|key_file|signature|signed|signed_payload|signed_transaction|raw_transaction|code_verifier|oauth_code|auth_code)$/i;
const EMAIL=/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const BEARER=/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT=/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
/** The domain of an email address, never the address; null when it is not one. */
export const emailDomain=v=>typeof v==='string'&&/^[^\s@]+@([^\s@]+\.[^\s@]+)$/.test(v)?v.split('@').pop().toLowerCase().slice(0,100):null;
const scrubString=s=>s.replace(BEARER,'$1 [redacted]').replace(JWT,'[jwt]').replace(EMAIL,(_m,_u,d)=>`[email]@${d.toLowerCase()}`).slice(0,500);
export function scrub(value,depth=0){
 if(typeof value==='string')return scrubString(value);
 if(value===null||typeof value!=='object')return typeof value==='bigint'?String(value):value;
 if(depth>=4)return '[deep]';
 if(Array.isArray(value))return value.slice(0,20).map(v=>scrub(v,depth+1));
 const out={};
 for(const [k,v] of Object.entries(value).slice(0,40))out[k]=SECRET_KEY.test(k)?'[redacted]':scrub(v,depth+1);
 return out;
}

// The request in flight (request id, account id), for the lines written while it runs and the header sent to core.
const als=new AsyncLocalStorage();
export const requestContext=()=>als.getStore();
export const currentRequestId=()=>als.getStore()?.rid;
/** {'x-request-id': id} inside a request, {} outside one: spread into the headers of a call to core. */
export const requestIdHeader=()=>{const rid=currentRequestId();return rid?{'x-request-id':rid}:{}};
/** The authenticated account of the request in flight, once it is known. */
export const setAccount=id=>{const s=als.getStore();if(s&&typeof id==='string'&&id)s.account=id.slice(0,100)};

// console.log is stdout; going through it keeps the tests that watch console.log for an event working.
let sink=line=>console.log(line);
/** Tests only: where lines go; returns the previous sink. */
export function setSink(fn){const prev=sink;sink=fn;return prev}

export function log(level,event,fields={}){
 if(!enabled(level))return;
 const rid=currentRequestId();
 const {ts:_t,svc:_s,level:_l,event:_e,...rest}=scrub(fields??{});
 const line={ts:new Date().toISOString(),svc:service(),level,event:String(event).slice(0,80),...(rid&&rest.rid===undefined?{rid}:{}),...rest};
 try{sink(JSON.stringify(line))}catch{}
}
log.debug=(e,f)=>log('debug',e,f);
log.info=(e,f)=>log('info',e,f);
log.warn=(e,f)=>log('warn',e,f);
log.error=(e,f)=>log('error',e,f);

const RID=/^[A-Za-z0-9-]{8,64}$/;
const cap=(v,n)=>typeof v==='string'?v.slice(0,n):undefined;
/** The person's address: Cloudflare's Cf-Connecting-Ip, else the first X-Forwarded-For hop, else the socket. */
export function clientAddress(q){
 const cf=cap(q.headers?.['cf-connecting-ip'],64)?.trim();if(cf)return cf;
 const xff=cap(q.headers?.['x-forwarded-for'],512)?.split(',')[0].trim();if(xff)return xff.slice(0,64);
 return q.socket?.remoteAddress??null;
}
/** Path without the query string, and the query's keys (never its values). */
export function pathAndQueryKeys(rawUrl){
 const url=String(rawUrl??'');const i=url.indexOf('?');
 const path=(i<0?url:url.slice(0,i)).slice(0,200);
 if(i<0)return {path,query_keys:[]};
 const keys=[...new Set([...new URLSearchParams(url.slice(i+1)).keys()])].slice(0,20).map(k=>k.slice(0,40));
 return {path,query_keys:keys};
}
/** Express middleware, first on every app: one `http_request` line per request when its response ends (or the client
 * goes away). trustRequestId: take a well-formed x-request-id from the caller (core, called by mcp and as only);
 * otherwise a new id. privileged(q): admin and operator access, written at warn. warnFrom: status from which the line
 * is warn (core: 400, its callers are our own services). */
export function accessLog({svc,trustRequestId=false,privileged=()=>false,warnFrom=500}={}){
 return (q,r,next)=>{
  const start=process.hrtime.bigint();
  const incoming=q.headers['x-request-id'];
  const rid=trustRequestId&&typeof incoming==='string'&&RID.test(incoming)?incoming:randomUUID();
  const store={rid,account:undefined,...(SVC.has(svc)?{svc}:{})};
  const {path,query_keys}=pathAndQueryKeys(q.originalUrl??q.url);
  let done=false;
  const end=()=>{
   if(done)return;done=true;
   const status=r.statusCode;
   const isPrivileged=!!privileged(q);
   const level=path==='/health'?'debug':isPrivileged||status>=warnFrom?'warn':'info';
   const account=store.account??(typeof q.subject==='string'&&q.subject?q.subject.slice(0,100):undefined);
   als.run(store,()=>log(level,'http_request',{rid,method:q.method,path,query_keys,status,ms:Number((process.hrtime.bigint()-start)/1000n)/1000,
    client:clientAddress(q),country:cap(q.headers['cf-ipcountry'],8)??null,ua:cap(q.headers['user-agent'],200)??null,
    ...(account?{account}:{}),...(isPrivileged?{privileged:true}:{}),...(r.writableFinished?{}:{aborted:true})}));
  };
  r.once('finish',end);r.once('close',end);
  als.run(store,next);
 };
}
/** Argument keys and their JSON sizes in bytes; never the values. */
export function argShape(args){
 if(!args||typeof args!=='object'||Array.isArray(args))return {};
 return Object.fromEntries(Object.entries(args).slice(0,30).map(([k,v])=>[k.slice(0,40),v===undefined?0:Buffer.byteLength(JSON.stringify(v)??'')]));
}
/** The result class of a tool answer: ok, or the error code the model was given. */
export function resultClass(out){
 if(!out?.isError)return 'ok';
 if(typeof out.structuredContent?.error==='string')return out.structuredContent.error;
 try{const e=JSON.parse(out.content?.[0]?.text)?.error;return typeof e==='string'?e:'error'}catch{return 'error'}
}
/** One `tool_call` line per call (shared/log.mjs): tool, account, result class, duration, argument keys and sizes.
 * Both MCP tool sets use it (mcp/tool-registration.mjs and mcp/agent.mjs). */
export function loggedTool(name,token,handler,{endpoint='chatgpt'}={}){
 return async(input,extra)=>{
  const start=performance.now();let out;
  try{return out=await handler(input,extra)}
  finally{log.info('tool_call',{endpoint,tool:name,account:typeof token?.sub==='string'?token.sub:null,result:out===undefined?'threw':resultClass(out),ms:Math.round(performance.now()-start),args:argShape(input)})}
 };
}

// One JSON object per line on stdout, for every role (core, as, mcp): {ts, svc, level, event, ...fields}. The same
// event lines core already wrote ({event, ...}), now with time, service and level. YEET_LOG_LEVEL (debug, info, warn,
// error; unset or empty = info) drops lines below it; health checks are debug.
//
// Never logged: tokens, authorization headers, cookies, OAuth codes, full email addresses, keys, signatures, signed
// payloads. Request lines carry the route TEMPLATE (`/interaction/:uid`), never an id from the path, and no query
// values (query KEYS only) and no header besides the few named below; tool lines carry argument KEYS, types and
// sizes only. scrub() below is the last net over every field.
//
// Nothing here may ever throw into the caller: every emit path swallows its own failure and writes, at most, one
// fixed `log_error` line. No untrusted value is serialized or walked deeply to size it.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';

const LEVELS={debug:10,info:20,warn:30,error:40};
const SVC=new Set(['core','as','mcp']);
// The request's own service (accessLog's svc), else the role the process was started as (node <role>/server.mjs <role>).
const service=()=>als.getStore()?.svc??(SVC.has(process.argv[2])?process.argv[2]:'unknown');
const threshold=()=>LEVELS[process.env.YEET_LOG_LEVEL?.trim().toLowerCase()||'info']??LEVELS.info;
export const enabled=level=>(LEVELS[level]??LEVELS.info)>=threshold();

// Keys whose values are never written, at any depth.
const SECRET_KEY=/^(authorization|cookie|set-cookie|x-delegated-bearer|bearer|token|access_token|refresh_token|id_token|privy_access_token|identity_token|client_secret|password|secret|private_key|privatekey|key_file|signature|signed|signed_payload|signed_transaction|raw_transaction|code_verifier|oauth_code|auth_code)$/i;
const EMAIL=/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// The same address percent-encoded (an email inside a URL or a client id): `alice%40example.com`.
const ENC_EMAIL=/([A-Za-z0-9._%+-]+)%40([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
// A URL's query and fragment: dropped from any URL-shaped value.
const URL_QUERY=/(\bhttps?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
const BEARER=/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT=/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
/** The domain of an email address, never the address; null when it is not one. */
export const emailDomain=v=>typeof v==='string'&&/^[^\s@]+@([^\s@]+\.[^\s@]+)$/.test(v)?v.split('@').pop().toLowerCase().slice(0,100):null;
const scrubString=s=>s.slice(0,2000).replace(URL_QUERY,'$1').replace(BEARER,'$1 [redacted]').replace(JWT,'[jwt]')
 .replace(ENC_EMAIL,(_m,_u,d)=>`[email]@${d.toLowerCase()}`).replace(EMAIL,(_m,_u,d)=>`[email]@${d.toLowerCase()}`).slice(0,500);
/** An OAuth client id for a log line: a URL-shaped id (a CIMD document URL) as origin + pathname only, never its query
 * or fragment; any other id unchanged. Capped at 200. */
export function safeClientId(v){
 if(v===undefined||v===null||v==='')return null;
 const s=String(v).slice(0,2048);
 if(/^[a-z][a-z0-9+.-]*:\/\//i.test(s)){try{const u=new URL(s);return scrubString((u.origin+u.pathname).slice(0,200))}catch{return '[invalid-url]'}}
 return scrubString(s.slice(0,200));
}
// ---- paths: an ALLOWLIST of static words; every other segment is :id ----
// A path segment is logged only when it is a word of our own route definitions (learnRoutes, at startup, from every
// Express app and router) or of the fixed list below (the OIDC provider's own paths and our app.use mount points,
// which Express does not keep as strings). Anything else, whatever it looks like, is `:id`: unknown is redacted.
const FIXED_WORDS=['auth','resume','token','introspection','revocation','me','userinfo','jwks','reg','session','end','confirm',
 'success','interaction','login','consent','request','device','backchannel','.well-known','openid-configuration',
 'oauth-authorization-server','oauth-protected-resource','health','version','cards','account','fund','sign','api','approve',
 'agent','mcp','privy-login','wallets','terms','favicon.ico'];
const WORDS=new Set(FIXED_WORDS);
const LITERAL=/^[A-Za-z0-9._~-]{1,60}$/;
function learnPattern(pattern){
 for(const seg of String(pattern).split('/'))for(const part of seg.split(/[{}]/))
  if(part&&!part.startsWith(':')&&!part.startsWith('*')&&LITERAL.test(part))WORDS.add(part);
}
function learnStack(stack,depth){
 if(!Array.isArray(stack)||depth>6)return;
 for(const layer of stack){
  const p=layer?.route?.path;
  if(typeof p==='string')learnPattern(p);else if(Array.isArray(p))p.filter(x=>typeof x==='string').forEach(learnPattern);
  if(layer?.handle?.stack)learnStack(layer.handle.stack,depth+1);
 }
}
/** Adds the literal path words of every route registered on these Express apps or routers to the allowlist. Call once
 * each app has all its routes (before listen). Never throws. */
export function learnRoutes(...apps){
 for(const a of apps){try{learnStack(a?.router?.stack??a?.stack,0)}catch{}}
}
/** A path for a log line: no query, every segment that is not an allowlisted static word as `:id`. */
export function redactPath(path){
 try{
  const p=String(path??'').split(/[?#]/)[0].slice(0,400);
  return p.split('/').slice(0,20).map(seg=>seg===''||WORDS.has(seg)?seg:':id').join('/').slice(0,200);
 }catch{return ':id'}
}
// A value the logger built itself from code (a route template): written as is, not redacted again.
class Trusted{constructor(v){this.v=v}}
// Field names that carry a path or a client id in any event: redacted wherever they appear.
const PATH_KEY=/^(path|route)$/,CLIENT_KEY=/^(client_id|client)$/;
export function scrub(value,depth=0){
 if(typeof value==='string')return scrubString(value);
 if(value===null||typeof value!=='object')return typeof value==='bigint'?String(value):typeof value==='function'||typeof value==='symbol'?undefined:value;
 if(depth>=4)return '[deep]';
 if(Array.isArray(value))return value.slice(0,20).map(v=>scrub(v,depth+1));
 const out={};let n=0;
 for(const k in value){
  if(!Object.hasOwn(value,k))continue;if(++n>40)break;
  const v=value[k];
  out[k]=v instanceof Trusted?v.v:SECRET_KEY.test(k)?'[redacted]':PATH_KEY.test(k)&&typeof v==='string'&&v.startsWith('/')?redactPath(v):CLIENT_KEY.test(k)&&typeof v==='string'?safeClientId(v):scrub(v,depth+1);
 }
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

/** The one line written when the logger itself fails: fixed fields only, nothing from the failed event. */
function logError(){try{sink(JSON.stringify({ts:new Date().toISOString(),svc:'unknown',level:'error',event:'log_error'}))}catch{}}
export function log(level,event,fields={}){
 try{
  if(!enabled(level))return;
  const rid=currentRequestId();
  const {ts:_t,svc:_s,level:_l,event:_e,...rest}=scrub(fields??{});
  const line={ts:new Date().toISOString(),svc:service(),level,event:String(event).slice(0,80),...(rid&&rest.rid===undefined?{rid}:{}),...rest};
  sink(JSON.stringify(line));
 }catch{logError()}
}
log.debug=(e,f)=>log('debug',e,f);
log.info=(e,f)=>log('info',e,f);
log.warn=(e,f)=>log('warn',e,f);
log.error=(e,f)=>log('error',e,f);

const RID=/^[A-Za-z0-9-]{8,64}$/;
const cap=(v,n)=>typeof v==='string'?v.slice(0,n):undefined;
/** The person's address: Cloudflare's Cf-Connecting-Ip, else the first X-Forwarded-For hop, else the socket. */
export function clientAddress(q){
 // Header values are the caller's: only a well-formed IP address is written, anything else is 'invalid'.
 const ip=v=>isIP(v)?v:'invalid';
 const cf=cap(q.headers?.['cf-connecting-ip'],64)?.trim();if(cf)return ip(cf);
 const xff=cap(q.headers?.['x-forwarded-for'],512)?.split(',')[0].trim();if(xff)return ip(xff.slice(0,64));
 return q.socket?.remoteAddress??null;
}
const METHODS=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const COUNTRY=/^[A-Z0-9]{2}$/;
// Query keys are the caller's too: only these (the OAuth/OIDC parameters and the ones our pages read) are written by
// name; the others are counted.
const QUERY_KEYS=new Set(['client_id','redirect_uri','response_type','response_mode','scope','state','code','code_challenge',
 'code_challenge_method','resource','prompt','login_hint','id_token_hint','nonce','request_uri','request','max_age','ui_locales',
 'claims','acr_values','display','error','error_description','iss','post_logout_redirect_uri','user_code','back','deposit',
 'filter','from','h','next','page','query','redirect','reference_id','t','trade_id','username']);
/** Path without the query string, and the query's keys (never its values). */
export function pathAndQueryKeys(rawUrl){
 const url=String(rawUrl??'');const i=url.indexOf('?');
 const path=(i<0?url:url.slice(0,i)).slice(0,400);
 if(i<0)return {path,query_keys:[],query_other:0};
 const all=[...new Set([...new URLSearchParams(url.slice(i+1,i+1+8192)).keys()])];
 return {path,query_keys:all.filter(k=>QUERY_KEYS.has(k)).slice(0,20),query_other:all.filter(k=>!QUERY_KEYS.has(k)).length};
}
/** Express middleware, first on every app: one `http_request` line per request when its response ends (or the client
 * goes away). trustRequestId: take a well-formed x-request-id from the caller (core, called by mcp and as only);
 * otherwise a new id. privileged(q): admin and operator access, written at warn. warnFrom: status from which the line
 * is warn (core: 400, its callers are our own services). */
/** The path for the access line: the matched Express route's template (base URL + route path) when the request was
 * answered by an Express route, else the raw path with every id-like segment as :id (the provider's routes, static
 * files, 404s). Both go through redactPath. */
export function routePath(q,rawPath){
 const tpl=q.route?.path;
 // The template is our code (`/interaction/:uid`); the mount prefix, if any, is checked like any path.
 if(typeof tpl==='string')return new Trusted(((typeof q.baseUrl==='string'&&q.baseUrl?redactPath(q.baseUrl):'')+tpl).slice(0,200));
 return redactPath(rawPath);
}
export function accessLog({svc,trustRequestId=false,privileged=()=>false,warnFrom=500}={}){
 return (q,r,next)=>{
  let store;
  try{
   const start=process.hrtime.bigint();
   const incoming=q.headers['x-request-id'];
   const rid=trustRequestId&&typeof incoming==='string'&&RID.test(incoming)?incoming:randomUUID();
   store={rid,account:undefined,...(SVC.has(svc)?{svc}:{})};
   const {path:rawPath,query_keys,query_other}=pathAndQueryKeys(q.originalUrl??q.url);
   let done=false;
   const end=()=>{
    try{
     if(done)return;done=true;
     const status=r.statusCode;
     const isPrivileged=!!privileged(q);
     const path=routePath(q,rawPath);
     const level=rawPath==='/health'?'debug':isPrivileged||status>=warnFrom?'warn':'info';
     const account=store.account??(typeof q.subject==='string'&&q.subject?q.subject.slice(0,100):undefined);
     als.run(store,()=>log(level,'http_request',{rid,method:METHODS.has(q.method)?q.method:'OTHER',path,query_keys,...(query_other?{query_other}:{}),status,ms:Number((process.hrtime.bigint()-start)/1000n)/1000,
      client:clientAddress(q),country:COUNTRY.test(q.headers['cf-ipcountry']??'')?q.headers['cf-ipcountry']:null,ua:cap(q.headers['user-agent'],200)??null,
      ...(account?{account}:{}),...(isPrivileged?{privileged:true}:{}),...(r.writableFinished?{}:{aborted:true})}));
    }catch{logError()}
   };
   r.once('finish',end);r.once('close',end);
  }catch{logError()}
  // The request always goes on, logged or not.
  return store?als.run(store,next):next();
 };
}
/** Argument keys with a shallow type and size each, never the values and never by serializing them: a string's or an
 * array's length, an object's own key count (counted up to 1000), 0 otherwise. At most 30 keys. Never throws. */
export function argShape(args,allowed){
 try{
  if(!args||typeof args!=='object'||Array.isArray(args))return {};
  const out={};let n=0,other=0;
  for(const k in args){
   if(!Object.hasOwn(args,k))continue;
   // Argument names are the caller's: only the tool's own schema keys are written; the others are counted.
   if(allowed&&!allowed.has(k)){other++;continue}
   if(++n>30)break;
   let v,type,size=0;
   try{v=args[k]}catch{v=undefined}
   if(typeof v==='string'){type='string';size=v.length}
   else if(Array.isArray(v)){type='array';size=v.length}
   else if(v&&typeof v==='object'){type='object';let c=0;for(const kk in v){if(Object.hasOwn(v,kk)&&++c>=1000)break}size=c}
   else type=v===null?'null':typeof v;
   out[String(k).slice(0,40)]={type,size};
  }
  if(other)out['(other)']={type:'keys',size:other};
  return out;
 }catch{return {}}
}
/** The result class of a tools/call answer: ok; the error code the model was given (our JSON refusals); invalid_input
 * (the SDK refused the arguments before the handler); unknown_tool; output_invalid; threw (the handler threw, the SDK
 * answered with its message). Never throws. */
/** An error code as our contracts write them (TERMS_REQUIRED); anything else is not written. */
export const ERROR_CODE=/^[A-Z][A-Z0-9_]{1,40}$/;
export function resultClass(out,{known=true}={}){
 try{
  if(!known)return 'unknown_tool';
  if(!out?.isError)return 'ok';
  const code=e=>typeof e==='string'&&ERROR_CODE.test(e)?e:'error';
  if(typeof out.structuredContent?.error==='string')return code(out.structuredContent.error);
  const text=typeof out.content?.[0]?.text==='string'?out.content[0].text:'';
  try{const e=JSON.parse(text)?.error;if(typeof e==='string')return code(e)}catch{}
  if(/Input validation error|Invalid arguments for tool/.test(text))return 'invalid_input';
  if(/Output validation error/.test(text))return 'output_invalid';
  if(/^(MCP error -?\d+: )?Tool \S+ (not found|disabled)/.test(text))return 'unknown_tool';
  return 'threw';
 }catch{return 'error'}
}
/** Exactly one `tool_call` line per MCP tools/call, at dispatch (so also when the SDK refuses the input before the
 * handler, and for a tool name that is not registered): endpoint, tool, account, result class, duration, argument
 * shape. Call once after every tool is registered. Never throws, never changes the answer. */
export function instrumentToolCalls(mcpServer,{endpoint='chatgpt',token}={}){
 try{
  const handlers=mcpServer?.server?._requestHandlers;
  const orig=handlers?.get?.('tools/call');
  if(typeof orig!=='function'){log.error('log_error',{what:'tools_call_handler_missing',endpoint});return}
  const known=name=>{try{return Object.hasOwn(mcpServer._registeredTools??{},name)}catch{return false}};
  // The tool's own argument names (its zod input shape), the only names written.
  const keysOf=name=>{try{const i=mcpServer._registeredTools[name]?.inputSchema;const shape=i?.shape??i?._zod?.def?.shape;return new Set(shape?Object.keys(shape):[])}catch{return new Set()}};
  handlers.set('tools/call',async(request,extra)=>{
   const start=performance.now();let out,threw=false;
   try{return out=await orig(request,extra)}
   catch(e){threw=true;throw e}
   finally{
    try{
     const name=typeof request?.params?.name==='string'?request.params.name:'';
     const isKnown=known(name);
     // A name that is not a registered tool is the caller's text: never written, only its length.
     log.info('tool_call',{endpoint,tool:isKnown?name:null,...(isKnown?{}:{tool_name_length:typeof request?.params?.name==='string'?request.params.name.length:null}),
      account:typeof token?.sub==='string'?token.sub:null,result:!isKnown?'unknown_tool':threw?'threw':resultClass(out),ms:Math.round(performance.now()-start),
      args:argShape(request?.params?.arguments,isKnown?keysOf(name):new Set())});
    }catch{logError()}
   }
  });
 }catch{logError()}
}

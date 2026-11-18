// The agent route's core routes (core/agent/agents.mjs), mounted by core.mjs only with YEET_AGENT_ROUTE=on.
// Only the connector reaches them, with the agent's delegated bearer (class agent, shared/introspection.mjs); every
// answer is plain JSON; a refusal is {error, message, retryable, ...}.
import {wrongRoute} from '#shared/agent-route.mjs';
import {OP_ID,AgentError} from './agents.mjs';
import {log as slog} from '#shared/log.mjs';

/** The default for `log` (one JSON line per event): through the shared logger (shared/log.mjs). */
const sharedLine=line=>{try{const {event,...fields}=JSON.parse(line);slog.warn(event,fields)}catch{}};

/** [method, path, scope] of every agent route. */
export const AGENT_ROUTE_SCOPES=Object.freeze([
 ['GET',/^\/agent\/overview$/,'yeet:read'],
 ['GET',/^\/agent\/balance$/,'yeet:read'],
 ['GET',/^\/agent\/positions$/,'yeet:read'],
 ['POST',/^\/agent\/balance$/,'yeet:read'],
 ['POST',/^\/agent\/positions$/,'yeet:read'],
 ['POST',/^\/agent\/status$/,'yeet:read'],
 ['POST',/^\/agent\/register$/,'yeet:write'],
 ['POST',/^\/agent\/quote$/,'yeet:write'],
 ['POST',/^\/agent\/return$/,'yeet:write'],
 ['POST',/^\/agent\/prepare$/,'yeet:prepare'],
 ['POST',/^\/agent\/submit$/,'yeet:prepare'],
]);
const isAgentPath=path=>path.startsWith('/agent/');
const RETRYABLE=new Set(['TEMPORARILY_UNAVAILABLE','REQUEST_EXPIRED','REQUOTE_REQUIRED']);

/** Both directions, on every connector call: a ChatGPT token never reaches an agent route, an agent token never a
 * ChatGPT route. 403 WRONG_ROUTE with the sentence and the right URL. */
export function routeGuard(q,r,next){
 if(q.role!=='mcp')return next();
 const cls=q.principal?.route??'chatgpt';
 if(isAgentPath(q.path)&&cls!=='agent')return r.status(403).json({...wrongRoute('chatgpt'),retryable:false});
 if(!isAgentPath(q.path)&&cls==='agent')return r.status(403).json({...wrongRoute('agent'),retryable:false});
 next();
}

/** The routes. agents(): the agent service (createAgents); terms(subject): {accepted, page_url?}. */
export function mountAgentRoutes(app,{agents,terms,log=sharedLine}){
 const handler=(fn,{needsTerms=true}={})=>async(q,r)=>{
  if(q.role!=='mcp')return r.sendStatus(403);
  r.set('Cache-Control','no-store');
  try{
   if(needsTerms){
    const t=terms(q.subject);
    if(!t.accepted)return r.status(403).json({error:'TERMS_REQUIRED',retryable:false,
     message:`The YEET account has not accepted the current YEET terms. Ask the person to accept them${t.page_url?` at ${t.page_url}`:' in ChatGPT or on yeet.win'}, then try again.`,...(t.page_url?{terms_url:t.page_url}:{})});
   }
   const out=await fn(await agents(),q.subject,q.principal.client,q.body??{});
   // An agent key registered for the account: the server-side half of an agent approval (never the key itself).
   if(q.path==='/agent/register')slog.warn('agent_registered',{account:q.subject,client_id:String(q.principal.client??'').slice(0,200)});
   r.json(out);
  }catch(e){
   if(e instanceof AgentError&&e.code==='INVALID_ARGUMENT')slog.warn('input_rejected',{route:q.path,tool:null,code:e.code});
   if(e instanceof AgentError)return r.status(e.status).json({error:e.code,message:e.message,retryable:RETRYABLE.has(e.code),...(e.extra??{})});
   if(e?.name==='TradeError'){
    log(JSON.stringify({event:'agent_trade_refused',route:q.path,code:e.code,detail:String(e.detail??'').slice(0,200)}));
    const message=typeof e.userMessage==='string'?e.userMessage:TRADE_MESSAGES[e.code]??'The trade was refused. Nothing moved.';
    return r.status(e.code==='TEMPORARILY_UNAVAILABLE'||e.code==='TRADING_PAUSED'?503:409).json({error:e.code,message,retryable:RETRYABLE.has(e.code)});
   }
   log(JSON.stringify({event:'agent_route_failed',route:q.path,error:String(e?.message??e).slice(0,200)}));
   r.status(503).json({error:'TEMPORARILY_UNAVAILABLE',message:'YEET could not answer just now. Nothing moved. Try again in a minute.',retryable:true});
  }
 };
 app.get('/agent/overview',handler((a,s,c)=>a.overview(s,c),{needsTerms:false}));
 // `account` ('agent' by default, or 'owner' with YEET_AGENT_OWNER_ACCOUNT=on) is the only selector: the account itself
 // is always the token's subject (or its agent key), never named by the caller.
 const acct=b=>b.account===undefined?{}:{account:b.account};
 app.get('/agent/balance',handler((a,s,c)=>a.balance(s,c)));
 app.get('/agent/positions',handler((a,s,c)=>a.positions(s,c)));
 app.post('/agent/balance',handler((a,s,c,b)=>a.balance(s,c,acct(b))));
 app.post('/agent/positions',handler((a,s,c,b)=>a.positions(s,c,acct(b))));
 app.post('/agent/status',handler((a,s,c,b)=>{if(typeof b.trade_id!=='string'||!/^t_[a-z0-9]{20}$/.test(b.trade_id))throw new AgentError('INVALID_ARGUMENT','trade_id is a t_ id from prepare or submit.',400);return a.status(s,c,{trade_id:b.trade_id,...acct(b)})}));
 app.post('/agent/register',handler((a,s,c,b)=>a.register(s,c,{public_key:b.public_key,budget_usdc:b.budget_usdc})));
 app.post('/agent/quote',handler((a,s,c,b)=>a.quote(s,c,{side:b.side,coins:b.coins,amount_usdc:b.amount_usdc,percent:b.percent,...acct(b)})));
 app.post('/agent/prepare',handler((a,s,c,b)=>a.prepare(s,c,{quote_id:b.quote_id,revision:b.revision,...acct(b)})));
 app.post('/agent/submit',handler((a,s,c,b)=>a.submit(s,c,{request_id:b.request_id,signature:b.signature,...acct(b)})));
 app.post('/agent/return',handler((a,s,c,b)=>a.returnBudget(s,c,acct(b))));
}

/** The signing page's two calls for a budget link (`a_...`): the owner's page session, never the agent's token. */
export function mountAgentPageRoutes(app,{agents,refusal}){
 const page=fn=>async(q,r,next)=>{
  if(!OP_ID.test(q.params.id))return next();
  if(q.role!=='as')return r.sendStatus(403);
  try{r.json(await fn(await agents(),q.subject,q))}catch(e){refusal(e,q,r)}
 };
 app.post('/sign/trades/:id/requests',page((a,s,q)=>a.pageRequests(s,q.params.id)));
 app.post('/sign/trades/:id/signature',page((a,s,q)=>a.pageSubmit(s,q.params.id,{attempt_id:q.body?.attempt_id,signed:q.body?.signed})));
}

const TRADE_MESSAGES=Object.freeze({
 BALANCE_LOW:'The agent balance does not cover this trade. Ask the person for a bigger budget, or trade less.',
 LIMIT_EXCEEDED:'This trade is over the account limits.',
 AMOUNT_TOO_SMALL:'This amount is below the smallest trade YEET makes.',
 COIN_NOT_SUPPORTED:'That coin is not one YEET lists.',
 TRADING_PAUSED:'Trading is paused right now. Nothing moved.',
 INVALID_ARGUMENT:'The request was refused: check the ids and the signature. Nothing moved.',
 TEMPORARILY_UNAVAILABLE:'YEET could not do this just now. Nothing moved. Try again in a minute.',
});

import {initializeIdentityStore,resolveIdentity,account,didFor,usernameOf,setUsername} from './identity-store.mjs';
import {usernameFailure} from './username.mjs';
import {handle} from './xp/board.mjs';
import {createWalletEnsurer,walletSetupConfig,walletSetupMessage} from './trade/wallet-ensure.mjs';
import express from 'express';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import {secret,equal,read,write,port,TEST,DEV_APP_ID} from '#shared/common.mjs';
import {coins} from './coins.mjs';
import {unavailable,failure} from './failure.mjs';
import {tradeEngine,onTradeSettled} from './trade/runtime.mjs';
import {xpRuntime,p2On,homeXp,homeXpKeys,checkSpinTable} from './xp/xp.mjs';
import {z} from 'zod';
import {toolSchemas,zodSchema,contract} from '../mcp/tool-contract.mjs';
import {homeWithFundUrl,failureWithFundUrl} from './fund-link.mjs';
import {versionInfo} from './version.mjs';
// Accounts are created on the first verified sign-in (identity-store.mjs). The identity app is Privy in
// production and the development stub only under TEST_PROFILE=1 with DEV_IDENTITY_STUB=1.
const devStub=TEST&&process.env.DEV_IDENTITY_STUB==='1';
if(process.env.PRIVY_LOGIN==='1'&&devStub)throw Error('Identity modes must be separate');
if(process.env.PRIVY_LOGIN!=='1'&&!devStub)throw Error('No identity verifier configured');
initializeIdentityStore({app:process.env.PRIVY_LOGIN==='1'?process.env.PRIVY_APP_ID:DEV_APP_ID});
const user=id=>account(id);
// XP (lane E, YEET_P2=1): trade settlement pays through the tracker's onSettled hook; read per event so the flag is live.
onTradeSettled(e=>{if(p2On())xpRuntime().onSettled(e)});
/** XP never stands in the way of the answer it decorates: a failure is logged and the XP part is left out. */
/** yeet_home's xp fields as the pinned contract lists them; the summary is cut to these. */
const HOME_XP_KEYS=homeXpKeys(toolSchemas.yeet_home.output);
// The card draws the wheel from the contract's x-yeet-spin; the server draws the award. Refuse to start if they differ.
checkSpinTable(contract['x-yeet-spin']);
const xpSafe=(what,fn,fallback)=>{try{return fn()}catch(e){console.error(JSON.stringify({event:'xp_failed',what,error:String(e?.message??e).slice(0,200)}));return fallback}};
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
app.get('/health',(_q,r)=>r.json({ok:true}));
// Public facts about this deployment (version.mjs); read once at start, the settings are fixed for the process.
const VERSION=Object.freeze(versionInfo());
app.get('/version',(_q,r)=>r.json(VERSION));
app.use((q,r,next)=>{const token=q.headers.authorization?.replace(/^Bearer /,'');q.role=['mcp','as','operator'].find(role=>equal(token,secret(`core-${role}`)));if(!q.role)return r.sendStatus(401);next()});
app.post('/identity/resolve',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const id=resolveIdentity(q.body);if(!id||read('policy.json')[id]?.suspended)return r.sendStatus(403);if(p2On())xpSafe('sign_in',()=>xpRuntime().signIn(id));r.json({id})});
app.post('/policy',(q,r)=>{if(q.role!=='operator')return r.sendStatus(403);const {account,client,suspended,disconnect,reconnect}=q.body;if(!user(account))return r.sendStatus(400);const p=read('policy.json');const row=p[account]||{clients:{}};if(typeof suspended==='boolean')row.suspended=suspended;if(disconnect||reconnect){if(typeof client!=='string'||!client)return r.sendStatus(400);row.clients[client]=!!disconnect}p[account]=row;write('policy.json',p);r.json({ok:true})});
app.get('/policy',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const subject=q.headers['x-yeet-subject'];const exists=!!user(subject);r.json({...read('policy.json')[subject],exists,eligible:exists})});
// Operator trades (ops/first-trade.mjs): the operator starts a trade for one account from the box, without ChatGPT,
// through the same engine calls the card uses (yeet_propose, execute_trade, trade_status), so confirm codes, caps,
// the requote rule, audit rows, accounting and XP apply unchanged. Client id `operator`. Only for an account listed in
// YEET_LIVE_ACCOUNTS: with the allowlist unset no account can be traded this way (the reads stay open). Every call is
// logged.
const OPERATOR_CLIENT='operator';
const OPERATOR_INPUT={propose:'yeet_propose',execute:'execute_trade'};
function operatorTrade(op,fn){
 return async(q,r)=>{
  if(q.role!=='operator')return r.sendStatus(403);
  if(Object.keys(q.query).length)return r.sendStatus(400);
  const {account:accountId,...body}=q.body??{};
  if(!user(accountId))return r.sendStatus(400);
  if(read('policy.json')[accountId]?.suspended)return r.sendStatus(403);
  const ctx={accountId,clientId:OPERATOR_CLIENT};
  console.log(JSON.stringify({event:'operator_trade',op,account:accountId,proposal:body.proposal_id??null,trade:body.trade_id??null}));
  try{
   const e=await tradeEngine();
   // Reads (trading, status) stay open so a trade can be followed after trading is turned off again.
   if((op==='propose'||op==='execute')&&!e.limits.liveAccounts?.includes(accountId))return r.status(403).json(failure('TRADING_PAUSED'));
   let args=body;
   if(OPERATOR_INPUT[op]){const a=inputs[OPERATOR_INPUT[op]].safeParse(body);if(!a.success)return r.status(400).json(failure('INVALID_ARGUMENT'));args=a.data}
   r.json(await fn(e,ctx,args));
  }catch(e){
   if(e?.name==='TradeError'){console.error(JSON.stringify({event:'operator_trade_refused',op,code:e.code,detail:String(e.detail??'').slice(0,200)}));return r.status(CODE_STATUS[e.code]??409).json(failure(e.code))}
   console.error(JSON.stringify({event:'operator_trade_failed',op,error:String(e?.message??e).slice(0,200)}));
   unavailable(r);
  }
 };
}
/** What the engine would do for this account right now: the card's `paused` vs `live`, and why. */
app.post('/operator/trading',operatorTrade('trading',(e,ctx)=>{
 const l=e.limits,allowed=!!l.liveAccounts?.includes(ctx.accountId);
 return {trading:l.live&&!l.killSwitch?'live':'paused',live:l.live,kill_switch:l.killSwitch,scope:l.liveAccounts?'allowlist':'all',
  live_accounts:l.liveAccounts?.length??0,account_allowed:allowed,operator_trades:allowed&&l.live&&!l.killSwitch,
  // The person's own wallet signs; YEET only adds the network fee. Each chain driver's readiness (fee payer, gas wallet).
  signing:'user_wallet',buy_chain:e.buyChain,sell_chain:e.sellChain,
  drivers:Object.fromEntries(Object.entries(e.drivers).map(([c,d])=>{const r=d.readiness();return [c,{ok:r.ok,reasons:r.reasons}]}))};
}));
app.post('/operator/trades/propose',operatorTrade('propose',(e,ctx,a)=>e.propose(ctx,a)));
app.post('/operator/trades/execute',operatorTrade('execute',(e,ctx,a)=>e.execute(ctx,a)));
// Cancel a trade whose legs were never broadcast (executor.cancel): checks 1Click and Privy first, then fails the legs
// through the transition guard, returns the amount to the daily cap and writes audit rows. Open regardless of the
// allowlist and the flags: it can only stop a send, never start one. A refusal answers cancelled:false and the reason.
app.post('/operator/trades/cancel',operatorTrade('cancel',async(e,ctx,a)=>{
 if(typeof a.trade_id!=='string'||!/^t_[a-z0-9]{20}$/.test(a.trade_id))throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});
 if(a.reason!==undefined&&typeof a.reason!=='string')throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});
 const out=await e.cancel(ctx,a.trade_id,{reason:a.reason});
 console.log(JSON.stringify({event:'operator_trade_cancel',trade:a.trade_id,cancelled:out.cancelled,status:out.status,reason:out.reason??null}));
 return out;
}));
app.post('/operator/trades/status',operatorTrade('status',(e,ctx,a)=>{
 if(typeof a.trade_id!=='string'||!/^t_[a-z0-9]{20}$/.test(a.trade_id))throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});
 const view=e.status(ctx,a.trade_id);
 return {...(p2On()?{...view,xp_award:xpSafe('trade',()=>xpRuntime().tradeAward(ctx.accountId,view),null)}:view),record:e.tracker.record(ctx,a.trade_id)};
}));
app.use(async(q,r,next)=>{if(Object.keys(q.query).length)return r.sendStatus(400);if(q.role==='operator')return r.sendStatus(403);let subject,client;if(q.role==='mcp'){try{q.principal=validatePrincipal(await introspectBearer(q.headers['x-delegated-bearer'],'core-resource','core-introspection'));subject=q.principal.subject;client=q.principal.client}catch{return r.sendStatus(401)}}else subject=q.headers['x-yeet-subject'];if(!user(subject))return r.sendStatus(400);q.subject=subject;const p=read('policy.json')[subject];if(p?.suspended||q.role==='mcp'&&p?.clients?.[client])return r.sendStatus(403);next()});
app.get('/eligibility',(q,r)=>q.role==='mcp'?r.json({ok:true}):r.sendStatus(403));
/** Scope each connector route needs; a route not listed here is refused for the connector. */
export const ROUTE_SCOPES=Object.freeze([
 ['GET',/^\/home$/,'yeet:read'],
 ['GET',/^\/coins$/,'yeet:read'],
 ['POST',/^\/proposals$/,'yeet:write'],
 ['POST',/^\/proposals\/skeet$/,'yeet:write'],
 ['POST',/^\/proposals\/p_[a-z0-9]{20}\/quote$/,'yeet:write'],
 ['POST',/^\/trades$/,'yeet:trade'],
 ['POST',/^\/trades\/t_[a-z0-9]{20}\/signature$/,'yeet:trade'],
 ['GET',/^\/trades\/t_[a-z0-9]{20}$/,'yeet:read'],
 ['GET',/^\/portfolio$/,'yeet:read'],
 ['GET',/^\/leaderboard\/(xp|week)$/,'yeet:read'],
 ['POST',/^\/spin$/,'yeet:write'],
 ['POST',/^\/username$/,'yeet:write'],
]);
export const routeScope=(method,path)=>ROUTE_SCOPES.find(([m,p])=>m===method&&p.test(path))?.[2]??null;
app.use((q,r,next)=>{if(q.role==='mcp'){const needed=routeScope(q.method,q.path);if(!needed||!q.principal.scopes.has(needed))return r.sendStatus(403)}next()});
// Wallet setup at sign-in (trade/wallet-ensure.mjs): only the sign-in server asks, after it verified the Privy identity.
let walletEnsurer;
app.post('/wallets/ensure',async(q,r)=>{
 if(q.role!=='as')return r.sendStatus(403);
 const config=walletSetupConfig();
 if(!config)return r.status(503).json({code:'WALLET_SETUP_UNAVAILABLE',message:walletSetupMessage('WALLET_SETUP_UNAVAILABLE')});
 walletEnsurer??=createWalletEnsurer({config});
 try{r.json(await walletEnsurer.ensure(q.subject,didFor(q.subject)))}
 catch(e){const code=typeof e?.code==='string'?e.code:'WALLET_SETUP_FAILED';r.status(502).json({code,chain:e?.chain??null,privy_status:e?.status??null,message:walletSetupMessage(code)})}
});
app.get('/coins',(_q,r)=>r.json(coins()));
// Trade engine (lane B). Only the connector reaches these routes; each answer is the tool's structuredContent, plus
// `confirm` for the card-only `_meta` where the contract has one. A refusal is the contract `failure` shape.
const inputs=Object.fromEntries(Object.entries(toolSchemas).map(([n,s])=>[n,zodSchema(z,s.input)]));
const CODE_STATUS={TEMPORARILY_UNAVAILABLE:503,TRADING_PAUSED:503,REAUTH_REQUIRED:401};
function trade(tool,fn){
 return async(q,r)=>{
  if(q.role!=='mcp')return r.sendStatus(403);
  const ctx={accountId:q.subject,clientId:q.principal.client};
  const args=tool?inputs[tool].safeParse(q.method==='GET'?{}:q.body??{}):{success:true,data:{}};
  if(!args.success)return r.status(400).json(failure('INVALID_ARGUMENT'));
  try{r.json(await fn(await tradeEngine(),ctx,args.data,q))}
  catch(e){
   if(e?.name==='TradeError'){console.error(JSON.stringify({event:'trade_refused',route:q.route?.path,code:e.code,detail:String(e.detail??'').slice(0,200)}));return r.status(CODE_STATUS[e.code]??409).json(failureWithFundUrl(failure(e.code)))}
   console.error(JSON.stringify({event:'trade_route_failed',route:q.route?.path,error:String(e?.message??e).slice(0,200)}));
   unavailable(r);
  }
 };
}
app.get('/home',trade('yeet_home',async(e,ctx)=>{
 const home=homeWithFundUrl(await e.home(ctx));
 if(!p2On())return home;
 return {...home,xp:xpSafe('home',()=>homeXp(xpRuntime().summary(ctx.accountId),HOME_XP_KEYS),null),recent_wins:xpSafe('wins',()=>xpRuntime().recentWins(),[])};
}));
app.post('/proposals',trade('yeet_propose',(e,ctx,a)=>e.propose(ctx,a)));
app.post('/proposals/skeet',trade('skeet_propose',(e,ctx,a)=>e.skeet(ctx,a)));
app.post('/proposals/:id/quote',trade(null,(e,ctx,_a,q)=>{const a=inputs.yeet_quote.safeParse({...q.body,proposal_id:q.params.id});if(!a.success)throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});return e.quote(ctx,a.data)}));
app.post('/trades',trade('execute_trade',(e,ctx,a)=>e.execute(ctx,a)));
// submit_trade_signature: bytes the person's own wallet signed for one leg (pipeline.submit checks and sponsors them).
app.post('/trades/:id/signature',trade(null,(e,ctx,_a,q)=>{const a=inputs.submit_trade_signature.safeParse({...q.body,trade_id:q.params.id});if(!a.success)throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});return e.submit(ctx,a.data)}));
app.get('/trades/:id',trade(null,(e,ctx,_a,q)=>{
 const view=e.status(ctx,q.params.id);
 return p2On()?{...view,xp_award:xpSafe('trade',()=>xpRuntime().tradeAward(ctx.accountId,view),null)}:view;
}));
app.get('/portfolio',trade('yeet_portfolio',(e,ctx)=>e.portfolio(ctx)));
// Leaderboard and daily spin (P2): answered only with YEET_P2=1, otherwise a typed retryable failure.
function xpRoute(tool,fn){
 return (q,r)=>{
  if(q.role!=='mcp')return r.sendStatus(403);
  if(!p2On())return unavailable(r);
  const args=inputs[tool].safeParse(q.method==='GET'?{...q.params}:q.body??{});
  if(!args.success)return r.status(400).json(failure('INVALID_ARGUMENT'));
  try{r.json(fn(xpRuntime(),q.subject,args.data))}
  catch(e){console.error(JSON.stringify({event:'xp_route_failed',route:q.route?.path,error:String(e?.message??e).slice(0,200)}));unavailable(r)}
 };
}
/** The name a board shows: the username the person set, otherwise the default name. */
export const boardName=id=>usernameOf(id)??handle(id);
app.get('/leaderboard/:board',xpRoute('yeet_leaderboard',(x,who,a)=>x.board(a.board??'xp',who,boardName)));
app.post('/spin',xpRoute('daily_spin',(x,who)=>x.doSpin(who)));
// Username (username.mjs): read by the sign-in server's account page; set from that page or by yeet_set_username.
app.get('/username',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);r.json({username:usernameOf(q.subject)??null,name:boardName(q.subject)})});
app.post('/username',(q,r)=>{
 if(q.role!=='as'&&q.role!=='mcp')return r.sendStatus(403);
 try{const username=setUsername(q.subject,q.body?.username);r.json({username})}
 catch(e){
  if(e?.name==='UsernameError')return r.status(e.code==='USERNAME_TAKEN'?409:400).json(usernameFailure(e.code));
  console.error(JSON.stringify({event:'username_failed',error:String(e?.message??e).slice(0,200)}));unavailable(r);
 }
});
app.use((_e,_q,r,_n)=>r.status(400).json({error:'invalid request'}));
export const server=app.listen(port('CORE_PORT',38316),process.env.LISTEN_HOST||'0.0.0.0');

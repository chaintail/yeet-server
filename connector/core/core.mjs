import {initializeIdentityStore,resolveIdentity,lookupIdentity,account,didFor,usernameOf,setUsername} from './identity-store.mjs';
import {usernameFailure} from './username.mjs';
import {handle} from './xp/board.mjs';
import {createWalletEnsurer,walletSetupConfig,walletSetupMessage} from './trade/wallet-ensure.mjs';
import express from 'express';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import {secret,equal,read,write,port,TEST,DEV_APP_ID} from '#shared/common.mjs';
import {coins,coin,symbolOf} from './coins.mjs';
import {unavailable,failure,withUserMessage} from './failure.mjs';
import {tradeEngine,onTradeSettled} from './trade/runtime.mjs';
import {ledgerConfig} from './ledger-route/config.mjs';
import {loadSolverKey} from './ledger-route/solver.mjs';
import {xpRuntime,p2On,homeXp,homeXpKeys,checkSpinTable} from './xp/xp.mjs';
import {createAvailability,quoteProbe} from './xp/availability.mjs';
import {z} from 'zod';
import {toolSchemas,zodSchema,contract} from '../mcp/tool-contract.mjs';
import {homeWithFundUrl,failureWithFundUrl,fundAnswer,fundUrlWithHint,homeAnswer,portfolioAnswer,depositFor} from './fund-link.mjs';
import {versionInfo} from './version.mjs';
import {overview,totalUsdc,welcomeSuggestions} from './overview.mjs';
import {winnerOf} from './trade/pnl.mjs';
import {boardAnswer} from './xp/boards.mjs';
import {TERMS_VERSION,REQUIRED_IDS,termsObject,checkAcceptance,termsOpen,termsLinkFor} from './terms.mjs';
import {requireLinkKey,withLinkToken} from '#shared/link-token.mjs';
import {acceptanceOf,recordAcceptance,acceptViaLink,referralOf,decideReferral,referralCode} from './terms-store.mjs';
import {createAccountLogin,withCardAccount,hintFor} from './account-login.mjs';
import {hasScope} from '#scope-catalog';
// Accounts are created on the first verified sign-in (identity-store.mjs). The identity app is Privy in
// production and the development stub only under TEST_PROFILE=1 with DEV_IDENTITY_STUB=1.
const devStub=TEST&&process.env.DEV_IDENTITY_STUB==='1';
if(process.env.PRIVY_LOGIN==='1'&&devStub)throw Error('Identity modes must be separate');
if(process.env.PRIVY_LOGIN!=='1'&&!devStub)throw Error('No identity verifier configured');
// The ledger route (docs/LEDGER-ROUTE.md) is checked at start, not at the first trade: with YEET_ROUTE=ledger or an account
// in YEET_LEDGER_ACCOUNTS, a missing or malformed solver setting, or a key file that is absent or belongs to another
// account, stops the core here. With the route off (the default) nothing is read.
{const ledger=ledgerConfig(process.env);if(ledger.enabled)loadSolverKey({accountId:ledger.solverAccount,keyFile:ledger.solverKeyFile})}
initializeIdentityStore({app:process.env.PRIVY_LOGIN==='1'?process.env.PRIVY_APP_ID:DEV_APP_ID});
const user=id=>account(id);
// XP (lane E, YEET_P2=1): trade settlement pays through the tracker's onSettled hook; read per event so the flag is live.
onTradeSettled(e=>{if(p2On()){xpRuntime().onSettled(e);luckySettled(e)}});
/** XP never stands in the way of the answer it decorates: a failure is logged and the XP part is left out. */
/** yeet_home's xp fields as the pinned contract lists them; the summary is cut to these. */
const HOME_XP_KEYS=homeXpKeys(toolSchemas.yeet_home.output);
// The card draws the wheel from the contract's x-yeet-spin; the server draws the award. Refuse to start if they differ.
checkSpinTable(contract['x-yeet-spin']);
const xpSafe=(what,fn,fallback)=>{try{return fn()}catch(e){console.error(JSON.stringify({event:'xp_failed',what,error:String(e?.message??e).slice(0,200)}));return fallback}};
// Lucky wheel (xp/lucky.mjs). The claim runs from the tracker's settle event and again from every trade_status read
// (as trade XP does), so a lost event still claims; lucky.settle claims once whatever the path.
const luckyClaim=(engine,accountId,tradeId,view)=>{
 const x=xpRuntime(),proposal=engine.proposalOf({accountId},tradeId);
 if(!x.lucky.linked(proposal))return;
 const r=x.lucky.settle(accountId,proposal,view??engine.status({accountId},tradeId));
 if(r.fresh)console.log(JSON.stringify({event:'lucky_claimed',trade:tradeId,grant:r.grant?.id??null}));
};
function luckySettled(e){
 if(e?.direction!=='yeet')return;
 tradeEngine().then(engine=>xpSafe('lucky_settle',()=>luckyClaim(engine,e.accountId,e.tradeId)),()=>{});
}
// Which meme coins 1Click can quote now: dry quotes through the engine's own client, cached 5 minutes per coin.
let availability;
const luckyAvailable=engine=>{
 if(availability?.client!==engine.client)availability={client:engine.client,check:createAvailability({probe:quoteProbe({client:engine.client,catalog:engine.catalog})})};
 return availability.check.available;
};
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
app.get('/health',(_q,r)=>r.json({ok:true}));
// Public facts about this deployment (version.mjs); read once at start, the settings are fixed for the process.
const VERSION=Object.freeze(versionInfo());
app.get('/version',(_q,r)=>r.json(VERSION));
app.use((q,r,next)=>{const token=q.headers.authorization?.replace(/^Bearer /,'');q.role=['mcp','as','operator'].find(role=>equal(token,secret(`core-${role}`)));if(!q.role)return r.sendStatus(401);next()});
app.post('/identity/resolve',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const id=resolveIdentity(q.body);if(!id||read('policy.json')[id]?.suspended)return r.sendStatus(403);if(p2On())xpSafe('sign_in',()=>xpRuntime().signIn(id));r.json({id})});
// The signing page (as/sign-page.mjs): the sign-in server verified a Privy access token and asks which account that
// identity is ALREADY linked to. Unlike /identity/resolve this never creates an account and awards nothing.
app.post('/identity/lookup',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const id=lookupIdentity(q.body);if(!id)return r.sendStatus(404);if(read('policy.json')[id]?.suspended)return r.sendStatus(403);r.json({id})});
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
 ['GET',/^\/overview$/,'yeet:read'],
 ['GET',/^\/home$/,'yeet:read'],
 ['GET',/^\/coins$/,'yeet:read'],
 ['GET',/^\/coins\/[A-Z0-9]{2,12}$/,'yeet:read'],
 ['POST',/^\/proposals$/,'yeet:write'],
 ['POST',/^\/proposals\/skeet$/,'yeet:write'],
 ['POST',/^\/proposals\/p_[a-z0-9]{20}\/quote$/,'yeet:write'],
 ['POST',/^\/trades$/,'yeet:prepare'],
 ['POST',/^\/trades\/t_[a-z0-9]{20}\/signature$/,'yeet:prepare'],
 ['GET',/^\/terms$/,'yeet:read'],
 ['POST',/^\/terms\/accept$/,'yeet:write'],
 ['GET',/^\/referral$/,'yeet:read'],
 ['POST',/^\/referral$/,'yeet:write'],
 ['GET',/^\/trades\/t_[a-z0-9]{20}$/,'yeet:read'],
 ['GET',/^\/portfolio$/,'yeet:read'],
 ['GET',/^\/fund$/,'yeet:read'],
 ['GET',/^\/leaderboard\/(xp|week|winners|best_trade|losers|coins)(\/(today|7d|all))?$/,'yeet:read'],
 ['GET',/^\/checkin$/,'yeet:read'],
 ['POST',/^\/spin$/,'yeet:write'],
 ['GET',/^\/lucky$/,'yeet:read'],
 ['POST',/^\/lucky\/spin$/,'yeet:write'],
 ['POST',/^\/username$/,'yeet:write'],
]);
export const routeScope=(method,path)=>ROUTE_SCOPES.find(([m,p])=>m===method&&p.test(path))?.[2]??null;
app.use((q,r,next)=>{if(q.role==='mcp'){const needed=routeScope(q.method,q.path);if(!needed||!hasScope(q.principal.scopes,needed))return r.sendStatus(403)}next()});
// ---- The YEET terms (terms.mjs, terms-store.mjs, docs/TERMS-IN-CHAT.md). Until the person accepted the CURRENT version,
// every connector route answers 403 TERMS_REQUIRED with the terms, except the overview (it answers, with
// terms.accepted false and "review and accept the YEET terms" as its first suggestion) and the terms routes
// themselves. The sign-in server's own routes (the account page, wallet set-up, the trade page of a trade that already
// exists) and the operator's are not gated here.
// ---- Account-bound page links (shared/link-token.mjs purpose `hint`; account-login.mjs hintFor). A link the core
// hands out for the connected account names that account and the sign-in methods its Privy user has (read from
// Privy with the app credentials, cached as the card facts are). The pages show only those methods and refuse any
// other account. No answer from Privy: no link is handed out (fund_url is left out, the card gets no trade page
// address) until the next answer can make one. The binding is never dropped to keep a link.
let accountLogin;
const logins=()=>(accountLogin??=createAccountLogin());
const signHint=(ctx,facts)=>hintFor(ctx.accountId,facts,{key:pageKey()});
/** The hint from facts that are already cached, or null. Never waits. */
function knownHint(accountId){try{const did=didFor(accountId),facts=did?logins().peek(did):null;return facts?hintFor(accountId,facts,{key:pageKey()}):null}catch{return null}}
/** The account's funding page link (waits for Privy once, 4 s at most; then cached). Null when the hint cannot be
 * made (Privy did not answer): the answer then carries no fund_url. An unbound funding link is never handed out. */
async function fundLink(accountId){try{const did=didFor(accountId),facts=did?await logins()(did):null;return fundUrlWithHint(facts?hintFor(accountId,facts,{key:pageKey()}):null)}catch{return null}}
// The key the page links are signed with (shared/link-token.mjs: derived from core-as). Checked when the core starts:
// with no usable key the core does not start, rather than hand out links that bind nothing.
const LINK_KEY=requireLinkKey('core');
const pageKey=()=>LINK_KEY;
// terms.page_url is this account's own link: the terms page opens on the statements and Accept with no sign-in.
// It also carries the account's sign-in hint when the methods are already known (never waiting for Privy), so a
// link that has expired still offers the right methods.
// A link that cannot be signed is not handed out at all (the chat then is the only place): never a bare page URL.
function withTermsLink(terms,accountId){
 if(!terms.page_url)return terms;
 const link=termsLinkFor(accountId,{pageUrl:terms.page_url,key:pageKey()});
 if(link)return {...terms,page_url:withLinkToken(link,'h',knownHint(accountId))};
 const {page_url:_,...rest}=terms;
 return {...rest,mode:'chat'};
}
const termsOf=accountId=>withTermsLink(termsObject(acceptanceOf(accountId,TERMS_VERSION)),accountId);
app.use((q,r,next)=>{
 if(q.role!=='mcp'||termsOpen(q.method,q.path))return next();
 const terms=termsOf(q.subject);
 if(terms.accepted)return next();
 r.status(403).json({...failure('TERMS_REQUIRED'),terms});
});
app.get('/terms',(q,r)=>{if(q.role!=='mcp'&&q.role!=='as')return r.sendStatus(403);r.json({terms:termsOf(q.subject)})});
// yeet_accept_terms (source chat, with ChatGPT's conversation id when it sent one) and the /account/terms page (source
// page). Refused unless the version is the current one and every required statement is among `confirmed`.
// `via: "link"` (sign-in server only): accepted on the page through the account's signed link, with no sign-in
// (as/terms-page.mjs). Source `terms-link`. Such a link is a bearer, so: it records the required statements ONLY
// (an optional one in the request is dropped), and it is used once: the token's id (`token_id`) is marked with the
// acceptance, and a second call with it records nothing and answers 409 LINK_USED with the terms as they stand.
const TERMS_LINK='terms-link';
app.post('/terms/accept',async(q,r)=>{
 if(q.role!=='mcp'&&q.role!=='as')return r.sendStatus(403);
 const b=q.body??{};
 if(typeof b.version!=='string'||!Array.isArray(b.confirmed)||b.confirmed.length>12||b.confirmed.some(x=>typeof x!=='string'))return r.status(400).json(failure('INVALID_ARGUMENT'));
 const viaLink=q.role==='as'&&b.via==='link';
 if(viaLink&&(typeof b.token_id!=='string'||!/^[A-Za-z0-9_-]{16,32}$/.test(b.token_id)))return r.status(400).json(failure('INVALID_ARGUMENT'));
 const source=q.role==='as'?(viaLink?TERMS_LINK:'page'):'chat';
 const check=checkAcceptance({version:b.version,confirmed:viaLink?b.confirmed.filter(id=>REQUIRED_IDS.includes(id)):b.confirmed});
 if(!check.ok){
  console.log(JSON.stringify({event:'terms_refused',account:q.subject,version:String(b.version).slice(0,20),reason:check.reason,missing:check.missing,source}));
  return r.status(403).json({...failure('TERMS_REQUIRED'),terms:termsOf(q.subject),reason:check.reason,missing:check.missing});
 }
 // The link path: the token id and the acceptance go in together or not at all (terms-store.mjs acceptViaLink).
 let record,fresh;
 if(viaLink){
  const out=acceptViaLink({accountId:q.subject,tokenId:b.token_id,version:TERMS_VERSION,statements:check.confirmed});
  if(out.used){
   console.log(JSON.stringify({event:'terms_link_reused',account:q.subject}));
   return r.status(409).json({error:'LINK_USED',terms:termsOf(q.subject)});
  }
  ({record,fresh}=out);
 }else{
  const session=source==='chat'&&typeof b.session==='string'?b.session.slice(0,200):null;
  ({record,fresh}=recordAcceptance({accountId:q.subject,version:TERMS_VERSION,statements:check.confirmed,source,clientId:q.role==='mcp'?q.principal.client:'terms-page',session}));
 }
 console.log(JSON.stringify({event:'terms_accepted',account:q.subject,version:record.version,statements:record.statements,accepted_at:record.accepted_at,source:record.source,client:record.client_id,session:record.session,fresh}));
 const terms=withTermsLink(termsObject(record),q.subject);
 if(q.role==='as')return r.json({terms});
 // The overview, so the conversation continues; null when it cannot be read just now (the acceptance stands).
 let view=null;
 try{view=await overviewFor(await tradeEngine(),{accountId:q.subject,clientId:q.principal.client})}catch(e){console.error(JSON.stringify({event:'terms_overview_failed',error:String(e?.message??e).slice(0,200)}))}
 // The first thing after the terms: the name, then what to do next (overview.mjs welcomeSuggestions).
 if(view)view={...view,suggestions:welcomeSuggestions({named:!!usernameOf(q.subject),checkinOpen:view.checkin_open===true})};
 r.json({terms,overview:view});
});
// The win code (yeet_referral and the card-only apply_referral): the rule of the connect screen it came from.
app.get('/referral',(q,r)=>{if(q.role!=='mcp')return r.sendStatus(403);r.json(referralOf(q.subject))});
app.post('/referral',(q,r)=>{
 if(q.role!=='mcp')return r.sendStatus(403);
 const b=q.body??{},code=b.code===undefined?null:referralCode(b.code),skip=b.skip===true;
 if((b.code!==undefined&&!code)||(!code&&!skip)||(code&&skip))return r.status(400).json(failure('INVALID_ARGUMENT'));
 const out=decideReferral(q.subject,{code,skip});
 console.log(JSON.stringify({event:'referral_decided',account:q.subject,status:out.status,code:out.code}));
 r.json(out);
});
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
// yeet_coins: the catalogue with live prices (coins.mjs, market.mjs). A price that cannot be read is null, never an error.
app.get('/coins',async(_q,r)=>{try{r.json(await coins())}catch(e){console.error(JSON.stringify({event:'coins_failed',error:String(e?.message??e).slice(0,200)}));unavailable(r)}});
// yeet_coin: one coin. What the person holds of it comes from the portfolio read when that answers within 2.5 s;
// otherwise the coin is shown without a holding. An unknown symbol is the contract's COIN_NOT_SUPPORTED.
const HOLDING_MS=2500;
async function holdingOf(ctx,symbol){
 let timer;
 try{
  const bag=await Promise.race([tradeEngine().then(e=>e.portfolio(ctx)),new Promise((_,no)=>{timer=setTimeout(()=>no(Error('timeout')),HOLDING_MS)})]);
  const h=(bag?.solana?.holdings??[]).find(x=>x.symbol===symbol);
  return h&&Number(h.amount)>0?{amount:h.amount,usd:h.usd??null}:null;
 }catch{return null}finally{clearTimeout(timer)}
}
app.get('/coins/:symbol',async(q,r)=>{
 if(q.role!=='mcp')return r.sendStatus(403);
 const symbol=symbolOf(q.params.symbol);
 try{
  const view=symbol?await coin(symbol,{holding:await holdingOf({accountId:q.subject,clientId:q.principal.client},symbol)}):null;
  if(!view)return r.status(409).json(failure('COIN_NOT_SUPPORTED'));
  r.json(view);
 }catch(e){console.error(JSON.stringify({event:'coin_failed',error:String(e?.message??e).slice(0,200)}));unavailable(r)}
});
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
   if(e?.name==='TradeError'){console.error(JSON.stringify({event:'trade_refused',route:q.route?.path,code:e.code,detail:String(e.detail??'').slice(0,200)}));return r.status(CODE_STATUS[e.code]??409).json(failureWithFundUrl(withUserMessage(failure(e.code),e),e.code==='BALANCE_LOW'?await fundLink(ctx.accountId):undefined))}
   console.error(JSON.stringify({event:'trade_route_failed',route:q.route?.path,error:String(e?.message??e).slice(0,200)}));
   unavailable(r);
  }
 };
}
app.get('/home',trade('yeet_home',async(e,ctx)=>{
 const raw=await e.home(ctx);
 // No wallets and no address in the answer (fund-link.mjs homeAnswer): one USDC number.
 const home=homeAnswer(homeWithFundUrl(raw,raw?.ready==='needs_funds'?await fundLink(ctx.accountId):undefined));
 if(!p2On())return home;
 return {...home,xp:xpSafe('home',()=>homeXp(xpRuntime().summary(ctx.accountId),HOME_XP_KEYS),null),recent_wins:xpSafe('wins',()=>xpRuntime().recentWins(),[])};
}));
// yeet_overview (overview.mjs): the entry answer. The portfolio read, the XP summary and the cost basis each fail soft
// (their fields are null); only the wallets and readiness (e.home) can refuse the call.
async function overviewFor(e,ctx,{card=false}={}){
 const [home,bag]=await Promise.all([e.home(ctx),e.portfolio(ctx).catch(()=>null)]);
 const xp=p2On()?xpSafe('overview',()=>xpRuntime().summary(ctx.accountId),null):null;
 const winner=bag?xpSafe('winner',()=>winnerOf(bag.solana.holdings,e.averageCost(ctx.accountId)),null):null;
 const view=overview({home,bag,xp,winner,username:boardName(ctx.accountId),wheel:p2On(),board:p2On(),terms:termsOf(ctx.accountId),referral:referralOf(ctx.accountId)});
 if(!card)return view;
 // Card only (the connector moves it to _meta["yeet/account"]): who the connected account is, for the device check.
 const did=didFor(ctx.accountId),login=await logins()(did);
 const wallets=[home.wallets?.base?.address,home.wallets?.solana?.address].filter(a=>typeof a==='string');
 return {...view,card_account:{user:did??null,email:login?.email??null,masked:login?.masked??null,google:login?.google===true,apple:login?.apple===true,wallets}};
}
// The basket card meets the first trade on a device: its answers (yeet_propose, skeet_propose, yeet_quote) carry the
// card-only account facts too (account-login.mjs withCardAccount). No facts from Privy: the answer is unchanged.
const basketCard=withCardAccount({lookup:logins,didOf:ctx=>didFor(ctx.accountId),hint:signHint});
// execute_trade and submit_trade_signature: only the trade page hint, from facts already known (the basket read them).
const hintOnly=withCardAccount({lookup:logins,didOf:ctx=>didFor(ctx.accountId),hint:signHint,wait:false,account:false});
app.get('/overview',trade('yeet_overview',(e,ctx)=>overviewFor(e,ctx,{card:true})));
// yeet_fund: the funding card. All USDC as one number (read fresh: the card asks again after the funding page).
app.get('/fund',trade('yeet_fund',async(e,ctx)=>{
 const home=await e.home(ctx),f=home.funding;
 // The account's own deposit addresses, for the card only (card_deposit; the connector moves it to _meta). They are
 // the bound account's (ctx.accountId is the token's subject), read by e.home from the wallet directory.
 // An account on the ledger route (docs/LEDGER-ROUTE.md 1.5): its permanent deposit address and the watch of a
 // deposit. No card payment and no funding page link: a card payment lands in the person's wallet, not in their
 // ledger account. null for every other account, whose answer below is unchanged.
 const led=await e.ledgerFund?.(ctx,home);
 if(led)return {...fundAnswer(led.usdc??(f?totalUsdc(f.base_usdc,f.solana_usdc):null),null),methods:led.methods,...(led.card_deposit?{card_deposit:led.card_deposit}:{}),...(led.watch?{watch:led.watch}:{}),...(led.min_deposit_usdc?{min_deposit_usdc:led.min_deposit_usdc}:{})};
 const deposit=depositFor(home.wallets,e.funding?.deposits?.());
 return {...fundAnswer(f?totalUsdc(f.base_usdc,f.solana_usdc):totalUsdc(home.wallets?.base?.usdc),await fundLink(ctx.accountId)),...(deposit?{card_deposit:deposit}:{})};
}));
// lucky_id (optional): the caller's own lucky wheel, spun today, else INVALID_ARGUMENT. The proposal is linked to it;
// the bonus is decided when the trade settles (lucky.settle), since yeet_quote can still change coins and amount.
// Without YEET_P2 the lucky tools are not registered and lucky_id is ignored.
app.post('/proposals',trade('yeet_propose',basketCard(async(e,ctx,a)=>{
 if(a.lucky_id===undefined)return e.propose(ctx,a);
 if(!p2On()){const {lucky_id:_,...rest}=a;return e.propose(ctx,rest)}
 xpRuntime().lucky.check(ctx.accountId,a.lucky_id);
 const out=await e.propose(ctx,a);
 xpRuntime().lucky.link(ctx.accountId,a.lucky_id,out.proposal_id);
 return out;
})));
app.post('/proposals/skeet',trade('skeet_propose',basketCard((e,ctx,a)=>e.skeet(ctx,a))));
app.post('/proposals/:id/quote',trade(null,basketCard((e,ctx,_a,q)=>{const a=inputs.yeet_quote.safeParse({...q.body,proposal_id:q.params.id});if(!a.success)throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});return e.quote(ctx,a.data)})));
app.post('/trades',trade('execute_trade',hintOnly((e,ctx,a)=>e.execute(ctx,a))));
// submit_trade_signature: bytes the person's own wallet signed for one leg (pipeline.submit checks and sponsors them).
app.post('/trades/:id/signature',trade(null,hintOnly((e,ctx,_a,q)=>{const a=inputs.submit_trade_signature.safeParse({...q.body,trade_id:q.params.id});if(!a.success)throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});return e.submit(ctx,a.data)})));
// trade_status carries the card-only account facts as well, but only the ones already known (it never waits for
// Privy): a card that follows a trade finished on the YEET page then sees the email the person confirmed there.
const statusCard=withCardAccount({lookup:logins,didOf:ctx=>didFor(ctx.accountId),wait:false,hint:signHint});
app.get('/trades/:id',trade(null,statusCard((e,ctx,_a,q)=>{
 const view=e.status(ctx,q.params.id);
 if(!p2On())return view;
 if(view.direction==='yeet')xpSafe('lucky_status',()=>luckyClaim(e,ctx.accountId,view.trade_id,view));
 return {...view,xp_award:xpSafe('trade',()=>xpRuntime().tradeAward(ctx.accountId,view),null)};
})));
app.get('/portfolio',trade('yeet_portfolio',async(e,ctx)=>portfolioAnswer(await e.portfolio(ctx))));
// The first-party signing page (as/sign-page.mjs, CARD-SIGNING.md section 2.5). Only the sign-in server reaches these,
// and only after it verified the person's Privy access token and looked up the account already linked to it: that
// account is `x-yeet-subject` (checked to exist and not be suspended above). The engine then answers only for a trade
// of that account (pipeline.owned: trades.account_id) and a sign attempt of that account (ledger attempt.account_id);
// the signed bytes must be the server's own request for the account's wallet (driver.submit). Client id `sign-page`.
const PAGE_CLIENT='sign-page',TRADE_ID=/^t_[a-z0-9]{20}$/;
function pageTrade(fn){
 return async(q,r)=>{
  if(q.role!=='as')return r.sendStatus(403);
  if(!TRADE_ID.test(q.params.id))return r.status(400).json(failure('INVALID_ARGUMENT'));
  try{r.json(await fn(await tradeEngine(),{accountId:q.subject,clientId:PAGE_CLIENT},q))}
  catch(e){
   if(e?.name==='TradeError'){console.error(JSON.stringify({event:'sign_page_refused',route:q.route?.path,code:e.code,detail:String(e.detail??'').slice(0,200)}));return r.status(CODE_STATUS[e.code]??409).json(withUserMessage(failure(e.code),e))}
   console.error(JSON.stringify({event:'sign_page_failed',route:q.route?.path,error:String(e?.message??e).slice(0,200)}));
   unavailable(r);
  }
 };
}
/** The trade's open sign requests (the same ones execute_trade answers; a stale attempt is renewed within the window). */
app.post('/sign/trades/:id/requests',pageTrade((e,ctx,q)=>e.pageRequests(ctx,q.params.id)));
/** submit_trade_signature from the page: the same engine call as the tool. */
app.post('/sign/trades/:id/signature',pageTrade((e,ctx,q)=>{const a=inputs.submit_trade_signature.safeParse({...q.body,trade_id:q.params.id});if(!a.success)throw Object.assign(Error('INVALID_ARGUMENT'),{name:'TradeError',code:'INVALID_ARGUMENT'});return e.submit(ctx,a.data)}));
/** The page linked an email login to the account's Privy user (the optional step after a Google or Apple trade):
 * drop the cached sign-in facts, so the next basket answer reads them from Privy again and the card emails the code.
 * Nothing is taken from the page's word: the facts always come from Privy (account-login.mjs). Sign-in server only. */
app.post('/sign/account/login-refresh',(q,r)=>{
 if(q.role!=='as')return r.sendStatus(403);
 const did=didFor(q.subject);
 if(did)accountLogin?.forget(did);
 r.json({ok:true});
});
/** The funding page's account check (as/fund-page.mjs POST /fund/api/check): the Privy user id linked to the account
 * (`x-yeet-subject`) and ITS wallet addresses as the core holds them. The page shows only these. Sign-in server only. */
app.get('/account/wallets',async(q,r)=>{
 if(q.role!=='as')return r.sendStatus(403);
 try{
  const user=didFor(q.subject),w=await (await tradeEngine()).wallets.require(q.subject);
  if(!user||typeof w?.base?.address!=='string')return unavailable(r);
  r.json({user,addresses:{base:w.base.address,solana:typeof w.solana?.address==='string'?w.solana.address:null}});
 }catch(e){console.error(JSON.stringify({event:'account_wallets_failed',error:String(e?.code??e?.message??e).slice(0,120)}));unavailable(r)}
});
// Leaderboard and daily spin (P2): answered only with YEET_P2=1, otherwise a typed retryable failure.
function xpRoute(tool,fn){
 return async(q,r)=>{
  if(q.role!=='mcp')return r.sendStatus(403);
  if(!p2On())return unavailable(r);
  const args=inputs[tool].safeParse(q.method==='GET'?{...q.params}:q.body??{});
  if(!args.success)return r.status(400).json(failure('INVALID_ARGUMENT'));
  try{r.json(await fn(xpRuntime(),q.subject,args.data))}
  catch(e){
   // A typed refusal (the lucky wheel: someone else's or an expired lucky_id) is the caller's mistake, not an outage.
   if(e?.name==='TradeError'&&e.code==='INVALID_ARGUMENT')return r.status(400).json(failure('INVALID_ARGUMENT'));
   console.error(JSON.stringify({event:'xp_route_failed',route:q.route?.path,error:String(e?.message??e).slice(0,200)}));unavailable(r);
  }
 };
}
/** The name a board shows: the username the person set, otherwise the default name. */
export function boardName(id){return usernameOf(id)??handle(id)}
// Boards by XP and, from settled trades, by USDC made, best single SKEET, USDC lost and most yeeted coins (xp/boards.mjs).
app.get('/leaderboard/:board{/:window}',xpRoute('yeet_leaderboard',async(x,who,a)=>{
 const e=await tradeEngine();
 return boardAnswer({x,db:e.db,catalog:e.catalog,who,board:a.board,window:a.window,names:boardName});
}));
// yeet_checkin: the daily wheel on its own card (a check-in). The same XP summary yeet_home carries in `xp`.
app.get('/checkin',xpRoute('yeet_checkin',(x,who)=>({checkin:homeXp(x.summary(who),HOME_XP_KEYS)})));
app.post('/spin',xpRoute('daily_spin',(x,who)=>x.doSpin(who)));
// Lucky wheel (xp/lucky.mjs): today's five coins, picked at random per day (only coins 1Click quotes now), then the server's slice.
app.get('/lucky',xpRoute('lucky_wheel',async(x,who)=>x.lucky.wheel(who,luckyAvailable(await tradeEngine()))));
app.post('/lucky/spin',xpRoute('lucky_spin',(x,who,a)=>x.lucky.spin(who,a.lucky_id)));
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

// The YEET trade pipeline: Folio's client-signing flow (prepare unsigned -> the person's wallet signs -> server
// validates -> our sponsorship -> persist -> broadcast -> confirmation -> ledger) with the swap provider call replaced by
// NEAR Intents 1Click (oneclick-leg.mjs). It replaces trade/engine.mjs + executor.mjs: no server key ever signs for the
// person. Carried over unchanged by import: confirm codes (nonce.mjs), proposals (proposals.mjs), caps, kill switch,
// YEET_LIVE and YEET_LIVE_ACCOUNTS (limits.mjs), wallets (wallets.mjs), the router.
//
// execute_trade (at the person's tap):
//   1. confirm code bound to account, client, proposal, revision and quote; single use; a used code replays its trade
//      (with fresh sign requests for legs still awaiting a signature)
//   2. kill switch, YEET_LIVE, YEET_LIVE_ACCOUNTS and the chain pause; the chain's driver must be ready
//   3. caps (min leg, max trade, daily) and the person's balance on the origin chain
//   4. live 1Click plan, checked leg by leg (assertLivePlan); requote rule as before; cost cap
//   5. commit: code, proposal, trade (origin_chain), legs `awaiting_signature`, today's spend, in one transaction
//   6. sign requests from the driver (`status: awaiting_signature`, `sign_requests`): on Solana ONE request (one
//      transaction, one signature) pays every leg of the basket when it fits (`legs`, `leg_summaries`), else one per
//      leg; on Base (YEET_BASE_MODE=7702) ONE Calibur batch request (evm_7702) the gas wallet sends and pays, else one
//      per leg (legacy, the automatic fallback)
// submit_trade_signature: the person's signed bytes for one attempt -> driver.submit (guards, sponsorship, persist,
// send); every leg the attempt pays moves together. An expired attempt answers fresh sign requests instead of an error.
// Recovery (tracker tick): attempts are resolved by the driver; legs left unsigned past SIGN_WINDOW_MS, past the
// deposit deadline margin or while trading is paused become not_sent with the amount back to the daily cap; landed
// legs are reported to 1Click (/deposit/submit) and tracked.
import {limitsFromEnv,accountLive,checkKillSwitch,checkBasket,checkDaily,checkCost,recordSpend,capsFor,capsView} from '../trade/limits.mjs';
import {createConfirmCodes} from '../trade/nonce.mjs';
import {createProposals,quoteHash} from '../trade/proposals.mjs';
import {createWallets,createRpcBalances} from '../trade/wallets.mjs';
import {OneClickClient,formatUnits,CATALOG} from '../trade/router.mjs';
import {tx} from '../trade/db.mjs';
import {refuse,newId,iso,usd,TradeError} from '../trade/util.mjs';
import {statusTolerantFetch} from './oneclick-status.mjs';
import {createTracker,receiptLeg,legDeadline} from './tracker.mjs';
import {createLedger,appendEvent,OPEN_LEG} from './ledger.mjs';
import {livePlan,assertLivePlan,usdcOn} from './oneclick-leg.mjs';
import {createDrivers} from './drivers.mjs';
import {walletDirectoryFromEnv} from './wallet-directory.mjs';
import {readSponsorshipLimits} from './solana/sponsorship.mjs';
import {WALLET_CHAIN,CHAINS} from './driver-interface.mjs';
import {xpRuntime} from '../xp/xp.mjs';

export const PREVIEW_STALE_MS=60_000;
export const PRICE_TTL_MS=5*60_000;
/** A leg waits for its signature at most this long after the trade is committed (design 1.2: 10 min). */
export const SIGN_WINDOW_MS=10*60_000;
/** No sign request is issued when the leg's 1Click deposit deadline is closer than this. */
export const SEND_MARGIN_MS=120_000;
const TRUE=['1','true','on','yes'];
/** batch_json.mode of an attempt (Base 7702 batches), or null. */
const batchMode=a=>{if(!a?.batch_json)return null;try{return JSON.parse(a.batch_json).mode??null}catch{return null}};
const explorer=(chain,hash)=>hash?(chain==='base'?`https://basescan.org/tx/${hash}`:`https://solscan.io/tx/${hash}`):null;

/** The gate re-read on every call (design guard 1 / 9): kill switch, YEET_LIVE, YEET_LIVE_ACCOUNTS, the chain pause. */
export function liveGate(env=process.env){
 return chain=>accountId=>{
  const l=limitsFromEnv(env);
  if(l.killSwitch)refuse('TRADING_PAUSED','kill switch');
  if(!l.live)refuse('TRADING_PAUSED','YEET_LIVE is not set');
  if(!accountLive(l,accountId))refuse('TRADING_PAUSED','account not in YEET_LIVE_ACCOUNTS');
  if(TRUE.includes(String((chain==='sol'?env.YEET_SOLANA_PAUSE:env.YEET_BASE_PAUSE)??'').toLowerCase()))refuse('TRADING_PAUSED','SOURCE_PAUSED');
 };
}
const chainEnv=(env,name)=>{const v=env[name]?.trim()||'sol';if(!CHAINS.includes(v))throw Error(`Invalid ${name}`);return v};

export function createPipeline({db,env=process.env,client,wallets,directory,balances,drivers,ledger,catalog=CATALOG,now=Date.now,fetch=globalThis.fetch,didFor,
 onSettled,trackerIntervalMs=5000,log=line=>console.log(line),driverOverrides,liveBroadcast=true,
 landingPollMs=1000,landingWatchMs=60_000,landingWatchMax=200,sleep=ms=>new Promise(r=>{const h=setTimeout(r,ms);h.unref?.()}),
 xpOf=id=>xpRuntime(env).total(id)}){
 const limits=limitsFromEnv(env);
 /** The account's XP for the tier caps (limits.mjs); an unreadable XP store counts as 0 XP (Noob, the lowest caps). */
 const xpTotal=id=>{try{const n=Number(xpOf(id));return Number.isFinite(n)?n:0}catch{return 0}};
 const gateFor=liveGate(env);
 const buyChain=chainEnv(env,'YEET_BUY_CHAIN'),sellChain=chainEnv(env,'YEET_SELL_CHAIN');
 const event=e=>{try{log(JSON.stringify(e))}catch{}};
 client??=new OneClickClient({jwt:env.ONECLICK_JWT||undefined,timeoutMs:6000,retryDelayMs:500,fetch:statusTolerantFetch(fetch)});
 balances??=createRpcBalances({baseRpcUrl:env.BASE_RPC_URL,solanaRpcUrl:env.SOLANA_RPC_URL,fetch});
 directory??=walletDirectoryFromEnv({env,fetch,didFor});
 wallets??=createWallets({db,directory,balances,now});
 ledger??=createLedger({db,now,sponsorLimits:readSponsorshipLimits(env),log:l=>event(JSON.parse(l))});
 drivers??=createDrivers({env,db,ledger,fetch,now,log:event,gateFor,liveBroadcast,overrides:driverOverrides});
 const codes=createConfirmCodes({db,now,mintLimit:limits.codeMintLimit});
 const proposals=createProposals({db,client,limits,wallets,codes,now,catalog,xpOf:xpTotal});
 const tracker=createTracker({db,client,now,onSettled,intervalMs:trackerIntervalMs,trackMaxHours:limits.trackMaxHours,accounting:{raiseAlert:a=>ledger.raiseAlert(a),
  // Review finding 2: held BUY amounts return to the daily cap only after the deposit deadline, on 1Click's word.
  async tick(){await ledger.releaseDue((addr,memo)=>client.status(addr,memo));for(const d of Object.values(drivers))try{await d.accountingTick?.()}catch(e){event({event:'accounting_tick_failed',chain:d.chain,error:String(e?.message??e).slice(0,120)})}}}});
 const trade=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
 const legOf=(id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
 // Per-trade work counter (execute, submit, recovery, the landing notice). `has` is what recovery and cancel check;
 // `exclusive` waits until the trade is free and runs fn holding it (the landing watcher's deposit notice).
 const busy=new Map();
 const inFlight={
  has:id=>busy.has(id),
  add(id){const b=busy.get(id);if(b)b.n++;else busy.set(id,{n:1,waiters:[]})},
  delete(id){const b=busy.get(id);if(!b||--b.n>0)return;busy.delete(id);for(const w of b.waiters)w()},
 };
 async function exclusive(id,fn){
  while(busy.has(id))await new Promise(r=>busy.get(id).waiters.push(r));
  inFlight.add(id);
  try{return await fn()}finally{inFlight.delete(id)}
 }
 const driverOf=chain=>{const d=drivers[chain];if(!d)refuse('TEMPORARILY_UNAVAILABLE',`no driver for chain ${chain}`);return d};
 const walletOf=async(t,chain)=>(await wallets.require(t.account_id))[WALLET_CHAIN[chain]].address;
 const owned=(ctx,tradeId)=>{const t=trade(tradeId);if(!t||t.account_id!==ctx.accountId||t.status==='requote_required')refuse('INVALID_ARGUMENT','unknown trade');return t};

 /** The sign request for an open attempt (contract shape). A Solana request names every leg its one transaction pays
  * (`legs`, `leg_summaries`); `leg` and `summary` are the anchor (legs[0]). A legacy Base request carries neither;
  * a Base 7702 batch (batch_json mode 7702) is kind evm_7702 and names its legs the same way. */
 function signRequest(t,a){
  const side=t.direction==='yeet'?'buy':'sell';
  const summaryOf=l=>{const q=JSON.parse(l.live_quote_json);return {side,asset:q.origin.symbol,amount_raw:l.amount_in_raw,decimals:q.origin.decimals,to:l.deposit_address}};
  const legs=ledger.legsOfAttempt(a),rows=legs.map(i=>legOf(t.id,i));
  return {trade_id:t.id,leg:a.leg_idx,attempt_id:a.attempt_id,kind:batchMode(a)==='7702'?'evm_7702':a.kind,chain:a.chain,wallet:a.wallet,payload:JSON.parse(a.payload_json),payload_sha256:a.payload_sha256,
   expires_at:iso(a.expires_at),summary:summaryOf(rows[0]),
   ...(a.chain==='sol'||a.batch_json?{legs,leg_summaries:rows.map(l=>({leg:l.idx,...summaryOf(l)}))}:{})};
 }
 /** Prepares requests for `legs` (rows awaiting a signature, none covered by an open attempt): one driver call for
  * all of them when the driver can put several legs in one transaction, else one per leg. Returns
  * [{attemptId, legs} | {legs, error}]. */
 async function prepareAll(t,d,legs,wallet){
  if(d.prepareLegs)return d.prepareLegs({trade:t,legs,wallet,now:now()});
  const out=[];
  for(const l of legs){try{const p=await d.prepare({trade:t,leg:l,wallet,now:now()});out.push({...p,legs:[l.idx]})}catch(e){out.push({legs:[l.idx],error:e})}}
  return out;
 }
 /** Sign requests for every leg awaiting a signature: the open attempt while it is valid (one request per attempt,
  * however many legs it pays), else new ones (attempt n+1) for the uncovered legs. */
 async function signRequests(t){
  const out=[],chain=t.origin_chain,seen=new Set(),uncovered=[];
  if(!chain)return out;
  for(const l of legsOf(t.id).filter(l=>l.send_status==='awaiting_signature')){
   let a=ledger.openAttempt(t.id,l.idx);
   if(a&&seen.has(a.attempt_id))continue;
   if(a&&a.status==='pending'&&now()>a.expires_at){ledger.endAttempt(a.attempt_id,'pending','SIGN_EXPIRED');a=null}
   if(a){seen.add(a.attempt_id);if(a.status==='pending')out.push(signRequest(t,a));continue}
   if(now()>t.created_at+SIGN_WINDOW_MS||!(now()+SEND_MARGIN_MS<legDeadline(l)))continue;
   uncovered.push(l);
  }
  if(!uncovered.length)return out;
  let made;
  try{made=await prepareAll(t,driverOf(chain),uncovered,await walletOf(t,chain))}
  catch(e){made=uncovered.map(l=>({legs:[l.idx],error:e}))}
  for(const p of made){
   if(p.error){for(const i of p.legs){ledger.note(t.id,`leg ${i}: prepare: ${p.error?.detail??p.error?.message}`);event({event:'prepare_failed',trade:t.id,leg:i,code:p.error?.code??null})}continue}
   out.push(signRequest(t,ledger.attempt(p.attemptId)));
  }
  return out.sort((x,y)=>x.leg-y.leg);
 }
 const legView=(t,l)=>({symbol:l.symbol,deposit_address:l.deposit_address,tx_hash:l.send_status==='sent'||l.send_status==='signing'?l.tx_hash??null:null,
  explorer_url:explorer(t.origin_chain,l.send_status==='sent'?l.tx_hash:null),status:l.send_status});
 /** The execute_trade answer for a stored trade (also what a replayed code gets). */
 async function answer(tradeId){
  const t=trade(tradeId);
  if(!t)refuse('TEMPORARILY_UNAVAILABLE','trade missing');
  if(t.result_json){const r=JSON.parse(t.result_json);if(r.error)throw new TradeError(r.error,'replayed failure');return r}
  const sign_requests=await signRequests(t),legs=legsOf(t.id);
  return {trade_id:t.id,proposal_id:t.proposal_id,direction:t.direction,status:legs.some(l=>l.send_status==='awaiting_signature')?'awaiting_signature':'submitted',
   legs:legs.map(l=>legView(t,l)),sign_requests};
 }
 /** Once no leg is open: the proposal's final status, and the stored failure when nothing was sent. */
 function settle(tradeId,lastError){
  const t=trade(tradeId),legs=legsOf(tradeId);
  if(legs.some(l=>OPEN_LEG.includes(l.send_status)))return;
  const anySent=legs.some(l=>l.send_status==='sent');
  db.prepare("UPDATE proposals SET status=?,updated_at=? WHERE id=? AND status='executing'").run(anySent?'executed':'failed',now(),t.proposal_id);
  if(!anySent&&!t.result_json)db.prepare('UPDATE trades SET result_json=? WHERE id=?').run(JSON.stringify({error:lastError??'TEMPORARILY_UNAVAILABLE'}),tradeId);
 }
 /** 1Click /deposit/submit for a landed leg, until accepted. Callers hold the trade (inFlight / exclusive). Single
  * flight per leg (review int-v2 finding 1): deposit_submitted is claimed in the database before the await and given
  * back only if the call fails, so a second caller never sends a second notice; the answer is folded monotonically
  * (tracker.apply), so a slow answer never moves the leg back. */
 async function depositSubmit(t,idx){
  const l=legOf(t.id,idx);
  if(l.send_status!=='sent'||l.deposit_submitted||!l.tx_hash)return false;
  if(db.prepare("UPDATE trade_legs SET deposit_submitted=1 WHERE trade_id=? AND idx=? AND deposit_submitted=0 AND send_status='sent'").run(t.id,idx).changes!==1)return false;
  if(l.oneclick_status&&l.oneclick_status!=='PENDING_DEPOSIT')return false;
  try{tracker.apply(t.id,idx,await client.submitDeposit(l.deposit_address,l.tx_hash,l.deposit_memo??undefined));return true}
  catch(e){db.prepare('UPDATE trade_legs SET deposit_submitted=0 WHERE trade_id=? AND idx=?').run(t.id,idx);if(t.origin_chain==='base')try{drivers.base?.depositFailed?.({tradeId:t.id,idx,txHash:l.tx_hash,error:e})}catch{}ledger.note(t.id,`leg ${idx}: deposit/submit: ${e?.message}`);return false}
 }
 /** Polls one sent attempt every landingPollMs for up to landingWatchMs; /deposit/submit as soon as it has landed.
  * Not awaited by submit; the tracker pass stays the fallback. `landings()` awaits the open watches (tests, ops).
  * One watch per attempt (a resubmitted signature joins the open one) and at most landingWatchMax at once; beyond the
  * cap the tracker pass sends the notice (review int-v2 finding 2). */
 const watches=new Map();
 function watchLanding(t,legs,attemptId,d){
  if(!(landingWatchMs>0)||watches.has(attemptId))return;
  if(watches.size>=landingWatchMax){event({event:'landing_watch_capped',trade:t.id,leg:legs[0],legs,open:watches.size});return}
  const run=(async()=>{
   for(let i=0,n=Math.ceil(landingWatchMs/Math.max(1,landingPollMs));i<n;i++){
    await sleep(landingPollMs);
    let r;try{r=await d.recoverAttempt(attemptId)}catch{continue}
    if(r?.state==='sent'){
     // Under the trade's lock, like recovery: the notice and the tracker's recovery pass never overlap. One landed
     // transaction pays every leg of the attempt: one notice per leg (each single flight in depositSubmit).
     const sent=await exclusive(t.id,async()=>{const done=[];for(const idx of legs)if(await depositSubmit(t,idx))done.push(idx);return done});
     for(const idx of sent)event({event:'deposit_submitted_on_landing',trade:t.id,leg:idx});
     return;
    }
    if(!['pending','confirming'].includes(r?.state))return;
   }
  })().catch(e=>ledger.note(t.id,`leg ${legs[0]}: landing watch: ${e?.message}`)).finally(()=>watches.delete(attemptId));
  watches.set(attemptId,run);
 }
 const pausedReason=(t)=>{try{gateFor(t.origin_chain??'sol')(t.account_id);return null}catch(e){return e?.detail??'paused'}};

 /** Recovery for one trade (tracker tick, replay): see the header. */
 async function recoverTrade(tradeId){
  if(inFlight.has(tradeId))return false;
  const t=trade(tradeId);if(!t||!t.origin_chain)return false;
  const open=legsOf(tradeId).filter(l=>OPEN_LEG.includes(l.send_status)||(l.send_status==='sent'&&!l.deposit_submitted));
  if(!open.length)return false;
  inFlight.add(tradeId);
  try{
   const d=drivers[t.origin_chain],paused=pausedReason(t),recovered=new Set();
   for(const l of open){
    if(l.send_status==='sent'){await depositSubmit(t,l.idx);continue}
    const a=ledger.openAttempt(t.id,l.idx);
    // One recovery per attempt per pass, however many legs it pays; a landed attempt notifies 1Click for each.
    if(a&&d&&!recovered.has(a.attempt_id)){
     recovered.add(a.attempt_id);
     try{const r=d.recoverAttempt?await d.recoverAttempt(a.attempt_id):(await d.recover({now:now()})).find(x=>x.tradeId===t.id&&x.legIdx===a.leg_idx);
      if(r?.state==='sent')for(const i of ledger.legsOfAttempt(a))await depositSubmit(t,i)}
     catch(e){ledger.note(t.id,`leg ${l.idx}: recover: ${e?.message}`)}
    }
    const cur=legOf(t.id,l.idx);
    if(cur.send_status!=='awaiting_signature')continue;
    const why=paused?`trading paused: ${paused}`:now()>t.created_at+SIGN_WINDOW_MS?'not signed within the sign window':!(now()+SEND_MARGIN_MS<legDeadline(cur))?'deposit deadline too close':null;
    if(why)ledger.legNotSent(t.id,l.idx,{reason:why,stage:'recovery'});
   }
   settle(tradeId);
  }finally{inFlight.delete(tradeId)}
  try{tracker.refresh(tradeId)}catch(e){ledger.note(tradeId,`refresh: ${e?.message}`)}
  return true;
 }
 tracker.useRecovery(id=>recoverTrade(id));

 async function replay(tradeId){await recoverTrade(tradeId);return answer(tradeId)}
 const existingTrade=proposalId=>db.prepare("SELECT id FROM trades WHERE proposal_id=? AND status<>'requote_required' ORDER BY created_at DESC LIMIT 1").get(proposalId)?.id;

 async function requote(ctx,{p,legs,live,confirm}){
  const rows=proposals.legRows(live,{percents:legs.map(l=>l.percent)});
  const tradeId=newId('t'),t=now(),revision=p.revision+1;
  const done=tx(db,()=>{
   if(!codes.consume({code:confirm,tradeId}))return false;
   if(db.prepare("UPDATE proposals SET revision=?,updated_at=? WHERE id=? AND revision=? AND status='proposed'").run(revision,t,p.id,p.revision).changes!==1)refuse('CONFIRMATION_REQUIRED','proposal changed meanwhile');
   proposals.insertRevision(p.id,revision,rows);
   db.prepare('INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at,receipt_json,result_json) VALUES(?,?,?,?,?,?,?,?,NULL,NULL)')
    .run(tradeId,p.id,p.revision,ctx.accountId,p.direction,'requote_required',t,t);
   appendEvent(db,{tradeId,kind:'trade',from:null,to:'requote_required',evidence:{reason:'live quote worse than the preview',revision:p.revision,new_revision:revision},at:t});
   return true;
  });
  if(!done)return null;
  const fresh=proposals.row(p.id);
  const result={trade_id:tradeId,proposal_id:p.id,direction:p.direction,status:'requote_required',legs:[],requote:proposals.view(fresh,revision)};
  db.prepare('UPDATE trades SET result_json=? WHERE id=?').run(JSON.stringify(result),tradeId);
  return {...result,confirm:proposals.mint(fresh,revision,ctx.accountId,ctx.clientId,{rateLimited:false})};
 }

 async function execute(ctx,{proposal_id,revision,confirm},opts={}){
  const code=codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision});
  if(code.used)return replay(code.trade_id);
  const p=proposals.row(proposal_id);
  const chain=opts.chain??(p.direction==='yeet'?buyChain:sellChain);
  checkKillSwitch(limits);
  gateFor(chain)(ctx.accountId);
  if(p.status!=='proposed'||p.revision!==revision){const prior=existingTrade(p.id);if(prior)return replay(prior);refuse('CONFIRMATION_REQUIRED','revision is not current')}
  const legs=proposals.legsOf(p.id,revision);
  if(quoteHash(p.id,revision,legs)!==code.quote_sha256)refuse('CONFIRMATION_REQUIRED','quote changed');
  const driver=driverOf(chain),ready=driver.readiness();
  if(!ready.ok)refuse('TEMPORARILY_UNAVAILABLE',`driver ${chain}: ${ready.reasons.join(',')}`);
  const w=await wallets.require(ctx.accountId);
  const total=legs.reduce((a,l)=>a+BigInt(l.amount_in_raw),0n);
  let held;
  if(p.direction==='yeet'){
   const xp=xpTotal(ctx.accountId);checkBasket(limits,legs.map(l=>BigInt(l.amount_in_raw)),capsFor(db,limits,ctx.accountId,now(),xp));
   checkDaily(db,limits,ctx.accountId,now(),total,xp);
   const usdc=usdcOn(chain,catalog);
   const have=chain==='sol'?(await wallets.holdings(w.solana.address)).filter(h=>h.mint===usdc.address).reduce((a,h)=>a+h.raw,0n):await wallets.usdc(w.base.address);
   if(have<total)refuse('BALANCE_LOW');
  }else held=await wallets.holdings(w.solana.address);
  const live=await livePlan({direction:p.direction,legs,w,chain,slippageBps:p.slippage_bps,client,now,catalog});
  assertLivePlan({direction:p.direction,chain,live,legs,w,catalog});
  if(p.direction==='skeet')for(const [i,l] of live.legs.entries()){
   const mint=proposals.mintOf(l.origin.symbol),have=held.filter(h=>h.mint===mint).reduce((a,h)=>a+h.raw,0n);
   if(have<BigInt(legs[i].amount_in_raw))refuse('BALANCE_LOW');
  }
  // Requote rule (plan 2.3 / risk 2), unchanged.
  const previewAge=now()-Math.min(...legs.map(l=>l.quoted_at)),tol=BigInt(limits.requoteToleranceBps);
  const worse=live.legs.some((l,i)=>{const out=BigInt(l.amountOut),est=BigInt(legs[i].dry_out_raw);
   return out<BigInt(legs[i].dry_min_out_raw)||out*10_000n<est*(10_000n-tol)||(previewAge>PREVIEW_STALE_MS&&out<est)});
  if(worse){const r=await requote(ctx,{p,legs,live,confirm});if(r)return r;return replay(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id)}
  checkCost(limits,proposals.legsCost(proposals.legRows(live)));

  const tradeId=newId('t'),t=now();
  const committed=tx(db,()=>{
   if(!codes.consume({code:confirm,tradeId}))return false;
   if(db.prepare("UPDATE proposals SET status='executing',updated_at=? WHERE id=? AND revision=? AND status='proposed'").run(t,p.id,revision).changes!==1)refuse('CONFIRMATION_REQUIRED','proposal changed meanwhile');
   if(p.direction==='yeet'){checkDaily(db,limits,ctx.accountId,t,total,xpTotal(ctx.accountId));recordSpend(db,ctx.accountId,t,total)}
   const receipt={version:1,planId:live.id,direction:live.direction,recipient:live.recipient,refundTo:live.refundTo,planCreatedAt:live.createdAt,
    trackingStartedAt:iso(t),writtenAt:iso(t),complete:false,timedOut:false,legs:[]};
   db.prepare('INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at,receipt_json,result_json,origin_chain) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)')
    .run(tradeId,p.id,revision,ctx.accountId,p.direction,'signing',t,t,JSON.stringify(receipt),chain);
   appendEvent(db,{tradeId,kind:'trade',from:null,to:'signing',evidence:{proposal_id:p.id,revision,plan_id:live.id,legs:live.legs.length,origin_chain:chain,user_signed:true},at:t});
   const ins=db.prepare('INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,receipt_leg_json,updated_at,sign_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
   for(const l of live.legs){
    ins.run(tradeId,l.index,l.symbol,l.amountIn,l.depositAddress,l.depositMemo??null,JSON.stringify(l),'awaiting_signature',JSON.stringify(receiptLeg(l)),t,driver.kind);
    appendEvent(db,{tradeId,legIdx:l.index,kind:'leg',from:null,to:'awaiting_signature',evidence:{amount_in_raw:l.amountIn,deposit_address:l.depositAddress,correlation_id:l.correlationId??null},at:t});
   }
   return true;
  });
  if(!committed)return replay(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id);
  event({event:'trade_committed',trade:tradeId,direction:p.direction,chain,legs:live.legs.length});
  // Sign requests: on Solana one transaction for the whole basket when it fits (one signature), else one per leg; on
  // Base one 7702 batch when eligible, else one per leg. A leg whose request cannot be built never moved funds: not_sent, amount back to the cap.
  const tRow=trade(tradeId);let lastError;
  inFlight.add(tradeId);
  try{
   let made;
   try{made=await prepareAll(tRow,driver,legsOf(tradeId),w[WALLET_CHAIN[chain]].address)}
   catch(e){made=legsOf(tradeId).map(l=>({legs:[l.idx],error:e}))}
   for(const p of made)if(p.error){
    const e=p.error;lastError=e?.code??'TEMPORARILY_UNAVAILABLE';
    for(const i of p.legs){ledger.note(tradeId,`leg ${i}: prepare: ${e?.detail??e?.message}`);ledger.legNotSent(tradeId,i,{reason:lastError,detail:String(e?.detail??e?.message??'').slice(0,160),stage:'prepare'})}
   }
  }finally{inFlight.delete(tradeId)}
  settle(tradeId,lastError);
  try{tracker.refresh(tradeId)}catch(e){ledger.note(tradeId,`refresh: ${e?.message}`)}
  if(!legsOf(tradeId).some(l=>OPEN_LEG.includes(l.send_status)))refuse(lastError??'TEMPORARILY_UNAVAILABLE','no sign request could be issued');
  return answer(tradeId);
 }

 /** submit_trade_signature: the person's signed bytes for one attempt. */
 async function submit(ctx,{trade_id,leg,attempt_id,signed},{dryRun=false}={}){
  const t=owned(ctx,trade_id);
  const a=ledger.attempt(attempt_id);
  if(!a||a.trade_id!==t.id||a.leg_idx!==leg||a.account_id!==ctx.accountId)refuse('INVALID_ARGUMENT','unknown attempt');
  const l=legOf(t.id,leg),d=driverOf(a.chain);
  const wallet=await walletOf(t,a.chain);
  if(wallet!==a.wallet)refuse('INVALID_ARGUMENT','the attempt is for another wallet');
  const covered=ledger.legsOfAttempt(a);
  let r;
  inFlight.add(t.id);
  try{r=await d.submit({trade:t,leg:l,wallet,attemptId:attempt_id,signed,dryRun,now:now()});
   if(r.state==='sent')for(const i of covered)await depositSubmit(t,i)}
  finally{inFlight.delete(t.id)}
  // Sent but not yet landed (Solana answers `pending` after the broadcast): watch this attempt and tell 1Click the
  // moment it lands, instead of on the next tracker pass.
  if(!dryRun&&r.state==='pending'&&r.txHash&&d.recoverAttempt)watchLanding(t,covered,attempt_id,d);
  if(!dryRun){settle(t.id);try{tracker.refresh(t.id)}catch(e){ledger.note(t.id,`refresh: ${e?.message}`)}}
  event({event:'signature_submitted',trade:t.id,leg,attempt:attempt_id.slice(0,12),state:r.state,dry_run:dryRun});
  const fresh=r.state==='expired'?await signRequests(trade(t.id)):[];
  const cur=trade(t.id);
  return {trade_id:t.id,status:cur.status,legs:legsOf(t.id).map(x=>({leg:x.idx,symbol:x.symbol,send_status:x.send_status,tx_hash:['sent','signing'].includes(x.send_status)?x.tx_hash??null:null})),
   ...(fresh.length?{sign_requests:fresh}:{}),...(dryRun?{dry_run:{state:r.state,simulation:r.simulation??null,fee_lamports:r.feeLamports??null,rent_lamports:r.rentLamports??null}}:{})};
 }

 /** Operator cancel: legs still awaiting a signature become not_sent (nothing was signed, nothing can move). A trade
  * with a leg being signed, sent or landed is refused. Refusals are answers, not throws. */
 async function cancel(ctx,tradeId,{reason}={}){
  const t=trade(tradeId);
  if(!t||t.account_id!==ctx.accountId)refuse('INVALID_ARGUMENT','unknown trade');
  const view=extra=>({trade_id:tradeId,status:trade(tradeId).status,legs:legsOf(tradeId).map(l=>({idx:l.idx,symbol:l.symbol,send_status:l.send_status,tx_hash:l.tx_hash??null})),...extra});
  if(inFlight.has(tradeId))return view({cancelled:false,reason:'the trade is being worked on right now; try again in a minute'});
  const legs=legsOf(tradeId);
  if(legs.some(l=>['signing','awaiting_gas','sent','sending'].includes(l.send_status)))return view({cancelled:false,reason:'a leg was signed or sent: it is tracked, never cancelled'});
  const open=legs.filter(l=>l.send_status==='awaiting_signature');
  if(!open.length)return view({cancelled:false,reason:`nothing to cancel (trade ${t.status})`});
  const note=typeof reason==='string'&&reason.trim()?reason.trim().slice(0,200):null;
  for(const l of open)ledger.legNotSent(tradeId,l.idx,{reason:'operator cancel: never signed',operator_note:note,stage:'cancel'});
  settle(tradeId);
  try{tracker.refresh(tradeId)}catch{}
  return view({cancelled:true});
 }

 let prices={at:0,bySymbol:new Map()};
 async function priceMap(){
  if(now()-prices.at<PRICE_TTL_MS)return prices.bySymbol;
  try{const tokens=await client.getTokens(),bySymbol=new Map();
   for(const e of catalog){const t=tokens.find(t=>t.assetId===e.assetId);if(t&&typeof t.price==='number'&&Number.isFinite(t.price))bySymbol.set(e.symbol,t.price)}
   prices={at:now(),bySymbol}}catch{}
  return prices.bySymbol;
 }
 const solUsdc=async owner=>{const m=usdcOn('sol',catalog)?.address;return (await wallets.holdings(owner)).filter(h=>h.mint===m).reduce((a,h)=>a+h.raw,0n)};

 return {
  limits,wallets,proposals,tracker,codes,ledger,drivers,buyChain,sellChain,catalog,
  /** The 1Click client (dry quotes for the lucky wheel's coin availability, core/xp/availability.mjs). */
  client,
  /** The proposal a trade of the account came from (the lucky wheel's claim, core.mjs). */
  proposalOf:(ctx,id)=>owned(ctx,id).proposal_id,
  execute,submit,cancel,landings:()=>Promise.allSettled([...watches.values()]),landingWatches:()=>watches.size,signRequests:async(ctx,id)=>signRequests(owned(ctx,id)),recoverTrade,
  /** The first-party signing page: the trade's legs and its open sign requests, for the account's own trade only.
   * Recovery runs first (as a replayed code does), so a paused system, a closed sign window or a near deadline ends
   * the leg as not_sent instead of issuing a request. */
  async pageRequests(ctx,id){
   const t=owned(ctx,id);
   await recoverTrade(t.id);
   const cur=trade(t.id),sign_requests=await signRequests(cur);
   return {trade_id:cur.id,direction:cur.direction,status:cur.status,legs:legsOf(cur.id).map(l=>({leg:l.idx,symbol:l.symbol,send_status:l.send_status})),sign_requests};
  },
  /** driver-interface recover over every driver (ops). */
  async recover(){const out=[];for(const d of Object.values(drivers))out.push(...await d.recover({now:now()}));return out},
  propose:(ctx,body)=>proposals.propose(ctx,body),
  skeet:(ctx,body)=>proposals.skeet(ctx,body),
  quote:(ctx,body)=>proposals.quote(ctx,body),
  status:(ctx,id)=>tracker.status(ctx,id),
  /** yeet_home: wallets and readiness (no signer state: the person's own wallet signs). */
  async home(ctx){
   const w=await wallets.require(ctx.accountId,{refresh:true});
   let usdc=null,funding=null;
   try{usdc=await wallets.usdc(w.base.address)}catch{}
   try{funding=buyChain==='sol'?await solUsdc(w.solana.address):usdc}catch{}
   const r=drivers[buyChain]?.readiness?.()??{ok:false};
   const ready=limits.killSwitch||!limits.live||!accountLive(limits,ctx.accountId)||!r.ok?'paused':funding!==null&&funding<limits.minLegRaw?'needs_funds':'ready';
   return {wallets:{base:{address:w.base.address,usdc:usdc===null?null:usd(formatUnits(usdc,6))},solana:{address:w.solana.address}},ready,xp:null,recent_wins:[],limits:capsView(capsFor(db,limits,ctx.accountId,now(),xpTotal(ctx.accountId)))};
  },
  /** yeet_portfolio: catalogue coins held on Solana (USDC on Solana included), USDC on Base. */
  async portfolio(ctx){
   const w=await wallets.require(ctx.accountId);
   const [held,usdc,px]=await Promise.all([wallets.holdings(w.solana.address),wallets.usdc(w.base.address).catch(()=>null),priceMap()]);
   const holdings=[];
   for(const e of catalog.filter(e=>e.chain==='solana'&&e.kind!=='funding'&&e.address)){
    const raw=held.filter(h=>h.mint===e.address).reduce((a,h)=>a+h.raw,0n);
    if(raw<=0n)continue;
    const amount=formatUnits(raw,e.decimals),p=px.get(e.symbol);
    holdings.push({symbol:e.symbol,amount,usd:p===undefined?null:usd((Number(amount)*p).toFixed(6))});
   }
   const top=holdings.slice(0,25),priced=top.every(h=>h.usd!==null)&&usdc!==null;
   const total=priced?usd((top.reduce((a,h)=>a+Number(h.usd),0)+Number(formatUnits(usdc,6))).toFixed(6)):null;
   return {solana:{address:w.solana.address,holdings:top},base:{address:w.base.address,usdc:usdc===null?null:usd(formatUnits(usdc,6))},total_usd:total,priced_at:iso(now())};
  },
 };
}

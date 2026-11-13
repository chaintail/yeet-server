// execute_trade, at the person's tap (port plan section 3):
//  1. the confirm code: bound to account, client, proposal, revision and quote; single use; a used code replays its trade
//  2. kill switch and YEET_LIVE (unset: TRADING_PAUSED, the code stays unused)
//  3. signer state and balance through the wallet adapter
//  4. live plan through the router with dry:false (one deposit address per leg)
//  5. the live plan is checked leg by leg against the proposal and the person's own wallets (assertLivePlan); any
//     mismatch refuses the whole trade before anything is committed or signed
//  6. REQUOTE when a live leg's amountOut is more than YEET_REQUOTE_TOLERANCE_BPS (default 50) under the previewed
//     estimate or under the preview's min_out, or the preview is over 60 s old and a live leg is under the estimate:
//     the code is used, a new revision is stored and a new code goes to `_meta`
//  7. one transfer per leg for the exact amountIn through the signer, then 1Click submitDeposit. A sponsored Base send
//     answers a Privy transaction id before the chain hash: the leg is `sent` (hash pending), never sent again, and
//     recovery resolves the hash by GET /v1/transactions/{id} on later ticks
//  8. persist trade and legs, answer `submitted` inside the time budget; the tracker takes over
import {buildYeetPlan,buildSkeetPlan,formatUnits,FUNDING,CATALOG,isEvmAddress,isSolanaAddress} from './router.mjs';
import {checkKillSwitch,checkBasket,checkDaily,checkCost,recordSpend} from './limits.mjs';
import {routed,quoteHash} from './proposals.mjs';
import {receiptLeg} from './tracker.mjs';
import {legIdempotencyKey,USDC_BASE} from './signer.mjs';
import {refuse,newId,iso,TradeError} from './util.mjs';
import {tx} from './db.mjs';
import {transitionLeg,appendEvent,recordLegEvent,recordLegHash} from './audit.mjs';
import {USDC_KEY} from './accounting.mjs';

export const PREVIEW_STALE_MS=60_000;
export const EXECUTE_BUDGET_MS=20_000;
const explorer=(direction,hash)=>hash?(direction==='yeet'?`https://basescan.org/tx/${hash}`:`https://solscan.io/tx/${hash}`):null;

/** No transfer is started or re-issued when the leg's 1Click deposit deadline is closer than this. */
export const SEND_MARGIN_MS=120_000;
/** A leg left `sending` is re-issued (same idempotency key) at most this often. */
export const RESEND_AFTER_MS=15_000;
/** After a cached Privy 5xx, a new idempotency key is used only when a reference_id lookup at least this long after the
 * 5xx finds no transaction: Privy never accepted the request. */
export const REKEY_AFTER_MS=60_000;
/** At most this many keys after the first; then the leg stays `sending` (spent) and is only looked up. */
export const MAX_KEY_GENERATION=2;
const TX_HASH=/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,90})$/;
const codeOf=e=>e instanceof TradeError?e.code:'TEMPORARILY_UNAVAILABLE';
/** execute_trade leg status (contract enum sent|failed|not_sent): an attempted transfer that is not confirmed yet may
 * have moved funds, so it is reported as sent (without a hash), never as failed. */
const ANSWER_STATUS={queued:'not_sent',sending:'sent',sent:'sent',failed:'failed',not_sent:'not_sent'};

const SOLANA_ZERO='11111111111111111111111111111111';// the all-zero key (also the System Program)
const EVM_ZERO='0x'+'0'.repeat(40);
const sameAddress=(chain,a,b)=>typeof a==='string'&&typeof b==='string'&&(chain==='base'?a.toLowerCase()===b.toLowerCase():a===b);

/**
 * The live plan must be exactly what the person approved, sent to 1Click and nowhere else (review M2/M3). Per leg:
 * same coin and order, origin asset USDC on Base (YEET) or the coin on Solana (SKEET), live amountIn equal to the
 * proposal's amount_in_raw, destination the coin (YEET) or USDC on Base (SKEET), recipient the person's own wallet on
 * the destination chain, refund address their own origin-chain wallet, and a well-formed deposit address on the origin
 * chain that is not one of their wallets, not the token contract or mint, not the zero address and not shared with
 * another leg. Any mismatch is TEMPORARILY_UNAVAILABLE, logged with the 1Click correlationId; nothing is signed.
 */
export function assertLivePlan({direction,live,legs,w,log=console.error}){
 const fail=(why,l)=>{
  log(JSON.stringify({event:'trade_plan_refused',reason:why,leg:l?.index??null,symbol:l?.symbol??null,correlationId:l?.correlationId??null}));
  refuse('TEMPORARILY_UNAVAILABLE',`live plan: ${why}`);
 };
 const origin=direction==='yeet'?'base':'solana',dest=direction==='yeet'?'solana':'base';
 if(live?.direction!==undefined&&live.direction!==direction)fail('direction');
 if(!Array.isArray(live?.legs)||live.legs.length!==legs.length||!legs.length)fail('leg count');
 if(!sameAddress(dest,live.recipient,w[dest].address))fail('recipient is not the own wallet');
 if(!sameAddress(origin,live.refundTo,w[origin].address))fail('refund address is not the own wallet');
 const seen=new Set();
 for(const [i,l] of live.legs.entries()){
  const p=legs[i];
  if(l.index!==i||l.symbol!==p.symbol)fail('leg order or coin',l);
  if(l.amountIn!==p.amount_in_raw)fail('amountIn differs from the proposal',l);
  const coin=CATALOG.find(c=>c.assetId===p.asset_id&&c.chain==='solana');
  if(!coin)fail('coin not in catalogue',l);
  const [wantOrigin,wantDest]=direction==='yeet'?[FUNDING.assetId,p.asset_id]:[p.asset_id,FUNDING.assetId];
  if(l.origin?.assetId!==wantOrigin)fail('origin asset',l);
  if(l.destination?.assetId!==wantDest)fail('destination asset',l);
  const dep=l.depositAddress;
  if(typeof dep!=='string'||!(origin==='base'?isEvmAddress(dep):isSolanaAddress(dep)))fail('deposit address malformed',l);
  const forbidden=origin==='base'?[w.base.address,USDC_BASE,EVM_ZERO]:[w.solana.address,coin.address,SOLANA_ZERO];
  if(forbidden.some(a=>sameAddress(origin,dep,a))||dep===w.solana.address||sameAddress('base',dep,w.base.address))fail('deposit address is a known non-deposit address',l);
  const key=origin==='base'?dep.toLowerCase():dep;
  if(seen.has(key))fail('deposit address repeated',l);
  seen.add(key);
 }
}

export function createExecutor({db,client,limits,wallets,signer,codes,proposals,tracker,accounting,now=Date.now,budgetMs=EXECUTE_BUDGET_MS,hooks={}}){
 const trade=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
 const legOf=(id,idx)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? AND idx=?').get(id,idx);
 const deps=()=>({client,now:()=>new Date(now())});
 /** Trades whose legs this process is sending right now; recovery leaves them alone. */
 const inFlight=new Set();
 const note=(tradeId,message)=>db.prepare('UPDATE trades SET last_error=? WHERE id=?').run(String(message).slice(0,300),tradeId);

 /**
  * Before anything is signed: the YEET signer is attached to the wallet, and (delegated) its signer entry carries
  * exactly the policy configured for the chain (YEET_BASE_POLICY_ID / YEET_SOLANA_POLICY_ID). A signer attached with
  * no policy, another policy or several is refused: Privy would apply no limit or other limits. Custodial wallets have
  * no signer entry (the YEET key owns them), so only the grant is checked there.
  */
 function requireSigner(w,chain){
  if(w[chain].signerState!=='granted'||!w[chain].walletId)refuse('WALLET_NOT_READY',`${chain} signer not granted`);
  if(signer.kind==='custodial')return;
  const want=chain==='base'?limits.basePolicyId:limits.solanaPolicyId;
  if(!want)refuse('WALLET_NOT_READY',`${chain} policy not configured`);
  if(w[chain].policyId!==want)refuse('WALLET_NOT_READY',`${chain} signer policy is not the configured one`);
 }

 /** The execute_trade answer for a stored trade (also what a replayed code gets). */
 function answer(tradeId){
  const t=trade(tradeId);
  if(!t)refuse('TEMPORARILY_UNAVAILABLE','trade missing');
  if(t.result_json){const r=JSON.parse(t.result_json);if(r.error)throw new TradeError(r.error,'replayed failure');return r}
  return {trade_id:t.id,proposal_id:t.proposal_id,direction:t.direction,status:'submitted',
   legs:legsOf(t.id).map(l=>({symbol:l.symbol,deposit_address:l.deposit_address,tx_hash:l.tx_hash??null,explorer_url:explorer(t.direction,l.tx_hash),status:ANSWER_STATUS[l.send_status]}))};
 }

 /** A leg that never moved funds (`failed`: the signer says nothing was broadcast; `not_sent`: never attempted) goes
  * back to the daily cap, once: the state change, its audit row and the refund are one transaction. */
 function release(t,idx,state,evidence){
  return tx(db,()=>{
   const l=legOf(t.id,idx);
   if(!l||!['queued','sending'].includes(l.send_status))return false;
   if(!transitionLeg(db,{tradeId:t.id,idx,from:l.send_status,to:state,evidence,set:{updated_at:now()},at:now()}))return false;
   if(t.direction==='yeet')recordSpend(db,t.account_id,t.created_at,-BigInt(l.amount_in_raw));
   return true;
  });
 }
 /** The signer call for a leg; throws before anything is broadcast when the call cannot be built. */
 function prepare(t,l,wallet,held){
  const q=JSON.parse(l.live_quote_json);
  const common={walletId:wallet.walletId,amountRaw:l.amount_in_raw,idempotencyKey:l.idempotency_key,referenceId:legIdempotencyKey(wallet.walletId,t.id,l.idx,0),
   request:l.send_request??undefined,persistRequest:body=>persistRequest(t.id,l.idx,body)};
  if(t.direction==='yeet')return ()=>signer.transferUsdcBase({...common,from:wallet.address,to:l.deposit_address});
  const mint=proposals.mintOf(q.origin.symbol),src=held?.find(h=>h.mint===mint);
  if(!src&&!l.send_request)refuse('BALANCE_LOW','token account not found');
  return ()=>signer.transferSpl({...common,owner:wallet.address,source:src?.tokenAccount,destinationOwner:l.deposit_address,mint,decimals:q.origin.decimals,tokenProgram:src?.tokenProgram});
 }
 /** The exact request body, stored before its first send; a retry sends it again instead of building a new one. */
 function persistRequest(tradeId,idx,body){
  if(db.prepare('UPDATE trade_legs SET send_request=? WHERE trade_id=? AND idx=? AND send_request IS NULL').run(body,tradeId,idx).changes===1)return;
  if(legOf(tradeId,idx)?.send_request!==body)throw Error('a different request is already stored for this leg');
 }
 /** The leg's reference_id, from its stored request; null when no request was ever stored (so none was sent). */
 const referenceOf=l=>{try{const r=JSON.parse(l.send_request)?.reference_id;return typeof r==='string'?r:null}catch{return null}};
 const chainOf=t=>t.direction==='yeet'?'base':'solana';
 /** One Privy lookup by reference_id for a `sending` leg; null when no lookup is possible or it failed. */
 async function privyLookup(t,l){
  const referenceId=referenceOf(l);
  if(!referenceId||typeof signer.lookupTransfer!=='function')return null;
  try{return await signer.lookupTransfer({chain:chainOf(t),referenceId})}
  catch(e){note(t.id,`leg ${l.idx}: Privy lookup: ${e?.detail??e?.message}`);return null}
 }
 /** A Privy lookup that found the transfer: sent (with or without its hash yet), or failed with nothing moved. */
 async function applyFound(t,idx,found,source){
  if(found.state==='failed'){release(t,idx,'failed',{reason:'Privy reports the transfer failed',privy_transaction_id:found.transactionId,privy_status:found.status,source});return 'TEMPORARILY_UNAVAILABLE'}
  return adopt(t,idx,{txHash:found.txHash,transactionId:found.transactionId},source);
 }
 /** sending -> sent from a signer answer or a lookup: the chain hash, or a Privy transaction id with the hash pending. */
 async function adopt(t,idx,{txHash,transactionId},source){
  const hash=typeof txHash==='string'&&TX_HASH.test(txHash)?txHash:null,id=typeof transactionId==='string'&&transactionId?transactionId:null;
  if(!hash&&!id){note(t.id,`leg ${idx}: signer answered no hash`);return 'TEMPORARILY_UNAVAILABLE'}
  const evidence={source,...(hash?{tx_hash:hash}:{hash_pending:true}),...(id?{privy_transaction_id:id}:{})};
  transitionLeg(db,{tradeId:t.id,idx,from:'sending',to:'sent',evidence,set:{tx_hash:hash,privy_tx_id:id,cached_failure_at:null,updated_at:now()},at:now()});
  if(hash)await submit(t,idx);
 }
 /** A `sent` leg with a Privy transaction id and no hash: one GET /v1/transactions/{id} per recovery pass. */
 async function resolveHash(t,l){
  if(typeof signer.lookupTransfer!=='function')return;
  let r;
  try{r=await signer.lookupTransfer({chain:chainOf(t),transactionId:l.privy_tx_id})}
  catch(e){note(t.id,`leg ${l.idx}: Privy transaction: ${e?.detail??e?.message}`);return}
  if(r?.state==='confirmed'&&TX_HASH.test(r.txHash??''))
   recordLegHash(db,{tradeId:t.id,idx:l.idx,txHash:r.txHash,evidence:{privy_transaction_id:l.privy_tx_id,privy_status:r.status,source:'privy_transaction'},at:now()});
  else if(r?.state==='failed')note(t.id,`leg ${l.idx}: Privy reports transaction ${l.privy_tx_id} ${r.status}`);
 }
 /** A new idempotency key for a leg whose key holds a cached 5xx, after a lookup found no transaction under its
  * reference_id; the stored request is sent again unchanged. False when the leg or its wallet changed meanwhile. */
 function rekey(t,l,wallet){
  const gen=l.key_generation;
  if(l.idempotency_key!==legIdempotencyKey(wallet.walletId,t.id,l.idx,gen)){note(t.id,`leg ${l.idx}: wallet changed since the first attempt, not re-issued`);return false}
  const key=legIdempotencyKey(wallet.walletId,t.id,l.idx,gen+1);
  return tx(db,()=>{
   if(db.prepare("UPDATE trade_legs SET idempotency_key=?,key_generation=?,cached_failure_at=NULL,updated_at=? WHERE trade_id=? AND idx=? AND send_status='sending' AND key_generation=? AND cached_failure_at IS NOT NULL")
    .run(key,gen+1,now(),t.id,l.idx,gen).changes!==1)return false;
   recordLegEvent(db,{tradeId:t.id,idx:l.idx,status:'sending',evidence:{reason:'Privy 5xx cached on the key; no transaction under the reference',reference_id:referenceOf(l),
    failed_at:iso(l.cached_failure_at),key_generation:gen+1,idempotency_key:key},at:now()});
   return true;
  });
 }
 /**
  * One transfer attempt for a `queued` leg, or a re-issue of a `sending` leg with its stored idempotency key. The leg is
  * `sending` (key stored) before the signer is called. Only a first attempt the signer refuses with `notSent` becomes
  * `failed`; any other failure (timeout, missing hash, crash) leaves the leg `sending`, still counted as spent.
  * Returns the catalogue code of a failure, or undefined.
  */
 async function attempt(t,idx,wallet,held){
  const l=legOf(t.id,idx),key=legIdempotencyKey(wallet.walletId,t.id,idx,0);
  if(l.send_status==='queued'){
   let call;
   try{call=prepare(t,{...l,idempotency_key:key},wallet,held)}catch(e){release(t,idx,'failed',{reason:codeOf(e),stage:'prepare'});return codeOf(e)}
   if(!transitionLeg(db,{tradeId:t.id,idx,from:'queued',to:'sending',evidence:{idempotency_key:key},set:{idempotency_key:key,send_attempts:l.send_attempts+1,updated_at:now()},at:now()}))return;
   return finish(t,idx,call,true);
  }
  if(l.send_status!=='sending')return;
  // A key that answered a 5xx holds that 5xx for 24 h: it is never sent again (recover() looks up, then rekeys).
  if(l.cached_failure_at!==null)return;
  if(l.idempotency_key!==legIdempotencyKey(wallet.walletId,t.id,idx,l.key_generation)){note(t.id,`leg ${idx}: wallet changed since the first attempt, not re-issued`);return}
  let call;
  try{call=prepare(t,l,wallet,held)}catch(e){note(t.id,`leg ${idx}: ${e?.detail??e?.message}`);return codeOf(e)}
  db.prepare('UPDATE trade_legs SET send_attempts=send_attempts+1,updated_at=? WHERE trade_id=? AND idx=?').run(now(),t.id,idx);
  return finish(t,idx,call,false);
 }
 async function finish(t,idx,call,first){
  let res;
  try{res=await call()}
  catch(e){
   // A re-issue's refusal says nothing about the first attempt, so only a first attempt can be released.
   if(first&&e?.notSent===true){release(t,idx,'failed',{reason:codeOf(e),stage:'signer',not_sent:true});return codeOf(e)}
   note(t.id,`leg ${idx}: ${e?.detail??e?.message??'send not confirmed'}${e?.privyStatus?` (Privy ${e.privyStatus})`:''}`);
   if(e?.cachedFailure){
    // Privy caches a 5xx on /rpc against the key: this key is spent. Look the transfer up before deciding anything.
    db.prepare("UPDATE trade_legs SET cached_failure_at=?,updated_at=? WHERE trade_id=? AND idx=? AND send_status='sending'").run(now(),now(),t.id,idx);
    const found=await privyLookup(t,legOf(t.id,idx));
    if(found&&found.state!=='none')return applyFound(t,idx,found,'privy_reference');
   }
   return codeOf(e);
  }
  return adopt(t,idx,res??{},'signer');
 }
 /** 1Click /deposit/submit for a sent leg, until accepted; not needed once 1Click has found the deposit itself. */
 async function submit(t,idx){
  const l=legOf(t.id,idx);
  if(l.send_status!=='sent'||l.deposit_submitted)return;
  const done=()=>db.prepare('UPDATE trade_legs SET deposit_submitted=1 WHERE trade_id=? AND idx=?').run(t.id,idx);
  if(l.oneclick_status&&l.oneclick_status!=='PENDING_DEPOSIT'){done();return}
  if(!l.tx_hash)return;
  try{tracker.apply(t.id,idx,await client.submitDeposit(l.deposit_address,l.tx_hash,l.deposit_memo??undefined));done()}
  catch(e){note(t.id,`leg ${idx}: deposit/submit: ${e?.message}`)}
 }
 /** A `sending` leg 1Click already sees a deposit for is sent (the deposit address is unique to this leg). */
 async function lookup(t,l){
  let st;
  try{st=await client.status(l.deposit_address,l.deposit_memo??undefined)}catch(e){note(t.id,`leg ${l.idx}: status: ${e?.message}`);return false}
  if(!st?.status||st.status==='PENDING_DEPOSIT')return false;
  const hash=(st.swapDetails?.originChainTxHashes??[]).map(h=>h?.hash).find(h=>typeof h==='string'&&TX_HASH.test(h))??null;
  const txHash=l.tx_hash??hash;
  transitionLeg(db,{tradeId:t.id,idx:l.idx,from:'sending',to:'sent',evidence:{tx_hash:txHash,oneclick_status:st.status,correlation_id:st.correlationId??null,source:'1click_status'},
   set:{tx_hash:txHash,deposit_submitted:1,updated_at:now()},at:now()});
  tracker.apply(t.id,l.idx,st);
  return true;
 }
 /** Once no leg is queued or sending: the proposal's final status, and the stored failure when nothing was sent. */
 function settle(tradeId,lastError){
  const t=trade(tradeId),legs=legsOf(tradeId);
  if(legs.some(l=>l.send_status==='queued'||l.send_status==='sending'))return;
  const anySent=legs.some(l=>l.send_status==='sent');
  db.prepare("UPDATE proposals SET status=?,updated_at=? WHERE id=? AND status='executing'").run(anySent?'executed':'failed',now(),t.proposal_id);
  if(!anySent&&!t.result_json)db.prepare('UPDATE trades SET result_json=? WHERE id=?').run(JSON.stringify({error:lastError??'TEMPORARILY_UNAVAILABLE'}),tradeId);
 }

 /**
  * Recovery for one trade, run by the tracker on start and every tick (and before a replayed code is answered), for
  * a trade no send loop in this process is working on (after a crash or restart):
  *  - `queued` legs (never attempted): sent while the deposit deadline is more than SEND_MARGIN_MS away, otherwise
  *    `not_sent` with the amount back to the daily cap;
  *  - `sending` legs: looked up at 1Click by deposit address, else re-issued with the same idempotency key while the
  *    deadline is open; past it they stay `sending` (counted as spent) until 1Click or the tracker horizon resolves them;
  *  - sent legs whose deposit/submit failed are submitted again.
  * With the kill switch on or YEET_LIVE unset, `queued` legs become `not_sent` (amount back to the cap) and `sending`
  * legs are only looked up, never re-issued.
  */
 async function recover(tradeId){
  if(inFlight.has(tradeId))return false;
  const t=trade(tradeId);if(!t)return false;
  const open=legsOf(tradeId).filter(l=>l.send_status==='queued'||l.send_status==='sending'||(l.send_status==='sent'&&(!l.deposit_submitted||(!l.tx_hash&&l.privy_tx_id))));
  if(!open.length)return false;
  inFlight.add(tradeId);
  try{
   let ctx;
   const walletCtx=async()=>{
    if(ctx)return ctx;
    const w=await wallets.require(t.account_id,{refresh:!signer.directory.stable});
    requireSigner(w,chainOf(t));
    const wallet=w[chainOf(t)];
    return ctx={wallet,held:t.direction==='skeet'?await wallets.holdings(wallet.address):undefined};
   };
   // Kill switch or YEET_LIVE unset: nothing new is sent or re-issued; legs already sent are still tracked.
   const paused=limits.killSwitch||!limits.live;
   for(const l of open){
    if(l.send_status==='sent'){
     // Sent, hash pending: Privy accepted it (transaction id stored); the hash is looked up, the transfer never re-sent.
     if(!l.tx_hash&&l.privy_tx_id)await resolveHash(t,l);
     await submit(t,l.idx);continue;
    }
    const deadline=Date.parse(JSON.parse(l.live_quote_json).deadline);
    if(l.send_status==='queued'){
     if(paused){release(t,l.idx,'not_sent',{reason:'trading paused',kill_switch:limits.killSwitch,live:limits.live});continue}
     if(!(now()+SEND_MARGIN_MS<deadline)){release(t,l.idx,'not_sent',{reason:'deposit deadline too close',deadline:iso(deadline)});continue}
     try{const {wallet,held}=await walletCtx();await attempt(t,l.idx,wallet,held)}
     catch(e){note(tradeId,`leg ${l.idx}: ${e?.detail??e?.message}`)}// stays queued; retried next tick
     continue;
    }
    if(await lookup(t,l))continue;
    // Privy by reference_id: a transfer it accepted under any key of this leg is adopted, never sent again.
    const found=await privyLookup(t,l);
    if(found&&found.state!=='none'){await applyFound(t,l.idx,found,'privy_reference');continue}
    if(paused)continue;// stays `sending` (spent) until 1Click or the tracker horizon resolves it
    // Never re-issue towards an address that may be inactive: the leg stays `sending` (spent) until 1Click or the
    // tracker's horizon resolves it.
    if(!(now()+SEND_MARGIN_MS<deadline))continue;
    if(now()-l.updated_at<RESEND_AFTER_MS)continue;
    let wallet,held;
    try{({wallet,held}=await walletCtx())}catch(e){note(tradeId,`leg ${l.idx}: ${e?.detail??e?.message}`);continue}
    if(l.cached_failure_at!==null){
     // The key holds a cached 5xx. A new key only when a lookup answered (found === none) at least REKEY_AFTER_MS
     // after the 5xx; with no answer, or after MAX_KEY_GENERATION keys, the leg is only looked up.
     if(found?.state!=='none'||now()-l.cached_failure_at<REKEY_AFTER_MS)continue;
     if(l.key_generation>=MAX_KEY_GENERATION){note(tradeId,`leg ${l.idx}: Privy 5xx on ${l.key_generation+1} keys; only looked up from now on`);continue}
     if(!rekey(t,l,wallet))continue;
    }
    await attempt(t,l.idx,wallet,held);
   }
   settle(tradeId);
  }finally{inFlight.delete(tradeId)}
  try{tracker.refresh(tradeId)}catch(e){note(tradeId,`refresh: ${e?.message}`)}
  return true;
 }
 /** A used code's answer: the trade's true current state, after recovery when its send loop is not running. */
 async function replay(tradeId){
  const t=trade(tradeId);
  if(t&&t.status==='signing')await recover(tradeId);
  return answer(tradeId);
 }
 const existingTrade=(proposalId)=>db.prepare("SELECT id FROM trades WHERE proposal_id=? AND status<>'requote_required' ORDER BY created_at DESC LIMIT 1").get(proposalId)?.id;

 async function livePlan(p,legs,w){
  if(p.direction==='yeet')
   return routed(()=>buildYeetPlan({amountUsdc:formatUnits(legs.reduce((a,l)=>a+BigInt(l.amount_in_raw),0n),6),
    legs:legs.map(l=>({symbol:l.symbol,parts:l.parts})),recipientSol:w.solana.address,refundBase:w.base.address,slippageBps:p.slippage_bps,dry:false},deps()));
  return routed(()=>buildSkeetPlan({legs:legs.map(l=>({symbol:l.symbol,amount:l.amount_in})),recipientBase:w.base.address,refundSol:w.solana.address,slippageBps:p.slippage_bps,dry:false},deps()));
 }

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
  return {...result,confirm:proposals.mint(fresh,revision,ctx.accountId,ctx.clientId,{rateLimited:false})};// follows a used code: no amplification
 }

 return {
  answer,recover,
  async execute(ctx,{proposal_id,revision,confirm}){
   const started=now();
   const code=codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision});
   if(code.used)return replay(code.trade_id);
   checkKillSwitch(limits);
   if(!limits.live)refuse('TRADING_PAUSED','YEET_LIVE is not set');
   const p=proposals.row(proposal_id);
   if(p.status!=='proposed'||p.revision!==revision){const prior=existingTrade(p.id);if(prior)return replay(prior);refuse('CONFIRMATION_REQUIRED','revision is not current')}
   const legs=proposals.legsOf(p.id,revision);
   if(quoteHash(p.id,revision,legs)!==code.quote_sha256)refuse('CONFIRMATION_REQUIRED','quote changed');
   const w=await wallets.require(ctx.accountId,{refresh:!signer.directory.stable});
   const chain=p.direction==='yeet'?'base':'solana';
   requireSigner(w,chain);
   const total=legs.reduce((a,l)=>a+BigInt(l.amount_in_raw),0n);
   let held;
   if(p.direction==='yeet'){
    checkBasket(limits,legs.map(l=>BigInt(l.amount_in_raw)));
    checkDaily(db,limits,ctx.accountId,now(),total);
    if(await wallets.usdc(w.base.address)<total)refuse('BALANCE_LOW');
   }else{
    held=await wallets.holdings(w.solana.address);
   }
   const live=await livePlan(p,legs,w);
   assertLivePlan({direction:p.direction,live,legs,w});
   if(p.direction==='skeet'){
    for(const [i,l] of live.legs.entries()){
     const src=held.find(h=>h.mint===proposals.mintOf(l.origin.symbol));
     if(!src||src.raw<BigInt(legs[i].amount_in_raw))refuse('BALANCE_LOW');
    }
   }
   // Requote rule (plan 2.3 / risk 2).
   const previewAge=now()-Math.min(...legs.map(l=>l.quoted_at));
   const tol=BigInt(limits.requoteToleranceBps);
   const worse=live.legs.some((l,i)=>{
    const out=BigInt(l.amountOut),est=BigInt(legs[i].dry_out_raw);
    return out<BigInt(legs[i].dry_min_out_raw)||out*10_000n<est*(10_000n-tol)||(previewAge>PREVIEW_STALE_MS&&out<est);
   });
   if(worse){
    const r=await requote(ctx,{p,legs,live,confirm});
    if(r)return r;
    return replay(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id);
   }
   checkCost(limits,proposals.legsCost(proposals.legRows(live)));
   // Source balance before anything is signed (accounting.mjs); a failed read never blocks the trade.
   const legAssets=Object.fromEntries(live.legs.map(l=>[l.index,p.direction==='yeet'?USDC_KEY:proposals.mintOf(l.origin.symbol)]));
   const snapshot=accounting?await accounting.readBefore({chain,address:w[chain].address,legAssets}):null;

   // Commit: the code, the proposal, the trade and its legs, and today's spend, in one transaction.
   const tradeId=newId('t'),t=now();
   const committed=tx(db,()=>{
    if(!codes.consume({code:confirm,tradeId}))return false;
    if(db.prepare("UPDATE proposals SET status='executing',updated_at=? WHERE id=? AND revision=? AND status='proposed'").run(t,p.id,revision).changes!==1)refuse('CONFIRMATION_REQUIRED','proposal changed meanwhile');
    if(p.direction==='yeet'){checkDaily(db,limits,ctx.accountId,t,total);recordSpend(db,ctx.accountId,t,total)}
    const receipt={version:1,planId:live.id,direction:live.direction,recipient:live.recipient,refundTo:live.refundTo,planCreatedAt:live.createdAt,
     trackingStartedAt:iso(t),writtenAt:iso(t),complete:false,timedOut:false,legs:[]};
    db.prepare('INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at,receipt_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,NULL)')
     .run(tradeId,p.id,revision,ctx.accountId,p.direction,'signing',t,t,JSON.stringify(receipt));
    appendEvent(db,{tradeId,kind:'trade',from:null,to:'signing',evidence:{proposal_id:p.id,revision,plan_id:live.id,legs:live.legs.length},at:t});
    const ins=db.prepare('INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)');
    for(const l of live.legs){
     ins.run(tradeId,l.index,l.symbol,l.amountIn,l.depositAddress,l.depositMemo??null,JSON.stringify(l),'queued',JSON.stringify(receiptLeg(l)),t);
     appendEvent(db,{tradeId,legIdx:l.index,kind:'leg',from:null,to:'queued',evidence:{amount_in_raw:l.amountIn,deposit_address:l.depositAddress,correlation_id:l.correlationId??null},at:t});
    }
    if(snapshot)accounting.recordSnapshot(tradeId,snapshot);
    return true;
   });
   if(!committed)return replay(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id);

   // Send: one exact transfer per leg, in order, within the time budget. A failed leg does not stop the others.
   const tRow=trade(tradeId);
   let lastError;
   inFlight.add(tradeId);
   try{
    await hooks.afterCommit?.(tradeId);
    for(const l of live.legs){
     if(now()-started>budgetMs)break;
     const failed=await attempt(tRow,l.index,w[chain],held);
     if(failed)lastError=failed;
    }
    // Legs the budget left unattempted never moved funds.
    for(const l of legsOf(tradeId))if(l.send_status==='queued')release(tRow,l.idx,'not_sent',{reason:'execute time budget spent'});
   }finally{inFlight.delete(tradeId)}
   settle(tradeId,lastError);
   try{tracker.refresh(tradeId)}catch(e){note(tradeId,`refresh: ${e?.message}`)}
   if(!legsOf(tradeId).some(l=>l.send_status==='sent'||l.send_status==='sending'))refuse(lastError??'TEMPORARILY_UNAVAILABLE','no leg was sent');
   return answer(tradeId);
  },
 };

}

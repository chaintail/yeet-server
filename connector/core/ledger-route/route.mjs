// The ledger route (docs/LEDGER-ROUTE.md): a trade settles INSIDE the NEAR Intents ledger (`intents.near`). The
// person's USDC and coins sit in their own ledger account (the account their Privy Solana key owns); a trade is ONE
// message they approve (`token_diff`: what they give, the least they receive); our solver sources the coins just in
// time and one `execute_intents` settles the person's message and the solver's together, or nothing moves.
// The server holds no key of the person: it can only settle the exact message they approved, against our solver.
//
// The pipeline (pipeline/pipeline.mjs) keeps everything it had: confirm codes, proposals, caps, the kill switch, the
// trade and leg rows, the tracker and the receipt. This module answers, for a trade on the ledger route:
//   livePlan      firm sourcing quotes (1Click with the ledger on both sides, our solver as the account) in the shape
//                 of the chain route's live plan, so proposals, the requote rule and the receipt work unchanged
//   commit        the route's own row (ledger_trade), written in the pipeline's commit transaction
//   driver        prepareLegs: the one message for the whole basket (one request, one approval)
//   signRequests  the open request, renewed while the trade's window allows
//   submit        the person's approval: checked locally, simulated alone, stored; the run starts
//   run           buy: source, settle. sell: settle (the solver pays at once), unload, pass the surplus on
//   recover       a window that closed, a run a restart interrupted
//   tick          resumes runs and sells leftover solver inventory (capped)
// States of ledger_trade: awaiting_approval -> running -> settled | not_executed, with `unloading` after a settled
// sell. Leg states are the pipeline's own: awaiting_signature -> signing -> sent | failed, or not_sent.
import {createHash} from 'node:crypto';
import {ed25519AccountId,rawEd25519Payload,intentHash} from '../intents/sign.mjs';
import {tokenDiff,payloadString,mirrorDiff,receivedFor,giveFor,unmatched,signIntents} from '../intents/intents.mjs';
import {buildNonce} from '../intents/nonce.mjs';
import {buyFloors,settleBuy,transferIntent,signSolverSettle,solverLoss} from '../intents/jit.mjs';
import {USDC_SOL_TOKEN_ID,VERIFIER} from '../intents/constants.mjs';
import {transitionLeg,recordLegEvent,attemptIdOf} from '../pipeline/ledger.mjs';
import {recordSpend} from '../trade/limits.mjs';
import {tx} from '../trade/db.mjs';
import {refuse,TradeError,iso} from '../trade/util.mjs';
import {CANNOT_FILL_MESSAGE} from '#contracts/errors';
import {formatUnits,CATALOG} from '../trade/router.mjs';
import {onLedger} from './config.mjs';
import {settledOk} from './solver.mjs';

export const KIND='near_intent';
export const STANDARD='raw_ed25519';
/** A firm sourcing quote stays payable this long. */
export const QUOTE_MINUTES=12;
const TOKEN_ID=/^nep141:[a-z0-9._-]{2,64}$/;
const MAX_LOSS_BPS=10;
const SCHEMA=`
CREATE TABLE IF NOT EXISTS ledger_trade(
 trade_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, user_account TEXT NOT NULL, wallet TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN('yeet','skeet')),
 state TEXT NOT NULL CHECK(state IN('awaiting_approval','running','unloading','settled','not_executed')),
 json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_trade_state ON ledger_trade(state);
CREATE TABLE IF NOT EXISTS ledger_attempt(
 attempt_id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, attempt_no INTEGER NOT NULL, account_id TEXT NOT NULL, wallet TEXT NOT NULL,
 payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, nonce TEXT NOT NULL, deadline_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN('pending','accepted','expired','abandoned')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_attempt_trade ON ledger_attempt(trade_id,attempt_no);`;

const big=v=>BigInt(v);
const sum=xs=>xs.reduce((a,b)=>a+b,0n);
const sha256Hex=s=>createHash('sha256').update(s,'utf8').digest('hex');
/** What a person reads when the solver's float does not cover their trade (checked at the tap, before they are asked
 * for anything): plain words, and the fact that matters. */
export const CANNOT_FILL=CANNOT_FILL_MESSAGE;
const cannotFill=detail=>{throw Object.assign(new TradeError('TEMPORARILY_UNAVAILABLE',detail),{userMessage:CANNOT_FILL})};
export const explorerUrl=hash=>hash?`https://nearblocks.io/txns/${hash}`:null;
/** The ledger account a Solana wallet's key owns: the address bytes in hex. No registration, nothing to create. */
export const ledgerAccountOf=solanaAddress=>ed25519AccountId(solanaAddress);

/**
 * The 1Click client proposals use for an account on the ledger route: every DRY quote is asked with the ledger on
 * both sides and our solver as the account, so the basket card shows the amounts and minimums of the route the trade
 * will take. USDC on any network stands for the ledger's USDC. Firm quotes never go through this wrapper.
 */
export function previewClient(client,{solverAccount,usdcAssetIds}){
 const usdc=id=>usdcAssetIds.includes(id)?USDC_SOL_TOKEN_ID:id;
 return {
  get authenticated(){return client.authenticated},
  getTokens:(...a)=>client.getTokens(...a),
  status:(...a)=>client.status(...a),
  submitDeposit:(...a)=>client.submitDeposit(...a),
  quote(req){
   if(req?.dry!==true)throw Error('the preview client answers dry quotes only');
   return client.quote({...req,originAsset:usdc(req.originAsset),destinationAsset:usdc(req.destinationAsset),depositType:'INTENTS',refundType:'INTENTS',recipientType:'INTENTS',refundTo:solverAccount,recipient:solverAccount});
  },
 };
}

/**
 * Balances for accounts on the ledger route: what the pipeline calls the person's tokens on Solana is read from their
 * ledger account instead (USDC and every catalogue coin, one view call), and their USDC elsewhere counts as nothing
 * spendable. `isLedgerAddress(address)` decides per wallet address; every other address reads as before.
 */
export function ledgerBalances(inner,{isLedgerAddress,verifier,catalog=CATALOG,usdcTokenIds=[USDC_SOL_TOKEN_ID]}){
 const coins=catalog.filter(e=>e.chain==='solana'&&e.address&&TOKEN_ID.test(e.assetId));
 // USDC credited under another network's token id (Base's, when Base is offered for deposits) is the person's USDC
 // too: it is counted into the one USDC number. Which of them a buy spends is decided in livePlan (payWith).
 const more=usdcTokenIds.filter(id=>id!==USDC_SOL_TOKEN_ID&&TOKEN_ID.test(id));
 return {...inner,
  async baseUsdc(address){return isLedgerAddress(address)?0n:inner.baseUsdc(address)},
  async solanaTokens(owner){
   if(!isLedgerAddress(owner))return inner.solanaTokens(owner);
   const bal=await verifier.balances(ledgerAccountOf(owner),[...coins.map(c=>c.assetId),...more]);
   const extra=more.reduce((a,_,i)=>a+bal[coins.length+i],0n);
   return coins.map((c,i)=>({mint:c.address,raw:c.assetId===USDC_SOL_TOKEN_ID?bal[i]+extra:bal[i],decimals:c.decimals})).filter(h=>h.raw>0n);
  }};
}
/**
 * Which USDC token id a buy of `total` spends, from the person's balance of each (`held`, in the order of `ids`:
 * Solana's first). One message gives one token, so a buy is paid from ONE of them: the first that covers it (Solana's
 * when it does), else nothing: {tokenId} or {tokenId:null, most: the larger single balance}.
 */
export function payWith(ids,held,total){
 const i=held.findIndex(b=>b>=total);
 if(i>=0)return {tokenId:ids[i]};
 return {tokenId:null,most:held.reduce((a,b)=>b>a?b:a,0n)};
}
/** What a person reads when their USDC is in two parts and no single one covers the buy. */
export const twoPartsMessage=most=>`Your USDC arrived in two parts, and one trade spends from one of them: up to ${formatUnits(most,6)} USDC right now. Try that amount or less.`;

/** The token_diff a request states, rebuilt from its `gives` and `receives`: {tokenId: bigint}. */
export function diffOf({gives,receives}){
 const d={};
 for(const g of gives){if(d[g.token_id]!==undefined)throw Error('token listed twice');d[g.token_id]=-big(g.amount_raw)}
 for(const r of receives){if(d[r.token_id]!==undefined)throw Error('token listed twice');d[r.token_id]=big(r.min_raw)}
 return d;
}

export function createLedgerRoute({db,cfg,verifier,solver,client,alsoHandles=()=>false,catalog=CATALOG,usdcTokenIds=[USDC_SOL_TOKEN_ID],now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{},hooks,signWindowMs=10*60_000,unloadEveryMs=60_000,unloadWaitMs=90_000}){
 db.exec(SCHEMA);
 const event=e=>{try{log(e)}catch{}};
 const usdc=catalog.find(e=>e.chain==='solana'&&e.assetId===USDC_SOL_TOKEN_ID);
 if(!usdc)throw Error('catalogue is missing USDC on Solana');
 const usdcIds=catalog.filter(e=>e.symbol==='USDC').map(e=>e.assetId);
 const coinOf=assetId=>{const c=catalog.find(e=>e.chain==='solana'&&e.assetId===assetId);if(!c||!TOKEN_ID.test(assetId)||assetId===USDC_SOL_TOKEN_ID)refuse('COIN_NOT_SUPPORTED',assetId);return c};
 const brief=t=>({symbol:t.symbol,chain:t.chain,assetId:t.assetId,decimals:t.decimals});
 const row=id=>db.prepare('SELECT * FROM ledger_trade WHERE trade_id=?').get(id);
 const attempt=id=>db.prepare('SELECT * FROM ledger_attempt WHERE attempt_id=?').get(id);
 const lastAttempt=tradeId=>db.prepare('SELECT * FROM ledger_attempt WHERE trade_id=? ORDER BY attempt_no DESC LIMIT 1').get(tradeId);
 const setAttempt=(id,from,to)=>db.prepare('UPDATE ledger_attempt SET status=?,updated_at=? WHERE attempt_id=? AND status=?').run(to,now(),id,from).changes===1;
 const setState=(id,from,to,j)=>db.prepare(`UPDATE ledger_trade SET state=?,json=?,updated_at=? WHERE trade_id=? AND state IN(${from.map(()=>'?').join(',')})`).run(to,JSON.stringify(j),now(),id,...from).changes===1;
 const saver=(id,j)=>()=>{db.prepare('UPDATE ledger_trade SET json=?,updated_at=? WHERE trade_id=?').run(JSON.stringify(j),now(),id)};
 const preview=previewClient(client,{solverAccount:solver.accountId,usdcAssetIds:usdcIds});
 /** The USDC token ids a buy may be paid with, Solana's first: only ids the catalogue lists as USDC. */
 const payIds=[USDC_SOL_TOKEN_ID,...usdcTokenIds.filter(id=>id!==USDC_SOL_TOKEN_ID&&usdcIds.includes(id)&&TOKEN_ID.test(id))];

 /** One firm quote with the ledger on both sides and the solver as the account: nothing is committed until it is paid. */
 async function quoteFirm({originAsset,destinationAsset,amount,slippageBps,deadlineMs,dry=false}){
  const res=await client.quote({dry,swapType:'EXACT_INPUT',slippageTolerance:slippageBps,originAsset,depositType:'INTENTS',destinationAsset,amount:big(amount).toString(),
   refundTo:solver.accountId,refundType:'INTENTS',recipient:solver.accountId,recipientType:'INTENTS',deadline:iso(deadlineMs)});
  const q=res.quote;
  if(big(q.amountIn)!==big(amount))throw Error(`quote amountIn ${q.amountIn} differs from the request (correlationId ${res.correlationId})`);
  if(big(q.minAmountOut)<=0n||big(q.minAmountOut)>big(q.amountOut))throw Error('quote has no usable minimum');
  // a dry quote is a price only: it names no deposit account and can never be paid
  if(dry){if(q.depositAddress)throw Error('a dry quote returned a deposit account');return res}
  if(!/^[0-9a-f]{64}$/.test(q.depositAddress??''))throw Error('quote returned no ledger deposit account');
  if(q.depositMemo)throw Error('quote asks for a deposit memo');
  if(q.depositAddress===solver.accountId)throw Error('the deposit account is the solver itself');
  return res;
 }
 const quoteErrors=async fn=>{
  try{return await fn()}
  catch(e){
   if(e instanceof TradeError)throw e;
   const text=String(e?.message??e);
   if(/too low|minimum/i.test(text))refuse('AMOUNT_TOO_SMALL',text.slice(0,200));
   refuse('TEMPORARILY_UNAVAILABLE',`ledger quote: ${text.slice(0,200)}`);
  }
 };

 /**
  * The live plan of a trade on the ledger: one firm sourcing quote per leg, in the chain route's plan shape. BUY: the
  * solver buys each coin with the USDC the person pays. SELL: the solver sells what it receives of each coin (the
  * amount given less the ledger's fee). Refuses before anything is committed when the person's wallet is the solver's
  * own key, or the solver's bounds or float do not cover the trade.
  */
 async function livePlan({direction,legs,w,slippageBps,dry=false}){
  const userAccount=ledgerAccountOf(w.solana.address);
  if(userAccount===solver.accountId)refuse('TEMPORARILY_UNAVAILABLE','the account is the solver itself');
  const [feePips,float]=await quoteErrors(()=>Promise.all([verifier.fee(),solver.float()]));
  const at=now(),deadlineMs=at+QUOTE_MINUTES*60_000;
  const coins=legs.map(l=>coinOf(l.asset_id));
  // The USDC token the person pays a buy with. Solana's alone unless Base is offered for deposits; then the one of
  // the two that covers the whole buy (a message gives one token). The solver still sources with its own USDC.
  let usdcTokenId=USDC_SOL_TOKEN_ID;
  if(direction==='yeet'){
   const total=sum(legs.map(l=>big(l.amount_in_raw)));
   if(payIds.length>1){
    const held=await quoteErrors(()=>verifier.balances(userAccount,payIds)),pick=payWith(payIds,held,total);
    if(!pick.tokenId){
     if(sum(held)<total)refuse('BALANCE_LOW');
     throw Object.assign(new TradeError('BALANCE_LOW',`USDC in two token ids, the larger holds ${pick.most}, the buy needs ${total}`),{userMessage:twoPartsMessage(pick.most)});
    }
    usdcTokenId=pick.tokenId;
    if(usdcTokenId!==USDC_SOL_TOKEN_ID)event({event:'ledger_buy_pays_with',token:usdcTokenId,total:total.toString()});
   }
   solver.checkExposure(total);
   if(float<total)cannotFill(`solver float ${float} is below ${total}`);
  }
  const quotes=await quoteErrors(()=>Promise.all(legs.map((l,i)=>direction==='yeet'
   ?quoteFirm({originAsset:USDC_SOL_TOKEN_ID,destinationAsset:coins[i].assetId,amount:big(l.amount_in_raw),slippageBps,deadlineMs,dry})
   :quoteFirm({originAsset:coins[i].assetId,destinationAsset:USDC_SOL_TOKEN_ID,amount:receivedFor(big(l.amount_in_raw),feePips),slippageBps,deadlineMs,dry}))));
  if(direction==='skeet'){
   const pays=giveFor(sum(quotes.map(r=>receivedFor(big(r.quote.minAmountOut),feePips))),feePips);
   solver.checkExposure(pays);
   if(float<pays)cannotFill(`solver float ${float} is below ${pays}`);
  }
  const out=quotes.map((res,i)=>{
   const q=res.quote,l=legs[i],coin=coins[i],[origin,destination]=direction==='yeet'?[usdc,coin]:[coin,usdc];
   const leg={index:i,symbol:coin.symbol,origin:brief(origin),destination:brief(destination),amountIn:String(l.amount_in_raw),amountInFormatted:formatUnits(big(l.amount_in_raw),origin.decimals),amountInUsd:q.amountInUsd,
    amountOut:q.amountOut,amountOutFormatted:q.amountOutFormatted??formatUnits(big(q.amountOut),destination.decimals),amountOutUsd:q.amountOutUsd,minAmountOut:q.minAmountOut,
    minAmountOutFormatted:formatUnits(big(q.minAmountOut),destination.decimals),timeEstimate:q.timeEstimate,deadline:q.deadline??iso(deadlineMs),
    correlationId:res.correlationId,signature:res.signature,quoteTimestamp:res.timestamp,depositAddress:q.depositAddress??null,
    // what the solver pays into this quote: the person's USDC for a buy, the coin less the ledger's fee for a sell
    sourcingAmountIn:q.amountIn};
   if(l.parts!==undefined&&l.parts!==null)leg.parts=l.parts;
   return leg;
  });
  if(!dry&&new Set(out.map(l=>l.depositAddress)).size!==out.length)refuse('TEMPORARILY_UNAVAILABLE','ledger quote: deposit account repeated');
  const id=`${direction}_${sha256Hex(JSON.stringify({direction,route:'ledger',legs:out.map(l=>[l.origin.assetId,l.destination.assetId,l.amountIn]),userAccount,at})).slice(0,24)}`;
  return {id,direction,dry:false,createdAt:iso(at),recipient:userAccount,refundTo:userAccount,slippageBps,authenticated:!!client.authenticated,legs:out,originChain:'sol',
   ledger:{userAccount,feePips:Number(feePips),quoteDeadlineMs:deadlineMs,...(usdcTokenId!==USDC_SOL_TOKEN_ID?{usdcTokenId}:{})}};
 }

 /** The route's row for a trade the pipeline is committing (called inside its transaction). */
 const stateOf=live=>({direction:live.direction,fee_pips:live.ledger.feePips,quote_deadline_ms:live.ledger.quoteDeadlineMs,...(live.ledger.usdcTokenId?{usdc_token_id:live.ledger.usdcTokenId}:{}),
  legs:live.legs.map(l=>({idx:l.index,symbol:l.symbol,originAsset:l.origin.assetId,destinationAsset:l.destination.assetId,amount_in:l.amountIn,
   quote:{depositAddress:l.depositAddress,amountIn:l.sourcingAmountIn,amountOut:l.amountOut,minAmountOut:l.minAmountOut,correlationId:l.correlationId??null}}))});
 function commit({tradeId,accountId,wallet,live,at}){
  const j=stateOf(live);
  db.prepare("INSERT INTO ledger_trade(trade_id,account_id,user_account,wallet,direction,state,json,created_at,updated_at) VALUES(?,?,?,?,?,'awaiting_approval',?,?,?)")
   .run(tradeId,accountId,live.ledger.userAccount,wallet,live.direction,JSON.stringify(j),at,at);
 }

 /** What the person gives and the least they receive, from the firm quotes: the content of their one message. */
 function terms(j){
  const fee=big(j.fee_pips);
  if(j.direction==='yeet'){
   // the token the person gives: Solana's USDC, or the one chosen at the tap (stored with the trade, one of payIds)
   const paid=j.usdc_token_id??USDC_SOL_TOKEN_ID;
   if(!payIds.includes(paid))throw new TradeError('TEMPORARILY_UNAVAILABLE','the trade names a USDC token this route does not take');
   const floors=buyFloors({legs:j.legs.map(l=>({symbol:l.symbol,tokenId:l.destinationAsset,usdcIn:l.amount_in,minOut:l.quote.minAmountOut})),feePips:fee,marginBps:0,usdcTokenId:paid});
   const loss=solverLoss({spentUsdc:floors.usdc.userGives,receivesUsdc:floors.usdc.solverReceives,maxLossBps:MAX_LOSS_BPS});
   if(!loss.ok)throw new TradeError('TEMPORARILY_UNAVAILABLE','the ledger fee is over the solver bound');
   return {gives:[{token_id:paid,amount_raw:floors.usdc.userGives.toString()}],receives:floors.legs.map(l=>({token_id:l.tokenId,min_raw:l.userFloor.toString()})),floors};
  }
  const floor=sum(j.legs.map(l=>receivedFor(big(l.quote.minAmountOut),fee)));
  if(floor<=0n)throw new TradeError('AMOUNT_TOO_SMALL','sell floor');
  return {gives:j.legs.map(l=>({token_id:l.originAsset,amount_raw:big(l.amount_in).toString()})),receives:[{token_id:USDC_SOL_TOKEN_ID,min_raw:floor.toString()}],floor};
 }

 /** The exact text the person approves: one `token_diff` for their own ledger account, with a fresh nonce that ends
  * with the message. */
 async function messageFor(t,userAccount,deadlineMs){
  const nonce=buildNonce({saltHex:await verifier.currentSalt(),deadlineMs});
  return {nonce,payload:payloadString({signerId:userAccount,deadline:iso(deadlineMs),nonce,intents:[tokenDiff(diffOf(t))]})};
 }
 /** Read only (ops/ledger-route-check.mjs): the plan of a trade from DRY quotes (prices only, nothing that could be
  * paid) and the message that would be approved for it. Stores nothing and asks no one. */
 async function draft({direction,legs,w,slippageBps=100}){
  const live=await livePlan({direction,legs,w,slippageBps,dry:true}),t=terms(stateOf(live)),deadlineMs=now()+cfg.deadlineS*1000;
  const {payload}=await messageFor(t,live.ledger.userAccount,deadlineMs);
  return {live,message:payload,gives:t.gives,receives:t.receives,deadline:iso(deadlineMs),approve_before:iso(deadlineMs-cfg.minRunS*1000)};
 }
 /** A new request for the whole trade: one message, valid cfg.deadlineS, to be approved cfg.minRunS before it ends. */
 async function issue(r){
  const j=JSON.parse(r.json),t=terms(j),at=now(),deadlineMs=at+cfg.deadlineS*1000;
  if(deadlineMs>j.quote_deadline_ms-5_000)throw new TradeError('TEMPORARILY_UNAVAILABLE','the sourcing quotes end too soon for a new request');
  const {nonce,payload}=await messageFor(t,r.user_account,deadlineMs);
  return tx(db,()=>{
   const cur=row(r.trade_id);
   if(cur.state!=='awaiting_approval')throw new TradeError('INVALID_ARGUMENT','the trade is not waiting for approval');
   db.prepare("UPDATE ledger_attempt SET status='abandoned',updated_at=? WHERE trade_id=? AND status='pending'").run(at,r.trade_id);
   const n=(db.prepare('SELECT MAX(attempt_no) AS n FROM ledger_attempt WHERE trade_id=?').get(r.trade_id).n??0)+1,id=attemptIdOf(r.trade_id,j.legs[0].idx,n);
   db.prepare("INSERT INTO ledger_attempt(attempt_id,trade_id,attempt_no,account_id,wallet,payload,payload_sha256,nonce,deadline_ms,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)")
    .run(id,r.trade_id,n,r.account_id,r.wallet,payload,sha256Hex(payload),nonce,deadlineMs,deadlineMs-cfg.minRunS*1000,at,at);
   return attempt(id);
  });
 }
 /** The contract's sign request for an open attempt: `payload.message` is the exact text the person's key approves;
  * `gives` and `receives` restate it so the card can check the text before it asks the wallet (wallet-request.mjs). */
 function requestOf(r,a,legRows){
  const j=JSON.parse(r.json),t=terms(j),side=r.direction==='yeet'?'buy':'sell';
  const summaryOf=l=>{const q=JSON.parse(l.live_quote_json);return {side,asset:q.origin.symbol,amount_raw:String(l.amount_in_raw),decimals:q.origin.decimals,to:r.user_account}};
  const idxs=j.legs.map(l=>l.idx),rows=idxs.map(i=>legRows.find(l=>l.idx===i));
  return {trade_id:r.trade_id,leg:idxs[0],attempt_id:a.attempt_id,kind:KIND,chain:'sol',wallet:a.wallet,
   payload:{standard:STANDARD,message:a.payload,message_base64:Buffer.from(a.payload,'utf8').toString('base64'),signer_id:r.user_account,verifying_contract:VERIFIER,deadline:iso(a.deadline_ms),gives:t.gives,receives:t.receives},
   payload_sha256:a.payload_sha256,expires_at:iso(a.expires_at),summary:summaryOf(rows[0]),legs:idxs,leg_summaries:rows.map(l=>({leg:l.idx,...summaryOf(l)}))};
 }
 const windowOpen=(t,j)=>now()<=t.created_at+signWindowMs&&now()+cfg.deadlineS*1000<=j.quote_deadline_ms-5_000;

 /** The open request of a trade awaiting approval: the pending one while it can still be approved in time, else a new
  * one while the trade's window and the quotes allow. [] otherwise (recover then closes the trade). */
 async function signRequests(t){
  const r=row(t.id);
  if(!r||r.state!=='awaiting_approval')return [];
  const legRows=hooks.legsOf(t.id);
  if(legRows.some(l=>l.send_status!=='awaiting_signature'))return [];
  let a=lastAttempt(t.id);
  if(a?.status==='pending'&&now()>a.expires_at){setAttempt(a.attempt_id,'pending','expired');a=null}
  if(a?.status!=='pending'){
   if(!windowOpen(t,JSON.parse(r.json)))return [];
   try{a=await issue(r)}catch(e){hooks.note(t.id,`ledger request: ${e?.detail??e?.message}`);return []}
  }
  return [requestOf(r,a,legRows)];
 }
 /** driver.prepareLegs for the pipeline: one request covers every leg. Never throws for a leg. */
 async function prepareLegs({trade,legs}){
  const idxs=legs.map(l=>l.idx);
  try{const a=await issue(row(trade.id));return [{attemptId:a.attempt_id,legs:idxs}]}
  catch(e){return [{legs:idxs,error:e}]}
 }

 /**
  * The person's approval of one request. `signed` is base64 of the 64-byte signature their wallet made over the exact
  * message bytes. Checked locally against the wallet's own key, then simulated ALONE on the ledger: it must pass every
  * check and stop only at the missing counterparty. Only then is it stored and the run started.
  * Returns {state: 'pending' (accepted, on its way) | 'expired' (ask again) | 'not_sent' (nothing moved), ...}.
  */
 async function submit({trade,leg,attemptId,signed,dryRun=false,accountId,wallet}){
  const r=row(trade.id),a=attempt(attemptId);
  if(!r||!a||a.trade_id!==trade.id||a.account_id!==accountId)refuse('INVALID_ARGUMENT','unknown attempt');
  const j=JSON.parse(r.json);
  if(leg!==j.legs[0].idx)refuse('INVALID_ARGUMENT','unknown attempt');
  if(wallet!==a.wallet)refuse('INVALID_ARGUMENT','the attempt is for another wallet');
  if(a.status==='accepted')return {state:'pending',txHash:null};
  if(a.status!=='pending'||r.state!=='awaiting_approval')return {state:'expired'};
  if(now()>a.expires_at){setAttempt(a.attempt_id,'pending','expired');return {state:'expired'}}
  let mp;
  try{
   const sig=Buffer.from(String(signed),'base64');
   if(sig.length!==64||sig.toString('base64')!==signed)throw Error('not a 64-byte base64 value');
   mp=rawEd25519Payload(a.payload,a.wallet,sig);
  }catch(e){refuse('INVALID_ARGUMENT',`approval: ${String(e?.message??e).slice(0,120)}`)}
  hooks.gate(accountId);
  const sim=await verifier.simulate([mp]);
  if(sim.code!=='INVARIANT_VIOLATED'){
   event({event:'ledger_approval_refused',trade:trade.id,outcome:sim.ok?'PASSED':sim.code,contract_says:String(sim.message??'').slice(0,160)});
   // the salt rotated or time ran out between the request and the approval: a fresh request can still succeed
   if(['INVALID_SALT','DEADLINE_EXPIRED','NONCE_EXPIRED','DEADLINE_GREATER_THAN_NONCE'].includes(sim.code)){setAttempt(a.attempt_id,'pending','expired');return {state:'expired'}}
   if(dryRun)return {state:'not_sent',simulation:{outcome:sim.ok?'PASSED':sim.code}};
   const code=sim.code==='INSUFFICIENT_BALANCE'?'BALANCE_LOW':'TEMPORARILY_UNAVAILABLE';
   close(trade.id,{reason:`the approval does not simulate: ${sim.ok?'PASSED':sim.code}`,stage:'approval'},code);
   return {state:'not_sent'};
  }
  if(dryRun)return {state:'pending',simulation:{outcome:'READY',intent_hash:intentHash(mp)}};
  const hash=intentHash(mp);
  const accepted=tx(db,()=>{
   if(!setAttempt(a.attempt_id,'pending','accepted'))return false;
   Object.assign(j,{user_signed:mp,nonce:a.nonce,deadline_ms:a.deadline_ms,attempt_id:a.attempt_id,user_intent_hash:hash,terms:(({gives,receives})=>({gives,receives}))(terms(j)),run:{},at:{approved:iso(now())}});
   if(!setState(trade.id,['awaiting_approval'],'running',j))throw new TradeError('INVALID_ARGUMENT','the trade is not waiting for approval');
   for(const l of j.legs)if(!transitionLeg(db,{tradeId:trade.id,idx:l.idx,from:'awaiting_signature',to:'signing',evidence:{attempt_id:a.attempt_id,intent_hash:hash,route:'ledger'},set:{updated_at:now()},at:now()}))
    throw new TradeError('INVALID_ARGUMENT','a leg is not waiting for approval');
   return true;
  });
  if(!accepted)return {state:'pending',txHash:null};
  event({event:'ledger_approved',trade:trade.id,intent_hash:hash,deadline:iso(a.deadline_ms)});
  start(trade.id);
  return {state:'pending',txHash:null};
 }

 /** Legs still awaiting approval become not_sent (the pipeline's own transition), a buy's amount returns to the daily
  * cap, and the route's row closes. Nothing was approved, nothing can move. */
 function close(tradeId,evidence,code='TEMPORARILY_UNAVAILABLE'){
  const t=hooks.trade(tradeId);
  for(const l of hooks.legsOf(tradeId).filter(l=>l.send_status==='awaiting_signature')){
   if(!hooks.legNotSent(tradeId,l.idx,{...evidence,route:'ledger'}))continue;
   // The pipeline holds a buy leg's amount until its deposit address can no longer be paid from the person's wallet.
   // A ledger leg has no such address (only the solver pays the sourcing quote), so the amount returns at once.
   tx(db,()=>{if(db.prepare("UPDATE spend_hold SET state='released',resolved_at=? WHERE trade_id=? AND idx=? AND state='held'").run(now(),tradeId,l.idx).changes===1)recordSpend(db,t.account_id,t.created_at,-big(l.amount_in_raw))});
  }
  const r=row(tradeId);
  if(r?.state==='awaiting_approval'){
   db.prepare("UPDATE ledger_attempt SET status='abandoned',updated_at=? WHERE trade_id=? AND status='pending'").run(now(),tradeId);
   setState(tradeId,['awaiting_approval'],'not_executed',{...JSON.parse(r.json),result:{executed:false,...evidence}});
  }
  hooks.settle(tradeId,code);hooks.refresh(tradeId);
 }

 // ---- the run ----
 const runs=new Map();
 function start(tradeId){
  if(runs.has(tradeId))return runs.get(tradeId);
  const p=solver.lock(()=>run(tradeId)).catch(e=>{event({event:'ledger_run_failed',trade:tradeId,error:String(e?.message??e).slice(0,200)});hooks.note(tradeId,`ledger run: ${e?.message}`)}).finally(()=>runs.delete(tradeId));
  runs.set(tradeId,p);
  return p;
 }
 /** The synthetic settlement record of a leg, folded by the tracker exactly like a 1Click status. */
 const settledStatus=(l,{amountIn,amountOut,txHash})=>({status:'SUCCESS',correlationId:l.quote.correlationId??`ledger:${txHash}`,updatedAt:iso(now()),
  swapDetails:{intentHashes:[],nearTxHashes:[txHash],amountIn:String(amountIn),amountOut:String(amountOut),originChainTxHashes:[],destinationChainTxHashes:[]}});
 /** signing -> sent for every leg with what the person received, in one transaction with the route's own state. */
 function markSettled(tradeId,j,next,outs){
  const txHash=j.settle.tx_hash;
  tx(db,()=>{
   for(const l of j.legs){
    if(!transitionLeg(db,{tradeId,idx:l.idx,from:'signing',to:'sent',evidence:{tx_hash:txHash,oneclick_status:'SUCCESS',route:'ledger',received_raw:outs[l.idx].toString()},set:{tx_hash:txHash,deposit_submitted:1,updated_at:now()},at:now()}))
     throw Error(`leg ${l.idx} is not being settled`);
    hooks.apply(tradeId,l.idx,settledStatus(l,{amountIn:l.amount_in,amountOut:outs[l.idx],txHash}));
   }
   j.result={executed:true,tx_hash:txHash,received:Object.fromEntries(j.legs.map(l=>[l.symbol,outs[l.idx].toString()]))};j.at.settled=iso(now());
   if(!setState(tradeId,['running'],next,j))throw Error('the trade is not running');
  });
  event({event:'ledger_settled',trade:tradeId,tx_hash:txHash,direction:j.direction});
  hooks.settle(tradeId);hooks.refresh(tradeId);
 }
 /** The person's message was not executed and can no longer be: every leg fails (nothing of theirs moved), a buy's
  * amount returns to the daily cap at once. */
 function markNotExecuted(tradeId,j,reason){
  const t=hooks.trade(tradeId);
  tx(db,()=>{
   for(const l of j.legs)transitionLeg(db,{tradeId,idx:l.idx,from:'signing',to:'failed',evidence:{reason:String(reason).slice(0,200),route:'ledger',executed:false,released_raw:t.direction==='yeet'?l.amount_in:null},set:{updated_at:now()},at:now()});
   if(t.direction==='yeet')recordSpend(db,t.account_id,t.created_at,-sum(j.legs.map(l=>big(l.amount_in))));
   j.result={executed:false,reason:String(reason).slice(0,200)};
   if(!setState(tradeId,['running'],'not_executed',j))throw Error('the trade is not running');
  });
  event({event:'ledger_not_executed',trade:tradeId,reason:String(reason).slice(0,200)});
  hooks.settle(tradeId,'TEMPORARILY_UNAVAILABLE');hooks.refresh(tradeId);
  lastUnload=0;
 }
 /** Sends the settlement once and reads its outcome. 'settled' | 'failed' (the person's nonce is unused: it did not
  * and cannot execute after its deadline) | 'pending' (no outcome yet: recover looks again). */
 async function settleOnce(tradeId,j,save){
  let st=null;
  try{st=await solver.sendOnce(j.settle,j.signed_pair,save,{label:'settle'})}
  catch(e){hooks.note(tradeId,`ledger settle: ${e?.message}`)}
  if(st&&settledOk(st))return 'settled';
  if(st&&st.ok===null)return 'pending';
  // failed, refused or unreadable: the ledger itself says whether the person's message was executed
  let used;
  try{used=await verifier.isNonceUsed(row(tradeId).user_account,j.nonce)}catch{return 'pending'}
  if(used)return 'settled';
  if(st?.ok===false)return 'failed';
  return now()>j.deadline_ms+30_000?'failed':'pending';
 }

 async function run(tradeId){
  const r=row(tradeId);
  if(!r||!['running','unloading'].includes(r.state))return;
  const j=JSON.parse(r.json),save=saver(tradeId,j),fee=big(j.fee_pips),limit=j.deadline_ms-cfg.minLeftS*1000;
  const paused=()=>hooks.paused(hooks.trade(tradeId));
  if(r.state==='unloading')return unloadSell(tradeId,r,j,save);
  if(j.direction==='yeet'){
   if(!j.signed_pair){
    const total=sum(j.legs.map(l=>big(l.amount_in)));
    if(!j.legs.every(l=>l.sourced)){
     if(!j.run.signed){
      // nothing is paid yet: every refusal here leaves the solver and the person exactly where they were
      const why=paused();
      if(why)return markNotExecuted(tradeId,j,`trading paused: ${why}`);
      if(now()>=limit)return markNotExecuted(tradeId,j,'the approval arrived too close to its deadline; nothing was bought');
      try{if((await solver.float())<total)throw new TradeError('TEMPORARILY_UNAVAILABLE','solver float too low');solver.recordExposure(total)}
      catch(e){return markNotExecuted(tradeId,j,e?.detail??e?.message??'solver bound')}
      j.at.sourcing_started=iso(now());save();
     }
     const s=await solver.source(j.run,j.legs,{untilMs:limit,save,label:'buy'});
     j.at.sourcing_ended=iso(now());save();
     if(!s.ok){
      if(s.paid===null&&now()<limit)return;
      return markNotExecuted(tradeId,j,s.reason);
     }
    }
    if(now()>=limit)return markNotExecuted(tradeId,j,'sourcing finished too close to the deadline');
    const t=terms(j),bal=await verifier.balances(solver.accountId,j.legs.map(l=>l.destinationAsset));
    // never give more than the solver holds now, whatever was counted as sourced
    const sourced=j.legs.map((l,i)=>big(l.sourced)<bal[i]?big(l.sourced):bal[i]);
    const settle=settleBuy({floors:t.floors,sourced,feePips:fee,marginBps:0});
    if(!settle.ok)return markNotExecuted(tradeId,j,`a coin was delivered below the approved minimum: ${settle.short.map(s=>s.symbol).join(', ')}`);
    const signedSolver=await signSolverSettle(solver.signer,{solverDiff:settle.solverDiff,surplus:settle.surplus,userAccount:r.user_account,deadlineMs:j.deadline_ms,saltHex:await verifier.currentSalt()});
    const pair=[signedSolver.signed,j.user_signed],sim=await verifier.simulate(pair);
    if(!sim.ok)return markNotExecuted(tradeId,j,`the settlement does not simulate: ${sim.code}`);
    j.signed_pair=pair;j.settle={};j.outs=Object.fromEntries(j.legs.map((l,i)=>[l.idx,settle.legs[i].userReceives.toString()]));save();
   }
   const s=await settleOnce(tradeId,j,save);
   if(s==='settled'){
    markSettled(tradeId,j,'settled',Object.fromEntries(Object.entries(j.outs).map(([k,v])=>[k,big(v)])));
    // the next operation reads the solver's balances: it must see this settlement
    await solver.awaitFinal(j.settle);
    return;
   }
   if(s==='failed')return markNotExecuted(tradeId,j,`execute_intents failed: ${String(j.settle?.failure??j.settle?.rejected??'no outcome').slice(0,120)}`);
   return;
  }
  // ---- sell: the solver pays the approved minimum at once from its float, then sells what it received ----
  if(!j.signed_pair){
   const why=paused();
   if(why)return markNotExecuted(tradeId,j,`trading paused: ${why}`);
   if(now()>=limit)return markNotExecuted(tradeId,j,'the approval arrived too close to its deadline; nothing was sold');
   const userDiff=diffOf(terms(j)),solverDiff=mirrorDiff(userDiff,fee);
   if(Object.keys(unmatched([userDiff,solverDiff],fee)).length)return markNotExecuted(tradeId,j,'the two sides do not net to zero');
   const pays=-solverDiff[USDC_SOL_TOKEN_ID];
   try{if((await solver.float())<pays)throw new TradeError('TEMPORARILY_UNAVAILABLE','solver float too low');solver.recordExposure(pays)}
   catch(e){return markNotExecuted(tradeId,j,e?.detail??e?.message??'solver bound')}
   const s=await signIntents(solver.signer,{intents:[tokenDiff(solverDiff)],deadlineMs:j.deadline_ms,saltHex:await verifier.currentSalt()});
   const pair=[s.signed,j.user_signed],sim=await verifier.simulate(pair);
   if(!sim.ok)return markNotExecuted(tradeId,j,`the settlement does not simulate: ${sim.code}`);
   j.signed_pair=pair;j.settle={};j.solver_pays=pays.toString();
   j.outs=Object.fromEntries(j.legs.map(l=>[l.idx,receivedFor(big(l.quote.minAmountOut),fee).toString()]));save();
  }
  const s=await settleOnce(tradeId,j,save);
  if(s==='failed')return markNotExecuted(tradeId,j,`execute_intents failed: ${String(j.settle?.failure??j.settle?.rejected??'no outcome').slice(0,120)}`);
  if(s!=='settled')return;
  markSettled(tradeId,j,'unloading',Object.fromEntries(Object.entries(j.outs).map(([k,v])=>[k,big(v)])));
  // the person is paid; the unload below reads the solver's balances and must see this settlement
  await solver.awaitFinal(j.settle);
  return unloadSell(tradeId,row(tradeId),j,save);
 }
 /** After a settled sell: the solver pays the firm quotes with the coins it received; what comes back above what it
  * already paid the person is theirs and is sent on. A sale that does not complete leaves the coins to the leftover
  * unload and raises an alert for the surplus. */
 async function unloadSell(tradeId,r,j,save){
  j.unload??={run:{},legs:j.legs.map(l=>({symbol:l.symbol,originAsset:l.originAsset,destinationAsset:USDC_SOL_TOKEN_ID,quote:l.quote}))};save();
  const done=(state,extra={})=>{Object.assign(j.unload,{state,...extra});setState(tradeId,['unloading'],'settled',j)};
  const u=await solver.source(j.unload.run,j.unload.legs,{untilMs:Math.min(now()+unloadWaitMs,j.quote_deadline_ms),save,label:'sell_unload'});
  if(!u.ok){
   if(u.paid===null&&now()<j.quote_deadline_ms)return;
   hooks.raiseAlert({key:`ledger_sell_unload:${tradeId}`,tradeId,kind:'stuck',detail:{route:'ledger',what:'the solver could not sell the coins of a settled sell; any surplus over the paid minimum is still owed to the person',reason:u.reason,solver_paid:j.solver_pays}});
   lastUnload=0;
   return done('leftover',{reason:u.reason});
  }
  // each leg's `sourced` was fixed when its delivery was seen: a later look at the balance is not used
  const unloaded=sum(j.unload.legs.map(l=>big(l.sourced))),extra=unloaded-big(j.solver_pays);
  if(extra<=0n)return done('done',{unloaded:unloaded.toString(),surplus:'0'});
  if(!j.unload.surplus_signed){
   j.unload.surplus_signed=(await signIntents(solver.signer,{intents:[transferIntent({receiverId:r.user_account,tokens:{[USDC_SOL_TOKEN_ID]:extra}})],deadlineMs:now()+10*60_000,saltHex:await verifier.currentSalt()})).signed;
   j.unload.surplus_tx={};save();
  }
  let st=null;
  try{st=await solver.sendOnce(j.unload.surplus_tx,[j.unload.surplus_signed],save,{label:'sell_surplus'})}catch(e){hooks.note(tradeId,`ledger surplus: ${e?.message}`)}
  if(st&&st.ok===null)return;
  if(!st||!settledOk(st)){
   hooks.raiseAlert({key:`ledger_sell_surplus:${tradeId}`,tradeId,kind:'stuck',detail:{route:'ledger',what:'the surplus of a settled sell was not sent to the person',surplus_raw:extra.toString()}});
   return done('surplus_owed',{unloaded:unloaded.toString(),surplus:extra.toString()});
  }
  // the receipt shows what the person really received: the surplus is spread over the legs by their quoted share
  const quoted=sum(j.legs.map(l=>big(l.quote.amountOut)));let left=extra;
  tx(db,()=>{
   j.legs.forEach((l,i)=>{
    const share=i===j.legs.length-1?left:extra*big(l.quote.amountOut)/quoted;left-=share;
    const total=big(j.outs[l.idx])+share;j.outs[l.idx]=total.toString();
    db.prepare('UPDATE trade_legs SET settled_out_raw=?,updated_at=? WHERE trade_id=? AND idx=?').run(total.toString(),now(),tradeId,l.idx);
    recordLegEvent(db,{tradeId,idx:l.idx,status:'sent',evidence:{route:'ledger',surplus_raw:share.toString(),surplus_tx:j.unload.surplus_tx.tx_hash,received_raw:total.toString()},at:now()});
   });
   done('done',{unloaded:unloaded.toString(),surplus:extra.toString()});
  });
  event({event:'ledger_sell_surplus',trade:tradeId,surplus_raw:extra.toString(),tx_hash:j.unload.surplus_tx.tx_hash});
  await solver.awaitFinal(j.unload.surplus_tx);
  try{hooks.refresh(tradeId)}catch{}
 }

 /** Recovery for one ledger trade (the tracker's pass, a replayed code, the trade page). */
 async function recover(tradeId){
  const r=row(tradeId);
  if(!r)return false;
  if(r.state==='awaiting_approval'){
   const t=hooks.trade(tradeId),legRows=hooks.legsOf(tradeId);
   if(!legRows.some(l=>l.send_status==='awaiting_signature')){close(tradeId,{reason:'closed before approval',stage:'recovery'});return true}
   const a=lastAttempt(tradeId),paused=hooks.paused(t);
   const openRequest=a?.status==='pending'&&now()<=a.expires_at;
   const why=paused?`trading paused: ${paused}`:now()>t.created_at+signWindowMs?'not approved within the window':!openRequest&&!windowOpen(t,JSON.parse(r.json))?'the sourcing quotes ended':null;
   if(why)close(tradeId,{reason:why,stage:'recovery'});
   return true;
  }
  if(['running','unloading'].includes(r.state))start(tradeId);
  return true;
 }

 // ---- leftover inventory ----
 let lastUnload=0,unloading=null;
 // USDC the solver was paid under another network's token id (a buy paid with Base's) is inventory like a coin: it is
 // sold back to the solver's own USDC by the same unload, under the same tries and bound.
 const leftoverCoins=()=>[...catalog.filter(e=>e.chain==='solana'&&TOKEN_ID.test(e.assetId)&&e.assetId!==USDC_SOL_TOKEN_ID).map(e=>({symbol:e.symbol,tokenId:e.assetId})),
  ...payIds.slice(1).map(id=>({symbol:`USDC.${/^nep141:([a-z]{2,8})-/.exec(id)?.[1]??'other'}`,tokenId:id}))];
 /** Resumes interrupted runs; then, while no trade is running and at most every unloadEveryMs, sells what the solver
  * holds besides USDC (solver.unloadLeftovers: capped tries per coin and day). */
 async function tick(){
  for(const r of db.prepare("SELECT trade_id FROM ledger_trade WHERE state IN('running','unloading') ORDER BY created_at").all())start(r.trade_id);
  if(unloading||now()-lastUnload<unloadEveryMs)return;
  if(db.prepare("SELECT 1 FROM ledger_trade WHERE state IN('running','unloading') LIMIT 1").get())return;
  lastUnload=now();
  unloading=solver.unloadLeftovers({coins:leftoverCoins(),waitMs:unloadWaitMs,
   quote:async({originAsset,amount})=>{const res=await quoteFirm({originAsset,destinationAsset:USDC_SOL_TOKEN_ID,amount,slippageBps:cfg.sourceSlippageBps,deadlineMs:now()+QUOTE_MINUTES*60_000});
    return {depositAddress:res.quote.depositAddress,amountIn:big(res.quote.amountIn),amountOut:big(res.quote.amountOut),minAmountOut:big(res.quote.minAmountOut)}},
   onStuck:s=>hooks.raiseAlert({key:s.unload_id?`ledger_unload_open:${s.unload_id}`:`ledger_unload:${s.day}:${s.tokenId}`,kind:'stuck',detail:{route:'ledger',what:'the solver holds a coin it could not sell back to USDC within the daily tries',...s}})})
   .catch(e=>event({event:'ledger_unload_failed',error:String(e?.message??e).slice(0,200)})).finally(()=>{unloading=null});
  return unloading;
 }

 return {
  cfg,solverAccount:solver.accountId,
  // alsoHandles: accounts that trade here whatever the route switch says (an agent's own key, core/agent/agents.mjs)
  handles:accountId=>onLedger(cfg,accountId)||!!alsoHandles(accountId),
  /** The solver and the ledger reader (the agent route relays its budget transfers through the same solver). */
  solver,verifier,
  owns:tradeId=>!!row(tradeId),
  row,attempt,previewClient:preview,livePlan,draft,commit,signRequests,submit,recover,close,tick,explorerUrl,
  driver:Object.freeze({chain:'sol',kind:null,route:'ledger',prepareLegs,readiness:()=>({ok:true,reasons:[]})}),
  /** Every open run and unload (tests, ops). */
  idle:async()=>{for(;;){const open=[...runs.values(),...(unloading?[unloading]:[])];if(!open.length)return;await Promise.allSettled(open)}},
 };
}

// execute_trade, at the person's tap (port plan section 3):
//  1. the confirm code: bound to account, client, proposal, revision and quote; single use; a used code replays its trade
//  2. kill switch and YEET_LIVE (unset: TRADING_PAUSED, the code stays unused)
//  3. signer state and balance through the wallet adapter
//  4. live plan through the router with dry:false (one deposit address per leg)
//  5. REQUOTE when a live leg's amountOut is under the preview's min_out, or the preview is over 60 s old and a live
//     leg is under the preview's estimate: the code is used, a new revision is stored and a new code goes to `_meta`
//  6. one transfer per leg for the exact amountIn through the signer, then 1Click submitDeposit
//  7. persist trade and legs, answer `submitted` inside the time budget; the tracker takes over
import {buildYeetPlan,buildSkeetPlan,formatUnits} from './router.mjs';
import {checkKillSwitch,checkBasket,checkDaily,checkCost,recordSpend} from './limits.mjs';
import {routed,quoteHash} from './proposals.mjs';
import {receiptLeg} from './tracker.mjs';
import {legIdempotencyKey} from './signer.mjs';
import {refuse,newId,iso,TradeError} from './util.mjs';
import {tx} from './db.mjs';

export const PREVIEW_STALE_MS=60_000;
export const EXECUTE_BUDGET_MS=20_000;
const explorer=(direction,hash)=>hash?(direction==='yeet'?`https://basescan.org/tx/${hash}`:`https://solscan.io/tx/${hash}`):null;

export function createExecutor({db,client,limits,wallets,signer,codes,proposals,tracker,now=Date.now,budgetMs=EXECUTE_BUDGET_MS}){
 const trade=id=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
 const legsOf=id=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
 const deps=()=>({client,now:()=>new Date(now())});

 /** The execute_trade answer for a stored trade (also what a replayed code gets). */
 function answer(tradeId){
  const t=trade(tradeId);
  if(!t)refuse('TEMPORARILY_UNAVAILABLE','trade missing');
  if(t.result_json){const r=JSON.parse(t.result_json);if(r.error)throw new TradeError(r.error,'replayed failure');return r}
  return {trade_id:t.id,proposal_id:t.proposal_id,direction:t.direction,status:'submitted',
   legs:legsOf(t.id).map(l=>({symbol:l.symbol,deposit_address:l.deposit_address,tx_hash:l.tx_hash??null,explorer_url:explorer(t.direction,l.tx_hash),status:l.send_status}))};
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
   return true;
  });
  if(!done)return null;
  const fresh=proposals.row(p.id);
  const result={trade_id:tradeId,proposal_id:p.id,direction:p.direction,status:'requote_required',legs:[],requote:proposals.view(fresh,revision)};
  db.prepare('UPDATE trades SET result_json=? WHERE id=?').run(JSON.stringify(result),tradeId);
  return {...result,confirm:proposals.mint(fresh,revision,ctx.accountId,ctx.clientId)};
 }

 return {
  answer,
  async execute(ctx,{proposal_id,revision,confirm}){
   const started=now();
   const code=codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision});
   if(code.used)return answer(code.trade_id);
   checkKillSwitch(limits);
   if(!limits.live)refuse('TRADING_PAUSED','YEET_LIVE is not set');
   const p=proposals.row(proposal_id);
   if(p.status!=='proposed'||p.revision!==revision){const prior=existingTrade(p.id);if(prior)return answer(prior);refuse('CONFIRMATION_REQUIRED','revision is not current')}
   const legs=proposals.legsOf(p.id,revision);
   if(quoteHash(p.id,revision,legs)!==code.quote_sha256)refuse('CONFIRMATION_REQUIRED','quote changed');
   const w=await wallets.require(ctx.accountId,{refresh:signer.kind==='delegated'});
   const chain=p.direction==='yeet'?'base':'solana';
   if(w[chain].signerState!=='granted'||!w[chain].walletId)refuse('WALLET_NOT_READY',`${chain} signer not granted`);
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
   if(p.direction==='skeet'){
    for(const [i,l] of live.legs.entries()){
     const src=held.find(h=>h.mint===proposals.mintOf(l.origin.symbol));
     if(!src||src.raw<BigInt(legs[i].amount_in_raw))refuse('BALANCE_LOW');
    }
   }
   // Requote rule (plan 2.3 / risk 2).
   const previewAge=now()-Math.min(...legs.map(l=>l.quoted_at));
   const worse=live.legs.length!==legs.length||live.legs.some((l,i)=>l.amountIn!==legs[i].amount_in_raw||BigInt(l.amountOut)<BigInt(legs[i].dry_min_out_raw)
    ||(previewAge>PREVIEW_STALE_MS&&BigInt(l.amountOut)<BigInt(legs[i].dry_out_raw)));
   if(worse){
    const r=await requote(ctx,{p,legs,live,confirm});
    if(r)return r;
    return answer(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id);
   }
   checkCost(limits,proposals.legsCost(proposals.legRows(live)));

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
    const ins=db.prepare('INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)');
    for(const l of live.legs)ins.run(tradeId,l.index,l.symbol,l.amountIn,l.depositAddress,l.depositMemo??null,JSON.stringify(l),'not_sent',JSON.stringify(receiptLeg(l)),t);
    return true;
   });
   if(!committed)return answer(codes.check({code:confirm,accountId:ctx.accountId,clientId:ctx.clientId,proposalId:proposal_id,revision}).trade_id);

   // Send: one exact transfer per leg, in order, within the time budget. A failed leg does not stop the others.
   let lastError;
   const wallet=w[chain];
   for(const l of live.legs){
    if(now()-started>budgetMs)break;
    try{
     const idempotencyKey=legIdempotencyKey(wallet.walletId,tradeId,l.index);
     const {txHash}=p.direction==='yeet'
      ?await signer.transferUsdcBase({walletId:wallet.walletId,from:wallet.address,to:l.depositAddress,amountRaw:l.amountIn,idempotencyKey})
      :await (async()=>{const mint=proposals.mintOf(l.origin.symbol),src=held.find(h=>h.mint===mint);
        return signer.transferSpl({walletId:wallet.walletId,owner:wallet.address,source:src.tokenAccount,destinationOwner:l.depositAddress,mint,decimals:l.origin.decimals,amountRaw:l.amountIn,tokenProgram:src.tokenProgram,idempotencyKey})})();
     db.prepare("UPDATE trade_legs SET send_status='sent',tx_hash=?,updated_at=? WHERE trade_id=? AND idx=?").run(txHash,now(),tradeId,l.index);
     try{tracker.apply(tradeId,l.index,await client.submitDeposit(l.depositAddress,txHash,l.depositMemo))}
     catch{/* the status loop finds the deposit without the hint */}
    }catch(e){
     lastError=e instanceof TradeError?e.code:'TEMPORARILY_UNAVAILABLE';
     db.prepare("UPDATE trade_legs SET send_status='failed',updated_at=? WHERE trade_id=? AND idx=?").run(now(),tradeId,l.index);
    }
   }
   // Unsent amounts never left the wallet: give them back to today's allowance.
   const sentRows=legsOf(tradeId);
   const unsent=sentRows.filter(l=>l.send_status!=='sent').reduce((a,l)=>a+BigInt(l.amount_in_raw),0n);
   const anySent=sentRows.some(l=>l.send_status==='sent');
   tx(db,()=>{
    if(p.direction==='yeet'&&unsent>0n)recordSpend(db,ctx.accountId,t,-unsent);
    db.prepare('UPDATE proposals SET status=?,updated_at=? WHERE id=?').run(anySent?'executed':'failed',now(),p.id);
   });
   tracker.refresh(tradeId);
   if(!anySent){
    const code=lastError??'TEMPORARILY_UNAVAILABLE';
    db.prepare('UPDATE trades SET result_json=? WHERE id=?').run(JSON.stringify({error:code}),tradeId);
    refuse(code,'no leg was sent');
   }
   return answer(tradeId);
  },
 };

}

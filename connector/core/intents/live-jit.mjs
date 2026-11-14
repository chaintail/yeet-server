// `--live` steps of the balance model (docs/INTENTS-BALANCE-MODEL.md): balances stay inside intents.near, the solver
// holds USDC and sources coins just in time. Same rules as live.mjs: one step per run, resumable from the state file,
// JSON lines without any key, a final line with `stage:"result"` and the seconds of every phase.
//   --solver-usdc <amount>     USDC into the solver's verifier account (same-asset 1Click deposit from the wallet)
//   --jit-buy                  the user signs first; the solver sources (inside or outside), simulates, executes
//   --jit-sell                 the reverse: the solver pays USDC at once, then unloads the coin and passes the surplus on
//   --unload                   the solver sells every coin it holds back to USDC inside the verifier
//   --withdraw-user --coin X   the user's whole balance of one token to Solana through the Omni bridge
//   --refill                   the solver's USDC from the verifier back to the wallet on Solana
import {basketCoins,splitEven} from './basket.mjs';
import {fundVia1Click,quoteFunding} from './funding.mjs';
import {buildFunctionCall} from './near-tx.mjs';
import {signerStorageNeeded} from './omni.mjs';
import {signIntents,omniWithdrawToSolana,tokenDiff} from './intents.mjs';
import {nep413Signer,intentHash} from './sign.mjs';
import {quoteInternal,sourcingIntents,transferIntent,buyFloors,settleBuy,sellDiffs,sellSurplus,solverLoss,signUserDiff,signSolverSettle} from './jit.mjs';
import {VERIFIER,EXECUTE_GAS,USDC_SOL_TOKEN_ID} from './constants.mjs';
import {sendNearOnce,usdcRaw,fund,bridgeFees,solanaBalances,near,USDC_COIN} from './live.mjs';

const iso=ms=>new Date(ms).toISOString();
const secs=ms=>ms==null?null:Math.round(ms/100)/10;
const TERMINAL=['SUCCESS','REFUNDED','FAILED'];
const execute=(ctx,signed)=>buildFunctionCall({rpc:ctx.rpc,near:ctx.near,receiverId:VERIFIER,method:'execute_intents',args:{signed},gas:EXECUTE_GAS});
const settledOk=st=>st.ok===true&&st.logs.some(l=>l.includes('"event":"intents_executed"'));
/** A finished slot is filed away under `<key>_done` so that the same step can run again as a new operation. */
function freshSlot(state,key,{archive}){
 const cur=state.steps[key];
 if(cur?.done&&archive){(state.steps[`${key}_done`]??=[]).push(cur);delete state.steps[key]}
 const slot=(state.steps[key]??={});
 slot.at??={};slot.ms??={};
 return slot;
}

/**
 * Pays committed quotes that take their deposit INSIDE the verifier: the solver signs ONE payload with a `transfer`
 * intent per quote, our NEAR account executes it, 1Click is told the transaction hash, and the destination balances
 * are watched until every leg is delivered, 1Click reports a refund or failure, or `untilMs` passes.
 * `run` = this operation's state ({fund:{…}, before:{tokenId: raw}}); `legs` = [{symbol, originAsset,
 * destinationAsset, quote:{depositAddress, amountIn, minAmountOut}}] (strings); each gets `sourced` (raw, string),
 * `status` and `sourcing_ms` written to it. Returns {ok, legs, reason?}.
 */
export async function payInside(ctx,run,label,legs,{untilMs}){
 const {near:n,verifier,client,emit,save,now,sleep,opts}=ctx;
 const solver=nep413Signer(n.key),dests=[...new Set(legs.map(l=>l.destinationAsset))];
 run.fund??={};
 if(!run.fund.tx_hash){
  const saltHex=await verifier.currentSalt();
  const {signed}=await signIntents(solver,{intents:sourcingIntents(legs.map(l=>({originAsset:l.originAsset,quote:l.quote}))),deadlineMs:now()+Math.max(opts.deadlineS,120)*1000,saltHex});
  const sim=await verifier.simulate([signed]);
  if(!sim.ok){emit({step:label,stage:'sourcing_refused',outcome:sim.code,contract_says:sim.message??null});return {ok:false,legs,reason:`the sourcing transfer does not simulate: ${sim.code}`}}
  const bal=await verifier.balances(n.accountId,dests);
  run.before=Object.fromEntries(dests.map((d,i)=>[d,bal[i].toString()]));
  run.signed=signed;save();
 }
 const st=await sendNearOnce(ctx,run.fund,`${label}_fund`,()=>execute(ctx,[run.signed]));
 if(!settledOk(st))return {ok:false,legs,reason:st.ok===false?'the sourcing transfer failed on NEAR: nothing was paid':'the sourcing transfer has no outcome yet; run the step again'};
 const t0=Date.parse(run.fund.at.submitted??run.fund.at.included);
 if(!run.notified){
  // optional by the API's own description; it only saves 1Click the time to notice the transfer
  await Promise.all(legs.map(l=>client.submitDeposit(l.quote.depositAddress,run.fund.tx_hash).catch(e=>emit({step:label,stage:'deposit_submit_refused',symbol:l.symbol,message:String(e?.message??e).slice(0,160)}))));
  run.notified=true;save();
 }
 const alone=l=>legs.filter(x=>x.destinationAsset===l.destinationAsset).length===1;
 for(;;){
  const [bal,statuses]=await Promise.all([verifier.balances(n.accountId,dests),Promise.all(legs.map(l=>l.sourced||TERMINAL.includes(l.status)?null:client.status(l.quote.depositAddress).catch(()=>null)))]);
  legs.forEach((l,i)=>{
   if(l.sourced)return;
   const s=statuses[i];
   if(s&&s.status!==l.status){l.status=s.status;emit({step:label,stage:'oneclick_status',symbol:l.symbol,status:s.status,at:iso(now())})}
   const delta=bal[dests.indexOf(l.destinationAsset)]-BigInt(run.before[l.destinationAsset]);
   const reported=s?.status==='SUCCESS'&&/^\d+$/.test(String(s.swapDetails?.amountOut??''))?BigInt(s.swapDetails.amountOut):null;
   // the verifier balance is the proof; 1Click's own figure is used only when several legs pay into one token
   const got=alone(l)?(delta>=BigInt(l.quote.minAmountOut)?delta:null):(reported!==null&&delta>=reported?reported:null);
   if(got!==null){l.sourced=got.toString();l.sourcing_ms=now()-t0;l.status='SUCCESS';emit({step:label,stage:'sourced',symbol:l.symbol,amount:l.sourced,min_amount_out:l.quote.minAmountOut,seconds:secs(l.sourcing_ms)})}
  });
  save();
  if(legs.every(l=>l.sourced||['REFUNDED','FAILED'].includes(l.status)))break;
  if(now()>=untilMs)break;
  await sleep(1500);
 }
 const ok=legs.every(l=>l.sourced);
 return {ok,legs,reason:ok?null:`not sourced in time: ${legs.filter(l=>!l.sourced).map(l=>`${l.symbol} (${l.status??'no status'})`).join(', ')}`};
}

/**
 * OUTSIDE sourcing: each leg is a 1Click quote paid with USDC on Solana from the wallet, the coin delivered to the
 * solver's verifier account (`recipientType: INTENTS`). `slotLegs[i].out` holds the funding state with the quote
 * already taken. The legs run in parallel; each gets `sourced` and `sourcing_ms` (Solana send to credited).
 */
export async function payOutside(ctx,run,label,legs,{untilMs}){
 const {near:n,verifier,emit,save,now,sleep}=ctx;
 const dests=legs.map(l=>l.destinationAsset);
 if(!run.before){const bal=await verifier.balances(n.accountId,dests);run.before=Object.fromEntries(dests.map((d,i)=>[d,bal[i].toString()]));save()}
 const results=await Promise.allSettled(legs.map(l=>fundVia1Click({label:`${label}_${l.symbol}`,state:l.out,save,client:ctx.client,rpc:ctx.sol,signatureStatus:ctx.signatureStatus,wallet:ctx.wallet.solana,feePayer:ctx.feePayer,
  request:{destinationAsset:l.destinationAsset,amount:l.quote.amountIn,recipient:n.accountId,recipientType:'INTENTS'},emit,now,sleep,waitMs:Math.max(0,untilMs-now()),
  watch:{read:async()=>(await verifier.balances(n.accountId,[l.destinationAsset]))[0]}})));
 results.forEach((r,i)=>{if(r.status==='rejected')emit({step:label,stage:'outside_leg_failed',symbol:legs[i].symbol,message:String(r.reason?.message??r.reason).slice(0,240)})});
 const bal=await verifier.balances(n.accountId,dests);
 legs.forEach((l,i)=>{
  l.status=l.out.status??null;
  const delta=bal[i]-BigInt(run.before[l.destinationAsset]);
  if(!l.sourced&&delta>=BigInt(l.quote.minAmountOut)){
   const sent=Date.parse(l.out.at?.transfer_sent??''),done=Date.parse(l.out.at?.oneclick_success??'')||now();
   l.sourced=delta.toString();l.sourcing_ms=Number.isFinite(sent)?done-sent:null;
   emit({step:label,stage:'sourced',symbol:l.symbol,amount:l.sourced,min_amount_out:l.quote.minAmountOut,seconds:secs(l.sourcing_ms),solana_tx:l.out.solana_tx??null});
  }
 });
 save();
 const ok=legs.every(l=>l.sourced);
 return {ok,legs,reason:ok?null:`not sourced in time: ${legs.filter(l=>!l.sourced).map(l=>`${l.symbol} (${l.status??'no status'})`).join(', ')}`};
}

// ---- solver float ----
export async function stepSolverUsdc(ctx){
 const {near:n,verifier,emit,opts,state}=ctx;
 const all=(state.steps.solver_usdc??={});
 if(opts.newTrade&&TERMINAL.includes(all[opts.solverUsdc]?.status)){(state.steps.solver_usdc_done??=[]).push(all[opts.solverUsdc]);delete all[opts.solverUsdc]}
 const slot=(all[opts.solverUsdc]??={});
 const [before]=await verifier.balances(n.accountId,[USDC_SOL_TOKEN_ID]);
 await fund(ctx,'solver_usdc',slot,{destinationAsset:USDC_SOL_TOKEN_ID,amount:usdcRaw(opts.solverUsdc),recipient:n.accountId,recipientType:'INTENTS'});
 const [after]=await verifier.balances(n.accountId,[USDC_SOL_TOKEN_ID]);
 const sent=Date.parse(slot.at?.transfer_sent??''),done=Date.parse(slot.at?.oneclick_success??'');
 emit({step:'solver_usdc',stage:'result',solver_verifier_account:n.accountId,status:slot.status??null,status_source:slot.status_source??'oneclick',usdc_balance_before_this_run:before.toString(),usdc_balance:after.toString(),
  seconds:{solana_send_to_credited:Number.isFinite(sent)&&Number.isFinite(done)?secs(done-sent):null},timestamps:slot.at??{},ok:slot.status==='SUCCESS'&&after>0n});
}

// ---- buy ----
export async function stepJitBuy(ctx){
 const {near:n,user,verifier,client,emit,opts,state,save,now}=ctx;
 const slot=freshSlot(state,'jit_buy',{archive:opts.newTrade});
 if(slot.done){const again={...slot.result,replayed:true};emit(again);return again}
 const solver=nep413Signer(n.key);
 const coins=basketCoins(slot.coins??opts.coins),tokens=[USDC_SOL_TOKEN_ID,...coins.map(c=>c.tokenId)];
 const finish=r=>{slot.done=true;slot.result=r;save();emit(r);return r};
 const refuse=(reason,extra={})=>{emit({step:'jit_buy',stage:'refused',reason,...extra});return {ok:false}};

 // ---- 1. firm quotes, then the user's signature ----
 if(!slot.user_signed){
  const usdc=usdcRaw(opts.usdc),source=opts.source;
  if(user.accountId===n.accountId)return refuse('the user and the solver are the same account');
  const [saltHex,feePips,ub,sb]=await Promise.all([verifier.currentSalt(),verifier.fee(),verifier.balances(user.accountId,tokens),verifier.balances(n.accountId,tokens)]);
  if(ub[0]<usdc)return refuse('the user verifier account holds less USDC than the trade spends',{have:ub[0].toString(),need:usdc.toString(),fix:'--deposit-user'});
  if(source==='inside'&&sb[0]<usdc)return refuse('the solver verifier account holds less USDC than it must spend on sourcing',{have:sb[0].toString(),need:usdc.toString(),fix:'--solver-usdc'});
  const t0=now(),usdcIns=splitEven(usdc,coins.length);
  const legs=await Promise.all(coins.map(async(c,i)=>{
   if(source==='inside'){
    const q=await quoteInternal({client,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:c.tokenId,amount:usdcIns[i],account:n.accountId,dry:false,slippageBps:opts.sourceSlippageBps,deadlineMs:now()+10*60_000});
    return {symbol:c.symbol,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:c.tokenId,usdc_in:usdcIns[i].toString(),time_estimate_s:q.timeEstimate,
     quote:{depositAddress:q.depositAddress,amountIn:q.amountIn.toString(),amountOut:q.amountOut.toString(),minAmountOut:q.minAmountOut.toString(),correlationId:q.correlationId}};
   }
   const q=await quoteFunding({client,wallet:ctx.wallet.solana,request:{destinationAsset:c.tokenId,amount:usdcIns[i],recipient:n.accountId,recipientType:'INTENTS'},slippageBps:opts.sourceSlippageBps,now});
   return {symbol:c.symbol,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:c.tokenId,usdc_in:usdcIns[i].toString(),time_estimate_s:q.timeEstimate,quote:{depositAddress:q.depositAddress,amountIn:q.amountIn,amountOut:q.amountOut,minAmountOut:q.minAmountOut,correlationId:q.correlationId},
    out:{quote:q,at:{quoted:iso(now())}}};
  }));
  const t1=now();
  const floors=buyFloors({legs:legs.map(l=>({symbol:l.symbol,tokenId:l.destinationAsset,usdcIn:l.usdc_in,minOut:l.quote.minAmountOut})),feePips,marginBps:opts.marginBps});
  const loss=solverLoss({spentUsdc:floors.usdc.userGives,receivesUsdc:floors.usdc.solverReceives,maxLossBps:opts.maxLossBps});
  if(!loss.ok)return refuse('the solver would lose more than --max-loss-bps on the USDC leg',{loss:loss.loss.toString(),limit:loss.limit.toString()});
  const deadlineMs=now()+opts.deadlineS*1000;
  const t2=now();
  const u=await signUserDiff(user,{diff:floors.userDiff,deadlineMs,saltHex});
  const t3=now();
  // the user's payload alone must pass every check and stop only at the missing counterparty, before a cent is spent
  const pre=await verifier.simulate([u.signed]);
  if(pre.code!=='INVARIANT_VIOLATED')return refuse('the user payload does not simulate',{outcome:pre.ok?'PASSED':pre.code,contract_says:pre.message??null});
  floors.legs.forEach((f,i)=>{legs[i].user_floor=f.userFloor.toString();legs[i].must_give=f.mustGive.toString()});
  Object.assign(slot,{source,coins:coins.map(c=>c.symbol).join(','),usdc_in:usdc.toString(),fee_pips:feePips,margin_bps:opts.marginBps,legs,user_signed:u.signed,user_account:user.accountId,user_standard:user.standard,
   deadline:u.deadline,deadline_ms:deadlineMs,started_ms:t0,before:{user:ub.map(String),solver:sb.map(String)},run:{}});
  Object.assign(slot.ms,{quote:t1-t0,user_signature:t3-t2});Object.assign(slot.at,{started:iso(t0),quoted:iso(t1),user_signed:iso(t3)});
  save();
  emit({step:'jit_buy',stage:'user_signed',source,user_account:user.accountId,user_standard:user.standard,deadline:u.deadline,user_intent_hash:intentHash(u.signed),seconds:{quote:secs(slot.ms.quote),user_signature:secs(slot.ms.user_signature)},
   legs:legs.map(l=>({symbol:l.symbol,usdc_in:l.usdc_in,quoted_out:l.quote.amountOut,min_out:l.quote.minAmountOut,user_signs_for_at_least:l.user_floor,deposit:l.quote.depositAddress,time_estimate_s:l.time_estimate_s}))});
 }
 const legs=slot.legs,limit=slot.deadline_ms-opts.minLeftS*1000;
 const holds=async()=>{const b=await verifier.balances(n.accountId,tokens);return Object.fromEntries(['USDC',...coins.map(c=>c.symbol)].map((s,i)=>[s,(b[i]-BigInt(slot.before.solver[i])).toString()]))};
 const notExecuted=async reason=>finish({step:'jit_buy',stage:'result',ok:false,executed:false,source:slot.source,reason,user_moved:'nothing: the user intent was not executed and expires at its deadline',deadline:slot.deadline,
  solver_delta_since_start:await holds(),legs:legs.map(l=>({symbol:l.symbol,status:l.status??null,sourced:l.sourced??null})),fix:'--unload sells what the solver bought back to USDC; a leg 1Click refunds returns by itself',
  seconds:{quote:secs(slot.ms.quote),user_signature:secs(slot.ms.user_signature),sourcing:Object.fromEntries(legs.map(l=>[l.symbol,secs(l.sourcing_ms)]))},timestamps:slot.at});

 // ---- 2. sourcing ----
 if(!slot.settle?.tx_hash){
  if(!legs.every(l=>l.sourced)){
   const started=slot.run.fund?.tx_hash||legs.some(l=>l.out?.solana_tx);
   if(!started&&now()>=limit)return notExecuted('the user deadline was too close before sourcing started; nothing was bought');
   slot.at.sourcing_started??=iso(now());save();
   const r=slot.source==='inside'?await payInside(ctx,slot.run,'jit_buy',legs,{untilMs:limit}):await payOutside(ctx,slot.run,'jit_buy',legs,{untilMs:limit});
   slot.at.sourcing_ended=iso(now());save();
   if(!r.ok)return notExecuted(r.reason);
  }
  // ---- 3. settle: only what was really sourced, only inside the deadline ----
  if(now()>=limit)return notExecuted('sourcing finished too close to the user deadline');
  const floors={userDiff:Object.fromEntries([[USDC_SOL_TOKEN_ID,-BigInt(slot.usdc_in)],...legs.map(l=>[l.destinationAsset,BigInt(l.user_floor)])]),
   legs:legs.map(l=>({symbol:l.symbol,tokenId:l.destinationAsset,userFloor:BigInt(l.user_floor),mustGive:BigInt(l.must_give)}))};
  const bal=await verifier.balances(n.accountId,coins.map(c=>c.tokenId));
  // never give more than the solver holds now, whatever was reported as sourced
  const sourced=legs.map((l,i)=>BigInt(l.sourced)<bal[i]?BigInt(l.sourced):bal[i]);
  const settle=settleBuy({floors,sourced,feePips:slot.fee_pips,marginBps:slot.margin_bps});
  if(!settle.ok)return notExecuted(`a leg delivered less than the user was promised: ${settle.short.map(s=>s.symbol).join(', ')}`);
  const s=await signSolverSettle(solver,{solverDiff:settle.solverDiff,surplus:settle.surplus,userAccount:slot.user_account,deadlineMs:slot.deadline_ms,saltHex:await verifier.currentSalt()});
  const signed=[s.signed,slot.user_signed];
  const ts=now(),sim=await verifier.simulate(signed);
  slot.ms.simulate=now()-ts;
  emit({step:'jit_buy',stage:'simulated',ok:sim.ok,outcome:sim.ok?'PASSED':sim.code,contract_says:sim.message??null,seconds:secs(slot.ms.simulate),
   legs:settle.legs.map(l=>({symbol:l.symbol,sourced:l.sourced.toString(),user_receives:l.userReceives.toString(),solver_keeps:l.solverKeeps.toString()}))});
  if(!sim.ok)return notExecuted(`the settlement does not simulate: ${sim.code}`);
  slot.signed=signed;slot.settle_legs=settle.legs.map(l=>({symbol:l.symbol,sourced:l.sourced.toString(),user_receives:l.userReceives.toString(),solver_keeps:l.solverKeeps.toString()}));
  slot.intent_hashes={solver:intentHash(signed[0]),user:intentHash(signed[1])};slot.settle={};save();
 }
 const st=await sendNearOnce(ctx,slot.settle,'jit_buy',()=>execute(ctx,slot.signed));
 if(st.ok===null){emit({step:'jit_buy',stage:'pending',tx_hash:slot.settle.tx_hash,note:'the NEAR transaction has no outcome yet; run --jit-buy again'});return {ok:false}}
 if(!settledOk(st))return notExecuted(`execute_intents failed: ${JSON.stringify(st.failure??null).slice(0,200)}`);
 const [ua,sa]=await Promise.all([verifier.balances(slot.user_account,tokens),verifier.balances(n.accountId,tokens)]);
 const names=['USDC',...coins.map(c=>c.symbol)],delta=(a,b)=>Object.fromEntries(names.map((s,i)=>[s,(a[i]-BigInt(b[i])).toString()]));
 const userDelta=delta(ua,slot.before.user),solverDelta=delta(sa,slot.before.solver);
 const balancesOk=userDelta.USDC===`-${slot.usdc_in}`&&slot.settle_legs.every(l=>userDelta[l.symbol]===l.user_receives);
 const exec=Date.parse(slot.settle.at.executed)-Date.parse(slot.settle.at.submitted),total=Date.parse(slot.settle.at.executed)-slot.started_ms;
 return finish({step:'jit_buy',stage:'result',ok:balancesOk,executed:true,source:slot.source,tx_hash:slot.settle.tx_hash,sourcing_tx_hash:slot.run.fund?.tx_hash??null,user_standard:slot.user_standard,
  user_delta:userDelta,solver_delta:solverDelta,legs:slot.settle_legs,gas_burnt:{settle:st.gasBurnt??null},
  seconds:{quote:secs(slot.ms.quote),user_signature:secs(slot.ms.user_signature),sourcing:Object.fromEntries(legs.map(l=>[l.symbol,secs(l.sourcing_ms)])),
   sourcing_all:secs(Date.parse(slot.at.sourcing_ended)-Date.parse(slot.at.sourcing_started)),simulate:secs(slot.ms.simulate),execute:secs(exec),total:secs(total)},
  timestamps:{...slot.at,settle:slot.settle.at}});
}

// ---- sell ----
export async function stepJitSell(ctx){
 const {near:n,user,verifier,client,emit,opts,state,save,now}=ctx;
 const slot=freshSlot(state,'jit_sell',{archive:opts.newTrade});
 if(slot.done){const again={...slot.result,replayed:true};emit(again);return again}
 const solver=nep413Signer(n.key);
 const coin=basketCoins(slot.coin??opts.coin)[0],tokens=[USDC_SOL_TOKEN_ID,coin.tokenId];
 const refuse=(reason,extra={})=>{emit({step:'jit_sell',stage:'refused',reason,...extra});return {ok:false}};
 if(!slot.settle?.tx_hash){
  // a signed sell that was never sent and has expired starts over
  if(slot.signed&&slot.deadline_ms<=now()){for(const k of Object.keys(slot))delete slot[k];slot.at={};slot.ms={}}
  const [saltHex,feePips,ub,sb]=await Promise.all([verifier.currentSalt(),verifier.fee(),verifier.balances(user.accountId,tokens),verifier.balances(n.accountId,tokens)]);
  const amount=ub[1]*BigInt(opts.percent)/100n;
  if(amount<=0n)return refuse(`the user holds no ${coin.symbol} inside the verifier`,{fix:'--jit-buy'});
  const t0=now(),pre=sellDiffs({coin,amount,feePips});
  const q=await quoteInternal({client,originAsset:coin.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,amount:pre.solverReceivesCoin,account:n.accountId,dry:false,slippageBps:opts.sourceSlippageBps,deadlineMs:now()+10*60_000});
  const t1=now(),sd=sellDiffs({coin,amount,usdcMinOut:q.minAmountOut,feePips,marginBps:opts.marginBps});
  if(sb[0]<sd.solverPays)return refuse('the solver verifier account holds less USDC than it must pay the user',{have:sb[0].toString(),need:sd.solverPays.toString(),fix:'--solver-usdc'});
  const deadlineMs=now()+opts.deadlineS*1000;
  const t2=now(),u=await signUserDiff(user,{diff:sd.userDiff,deadlineMs,saltHex}),t3=now();
  const s=await signIntents(solver,{intents:[tokenDiff(sd.solverDiff)],deadlineMs,saltHex});
  const signed=[s.signed,u.signed];
  const ts=now(),sim=await verifier.simulate(signed);
  emit({step:'jit_sell',stage:'simulated',ok:sim.ok,outcome:sim.ok?'PASSED':sim.code,contract_says:sim.message??null,symbol:coin.symbol,user_gives:amount.toString(),solver_unloads:pre.solverReceivesCoin.toString(),
   unload_quote_usdc:q.amountOut.toString(),user_signs_for_at_least:sd.userFloor.toString(),solver_pays_first:sd.solverPays.toString(),time_estimate_s:q.timeEstimate});
  if(!sim.ok)return {ok:false};
  Object.assign(slot,{coin:coin.symbol,amount:amount.toString(),fee_pips:feePips,margin_bps:opts.marginBps,user_account:user.accountId,user_standard:user.standard,deadline:u.deadline,deadline_ms:deadlineMs,started_ms:t0,signed,
   user_floor:sd.userFloor.toString(),solver_pays:sd.solverPays.toString(),before:{user:ub.map(String),solver:sb.map(String)},settle:{},run:{},
   legs:[{symbol:coin.symbol,originAsset:coin.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,quote:{depositAddress:q.depositAddress,amountIn:q.amountIn.toString(),amountOut:q.amountOut.toString(),minAmountOut:q.minAmountOut.toString(),correlationId:q.correlationId}}]});
  Object.assign(slot.ms,{quote:t1-t0,user_signature:t3-t2,simulate:now()-ts});Object.assign(slot.at,{started:iso(t0),quoted:iso(t1),user_signed:iso(t3)});
  save();
 }
 const st=await sendNearOnce(ctx,slot.settle,'jit_sell',()=>execute(ctx,slot.signed));
 if(st.ok===null){emit({step:'jit_sell',stage:'pending',tx_hash:slot.settle.tx_hash,note:'the NEAR transaction has no outcome yet; run --jit-sell again'});return {ok:false}}
 if(!settledOk(st)){
  const r={step:'jit_sell',stage:'result',ok:false,executed:false,tx_hash:slot.settle.tx_hash,reason:'execute_intents failed: nothing was swapped',failure:st.failure};
  slot.done=true;slot.result=r;save();emit(r);return r;
 }
 // ---- the user is paid; now the solver unloads the coin it received ----
 const r=await payInside(ctx,slot.run,'jit_sell_unload',slot.legs,{untilMs:now()+opts.followS*1000});
 let extra=0n;
 if(r.ok){
  extra=sellSurplus({unloaded:BigInt(slot.legs[0].sourced),solverPays:slot.solver_pays,marginBps:slot.margin_bps});
  if(extra>0n){
   slot.surplus??={};
   if(!slot.surplus.tx_hash&&!slot.surplus_signed){
    slot.surplus_signed=(await signIntents(solver,{intents:[transferIntent({receiverId:slot.user_account,tokens:{[USDC_SOL_TOKEN_ID]:extra}})],deadlineMs:now()+Math.max(opts.deadlineS,120)*1000,saltHex:await verifier.currentSalt()})).signed;save();
   }
   const s2=await sendNearOnce(ctx,slot.surplus,'jit_sell_surplus',()=>execute(ctx,[slot.surplus_signed]));
   if(!settledOk(s2))extra=-1n;
  }
 }
 const [ua,sa]=await Promise.all([verifier.balances(slot.user_account,tokens),verifier.balances(n.accountId,tokens)]);
 const delta=(a,b)=>({USDC:(a[0]-BigInt(b[0])).toString(),[coin.symbol]:(a[1]-BigInt(b[1])).toString()});
 const exec=Date.parse(slot.settle.at.executed)-Date.parse(slot.settle.at.submitted);
 const result={step:'jit_sell',stage:'result',ok:r.ok&&extra>=0n,executed:true,tx_hash:slot.settle.tx_hash,unload_tx_hash:slot.run.fund?.tx_hash??null,surplus_tx_hash:slot.surplus?.tx_hash??null,symbol:coin.symbol,user_standard:slot.user_standard,
  user_gave:slot.amount,user_paid_at_once:slot.user_floor,unloaded_usdc:slot.legs[0].sourced??null,surplus_to_user:extra>0n?extra.toString():'0',unload:r.ok?'done':r.reason,
  user_delta:delta(ua,slot.before.user),solver_delta:delta(sa,slot.before.solver),
  seconds:{quote:secs(slot.ms.quote),user_signature:secs(slot.ms.user_signature),simulate:secs(slot.ms.simulate),execute:secs(exec),user_paid_after:secs(Date.parse(slot.settle.at.executed)-slot.started_ms),unload:secs(slot.legs[0].sourcing_ms)},
  timestamps:{...slot.at,settle:slot.settle.at}};
 if(r.ok&&extra>=0n){slot.done=true;slot.result=result;save()}
 emit(result);
 return result;
}

// ---- unload: every coin the solver holds, back to USDC inside the verifier ----
export async function stepUnload(ctx){
 const {near:n,verifier,client,emit,opts,state,save,now}=ctx;
 const slot=freshSlot(state,'unload',{archive:true});
 if(!slot.legs){
  const coins=basketCoins(opts.coins),bal=await verifier.balances(n.accountId,coins.map(c=>c.tokenId));
  const held=coins.map((c,i)=>({...c,amount:bal[i]})).filter(c=>c.amount>0n);
  if(!held.length){const none={step:'unload',stage:'result',ok:true,nothing_to_unload:true,account:n.accountId};emit(none);delete state.steps.unload;return none}
  const quotes=await Promise.allSettled(held.map(c=>quoteInternal({client,originAsset:c.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,amount:c.amount,account:n.accountId,dry:false,slippageBps:opts.sourceSlippageBps,deadlineMs:now()+10*60_000})));
  quotes.forEach((q,i)=>{if(q.status==='rejected')emit({step:'unload',stage:'no_quote',symbol:held[i].symbol,amount:held[i].amount.toString(),message:String(q.reason?.message??q.reason).slice(0,160)})});
  slot.legs=held.flatMap((c,i)=>quotes[i].status!=='fulfilled'?[]:[{symbol:c.symbol,originAsset:c.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,
   quote:{depositAddress:quotes[i].value.depositAddress,amountIn:quotes[i].value.amountIn.toString(),amountOut:quotes[i].value.amountOut.toString(),minAmountOut:quotes[i].value.minAmountOut.toString()}}]);
  if(!slot.legs.length){delete state.steps.unload;emit({step:'unload',stage:'result',ok:false,reason:'1Click quoted none of the coins'});return {ok:false}}
  slot.run={};save();
 }
 const r=await payInside(ctx,slot.run,'unload',slot.legs,{untilMs:now()+opts.followS*1000});
 const [usdc]=await verifier.balances(n.accountId,[USDC_SOL_TOKEN_ID]);
 const result={step:'unload',stage:'result',ok:r.ok,tx_hash:slot.run.fund?.tx_hash??null,legs:slot.legs.map(l=>({symbol:l.symbol,sold:l.quote.amountIn,usdc:l.sourced??null,status:l.status??null,seconds:secs(l.sourcing_ms)})),solver_usdc_balance:usdc.toString(),reason:r.reason};
 if(r.ok||slot.legs.every(l=>l.sourced||['REFUNDED','FAILED'].includes(l.status))){slot.done=true;slot.result=result;save()}
 emit(result);
 return result;
}

// ---- one token out to Solana through the Omni bridge, timed ----
/**
 * `who` 'user' or 'solver' withdraws `amount` (null: the whole balance) of `coin` to the Solana recipient. One signed
 * payload with one `ft_withdraw`; the bridge fee comes from the NEAR account's storage balance on omni.bridge.near.
 * Follows the token to the recipient's Solana account for --follow-s seconds.
 */
export async function withdrawOne(ctx,{who,coin,amount=null,key,label}){
 const {near:n,user,recipient,verifier,omni,emit,opts,state,save,now,sleep}=ctx;
 const signer=who==='solver'?nep413Signer(n.key):user;
 const slot=freshSlot(state,key,{archive:true});
 if(!slot.tx_hash){
  const [bal]=await verifier.balances(signer.accountId,[coin.tokenId]);
  const amt=amount===null?bal:BigInt(amount);
  if(amt<=0n||amt>bal){emit({step:label,stage:'result',ok:amt<=0n,nothing_to_withdraw:amt<=0n,reason:amt>bal?'the account holds less than the amount asked':null,account:signer.accountId,symbol:coin.symbol,balance:bal.toString()});delete state.steps[key];return {ok:amt<=0n}}
  const [[fee],sb,req,saltHex,[solBefore]]=await Promise.all([bridgeFees(ctx,[coin],recipient,[amt]),omni.storageBalance(n.accountId),omni.storageRequirements(),verifier.currentSalt(),solanaBalances(ctx,recipient,[coin])]);
  const need=signerStorageNeeded({nativeFees:[fee.nativeFee],transferStorage:req.transfer,feeMode:'signer'});
  if(!sb||sb.available<need){emit({step:label,stage:'refused',reason:'too little storage balance on omni.bridge.near',available:near(sb?.available??0n),need:near(need),fix:'--register-omni'});delete state.steps[key];return {ok:false}}
  const {signed}=await signIntents(signer,{intents:omniWithdrawToSolana({tokenId:coin.tokenId,amount:amt,recipient,nativeFee:fee.nativeFee,feeMode:'signer'}).intents,deadlineMs:now()+Math.max(opts.deadlineS,120)*1000,saltHex});
  const sim=await verifier.simulate([signed]);
  emit({step:label,stage:'simulated',ok:sim.ok,outcome:sim.ok?'PASSED':sim.code,contract_says:sim.message??null,account:signer.accountId,symbol:coin.symbol,amount:amt.toString(),recipient,bridge_fee_near:near(fee.nativeFee),bridge_fee_usd:fee.usd});
  if(!sim.ok){delete state.steps[key];return {ok:false}}
  Object.assign(slot,{who,symbol:coin.symbol,amount:amt.toString(),recipient,signed,solana_before:solBefore.toString(),bridge_fee_usd:fee.usd});save();
 }
 const st=await sendNearOnce(ctx,slot,label,()=>execute(ctx,[slot.signed]));
 if(st.ok===null){emit({step:label,stage:'pending',tx_hash:slot.tx_hash});return {ok:false}}
 if(!st.logs.some(l=>l.includes('"event":"intents_executed"'))){const r={step:label,stage:'result',ok:false,tx_hash:slot.tx_hash,reason:'execute_intents failed: nothing left the verifier',failure:st.failure};slot.done=true;slot.result=r;save();emit(r);return r}
 let transfers=[];
 for(const t0=now();;){
  try{transfers=await omni.transfers(slot.tx_hash)}catch{}
  const [sol]=await solanaBalances(ctx,slot.recipient,[coin]);
  if(!slot.arrived&&sol-BigInt(slot.solana_before)>=BigInt(slot.amount)){slot.arrived={at:iso(now()),received:(sol-BigInt(slot.solana_before)).toString()};save()}
  if(slot.arrived||now()-t0>=opts.followS*1000)break;
  await sleep(3000);
 }
 const sub=Date.parse(slot.at.submitted),since=t=>t?secs(Date.parse(t)-sub):null;
 const result={step:label,stage:'result',ok:Boolean(slot.arrived),who,tx_hash:slot.tx_hash,symbol:slot.symbol,amount:slot.amount,recipient:slot.recipient,received_on_solana:slot.arrived?.received??null,bridge_fee_usd:slot.bridge_fee_usd,
  receipt_failed:st.ok===false?st.failure:null,seconds:{submit_to_executed:since(slot.at.executed),submit_to_arrival:since(slot.arrived?.at)},
  bridge:transfers.map(t=>({status:t.status,solana_tx:t.solanaTx,bridge_seconds:t.initialisedAt&&t.finalisedAt?t.finalisedAt-t.initialisedAt:null})),timestamps:{...slot.at,arrived:slot.arrived?.at??null},
  note:slot.arrived?null:'not on Solana yet: run the same step again to keep following (nothing is sent twice)'};
 if(slot.arrived){slot.done=true;slot.result=result;save()}
 emit(result);
 return result;
}
const coinOf=symbol=>String(symbol).toUpperCase()==='USDC'?USDC_COIN:basketCoins(symbol)[0];
export const stepWithdrawUser=ctx=>withdrawOne(ctx,{who:'user',coin:coinOf(ctx.opts.coin),key:`withdraw_user_${coinOf(ctx.opts.coin).symbol}`,label:'withdraw_user'});
/** The refill of the outside buy-in pool: the solver's USDC leaves the verifier for the wallet on Solana. */
export const stepRefill=ctx=>withdrawOne(ctx,{who:'solver',coin:USDC_COIN,amount:ctx.opts.refillUsdc?usdcRaw(ctx.opts.refillUsdc):null,key:'refill',label:'refill'});

/** `--status` addition: both accounts' whole portfolios as the verifier lists them, and the state of the JIT steps. */
export async function statusHoldings(ctx){
 const {near:n,user,verifier,emit,state}=ctx;
 const list=async a=>(await verifier.holdings(a)).map(h=>({token_id:h.tokenId,amount:h.amount.toString()}));
 const [u,s]=await Promise.all([list(user.accountId),list(n.accountId)]);
 const brief=x=>x?{done:Boolean(x.done),ok:x.result?.ok??null,executed:x.result?.executed??null,tx_hash:x.settle?.tx_hash??x.tx_hash??null}:null;
 emit({step:'status',stage:'holdings',user_verifier_account:user.accountId,user_holdings:u,solver_verifier_account:n.accountId,solver_holdings:s,
  steps:{jit_buy:brief(state.steps.jit_buy),jit_sell:brief(state.steps.jit_sell),unload:brief(state.steps.unload),refill:brief(state.steps.refill),
   solver_usdc:Object.fromEntries(Object.entries(state.steps.solver_usdc??{}).map(([k,v])=>[k,v.status??null])),finished:{jit_buy:(state.steps.jit_buy_done??[]).length,jit_sell:(state.steps.jit_sell_done??[]).length}}});
}

// `--plan`, second part: the balance model (docs/INTENTS-BALANCE-MODEL.md). Needs no secret, sends nothing.
//   surveyQuotes   dry 1Click quotes WITHOUT an API key, verifier on both sides, both directions, for each coin and
//                  trade size, next to today's chain-to-chain quote; the all-in cost table.
//   probeSourcing  one committed quote for a throwaway account (it commits nothing: nothing is ever sent to it) to
//                  read the deposit account's shape, and 1Click's own generate-intent answer for it, compared with the
//                  `transfer` intent we build ourselves.
//   runBalancePlan the user and solver payloads of a no-withdrawal buy, of a sell, of the sourcing transfer and of a
//                  withdrawal on request, signed with throwaway keys and run through `simulate_intents` up to the
//                  balance check, plus the negative cases of the just-in-time flow.
import {rawEd25519Signer,nep413Signer,throwawayEd25519,verifyMultiPayload,intentHash} from './sign.mjs';
import {tokenDiff,signIntents,omniWithdrawToSolana,receivedFor,contractOf} from './intents.mjs';
import {basketCoins,splitEven} from './basket.mjs';
import {throwawayUser} from './plan.mjs';
import {quoteInternal,sourcingIntents,transferIntent,buyFloors,settleBuy,sellDiffs,sellSurplus,solverLoss,signUserDiff,signSolverSettle,costRow} from './jit.mjs';
import {USDC_SOL_TOKEN_ID,WNEAR_TOKEN_ID,OMNI_BRIDGE,VERIFIER} from './constants.mjs';
import {omniSolanaAccounts,omniDepositInstruction,omniDepositFee,WORMHOLE_CORE} from './omni-deposit.mjs';
import {buildSelfPaidTransaction} from './funding.mjs';
import {USDC_SOLANA} from '../pipeline/solana/message.mjs';

/** NEAR our own account burns per `execute_intents` call without a bridge withdrawal. Not measured by us yet: 25
 * recent calls on mainnet (nearblocks, 2026-11-13) cost 0.00055 to 0.0011 NEAR without a withdrawal and about
 * 0.0030 with one; the table uses the higher figure for every call. */
export const GAS_NEAR_PER_CALL_BOUND=0.003;
/** NEAR calls of ours per trade: buy = sourcing transfer + settlement; sell = settlement + unload + surplus. */
export const CALLS={buy:2,sell:3};

const str=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v]));
const brief=q=>q?{amount_in:q.amountIn.toString(),amount_out:q.amountOut.toString(),min_amount_out:q.minAmountOut.toString(),amount_in_usd:q.amountInUsd,amount_out_usd:q.amountOutUsd,time_estimate_s:q.timeEstimate,app_fees:q.appFees}:null;

/**
 * Dry quotes for every coin and size. `client` must carry NO API key (the point is what works without one).
 * Emits one `quote_survey` line per coin and size and one `cost_table` line. Returns {ok, rows, checks}.
 */
export async function surveyQuotes({client,coins,sizes,feePips,emit=()=>{},now=Date.now}){
 const account=nep413Signer(throwawayEd25519()).accountId,sol=throwawayEd25519().address;
 const deadlineMs=now()+10*60_000,deadline=new Date(deadlineMs).toISOString();
 const tokens=await client.getTokens();
 const nearUsd=tokens.find(t=>t.assetId===WNEAR_TOKEN_ID)?.price;
 if(!(nearUsd>0))throw Error('no NEAR price in the 1Click token list');
 // 1Click sometimes answers "Quoting for this pair is not available" for a pair it quoted a second earlier: ask up to three times
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const tryQuote=async f=>{let error;for(let k=0;k<3;k++){try{return {q:await f()}}catch(e){error=String(e?.message??e).slice(0,160);await pause(1500)}}return {error}};
 const rows=[],checks=[];
 for(const c of coins){
  for(const size of sizes){
   const amount=BigInt(Math.round(size*1e6));
   const buy=await tryQuote(()=>quoteInternal({client,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:c.tokenId,amount,account,dry:true,deadlineMs}));
   const sell=buy.q?await tryQuote(()=>quoteInternal({client,originAsset:c.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,amount:buy.q.amountOut,account,dry:true,deadlineMs})):{error:'no buy quote'};
   const chain=await tryQuote(async()=>{
    const r=await client.quote({dry:true,swapType:'EXACT_INPUT',slippageTolerance:100,originAsset:USDC_SOL_TOKEN_ID,depositType:'ORIGIN_CHAIN',destinationAsset:c.tokenId,amount:amount.toString(),
     refundTo:sol,refundType:'ORIGIN_CHAIN',recipient:sol,recipientType:'DESTINATION_CHAIN',deadline});
    return {amountIn:BigInt(r.quote.amountIn),amountOut:BigInt(r.quote.amountOut),minAmountOut:BigInt(r.quote.minAmountOut),amountInUsd:Number(r.quote.amountInUsd),amountOutUsd:Number(r.quote.amountOutUsd),timeEstimate:r.quote.timeEstimate,appFees:r.quoteRequest?.appFees??null};
   });
   const pass=Boolean(buy.q&&sell.q);
   checks.push({name:`sourcing quote without an API key, verifier on both sides: ${c.symbol} at ${size} USDC, buy and sell`,expect:'QUOTED',got:pass?'QUOTED':'NO_QUOTE',pass,...(pass?{}:{buy_error:buy.error??null,sell_error:sell.error??null})});
   emit({step:'quote_survey',symbol:c.symbol,size_usdc:size,api_key:false,internal_buy:brief(buy.q)??{error:buy.error},internal_sell:brief(sell.q)??{error:sell.error},chain_to_chain_buy:brief(chain.q)??{error:chain.error}});
   if(pass)rows.push(costRow({symbol:c.symbol,sizeUsdc:size,ii:buy.q,back:sell.q,cc:chain.q??null,feePips,gasNear:GAS_NEAR_PER_CALL_BOUND*CALLS.buy,nearUsd}));
  }
 }
 emit({step:'cost_table',what:'all-in cost of ONE single-coin buy with every balance staying inside the verifier, per trade size, next to the same size through the chain-to-chain 1Click route',
  near_usd:nearUsd,near_gas_assumed:`${CALLS.buy} calls x ${GAS_NEAR_PER_CALL_BOUND} NEAR (upper bound, not yet measured by us)`,our_fee_bps:0,rows});
 // the live funding steps (--solver-usdc, --deposit-user, --source outside) need 1Click to take a Solana deposit right
 // now; on 2026-11-13 20:29 UTC it refused every Solana-chain quote for a while. Information for the operator, not a check.
 const dep=await tryQuote(()=>client.quote({dry:true,swapType:'EXACT_INPUT',slippageTolerance:100,originAsset:USDC_SOL_TOKEN_ID,depositType:'ORIGIN_CHAIN',destinationAsset:USDC_SOL_TOKEN_ID,amount:'4500000',
  refundTo:sol,refundType:'ORIGIN_CHAIN',recipient:account,recipientType:'INTENTS',deadline}));
 emit({step:'deposit_route',what:'1Click same-asset deposit quote, USDC on Solana into a verifier account, no API key',available:Boolean(dep.q),amount_in:'4500000',amount_out:dep.q?.quote.amountOut??null,time_estimate_s:dep.q?.quote.timeEstimate??null,
  app_fees:dep.q?.quoteRequest?.appFees??null,error:dep.error??null,if_unavailable:'the live steps that deposit from Solana through 1Click will be refused at the quote; nothing is paid'});
 return {ok:checks.every(c=>c.pass),rows,checks,nearUsd};
}

/**
 * The sourcing mechanics, read from 1Click itself: a committed quote (verifier on both sides, no API key) must name
 * a 64-hex verifier account to fund, and `POST /v0/generate-intent` for it must describe the same `transfer` intent
 * we sign ourselves. Nothing is transferred, so the quote simply lapses.
 */
export async function probeSourcing({client,coin,amount,emit=()=>{},fetch=globalThis.fetch,now=Date.now}){
 const account=nep413Signer(throwawayEd25519()).accountId;
 const checks=[];
 let q;
 try{q=await quoteInternal({client,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:coin.tokenId,amount,account,dry:false,deadlineMs:now()+10*60_000})}
 catch(e){
  const row={name:'sourcing: a committed quote without an API key names a verifier account to fund',expect:'DEPOSIT_ACCOUNT',got:'REFUSED',pass:false,message:String(e?.message??e).slice(0,200)};
  checks.push(row);emit({step:'sourcing_probe',...row});
  return {ok:false,checks};
 }
 const ours=sourcingIntents([{originAsset:USDC_SOL_TOKEN_ID,quote:q}]);
 const row={name:'sourcing: a committed quote without an API key names a verifier account to fund',expect:'DEPOSIT_ACCOUNT',got:'DEPOSIT_ACCOUNT',pass:true,deposit_account:q.depositAddress,
  amount_in:q.amountIn.toString(),amount_out:q.amountOut.toString(),min_amount_out:q.minAmountOut.toString(),time_estimate_s:q.timeEstimate,quote_deadline:q.deadline,app_fees:q.appFees,our_transfer_intent:ours[0]};
 checks.push(row);emit({step:'sourcing_probe',...row});
 // 1Click's own description of how to fund that quote; informative when the endpoint asks for a key one day
 let gen={status:null};
 try{
  const res=await fetch(`${client.baseUrl}/generate-intent`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({type:'swap_transfer',standard:'nep413',signerId:account,depositAddress:q.depositAddress}),signal:AbortSignal.timeout(20_000)});
  gen.status=res.status;
  const body=await res.json().catch(()=>null);
  const theirs=body?.intent?.payload?.message?JSON.parse(body.intent.payload.message).intents:null;
  gen.intents=theirs;
  gen.same=theirs?JSON.stringify(theirs)===JSON.stringify(ours):null;
 }catch(e){gen.error=String(e?.message??e).slice(0,160)}
 const answered=gen.status>=200&&gen.status<300;
 const row2={name:'sourcing: 1Click\'s generate-intent (no API key) describes the same transfer intent we build',expect:['SAME','KEY_REQUIRED'],got:answered?(gen.same?'SAME':'DIFFERENT'):(gen.status===401||gen.status===403?'KEY_REQUIRED':'UNAVAILABLE'),
  http_status:gen.status,their_intents:gen.intents??null,error:gen.error??null};
 row2.pass=row2.expect.includes(row2.got);
 checks.push(row2);emit({step:'sourcing_probe',...row2});
 return {ok:checks.every(c=>c.pass),checks,keylessGenerate:answered};
}

/**
 * The payloads of the balance model for one user signing standard. `deps` = {verifier, omni, client}.
 * Returns {ok, standard, checks}.
 */
export async function runBalancePlan({standard,usdc,coins:coinList='WIF,BOME,TRUMP',marginBps=0,sourceSlippageBps=100,deadlineS=120,deps,emit=()=>{},now=Date.now}){
 const {verifier,omni,client}=deps;
 const user=throwawayUser(standard),solver=nep413Signer(throwawayEd25519());
 const coins=basketCoins(coinList);
 const [saltHex,feePips]=await Promise.all([verifier.currentSalt(),verifier.fee()]);
 const deadlineMs=now()+deadlineS*1000;
 const checks=[];
 const check=async(name,signed,expect,extra)=>{
  const r=await verifier.simulate(signed);
  const got=r.ok?'PASSED':r.code;
  const row={name,expect,got,pass:[expect].flat().includes(got)&&(extra?extra(r):true),stage:r.stage??null,contract_says:r.message??null};
  if(r.output){
   row.intents_executed=(r.output.intents_executed??[]).map(e=>({account_id:e.account_id,intent_hash:e.intent_hash}));
   if(r.output.invariant_violated)row.invariant_violated=r.output.invariant_violated;
  }
  checks.push(row);emit({step:'simulate_intents',model:'balance',standard,...row});
  return r;
 };
 const local=(name,pass,extra={})=>{const row={name,expect:'TRUE',got:pass?'TRUE':'FALSE',pass,...extra};checks.push(row);emit({step:'local_check',model:'balance',standard,...row})};
 const executed=(r,list)=>{const h=(r.output?.intents_executed??[]).map(e=>e.intent_hash);return list.every(s=>h.includes(intentHash(s)))&&h.length===list.length};

 // ---- buy: floors from dry quotes with the verifier on both sides ----
 const usdcIns=splitEven(usdc,coins.length);
 const quotes=await Promise.all(coins.map((c,i)=>quoteInternal({client,originAsset:USDC_SOL_TOKEN_ID,destinationAsset:c.tokenId,amount:usdcIns[i],account:solver.accountId,dry:true,slippageBps:sourceSlippageBps,deadlineMs:now()+10*60_000})));
 const floors=buyFloors({legs:coins.map((c,i)=>({symbol:c.symbol,tokenId:c.tokenId,usdcIn:usdcIns[i],minOut:quotes[i].minAmountOut})),feePips,marginBps});
 const userBuy=await signUserDiff(user.signer,{diff:floors.userDiff,deadlineMs,saltHex});
 // the plan has no funds to source with: settle as if 1Click delivered exactly what it quoted
 const settle=settleBuy({floors,sourced:quotes.map(q=>q.amountOut),feePips,marginBps});
 const solverBuy=await signSolverSettle(solver,{solverDiff:settle.solverDiff,surplus:settle.surplus,userAccount:user.signer.accountId,deadlineMs,saltHex});
 const loss=solverLoss({spentUsdc:floors.usdc.userGives,receivesUsdc:floors.usdc.solverReceives});
 const v=await verifyMultiPayload(userBuy.signed);
 emit({step:'jit_buy_priced',standard,source:'1Click dry quotes, no API key, verifier on both sides',margin_bps:marginBps,source_slippage_bps:sourceSlippageBps,user_deadline_s:deadlineS,
  legs:floors.legs.map((l,i)=>({symbol:l.symbol,usdc_in:l.usdcIn.toString(),quoted_out:quotes[i].amountOut.toString(),min_out:l.minOut.toString(),user_signs_for_at_least:l.userFloor.toString(),
   user_receives_if_filled_at_quote:settle.legs[i].userReceives.toString(),solver_keeps:settle.legs[i].solverKeeps.toString(),time_estimate_s:quotes[i].timeEstimate})),
  user_diff:str(floors.userDiff),solver_diff:str(settle.solverDiff),surplus_to_user:str(settle.surplus),solver_usdc_loss:loss.loss.toString(),solver_usdc_loss_limit:loss.limit.toString(),
  user_payload:userBuy.signed,solver_payload:solverBuy.signed});
 const userIntents=JSON.parse(typeof userBuy.signed.payload==='string'?userBuy.signed.payload:userBuy.signed.payload.message).intents;
 local('buy: the user signs ONE token_diff and no withdrawal',userIntents.length===1&&userIntents[0].intent==='token_diff'&&v.accountId===user.signer.accountId,{intents:userIntents.map(i=>i.intent)});
 local('buy: the solver loses at most the contract fee on the USDC leg',loss.ok,{loss:loss.loss.toString(),limit:loss.limit.toString()});
 await check('buy: [solver, user] as it would be executed',[solverBuy.signed,userBuy.signed],'INSUFFICIENT_BALANCE');
 await check('buy: the user payload alone',[userBuy.signed],'INSUFFICIENT_BALANCE');
 const credits=Object.fromEntries(Object.entries(floors.userDiff).filter(([,d])=>d>0n));
 const userCredit=await signIntents(user.signer,{intents:[tokenDiff(credits)],deadlineMs,saltHex});
 const solverCredit=await signIntents(solver,{intents:[tokenDiff({[USDC_SOL_TOKEN_ID]:floors.usdc.solverReceives})],deadlineMs,saltHex});
 await check('buy envelope: the user diff without the USDC debit runs to the end of the engine',[userCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[userCredit.signed]));
 await check('buy envelope: solver and user together, credits only',[solverCredit.signed,userCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[solverCredit.signed,userCredit.signed]));

 // ---- sourcing: the solver's transfer intents to the quotes' deposit accounts ----
 const depositAccounts=coins.map(()=>nep413Signer(throwawayEd25519()).accountId);
 const source=await signIntents(solver,{intents:sourcingIntents(coins.map((c,i)=>({originAsset:USDC_SOL_TOKEN_ID,quote:{depositAddress:depositAccounts[i],amountIn:usdcIns[i]}}))),deadlineMs,saltHex});
 await check(`sourcing: one solver payload with ${coins.length} transfer intents (unfunded: accepted up to the balance check)`,[source.signed],'INSUFFICIENT_BALANCE');
 {
  const self={intent:'transfer',receiver_id:solver.accountId,tokens:{[USDC_SOL_TOKEN_ID]:'1'}};
  await check('negative: a transfer to the signer itself',[(await signIntents(solver,{intents:[self],deadlineMs,saltHex})).signed],'INVALID_INTENT');
 }

 // ---- sell: the reverse, the solver pays USDC at once and unloads afterwards ----
 const coin=coins[0],sellAmount=quotes[0].amountOut;
 const pre=sellDiffs({coin,amount:sellAmount,feePips});
 const unload=await quoteInternal({client,originAsset:coin.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,amount:pre.solverReceivesCoin,account:solver.accountId,dry:true,slippageBps:sourceSlippageBps,deadlineMs:now()+10*60_000});
 const sd=sellDiffs({coin,amount:sellAmount,usdcMinOut:unload.minAmountOut,feePips,marginBps});
 const userSell=await signUserDiff(user.signer,{diff:sd.userDiff,deadlineMs,saltHex});
 const solverSell=await signIntents(solver,{intents:[tokenDiff(sd.solverDiff)],deadlineMs,saltHex});
 emit({step:'jit_sell_priced',standard,symbol:coin.symbol,user_gives:sellAmount.toString(),solver_unloads:pre.solverReceivesCoin.toString(),unload_quote_usdc:unload.amountOut.toString(),unload_min_usdc:unload.minAmountOut.toString(),
  user_signs_for_at_least:sd.userFloor.toString(),solver_pays_first:sd.solverPays.toString(),surplus_to_user_if_filled_at_quote:sellSurplus({unloaded:unload.amountOut,solverPays:sd.solverPays,marginBps}).toString(),
  time_estimate_s:unload.timeEstimate,user_diff:str(sd.userDiff),solver_diff:str(sd.solverDiff),user_payload:userSell.signed,solver_payload:solverSell.signed});
 await check('sell: [solver, user] as it would be executed',[solverSell.signed,userSell.signed],'INSUFFICIENT_BALANCE');
 const userSellCredit=await signIntents(user.signer,{intents:[tokenDiff({[USDC_SOL_TOKEN_ID]:sd.userFloor})],deadlineMs,saltHex});
 const solverSellCredit=await signIntents(solver,{intents:[tokenDiff({[coin.tokenId]:sd.solverReceivesCoin})],deadlineMs,saltHex});
 await check('sell envelope: solver and user together, credits only',[solverSellCredit.signed,userSellCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[solverSellCredit.signed,userSellCredit.signed]));

 // ---- withdrawal on request: a separate user payload, later ----
 {
  const fee=await omni.fee({tokenId:coin.tokenId,recipient:user.recipient,amount:floors.legs[0].userFloor});
  const w=omniWithdrawToSolana({tokenId:coin.tokenId,amount:floors.legs[0].userFloor,recipient:user.recipient,nativeFee:fee.nativeFee,feeMode:'signer'});
  await check('withdrawal on request: a user payload with only ft_withdraw (unfunded: accepted up to the balance check)',[(await signIntents(user.signer,{intents:w.intents,deadlineMs,saltHex})).signed],'INSUFFICIENT_BALANCE');
 }

 // ---- negative cases of the just-in-time flow ----
 {
  // sourcing took longer than the user's deadline: the whole batch is refused, so nothing of the user's moves
  const late=await signIntents(user.signer,{intents:[tokenDiff(credits)],deadlineMs:now()-60_000,saltHex});
  await check('negative: the solver settles after the user\'s deadline (the batch is refused as a whole)',[solverCredit.signed,late.signed],'DEADLINE_EXPIRED');
 }
 if(typeof userCredit.signed.payload==='string'){
  const altered=userCredit.signed.payload.replace(/:"(\d+)"\}/,(m,d)=>`:"${BigInt(d)+1n}"}`);
  await check('negative: the solver alters the amounts the user signed',[{...userCredit.signed,payload:altered}],standard==='erc191'?['PUBLIC_KEY_NOT_EXIST','INVALID_SIGNATURE']:'INVALID_SIGNATURE');
 }
 {
  // a second settlement can never reuse the user's signature
  await check('negative: the user\'s payload submitted twice in one batch',[userCredit.signed,userCredit.signed],'NONCE_USED');
 }
 {
  const short=settleBuy({floors,sourced:quotes.map((q,i)=>i===0?floors.legs[0].mustGive-1n:q.amountOut),feePips,marginBps});
  local('negative: a leg sourced below the user\'s floor is not settled',short.ok===false&&short.short[0].symbol===coins[0].symbol);
 }
 const ok=checks.every(c=>c.pass);
 const summary={step:'balance_plan_result',standard,ok,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name)};
 emit(summary);
 return {ok,standard,checks,summary};
}

/**
 * `--deposit-user --via omni`, plan form: the deposit WITHOUT 1Click. Checks on the chains, builds the user's exact
 * Solana transaction (Omni bridge `init_transfer`, recipient near:intents.near, message = the owner account) and,
 * when `from` names a Solana address that holds the USDC and some SOL, runs it through `simulateTransaction` without
 * signature checks. Nothing is sent. `rpc` = NEAR RPC, `sol` = pipeline/solana/relay-rpc.mjs.
 */
export async function probeOmniDeposit({rpc,sol,amount,ownerAccount,from=null,emit=()=>{},fetch=globalThis.fetch}){
 const checks=[];
 const push=row=>{checks.push(row);emit({step:'omni_deposit',...row})};
 const user=from??throwawayEd25519().address,owner=ownerAccount??rawEd25519Signer(throwawayEd25519()).accountId;
 // 1. the bridge on NEAR mints the SAME token the verifier already holds for Solana USDC
 const tokenOnNear=await rpc.view(OMNI_BRIDGE,'get_token_id',{address:`sol:${USDC_SOLANA}`}).catch(e=>`error: ${String(e?.message??e).slice(0,80)}`);
 push({name:'omni deposit: omni.bridge.near maps Solana USDC to the verifier\'s own USDC token id',expect:contractOf(USDC_SOL_TOKEN_ID),got:tokenOnNear,pass:tokenOnNear===contractOf(USDC_SOL_TOKEN_ID)});
 const base=await rpc.view(OMNI_BRIDGE,'get_token_id',{address:'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}).then(v=>String(v),e=>String(e?.message??e).slice(0,60));
 emit({step:'omni_deposit',info:'USDC on Base at the Omni bridge (no check: it tells whether the same route exists from Base)',answer:base,route_from_base:!/NOT_REGISTERED|error/i.test(base)&&base!=='null'});
 // 2. the bridge's vault for USDC exists on Solana (the program takes this as the proof that the token is registered)
 const a=omniSolanaAccounts(USDC_SOLANA);
 const vault=await sol.accountInfo(a.vault);
 push({name:'omni deposit: the bridge program keeps a USDC vault on Solana',expect:'EXISTS',got:vault?'EXISTS':'MISSING',pass:Boolean(vault),vault:a.vault,owner_program:vault?.owner??null});
 // 3. the transaction
 const fee=await omniDepositFee({user,mint:USDC_SOLANA,amount,fetch});
 const ix=omniDepositInstruction({user,mint:USDC_SOLANA,amount,ownerAccount:owner,nativeFee:fee.nativeFee});
 const {blockhash}=await sol.latestBlockhash();
 const bytes=buildSelfPaidTransaction({payer:user,blockhash,instructions:[ix]});
 emit({step:'omni_deposit',built:'the user\'s Solana transaction',program:ix.programAddress,instruction:'init_transfer',recipient:`near:${VERIFIER}`,message:owner,amount:BigInt(amount).toString(),fee:'0',native_fee_lamports:fee.nativeFee.toString(),native_fee_usd:fee.usd,
  accounts:ix.accounts.map(x=>x.address),transaction_bytes:bytes.length});
 if(from){
  const sim=await sol.simulate(bytes);
  // the node returns the last log lines: the Wormhole core and its shim must have run, and the bridge program must end in success
  const entered=sim.logs.some(l=>l===`Program ${ix.programAddress} success`),posted=sim.logs.some(l=>l===`Program ${WORMHOLE_CORE} success`);
  push({name:'omni deposit: the transaction simulates on Solana mainnet (no signature check) up to the Wormhole message',expect:'SIMULATED',got:!sim.err&&entered&&posted?'SIMULATED':'FAILED',pass:!sim.err&&entered&&posted,from,err:sim.err,units:sim.unitsConsumed,logs:sim.logs.slice(-8)});
 }else emit({step:'omni_deposit',simulation:'skipped',why:'pass --omni-from <a Solana address holding the USDC and a little SOL> (the test wallet\'s public address) to simulate the transaction; a throwaway address has neither'});
 return {ok:checks.every(c=>c.pass),checks};
}

/** The holdings views on a real account (`mt_tokens_for_owner` then `mt_batch_balance_of`): the portfolio read. */
export async function probeHoldings({verifier,account,emit=()=>{}}){
 let held=[],error=null;
 try{held=await verifier.holdings(account)}catch(e){error=String(e?.message??e).slice(0,200)}
 const row={name:'holdings: mt_tokens_for_owner and mt_batch_balance_of list an account\'s whole portfolio',expect:'LISTED',got:held.length?'LISTED':'EMPTY',pass:held.length>0,account,tokens:held.length,
  sample:held.slice(0,3).map(h=>({token_id:h.tokenId,amount:h.amount.toString()})),error};
 emit({step:'holdings_probe',...row});
 return {ok:row.pass,checks:[row]};
}
// re-exported so the spike's entry point needs one import
export {receivedFor};

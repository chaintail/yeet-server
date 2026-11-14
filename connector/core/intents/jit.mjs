// The balance model: the user's USDC and coins stay inside intents.near under the user's own key; a buy is ONE
// user-signed `token_diff` with no withdrawal; our solver holds USDC only and sources each coin just in time through
// a 1Click quote that has the verifier on BOTH sides (`depositType: INTENTS`, `recipientType: INTENTS`).
// docs/INTENTS-BALANCE-MODEL.md has the mechanics with their sources. Read on 2026-11-13:
//   - OpenAPI https://1click.chaindefuser.com/docs/v0/openapi.yaml, `Quote.depositAddress`: "The deposit address
//     inside NEAR Intents (the verifier smart contract) when `depositType` is `INTENTS`"; `depositType` INTENTS:
//     "the account ID within NEAR Intents to which you should transfer assets".
//   - A committed quote without an API key returned a 64-hex verifier account as `depositAddress`, and
//     `POST /v0/generate-intent` (also without a key) answered with exactly the `transfer` intent built here.
//   - near/intents dbad9c8 contracts/defuse/core/src/intents/tokens.rs `Transfer`: {receiver_id, tokens, memo?};
//     it moves balances inside the contract, takes no fee, and refuses a transfer to the signer itself.
// Pricing rule (no fee of ours by default): the user signs for a FLOOR (the firm quote's `minAmountOut`) and receives
// everything the solver sourced: the mirror diff gives the floor, a `transfer` intent in the solver's own payload
// hands over the rest. The solver spends exactly the USDC the user pays, so its price risk is nil; what is left is
// sourcing failure (the user's intent then expires and nothing of theirs moved).
import {USDC_SOL_TOKEN_ID} from './constants.mjs';
import {tokenDiff,mirrorDiff,receivedFor,giveFor,unmatched,signIntents} from './intents.mjs';

const TOKEN_ID=/^nep141:[a-z0-9._-]{2,64}$/;
const ACCOUNT=/^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|[a-z0-9._-]{2,64})$/;
const big=v=>BigInt(v);
const keep=(amount,marginBps)=>big(amount)*BigInt(10_000-marginBps)/10_000n;
function margin(marginBps){
 if(!Number.isInteger(marginBps)||marginBps<0||marginBps>2000)throw Error('margin is 0..2000 bps');
 return marginBps;
}

/** `transfer` intent: moves `tokens` ({tokenId: amount}) from the signer to `receiverId` inside the verifier. */
export function transferIntent({receiverId,tokens,memo}){
 if(!ACCOUNT.test(receiverId))throw Error('receiver is not an account id');
 const entries=Object.entries(tokens).sort(([a],[b])=>a<b?-1:a>b?1:0);
 if(!entries.length)throw Error('nothing to transfer');
 const out={};
 for(const [id,v] of entries){
  if(!TOKEN_ID.test(id))throw Error(`token id must be nep141:<contract>: ${id}`);
  if(big(v)<=0n)throw Error('amount must be positive');
  out[id]=big(v).toString();
 }
 return {intent:'transfer',receiver_id:receiverId,tokens:out,...(memo?{memo}:{})};
}

/**
 * A 1Click quote with the verifier on both sides: `account` (an account inside intents.near) pays `amount` of
 * `originAsset` from its verifier balance and receives `destinationAsset` in the same account; refunds return there.
 * `dry:true` is a price only; `dry:false` commits nothing either but returns the deposit account to fund.
 * Returns {depositAddress, amountIn, amountOut, minAmountOut, amountInUsd, amountOutUsd, timeEstimate, deadline,
 * correlationId, appFees}.
 */
export async function quoteInternal({client,originAsset,destinationAsset,amount,account,dry,slippageBps=100,deadlineMs}){
 const r=await client.quote({dry,swapType:'EXACT_INPUT',slippageTolerance:slippageBps,originAsset,depositType:'INTENTS',destinationAsset,amount:big(amount).toString(),
  refundTo:account,refundType:'INTENTS',recipient:account,recipientType:'INTENTS',deadline:new Date(deadlineMs).toISOString()});
 const q=r.quote;
 if(big(q.amountIn)!==big(amount))throw Error('1Click quote amountIn differs from the request');
 if(big(q.minAmountOut)<=0n||big(q.minAmountOut)>big(q.amountOut))throw Error('1Click quote has no usable minimum');
 if(!dry){
  if(!q.depositAddress||!/^[0-9a-f]{64}$/.test(q.depositAddress))throw Error('1Click returned no verifier deposit account');
  if(q.depositMemo)throw Error('1Click asked for a deposit memo; not supported here');
  if(q.depositAddress===account)throw Error('deposit account is the payer itself');
 }
 return {depositAddress:q.depositAddress??null,amountIn:big(q.amountIn),amountOut:big(q.amountOut),minAmountOut:big(q.minAmountOut),amountInUsd:Number(q.amountInUsd),amountOutUsd:Number(q.amountOutUsd),
  timeEstimate:q.timeEstimate,deadline:q.deadline??null,correlationId:r.correlationId,appFees:r.quoteRequest?.appFees??null};
}

/** The solver's sourcing payload content: one `transfer` intent per funded quote. `legs` = [{originAsset, quote}]. */
export const sourcingIntents=legs=>legs.map(l=>transferIntent({receiverId:l.quote.depositAddress,tokens:{[l.originAsset]:l.quote.amountIn}}));

/**
 * What the USER signs for a buy: {usdc: -total, coin_i: +floor_i} and nothing else (no withdrawal).
 * `legs` = [{symbol, tokenId, usdcIn, minOut}] where minOut is the firm quote's `minAmountOut`.
 * The solver must be able to give `mustGive` of each coin; the user receives `userFloor` at least.
 */
export function buyFloors({legs,feePips,marginBps=0,usdcTokenId=USDC_SOL_TOKEN_ID}){
 margin(marginBps);
 const fee=big(feePips),total=legs.reduce((a,l)=>a+big(l.usdcIn),0n);
 if(total<=0n)throw Error('nothing to spend');
 const userDiff={[usdcTokenId]:-total};
 const out=legs.map(l=>{
  const userFloor=receivedFor(keep(l.minOut,marginBps),fee);
  if(userFloor<=0n)throw Error(`${l.symbol}: amount too small`);
  userDiff[l.tokenId]=userFloor;
  return {symbol:l.symbol,tokenId:l.tokenId,usdcIn:big(l.usdcIn),minOut:big(l.minOut),userFloor,mustGive:giveFor(userFloor,fee)};
 });
 return {userDiff,legs:out,usdc:{userGives:total,solverReceives:receivedFor(total,fee)}};
}

/**
 * After sourcing: what the SOLVER signs. `sourced[i]` = raw coin amount the solver actually received for leg i.
 * ok:false with `short` when a leg delivered less than the user was promised: do NOT execute.
 * Otherwise {solverDiff (the exact mirror of the user's diff), surplus: {tokenId: amount} handed to the user by a
 * `transfer` intent, userReceives per leg, solverKeeps per leg (the margin; 0 when marginBps is 0)}.
 */
export function settleBuy({floors,sourced,feePips,marginBps=0}){
 margin(marginBps);
 const fee=big(feePips),short=[],surplus={},legs=[];
 floors.legs.forEach((l,i)=>{
  const got=big(sourced[i]??0n),pass=keep(got,marginBps);
  if(pass<l.mustGive){short.push({symbol:l.symbol,sourced:got,must_give:l.mustGive});return}
  const extra=pass-l.mustGive;
  if(extra>0n)surplus[l.tokenId]=extra;
  legs.push({symbol:l.symbol,tokenId:l.tokenId,sourced:got,userReceives:l.userFloor+extra,solverKeeps:got-pass});
 });
 if(short.length)return {ok:false,short};
 const solverDiff=mirrorDiff(floors.userDiff,fee);
 if(Object.keys(unmatched([floors.userDiff,solverDiff],fee)).length)throw Error('diffs do not net to zero');
 return {ok:true,solverDiff,surplus,legs};
}

/**
 * A sell. The user gives `amount` of the coin; the solver receives `solverReceivesCoin` (the contract's fee is taken
 * from the amount given) and that is what the unload quote must be asked for. Call with `usdcMinOut` = that firm
 * quote's `minAmountOut` to get the diffs: the solver pays the floor from its own USDC at once, then unloads.
 */
export function sellDiffs({coin,amount,usdcMinOut,feePips,marginBps=0,usdcTokenId=USDC_SOL_TOKEN_ID}){
 margin(marginBps);
 const fee=big(feePips),a=big(amount);
 if(a<=0n)throw Error('nothing to sell');
 const solverReceivesCoin=receivedFor(a,fee);
 if(usdcMinOut===undefined)return {solverReceivesCoin};
 const userFloor=receivedFor(keep(usdcMinOut,marginBps),fee);
 if(userFloor<=0n)throw Error('amount too small');
 const userDiff={[coin.tokenId]:-a,[usdcTokenId]:userFloor};
 const solverDiff={[coin.tokenId]:solverReceivesCoin,[usdcTokenId]:-giveFor(userFloor,fee)};
 if(Object.keys(unmatched([userDiff,solverDiff],fee)).length)throw Error('diffs do not net to zero');
 return {solverReceivesCoin,userDiff,solverDiff,userFloor,solverPays:-solverDiff[usdcTokenId]};
}
/** After the unload of a sell: the USDC beyond what the solver already paid goes to the user (minus the margin). */
export function sellSurplus({unloaded,solverPays,marginBps=0}){
 const extra=keep(unloaded,margin(marginBps))-big(solverPays);
 return extra>0n?extra:0n;
}

/**
 * The bound on what the solver can lose on one buy, checked before execute: it spent `spentUsdc` on sourcing and
 * receives `receivesUsdc` from the user; the difference must not exceed `maxLossBps` of the trade.
 */
export function solverLoss({spentUsdc,receivesUsdc,maxLossBps=10}){
 const loss=big(spentUsdc)-big(receivesUsdc),limit=big(spentUsdc)*BigInt(maxLossBps)/10_000n+1n;
 return {loss,limit,ok:loss<=limit};
}

/** Signs the user's buy or sell: a single `token_diff` intent. */
export const signUserDiff=(user,{diff,deadlineMs,saltHex})=>signIntents(user,{intents:[tokenDiff(diff)],deadlineMs,saltHex});
/** Signs the solver's settlement: the mirror diff, then the surplus transfer to the user when there is one. */
export function signSolverSettle(solver,{solverDiff,surplus={},userAccount,deadlineMs,saltHex}){
 const intents=[tokenDiff(solverDiff),...(Object.keys(surplus).length?[transferIntent({receiverId:userAccount,tokens:surplus})]:[])];
 return signIntents(solver,{intents,deadlineMs,saltHex});
}

// ---- the all-in cost of one buy leg, from dry quotes ----
/**
 * `ii` = internal (INTENTS to INTENTS) dry buy quote, `back` = the internal dry quote selling `ii.amountOut` straight
 * back, `cc` = today's chain-to-chain dry quote (or null). `gasNear` = NEAR burnt by our own calls for the trade,
 * `nearUsd` = NEAR price. Amounts in USD are 1Click's own marks (`amountInUsd`, `amountOutUsd`); the round trip is
 * independent of those marks. Returns numbers rounded to 4 decimals of a dollar and to 0.1 bps.
 */
export function costRow({symbol,sizeUsdc,ii,back,cc,feePips,gasNear,nearUsd,legsPerTrade=1}){
 const r4=x=>Math.round(x*1e4)/1e4,bps=(x,of)=>Math.round(x/of*1e5)/10;
 const marked=ii.amountInUsd-ii.amountOutUsd;
 const oneClickBps=(ii.appFees??[]).reduce((a,f)=>a+Number(f.fee??0),0);
 const protocol=2*Number(feePips)/1e6*ii.amountInUsd;
 const gas=gasNear*nearUsd/legsPerTrade;
 const roundTrip=back?Number(ii.amountIn-back.amountOut)/1e6:null;
 // the sourcing cost of ONE side is half of what a buy and an immediate sell lose: that figure needs no USD mark.
 // 1Click's marks (`amountInUsd` - `amountOutUsd`) are shown next to it; they can lag the market either way.
 const sourcing=roundTrip===null?marked:roundTrip/2;
 const allIn=sourcing+protocol+gas;
 const chain=cc?cc.amountInUsd-cc.amountOutUsd:null;
 return {symbol,size_usdc:sizeUsdc,time_estimate_s:ii.timeEstimate,
  sourcing_cost_usd:r4(sourcing),sourcing_cost_bps:bps(sourcing,sizeUsdc),sourcing_cost_basis:roundTrip===null?'usd_marks':'half_round_trip',marked_cost_usd:r4(marked),
  of_which_1click_fee_bps:oneClickBps,of_which_1click_fee_usd:r4(oneClickBps/1e4*sizeUsdc),
  protocol_fee_usd:Math.round(protocol*1e6)/1e6,near_gas_usd:r4(gas),our_fee_usd:0,all_in_usd:r4(allIn),all_in_bps:bps(allIn,sizeUsdc),
  round_trip_loss_usdc:roundTrip===null?null:r4(roundTrip),
  chain_to_chain_cost_usd:chain===null?null:r4(chain),chain_to_chain_cost_bps:chain===null?null:bps(chain,cc.amountInUsd),chain_time_estimate_s:cc?.timeEstimate??null};
}

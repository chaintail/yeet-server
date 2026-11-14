// A basket BUY as two signed intents: the user gives USDC and receives every coin and withdraws each to Solana, all in
// ONE signed payload; our solver signs the mirror diff from its own inventory inside the verifier. Whoever sends
// `execute_intents({signed:[solver, user]})` settles both atomically (no relay, no 1Click for the swap).
// Order inside the batch does not matter for the zero-sum check (it runs once at the end), but each negative delta
// needs the balance at that moment: with the solver first, the user's withdrawals spend coins already credited.
import {CATALOG,findToken} from '../trade/router.mjs';
import {USDC_SOL_TOKEN_ID,WNEAR_TOKEN_ID} from './constants.mjs';
import {tokenDiff,mirrorDiff,receivedFor,unmatched,omniWithdrawToSolana,signIntents} from './intents.mjs';

/** Catalogue entries for `WIF,BOME,TRUMP`: [{symbol, tokenId, mint, decimals}]. Solana coins only. */
export function basketCoins(input,catalog=CATALOG){
 const parts=String(input??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(!parts.length||parts.length>5)throw Error('1 to 5 coins, comma separated');
 const out=parts.map(p=>{
  const e=findToken(p,'solana',catalog);
  if(!e||e.kind==='funding'||e.symbol==='USDC'||!e.address)throw Error(`unknown coin ${p}`);
  if(!/^nep141:sol-[0-9a-f]{40}\.omft\.near$/.test(e.assetId))throw Error(`${e.symbol} does not leave by the plain Omni route (${e.assetId}); not supported by this spike`);
  return {symbol:e.symbol,tokenId:e.assetId,mint:e.address,decimals:e.decimals};
 });
 if(new Set(out.map(c=>c.tokenId)).size!==out.length)throw Error('a coin is listed twice');
 return out;
}

/** Splits `total` (raw USDC) evenly over `n` legs; the first leg takes the remainder. */
export function splitEven(total,n){
 const each=BigInt(total)/BigInt(n),rest=BigInt(total)-each*BigInt(n);
 return Array.from({length:n},(_,i)=>each+(i===0?rest:0n));
}

/**
 * Live price of each leg: a 1Click DRY quote (`dry:true` commits nothing and returns no deposit address) for
 * USDC -> coin delivered inside the verifier. This is only the solver's price source; the swap itself never touches
 * 1Click. Returns [{...coin, usdcIn (bigint), quotedOut (bigint), correlationId}].
 */
export async function quoteLegs({client,coins,usdcIns,recipient,refundTo,usdcTokenId=USDC_SOL_TOKEN_ID,now=Date.now}){
 const deadline=new Date(now()+10*60_000).toISOString();
 let tokens=null;
 return Promise.all(coins.map(async(c,i)=>{
  let r;
  try{
   r=await client.quote({dry:true,swapType:'EXACT_INPUT',slippageTolerance:100,originAsset:usdcTokenId,depositType:'ORIGIN_CHAIN',destinationAsset:c.tokenId,
    amount:usdcIns[i].toString(),refundTo,refundType:'ORIGIN_CHAIN',recipient,recipientType:'INTENTS',deadline});
  }catch(e){
   // 1Click has no route for this size ("No liquidity available" was seen for $1 legs): our solver does not need
   // one, only a price. Fall back to the USD prices of GET /v0/tokens.
   if(typeof client.getTokens!=='function')throw e;
   tokens??=client.getTokens();
   const list=await tokens,coin=list.find(t=>t.assetId===c.tokenId),usdc=list.find(t=>t.assetId===usdcTokenId);
   if(!(coin?.price>0)||!(usdc?.price>0))throw Error(`no price for ${c.symbol}: ${String(e?.message??e).slice(0,120)}`);
   const out=BigInt(Math.floor(Number(usdcIns[i])/1e6*usdc.price/coin.price*10**c.decimals));
   if(out<=0n)throw Error(`no price for ${c.symbol}`);
   return {...c,usdcIn:usdcIns[i],quotedOut:out,correlationId:null,priceSource:'tokens_list'};
  }
  const out=BigInt(r.quote.amountOut);
  if(out<=0n)throw Error(`no price for ${c.symbol}`);
  return {...c,usdcIn:usdcIns[i],quotedOut:out,correlationId:r.correlationId,priceSource:'dry_quote'};
 }));
}

/**
 * The two diffs. The solver gives quotedOut * (1 - marginBps/10000) of each coin and takes the USDC; the user receives
 * what is left after the contract's fee on each given amount. `wnearForUser` (bigint yoctoNEAR, 'intent' fee mode):
 * the solver also hands the user exactly that much wNEAR to pay the bridge.
 * Returns {userDiff, solverDiff, legs:[{symbol, tokenId, solverGives, userReceives}], usdc:{userGives, solverReceives}}.
 */
export function basketDiffs({legs,feePips,marginBps=100,usdcTokenId=USDC_SOL_TOKEN_ID,wnearForUser=0n}){
 if(!Number.isInteger(marginBps)||marginBps<0||marginBps>2000)throw Error('margin is 0..2000 bps');
 const fee=BigInt(feePips);
 const userGives=legs.reduce((a,l)=>a+BigInt(l.usdcIn),0n);
 if(userGives<=0n)throw Error('nothing to spend');
 const userDiff={[usdcTokenId]:-userGives};
 const out=legs.map(l=>{
  const solverGives=BigInt(l.quotedOut)*BigInt(10_000-marginBps)/10_000n;
  const userReceives=receivedFor(solverGives,fee);
  if(userReceives<=0n)throw Error(`${l.symbol}: amount too small`);
  userDiff[l.tokenId]=userReceives;
  return {symbol:l.symbol,tokenId:l.tokenId,mint:l.mint,decimals:l.decimals,usdcIn:BigInt(l.usdcIn),quotedOut:BigInt(l.quotedOut),priceSource:l.priceSource??null,solverGives,userReceives};
 });
 if(BigInt(wnearForUser)>0n)userDiff[WNEAR_TOKEN_ID]=BigInt(wnearForUser);
 const solverDiff=mirrorDiff(userDiff,fee);
 const rest=unmatched([userDiff,solverDiff],fee);
 if(Object.keys(rest).length)throw Error('diffs do not net to zero');
 return {userDiff,solverDiff,legs:out,usdc:{userGives,solverReceives:solverDiff[usdcTokenId]}};
}

/**
 * Signs both sides. `user` / `solver` = sign.mjs signers. `bridgeFees[i]` = yoctoNEAR native fee of leg i (omni.mjs
 * `fee`). feeMode 'signer': the account that sends the NEAR transaction pays the bridge from its storage balance on
 * omni.bridge.near; 'intent': the user pays in wNEAR that the solver adds to the diff.
 * Returns {signed:[solverSigned, userSigned], user:{intents, payload…}, solver:{…}, diffs, withdrawals}.
 */
export async function buildBasketTrade({user,solver,legs,recipient,bridgeFees,feePips,saltHex,deadlineMs,marginBps=100,feeMode='signer',usdcTokenId=USDC_SOL_TOKEN_ID,externalIds}){
 if(bridgeFees.length!==legs.length)throw Error('one bridge fee per leg');
 const wnearForUser=feeMode==='intent'?bridgeFees.reduce((a,f)=>a+BigInt(f),0n):0n;
 const diffs=basketDiffs({legs,feePips,marginBps,usdcTokenId,wnearForUser});
 const withdrawals=diffs.legs.map((l,i)=>({symbol:l.symbol,tokenId:l.tokenId,mint:l.mint,amount:l.userReceives,nativeFee:BigInt(bridgeFees[i]),
  ...omniWithdrawToSolana({tokenId:l.tokenId,amount:l.userReceives,recipient,nativeFee:bridgeFees[i],feeMode,externalId:externalIds?.[i]})}));
 const userIntents=[tokenDiff(diffs.userDiff),...withdrawals.flatMap(w=>w.intents)];
 const solverIntents=[tokenDiff(diffs.solverDiff)];
 const u=await signIntents(user,{intents:userIntents,deadlineMs,saltHex});
 const s=await signIntents(solver,{intents:solverIntents,deadlineMs,saltHex});
 return {signed:[s.signed,u.signed],user:{...u,intents:userIntents},solver:{...s,intents:solverIntents},diffs,feeMode,recipient,
  withdrawals:withdrawals.map(({intents,...w})=>w)};
}

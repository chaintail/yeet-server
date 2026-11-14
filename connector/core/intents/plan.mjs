// `--plan`: the whole basket trade built and signed with THROWAWAY keys and run through the verifier's free
// `simulate_intents` view on mainnet. Needs no secret, sends nothing, costs nothing.
// Throwaway accounts hold nothing, so the real trade cannot pass the balance check. What the plan proves instead:
//   1. each real signed payload, simulated alone, is refused at `intent_execution` with "insufficient balance or
//      overflow": the engine checks signature, payload JSON, verifying contract, deadline, key ownership, salt and
//      nonce BEFORE it applies any delta (contracts/defuse/core/src/engine/mod.rs `execute_signed_intent`), so
//      everything earlier was accepted;
//   2. the same payloads with only the debits removed run to the END of the engine: the contract lists them in
//      `intents_executed` with the intent hash we computed locally, accepts the three withdrawal intents (they spend
//      the coins the diff just credited), and reports only `invariant_violated` (nobody gave the coins);
//   3. the negative cases are refused for the stated reason.
import {randomBytes} from 'node:crypto';
import {evmAddress,newSecp256k1Key} from '../pipeline/test-wallet.mjs';
import {rawEd25519Signer,erc191Signer,nep413Signer,throwawayEd25519,verifyMultiPayload,intentHash} from './sign.mjs';
import {tokenDiff,signIntents} from './intents.mjs';
import {basketCoins,splitEven,quoteLegs,buildBasketTrade} from './basket.mjs';
import {parseNonce} from './nonce.mjs';
import {USDC_SOL_TOKEN_ID,WNEAR_TOKEN_ID} from './constants.mjs';
import {reservedTgas,maxWithdrawals} from './omni.mjs';

/** A throwaway user for a signing standard, plus the Solana address its coins would go to. */
export function throwawayUser(standard){
 if(standard==='raw_ed25519'){const k=throwawayEd25519();return {signer:rawEd25519Signer(k),recipient:k.address}}
 if(standard==='erc191'){
  const k=newSecp256k1Key();
  return {signer:erc191Signer({address:evmAddress(k),privateKey:()=>Uint8Array.from(k)}),recipient:throwawayEd25519().address};
 }
 throw Error('standard is raw_ed25519 or erc191');
}
/** The same JSON with the first diff amount raised by one (what a tampering relay would do). */
const flip=s=>{const out=s.replace(/:"(\d+)"\}/,(m,d)=>`:"${BigInt(d)+1n}"}`);if(out===s)throw Error('nothing to alter');return out};
const brief=r=>r.ok?{outcome:'PASSED'}:{outcome:r.code,stage:r.stage,contract_says:r.message};

/**
 * Runs the plan for one signing standard. `deps` = {verifier, omni, client}. `emit` gets one object per check.
 * Returns {ok, standard, checks:[{name, expect, got, pass}], …}.
 */
export async function runPlan({standard,usdc,coins:coinList='WIF,BOME,TRUMP',feeMode='signer',marginBps=100,deps,emit=()=>{},now=Date.now}){
 const {verifier,omni,client}=deps;
 const user=throwawayUser(standard),solver=nep413Signer(throwawayEd25519());
 const coins=basketCoins(coinList);
 const [saltHex,feePips]=await Promise.all([verifier.currentSalt(),verifier.fee()]);
 emit({step:'accounts',standard,user_account:user.signer.accountId,user_public_key:user.signer.publicKey,solver_account:solver.accountId,solver_standard:'nep413',recipient_solana:user.recipient,
  note:'throwaway keys generated in this process; they hold nothing and are discarded'});
 emit({step:'contract_state',verifier:verifier.contract,current_salt:saltHex,fee_pips:feePips});
 const checks=[];
 // the way out: each coin must leave through omni.bridge.near to the mint in our catalogue (read from the chain)
 for(const [i,r] of (await Promise.all(coins.map(c=>omni.route(c)))).entries()){
  const row={name:`route: ${coins[i].symbol} leaves through omni.bridge.near to its Solana mint`,expect:'OPEN',got:r.ok?'OPEN':'CLOSED',pass:r.ok,bridged:r.bridged,bridge_registered_on_token:r.bridge_registered_on_token,decimals:r.decimals};
  checks.push(row);emit({step:'bridge_route',...row});
 }
 {
  const reserved=reservedTgas(coins.length,feeMode),fits=coins.length<=maxWithdrawals(feeMode);
  const row={name:`gas: ${coins.length} withdrawals in one 300 Tgas transaction`,expect:'FITS',got:fits?'FITS':'TOO_MANY',pass:fits,reserved_tgas:reserved,max_withdrawals:maxWithdrawals(feeMode)};
  checks.push(row);emit({step:'gas_budget',...row});
 }

 const legs=await quoteLegs({client,coins,usdcIns:splitEven(usdc,coins.length),recipient:solver.accountId,refundTo:user.recipient,now});
 const fees=await Promise.all(legs.map(l=>omni.fee({tokenId:l.tokenId,recipient:user.recipient,amount:l.quotedOut})));
 const deadlineMs=now()+5*60_000;
 const trade=await buildBasketTrade({user:user.signer,solver,legs,recipient:user.recipient,bridgeFees:fees.map(f=>f.nativeFee),feePips,saltHex,deadlineMs,marginBps,feeMode});
 const [solverSigned,userSigned]=trade.signed;
 emit({step:'priced',source:'1Click dry quotes, or the 1Click token list when it has no route for the size (price only)',margin_bps:marginBps,fee_mode:feeMode,
  legs:trade.diffs.legs.map((l,i)=>({symbol:l.symbol,price_source:l.priceSource,usdc_in:l.usdcIn.toString(),quoted_out:l.quotedOut.toString(),solver_gives:l.solverGives.toString(),user_receives:l.userReceives.toString(),
   bridge_fee_yocto:fees[i].nativeFee.toString(),bridge_fee_usd:fees[i].usd})),
  user_diff:Object.fromEntries(Object.entries(trade.diffs.userDiff).map(([k,v])=>[k,v.toString()])),
  solver_diff:Object.fromEntries(Object.entries(trade.diffs.solverDiff).map(([k,v])=>[k,v.toString()]))});
 const local={user:await verifyMultiPayload(userSigned),solver:await verifyMultiPayload(solverSigned)};
 if(local.user.accountId!==user.signer.accountId||local.solver.accountId!==solver.accountId)throw Error('local verification: a signature does not belong to its account');
 emit({step:'signed',user:{standard:userSigned.standard,intents:trade.user.intents.map(i=>i.intent),payload_bytes:Buffer.byteLength(typeof userSigned.payload==='string'?userSigned.payload:userSigned.payload.message),nonce:trade.user.nonce,nonce_parsed:(({saltHex:s,deadlineMs:d})=>({salt:s,deadline:new Date(d).toISOString()}))(parseNonce(trade.user.nonce)),deadline:trade.user.deadline,intent_hash:local.user.hash},
  solver:{standard:solverSigned.standard,nonce:trade.solver.nonce,intent_hash:local.solver.hash},user_payload:userSigned,solver_payload:solverSigned});

 const check=async(name,signed,expect,extra)=>{
  const r=await verifier.simulate(signed);
  const got=r.ok?'PASSED':r.code;
  const row={name,expect,got,pass:[expect].flat().includes(got)&&(extra?extra(r):true),...brief(r)};
  if(r.output){
   row.intents_executed=(r.output.intents_executed??[]).map(e=>({account_id:e.account_id,intent_hash:e.intent_hash}));
   if(r.output.invariant_violated)row.invariant_violated=r.output.invariant_violated;
  }
  checks.push(row);emit({step:'simulate_intents',...row});
  return r;
 };
 const executed=(r,list)=>{const h=(r.output?.intents_executed??[]).map(e=>e.intent_hash);return list.every(s=>h.includes(intentHash(s)))&&h.length===list.length};

 // 1. the real trade
 const full=await check('trade: [solver, user] as it would be executed',[solverSigned,userSigned],'INSUFFICIENT_BALANCE');
 await check('trade: the user payload alone',[userSigned],'INSUFFICIENT_BALANCE');
 await check('trade: the solver payload alone',[solverSigned],'INSUFFICIENT_BALANCE');

 // 2. the same payloads without the debits: they run to the end of the engine
 const credits=Object.fromEntries(Object.entries(trade.diffs.userDiff).filter(([,v])=>v>0n));
 const userCredit=await signIntents(user.signer,{intents:[tokenDiff(credits),...trade.user.intents.slice(1)],deadlineMs,saltHex});
 const solverCredit=await signIntents(solver,{intents:[tokenDiff({[USDC_SOL_TOKEN_ID]:trade.diffs.usdc.solverReceives})],deadlineMs,saltHex});
 await check('envelope: user diff without the USDC debit, with every withdrawal intent',[userCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[userCredit.signed]));
 await check('envelope: solver diff without the coin debits',[solverCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[solverCredit.signed]));
 await check('envelope: both together',[solverCredit.signed,userCredit.signed],'INVARIANT_VIOLATED',r=>executed(r,[solverCredit.signed,userCredit.signed]));

 // 3. negative cases, each on a payload that otherwise runs to the end
 const one=tokenDiff({[coins[0].tokenId]:1n});
 const fresh=o=>signIntents(user.signer,{intents:[one],deadlineMs,saltHex,...o});
 const base=(await fresh()).signed;
 if(typeof base.payload==='string'){
  // erc191 carries no public key: an altered payload recovers a DIFFERENT key, which does not own the account
  await check('negative: intent altered after signing',[{...base,payload:flip(base.payload)}],standard==='erc191'?['PUBLIC_KEY_NOT_EXIST','INVALID_SIGNATURE']:'INVALID_SIGNATURE');
 }
 {
  const s=(await signIntents(solver,{intents:[one],deadlineMs,saltHex})).signed;
  await check('negative: solver (nep413) message altered after signing',[{...s,payload:{...s.payload,message:flip(s.payload.message)}}],'INVALID_SIGNATURE');
 }
 await check('negative: expired deadline',[(await fresh({deadlineMs:now()-60_000})).signed],'DEADLINE_EXPIRED');
 {
  const p=(await fresh()).signed;
  await check('negative: the same nonce twice in one batch',[p,p],'NONCE_USED');
 }
 await check('negative: token diffs that do not net to zero',[(await fresh()).signed],'INVARIANT_VIOLATED');
 {
  let bad;do{bad=randomBytes(4).toString('hex')}while(await verifier.isValidSalt(bad));
  await check('negative: nonce built with a salt the contract does not hold',[(await fresh({saltHex:bad})).signed],'INVALID_SALT');
 }
 await check('negative: intent deadline later than the nonce deadline',[(await fresh({deadlineMs:deadlineMs+60_000,nonceDeadlineMs:deadlineMs})).signed],'DEADLINE_GREATER_THAN_NONCE');
 await check('negative: signed for another verifying contract',[(await fresh({verifyingContract:'not-intents.near'})).signed],'WRONG_VERIFYING_CONTRACT');

 const ok=checks.every(c=>c.pass);
 const summary={step:'plan_result',standard,ok,fee_mode:feeMode,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),
  trade_outcome:full.ok?'PASSED':full.code,trade_contract_says:full.message??null,wnear_in_diff:Boolean(trade.diffs.userDiff[WNEAR_TOKEN_ID])};
 emit(summary);
 return {ok,standard,checks,trade,summary};
}

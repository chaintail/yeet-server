// Getting funds INTO the verifier for the spike: the test wallet's Solana USDC goes to a 1Click deposit address, and
// 1Click credits an account inside intents.near (`recipientType: INTENTS`) or delivers NEAR to a NEAR account.
// This is the documented deposit route since the Bridge API closing notice of 2026-11-11
// (https://docs.near-intents.org/changelog/overview.md; same-asset deposit quote:
// https://docs.near-intents.org/integration/market-makers/hot-to-omni.md). 1Click is used for deposits only.
// Every step is resumable from the state object: the quote and the signed transaction are saved BEFORE anything is
// broadcast, so a second run never pays twice.
import {base58Encode} from '../trade/router.mjs';
import {associatedTokenAddress,createAssociatedTokenIdempotent,transferChecked,setComputeUnitLimit,setComputeUnitPrice,encodeMessage,encodeTransaction,key,
 TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC_SOLANA,TOKEN_ACCOUNT_RENT_LAMPORTS} from '../pipeline/solana/message.mjs';
import {buildLegTransaction,DEFAULT_COMPUTE_UNIT_LIMIT,DEFAULT_PRIORITY_MICRO_LAMPORTS} from '../pipeline/solana/transfer-leg.mjs';
import {USDC_SOL_TOKEN_ID} from './constants.mjs';

/** v0 message with ONE signer who is also the fee payer (pipeline/solana/message.mjs `buildMessage` insists on a
 * separate fee payer, which the spike's self-paid sends do not have). Returns unsigned wire bytes. */
export function buildSelfPaidTransaction({payer,blockhash,instructions,computeUnitLimit=DEFAULT_COMPUTE_UNIT_LIMIT,priorityMicroLamports=DEFAULT_PRIORITY_MICRO_LAMPORTS}){
 const all=[setComputeUnitLimit(computeUnitLimit),setComputeUnitPrice(priorityMicroLamports),...instructions];
 const metas=new Map([[payer,{signer:true,writable:true}]]);
 const add=(address,{signer=false,writable=false})=>{key(address);const m=metas.get(address)??{signer:false,writable:false};metas.set(address,{signer:m.signer||signer,writable:m.writable||writable})};
 for(const ix of all){for(const a of ix.accounts)add(a.address,a);add(ix.programAddress,{})}
 for(const [a,m] of metas)if(m.signer&&a!==payer)throw Error('only the payer may sign');
 const rest=w=>[...metas].filter(([a,m])=>a!==payer&&m.writable===w).map(([a])=>a);
 const accounts=[payer,...rest(true),...rest(false)];
 const message={version:0,header:{signers:1,readonlySigned:0,readonlyUnsigned:rest(false).length},accounts,blockhash,
  instructions:all.map(ix=>({programIndex:accounts.indexOf(ix.programAddress),accounts:ix.accounts.map(a=>accounts.indexOf(a.address)),data:Uint8Array.from(ix.data)})),lookups:[]};
 return encodeTransaction([new Uint8Array(64)],encodeMessage(message));
}

/**
 * Signed wire bytes of one SPL transfer from the wallet to `to`'s token account (created when missing).
 * `feePayer` null: the wallet pays its own fee and the rent. Otherwise {address, signTransaction} (the YEET fee
 * payer, pipeline/solana/fee-payer.mjs) co-signs the standard leg transaction.
 * Returns {bytes, signature (the transaction id), createsAccount, lamportsNeeded}.
 */
export async function signedTokenTransfer({rpc,wallet,to,amount,mint=USDC_SOLANA,decimals=6,feePayer=null,blockhash}){
 const info=await rpc.accountInfo(mint);
 const tokenProgram=info?.owner;
 if(![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(tokenProgram))throw Error('mint is not an SPL token');
 const dest=associatedTokenAddress(to,mint,tokenProgram),source=associatedTokenAddress(wallet.address,mint,tokenProgram);
 const createsAccount=!(await rpc.accountInfo(dest));
 const held=await rpc.tokenBalance(source);
 if(held===null||held<BigInt(amount))throw Error(`the wallet holds ${held??0n} raw units of the token and the transfer needs ${BigInt(amount)}`);
 let bytes;
 if(feePayer){
  const unsigned=buildLegTransaction({feePayer:feePayer.address,wallet:wallet.address,depositOwner:to,mint,tokenProgram,amount:BigInt(amount),decimals,depositMemo:null},{blockhash,createDestination:createsAccount});
  bytes=await feePayer.signTransaction(wallet.signTransaction(unsigned));
 }else{
  const ixs=[...(createsAccount?[createAssociatedTokenIdempotent({payer:wallet.address,ata:dest,owner:to,mint,tokenProgram})]:[]),
   transferChecked({source,mint,destination:dest,authority:wallet.address,amount:BigInt(amount),decimals,tokenProgram})];
  bytes=wallet.signTransaction(buildSelfPaidTransaction({payer:wallet.address,blockhash,instructions:ixs}));
 }
 const lamportsNeeded=(createsAccount?TOKEN_ACCOUNT_RENT_LAMPORTS:0)+10_000;
 return {bytes,signature:base58Encode(bytes.subarray(1,65)),createsAccount,lamportsNeeded};
}

const TERMINAL=['SUCCESS','REFUNDED','FAILED'];
const iso=ms=>new Date(ms).toISOString();

/**
 * The committed 1Click quote of a funding leg (a Solana deposit address; nothing is paid by asking). Returns the
 * object fundVia1Click keeps as `state.quote`, so a caller may quote first (to price something) and pay later.
 */
export async function quoteFunding({client,wallet,request,slippageBps=100,now=Date.now}){
 const deadline=iso(now()+30*60_000);
 const r=await client.quote({dry:false,swapType:'EXACT_INPUT',slippageTolerance:slippageBps,originAsset:request.originAsset??USDC_SOL_TOKEN_ID,depositType:'ORIGIN_CHAIN',
  destinationAsset:request.destinationAsset,amount:BigInt(request.amount).toString(),refundTo:wallet.address,refundType:'ORIGIN_CHAIN',recipient:request.recipient,recipientType:request.recipientType,deadline});
 const q=r.quote;
 if(!q.depositAddress)throw Error('1Click returned no deposit address');
 if(q.depositMemo)throw Error('1Click asked for a deposit memo; not supported here');
 if(q.amountIn!==BigInt(request.amount).toString())throw Error('1Click quote amountIn differs from the request');
 if(q.depositAddress===wallet.address)throw Error('deposit address is the wallet itself');
 return {depositAddress:q.depositAddress,amountIn:q.amountIn,amountOut:q.amountOut,minAmountOut:q.minAmountOut,deadline:q.deadline??deadline,correlationId:r.correlationId,recipient:request.recipient,recipientType:request.recipientType,
  destinationAsset:request.destinationAsset,timeEstimate:q.timeEstimate??null};
}

/**
 * One funding leg through 1Click, resumable. `state` is this leg's own object inside the caller's state file and
 * `save()` persists it. `request` = {originAsset, destinationAsset, amount, recipient, recipientType}; refunds go to
 * the wallet. Stages (each emits one line): quote -> transaction signed and saved -> broadcast -> confirmed on Solana
 * -> 1Click status until SUCCESS / REFUNDED / FAILED (or `waitMs` runs out: run again to resume).
 * Returns the state object ({status, quote, solana_tx, at:{…}}).
 */
export async function fundVia1Click({label,state,save,client,rpc,signatureStatus,wallet,feePayer=null,request,emit=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),waitMs=600_000,watch=null}){
 state.at??={};
 const mark=k=>{state.at[k]??=iso(now())};
 if(TERMINAL.includes(state.status)){emit({step:label,stage:'already_done',status:state.status,amount_out:state.amount_out??null});return state}
 // a quote that can no longer be paid (deadline passed, nothing sent) is dropped
 if(state.quote&&!state.solana_tx&&Date.parse(state.quote.deadline)-now()<120_000)delete state.quote;
 if(!state.quote){
  state.quote=await quoteFunding({client,wallet,request,now});
  const q=state.quote;
  mark('quoted');save();
  emit({step:label,stage:'quoted',deposit_address:q.depositAddress,amount_in:q.amountIn,amount_out:q.amountOut,min_amount_out:q.minAmountOut,recipient:request.recipient,recipient_type:request.recipientType,correlation_id:q.correlationId,at:state.at.quoted});
 }
 // ---- the Solana transfer ----
 if(state.solana_tx&&!state.confirmed){
  const s=await signatureStatus(state.solana_tx);
  if(s.status==='failed')throw Error(`Solana transfer ${state.solana_tx} failed on chain`);
  if(['confirmed','finalized'].includes(s.status)){state.confirmed=true;mark('solana_confirmed');save()}
  else if(s.status==='not_found'&&!(await rpc.blockhashValid(state.blockhash,state.lastValidBlockHeight))){
   // the saved transaction can never land any more: forget it and sign a new one
   emit({step:label,stage:'transfer_expired',solana_tx:state.solana_tx});
   delete state.solana_tx;delete state.signed_base64;delete state.blockhash;delete state.lastValidBlockHeight;save();
  }
 }
 if(!state.solana_tx){
  if(watch&&state.balance_before===undefined){try{state.balance_before=String(await watch.read());save()}catch{}}
  const {blockhash,lastValidBlockHeight}=await rpc.latestBlockhash();
  const t=await signedTokenTransfer({rpc,wallet,to:state.quote.depositAddress,amount:state.quote.amountIn,feePayer,blockhash});
  if(!feePayer){
   const lamports=await rpc.balance(wallet.address);
   if(lamports<t.lamportsNeeded)throw Error(`the wallet needs ${t.lamportsNeeded} lamports for this transfer (fee${t.createsAccount?' and the deposit token account rent':''}) and has ${lamports}; fund it with SOL or pass --fee-payer privy`);
  }
  Object.assign(state,{solana_tx:t.signature,signed_base64:Buffer.from(t.bytes).toString('base64'),blockhash,lastValidBlockHeight});
  mark('transfer_signed');save();
 }
 if(!state.confirmed){
  try{await rpc.broadcast(Buffer.from(state.signed_base64,'base64'))}
  catch(e){
   const message=String(e?.rpcError?.message??e?.message??e).slice(0,300);
   if(e?.rpcError&&!/already been processed|AlreadyProcessed/i.test(message)){
    // the node refused it outright (preflight): nothing was sent and nobody else holds these bytes
    delete state.solana_tx;delete state.signed_base64;delete state.blockhash;delete state.lastValidBlockHeight;save();
    throw Error(`Solana refused the transfer before sending: ${message}`);
   }
   emit({step:label,stage:'broadcast_uncertain',message});
  }
  mark('transfer_sent');save();
  emit({step:label,stage:'transfer_sent',solana_tx:state.solana_tx,at:state.at.transfer_sent});
  for(const t0=now();now()-t0<90_000;){
   const s=await signatureStatus(state.solana_tx);
   if(s.status==='failed')throw Error(`Solana transfer ${state.solana_tx} failed on chain`);
   if(['confirmed','finalized'].includes(s.status)){state.confirmed=true;mark('solana_confirmed');save();break}
   if(s.status==='not_found'&&!(await rpc.blockhashValid(state.blockhash,state.lastValidBlockHeight)))throw Error('the Solana transfer expired before it landed; run the step again');
   await sleep(2000);
  }
  if(!state.confirmed)throw Error('the Solana transfer is not confirmed yet; run the step again');
 }
 emit({step:label,stage:'solana_confirmed',solana_tx:state.solana_tx,at:state.at.solana_confirmed});
 // ---- 1Click ----
 if(!state.submitted){
  try{await client.submitDeposit(state.quote.depositAddress,state.solana_tx);state.submitted=true;mark('deposit_submitted');save()}
  catch(e){emit({step:label,stage:'deposit_submit_refused',message:String(e?.message??e).slice(0,200)})}
 }
 for(const t0=now();;){
  let s;
  try{s=await client.status(state.quote.depositAddress)}catch(e){
   emit({step:label,stage:'status_unavailable',message:String(e?.message??e).slice(0,160)});
   // the status answer could not be read: the on-chain balance is the truth (needs the balance taken before the transfer)
   if(watch&&state.balance_before!==undefined&&!TERMINAL.includes(state.status)){
    let got=null;try{got=BigInt(await watch.read())-BigInt(state.balance_before)}catch{}
    if(got!==null&&got>=BigInt(state.quote.minAmountOut??state.quote.amountOut)){
     state.status='SUCCESS';state.status_source='balance';state.amount_out=String(got);
     mark('oneclick_success');save();
     emit({step:label,stage:'oneclick_status',status:'SUCCESS',status_source:'balance',amount_out:state.amount_out,at:state.at.oneclick_success});
     break;
    }
   }
  }
  if(s&&s.status!==state.status){
   state.status=s.status;state.amount_out=s.swapDetails?.amountOut??state.amount_out??null;
   mark(`oneclick_${s.status.toLowerCase()}`);save();
   emit({step:label,stage:'oneclick_status',status:s.status,amount_out:state.amount_out,at:state.at[`oneclick_${s.status.toLowerCase()}`]});
  }
  if(TERMINAL.includes(state.status))break;
  if(now()-t0>=waitMs){emit({step:label,stage:'still_pending',status:state.status??null});break}
  await sleep(4000);
 }
 return state;
}

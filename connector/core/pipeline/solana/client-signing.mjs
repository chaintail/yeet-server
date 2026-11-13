// The person signs, YEET's fee payer co-signs. Lifted from Folio (stock-app origin/main 70848f097)
// apps/server/src/trade/client-signing.ts `createClientSigning`:
//   issue    = Folio execute():  fresh blockhash, guards on the unsigned bytes, both slots empty, fee reserved and the
//              pending send written in one transaction, {transaction_base64, transaction_hash} answered
//   signed   = Folio signed():   in-process join on identical bytes; canonical base64 of at most 1644 characters; the
//              person's slot verified over the unchanged message; already-signed attempts recover (same signature,
//              no second co-sign); guards and fee again; admission again; blockhash still valid else SIGN_EXPIRED;
//              admission once more (Folio audit R17); durable claim; fee payer co-sign; answer re-verified; signed
//              bytes committed BEFORE the first send; broadcast with maxRetries 0
//   recover  = Folio recoverOnce(): signature status; landed -> sent; chain failure -> failed; not found -> rebroadcast
//              the same durable bytes while the blockhash is valid; expired -> never-landed proof on two separate
//              passes after the finalized height passed the last valid height (Folio expiredNeverLanded); an
//              interrupted co-sign with no persisted bytes ends only once that height has passed
// Dropped from Folio: Kamino plans and receipts, execution observations, the 2 s rebroadcast timer (the tracker tick
// rebroadcasts), analytics and founder pages (alerts go to trade_alerts). A dry run stops after validation and a
// signature-free simulateTransaction: nothing is co-signed or sent.
import {TradeError} from '../../trade/util.mjs';
import {assertSponsorable,sponsoredSendKey,SponsorshipRefusal} from './sponsorship.mjs';
import {verifySolanaPartialTransaction,verifySolanaSignedTransaction} from './verify.mjs';
import {decodeTransaction,associatedTokenAddress,MAX_TRANSACTION_BASE64} from './message.mjs';
import {buildLegTransaction} from './transfer-leg.mjs';
import {definiteRefusal} from './fee-payer.mjs';

/** A Solana sign request lives about as long as its blockhash (~60-90 s); the server window is 60 s. */
export const SOLANA_SIGN_WINDOW_MS=60_000;

const b64=bytes=>Buffer.from(bytes).toString('base64');
/** A refusal with a contract code; `reason` (Folio's name for it) is logged and kept as detail. */
function refusal(code,reason,extra={}){const e=new TradeError(code,reason);e.reason=reason;Object.assign(e,extra);return e}
const SPONSOR_CODE={SPONSOR_QUOTA_EXHAUSTED:'LIMIT_EXCEEDED'};
const asTrade=e=>e instanceof SponsorshipRefusal?refusal(SPONSOR_CODE[e.reason]??'INVALID_ARGUMENT',e.reason,{scope:e.scope}):e;

export function createClientSigning({ledger,rpc,signatureStatus,historySignatureStatus=signatureStatus,feePayer,floor,gate,now=Date.now,log=()=>{},
 liveBroadcast=true,computeUnitLimit,priorityMicroLamports,maxFeeLamports}){
 const activeClaims=new Set(),joins=new Map(),expiryProofs=new Map();
 const event=e=>{try{log(e)}catch{}};
 const ref=id=>String(id).slice(0,12);
 const valid=a=>a.unsigned_base64&&a.last_valid_block_height?rpc.blockhashValid(decodeTransaction(Buffer.from(a.unsigned_base64,'base64')).message.blockhash,a.last_valid_block_height):Promise.resolve(false);
 const pastExpiry=async(a,commitment='finalized')=>{const h=await rpc.blockHeight(commitment);return BigInt(h)>BigInt(a.last_valid_block_height)?h:null};

 async function broadcast(a){
  if(!liveBroadcast||!a.signed_base64)return false;
  // Review finding 9: every send, first or rebroadcast, re-reads the kill switch, YEET_LIVE, the allowlist and the pause.
  try{gate(a.account_id)}catch{event({event:'broadcast_paused',attempt:ref(a.attempt_id)});return false}
  try{await rpc.broadcast(Buffer.from(a.signed_base64,'base64'));ledger.recordSent(a.attempt_id);return true}
  catch(e){event({event:'broadcast_failed',attempt:ref(a.attempt_id),error:String(e?.message??e).slice(0,120)});return false}
 }

 /** The landed / failed / expired outcome of one attempt; never calls the fee payer. */
 async function recoverAttempt(id){
  const a=ledger.attempt(id);
  if(!a||['confirmed','failed','abandoned'].includes(a.status))return {state:a?.status??'unknown',attempt:a};
  const leg={tradeId:a.trade_id,legIdx:a.leg_idx};
  if(a.status==='pending'){
   if(now()>a.expires_at||!await valid(a)){ledger.endAttempt(id,'pending','SIGN_EXPIRED');return {...leg,state:'expired'}}
   return {...leg,state:'awaiting_signature'};
  }
  if(a.status==='signing'){
   // No persisted bytes. Only a finalized height past the last valid height proves the message can no longer land.
   if(a.signed_base64||activeClaims.has(id))return {...leg,state:'pending'};
   const h=await pastExpiry(a).catch(()=>null);
   if(h!==null&&!activeClaims.has(id)&&ledger.endAttempt(id,'signing','CO_SIGN_INTERRUPTED',{finalized_height:h}))return {...leg,state:'failed'};
   return {...leg,state:'pending'};
  }
  // confirming: durable signed bytes exist.
  let seen;
  try{seen=await signatureStatus(a.signature)}catch(e){event({event:'signature_status_unavailable',attempt:ref(id)});return {...leg,state:'pending',txHash:a.signature}}
  if(seen.status==='confirmed'||seen.status==='finalized'){expiryProofs.delete(id);ledger.confirmed(id,{commitment:seen.status});return {...leg,state:'sent',txHash:a.signature}}
  if(seen.status==='failed'&&(seen.commitment==='confirmed'||seen.commitment==='finalized')){
   ledger.endAttempt(id,'chain','EXEC_SUBMISSION_FAILED',{chain_error:seen.err??null});return {...leg,state:'failed',txHash:a.signature};
  }
  if(seen.status==='not_found'){
   const finalized=await pastExpiry(a).catch(()=>null);
   if(finalized===null){expiryProofs.delete(id);if(await valid(a).catch(()=>false))await broadcast(a);return {...leg,state:'pending',txHash:a.signature}}
   // Expired: the landing check must follow the expiry proof, on the history RPC, on two separate passes.
   const again=await historySignatureStatus(a.signature).catch(()=>null);
   if(again?.status!=='not_found'){expiryProofs.delete(id);return {...leg,state:'pending',txHash:a.signature}}
   const first=expiryProofs.get(id);
   if(first===undefined||finalized<first){expiryProofs.set(id,finalized);event({event:'expiry_proof_pending',attempt:ref(id),finalized_height:finalized});return {...leg,state:'pending',txHash:a.signature}}
   expiryProofs.delete(id);
   ledger.endAttempt(id,'expired','expired, never landed',{last_valid_height:a.last_valid_block_height,finalized_height:finalized,first_proof_height:first});
   return {...leg,state:'not_sent'};
  }
  return {...leg,state:'pending',txHash:a.signature};
 }

 return {
  recoverAttempt,
  activeClaims:()=>activeClaims.size,
  /** Folio execute(): the unsigned leg transaction for the person to sign, both slots empty. */
  async issue({trade,leg,accountId,pin,exit,expiresCap}){
   gate(accountId);
   const {blockhash,lastValidBlockHeight}=await rpc.latestBlockhash();
   const exists=!!(await rpc.accountInfo(associatedTokenAddress(pin.depositOwner,pin.mint,pin.tokenProgram)));
   const bytes=buildLegTransaction(pin,{blockhash,createDestination:!exists,computeUnitLimit,priorityMicroLamports});
   let g;try{g=assertSponsorable(bytes,{...pin,maxFeeLamports})}catch(e){throw asTrade(e)}
   const tx=decodeTransaction(bytes);
   if(tx.signatures.some(s=>s.some(x=>x!==0)))throw refusal('TEMPORARILY_UNAVAILABLE','CLIENT_ATTEMPT_FORBIDDEN');
   const payload={transaction_base64:b64(bytes),last_valid_block_height:lastValidBlockHeight};
   const payloadSha256=sponsoredSendKey(bytes),expiresAt=Math.min(now()+SOLANA_SIGN_WINDOW_MS,expiresCap??Infinity);
   let row;
   try{row=ledger.issue({tradeId:trade.id,idx:leg.idx,accountId,wallet:pin.wallet,chain:'sol',kind:'solana_tx',payload,payloadSha256,unsignedBase64:payload.transaction_base64,
    lastValidBlockHeight,expiresAt,sponsor:{lamports:g.feeLamports,rentLamports:g.rentLamports,idempotencyKey:payloadSha256,exit:!!exit}})}
   catch(e){throw asTrade(e)}
   event({event:'execute_issued',attempt:ref(row.attempt_id),trade:trade.id,leg:leg.idx,fee_lamports:g.feeLamports,rent_lamports:g.rentLamports,last_valid_height:lastValidBlockHeight,
    fee_payer6:pin.feePayer.slice(0,6),wallet6:pin.wallet.slice(0,6)});
   return {attemptId:row.attempt_id,payload,payloadSha256,expiresAt,feeLamports:g.feeLamports,rentLamports:g.rentLamports};
  },

  /** Folio signed(). Returns {state, txHash?, simulation?}. */
  signed(id,encoded,{accountId,wallet,pin,dryRun=false}){
   const key=JSON.stringify([id,accountId,wallet,encoded,dryRun]);
   const active=joins.get(key);if(active)return active;
   const run=(async()=>{
    const a=ledger.attempt(id);
    if(!a||a.account_id!==accountId||a.wallet!==wallet||a.chain!=='sol')throw refusal('INVALID_ARGUMENT','CLIENT_ATTEMPT_FORBIDDEN');
    if(typeof encoded!=='string'||encoded.length>MAX_TRANSACTION_BASE64||!a.unsigned_base64)throw refusal('INVALID_ARGUMENT','CLIENT_SIGNATURE_INVALID');
    const partial=Buffer.from(encoded,'base64'),original=Buffer.from(a.unsigned_base64,'base64');
    if(partial.toString('base64')!==encoded||!verifySolanaPartialTransaction(original,partial,wallet)){
     event({event:'signature_invalid',attempt:ref(id),why:partial.toString('base64')!==encoded?'not_base64':'verify_failed'});
     throw refusal('INVALID_ARGUMENT','CLIENT_SIGNATURE_INVALID');
    }
    // Signed bytes already exist: the stored outcome, never a second co-sign.
    if(a.signed_base64)return recoverAttempt(id);
    if(a.status==='signing')throw refusal('TEMPORARILY_UNAVAILABLE','CLIENT_SIGNING_IN_PROGRESS');
    if(a.status!=='pending')return {state:a.status==='abandoned'?'expired':'not_sent'};
    let g;try{g=assertSponsorable(partial,{...pin,maxFeeLamports})}catch(e){throw asTrade(e)}
    if(decodeTransaction(partial).message.accounts[0]!==feePayer.address)throw refusal('INVALID_ARGUMENT','CLIENT_ATTEMPT_FORBIDDEN');
    gate(accountId);
    if(now()>a.expires_at||!await valid(a)){
     event({event:'blockhash_expired',attempt:ref(id)});
     ledger.endAttempt(id,'pending','CLIENT_BLOCKHASH_EXPIRED');
     return {state:'expired'};
    }
    if(dryRun){
     const simulation=await rpc.simulate(partial).catch(e=>({err:'SIMULATION_UNAVAILABLE',logs:[String(e?.message??e).slice(0,120)]}));
     event({event:'dry_run_validated',attempt:ref(id),simulation_err:simulation.err?JSON.stringify(simulation.err).slice(0,120):null});
     return {state:'not_sent',dryRun:true,simulation,feeLamports:g.feeLamports,rentLamports:g.rentLamports};
    }
    if(!liveBroadcast)throw refusal('TRADING_PAUSED','LIVE_BROADCAST_DISABLED');
    // Again after the awaits (Folio audit R17): a halt that flipped meanwhile refuses before the claim and co-sign.
    gate(accountId);
    if(floor&&!await floor.check(g.feeLamports+g.rentLamports))throw refusal('TEMPORARILY_UNAVAILABLE','SPONSOR_UNAVAILABLE');
    let claimed;try{claimed=ledger.claim(id,{lamports:g.feeLamports})}catch(e){throw asTrade(e)}
    if(!claimed){const cur=ledger.attempt(id);if(cur?.signed_base64)return recoverAttempt(id);throw refusal('TEMPORARILY_UNAVAILABLE','CLIENT_SIGNING_IN_PROGRESS')}
    activeClaims.add(id);
    try{
     let signed;
     try{signed=await feePayer.signTransaction(Uint8Array.from(partial));event({event:'feepayer_sign',attempt:ref(id),outcome:'ok'})}
     catch(e){
      event({event:'feepayer_sign',attempt:ref(id),outcome:'error',code:e?.code??null});
      if(definiteRefusal(e?.code)){ledger.endAttempt(id,'signing',e.code);return {state:'failed',reason:'CLIENT_FEE_PAYER_REFUSED'}}
      throw refusal('TEMPORARILY_UNAVAILABLE','FEE_PAYER_UNAVAILABLE');
     }
     const verified=verifySolanaSignedTransaction(partial,signed,feePayer.address);
     if(!verified){event({event:'feepayer_signature_invalid',attempt:ref(id)});throw refusal('TEMPORARILY_UNAVAILABLE','CLIENT_SIGNATURE_INVALID')}
     // FULL SQLite commit before any sendTransaction.
     ledger.finishSigning(id,{signedBase64:b64(signed),signature:verified.signature});
     event({event:'signed_bytes_persisted',attempt:ref(id),signature12:verified.signature.slice(0,12)});
     await broadcast(ledger.attempt(id));
     return {state:'pending',txHash:verified.signature};
    }finally{activeClaims.delete(id)}
   })();
   joins.set(key,run);
   run.then(()=>joins.delete(key),()=>joins.delete(key));
   return run;
  },
 };
}

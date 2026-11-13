// Design (a): the YEET key quorum is a delegated signer on the person's own Privy embedded wallets (added at sign-in by
// `addSigners` with the YEET policies). The server signs through the wallet RPC with an authorization signature.
//
// Copied from Folio (stock-app origin/dev): the signed request and headers (privy-api.mjs), POST /v1/wallets/{id}/rpc,
// the per-call idempotency key, app-auth GET /v1/wallets/{id} and the additional_signers check (evm.ts
// signerAttachment), the Solana sponsored send body {method:'signAndSendTransaction', caip2, sponsor:true,
// params:{transaction, encoding:'base64'}} answering data.hash (transport.ts createPrivySponsoredSend).
// Not in Folio (Folio only signs EVM with eth_signTransaction and broadcasts itself), written from the plan and
// Privy's public API naming, to be confirmed against a live app: the EVM body {method:'eth_sendTransaction',
// caip2:'eip155:8453', chain_type:'ethereum', sponsor, params:{transaction:{to,data,value,chain_id}}} answering
// data.hash; GET /v1/users/{did} and its linked_accounts fields.
// Checked against docs.privy.io on 2026-11-13: a sponsored EVM eth_sendTransaction answers data.hash '' with
// data.transaction_id and data.user_operation_hash until the user operation confirms; GET /v1/transactions/{id}
// answers {id, wallet_id, status, transaction_hash}; reference_id (<= 64 chars, top level of the RPC body) is
// listed by GET /v1/transactions?reference_id=; a key reused with another body answers 400; /rpc caches 4xx and 5xx
// against the key for 24 h (policy violations excepted).
import {createPrivyApi,privyConfig,PrivyApiError} from './privy-api.mjs';
import {USDC_BASE,BASE_CAIP2,BASE_CHAIN_ID,erc20TransferData,privyFailure} from './signer.mjs';
import {splTransferTransaction,SOLANA_MAINNET_CAIP2} from './solana-tx.mjs';
import {refuse,TradeError,canonical} from './util.mjs';
import {createHash} from 'node:crypto';

const WALLET_ID=/^[A-Za-z0-9_-]{1,128}$/,PRIVY_TX_ID=/^[A-Za-z0-9_-]{1,128}$/,REFERENCE_ID=/^[a-f0-9]{64}$/;
const EVM_HASH=/^0x[0-9a-fA-F]{64}$/,SOL_SIG=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Gas top-up for a wallet with no ETH when Privy sponsorship is off (pattern of Folio bridge/source-gas.ts). */
export const GAS_TOPUP_WEI=30_000_000_000_000n;   // 0.00003 ETH
export const GAS_MIN_WEI=10_000_000_000_000n;     // top up below 0.00001 ETH
/** GET /v1/transactions/{id} statuses that mean nothing moved (docs.privy.io api-reference/transactions/get). */
export const PRIVY_FAILED_STATUSES=new Set(['failed','execution_reverted']);

/**
 * Failures carry `notSent: true` only when nothing can have been broadcast: the call was refused before the transfer
 * request left (bad wallet id, no fee payer, calldata, gas check) or Privy explicitly refused this request (policy
 * denial, authorization refused). A timeout, a 5xx or an answer without a hash may follow a broadcast and carries no
 * flag: the engine then keeps the leg `sending` and resolves it by lookup or with the same idempotency key.
 * A 5xx also carries `cachedFailure: true`: Privy keeps a 5xx on /rpc against the key for 24 h, so the same key can
 * never succeed and the caller must look the transaction up (reference_id) before deciding anything.
 * A 400 for a key reused with another body carries `keyConflict: true`: the key was accepted earlier.
 */
export const DEFINITE_REFUSALS=new Set(['PRIVY_POLICY_DENIED','PRIVY_AUTHORIZATION_DENIED','PRIVY_INSUFFICIENT_FUNDS','INVALID_PRIVY_PATH','INVALID_IDEMPOTENCY_KEY']);
const notSent=fn=>{try{return fn()}catch(e){const t=e?.name==='TradeError'?e:new TradeError('TEMPORARILY_UNAVAILABLE',e?.message);t.notSent=true;throw t}};
const notSentAsync=async fn=>{try{return await fn()}catch(e){const t=e?.name==='TradeError'?e:new TradeError('TEMPORARILY_UNAVAILABLE',e?.message);t.notSent=true;throw t}};
async function rpc(api,walletId,body,idempotencyKey){
 try{return await api.signed('POST',`/v1/wallets/${walletId}/rpc`,body,{idempotencyKey})}
 catch(e){try{privyFailure(e)}catch(t){
  if(DEFINITE_REFUSALS.has(e?.code))t.notSent=true;
  if(Number.isInteger(e?.status))t.privyStatus=e.status;
  if(e?.status>=500)t.cachedFailure=true;
  if(e?.code==='PRIVY_IDEMPOTENCY_CONFLICT')t.keyConflict=true;
  throw t;
 }}
}
const validHash=(chain,h)=>typeof h==='string'&&(chain==='base'?EVM_HASH:SOL_SIG).test(h);
/**
 * A wallet RPC send answer: the chain hash, or (sponsored EVM, docs.privy.io gas transaction handling) an empty hash
 * with `transaction_id` until the user operation confirms. With a Privy transaction id and no hash the transfer was
 * accepted and broadcast: `hashPending`, resolved later by lookupTransfer, never sent again.
 */
export function sendResult(chain,res){
 const d=res?.data??{},txHash=validHash(chain,d.hash)?d.hash:null;
 const transactionId=typeof d.transaction_id==='string'&&PRIVY_TX_ID.test(d.transaction_id)?d.transaction_id:null;
 if(!txHash&&!transactionId)refuse('TEMPORARILY_UNAVAILABLE','send not confirmed');
 return {txHash,transactionId,hashPending:!txHash,...(typeof d.user_operation_hash==='string'?{userOperationHash:d.user_operation_hash}:{})};
}
/** A Privy Transaction object (GET /v1/transactions) as {state, txHash, transactionId, status}. */
function transferState(chain,t){
 const transactionId=typeof t?.id==='string'&&PRIVY_TX_ID.test(t.id)?t.id:null,status=typeof t?.status==='string'?t.status:null;
 if(PRIVY_FAILED_STATUSES.has(status))return {state:'failed',txHash:null,transactionId,status};
 const txHash=validHash(chain,t?.transaction_hash)?t.transaction_hash:null;
 return {state:txHash?'confirmed':'pending',txHash,transactionId,status};
}
/** The stored request of an earlier attempt, sent again byte for byte (never rebuilt under the same key). */
function storedRequest(request,method){
 let body;try{body=JSON.parse(request)}catch{refuse('TEMPORARILY_UNAVAILABLE','stored request unreadable')}
 if(body?.method!==method||typeof body.params!=='object')refuse('TEMPORARILY_UNAVAILABLE','stored request is for another method');
 return body;
}

/**
 * Base and Solana transfers through Privy wallet RPC; shared by the delegated and custodial adapters.
 *   transferUsdcBase / transferSpl args, beyond the transfer itself:
 *     idempotencyKey   privy-idempotency-key of this attempt
 *     referenceId      reference_id in the body (the leg's first key): GET /v1/transactions?reference_id finds the
 *                      transfer whatever key carried it
 *     request          the canonical body of an earlier attempt: sent again exactly, nothing is rebuilt
 *     persistRequest   called with the canonical body before it is sent the first time; a throw means nothing was sent
 *   -> {txHash, transactionId, hashPending}
 *   lookupTransfer({chain, walletId, transactionId | referenceId}) -> {state:'none'|'pending'|'confirmed'|'failed', ...}
 */
export function privyTransfers({api,env,balances}){
 const gasWalletId=env.YEET_GAS_WALLET_ID?.trim()||undefined;
 // YEET_BASE_GAS: `sponsor` (default) sends with Privy gas sponsorship; `self` sends unsponsored, the wallet pays gas
 // from its own ETH (checked before the send). A YEET_GAS_WALLET_ID also sends unsponsored, topped up from that wallet.
 const baseGas=(env.YEET_BASE_GAS?.trim()||'sponsor');
 if(!['sponsor','self'].includes(baseGas))throw Error('Invalid YEET_BASE_GAS');
 const sponsor=!gasWalletId&&baseGas==='sponsor';
 const gasMode=gasWalletId?'gas_wallet':sponsor?'sponsored':'self';
 async function ensureGas(from,idempotencyKey){
  if(!gasWalletId){
   if(gasMode!=='self')return;
   if(!balances?.baseEth)refuse('WALLET_NOT_READY','no Base RPC for the gas check');
   if(await balances.baseEth(from)<GAS_MIN_WEI)refuse('BALANCE_LOW','no ETH for gas (YEET_BASE_GAS=self)');
   return;
  }
  if(!balances?.baseEth)refuse('WALLET_NOT_READY','no Base RPC for the gas check');
  const wei=await balances.baseEth(from);
  if(wei>=GAS_MIN_WEI)return;
  const key=createHash('sha256').update(`yeet-gas:${idempotencyKey}`).digest('hex');
  try{
   await api.signed('POST',`/v1/wallets/${gasWalletId}/rpc`,{method:'eth_sendTransaction',caip2:BASE_CAIP2,chain_type:'ethereum',
    params:{transaction:{to:from,value:`0x${GAS_TOPUP_WEI.toString(16)}`,chain_id:BASE_CHAIN_ID}}},{idempotencyKey:key});
  }catch(e){privyFailure(e)}
 }
 const reference=(referenceId,idempotencyKey)=>{const r=referenceId??idempotencyKey;if(!REFERENCE_ID.test(r??''))refuse('TEMPORARILY_UNAVAILABLE','invalid reference id');return r};
 async function prepared({request,persistRequest,build,method}){
  if(request)return storedRequest(request,method);
  const body=await build();
  await persistRequest?.(canonical(body));
  return body;
 }
 return {
  sponsor,gasMode,
  async transferUsdcBase({walletId,from,to,amountRaw,idempotencyKey,referenceId,request,persistRequest}){
   const body=await notSentAsync(async()=>{
    if(!WALLET_ID.test(walletId??''))refuse('WALLET_NOT_READY','no Base wallet id');
    const body=await prepared({request,persistRequest,method:'eth_sendTransaction',build:()=>({method:'eth_sendTransaction',caip2:BASE_CAIP2,chain_type:'ethereum',sponsor,
     reference_id:reference(referenceId,idempotencyKey),params:{transaction:{to:USDC_BASE,data:erc20TransferData(to,amountRaw),value:'0x0',chain_id:BASE_CHAIN_ID}}})});
    if(body.sponsor===false)await ensureGas(from,idempotencyKey);
    return body;
   });
   return sendResult('base',await rpc(api,walletId,body,idempotencyKey));
  },
  async transferSpl({walletId,owner,source,destinationOwner,mint,decimals,amountRaw,tokenProgram,idempotencyKey,referenceId,request,persistRequest}){
   // SKEET needs Solana gas: until the fee payer is configured this path answers WALLET_NOT_READY.
   const body=await notSentAsync(async()=>{
    if(!env.YEET_SOL_FEE_PAYER_ID?.trim())refuse('WALLET_NOT_READY','Solana fee payer not configured');
    if(!WALLET_ID.test(walletId??''))refuse('WALLET_NOT_READY','no Solana wallet id');
    return prepared({request,persistRequest,method:'signAndSendTransaction',build:async()=>{
     if(!balances?.recentBlockhash)refuse('TEMPORARILY_UNAVAILABLE','no Solana RPC');
     const transaction=splTransferTransaction({owner,source,destinationOwner,mint,decimals,amountRaw,tokenProgram,recentBlockhash:await balances.recentBlockhash()}).transaction;
     return {method:'signAndSendTransaction',caip2:SOLANA_MAINNET_CAIP2,sponsor:true,reference_id:reference(referenceId,idempotencyKey),params:{transaction,encoding:'base64'}};
    }});
   });
   return sendResult('solana',await rpc(api,walletId,body,idempotencyKey));
  },
  /** One bounded read: the transfer by Privy transaction id, else by reference_id (only this wallet's). */
  async lookupTransfer({chain,walletId,transactionId,referenceId}){
   try{
    if(transactionId){
     if(!PRIVY_TX_ID.test(transactionId))refuse('TEMPORARILY_UNAVAILABLE','invalid Privy transaction id');
     return transferState(chain,await api.app('GET',`/v1/transactions/${transactionId}`));
    }
    if(!REFERENCE_ID.test(referenceId??''))refuse('TEMPORARILY_UNAVAILABLE','invalid reference id');
    const list=(await api.app('GET','/v1/transactions',undefined,{query:{reference_id:referenceId}}))?.transactions;
    if(!Array.isArray(list))refuse('TEMPORARILY_UNAVAILABLE','transaction list unreadable');
    const mine=list.filter(t=>!walletId||t?.wallet_id===walletId).map(t=>transferState(chain,t));
    return mine.find(t=>t.state==='confirmed')??mine.find(t=>t.state==='pending')??mine.find(t=>t.state==='failed')??{state:'none',txHash:null,transactionId:null,status:null};
   }catch(e){
    if(e instanceof PrivyApiError&&e.status===404)return {state:'none',txHash:null,transactionId:null,status:null};
    privyFailure(e);
   }
  },
 };
}

/** Our key quorum among a wallet's additional_signers (Folio evm.ts signerAttachment). */
/** `policyId` is the single policy id when exactly one entry for our quorum carries exactly one policy; otherwise every
 * id joined by commas (or null when there is none), which never equals the expected id, so the executor refuses. */
export function signerAttachment(wallet,keyQuorumId){
 const all=Array.isArray(wallet?.additional_signers)?wallet.additional_signers:[];
 const ours=all.filter(s=>s&&typeof s==='object'&&s.signer_id===keyQuorumId);
 const ids=ours.flatMap(s=>Array.isArray(s.override_policy_ids)?s.override_policy_ids.map(String):[]);
 const policy=ours.length===1&&ids.length===1?ids[0]:ids.length?ids.join(','):null;
 return {granted:!!keyQuorumId&&ours.length>0,policyId:policy};
}

/** The person's embedded wallets from Privy, plus whether the YEET signer is attached. */
export function privyDirectory({api,didFor,keyQuorumId}){
 return {
  stable:false,
  async lookup(accountId){
   const did=didFor?.(accountId);
   if(typeof did!=='string'||!/^did:privy:[A-Za-z0-9_-]{1,128}$/.test(did))return null;
   let user;
   try{user=await api.app('GET',`/v1/users/${did}`)}catch(e){if(e instanceof PrivyApiError&&e.status===404)return null;privyFailure(e)}
   const accounts=Array.isArray(user?.linked_accounts)?user.linked_accounts:[];
   const embedded=chain=>accounts.find(a=>a?.type==='wallet'&&a.wallet_client_type==='privy'&&a.chain_type===chain&&typeof a.address==='string'&&typeof a.id==='string');
   const out={};
   for(const [chain,type] of [['base','ethereum'],['solana','solana']]){
    const w=embedded(type);if(!w)return null;
    let state={granted:false,policyId:null};
    if(keyQuorumId&&WALLET_ID.test(w.id)){try{state=signerAttachment(await api.app('GET',`/v1/wallets/${w.id}`),keyQuorumId)}catch(e){privyFailure(e)}}
    out[chain]={address:w.address,walletId:w.id,signerState:state.granted?'granted':'none',policyId:state.policyId};
   }
   return out;
  },
 };
}

const notReady={stable:false,async lookup(){refuse('WALLET_NOT_READY','Privy credentials not configured')}};

export function createDelegatedSigner({env=process.env,fetch=globalThis.fetch,balances,didFor}={}){
 const config=privyConfig(env);
 if(!config){
  const no=async()=>notSent(()=>refuse('WALLET_NOT_READY','Privy credentials not configured'));
  return {kind:'delegated',configured:false,directory:notReady,transferUsdcBase:no,transferSpl:no};
 }
 const api=createPrivyApi({config,fetch,timeoutMs:8000});
 return {kind:'delegated',configured:true,directory:privyDirectory({api,didFor,keyQuorumId:config.keyQuorumId}),...privyTransfers({api,env,balances})};
}

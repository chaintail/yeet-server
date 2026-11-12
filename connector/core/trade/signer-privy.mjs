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
import {createPrivyApi,privyConfig,PrivyApiError} from './privy-api.mjs';
import {USDC_BASE,BASE_CAIP2,BASE_CHAIN_ID,erc20TransferData,privyFailure} from './signer.mjs';
import {splTransferTransaction,SOLANA_MAINNET_CAIP2} from './solana-tx.mjs';
import {refuse,TradeError} from './util.mjs';
import {createHash} from 'node:crypto';

const WALLET_ID=/^[A-Za-z0-9_-]{1,128}$/;
const EVM_HASH=/^0x[0-9a-fA-F]{64}$/,SOL_SIG=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** Gas top-up for a wallet with no ETH when Privy sponsorship is off (pattern of Folio bridge/source-gas.ts). */
export const GAS_TOPUP_WEI=30_000_000_000_000n;   // 0.00003 ETH
export const GAS_MIN_WEI=10_000_000_000_000n;     // top up below 0.00001 ETH

/**
 * Failures carry `notSent: true` only when nothing can have been broadcast: the call was refused before the transfer
 * request left (bad wallet id, no fee payer, calldata, gas check) or Privy explicitly refused this request (policy
 * denial, authorization refused). A timeout, a 5xx or an answer without a hash may follow a broadcast and carries no
 * flag: the engine then keeps the leg `sending` and resolves it with the same idempotency key.
 */
export const DEFINITE_REFUSALS=new Set(['PRIVY_POLICY_DENIED','PRIVY_AUTHORIZATION_DENIED','INVALID_PRIVY_PATH','INVALID_IDEMPOTENCY_KEY']);
const notSent=fn=>{try{return fn()}catch(e){const t=e?.name==='TradeError'?e:new TradeError('TEMPORARILY_UNAVAILABLE',e?.message);t.notSent=true;throw t}};
const notSentAsync=async fn=>{try{return await fn()}catch(e){const t=e?.name==='TradeError'?e:new TradeError('TEMPORARILY_UNAVAILABLE',e?.message);t.notSent=true;throw t}};
async function rpc(api,walletId,body,idempotencyKey){
 try{return await api.signed('POST',`/v1/wallets/${walletId}/rpc`,body,{idempotencyKey})}
 catch(e){try{privyFailure(e)}catch(t){if(DEFINITE_REFUSALS.has(e?.code))t.notSent=true;throw t}}
}

/** Base and Solana transfers through Privy wallet RPC; shared by the delegated and custodial adapters. */
export function privyTransfers({api,env,balances}){
 const gasWalletId=env.YEET_GAS_WALLET_ID?.trim()||undefined;
 const sponsor=!gasWalletId;
 async function ensureGas(from,idempotencyKey){
  if(sponsor)return;
  if(!balances?.baseEth)refuse('WALLET_NOT_READY','no Base RPC for the gas check');
  const wei=await balances.baseEth(from);
  if(wei>=GAS_MIN_WEI)return;
  const key=createHash('sha256').update(`yeet-gas:${idempotencyKey}`).digest('hex');
  try{
   await api.signed('POST',`/v1/wallets/${gasWalletId}/rpc`,{method:'eth_sendTransaction',caip2:BASE_CAIP2,chain_type:'ethereum',
    params:{transaction:{to:from,value:`0x${GAS_TOPUP_WEI.toString(16)}`,chain_id:BASE_CHAIN_ID}}},{idempotencyKey:key});
  }catch(e){privyFailure(e)}
 }
 return {
  sponsor,
  async transferUsdcBase({walletId,from,to,amountRaw,idempotencyKey}){
   const data=await notSentAsync(async()=>{
    if(!WALLET_ID.test(walletId??''))refuse('WALLET_NOT_READY','no Base wallet id');
    const data=erc20TransferData(to,amountRaw);
    await ensureGas(from,idempotencyKey);
    return data;
   });
   const res=await rpc(api,walletId,{method:'eth_sendTransaction',caip2:BASE_CAIP2,chain_type:'ethereum',sponsor,
    params:{transaction:{to:USDC_BASE,data,value:'0x0',chain_id:BASE_CHAIN_ID}}},idempotencyKey);
   const hash=res?.data?.hash;
   if(typeof hash!=='string'||!EVM_HASH.test(hash))refuse('TEMPORARILY_UNAVAILABLE','send not confirmed');
   return {txHash:hash};
  },
  async transferSpl({walletId,owner,source,destinationOwner,mint,decimals,amountRaw,tokenProgram,idempotencyKey}){
   // SKEET needs Solana gas: until the fee payer is configured this path answers WALLET_NOT_READY.
   const transaction=await notSentAsync(async()=>{
    if(!env.YEET_SOL_FEE_PAYER_ID?.trim())refuse('WALLET_NOT_READY','Solana fee payer not configured');
    if(!WALLET_ID.test(walletId??''))refuse('WALLET_NOT_READY','no Solana wallet id');
    if(!balances?.recentBlockhash)refuse('TEMPORARILY_UNAVAILABLE','no Solana RPC');
    return splTransferTransaction({owner,source,destinationOwner,mint,decimals,amountRaw,tokenProgram,recentBlockhash:await balances.recentBlockhash()}).transaction;
   });
   const res=await rpc(api,walletId,{method:'signAndSendTransaction',caip2:SOLANA_MAINNET_CAIP2,sponsor:true,
    params:{transaction,encoding:'base64'}},idempotencyKey);
   const sig=res?.data?.hash;
   if(typeof sig!=='string'||!SOL_SIG.test(sig))refuse('TEMPORARILY_UNAVAILABLE','send not confirmed');
   return {txHash:sig};
  },
 };
}

/** Our key quorum among a wallet's additional_signers (Folio evm.ts signerAttachment). */
export function signerAttachment(wallet,keyQuorumId){
 const all=Array.isArray(wallet?.additional_signers)?wallet.additional_signers:[];
 const ours=all.filter(s=>s&&typeof s==='object'&&s.signer_id===keyQuorumId);
 const policy=Array.isArray(ours[0]?.override_policy_ids)?ours[0].override_policy_ids[0]??null:null;
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
   const embedded=chain=>accounts.find(a=>a?.type==='wallet'&&['privy','privy-v2'].includes(a.wallet_client_type)&&a.chain_type===chain&&typeof a.address==='string'&&typeof a.id==='string');
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

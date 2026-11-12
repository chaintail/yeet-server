// Design (c): one Privy server wallet per account and chain, owned by the YEET authorization key (or the YEET key
// quorum when YEET_PRIVY_KEY_QUORUM_ID is set). The person funds it; the server signs within the server caps. Same
// Signer interface and the same wallet RPC as the delegated adapter.
// Wallet creation body {chain_type, owner:{public_key}} on POST /v1/wallets is the shape Folio verified live
// (docs/research/2026-09-19-privy-policy-schema.md); `owner_id` for a key quorum is the documented alternative.
import {createHash} from 'node:crypto';
import {createPrivyApi,privyConfig,authorizationPublicKey} from './privy-api.mjs';
import {privyTransfers} from './signer-privy.mjs';
import {privyFailure} from './signer.mjs';
import {refuse} from './util.mjs';

export function custodialDirectory({api,config}){
 const owner=config.keyQuorumId?{owner_id:config.keyQuorumId}:{owner:{public_key:authorizationPublicKey(config.authorizationKey)}};
 async function create(accountId,chainType){
  // Same account and chain always reuse one idempotency key, so a lost response never creates a second wallet.
  const idempotencyKey=createHash('sha256').update(`yeet-custodial:${config.appId}:${accountId}:${chainType}`).digest('hex');
  let w;
  try{w=await api.app('POST','/v1/wallets',{chain_type:chainType,...owner},{idempotencyKey})}catch(e){privyFailure(e)}
  if(typeof w?.id!=='string'||typeof w?.address!=='string')refuse('TEMPORARILY_UNAVAILABLE','wallet not created');
  return {address:w.address,walletId:w.id,signerState:'granted',policyId:null};
 }
 return {
  // Stored server wallets never change, so the wallet table is the source of truth once written.
  stable:true,
  async lookup(accountId){return {base:await create(accountId,'ethereum'),solana:await create(accountId,'solana')}},
 };
}

export function createCustodialSigner({env=process.env,fetch=globalThis.fetch,balances}={}){
 const config=privyConfig(env);
 if(!config){
  const no=async()=>refuse('WALLET_NOT_READY','Privy credentials not configured');
  const noSend=async()=>{try{await no()}catch(e){e.notSent=true;throw e}};
  return {kind:'custodial',configured:false,directory:{stable:true,lookup:no},transferUsdcBase:noSend,transferSpl:noSend};
 }
 const api=createPrivyApi({config,fetch,timeoutMs:8000});
 return {kind:'custodial',configured:true,directory:custodialDirectory({api,config}),...privyTransfers({api,env,balances})};
}

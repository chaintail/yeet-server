// The YEET fee payer: a Privy server wallet that signs only its own slot (signer 0). Lifted from Folio (stock-app
// origin/main 70848f097) packages/wallet-privy/src/fee-payer.ts `createPrivyServerWalletSigner`: POST
// /v1/wallets/{id}/rpc {method: signTransaction, params: {transaction, encoding: base64}}, answer must be canonical
// base64 and pass verifySolanaSignedTransaction against the bytes sent. Transport: trade/privy-api.mjs (Folio's
// signedRequest shape, authorization signature with YEET_PRIVY_AUTHORIZATION_KEY).
// Env: YEET_SOL_FEE_PAYER_ID (Privy wallet id), YEET_SOL_FEE_PAYER_ADDRESS (its address, checked on every answer).
import {createPrivyApi,privyConfig,PrivyApiError} from '../../trade/privy-api.mjs';
import {verifySolanaSignedTransaction} from './verify.mjs';
import {isAddress} from './message.mjs';

export class FeePayerError extends Error{constructor(code,status){super(code);this.name='FeePayerError';this.code=code;if(status)this.status=status}}
/** Folio client-signing.ts: a definite refusal (policy, authorization, 4xx other than 408/429) means nothing was signed. */
export const definiteRefusal=code=>/^(PRIVY_POLICY_DENIED|PRIVY_AUTHORIZATION_DENIED|PRIVY_HTTP_4(?!08|29)\d\d)$/.test(code??'');

const WALLET_ID=/^[A-Za-z0-9_-]{1,128}$/;
export function createPrivyFeePayer({api,walletId,address}){
 if(!WALLET_ID.test(walletId??''))throw new FeePayerError('INVALID_FEE_PAYER_WALLET_ID');
 if(!isAddress(address))throw new FeePayerError('INVALID_FEE_PAYER_ADDRESS');
 return Object.freeze({address,provider:'privy',
  async signTransaction(partial){
   const original=Uint8Array.from(partial);
   let res;
   try{res=await api.signed('POST',`/v1/wallets/${walletId}/rpc`,{method:'signTransaction',params:{transaction:Buffer.from(original).toString('base64'),encoding:'base64'}})}
   catch(e){if(e instanceof PrivyApiError)throw new FeePayerError(e.code,e.status);throw e}
   const encoded=res?.data?.signed_transaction;
   if(res?.data?.encoding!=='base64'||typeof encoded!=='string')throw new FeePayerError('INVALID_FEE_PAYER_SIGNATURE');
   const signed=Buffer.from(encoded,'base64');
   if(signed.toString('base64')!==encoded||!verifySolanaSignedTransaction(original,signed,address))throw new FeePayerError('INVALID_FEE_PAYER_SIGNATURE');
   return Uint8Array.from(signed);
  }});
}
/** The configured fee payer, or null when YEET_SOL_FEE_PAYER_ID / _ADDRESS or the Privy credentials are missing. */
export function feePayerFromEnv(env=process.env,{fetch=globalThis.fetch}={}){
 const walletId=env.YEET_SOL_FEE_PAYER_ID?.trim(),address=env.YEET_SOL_FEE_PAYER_ADDRESS?.trim(),config=privyConfig(env);
 if(!walletId||!address||!config)return null;
 return createPrivyFeePayer({api:createPrivyApi({config,fetch,timeoutMs:10_000}),walletId,address});
}

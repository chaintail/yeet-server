// The person's embedded Privy wallets (Base and Solana addresses and wallet ids), for trade/wallets.mjs. Lifted from
// trade/signer-privy.mjs `privyDirectory` without the signer-attachment check: in the user-signed pipeline no YEET key
// is attached to a person's wallet, so there is no signer state to read. Every wallet reports signerState 'none'.
import {createPrivyApi,privyConfig,PrivyApiError} from '../trade/privy-api.mjs';
import {refuse} from '../trade/util.mjs';

export function privyWalletDirectory({api,didFor}){
 return {
  stable:false,
  async lookup(accountId){
   const did=didFor?.(accountId);
   if(typeof did!=='string'||!/^did:privy:[A-Za-z0-9_-]{1,128}$/.test(did))return null;
   let user;
   try{user=await api.app('GET',`/v1/users/${did}`)}
   catch(e){if(e instanceof PrivyApiError&&e.status===404)return null;refuse('TEMPORARILY_UNAVAILABLE',e?.code||'privy user lookup failed')}
   const accounts=Array.isArray(user?.linked_accounts)?user.linked_accounts:[];
   const embedded=type=>accounts.find(a=>a?.type==='wallet'&&a.wallet_client_type==='privy'&&a.chain_type===type&&typeof a.address==='string'&&typeof a.id==='string');
   const out={};
   for(const [chain,type] of [['base','ethereum'],['solana','solana']]){
    const w=embedded(type);if(!w)return null;
    out[chain]={address:w.address,walletId:w.id,signerState:'none',policyId:null};
   }
   return out;
  },
 };
}
const notReady={stable:false,async lookup(){refuse('WALLET_NOT_READY','Privy credentials not configured')}};
/** From PRIVY_APP_ID / PRIVY_APP_SECRET / YEET_PRIVY_AUTHORIZATION_KEY; answers WALLET_NOT_READY without them. */
export function walletDirectoryFromEnv({env=process.env,fetch=globalThis.fetch,didFor}={}){
 const config=privyConfig(env);
 return config?privyWalletDirectory({api:createPrivyApi({config,fetch,timeoutMs:8000}),didFor}):notReady;
}
/** A fixed directory (operator tool, tests): {accountId: {base:{address}, solana:{address}}}. */
export function staticWalletDirectory(map){
 return {stable:true,async lookup(accountId){const w=map[accountId];if(!w)return null;
  return {base:{address:w.base.address,walletId:w.base.walletId??null,signerState:'none',policyId:null},solana:{address:w.solana.address,walletId:w.solana.walletId??null,signerState:'none',policyId:null}}}};
}

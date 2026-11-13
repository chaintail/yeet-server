// Server-side wallet setup at sign-in: the person's Base (Ethereum) and Solana embedded wallets are created by the
// server, owned by the person, with the YEET key quorum attached as an additional signer under the chain's policy, so
// no browser wallet call is needed. docs.privy.io (checked 2026-11-13):
//   api-reference/wallets/create: POST /v1/wallets, Basic auth + privy-app-id, optional privy-idempotency-key; body
//     {chain_type, owner: {user_id}, additional_signers: [{signer_id, override_policy_ids}]}; answers the Wallet
//     {id, address, chain_type, owner_id, additional_signers}. No authorization signature for creation.
//   recipes/pregenerate-wallets: wallets created for a user "automatically appear in their account" and "work
//     identically to wallets created during login".
//   wallets/using-wallets/signers/add-signers: updating a wallet's signers later needs the owner's signature, so a
//     wallet that already exists without the YEET signer is reported `signer: 'missing'` and the page adds it.
// Idempotent: the user's linked wallets are read first and a chain that has a wallet is never created again;
// concurrent calls for one person share one run; the create key is stable per person, chain and 10-minute window
// (a replay answers the same wallet) and moves on after a failure (Privy caches 4xx/5xx answers against a key).
import {createHash} from 'node:crypto';
import {createPrivyApi,privyConfig,PrivyApiError} from './privy-api.mjs';
import {signerAttachment} from './signer-privy.mjs';

export const WALLET_CHAINS=[['base','ethereum'],['solana','solana']];
const DID=/^did:privy:[A-Za-z0-9_-]{1,128}$/,ID=/^[A-Za-z0-9_-]{1,128}$/;
export const KEY_WINDOW_MS=10*60_000;

export class WalletSetupError extends Error{constructor(code,{chain,status}={}){super(code);this.name='WalletSetupError';this.code=code;this.chain=chain;this.status=status}}

/** The person's embedded wallets per chain from a Privy User (REST shape, snake_case). */
export function linkedWallets(user){
 const accounts=Array.isArray(user?.linked_accounts)?user.linked_accounts:[];
 const find=type=>accounts.find(a=>a?.type==='wallet'&&(a.wallet_client_type==='privy'||a.wallet_client_type==='privy-v2')&&a.chain_type===type&&!a.imported&&typeof a.address==='string');
 return Object.fromEntries(WALLET_CHAINS.map(([chain,type])=>[chain,find(type)]));
}

/** Settings from the core env; null when Privy or the YEET signer is not configured. */
export function walletSetupConfig(env=process.env){
 const privy=privyConfig(env);
 const v=n=>{const x=env[n]?.trim();return x&&ID.test(x)?x:undefined};
 const signerId=privy?.keyQuorumId,policyIds={base:v('YEET_BASE_POLICY_ID'),solana:v('YEET_SOLANA_POLICY_ID')};
 if(!privy||!signerId||!ID.test(signerId)||!policyIds.base||!policyIds.solana)return null;
 return {privy,signerId,policyIds};
}

const log=(event,fields)=>console.log(JSON.stringify({event,...fields}));

/**
 * ensure(accountId, did) -> {ready, chains: {base, solana}: {address, created, signer: 'attached'|'missing'}}.
 * `ready` is true when both wallets exist and both carry the YEET signer with the chain's policy.
 * Throws WalletSetupError (code, chain, Privy status) when Privy refuses or cannot be reached.
 */
export function createWalletEnsurer({config,fetch=globalThis.fetch,now=Date.now,logger=log}){
 const api=createPrivyApi({config:config.privy,fetch,timeoutMs:15_000});
 const running=new Map(),failures=new Map();
 const key=(did,chain)=>createHash('sha256').update(`yeet-wallet-ensure:${did}:${chain}:${Math.floor(now()/KEY_WINDOW_MS)}:${failures.get(`${did}:${chain}`)??0}`).digest('hex');
 const call=async(chain,fn)=>{
  try{return await fn()}
  catch(e){
   if(chain)failures.set(chain,(failures.get(chain)??0)+1);
   throw e instanceof PrivyApiError?new WalletSetupError(e.code,{status:e.status}):e;
  }
 };
 const signerState=wallet=>{const s=signerAttachment(wallet,config.signerId);return s.granted&&s.policyId===config.policyIds[wallet.__chain]?'attached':'missing'};

 async function run(accountId,did){
  const t0=now();
  logger('wallet_ensure_start',{account:accountId});
  let user;
  try{user=await call(null,()=>api.app('GET',`/v1/users/${did}`))}
  catch(e){logger('wallet_ensure_failed',{account:accountId,step:'read_user',code:e.code,privy_status:e.status??null});throw e}
  const have=linkedWallets(user),chains={};
  for(const [chain,type] of WALLET_CHAINS){
   const existing=have[chain];
   try{
    if(existing){
     let state='missing';
     if(typeof existing.id==='string'&&ID.test(existing.id)){
      const w=await call(null,()=>api.app('GET',`/v1/wallets/${existing.id}`));
      state=signerState({...w,__chain:chain});
     }
     chains[chain]={address:existing.address,created:false,signer:state};
     logger('wallet_ensure_exists',{account:accountId,chain,signer:state});
     continue;
    }
    const body={chain_type:type,owner:{user_id:did},additional_signers:[{signer_id:config.signerId,override_policy_ids:[config.policyIds[chain]]}]};
    const w=await call(`${did}:${chain}`,()=>api.app('POST','/v1/wallets',body,{idempotencyKey:key(did,chain)}));
    if(typeof w?.address!=='string')throw new WalletSetupError('PRIVY_CREATE_UNREADABLE');
    const state=signerState({...w,__chain:chain});
    chains[chain]={address:w.address,created:true,signer:state};
    logger('wallet_ensure_created',{account:accountId,chain,signer:state});
   }catch(e){
    const err=e instanceof WalletSetupError?e:new WalletSetupError('WALLET_SETUP_FAILED');
    err.chain=chain;
    logger('wallet_ensure_failed',{account:accountId,chain,code:err.code,privy_status:err.status??null});
    throw err;
   }
  }
  const ready=WALLET_CHAINS.every(([c])=>chains[c].signer==='attached');
  logger('wallet_ensure_done',{account:accountId,ready,ms:now()-t0});
  return {ready,chains};
 }

 return {
  ensure(accountId,did){
   if(!DID.test(did??''))return Promise.reject(new WalletSetupError('UNKNOWN_ACCOUNT'));
   if(running.has(did))return running.get(did);
   const p=run(accountId,did).finally(()=>running.delete(did));
   running.set(did,p);
   return p;
  },
 };
}

/** Plain text for the sign-in page when setup fails. */
export function walletSetupMessage(code){
 if(code==='WALLET_SETUP_UNAVAILABLE')return 'Wallet setup is not available right now. Please try again later.';
 if(code==='PRIVY_TRANSPORT_UNAVAILABLE'||/^PRIVY_HTTP_5\d\d$/.test(code??''))return 'Our wallet provider did not answer. Nothing was charged. Tap Try again.';
 if(code==='PRIVY_HTTP_429')return 'Too many wallet requests right now. Wait a minute, then tap Try again.';
 return 'YEET could not set up your wallets. Nothing was charged. Tap Try again.';
}

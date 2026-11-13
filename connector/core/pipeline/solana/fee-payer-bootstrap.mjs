// Creates the YEET fee payer: a Privy Solana server wallet owned by the YEET authorization key, with the sign-only policy
// (fee-payer-policy.mjs) attached. Lifted from Folio (stock-app origin/main 70848f097)
// packages/wallet-privy/scripts/fee-payer-bootstrap.ts: POST /v1/policies with an idempotency key derived from the app id
// and the policy hash, read the policy back and compare its rules as a multiset, POST /v1/wallets {chain_type solana,
// owner, policy_ids [policy]} with its own idempotency key, read the wallet back (address, chain, exactly that policy).
// The CLI is ops/fee-payer-bootstrap.mjs; `--dry-run` prints the policy body only and calls nothing.
import {createHash} from 'node:crypto';
import {authorizationPublicKey} from '../../trade/privy-api.mjs';
import {canonical} from '../../trade/util.mjs';
import {feePayerPolicy} from './fee-payer-policy.mjs';
import {isAddress} from './message.mjs';

export class BootstrapError extends Error{constructor(code){super(code);this.name='BootstrapError';this.code=code}}
export const policyHash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const ID=/^[A-Za-z0-9_-]+$/;

/** Stored rules may carry a Privy-assigned id and come back in any order (Folio, observed 2026-09-23). */
export function ruleMultiset(value){
 if(!Array.isArray(value))throw new BootstrapError('FEE_PAYER_POLICY_READBACK_REQUIRED');
 return canonical(value.map(entry=>{
  if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new BootstrapError('FEE_PAYER_POLICY_READBACK_REQUIRED');
  const {id,...rule}=entry;
  if(id!==undefined&&(typeof id!=='string'||!id))throw new BootstrapError('FEE_PAYER_POLICY_READBACK_REQUIRED');
  return canonical(rule);
 }).sort());
}
export const expectedRuleMultiset=rules=>canonical(rules.map(r=>canonical(r)).sort());

export async function verifyFeePayerPolicy(api,policyId,body){
 const policy=await api.app('GET',`/v1/policies/${policyId}`);
 // Folio: the policy read returns owner_id rather than the key.
 const ownerMatches=policy?.owner?.public_key!==undefined?policy.owner.public_key===body.owner.public_key:typeof policy?.owner_id==='string'&&policy.owner_id.length>0;
 if(policy?.id!==policyId||policy.chain_type!=='solana'||!ownerMatches||ruleMultiset(policy.rules)!==expectedRuleMultiset(body.rules))throw new BootstrapError('FEE_PAYER_POLICY_READBACK_REQUIRED');
}
export async function verifyFeePayerWallet(api,walletId,policyId,expectedAddress){
 const w=await api.app('GET',`/v1/wallets/${walletId}`);
 if(w?.id!==walletId||!isAddress(w.address)||(expectedAddress!==undefined&&w.address!==expectedAddress)||w.chain_type!=='solana'
  ||!Array.isArray(w.policy_ids)||canonical(w.policy_ids)!==canonical([policyId]))throw new BootstrapError('FEE_PAYER_POLICY_ATTACHMENT_REQUIRED');
}

/** The policy body for this Privy config (dry run). */
export const bootstrapBody=config=>feePayerPolicy(authorizationPublicKey(config.authorizationKey));

/** Returns the env lines for the core: YEET_SOL_FEE_PAYER_ID, YEET_SOL_FEE_PAYER_ADDRESS, the policy id and hash. */
export async function bootstrapFeePayer(config,api){
 const body=bootstrapBody(config),hash=policyHash(body);
 const created=await api.signed('POST','/v1/policies',body,{idempotencyKey:policyHash({app_id:config.appId,policy_hash:hash,resource:'policy'})});
 const policyId=created?.id;
 if(typeof policyId!=='string'||!ID.test(policyId))throw new BootstrapError('FEE_PAYER_POLICY_RESPONSE_INVALID');
 await verifyFeePayerPolicy(api,policyId,body);
 const wallet=await api.signed('POST','/v1/wallets',{chain_type:'solana',owner:body.owner,policy_ids:[policyId]},
  {idempotencyKey:policyHash({app_id:config.appId,policy_hash:hash,resource:'fee-payer-wallet'})});
 const walletId=wallet?.id,address=wallet?.address;
 if(typeof walletId!=='string'||!ID.test(walletId)||!isAddress(address))throw new BootstrapError('FEE_PAYER_WALLET_RESPONSE_INVALID');
 await verifyFeePayerWallet(api,walletId,policyId,address);
 return {walletId,address,policyId,policyHash:hash,
  env:`YEET_SOL_FEE_PAYER_ID=${walletId}\nYEET_SOL_FEE_PAYER_ADDRESS=${address}\nYEET_SOL_FEE_PAYER_POLICY_ID=${policyId}\nYEET_SOL_FEE_PAYER_POLICY_HASH=${hash}\n`};
}

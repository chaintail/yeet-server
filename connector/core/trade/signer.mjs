// One Signer interface for both designs in port plan section 3, chosen by YEET_SIGNER=delegated|custodial
// (default delegated):
//   kind                              'delegated' | 'custodial' | 'fake'
//   directory.lookup(accountId)       -> {base:{address,walletId,signerState,policyId}, solana:{...}} | null
//   directory.stable                  true when a stored wallet never needs a refresh (custodial)
//   transferUsdcBase({walletId, from, to, amountRaw, idempotencyKey, referenceId, request, persistRequest})
//   transferSpl({walletId, owner, source, destinationOwner, mint, decimals, amountRaw, tokenProgram, idempotencyKey,
//     referenceId, request, persistRequest})
//        -> {txHash, transactionId, hashPending}: a Privy transaction id without a hash is a transfer accepted and
//           broadcast whose chain hash is not known yet (sponsored EVM); it is resolved by lookupTransfer
//   lookupTransfer({chain, walletId, transactionId | referenceId})                       (optional)
//        -> {state:'none'|'pending'|'confirmed'|'failed', txHash, transactionId, status}
//   persistRequest(body) stores the exact request before it is sent; a retry passes it back as `request` and the
//   adapter sends it byte for byte (never rebuilt under the same idempotency key).
// Failures are TradeError codes from the contract catalogue (WALLET_NOT_READY, LIMIT_EXCEEDED, TEMPORARILY_UNAVAILABLE).
import {createHash} from 'node:crypto';
import {refuse} from './util.mjs';

export const BASE_CHAIN_ID=8453;
export const BASE_CAIP2='eip155:8453';
/** USDC on Base (Folio evm-sweep-policy.ts EVM_USDC[8453]; also the router catalogue's funding asset). */
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ERC20_TRANSFER_SELECTOR='0xa9059cbb'; // keccak256("transfer(address,uint256)")[0..4]

/** ERC-20 transfer(to, amount) calldata, encoded by hand: selector + 32-byte address + 32-byte amount. */
export function erc20TransferData(to,amountRaw){
 if(!/^0x[0-9a-fA-F]{40}$/.test(to))throw Error('invalid recipient');
 const amount=BigInt(amountRaw);
 if(amount<=0n||amount>=2n**256n)throw Error('invalid amount');
 return ERC20_TRANSFER_SELECTOR+to.slice(2).toLowerCase().padStart(64,'0')+amount.toString(16).padStart(64,'0');
}
/** ERC-20 balanceOf(owner) calldata. */
export const erc20BalanceOfData=owner=>'0x70a08231'+owner.slice(2).toLowerCase().padStart(64,'0');

/** Idempotency key per trade leg: a retried send can never become a second transfer. Generation 0 is the leg's first
 * key (also its reference_id); a later generation exists only after a cached 5xx and a reference lookup that found
 * nothing (executor.mjs rekey). */
export const legIdempotencyKey=(walletId,tradeId,idx,generation=0)=>createHash('sha256').update(`yeet-leg:${walletId}:${tradeId}:${idx}${generation?`:${generation}`:''}`).digest('hex');

export function signerKind(env=process.env){
 const kind=env.YEET_SIGNER||'delegated';
 if(!['delegated','custodial'].includes(kind))throw Error('Invalid YEET_SIGNER');
 return kind;
}

/** Builds the configured adapter. Without Privy credentials the adapter still loads and answers WALLET_NOT_READY. */
export async function createSigner({env=process.env,fetch=globalThis.fetch,balances,didFor,db,now}={}){
 const kind=signerKind(env);
 const mod=kind==='delegated'?await import('./signer-privy.mjs'):await import('./signer-custodial.mjs');
 return kind==='delegated'?mod.createDelegatedSigner({env,fetch,balances,didFor,now}):mod.createCustodialSigner({env,fetch,balances,db,now});
}

/** Shared mapping of Privy client failures onto catalogue codes. */
export function privyFailure(e){
 if(e?.code==='PRIVY_POLICY_DENIED')refuse('LIMIT_EXCEEDED','policy denied the transfer');
 if(e?.code==='PRIVY_AUTHORIZATION_DENIED')refuse('WALLET_NOT_READY','signer not authorised');
 if(e?.name==='TradeError')throw e;
 refuse('TEMPORARILY_UNAVAILABLE',e?.code||'privy request failed');
}

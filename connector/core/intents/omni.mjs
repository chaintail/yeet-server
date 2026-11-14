// The Omni bridge, read side: the relayer fee for a withdrawal, the storage the bridge wants from the account that
// signs the NEAR transaction, and where a transfer is.
// Sources: @omni-bridge/core 0.21.0 dist/api.js (`/api/v3/transfer-fee`, `/api/v4/transfers/transfer`), SDK
// packages/intents-sdk/src/bridges/omni-bridge/omni-bridge.ts `estimateWithdrawalFee`, Near-One/omni-bridge
// near/omni-bridge/src/storage.rs (`storage_balance_of`, `required_balance_for_account`,
// `required_balance_for_init_transfer`).
import {OMNI_API,OMNI_BRIDGE,VERIFIER} from './constants.mjs';
import {contractOf} from './intents.mjs';

export function createOmni({rpc,fetch=globalThis.fetch,api=OMNI_API,timeoutMs=15_000}){
 async function get(path,params){
  const res=await fetch(`${api}${path}?${new URLSearchParams(params)}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok)throw Error(`Omni API ${path} HTTP ${res.status}`);
  return res.json();
 }
 return {
  /**
   * Relayer fee to deliver `amount` of `tokenId` to a Solana address: {nativeFee (yoctoNEAR, bigint), usd}. The fee
   * is higher (about 0.06 NEAR against 0.003 on 2026-11-13) when the recipient has no token account for the mint yet.
   * `transferred_token_fee` was null for every coin we trade: the fee cannot be paid in the coin itself.
   */
  async fee({tokenId,recipient,amount}){
   const r=await get('/api/v3/transfer-fee',{sender:`near:${VERIFIER}`,recipient:`sol:${recipient}`,token:`near:${contractOf(tokenId)}`,amount:BigInt(amount).toString()});
   if(!/^\d+$/.test(String(r?.native_token_fee??'')))throw Error('Omni API returned no native fee');
   return {nativeFee:BigInt(r.native_token_fee),usd:typeof r.usd_fee==='number'?r.usd_fee:null};
  },
  /** Transfers the bridge indexed for a NEAR transaction hash: [{status, token, amount, recipient, initialisedAt,
   * solanaTx, finalisedAt}] (times in epoch seconds). Empty until the indexer has seen the transaction. */
  async transfers(nearTxHash){
   const r=await get('/api/v4/transfers/transfer',{transaction_hash:nearTxHash});
   return (r?.transfers??[]).map(t=>({status:t.status??null,token:t.token_id??null,amount:t.amount??null,recipient:t.recipient??null,
    initialisedAt:t.initialised?.timestamp_seconds??null,solanaTx:t.finalised?.chain==='Sol'?t.finalised.transaction_hash:null,finalisedAt:t.finalised?.timestamp_seconds??null}));
  },
  /** The Solana mint the bridge pays out for a verifier token, as `sol:<mint>`, or null. */
  bridgedToken:tokenId=>rpc.view(OMNI_BRIDGE,'get_bridged_token',{chain:'Sol',address:`near:${contractOf(tokenId)}`}),
  /**
   * Is the Omni route open for this coin, read from the chain: {ok, bridged, mint_matches, bridge_registered_on_token,
   * decimals}. `bridged` must be `sol:<our catalogue mint>`; omni.bridge.near must hold a storage registration on the
   * token contract (FtWithdraw with `msg` gives NO refund otherwise: core/src/intents/tokens.rs); equal decimals on
   * both sides mean the bridge does not round the amount.
   */
  async route({tokenId,mint}){
   const token=contractOf(tokenId);
   const [bridged,reg,dec]=await Promise.all([rpc.view(OMNI_BRIDGE,'get_bridged_token',{chain:'Sol',address:`near:${token}`}),rpc.view(token,'storage_balance_of',{account_id:OMNI_BRIDGE}),
    rpc.view(OMNI_BRIDGE,'get_token_decimals',{address:`sol:${mint}`})]);
   const r={bridged,mint_matches:bridged===`sol:${mint}`,bridge_registered_on_token:Boolean(reg),decimals:dec??null};
   return {ok:r.mint_matches&&r.bridge_registered_on_token&&Boolean(dec)&&dec.decimals===dec.origin_decimals,...r};
  },
  /** {total, available} (bigint yoctoNEAR) of an account's storage balance on the bridge, or null when unregistered. */
  async storageBalance(accountId){
   const r=await rpc.view(OMNI_BRIDGE,'storage_balance_of',{account_id:accountId});
   return r?{total:BigInt(r.total),available:BigInt(r.available)}:null;
  },
  /** {account, transfer} (bigint yoctoNEAR): what registering an account costs, and the most one transfer message can lock. */
  async storageRequirements(){
   const [account,transfer]=await Promise.all([rpc.view(OMNI_BRIDGE,'required_balance_for_account'),rpc.view(OMNI_BRIDGE,'required_balance_for_init_transfer',{})]);
   return {account:BigInt(account),transfer:BigInt(transfer)};
  },
 };
}
/**
 * Gas (in Tgas) that one execute_intents reserves up front for `n` Omni withdrawals, before its own execution cost
 * (about 10 to 25 Tgas): each `ft_transfer_call` 37.4 (min_gas) + `ft_resolve_withdraw` 15
 * (contracts/defuse/src/contract/tokens/nep141/withdraw.rs); in 'intent' mode each storage_deposit intent adds
 * `near_withdraw` 10 + `do_storage_deposit` 15 (seen in tx 7biSAti…). The transaction carries 300 Tgas.
 */
export const reservedTgas=(n,feeMode)=>n*(37.4+15+(feeMode==='intent'?25:0));
/** The most Omni withdrawals one 300 Tgas transaction can carry with 30 Tgas left for execution. */
export const maxWithdrawals=feeMode=>Math.floor(270/reservedTgas(1,feeMode));

/** yoctoNEAR the transaction signer needs AVAILABLE on the bridge for a set of withdrawals in one transaction:
 * 'signer' mode pays storage + fee for each; 'intent' mode only the storage (the fee arrives by storage_deposit). */
export function signerStorageNeeded({nativeFees,transferStorage,feeMode}){
 return nativeFees.reduce((a,f)=>a+transferStorage+(feeMode==='signer'?BigInt(f):0n),0n);
}

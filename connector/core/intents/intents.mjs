// Builders for the intents a basket trade is made of, and the fee arithmetic that makes two diffs net to zero.
// Sources (near/intents dbad9c8): contracts/defuse/core/src/intents/{mod,token_diff,tokens}.rs,
// core/src/payload/{mod,nep413}.rs, core/src/engine/state/deltas.rs;
// https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution.md
//
// token_diff: `diff` maps a PREFIXED token id (`nep141:<contract>`) to a signed amount string. Each delta is applied
// to the signer at once; on every NEGATIVE delta the contract takes fee = ceil(|delta| * fee_pips / 1,000,000) for
// its fee collector (`TokenDiff::execute_intent`, `Pips::fee_ceil`). After the whole batch every token must net to
// zero across all signers and the collector, else the call fails with `invariant violated` (`Deltas::finalize`).
// So for one giver and one taker: taker receives = given - ceil(given * fee / 1e6).
// ft_withdraw: `token` is the contract id WITHOUT prefix; it burns the signer's verifier balance and calls the token
// contract (`ft_transfer`, or `ft_transfer_call` when `msg` is set). It does not take part in the invariant
// (`Deltas::ft_withdraw` goes straight to the state), so a withdrawal can spend what a diff in the same batch credited.
import {createHash,randomUUID} from 'node:crypto';
import {PIPS,VERIFIER,OMNI_BRIDGE,OMNI_MIN_GAS,POA_MIN_GAS} from './constants.mjs';
import {concat,u8,u128,str,b58bytes,hex} from './codec.mjs';
import {buildNonce} from './nonce.mjs';

const TOKEN_ID=/^nep141:[a-z0-9._-]{2,64}$/;
const big=v=>{const n=BigInt(v);return n};

// ---- fee arithmetic ----
/** Fee the contract takes from an amount given: ceil(amount * feePips / 1e6). */
export const feeCeil=(amount,feePips)=>(big(amount)*big(feePips)+PIPS-1n)/PIPS;
/** What the counterparty receives when `given` is given. */
export const receivedFor=(given,feePips)=>big(given)-feeCeil(given,feePips);
/** The smallest amount to give so that the counterparty receives exactly `want`. */
export function giveFor(want,feePips){
 const w=big(want),f=big(feePips);
 if(w<=0n)throw Error('amount must be positive');
 let s=(w*PIPS+(PIPS-f)-1n)/(PIPS-f);
 while(receivedFor(s,f)>w)s--;
 while(receivedFor(s,f)<w)s++;
 if(receivedFor(s,f)!==w)throw Error('no exact closure for this amount');
 return s;
}
/** The diff a single counterparty must sign so that `diff` settles: {tokenId: bigint}. */
export function mirrorDiff(diff,feePips){
 const out={};
 for(const [id,d] of Object.entries(diff)){
  const v=big(d);
  if(v===0n)throw Error('zero delta');
  out[id]=v<0n?receivedFor(-v,feePips):-giveFor(v,feePips);
 }
 return out;
}
/** Per-token remainder of a set of diffs after fees, as the contract's `finalize` sees it. Empty object = balanced. */
export function unmatched(diffs,feePips){
 const sum={};
 for(const diff of diffs)for(const [id,d] of Object.entries(diff)){
  const v=big(d);
  // every signer delta counts, plus the collector's credit of the fee on each negative delta
  sum[id]=(sum[id]??0n)+v+(v<0n?feeCeil(-v,feePips):0n);
 }
 return Object.fromEntries(Object.entries(sum).filter(([,v])=>v!==0n));
}

// ---- intents ----
/** `token_diff` intent from {tokenId: bigint}. Keys are written sorted (the contract keeps a BTreeMap). */
export function tokenDiff(diff,{memo,referral}={}){
 const entries=Object.entries(diff).sort(([a],[b])=>a<b?-1:a>b?1:0);
 if(!entries.length)throw Error('empty diff');
 const out={};
 for(const [id,d] of entries){
  if(!TOKEN_ID.test(id))throw Error(`token id must be nep141:<contract>: ${id}`);
  if(big(d)===0n)throw Error('zero delta');
  out[id]=big(d).toString();
 }
 return {intent:'token_diff',diff:out,...(memo?{memo}:{}),...(referral?{referral}:{})};
}
/** Contract id of a `nep141:` token id (what the withdraw intents want). */
export function contractOf(tokenId){
 if(!TOKEN_ID.test(tokenId))throw Error(`token id must be nep141:<contract>: ${tokenId}`);
 return tokenId.slice('nep141:'.length);
}

// ---- Omni bridge withdrawal (Solana tokens) ----
// SDK packages/intents-sdk/src/bridges/omni-bridge/omni-bridge-utils.ts `createWithdrawIntentsPrimitive`:
//   {intent:'ft_withdraw', token, receiver_id:'omni.bridge.near', amount, msg: JSON {recipient:'sol:<address>',
//    fee:'0', native_token_fee, external_id}, min_gas:'37400000000000'}
// The bridge (Near-One/omni-bridge near/omni-bridge/src/lib.rs `ft_on_transfer` -> `init_transfer`) burns the amount
// and emits InitTransferEvent; its relayer then pays the tokens out on Solana and keeps `native_token_fee` (NEAR).
// Who pays that fee and the message storage, per `init_transfer`:
//   'signer'  the NEAR account that SIGNED the execute_intents transaction, from its own storage balance on
//             omni.bridge.near (`has_storage_balance(signer, storage + native_fee)`), no extra intent; or
//   'intent'  a `storage_deposit` intent of exactly native_token_fee (in wNEAR, from the user's verifier balance) to
//             the transfer's derived storage account; the bridge then moves it to the signer's balance
//             (`try_to_transfer_balance_from_message_account`), so the signer must still be registered on the bridge
//             with enough available for the message storage. This is what the protocol's own frontends send.
// If neither holds the bridge waits (promise yield) and finally returns the tokens: they come back to the user's
// verifier balance (`ft_resolve_withdraw` refund).
/** OmniAddress in borsh: enum index then the address (omni-types `OmniAddress`: Near = 1, Sol = 2). */
function omniAddressBorsh(a){
 const i=a.indexOf(':'),chain=a.slice(0,i),v=a.slice(i+1);
 if(chain==='near')return concat(u8(1),str(v));
 if(chain==='sol')return concat(u8(2),b58bytes(v,32));
 throw Error(`unsupported Omni address ${chain}`);
}
/**
 * The storage account of a transfer: hex(sha256(borsh(TransferMessageStorageAccount{token, amount u128, recipient,
 * fee{fee u128, native_fee u128}, sender, msg}) ++ external_id)). omni-types `TransferMessageStorageAccount::id`;
 * @omni-bridge/near 0.21.0 dist/storage.js `calculateStorageAccountId`.
 */
export function omniStorageAccountId({token,amount,recipient,fee=0n,nativeFee,sender=`near:${VERIFIER}`,msg='',externalId}){
 const h=createHash('sha256').update(concat(omniAddressBorsh(token),u128(amount),omniAddressBorsh(recipient),u128(fee),u128(nativeFee),omniAddressBorsh(sender),str(msg)));
 if(externalId){
  if(Buffer.byteLength(externalId,'utf8')>64)throw Error('external_id is at most 64 bytes');
  h.update(externalId,'utf8');
 }
 return hex(h.digest());
}
/**
 * Intents that withdraw `amount` of `tokenId` to a Solana address through the Omni bridge.
 * feeMode 'signer': [ft_withdraw]. feeMode 'intent': [storage_deposit, ft_withdraw] (the user needs `nativeFee`
 * wNEAR in the verifier). Returns {intents, externalId, storageAccountId}.
 */
export function omniWithdrawToSolana({tokenId,amount,recipient,nativeFee,feeMode='signer',externalId=randomUUID()}){
 b58bytes(recipient,32);
 const token=contractOf(tokenId),a=big(amount),nf=big(nativeFee);
 if(a<=0n)throw Error('amount must be positive');
 if(nf<0n)throw Error('native fee must not be negative');
 if(!['signer','intent'].includes(feeMode))throw Error('feeMode is signer or intent');
 const to=`sol:${recipient}`;
 const storageAccountId=omniStorageAccountId({token:`near:${token}`,amount:a,recipient:to,nativeFee:nf,externalId});
 const withdraw={intent:'ft_withdraw',token,receiver_id:OMNI_BRIDGE,amount:a.toString(),
  msg:JSON.stringify({recipient:to,fee:'0',native_token_fee:nf.toString(),external_id:externalId}),min_gas:OMNI_MIN_GAS};
 const intents=feeMode==='intent'&&nf>0n
  ?[{deposit_for_account_id:storageAccountId,amount:nf.toString(),contract_id:OMNI_BRIDGE,intent:'storage_deposit'},withdraw]
  :[withdraw];
 return {intents,externalId,storageAccountId};
}
/** PoA bridge withdrawal (`*.omft.near` tokens that have NOT moved to Omni, e.g. USDC on Base): `ft_transfer` to the
 * token contract itself with memo `WITHDRAW_TO:<address>`. SDK poa-bridge-utils.ts `createWithdrawIntentPrimitive`.
 * Not valid for Solana tokens any more; kept for the Base route. */
export function poaWithdraw({tokenId,amount,address}){
 const token=contractOf(tokenId);
 if(!token.endsWith('.omft.near'))throw Error('not a PoA token');
 if(big(amount)<=0n)throw Error('amount must be positive');
 return {intent:'ft_withdraw',token,receiver_id:token,amount:big(amount).toString(),memo:`WITHDRAW_TO:${address}`,min_gas:POA_MIN_GAS};
}

// ---- payload ----
/** The string an `erc191` / `raw_ed25519` key signs: compact JSON of DefusePayload (core/src/payload/mod.rs). The
 * bytes signed are the bytes sent, so it is serialised once, here. */
export function payloadString({signerId,deadline,nonce,intents,verifyingContract=VERIFIER}){
 return JSON.stringify({signer_id:signerId,verifying_contract:verifyingContract,deadline,nonce,intents});
}
/** The `message` of a NEP-413 payload (core/src/payload/nep413.rs `Nep413DefuseMessage`): nonce and recipient
 * travel in the NEP-413 envelope instead. */
export function nep413Message({signerId,deadline,intents}){
 return JSON.stringify({deadline,intents,signer_id:signerId});
}
/**
 * Signs `intents` with `signer` (sign.mjs: rawEd25519Signer / erc191Signer / nep413Signer). `deadlineMs` is both the
 * intent deadline and the nonce deadline (the engine requires intent deadline <= nonce deadline).
 * Returns {signed (wire object), nonce, deadline, signerId}.
 */
export async function signIntents(signer,{intents,deadlineMs,saltHex,random,nonceDeadlineMs=deadlineMs,verifyingContract=VERIFIER}){
 if(!Array.isArray(intents)||!intents.length)throw Error('no intents');
 const deadline=new Date(deadlineMs).toISOString();
 const nonce=buildNonce({saltHex,deadlineMs:nonceDeadlineMs,random});
 const signerId=signer.accountId;
 const signed=signer.standard==='nep413'
  ?await signer.sign({message:nep413Message({signerId,deadline,intents}),nonce,recipient:verifyingContract})
  :await signer.sign(payloadString({signerId,deadline,nonce,intents,verifyingContract}));
 return {signed,nonce,deadline,signerId};
}

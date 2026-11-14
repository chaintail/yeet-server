// Accounts and signatures for the verifier, in the three standards we use.
// Sources: contracts/defuse/core/src/payload/{multi,raw,erc191,nep413}.rs, core/src/public_key.rs,
// crates/signatures/{erc191,nep413}/src/lib.rs, crates/crypto/src/{fmt,secp256k1}.rs (near/intents dbad9c8),
// https://docs.near-intents.org/integration/verifier-contract/signing-intents.md
//
//   standard      wire object                                             bytes the key signs
//   raw_ed25519   {standard, payload:"<json>", public_key, signature}     the UTF-8 bytes of `payload`, no prefix, no hash
//   erc191        {standard, payload:"<json>", signature}                 keccak256("\x19Ethereum Signed Message:\n"+len+payload)
//   nep413        {standard, payload:{message,nonce,recipient}, public_key, signature}
//                                                                         sha256(borsh(u32 2147484061, message, nonce[32], recipient, Option callback_url))
// Keys and signatures travel as `<curve>:<base58>`. A secp256k1 signature is 65 bytes r||s||v with v in {0,1}
// (`RecoveryId::from_byte`), so the 27/28 that `personal_sign` returns must have 27 subtracted. The secp256k1 public
// key is the 64 uncompressed bytes without the 0x04 lead.
// The account an implicit key owns (`PublicKey::to_implicit_account_id`): ed25519 -> hex of the 32 key bytes (for a
// Solana wallet: the address bytes in hex); secp256k1 -> "0x"+hex(keccak256(key64)[12..32]), the EVM address in
// LOWERCASE. Implicit accounts need no registration (`has_public_key`, contracts/defuse/src/contract/intents/state.rs).
import {createHash,createPublicKey,verify as edVerify} from 'node:crypto';
import {keccak_256} from '@noble/hashes/sha3';
import {privateKeyToAccount} from 'viem/accounts';
import {recoverPublicKey} from 'viem';
import {base58Encode} from '../trade/router.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {NEP413_TAG,VERIFIER} from './constants.mjs';
import {hex,unhex,b64,unb64,utf8,curved,uncurved,b58bytes,concat,u32,u8,str} from './codec.mjs';

const SPKI_PREFIX=Buffer.from('302a300506032b6570032100','hex');
const sha256=b=>Uint8Array.from(createHash('sha256').update(b).digest());
const edOk=(raw32,message,signature)=>{try{return edVerify(null,message,createPublicKey({key:Buffer.concat([SPKI_PREFIX,Buffer.from(raw32)]),format:'der',type:'spki'}),signature)}catch{return false}};

// ---- accounts ----
/** Verifier account of an ed25519 key given as a Solana address (base58 of the 32 key bytes). */
export const ed25519AccountId=address=>hex(b58bytes(address,32));
/** Verifier account of a secp256k1 key: the EVM address, lowercase. Accepts the address in any case. */
export function evmAccountId(address){
 if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw Error('not an EVM address');
 return address.toLowerCase();
}
/** Verifier account of an uncompressed secp256k1 public key (64 bytes, no 0x04). */
export const secp256k1AccountId=key64=>{if(key64.length!==64)throw Error('key is 64 bytes');return '0x'+hex(keccak_256(key64).subarray(12))};

// ---- hashes (the contract's `Payload::hash`, printed as `intent_hash` in base58) ----
/** ERC-191 prehash of a message string (`Erc191::prehash`). */
export function erc191Hash(payload){
 const m=utf8(payload);
 return keccak_256(concat(utf8('\x19Ethereum Signed Message:\n'),utf8(String(m.length)),m));
}
/** NEP-413 prehash (`Nep413::prehash`). `nonce` is 32 bytes. */
export function nep413Hash({message,nonce,recipient,callbackUrl}){
 if(nonce.length!==32)throw Error('nonce is 32 bytes');
 return sha256(concat(u32(NEP413_TAG),str(message),nonce,str(recipient),callbackUrl==null?u8(0):concat(u8(1),str(callbackUrl))));
}
/** The hash the contract reports for a signed payload, base58 (events `intent_hash`, `simulate_intents`). */
export function intentHash(mp){
 if(mp.standard==='raw_ed25519')return base58Encode(sha256(utf8(mp.payload)));
 if(mp.standard==='erc191')return base58Encode(erc191Hash(mp.payload));
 if(mp.standard==='nep413')return base58Encode(nep413Hash({message:mp.payload.message,nonce:unb64(mp.payload.nonce),recipient:mp.payload.recipient,callbackUrl:mp.payload.callbackUrl}));
 throw Error(`unsupported standard ${mp.standard}`);
}

// ---- wire objects from a signature a wallet produced ----
/** `raw_ed25519` object from a 64-byte signature over the payload's UTF-8 bytes (Solana `signMessage`). Throws
 * when the signature does not verify against `address`: a wallet that prefixes the message would fail here. */
export function rawEd25519Payload(payload,address,signature){
 const sig=Uint8Array.from(signature);
 if(sig.length!==64)throw Error('ed25519 signature is 64 bytes');
 if(!edOk(b58bytes(address,32),utf8(payload),sig))throw Error('ed25519 signature does not verify over the raw payload bytes');
 return {standard:'raw_ed25519',payload,public_key:`ed25519:${address}`,signature:curved('ed25519',sig)};
}
/** `erc191` object from what `personal_sign` returns: 0x + r(32) s(32) v(1), v = 27/28 (or already 0/1). Throws when
 * the recovered address is not `address`. */
export async function erc191Payload(payload,address,signatureHex){
 const raw=unhex(String(signatureHex).replace(/^0x/,''));
 if(raw.length!==65)throw Error('secp256k1 signature is 65 bytes');
 const v=raw[64]>=27?raw[64]-27:raw[64];
 if(v!==0&&v!==1)throw Error('recovery id must be 0 or 1');
 const sig=Uint8Array.from(raw);sig[64]=v;
 const mp={standard:'erc191',payload,signature:curved('secp256k1',sig)};
 const got=(await verifyMultiPayload(mp)).accountId;
 if(got!==evmAccountId(address))throw Error('secp256k1 signature does not recover the wallet address');
 return mp;
}
/** `nep413` object from a 64-byte signature over the NEP-413 prehash. */
export function nep413Payload({message,nonce,recipient=VERIFIER},address,signature){
 const sig=Uint8Array.from(signature);
 if(!edOk(b58bytes(address,32),nep413Hash({message,nonce:unb64(nonce),recipient}),sig))throw Error('NEP-413 signature does not verify');
 return {standard:'nep413',payload:{message,nonce,recipient},public_key:`ed25519:${address}`,signature:curved('ed25519',sig)};
}

// ---- local signers (test wallet, throwaway keys, the solver key) ----
/** An ed25519 key signing `raw_ed25519`. `key` = pipeline/solana/verify.mjs localSigner (or the test wallet's
 * `solana`): {address, signMessage(bytes)}. */
export function rawEd25519Signer(key){
 return Object.freeze({standard:'raw_ed25519',accountId:ed25519AccountId(key.address),publicKey:`ed25519:${key.address}`,address:key.address,
  async sign(payload){return rawEd25519Payload(payload,key.address,key.signMessage(utf8(payload)))}});
}
/** A secp256k1 key signing `erc191` exactly as `personal_sign` does. `privateKey` = () => 32 bytes. */
export function erc191Signer({address,privateKey}){
 return Object.freeze({standard:'erc191',accountId:evmAccountId(address),publicKey:null,address,
  async sign(payload){
   const k=privateKey();
   try{return await erc191Payload(payload,address,await privateKeyToAccount(`0x${hex(k)}`).signMessage({message:payload}))}
   finally{k.fill?.(0)}
  }});
}
/** An ed25519 key signing `nep413` (the solver). `sign({message, nonce})` -> wire object. */
export function nep413Signer(key){
 return Object.freeze({standard:'nep413',accountId:ed25519AccountId(key.address),publicKey:`ed25519:${key.address}`,address:key.address,
  async sign({message,nonce,recipient=VERIFIER}){
   return nep413Payload({message,nonce,recipient},key.address,key.signMessage(nep413Hash({message,nonce:unb64(nonce),recipient})));
  }});
}
/** A fresh ed25519 key that never leaves the process (plan mode). */
export const throwawayEd25519=()=>localSigner();

// ---- verification, as the contract does it (`SignedPayload::verify`) ----
/**
 * Checks a wire object locally and returns {publicKey, accountId, hash}: the key the contract would accept, the
 * implicit account that key owns, and the intent hash. Throws on an invalid signature.
 */
export async function verifyMultiPayload(mp){
 if(mp.standard==='raw_ed25519'){
  const key=uncurved('ed25519',mp.public_key,32);
  if(!edOk(key,utf8(mp.payload),uncurved('ed25519',mp.signature,64)))throw Error('invalid signature');
  return {publicKey:mp.public_key,accountId:hex(key),hash:intentHash(mp)};
 }
 if(mp.standard==='nep413'){
  const key=uncurved('ed25519',mp.public_key,32);
  const digest=nep413Hash({message:mp.payload.message,nonce:unb64(mp.payload.nonce),recipient:mp.payload.recipient,callbackUrl:mp.payload.callbackUrl});
  if(!edOk(key,digest,uncurved('ed25519',mp.signature,64)))throw Error('invalid signature');
  return {publicKey:mp.public_key,accountId:hex(key),hash:intentHash(mp)};
 }
 if(mp.standard==='erc191'){
  const sig=uncurved('secp256k1',mp.signature,65);
  if(sig[64]>1)throw Error('invalid signature');
  let pub;
  try{pub=await recoverPublicKey({hash:`0x${hex(erc191Hash(mp.payload))}`,signature:`0x${hex(sig)}`})}catch{throw Error('invalid signature')}
  const key64=unhex(pub.slice(4));
  return {publicKey:curved('secp256k1',key64),accountId:secp256k1AccountId(key64),hash:intentHash(mp)};
 }
 throw Error(`unsupported standard ${mp.standard}`);
}
export {b64,unb64};

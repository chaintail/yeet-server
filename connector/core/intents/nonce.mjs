// The verifier's versioned nonce (contracts/defuse/core/src/nonce/versioned.rs, salted.rs, expirable.rs):
//   32 bytes = magic 56 28 f6 c6 | version 00 (borsh enum index of V1) | salt (4 bytes) |
//              deadline (8 bytes, i64 NANOSECONDS, little-endian: `TimestampNanoSeconds<i64>`) | 15 random bytes
// sent as standard base64. The engine (core/src/engine/mod.rs `verify_intent_nonce`) requires: the salt is one the
// contract still accepts (`is_valid_salt`), intent deadline <= nonce deadline, nonce deadline not in the past. The
// nonce is then committed once per account (`commit_nonce`), so a second use fails with "nonce was already used".
// Legacy random nonces still pass today; the contract README says they will be prohibited.
import {randomBytes} from 'node:crypto';
import {NONCE_MAGIC,NONCE_V1} from './constants.mjs';
import {concat,i64,unhex,hex,b64,unb64} from './codec.mjs';

const MS_TO_NS=1_000_000n;

/** base64 nonce for `saltHex` (8 hex chars from the `current_salt` view) expiring at `deadlineMs` (epoch ms). */
export function buildNonce({saltHex,deadlineMs,random=randomBytes(15)}){
 const salt=unhex(saltHex);
 if(salt.length!==4)throw Error('salt is 4 bytes');
 if(random.length!==15)throw Error('nonce tail is 15 bytes');
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=0)throw Error('deadline is epoch milliseconds');
 const bytes=concat(NONCE_MAGIC,Uint8Array.of(NONCE_V1),salt,i64(BigInt(deadlineMs)*MS_TO_NS),Uint8Array.from(random));
 if(bytes.length!==32)throw Error('nonce is 32 bytes');
 return b64(bytes);
}

/** {versioned, saltHex, deadlineMs, deadlineNs, randomHex} of a base64 nonce; {versioned:false} for a legacy one. */
export function parseNonce(nonceB64){
 const b=unb64(nonceB64);
 if(b.length!==32)throw Error('nonce is 32 bytes');
 if(!NONCE_MAGIC.every((x,i)=>b[i]===x)||b[4]!==NONCE_V1)return {versioned:false};
 const deadlineNs=Buffer.from(b.subarray(9,17)).readBigInt64LE();
 return {versioned:true,saltHex:hex(b.subarray(5,9)),deadlineNs,deadlineMs:Number(deadlineNs/MS_TO_NS),randomHex:hex(b.subarray(17))};
}

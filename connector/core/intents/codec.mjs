// Byte helpers for the verifier's wire formats: base58 with a curve prefix, and the few borsh primitives we need
// (little-endian integers, u32-length-prefixed strings and byte vectors: https://borsh.io).
import {base58Decode,base58Encode} from '../trade/router.mjs';

export const hex=b=>Buffer.from(b).toString('hex');
export const unhex=s=>{if(!/^([0-9a-f]{2})*$/i.test(s))throw Error('not hex');return Uint8Array.from(Buffer.from(s,'hex'))};
export const b64=b=>Buffer.from(b).toString('base64');
export const unb64=s=>{const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw Error('not canonical base64');return Uint8Array.from(b)};
export const utf8=s=>Uint8Array.from(Buffer.from(s,'utf8'));

/** base58 -> exactly `n` bytes (the contract's `checked_base58_decode_array`, crates/crypto/src/fmt.rs). */
export function b58bytes(s,n){
 const b=typeof s==='string'?base58Decode(s):null;
 if(!b||b.length!==n)throw Error(`base58 value is not ${n} bytes`);
 return Uint8Array.from(b);
}
/** `<curve>:<base58>` as the contract prints keys and signatures (`TypedCurve::to_base58`). */
export const curved=(curve,bytes)=>`${curve}:${base58Encode(bytes)}`;
/** Parses `<curve>:<base58>` into exactly `n` bytes; the curve must match. */
export function uncurved(curve,s,n){
 const i=String(s).indexOf(':');
 if(i<0||s.slice(0,i)!==curve)throw Error(`expected a ${curve}: value`);
 return b58bytes(s.slice(i+1),n);
}

export const u8=v=>Uint8Array.of(v);
export const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return Uint8Array.from(b)};
export const u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return Uint8Array.from(b)};
export const i64=v=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(v));return Uint8Array.from(b)};
export function u128(v){
 const n=BigInt(v);
 if(n<0n||n>=1n<<128n)throw Error('u128 out of range');
 const b=Buffer.alloc(16);b.writeBigUInt64LE(n&0xffffffffffffffffn,0);b.writeBigUInt64LE(n>>64n,8);
 return Uint8Array.from(b);
}
export const bytesVec=b=>concat(u32(b.length),b);
export const str=s=>bytesVec(utf8(s));
export function concat(...parts){
 const out=new Uint8Array(parts.reduce((a,p)=>a+p.length,0));
 let o=0;for(const p of parts){out.set(p,o);o+=p.length}
 return out;
}

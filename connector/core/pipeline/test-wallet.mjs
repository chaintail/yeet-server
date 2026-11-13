// The local test wallet for exercising the user-signed path without the ChatGPT widget (design section 4): one Ed25519
// key (the Solana wallet) and one secp256k1 key (the Base wallet) in one JSON file, mode 0600, directory 0700. It stands
// in for "a signature produced by the user's wallet"; the server never reads this file (ops/user-signed-trade.mjs
// injects it in process). Keys never leave this module in printable form: callers get addresses and sign functions.
//   file: {version:1, solana:{seed_base64, address}, base:{private_key_hex, address}}
import {mkdirSync,openSync,writeSync,closeSync,readFileSync,statSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes,createECDH} from 'node:crypto';
import {keccak_256} from '@noble/hashes/sha3';
import {localSigner,newEd25519Seed} from './solana/verify.mjs';

const SECP256K1_N=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const hex=b=>Buffer.from(b).toString('hex');

/** EIP-55 address of a secp256k1 private key (32 bytes). */
export function evmAddress(privateKey){
 const ecdh=createECDH('secp256k1');ecdh.setPrivateKey(Buffer.from(privateKey));
 const pub=ecdh.getPublicKey(null,'uncompressed').subarray(1);
 const lower=hex(keccak_256(pub)).slice(-40),h=hex(keccak_256(Buffer.from(lower,'ascii')));
 return '0x'+[...lower].map((c,i)=>parseInt(h[i],16)>=8?c.toUpperCase():c).join('');
}
/** A uniformly drawn secp256k1 scalar in [1, n-1]. */
export function newSecp256k1Key(){
 for(;;){const k=randomBytes(32),v=BigInt('0x'+hex(k));if(v>0n&&v<SECP256K1_N)return k}
}

/** Creates the file (refuses to overwrite: flag `wx`). Returns the two addresses only. */
export function createTestWalletFile(path){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const {seed,address:solana}=newEd25519Seed();
 const key=newSecp256k1Key(),base=evmAddress(key);
 const body=JSON.stringify({version:1,solana:{seed_base64:Buffer.from(seed).toString('base64'),address:solana},base:{private_key_hex:hex(key),address:base}});
 const fd=openSync(path,'wx',0o600);
 try{writeSync(fd,body+'\n')}finally{closeSync(fd)}
 chmodSync(path,0o600);
 seed.fill(0);key.fill(0);
 return {solana,base};
}

/** Loads the file: refuses a file readable by group or others, and a file whose addresses do not match its keys. */
export function loadTestWallet(path){
 const mode=statSync(path).mode&0o777;
 if(mode&0o077)throw Error(`test wallet file must be mode 0600 (is ${mode.toString(8)})`);
 const j=JSON.parse(readFileSync(path,'utf8'));
 if(j?.version!==1)throw Error('test wallet file: unknown version');
 const seed=Buffer.from(String(j.solana?.seed_base64??''),'base64');
 const solana=localSigner(Uint8Array.from(seed));seed.fill(0);
 if(solana.address!==j.solana.address)throw Error('test wallet file: Solana address does not match its key');
 const baseKey=Buffer.from(String(j.base?.private_key_hex??''),'hex');
 if(baseKey.length!==32||evmAddress(baseKey)!==j.base.address)throw Error('test wallet file: Base address does not match its key');
 return Object.freeze({
  solana,
  base:Object.freeze({address:j.base.address,
   /** For the Base driver's local EVM signer (package B). Never log or print the return value. */
   privateKey:()=>Uint8Array.from(baseKey)}),
 });
}

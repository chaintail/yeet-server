// Ed25519 checks of a Solana wire transaction. Lifted from Folio (stock-app origin/main 70848f097)
// packages/wallet-privy/src/solana.ts `verifySolanaSignedTransaction` and `verifySolanaPartialTransaction`; the
// transaction reader is message.mjs `decodeTransaction` (strict) instead of Folio's local parser.
// `localSigner` is a raw Ed25519 key in process (the operator tool's test wallet, the tests' fee payer); the live fee
// payer is a Privy server wallet (fee-payer.mjs).
import {createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import {base58Encode} from '../../trade/router.mjs';
import {decodeTransaction,encodeTransaction} from './message.mjs';

const SPKI_PREFIX=Buffer.from('302a300506032b6570032100','hex');
const PKCS8_PREFIX=Buffer.from('302e020100300506032b657004220420','hex');
const publicKey=raw=>createPublicKey({key:Buffer.concat([SPKI_PREFIX,Buffer.from(raw)]),format:'der',type:'spki'});
const zero=sig=>sig.every(x=>x===0);
const signerKeys=tx=>tx.message.accounts.slice(0,tx.message.header.signers);
const sigOk=(raw32,message,signature)=>{try{return verify(null,message,publicKey(raw32),signature)}catch{return false}};
import {key} from './message.mjs';

/** Same message bytes as `original`, every signature valid, signatures already present in `original` unchanged, and
 * `walletAddress` among the signers. Returns {signature: base58 of slot 0} or null. Never sends. */
export function verifySolanaSignedTransaction(original,signed,walletAddress,diagnostic){
 const refuse=reason=>{try{diagnostic?.(reason)}catch{}return null};
 try{
  const a=decodeTransaction(original),b=decodeTransaction(signed);
  if(!Buffer.from(a.messageBytes).equals(Buffer.from(b.messageBytes)))return refuse('message_changed');
  const signers=signerKeys(b);
  if(!signers.includes(walletAddress))return refuse('signer_missing');
  for(let i=0;i<signers.length;i++){
   if(!zero(a.signatures[i])&&!Buffer.from(a.signatures[i]).equals(Buffer.from(b.signatures[i])))return refuse('preserved_signature_changed');
   if(!sigOk(key(signers[i]),b.messageBytes,b.signatures[i]))return refuse('signature_invalid');
  }
  return {signature:base58Encode(b.signatures[0])};
 }catch{return refuse('wire_encoding')}
}

/** The person's slot only: same message, exactly two signers, signer 1 = `walletAddress`, signer 0 another key whose
 * slot is still zero, every slot of `original` zero, and a valid Ed25519 signature in slot 1. */
export function verifySolanaPartialTransaction(original,partial,walletAddress){
 try{
  const a=decodeTransaction(original),b=decodeTransaction(partial);
  const signers=signerKeys(b);
  if(!Buffer.from(a.messageBytes).equals(Buffer.from(b.messageBytes))||signers.length!==2||signers[1]!==walletAddress||signers[0]===walletAddress
   ||!zero(b.signatures[0])||a.signatures.some(s=>!zero(s)))return false;
  return sigOk(key(signers[1]),b.messageBytes,b.signatures[1]);
 }catch{return false}
}

/** An Ed25519 key held in process: {address, signMessage(bytes), signTransaction(bytes) -> bytes with its slot filled}.
 * `seed` is the 32-byte private seed; omitted, a fresh key is generated (never exported). */
export function localSigner(seed){
 let priv;
 if(seed){if(seed.length!==32)throw Error('seed must be 32 bytes');priv=createPrivateKey({key:Buffer.concat([PKCS8_PREFIX,Buffer.from(seed)]),format:'der',type:'pkcs8'})}
 else priv=generateKeyPairSync('ed25519').privateKey;
 const raw=createPublicKey(priv).export({format:'der',type:'spki'}).subarray(SPKI_PREFIX.length);
 const address=base58Encode(raw);
 const signMessage=m=>Uint8Array.from(sign(null,Buffer.from(m),priv));
 return Object.freeze({address,signMessage,
  /** Fills this key's signature slot of a wire transaction; every other slot is kept as it is. */
  signTransaction(bytes){
   const tx=decodeTransaction(bytes),i=signerKeys(tx).indexOf(address);
   if(i<0)throw Error('not a signer of this transaction');
   const sigs=tx.signatures.map(s=>Uint8Array.from(s));sigs[i]=signMessage(tx.messageBytes);
   return encodeTransaction(sigs,tx.messageBytes);
  }});
}
/** 32-byte seed and address of a new Ed25519 key, for key files (ops/test-wallet-init.mjs). */
export function newEd25519Seed(){
 const {privateKey}=generateKeyPairSync('ed25519');
 const der=privateKey.export({format:'der',type:'pkcs8'});
 const seed=Uint8Array.from(der.subarray(PKCS8_PREFIX.length));
 return {seed,address:localSigner(seed).address};
}

// A NEAR function-call transaction, by hand: borsh layout, ed25519 signature over sha256 of the bytes, JSON-RPC send.
// No NEAR library is needed for this much. Layout (nearcore core/primitives/src/transaction.rs `TransactionV0`,
// `Action`; the same bytes near-api-js produces: its test vectors are in intents.test.mjs):
//   Transaction = signer_id: string | public_key: u8 key type (0 = ed25519) + 32 bytes | nonce: u64 |
//                 receiver_id: string | block_hash: 32 bytes | actions: u32 count + each action
//   Action      = u8 index + body; FunctionCall (2) = method_name: string | args: u32 len + bytes | gas: u64 |
//                 deposit: u128;  Transfer (3) = deposit: u128
//   SignedTransaction = Transaction | signature: u8 key type (0) + 64 bytes
// string = u32 length + UTF-8; integers little-endian. The transaction hash is sha256(Transaction), shown in base58;
// the signature is ed25519 over that hash.
// An implicit NEAR account is the hex of an ed25519 public key; it exists once any NEAR is sent to it, with that key
// as its full-access key (https://docs.near.org/protocol/account-id#implicit-address).
import {createHash} from 'node:crypto';
import {mkdirSync,openSync,writeSync,closeSync,readFileSync,statSync,chmodSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {base58Encode} from '../trade/router.mjs';
import {localSigner,newEd25519Seed} from '../pipeline/solana/verify.mjs';
import {concat,u8,u32,u64,u128,str,bytesVec,b58bytes,hex,b64,utf8} from './codec.mjs';
import {NearRpcError} from './verifier.mjs';

export const functionCall=({method,args,gas,deposit=0n})=>concat(u8(2),str(method),bytesVec(args instanceof Uint8Array?args:utf8(JSON.stringify(args))),u64(gas),u128(deposit));
export const transfer=deposit=>concat(u8(3),u128(deposit));

/** Borsh bytes of a transaction. `publicKey` = base58 of the 32 ed25519 key bytes, `blockHash` = base58 (32 bytes),
 * `actions` = bytes from functionCall() / transfer(). */
export function encodeTransaction({signerId,publicKey,nonce,receiverId,blockHash,actions}){
 return concat(str(signerId),u8(0),b58bytes(publicKey,32),u64(nonce),str(receiverId),b58bytes(blockHash,32),u32(actions.length),...actions);
}
/** {hash (base58), bytes (signed transaction), base64} of a transaction signed by `key` ({address, signMessage}). */
export function signTransaction(tx,key){
 if(key.address!==tx.publicKey)throw Error('transaction public key is not the signing key');
 const body=encodeTransaction(tx);
 const digest=Uint8Array.from(createHash('sha256').update(body).digest());
 const bytes=concat(body,u8(0),key.signMessage(digest));
 return {hash:base58Encode(digest),bytes,base64:b64(bytes)};
}

// ---- key file ----
//   {version:1, near:{seed_base64, address, account_id}}  mode 0600, directory 0700, never overwritten.
// `address` is the base58 public key, `account_id` its hex: the implicit NEAR account AND the solver's verifier account.
/** Loads the NEAR key file, creating it when missing. Returns {created, accountId, address, publicKey, key}; `key` =
 * {address, signMessage(bytes)}. The seed never leaves this module in printable form. */
export function loadOrCreateNearKey(path){
 let created=false;
 if(!existsSync(path)){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const {seed,address}=newEd25519Seed();
  const body=JSON.stringify({version:1,near:{seed_base64:Buffer.from(seed).toString('base64'),address,account_id:hex(b58bytes(address,32))}});
  const fd=openSync(path,'wx',0o600);
  try{writeSync(fd,body+'\n')}finally{closeSync(fd)}
  chmodSync(path,0o600);seed.fill(0);created=true;
 }
 const mode=statSync(path).mode&0o777;
 if(mode&0o077)throw Error(`NEAR key file must be mode 0600 (is ${mode.toString(8)})`);
 const j=JSON.parse(readFileSync(path,'utf8'));
 if(j?.version!==1)throw Error('NEAR key file: unknown version');
 const seed=Buffer.from(String(j.near?.seed_base64??''),'base64');
 const key=localSigner(Uint8Array.from(seed));seed.fill(0);
 const accountId=hex(b58bytes(key.address,32));
 if(key.address!==j.near.address||accountId!==j.near.account_id)throw Error('NEAR key file: address does not match its key');
 return {created,accountId,address:key.address,publicKey:`ed25519:${key.address}`,key};
}

// ---- RPC, write side ----
/** NEAR account state: {exists, yocto (bigint), storageUsage}. */
export async function accountState(rpc,accountId){
 try{
  const r=await rpc.call('query',{request_type:'view_account',finality:'final',account_id:accountId});
  return {exists:true,yocto:BigInt(r.amount),locked:BigInt(r.locked??'0'),storageUsage:r.storage_usage??null};
 }catch(e){
  if(e instanceof NearRpcError&&/UNKNOWN_ACCOUNT|does not exist/i.test(JSON.stringify(e.data??e.message)))return {exists:false,yocto:0n,locked:0n,storageUsage:null};
  throw e;
 }
}
/** {nonce (bigint), blockHash} of an access key, or null when the account or key does not exist. */
export async function accessKey(rpc,accountId,publicKey){
 try{
  const r=await rpc.call('query',{request_type:'view_access_key',finality:'final',account_id:accountId,public_key:publicKey});
  if(r?.error)return null;
  return {nonce:BigInt(r.nonce),blockHash:r.block_hash,permission:r.permission};
 }catch(e){
  if(e instanceof NearRpcError&&/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist/i.test(JSON.stringify(e.data??e.message)))return null;
  throw e;
 }
}
/** Builds and signs (does NOT send) a single function call from the key's implicit account. Returns {hash, base64, nonce}. */
export async function buildFunctionCall({rpc,near,receiverId,method,args,gas,deposit=0n}){
 const ak=await accessKey(rpc,near.accountId,near.publicKey);
 if(!ak)throw Error(`NEAR account ${near.accountId} has no access key yet (send NEAR to it first)`);
 const nonce=ak.nonce+1n;
 const signed=signTransaction({signerId:near.accountId,publicKey:near.address,nonce,receiverId,blockHash:ak.blockHash,actions:[functionCall({method,args,gas,deposit})]},near.key);
 return {hash:signed.hash,base64:signed.base64,nonce:nonce.toString()};
}
/** Sends signed bytes; resolves once the node has the transaction in a block (`wait_until: INCLUDED`). */
export const sendTransaction=(rpc,base64,waitUntil='INCLUDED')=>rpc.call('send_tx',{signed_tx_base64:base64,wait_until:waitUntil},{sticky:false});
/**
 * What the chain says about a transaction: {found, finality, ok, failure, logs, outcomes}. `ok` is null until the
 * transaction and every receipt it spawned have executed (finality EXECUTED_OPTIMISTIC or later); a failed receipt
 * anywhere makes it false (`failure` names the first).
 */
export async function transactionStatus(rpc,hash,senderId){
 let r;
 try{r=await rpc.call('EXPERIMENTAL_tx_status',{tx_hash:hash,sender_account_id:senderId,wait_until:'NONE'})}
 catch(e){
  if(e instanceof NearRpcError&&/UNKNOWN_TRANSACTION|doesn't exist|not found/i.test(JSON.stringify(e.data??e.message)))return {found:false,finality:null,ok:null,failure:null,logs:[],outcomes:[]};
  throw e;
 }
 const finality=r.final_execution_status??null;
 const outcomes=(r.receipts_outcome??[]).map(o=>({id:o.id,executor:o.outcome.executor_id,status:o.outcome.status,logs:o.outcome.logs,gasBurnt:o.outcome.gas_burnt,blockHash:o.block_hash}));
 const txFailure=r.transaction_outcome?.outcome?.status?.Failure??r.status?.Failure??null;
 const receiptFailure=outcomes.find(o=>o.status?.Failure);
 const executed=['EXECUTED_OPTIMISTIC','EXECUTED','FINAL'].includes(finality);
 const failure=txFailure??receiptFailure?.status?.Failure??null;
 return {found:true,finality,ok:failure?false:(executed?true:null),failure:failure?JSON.stringify(failure).slice(0,400):null,
  logs:outcomes.flatMap(o=>o.logs),outcomes,gasBurnt:outcomes.reduce((a,o)=>a+BigInt(o.gasBurnt??0),BigInt(r.transaction_outcome?.outcome?.gas_burnt??0)).toString()};
}

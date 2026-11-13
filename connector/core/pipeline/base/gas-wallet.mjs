// The Base gas wallet: a raw secp256k1 key in a 0600 file whose derived address must equal YEET_BASE_GAS_WALLET.
// Lifted from Folio @70848f097: deposit-readiness.ts:64 (key-to-address boot check, GAS_WALLET_NOT_CONFIGURED) and
// source-rpc.ts:94-100 signGasTopup. YEET changes: the key comes from a file checked for mode 0600 on every load
// (Folio reads FOLIO_<CHAIN>_GAS_WALLET_KEY from env), and the signed top-up is parsed again and compared before it
// may be stored or broadcast (guard 8). The key never leaves this module: callers get {address, sign}.
import {readFileSync,statSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {keccak256,parseTransaction,recoverTransactionAddress} from 'viem';
import {privateKeyToAccount,privateKeyToAddress} from 'viem/accounts';
import {refuse} from '../../trade/util.mjs';
import {BASE_CHAIN_ID,TOPUP_GAS,TOPUP_GAS_DELEGATED} from './config.mjs';

const N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Writes a new key (flag wx: never overwrites) mode 0600 in a 0700 directory. Returns the address only. */
export function createGasWalletKey(file){
 const dir=path.dirname(file);
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
 let hex;
 for(;;){const b=randomBytes(32),k=BigInt('0x'+b.toString('hex'));if(k>0n&&k<N){hex='0x'+b.toString('hex');break}}
 writeFileSync(file,hex+'\n',{flag:'wx',mode:0o600});chmodSync(file,0o600);
 const address=privateKeyToAddress(hex).toLowerCase();
 hex=null;
 return {address,file};
}

/** The address of an existing key file (mode 0600 required). For the init tool's refuse-to-overwrite message. */
export function gasWalletAddress(file){
 const st=statSync(file);
 if(!st.isFile()||(st.mode&0o777)!==0o600)refuse('GAS_WALLET_NOT_CONFIGURED','key file mode must be 0600');
 const key=readFileSync(file,'utf8').trim();
 if(!/^0x[0-9a-fA-F]{64}$/.test(key))refuse('GAS_WALLET_NOT_CONFIGURED','key file format');
 return privateKeyToAddress(key).toLowerCase();
}
function readKey(config){
 if(!config.gasWallet||!config.keyFile)refuse('GAS_WALLET_NOT_CONFIGURED','YEET_BASE_GAS_WALLET unset');
 let st;try{st=statSync(config.keyFile)}catch{refuse('GAS_WALLET_NOT_CONFIGURED','key file missing')}
 if(!st.isFile()||(st.mode&0o777)!==0o600)refuse('GAS_WALLET_NOT_CONFIGURED','key file mode must be 0600');
 const key=readFileSync(config.keyFile,'utf8').trim();
 if(!/^0x[0-9a-fA-F]{64}$/.test(key))refuse('GAS_WALLET_NOT_CONFIGURED','key file format');
 let account;try{account=privateKeyToAccount(key)}catch{refuse('GAS_WALLET_NOT_CONFIGURED','key invalid')}
 if(account.address.toLowerCase()!==config.gasWallet)refuse('GAS_WALLET_NOT_CONFIGURED','key does not match YEET_BASE_GAS_WALLET');
 return account;
}
/** Boot and per-signature check. Throws GAS_WALLET_NOT_CONFIGURED. */
export function loadGasWallet(config){
 const account=readKey(config),address=account.address.toLowerCase();
 return Object.freeze({address,sign:tx=>signGasTopup(account,address,tx)});
}
/** Folio signGasTopup: local-account signing needs no transport; the prepared transaction carries chainId and nonce. */
export async function signGasTopup(account,expected,tx){
 if(account.address.toLowerCase()!==expected.toLowerCase())refuse('GAS_WALLET_NOT_CONFIGURED','GAS_WALLET_KEY_MISMATCH');
 const bytes=await account.signTransaction({...tx});
 return {bytes,hash:keccak256(bytes)};
}
/** Guard 8, second half: the signed top-up parses back to exactly the prepared top-up, signed by the gas wallet. Gas is
 * pinned to 21000, or 40000 for a Calibur-delegated wallet (plan 2.7). */
export async function assertTopupBytes(bytes,tx,gasWallet){
 let p,from;
 try{p=parseTransaction(bytes);from=(await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase()}
 catch{refuse('GAS_WALLET_NOT_CONFIGURED','top-up bytes unparseable')}
 if(p.type!=='eip1559'||p.chainId!==BASE_CHAIN_ID||p.to?.toLowerCase()!==tx.to.toLowerCase()||p.to.toLowerCase()===gasWallet
  ||(p.value??0n)!==tx.value||(p.data??'0x')!=='0x'||p.nonce!==tx.nonce||(p.gas!==TOPUP_GAS&&p.gas!==TOPUP_GAS_DELEGATED)||p.gas!==tx.gas
  ||p.maxFeePerGas!==tx.maxFeePerGas||(p.maxPriorityFeePerGas??0n)!==tx.maxPriorityFeePerGas||(p.accessList?.length??0)!==0
  ||from!==gasWallet)refuse('GAS_WALLET_NOT_CONFIGURED','top-up bytes differ from the prepared top-up');
 return keccak256(bytes);
}

// The Base USDC transfer the user's own wallet signs, and the checks on the bytes it returns.
// Lifted from Folio apps/server/src/bridge/source-executor.ts @70848f097: PreparedTransaction, validateSigned (56-65),
// and submitSource's rule that the prepared transaction is rebuilt from the durable attempt, never from the client
// (68-76). Folio's approve/burn calls are replaced by one USDC.transfer(depositAddress, amount) to the 1Click deposit
// address. YEET additions to validateSigned: low-s and canonical re-encoding, so one signature has one hash.
import {parseTransaction,recoverTransactionAddress,serializeTransaction,keccak256} from 'viem';
import {refuse} from '../../trade/util.mjs';
import {BASE_CHAIN_ID,USDC_BASE,TRANSFER_SELECTOR,TRANSFER_TOPIC} from './config.mjs';

const ADDR=/^0x[0-9a-f]{40}$/;
const HALF_N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n/2n;
const U256=2n**256n;

export function transferData(to,amount){
 const a=String(to).toLowerCase();
 if(!ADDR.test(a)||typeof amount!=='bigint'||amount<=0n||amount>=U256)refuse('SOURCE_IDENTITY_MISMATCH','transfer args');
 return TRANSFER_SELECTOR+a.slice(2).padStart(64,'0')+amount.toString(16).padStart(64,'0');
}
export function decodeTransfer(data){
 const m=/^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(String(data??'').toLowerCase());
 return m?{recipient:'0x'+m[1],amount:BigInt('0x'+m[2])}:null;
}
export function buildTransfer({depositAddress,amountRaw,nonce,gas,maxFeePerGas,maxPriorityFeePerGas}){
 return {type:'eip1559',chainId:BASE_CHAIN_ID,to:USDC_BASE,value:0n,data:transferData(depositAddress,BigInt(amountRaw)),
  nonce,gas,maxFeePerGas,maxPriorityFeePerGas};
}
const BIG=['value','gas','maxFeePerGas','maxPriorityFeePerGas'];
export const txJson=tx=>JSON.stringify(tx,(_k,v)=>typeof v==='bigint'?String(v):v);
export function txFromJson(s){const r=JSON.parse(s);for(const k of BIG)r[k]=BigInt(r[k]);return r}
/** Sign-request payload (design 1.2): integers above 2^53 as decimal strings, nonce and chainId as numbers. */
export function payloadOf(tx){
 return {type:'eip1559',chainId:tx.chainId,to:tx.to,value:String(tx.value),data:tx.data,nonce:tx.nonce,
  gas:String(tx.gas),maxFeePerGas:String(tx.maxFeePerGas),maxPriorityFeePerGas:String(tx.maxPriorityFeePerGas)};
}
/** What a signing surface feeds to its wallet (viem shape). */
export function txFromPayload(p){
 return {type:'eip1559',chainId:Number(p.chainId),to:p.to,value:BigInt(p.value),data:p.data,nonce:Number(p.nonce),
  gas:BigInt(p.gas),maxFeePerGas:BigInt(p.maxFeePerGas),maxPriorityFeePerGas:BigInt(p.maxPriorityFeePerGas)};
}
/** Guard 3 on the stored transaction: pinned contract, selector, recipient and amount from our own quote. */
export function assertTransferPinned(tx,{depositAddress,amountRaw}){
 const d=decodeTransfer(tx.data);
 if(tx.type!=='eip1559'||tx.chainId!==BASE_CHAIN_ID||String(tx.to).toLowerCase()!==USDC_BASE.toLowerCase()||tx.value!==0n
  ||!d||d.recipient!==String(depositAddress).toLowerCase()||d.amount!==BigInt(amountRaw))refuse('SIGNED_SOURCE_MISMATCH','stored transfer not pinned');
}
/** Folio validateSigned: every field equals the prepared transaction, empty access list, signer == wallet.
 * Returns the transaction hash. Any parse or recovery error is SIGNED_SOURCE_MISMATCH. */
export async function validateSigned(prepared,bytes){
 const no=why=>{throw Object.assign(new Error(why),{mismatch:true})};
 try{
  if(typeof bytes!=='string'||!/^0x02[0-9a-f]{2,4000}$/.test(bytes))no('shape');
  const actual=parseTransaction(bytes),expected=prepared.unsignedTransactions[0];
  if(actual.type!==expected.type||actual.chainId!==expected.chainId||actual.to?.toLowerCase()!==expected.to.toLowerCase()
   ||(actual.value??0n)!==expected.value||actual.data!==expected.data||actual.nonce!==expected.nonce||actual.gas!==expected.gas
   ||actual.maxFeePerGas!==expected.maxFeePerGas||(actual.maxPriorityFeePerGas??0n)!==expected.maxPriorityFeePerGas
   ||(actual.accessList?.length??0)!==0)no('field');
  if(actual.r===undefined||actual.s===undefined||actual.yParity===undefined||BigInt(actual.s)>HALF_N)no('signature');
  if(serializeTransaction(expected,{r:actual.r,s:actual.s,yParity:actual.yParity})!==bytes)no('encoding');
  if((await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase()!==prepared.wallet.toLowerCase())no('signer');
  return keccak256(bytes);
 }catch(e){refuse('SIGNED_SOURCE_MISMATCH',`validateSigned: ${e?.mismatch?e.message:'parse'}`)}
}
const topicAddr=t=>typeof t==='string'&&/^0x0{24}[0-9a-f]{40}$/i.test(t)?'0x'+t.slice(26).toLowerCase():null;
/** Design 1.1 step 7: a Transfer(wallet, depositAddress, amount) log from the pinned USDC contract. */
export function transferLogMatches(logs,{wallet,depositAddress,amountRaw}){
 return (logs??[]).some(l=>String(l.address).toLowerCase()===USDC_BASE.toLowerCase()&&l.topics?.[0]===TRANSFER_TOPIC
  &&topicAddr(l.topics[1])===wallet&&topicAddr(l.topics[2])===depositAddress&&(()=>{try{return BigInt(l.data)===BigInt(amountRaw)}catch{return false}})());
}

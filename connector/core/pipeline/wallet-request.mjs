// Decision (a), gas sponsorship: the person signs INSIDE the ChatGPT card with their own Privy embedded wallet through
// the Privy browser SDK (fallback: the first-party sign page). This module is the card-builder contract: a pure,
// dependency-free mapping from one `sign_request` (execute_trade / submit_trade_signature output) to the exact Privy
// wallet call, and from the wallet's answer to the `signed` argument of submit_trade_signature. The card may import
// it or copy it verbatim. The calls are Privy's wallet RPC as the browser SDK sends it (`eth_signTransaction`, answer
// `data.signed_transaction`), in the card and the same call on the first-party page.
//
// Solana (kind "solana_tx"): the wallet signs payload.transaction_base64 as signer 1 and leaves the fee-payer slot
// (signer 0) zero. Privy wallet RPC body: {method: "signTransaction", chain_type: "solana",
// params: {transaction: <base64>, encoding: "base64"}}; the answer data.signed_transaction (base64) is `signed`.
// React SDK equivalent (@privy-io/react-auth/solana useSignTransaction): signTransaction({transaction: bytes, wallet})
// -> {signedTransaction: Uint8Array}; `signed` = base64 of it.
//
// Base (kind "evm_tx"): the wallet signs the EIP-1559 USDC.transfer exactly as given, sign only, never send.
// Privy wallet RPC body: {method: "eth_signTransaction", chain_type: "ethereum", params: {transaction: {to, data,
// value, chain_id, nonce, type: 2, gas_limit, max_fee_per_gas, max_priority_fee_per_gas}}} with quantities as 0x hex;
// the answer data.signed_transaction ("0x02..." hex) is `signed`. React SDK equivalent (useSignTransaction):
// signTransaction({to, data, value, chainId, nonce, type: 2, gasLimit, maxFeePerGas, maxPriorityFeePerGas})
// -> {signature: "0x02..."}; `signed` = that string.
// The server rebuilds the transaction from its own record and requires byte equality after re-serialisation, so no
// field may be added, dropped or re-estimated by the card (no access list, no gas re-estimate, no chain switch).

//
// Base basket (kind "evm_7702", BASE-7702-PRODUCTION-PLAN.md 1.1 and 3.1): one Uniswap Calibur batch for every leg,
// sent and paid by YEET's gas wallet. privyRpcBodies(req) gives the wallet calls in order: (1) only when
// payload.authorization is set, {method: "eth_sign7702Authorization", chain_type: "ethereum", params: {contract,
// chain_id: 8453, nonce}}; (2) {method: "eth_signTypedData_v4", chain_type: "ethereum", params: {typed_data}}.
// signedFromWallets(req, answers) joins the answers: "0x" + batch signature (65 bytes r||s||v) + the authorization's
// r||s||y_parity (65 bytes) when one was asked, 132 or 262 characters. checkBatch(req) runs before any wallet call and
// refuses a request whose batch is not exactly the legs it shows (USDC transfers to leg_summaries[i].to of
// amount_raw, to Calibur only). The answer "unsupported" (UNSUPPORTED_7702) is what the card submits when the wallet
// refuses eth_sign7702Authorization.

const hex=v=>'0x'+BigInt(v).toString(16);
const B64=/^[A-Za-z0-9+/]+={0,2}$/;
/** Hard-coded so a server that misstates the batch is refused in the card (plan 3.1). */
export const CALIBUR='0x000000005c84f8fd50b21cac312528a64437030e';
export const USDC_BASE='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_CHAIN_ID=8453;
export const UNSUPPORTED_7702='unsupported';
const lc=v=>String(v??'').toLowerCase();
const ADDR=/^0x[0-9a-f]{40}$/;
const ZERO32='0x'+'0'.repeat(64);

/** Throws TypeError unless the evm_7702 request's batch pays exactly its leg_summaries (plan 3.1 checkBatch). */
export function checkBatch(req){
 if(req?.kind!=='evm_7702')throw TypeError('checkBatch is for evm_7702 requests');
 const p=req.payload??{},td=p.typed_data??{},d=td.domain??{},m=td.message??{},calls=m.batchedCall?.calls;
 if(p.type!=='calibur_batch'||td.primary_type!=='SignedBatchedCall')throw TypeError('not a Calibur batch');
 if(d.name!=='Calibur'||d.version!=='1.0.0'||Number(d.chainId)!==BASE_CHAIN_ID||lc(d.verifyingContract)!==lc(req.wallet))throw TypeError('batch domain is not this wallet on Base');
 if(!ADDR.test(lc(m.executor))||lc(m.executor)===lc('0x'+'0'.repeat(40)))throw TypeError('batch executor must be set');
 if(lc(m.keyHash)!==ZERO32||m.batchedCall?.revertOnFailure!==true)throw TypeError('batch must use the root key and revert on failure');
 const legs=req.leg_summaries??[];
 if(!Array.isArray(calls)||!calls.length||calls.length!==legs.length)throw TypeError('batch calls differ from the legs');
 calls.forEach((c,i)=>{
  const mm=/^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(lc(c.data));
  if(lc(c.to)!==USDC_BASE||String(c.value)!=='0'||!mm)throw TypeError(`batch call ${i} is not a USDC transfer`);
  if('0x'+mm[1]!==lc(legs[i].to)||BigInt('0x'+mm[2])!==BigInt(legs[i].amount_raw))throw TypeError(`batch call ${i} differs from leg ${legs[i].leg}`);
 });
 const a=p.authorization;
 if(a!==null&&a!==undefined&&(lc(a.contract)!==CALIBUR||Number(a.chain_id)!==BASE_CHAIN_ID||!Number.isInteger(a.nonce)||a.nonce<0))throw TypeError('authorization must be for Calibur on Base');
 return true;
}
/** The Privy wallet RPC bodies for a sign request, in order (evm_7702: authorization first when asked, then the
 * batch; other kinds: the one privyRpcBody). */
export function privyRpcBodies(req){
 if(req?.kind!=='evm_7702')return [privyRpcBody(req)];
 checkBatch(req);
 const a=req.payload.authorization,out=[];
 if(a)out.push({method:'eth_sign7702Authorization',chain_type:'ethereum',params:{contract:a.contract,chain_id:BASE_CHAIN_ID,nonce:a.nonce}});
 out.push({method:'eth_signTypedData_v4',chain_type:'ethereum',params:{typed_data:req.payload.typed_data}});
 return out;
}
const word=v=>{const h=lc(v).replace(/^0x/,'');if(!/^[0-9a-f]{1,64}$/.test(h))throw TypeError('authorization r/s');return h.padStart(64,'0')};
/** The `signed` argument for an evm_7702 request from the wallet answers, in privyRpcBodies order. */
export function signedFromWallets(req,answers){
 if(req?.kind!=='evm_7702')return signedFromWallet(req,answers?.[0]);
 const a=req.payload?.authorization,list=(answers??[]).map(x=>x?.data??x);
 if(list.length!==(a?2:1))throw TypeError('one wallet answer per call');
 const sig=lc(list.at(-1)?.signature);
 if(!/^0x[0-9a-f]{130}$/.test(sig))throw TypeError('no 65-byte batch signature in the wallet answer');
 if(!a)return sig;
 const au=list[0]?.authorization??list[0];
 if(lc(au?.contract)!==lc(a.contract)||Number(au?.chain_id)!==BASE_CHAIN_ID||Number(au?.nonce)!==a.nonce)throw TypeError('the authorization answer does not echo the request');
 const y=Number(au.y_parity);
 if(y!==0&&y!==1)throw TypeError('authorization y_parity must be 0 or 1');
 return sig+word(au.r)+word(au.s)+(y===1?'01':'00');
}

/** The Privy wallet RPC body for a sign request (POST /v1/wallets/{wallet_id}/rpc, or js-sdk-core rpc). */
export function privyRpcBody(req){
 if(req?.kind==='solana_tx'){
  const t=req.payload?.transaction_base64;
  if(typeof t!=='string'||!B64.test(t))throw TypeError('solana_tx payload needs transaction_base64');
  return {method:'signTransaction',chain_type:'solana',params:{transaction:t,encoding:'base64'}};
 }
 if(req?.kind==='evm_tx'){
  const p=req.payload??{};
  if(p.type!=='eip1559')throw TypeError('evm_tx payload must be eip1559');
  return {method:'eth_signTransaction',chain_type:'ethereum',params:{transaction:{
   to:p.to,data:p.data,value:hex(p.value),chain_id:Number(p.chainId),nonce:Number(p.nonce),type:2,
   gas_limit:hex(p.gas),max_fee_per_gas:hex(p.maxFeePerGas),max_priority_fee_per_gas:hex(p.maxPriorityFeePerGas)}}};
 }
 if(req?.kind==='evm_7702')throw TypeError('evm_7702 needs one or two wallet calls: use privyRpcBodies');
 throw TypeError(`unknown sign request kind ${req?.kind}`);
}

/** The React SDK argument for a sign request (useSignTransaction on the matching chain). `bytes` is a Uint8Array. */
export function reactSdkArgs(req){
 if(req?.kind==='solana_tx')return {transaction:Uint8Array.from(atob(req.payload.transaction_base64),c=>c.charCodeAt(0))};
 if(req?.kind==='evm_tx'){const p=req.payload;
  return {to:p.to,data:p.data,value:hex(p.value),chainId:Number(p.chainId),nonce:Number(p.nonce),type:2,gasLimit:hex(p.gas),maxFeePerGas:hex(p.maxFeePerGas),maxPriorityFeePerGas:hex(p.maxPriorityFeePerGas)};
 }
 throw TypeError(`unknown sign request kind ${req?.kind}`);
}

/** The `signed` argument of submit_trade_signature from the wallet's answer (RPC answer or React SDK result). */
export function signedFromWallet(req,answer){
 const a=answer?.data??answer;
 if(req?.kind==='solana_tx'){
  if(typeof a?.signed_transaction==='string')return a.signed_transaction;
  const bytes=a?.signedTransaction;
  if(bytes instanceof Uint8Array)return btoa(String.fromCharCode(...bytes));
  throw TypeError('no signed Solana transaction in the wallet answer');
 }
 if(req?.kind==='evm_tx'){
  const s=a?.signed_transaction??a?.signature??a?.signedTransaction;
  if(typeof s!=='string'||!/^0x02[0-9a-fA-F]+$/.test(s))throw TypeError('no 0x02 signed transaction in the wallet answer');
  return s.toLowerCase();
 }
 throw TypeError(`unknown sign request kind ${req?.kind}`);
}

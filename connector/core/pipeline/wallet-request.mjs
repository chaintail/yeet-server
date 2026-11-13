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

const hex=v=>'0x'+BigInt(v).toString(16);
const B64=/^[A-Za-z0-9+/]+={0,2}$/;

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

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
// Base basket (kind "evm_7702", BASE-7702-PRODUCTION-PLAN 1.1 and 3.1): one Uniswap Calibur batch (EIP-712
// SignedBatchedCall) of N USDC transfers that names YEET's gas wallet as executor, plus, only while the wallet is not
// yet delegated, one EIP-7702 authorization for Calibur. YEET's gas wallet sends the one transaction and pays.
// privyRpcBodies(req) gives the wallet calls in order: {method: "eth_sign7702Authorization", chain_type: "ethereum",
// params: {contract, chain_id: 8453, nonce}} (answer data.authorization {contract, chain_id, nonce, r, s, y_parity}),
// then {method: "eth_signTypedData_v4", chain_type: "ethereum", params: {typed_data}} (answer data.signature, 65
// bytes). signedFromWallets(req, answers) = lower-case 0x + batch signature [+ r || s || y_parity as 00/01], 132 or
// 262 characters. checkBatch(req) runs before any call: the typed data must be exactly the transfers the request's
// leg_summaries list, so a server that misstates the batch is refused here. The literal `unsupported` is the card's
// answer when the wallet refuses the 7702 method; the server then answers per-leg evm_tx requests.
//
// Ledger route (kind "near_intent", docs/LEDGER-ROUTE.md): the whole trade is ONE message for the NEAR Intents ledger,
// approved with the person's Solana key and never a transaction: nothing is sent by the wallet and no network fee
// exists. payload.message is the exact text (a `token_diff`: what the person gives, the least they receive);
// payload.gives and payload.receives restate it. checkIntent(req) runs before the wallet is asked: the text must be
// exactly that one exchange, for this wallet's own ledger account, on intents.near, ending at payload.deadline, and
// what it gives must be what the request's leg summaries list; a server that misstates the message is refused here.
// Privy wallet RPC body: {method: "signMessage", chain_type: "solana", params: {message: <base64 of the text>,
// encoding: "base64"}}; the answer data.signature (base64 of 64 bytes, made over the text's bytes with no prefix) is
// `signed`. React SDK equivalent (@privy-io/react-auth/solana useSignMessage): signMessage({message: bytes, wallet})
// -> {signature: Uint8Array}; `signed` = base64 of it. The server verifies the signature against the wallet's key over
// the exact bytes before anything else happens.

const hex=v=>'0x'+BigInt(v).toString(16);
const B64=/^[A-Za-z0-9+/]+={0,2}$/;
export const CALIBUR='0x000000005c84F8Fd50b21CAC312528A64437030e';
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN=8453,ZERO32='0x'+'0'.repeat(64);
const ADDR=/^0x[0-9a-fA-F]{40}$/,UINT=/^(0|[1-9][0-9]{0,77})$/,HEX32=/^0x[0-9a-fA-F]{1,64}$/;
const lc=v=>String(v).toLowerCase();
const word=v=>BigInt(v).toString(16).padStart(64,'0');
const CALIBUR_TYPES={
 EIP712Domain:[['name','string'],['version','string'],['chainId','uint256'],['verifyingContract','address'],['salt','bytes32']],
 SignedBatchedCall:[['batchedCall','BatchedCall'],['nonce','uint256'],['keyHash','bytes32'],['executor','address'],['deadline','uint256']],
 BatchedCall:[['calls','Call[]'],['revertOnFailure','bool']],
 Call:[['to','address'],['value','uint256'],['data','bytes']],
};
const refuse=why=>Object.assign(TypeError(`evm_7702 batch refused: ${why}`),{code:'BATCH_REFUSED'});

/** Throws (code BATCH_REFUSED) unless an evm_7702 request's batch is exactly the USDC transfers its leg summaries list. */
export function checkBatch(req){
 if(req?.kind!=='evm_7702')throw refuse('not an evm_7702 request');
 const p=req.payload??{},t=p.typed_data??{},d=t.domain??{},m=t.message??{},bc=m.batchedCall??{};
 if(p.type!=='calibur_batch'||t.primary_type!=='SignedBatchedCall')throw refuse('not a Calibur SignedBatchedCall');
 if(!ADDR.test(req.wallet??''))throw refuse('wallet');
 if(d.name!=='Calibur'||d.version!=='1.0.0'||Number(d.chainId)!==BASE_CHAIN||!ADDR.test(d.verifyingContract??'')||lc(d.verifyingContract)!==lc(req.wallet))throw refuse('domain is not this wallet on Base');
 const types=t.types??{};
 if(Object.keys(types).length!==4||Object.entries(CALIBUR_TYPES).some(([k,f])=>!Array.isArray(types[k])||types[k].length!==f.length||f.some(([n,ty],i)=>types[k][i]?.name!==n||types[k][i]?.type!==ty)))throw refuse('types');
 if(!ADDR.test(m.executor??'')||BigInt(m.executor)===0n)throw refuse('executor');
 if(typeof m.keyHash!=='string'||lc(m.keyHash)!==ZERO32)throw refuse('keyHash');
 if(bc.revertOnFailure!==true)throw refuse('revertOnFailure');
 if(!UINT.test(String(m.nonce??''))||!UINT.test(String(m.deadline??''))||BigInt(m.deadline)===0n)throw refuse('nonce or deadline');
 const ex=Date.parse(req.expires_at);
 if(!Number.isFinite(ex)||ex>Number(m.deadline)*1000)throw refuse('expires after the batch deadline');
 const sums=Array.isArray(req.leg_summaries)?req.leg_summaries:req.legs===undefined&&req.summary?[req.summary]:null;
 const calls=bc.calls;
 if(!sums||!Array.isArray(calls)||calls.length<1||calls.length>5||calls.length!==sums.length)throw refuse('one call per leg');
 calls.forEach((c,i)=>{
  const s=sums[i];
  if((req.legs!==undefined&&s?.leg!==req.legs[i])||s?.asset!=='USDC'||Number(s.decimals)!==6||!ADDR.test(s.to??'')||!UINT.test(String(s.amount_raw??''))||BigInt(s.amount_raw)===0n)throw refuse(`leg ${i} summary`);
  if(lc(c?.to)!==lc(USDC_BASE)||!UINT.test(String(c?.value??''))||BigInt(c.value)!==0n)throw refuse(`call ${i} is not a USDC call`);
  if(lc(c.data)!==`0xa9059cbb${word(s.to)}${word(s.amount_raw)}`)throw refuse(`call ${i} is not transfer(${s.to}, ${s.amount_raw})`);
 });
 const a=p.authorization;
 if(a!==null&&a!==undefined&&(lc(a.contract)!==lc(CALIBUR)||Number(a.chain_id)!==BASE_CHAIN||!Number.isInteger(a.nonce)||a.nonce<0))throw refuse('authorization is not for Calibur on Base');
 return true;
}

const refuseIntent=why=>Object.assign(TypeError(`near_intent refused: ${why}`),{code:'BATCH_REFUSED'});
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Hex of the 32 bytes a Solana address encodes (the ledger account its key owns), or null. */
function addressHex(a){
 if(typeof a!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))return null;
 let n=0n;for(const c of a)n=n*58n+BigInt(B58.indexOf(c));
 const h=n.toString(16);
 return h.length>64?null:h.padStart(64,'0');
}
const utf8Base64=text=>{const b=new TextEncoder().encode(text);let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s)};

/** Throws (code BATCH_REFUSED) unless a near_intent request's message is exactly the one exchange it states: a single
 * `token_diff` of `gives` (negative) and `receives` (positive) for the wallet's own ledger account on intents.near,
 * ending at `deadline`, with the amounts given equal to the request's leg summaries. */
export function checkIntent(req){
 if(req?.kind!=='near_intent')throw refuseIntent('not a near_intent request');
 const p=req.payload??{};
 if(p.standard!=='raw_ed25519'||typeof p.message!=='string'||!p.message.length||p.message.length>4000)throw refuseIntent('message');
 if(p.message_base64!==utf8Base64(p.message))throw refuseIntent('message_base64 is not the message');
 let m;try{m=JSON.parse(p.message)}catch{throw refuseIntent('message is not JSON')}
 const own=addressHex(req.wallet);
 if(!own||m.signer_id!==own||p.signer_id!==own)throw refuseIntent('not the own ledger account of this wallet');
 if(m.verifying_contract!=='intents.near'||p.verifying_contract!=='intents.near')throw refuseIntent('verifying contract');
 if(Object.keys(m).sort().join()!=='deadline,intents,nonce,signer_id,verifying_contract'||typeof m.nonce!=='string')throw refuseIntent('message fields');
 const end=Date.parse(m.deadline),ex=Date.parse(req.expires_at);
 if(!Number.isFinite(end)||m.deadline!==p.deadline||!Number.isFinite(ex)||ex>end)throw refuseIntent('deadline');
 const it=Array.isArray(m.intents)&&m.intents.length===1?m.intents[0]:null;
 if(it?.intent==='transfer')return checkTransfer(req,p,it,own);
 if(!it||it.intent!=='token_diff'||Object.keys(it).sort().join()!=='diff,intent'||!it.diff||typeof it.diff!=='object')throw refuseIntent('not one token_diff');
 const gives=Array.isArray(p.gives)?p.gives:[],receives=Array.isArray(p.receives)?p.receives:[],want={};
 if(!gives.length||!receives.length)throw refuseIntent('gives or receives');
 for(const g of gives){if(!UINT.test(String(g?.amount_raw??''))||BigInt(g.amount_raw)===0n||want[g.token_id]!==undefined)throw refuseIntent('gives');want[g.token_id]=`-${g.amount_raw}`}
 for(const r of receives){if(!UINT.test(String(r?.min_raw??''))||BigInt(r.min_raw)===0n||want[r.token_id]!==undefined)throw refuseIntent('receives');want[r.token_id]=String(r.min_raw)}
 const ids=Object.keys(it.diff);
 if(ids.length!==Object.keys(want).length||ids.some(id=>it.diff[id]!==want[id]))throw refuseIntent('the message is not the stated exchange');
 const sums=Array.isArray(req.leg_summaries)?req.leg_summaries:[];
 if(!sums.length||sums.length>5||!Array.isArray(req.legs)||req.legs.length!==sums.length||sums.some((s,i)=>s?.leg!==req.legs[i]||!UINT.test(String(s.amount_raw??''))||s.to!==own))throw refuseIntent('leg summaries');
 const side=sums[0].side;
 if(sums.some(s=>s.side!==side))throw refuseIntent('sides');
 // a buy gives one asset for every leg together; a sell gives each leg's own coin
 if(side==='buy'){if(gives.length!==1||receives.length!==sums.length||BigInt(gives[0].amount_raw)!==sums.reduce((a,s)=>a+BigInt(s.amount_raw),0n))throw refuseIntent('the amount given is not the total of the legs')}
 else if(side==='sell'){if(receives.length!==1||gives.length!==sums.length||gives.some((g,i)=>BigInt(g.amount_raw)!==BigInt(sums[i].amount_raw)))throw refuseIntent('the amounts given are not those of the legs')}
 else throw refuseIntent('side');
 return true;
}

/** The agent route's budget transfer (core/agent/agents.mjs, side `fund`): ONE `transfer` of ONE token from the wallet's
 * own ledger account to the receiver the request states, the amount equal to its one leg summary. Nothing else passes. */
function checkTransfer(req,p,it,own){
 if(Object.keys(it).sort().join()!=='intent,receiver_id,tokens'||typeof it.receiver_id!=='string'||!/^[0-9a-f]{64}$/.test(it.receiver_id)||!it.tokens||typeof it.tokens!=='object')throw refuseIntent('not one transfer');
 if(it.receiver_id===own)throw refuseIntent('a transfer to the own account');
 const ids=Object.keys(it.tokens),t=p.transfer??{},amount=String(it.tokens[ids[0]]??'');
 if(ids.length!==1||!UINT.test(amount)||BigInt(amount)===0n)throw refuseIntent('one token, a positive amount');
 if(t.receiver_id!==it.receiver_id||!t.tokens||typeof t.tokens!=='object'||Object.keys(t.tokens).length!==1||String(t.tokens[ids[0]])!==amount)throw refuseIntent('the message is not the stated transfer');
 const sums=Array.isArray(req.leg_summaries)?req.leg_summaries:[];
 if(sums.length!==1||!Array.isArray(req.legs)||req.legs.length!==1||sums[0]?.leg!==req.legs[0]||sums[0].side!=='fund'||sums[0].to!==it.receiver_id||String(sums[0].amount_raw)!==amount)throw refuseIntent('leg summaries');
 return true;
}

/** Every Privy wallet RPC body a sign request needs, in order (one, or two for a first evm_7702 basket). */
export function privyRpcBodies(req){
 if(req?.kind==='near_intent')checkIntent(req);
 if(req?.kind!=='evm_7702')return [privyRpcBody(req)];
 checkBatch(req);
 const a=req.payload.authorization,out=[];
 if(a)out.push({method:'eth_sign7702Authorization',chain_type:'ethereum',params:{contract:a.contract,chain_id:BASE_CHAIN,nonce:a.nonce}});
 out.push({method:'eth_signTypedData_v4',chain_type:'ethereum',params:{typed_data:req.payload.typed_data}});
 return out;
}

/** The `signed` argument from the answers to privyRpcBodies(req), in the same order. */
export function signedFromWallets(req,answers){
 if(req?.kind!=='evm_7702')return signedFromWallet(req,answers?.[0]);
 const a=req.payload?.authorization,list=Array.isArray(answers)?answers:[];
 if(list.length!==(a?2:1))throw TypeError('one wallet answer per call');
 const sig=(list.at(-1)?.data??list.at(-1))?.signature;
 if(typeof sig!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(sig))throw TypeError('no 65-byte batch signature in the wallet answer');
 if(!a)return sig.toLowerCase();
 const z=(list[0]?.data??list[0])?.authorization;
 const y=Number(z?.y_parity);
 if(!z||lc(z.contract)!==lc(a.contract)||Number(z.chain_id)!==BASE_CHAIN||Number(z.nonce)!==a.nonce||(y!==0&&y!==1)||!HEX32.test(z.r??'')||!HEX32.test(z.s??''))
  throw TypeError('the wallet answered a different authorization');
 return (sig+word(z.r)+word(z.s)+(y?'01':'00')).toLowerCase();
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
 if(req?.kind==='near_intent'){
  const m=req.payload?.message_base64;
  if(req.payload?.standard!=='raw_ed25519'||typeof m!=='string'||!B64.test(m))throw TypeError('near_intent payload needs message_base64');
  return {method:'signMessage',chain_type:'solana',params:{message:m,encoding:'base64'}};
 }
 if(req?.kind==='evm_7702')throw TypeError('evm_7702 needs privyRpcBodies (one or two wallet calls)');
 throw TypeError(`unknown sign request kind ${req?.kind}`);
}

/** The React SDK argument for a sign request (useSignTransaction on the matching chain). `bytes` is a Uint8Array. */
export function reactSdkArgs(req){
 if(req?.kind==='solana_tx')return {transaction:Uint8Array.from(atob(req.payload.transaction_base64),c=>c.charCodeAt(0))};
 if(req?.kind==='near_intent')return {message:Uint8Array.from(atob(req.payload.message_base64),c=>c.charCodeAt(0))};
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
 if(req?.kind==='near_intent'){
  const s=a?.signature;
  if(s instanceof Uint8Array&&s.length===64)return btoa(String.fromCharCode(...s));
  if(typeof s!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(s))throw TypeError('no 64-byte signature in the wallet answer');
  return s;
 }
 throw TypeError(`unknown sign request kind ${req?.kind}`);
}

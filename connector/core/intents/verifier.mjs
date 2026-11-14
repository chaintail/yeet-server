// NEAR JSON-RPC, read side, and the verifier's view methods. Plain fetch; no key, no cost.
// RPC reference: https://docs.near.org/api/rpc/contracts#call-a-contract-function (`query` / `call_function`).
// Views used (near/intents dbad9c8): contracts/defuse/src/intents.rs `simulate_intents`, src/salts.rs `current_salt`
// / `is_valid_salt`, src/fees.rs `fee`, NEP-245 `mt_batch_balance_of`, accounts.rs `is_nonce_used` / `has_public_key`.
import {VERIFIER,NEAR_RPC_URLS} from './constants.mjs';

export class NearRpcError extends Error{constructor(message,data){super(message);this.name='NearRpcError';this.data=data}}
/** A view call that ran and panicked: `panic` is the contract's message. */
export class ViewPanic extends Error{constructor(panic,raw){super(panic);this.name='ViewPanic';this.panic=panic;this.raw=raw}}

/** {call(method, params), view(account, method, args)} over a list of endpoints; a failing endpoint is skipped. */
export function createNearRpc({urls=NEAR_RPC_URLS,fetch=globalThis.fetch,timeoutMs=20_000,retries=3,retryDelayMs=2000}={}){
 if(!urls?.length)throw Error('no NEAR RPC url');
 async function once(url,method,params){
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok)throw new NearRpcError(`NEAR RPC HTTP ${res.status}`);
  return res.json();
 }
 /** Result of an RPC method; throws NearRpcError with the node's error object in `.data`. */
 async function call(method,params,{sticky=false}={}){
  let last;
  // the public endpoints rate-limit (HTTP 429): when every endpoint refused at the transport level, wait and go round again
  for(let round=0;round<=retries;round++){
   if(round)await new Promise(r=>setTimeout(r,retryDelayMs*round));
   for(const url of sticky?urls.slice(0,1):urls){
    let body;
    try{body=await once(url,method,params)}catch(e){last=e instanceof NearRpcError?e:new NearRpcError(`NEAR RPC unreachable: ${e?.message??e}`);continue}
    if(body?.error)throw new NearRpcError(String(body.error?.data?.message??body.error?.cause?.name??body.error?.message??'NEAR RPC error').slice(0,400),body.error);
    return body.result;
   }
  }
  throw last??new NearRpcError('NEAR RPC unreachable');
 }
 /** JSON result of a view method. A contract panic becomes ViewPanic (both RPC error shapes are handled). */
 async function view(account,method,args={}){
  let r;
  try{r=await call('query',{request_type:'call_function',finality:'final',account_id:account,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')})}
  catch(e){
   const text=e instanceof NearRpcError?JSON.stringify(e.data??e.message):'';
   if(/GuestPanic|wasm execution failed|CONTRACT_EXECUTION_ERROR|FunctionCallError/.test(text))throw new ViewPanic(panicMessage(text),text);
   throw e;
  }
  if(r?.error)throw new ViewPanic(panicMessage(String(r.error)),String(r.error));
  if(!Array.isArray(r?.result))throw new NearRpcError('view call returned no result');
  const text=Buffer.from(r.result).toString('utf8');
  return text.length?JSON.parse(text):null;
 }
 return {call,view,urls};
}
/** The contract's own words out of the node's wrapping (`... GuestPanic { panic_msg: "…" }`). */
export function panicMessage(text){
 const m=/panic_msg:\s*\\?"((?:[^"\\]|\\.)*?)\\?"\s*}/.exec(text)??/Smart contract panicked: (.*)/.exec(text);
 return (m?m[1]:text).replace(/\\+"/g,'"').slice(0,600);
}

/** The check that refused, from the contract's message (`DefuseError` texts, contracts/defuse/core/src/error.rs), in
 * the order `Engine::execute_signed_intent` runs them (constants.mjs STAGES). */
export function classifyPanic(message){
 const t=String(message);
 const rules=[
  [/invalid signature/,'signature','INVALID_SIGNATURE'],
  [/wrong verifying_contract/,'verifying_contract','WRONG_VERIFYING_CONTRACT'],
  [/deadline has expired/,'deadline','DEADLINE_EXPIRED'],
  [/doesn't exist for account/,'public_key','PUBLIC_KEY_NOT_EXIST'],
  [/invalid salt/,'nonce_salt','INVALID_SALT'],
  [/deadline is greater than nonce/,'nonce_deadline','DEADLINE_GREATER_THAN_NONCE'],
  [/nonce was already expired/,'nonce_expiry','NONCE_EXPIRED'],
  [/nonce was already used/,'nonce_unused','NONCE_USED'],
  [/insufficient balance or overflow/,'intent_execution','INSUFFICIENT_BALANCE'],
  [/invalid intent/,'intent_execution','INVALID_INTENT'],
  [/invariant violated/,'invariant','INVARIANT_VIOLATED'],
  [/JSON: |deserialize|invalid type|unknown variant|missing field/i,'payload_json','BAD_ENCODING'],
 ];
 for(const [re,stage,code] of rules)if(re.test(t))return {stage,code};
 return {stage:'unknown',code:'UNKNOWN'};
}

/** The verifier's views. `rpc` = createNearRpc(). */
export function createVerifier({rpc,contract=VERIFIER}){
 const view=(method,args)=>rpc.view(contract,method,args);
 return {
  contract,
  /** Current 4-byte salt, hex (rotates; read before building a nonce). */
  currentSalt:()=>view('current_salt'),
  isValidSalt:salt=>view('is_valid_salt',{salt}),
  /** Protocol fee in pips (1/1,000,000), a number. */
  fee:()=>view('fee'),
  /** Balances (bigint) of `tokenIds` for `accountId`, in order. */
  async balances(accountId,tokenIds){
   const r=await view('mt_batch_balance_of',{account_id:accountId,token_ids:tokenIds});
   if(!Array.isArray(r)||r.length!==tokenIds.length)throw new NearRpcError('mt_batch_balance_of returned an unexpected shape');
   return r.map(x=>BigInt(x));
  },
  /** Every token id `accountId` holds (NEP-245 enumeration `mt_tokens_for_owner`, paged). */
  async tokensForOwner(accountId,{pageSize=100,maxPages=10}={}){
   const ids=[];
   for(let page=0;page<maxPages;page++){
    const r=await view('mt_tokens_for_owner',{account_id:accountId,from_index:String(ids.length),limit:pageSize});
    if(!Array.isArray(r))throw new NearRpcError('mt_tokens_for_owner returned an unexpected shape');
    ids.push(...r.map(t=>t.token_id));
    if(r.length<pageSize)break;
   }
   return ids;
  },
  /** The account's whole portfolio inside the verifier: [{tokenId, amount (bigint)}], zero balances left out. */
  async holdings(accountId){
   const ids=await this.tokensForOwner(accountId);
   if(!ids.length)return [];
   const bal=await this.balances(accountId,ids);
   return ids.map((tokenId,i)=>({tokenId,amount:bal[i]})).filter(h=>h.amount>0n);
  },
  isNonceUsed:(accountId,nonce)=>view('is_nonce_used',{account_id:accountId,nonce}),
  hasPublicKey:(accountId,publicKey)=>view('has_public_key',{account_id:accountId,public_key:publicKey}),
  /**
   * `simulate_intents({signed})`: a free view call that runs the same engine as `execute_intents` on a copy of the
   * state. Returns
   *   {ok:true,  output}                         every payload passed every check and all tokens net to zero
   *   {ok:false, stage:'invariant', code, output} every payload passed; the diffs do not net to zero (`invariant_violated`)
   *   {ok:false, stage, code, message}           the contract panicked: the first check that refused, in its own words
   * Withdrawals are only checked against the balance; their cross-contract calls are not simulated.
   */
  async simulate(signed){
   let output;
   try{output=await view('simulate_intents',{signed})}
   catch(e){
    if(!(e instanceof ViewPanic))throw e;
    return {ok:false,...classifyPanic(e.panic),message:e.panic};
   }
   if(output?.invariant_violated)return {ok:false,stage:'invariant',code:'INVARIANT_VIOLATED',message:'token deltas do not net to zero',output};
   return {ok:true,output};
  },
 };
}

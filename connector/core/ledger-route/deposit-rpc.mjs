// Reading the deposit's own network (docs/LEDGER-ROUTE.md 1.5, "The deposit watch", YEET_LEDGER_DEPOSIT_STAGES=rpc).
// The logic is Folio's deposit watcher (stock-app apps/server/src/funding/watcher.ts and bridge/source-service.ts),
// cut down to what the Add funds card needs: did USDC arrive at this person's permanent deposit address?
//
// Receive-only and read-only: it builds, signs and sends nothing and holds no key.
//   Solana  the deposit address's USDC token account (the associated one, derived here: no lookup call). A baseline
//           is the newest signature on it; each look lists only what is newer (`until`), and a transaction body is
//           read once, for a new signature, to see what it brought in. One call per look while nothing happens.
//   Base    USDC `balanceOf` the deposit address: one call per look. A rise over the baseline is the deposit; its
//           Transfer log is then asked for once, for the transaction id (best effort: providers cap the block range).
// Endpoints (the first that answers; one that fails rests 30 s, doubling to 10 minutes, as Folio's source backoff):
//   SOLANA_RPC_URL          main Solana read endpoint      (Folio: L1_RPC_URL, Helius)
//   SOLANA_BACKUP_RPC_URL   second Solana endpoint         (Folio: FOLIO_SOLANA_RPC_URL)
//   BASE_RPC_URL            Base endpoint                  (Folio: FOLIO_BASE_RPC_URL, Alchemy)
// An Alchemy host is never used for Solana (owner's rule): such an entry is left out and named in the log.
import {associatedTokenAddress} from '../pipeline/solana/message.mjs';

export const USDC_SOLANA_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_BASE_CONTRACT='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ENDPOINT_REST_START_MS=30_000,ENDPOINT_REST_CAP_MS=600_000;
/** How many new signatures one look reads the bodies of (newest first). */
const MAX_BODIES=5;
const SOL_ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,EVM_ADDRESS=/^0x[0-9a-fA-F]{40}$/,SIGNATURE=/^[1-9A-HJ-NP-Za-km-z]{64,90}$/,TX_HASH=/^0x[0-9a-f]{64}$/;

const httpUrl=v=>{try{const u=new URL(v);return (u.protocol==='https:'||u.protocol==='http:')&&u.hostname?u:null}catch{return null}};
/** The read endpoints per network from the environment: {solana:[url…], base:[url…]}. Values are never logged. */
export function depositRpcFromEnv(env,log=()=>{}){
 const take=(names,{noAlchemy=false}={})=>{
  const out=[];
  for(const name of names){
   const v=env[name]?.trim();if(!v)continue;
   const u=httpUrl(v);
   if(!u){log({event:'ledger_deposit_rpc_ignored',setting:name,why:'not a URL'});continue}
   if(noAlchemy&&/(^|\.)alchemy(api)?\.(com|io)$/i.test(u.hostname)){log({event:'ledger_deposit_rpc_ignored',setting:name,why:'Alchemy is for Base only'});continue}
   if(!out.includes(v))out.push(v);
  }
  return out;
 };
 return {solana:take(['SOLANA_RPC_URL','SOLANA_BACKUP_RPC_URL'],{noAlchemy:true}),base:take(['BASE_RPC_URL'])};
}

/** JSON-RPC over the endpoints in order. An endpoint that failed (no answer, an HTTP error, a rate limit) rests (30 s
 * doubling to 10 min) and is skipped while it rests; with none left the call throws without asking anyone. `calls` counts requests really sent. */
function pool(urls,{fetch,now,timeoutMs,log,network}){
 const rest=new Map();let calls=0;
 async function one(url,method,params){
  calls+=1;
  const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok)throw Error(`HTTP ${res.status}`);
  const body=await res.json();
  if(body?.error)throw Object.assign(Error(`rpc error ${body.error.code??''}`),{refusal:![-32005,-32429,429].includes(body.error.code)});
  if(body?.result===undefined)throw Error('no result');
  return body.result;
 }
 return {
  get calls(){return calls},
  async call(method,params){
   let last=null;
   for(const [i,url] of urls.entries()){
    const r=rest.get(url);
    if(r&&now()<r.until&&now()>=r.at)continue;
    try{const out=await one(url,method,params);rest.delete(url);return out}
    catch(e){
     last=e;
     // an endpoint that answered with a refusal of this one request (a method or a block range it does not serve) is
     // alive: it does not rest; the next endpoint is asked for this request
     if(e?.refusal){log({event:'ledger_deposit_rpc_refused',network,endpoint:i,method,why:String(e.message).slice(0,60)});continue}
     const failures=(r?.failures??0)+1,wait=Math.min(ENDPOINT_REST_CAP_MS,ENDPOINT_REST_START_MS*2**Math.min(5,failures-1));
     rest.set(url,{at:now(),until:now()+wait,failures});
     log({event:'ledger_deposit_rpc_failed',network,endpoint:i,method,why:String(e?.name==='TimeoutError'?'no answer in time':e?.message??e).slice(0,60),rest_s:wait/1000});
    }
   }
   throw Error(last?`${network} rpc: ${String(last.message).slice(0,60)}`:`${network} rpc: every endpoint is resting`);
  }};
}
const big=v=>{try{return BigInt(v??'0')}catch{return 0n}};

/**
 * The reader. `has(network)`: an endpoint is configured. `mark(network,address)` -> the baseline (a small JSON
 * value to store). `look(network,address,cursor,{sinceMs})` -> {seen: null | {amount_raw: string|null, tx: string|null},
 * cursor}. `balances(network,addresses)` -> raw USDC sitting at each address now (the daily sweep; Solana in batches
 * of 100 per call). Every one throws when no endpoint answers.
 */
export function createDepositRpc({endpoints,fetch=globalThis.fetch,now=Date.now,log=()=>{},timeoutMs=6_000}){
 const pools={};
 for(const n of ['solana','base'])if(endpoints?.[n]?.length)pools[n]=pool(endpoints[n],{fetch,now,timeoutMs,log,network:n});
 const need=n=>{if(!pools[n])throw Error(`${n}: no endpoint`);return pools[n]};
 const ataOf=owner=>{if(!SOL_ADDRESS.test(owner))throw Error('not a Solana address');return associatedTokenAddress(owner,USDC_SOLANA_MINT)};
 const evm=address=>{if(!EVM_ADDRESS.test(address))throw Error('not a Base address');return address.toLowerCase()};

 // ---- Solana ----
 const signatures=(account,opts)=>need('solana').call('getSignaturesForAddress',[account,{commitment:'confirmed',...opts}]);
 /** What one landed transaction brought to `owner`'s USDC: post minus pre over its token balances (raw, may be <= 0). */
 async function inbound(signature,owner,account){
  const tx=await need('solana').call('getTransaction',[signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
  if(!tx||!tx.meta)throw Error('transaction not readable yet');
  if(tx.meta.err)return 0n;
  const keys=(tx.transaction?.message?.accountKeys??[]).map(k=>typeof k==='string'?k:k?.pubkey);
  const ours=b=>b?.mint===USDC_SOLANA_MINT&&(b.owner===owner||keys[b.accountIndex]===account);
  const total=list=>(Array.isArray(list)?list:[]).filter(ours).reduce((a,b)=>a+big(b.uiTokenAmount?.amount),0n);
  return total(tx.meta.postTokenBalances)-total(tx.meta.preTokenBalances);
 }
 async function solMark(owner){
  const list=await signatures(ataOf(owner),{limit:1});
  return {sig:Array.isArray(list)&&SIGNATURE.test(list[0]?.signature??'')?list[0].signature:null};
 }
 async function solLook(owner,cursor){
  const account=ataOf(owner),until=SIGNATURE.test(cursor?.sig??'')?cursor.sig:null;
  const list=await signatures(account,{limit:20,...(until?{until}:{})});
  // `until` excludes the cursor; an endpoint that ignores it is cut there
  const cut=(Array.isArray(list)?list:[]).findIndex(r=>r?.signature===until),fresh=(cut<0?list:list.slice(0,cut)).filter(r=>SIGNATURE.test(r?.signature??''));
  if(!fresh.length)return {seen:null,cursor:{sig:until}};
  let seen=null;
  // a body that cannot be read yet leaves the cursor where it was: the same signatures are listed again next time
  for(const r of fresh.filter(r=>!r.err).slice(0,MAX_BODIES)){
   const got=await inbound(r.signature,owner,account);
   if(got>0n){seen={amount_raw:got.toString(),tx:r.signature};break}
  }
  return {seen,cursor:{sig:fresh[0].signature}};
 }

 // ---- Base ----
 const balanceOf=async address=>big(await need('base').call('eth_call',[{to:USDC_BASE_CONTRACT,data:`0x70a08231${'0'.repeat(24)}${evm(address).slice(2)}`},'latest']));
 /** The newest USDC Transfer to `address` in the last blocks: its transaction hash, or null. Never throws. */
 async function lastTransferTo(address,sinceMs){
  try{
   const latest=Number(big(await need('base').call('eth_blockNumber',[])));
   // Base makes a block every 2 s; providers cap the range of one call, so this asks for what the look could have missed
   const span=Math.min(500,Math.ceil(Math.max(0,sinceMs)/2000)+5),hex=n=>`0x${Math.max(0,n).toString(16)}`;
   const logs=await need('base').call('eth_getLogs',[{address:USDC_BASE_CONTRACT,fromBlock:hex(latest-span),toBlock:hex(latest),topics:[TRANSFER_TOPIC,null,`0x${'0'.repeat(24)}${evm(address).slice(2)}`]}]);
   const hit=(Array.isArray(logs)?logs:[]).filter(l=>TX_HASH.test(l?.transactionHash??'')&&!l.removed).at(-1);
   return hit?{tx:hit.transactionHash,amount:big(hit.data)}:null;
  }catch{return null}
 }
 async function baseLook(address,cursor,sinceMs){
  const was=big(cursor?.bal),bal=await balanceOf(address);
  if(bal<=was)return {seen:null,cursor:{bal:bal.toString()}};
  const log=await lastTransferTo(address,sinceMs);
  // the rise is what arrived; the log only adds the transaction id (and is believed for the amount when they agree)
  return {seen:{amount_raw:(bal-was).toString(),tx:log?.tx??null},cursor:{bal:bal.toString()}};
 }

 return {
  has:n=>!!pools[n],
  networks:Object.keys(pools),
  /** Requests really sent, per network (tests, the sweep's log line). */
  calls:()=>Object.fromEntries(Object.entries(pools).map(([n,p])=>[n,p.calls])),
  async mark(network,address){return network==='solana'?solMark(address):{bal:(await balanceOf(address)).toString()}},
  async look(network,address,cursor,{sinceMs=60_000}={}){return network==='solana'?solLook(address,cursor):baseLook(address,cursor,sinceMs)},
  async balances(network,addresses){
   if(network==='base'){const out=[];for(const a of addresses)out.push(await balanceOf(a));return out}
   const accounts=addresses.map(ataOf),out=[];
   for(let i=0;i<accounts.length;i+=100){
    const r=await need('solana').call('getMultipleAccounts',[accounts.slice(i,i+100),{commitment:'confirmed',encoding:'jsonParsed'}]);
    const value=Array.isArray(r?.value)?r.value:[];
    for(let k=0;k<Math.min(100,accounts.length-i);k++){
     const info=value[k]?.data?.parsed?.info;
     // an account that does not exist holds nothing; one that is not this owner's USDC account is not counted
     out.push(info&&info.mint===USDC_SOLANA_MINT&&info.owner===addresses[i+k]?big(info.tokenAmount?.amount):0n);
    }
   }
   return out;
  }};
}

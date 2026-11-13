// Solana JSON-RPC for the sponsored leg. Lifted from Folio (stock-app origin/main 70848f097)
// apps/server/src/trade/relay-rpc.ts: reads go to the read RPC; sendTransaction goes only to the broadcast RPC with
// maxRetries 0 (the pipeline rebroadcasts the same durable bytes itself); blockhashValid = isBlockhashValid AND
// height <= lastValidBlockHeight. Added for YEET: getAccountInfo (does the deposit token account exist, which program
// owns the mint), getBalance (fee payer floor), simulateTransaction (dry runs, sigVerify off).
// Env: SOLANA_RPC_URL (reads), SOLANA_BROADCAST_RPC_URL (sends; defaults to SOLANA_RPC_URL).
export function createRelayRpc({readUrl,broadcastUrl=readUrl,fetch=globalThis.fetch,timeoutMs=15_000,log=()=>{}}){
 async function rpc(endpoint,method,params){
  if(!endpoint)throw Error(`no Solana RPC url for ${method}`);
  const started=Date.now();
  const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok){log({event:'relay_rpc_failed',method,status:res.status});throw Error('Relay RPC unavailable')}
  const body=await res.json();
  if(body?.error||body?.result===undefined){log({event:'relay_rpc_failed',method,rpc_error_code:body?.error?.code,provider_reason:String(body?.error?.message??'').slice(0,120)});
   const e=Error('Relay RPC refused');e.rpcError=body?.error;throw e}
  log({event:'relay_rpc_complete',method,ms:Date.now()-started});
  return body.result;
 }
 async function blockHeight(commitment='confirmed'){
  const h=await rpc(readUrl,'getBlockHeight',[{commitment}]);
  if(!Number.isSafeInteger(h)||h<0)throw Error('Relay block height unavailable');
  return h;
 }
 const b64=bytes=>Buffer.from(bytes).toString('base64');
 return {
  rpc,blockHeight,
  async latestBlockhash(){
   const r=await rpc(readUrl,'getLatestBlockhash',[{commitment:'confirmed'}]);
   if(typeof r?.value?.blockhash!=='string'||!Number.isSafeInteger(r.value.lastValidBlockHeight))throw Error('Relay lifetime unavailable');
   return {blockhash:r.value.blockhash,lastValidBlockHeight:String(r.value.lastValidBlockHeight)};
  },
  async blockhashValid(blockhash,lastValidBlockHeight){
   if(!/^\d+$/.test(String(lastValidBlockHeight)))return false;
   const r=await rpc(readUrl,'isBlockhashValid',[blockhash,{commitment:'confirmed'}]);
   const h=await blockHeight();
   return r?.value===true&&BigInt(h)<=BigInt(lastValidBlockHeight);
  },
  /** sendTransaction with maxRetries 0 and provider preflight; the answer is never trusted as our identity. */
  async broadcast(bytes){
   const signature=await rpc(broadcastUrl,'sendTransaction',[b64(bytes),{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);
   log({event:'cash_send',outcome:'ok',signature12:typeof signature==='string'?signature.slice(0,12):null});
   return signature;
  },
  /** {err, logs, unitsConsumed} of a simulation that does not check signatures and keeps the blockhash. */
  async simulate(bytes){
   const r=await rpc(readUrl,'simulateTransaction',[b64(bytes),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed'}]);
   return {err:r?.value?.err??null,logs:(r?.value?.logs??[]).slice(-20),unitsConsumed:r?.value?.unitsConsumed??null};
  },
  /** {owner, lamports} of an account, or null when it does not exist. */
  async accountInfo(address){
   const r=await rpc(readUrl,'getAccountInfo',[address,{encoding:'base64',commitment:'confirmed'}]);
   return r?.value?{owner:r.value.owner,lamports:r.value.lamports}:null;
  },
  async balance(address,commitment='confirmed'){
   const r=await rpc(readUrl,'getBalance',[address,{commitment}]);
   if(!Number.isSafeInteger(r?.value))throw Error('balance unavailable');
   return r.value;
  },
  /** Raw token amount of a token account (bigint), or null when it does not exist. */
  async tokenBalance(tokenAccount){
   try{const r=await rpc(readUrl,'getTokenAccountBalance',[tokenAccount,{commitment:'confirmed'}]);return /^\d+$/.test(r?.value?.amount??'')?BigInt(r.value.amount):null}
   catch(e){if(e.rpcError)return null;throw e}
  },
 };
}

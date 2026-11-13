// What the chain says about one signature. Lifted from Folio (stock-app origin/main 70848f097)
// apps/server/src/trade/signature-status.ts `createRpcSignatureStatus` (getSignatureStatuses with
// searchTransactionHistory): processed | confirmed | finalized | failed | not_found, with the commitment the provider
// reported. Folio's observation cache and coalescer are dropped (the tracker polls once per tick).
export function createRpcSignatureStatus({endpoint,fetch=globalThis.fetch,timeoutMs=15_000}){
 return async function status(signature){
  if(!endpoint)throw Error('no Solana RPC url for getSignatureStatuses');
  const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignatureStatuses',params:[[signature],{searchTransactionHistory:true}]}),signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok)throw Error('Signature status unavailable');
  const body=await res.json();
  const value=body?.result?.value;
  if(!Array.isArray(value)||value.length!==1)throw Error('Signature status unreadable');
  const s=value[0];
  if(s===null)return {status:'not_found',commitment:null,slot:null};
  const c=s.confirmationStatus;
  if(!['processed','confirmed','finalized'].includes(c)){if(s.err)return {status:'failed',commitment:null,slot:null};throw Error('Signature status unreadable')}
  return {status:s.err?'failed':c,commitment:c,slot:Number.isSafeInteger(s.slot)?s.slot:null,err:s.err??null};
 };
}

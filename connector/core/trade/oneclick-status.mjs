// 1Click /status and /deposit/submit answers carry `null` for every swapDetails field that is not known yet, in every
// status before settlement and some after (live PENDING_DEPOSIT answer of 2026-11-13: amountIn, amountInFormatted,
// amountInUsd, amountOut*, depositedAmount*, slippage, refundReason all null). The 1Click OpenAPI
// (https://1click.chaindefuser.com/docs/v0/openapi.yaml, GetExecutionStatusResponse / SwapDetails, read 2026-11-13)
// types those fields as optional strings or numbers and lists the statuses KNOWN_DEPOSIT_TX, PENDING_DEPOSIT,
// INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED. The vendored router (pinned yeet-win build) validates them
// as `optional`, which refuses `null`, so core normalises the body before the router sees it:
//   - a null scalar inside swapDetails is dropped (= not known yet); a null hash list becomes []
//   - a null explorerUrl inside a tx entry is dropped; a null quoteResponse or swapDetails is dropped
// Everything else stays strict: status (one of the seven), correlationId and updatedAt are still required strings, and a
// non-null value of the wrong type is still refused by the router's schema.
export const ONECLICK_STATUSES=Object.freeze(['PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','SUCCESS','INCOMPLETE_DEPOSIT','REFUNDED','FAILED']);
const LISTS=new Set(['intentHashes','nearTxHashes','originChainTxHashes','destinationChainTxHashes']);
const TX_LISTS=['originChainTxHashes','destinationChainTxHashes'];

/** The status body with not-yet-known nulls removed (a copy; anything that is not an object is returned as is). */
export function normalizeStatusBody(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return body;
 const out={...body};
 for(const k of ['quoteResponse','swapDetails'])if(out[k]===null)delete out[k];
 const d=out.swapDetails;
 if(d&&typeof d==='object'&&!Array.isArray(d)){
  const s={};
  for(const [k,v] of Object.entries(d)){
   if(v===null){if(LISTS.has(k))s[k]=[];continue}
   s[k]=v;
  }
  for(const k of TX_LISTS)if(Array.isArray(s[k]))s[k]=s[k].map(t=>{
   if(!t||typeof t!=='object')return t;
   const c={...t};for(const [f,v] of Object.entries(c))if(v===null&&f!=='hash')delete c[f];
   return c;
  });
  out.swapDetails=s;
 }
 return out;
}

const STATUS_PATH=/\/(status|deposit\/submit)$/;
/** A fetch for the router's OneClickClient that normalises 2xx JSON answers of /status and /deposit/submit. */
export function statusTolerantFetch(fetch=globalThis.fetch){
 return async(url,init)=>{
  const res=await fetch(url,init);
  let path;try{path=new URL(String(url)).pathname}catch{return res}
  if(!STATUS_PATH.test(path)||res.status<200||res.status>=300)return res;
  const text=await res.text();
  let json;try{json=JSON.parse(text)}catch{return new Response(text,{status:res.status,statusText:res.statusText,headers:res.headers})}
  return new Response(JSON.stringify(normalizeStatusBody(json)),{status:res.status,statusText:res.statusText,headers:res.headers});
 };
}

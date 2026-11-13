// Which catalog coins can be bought right now. The vendored catalog and router carry no availability field, so this
// asks 1Click: a DRY quote (nothing moves, no deposit address) of a small USDC amount into the coin. A coin whose quote
// fails is left out until the cache entry expires. Results are cached per coin for `ttlMs` (default 5 minutes), and
// concurrent checks of one coin share one quote. Used by the lucky wheel (lucky.mjs) to pick only tradeable coins.
import {createHash} from 'node:crypto';
import {buildYeetPlan,base58Encode,CATALOG} from '../trade/router.mjs';

export const AVAILABILITY_TTL_MS=5*60_000;
export const PROBE_USDC='5';
// Fixed, well-formed placeholder wallets for the dry quote (no key exists for them; a dry quote never sends anything).
const PROBE_SOL=base58Encode(createHash('sha256').update('yeet-availability-probe-sol').digest());
const PROBE_BASE='0x'+createHash('sha256').update('yeet-availability-probe-base').digest('hex').slice(0,40);

/** The default probe: true when 1Click answers a dry quote of PROBE_USDC into `symbol`. */
export const quoteProbe=({client,catalog=CATALOG})=>async symbol=>{
 await buildYeetPlan({amountUsdc:PROBE_USDC,legs:[{symbol,parts:1}],recipientSol:PROBE_SOL,refundBase:PROBE_BASE,dry:true},{client,catalog});
 return true;
};

/** probe(symbol) resolves truthy when the coin can be bought; a throw or a falsy answer marks it unavailable. */
export function createAvailability({probe,ttlMs=AVAILABILITY_TTL_MS,now=Date.now}){
 const cache=new Map(),inflight=new Map();
 async function check(symbol){
  const hit=cache.get(symbol);
  if(hit&&now()-hit.at<ttlMs)return hit.ok;
  if(inflight.has(symbol))return inflight.get(symbol);
  const p=(async()=>{
   let ok=false;
   try{ok=!!(await probe(symbol))}catch{ok=false}
   cache.set(symbol,{ok,at:now()});
   return ok;
  })().finally(()=>inflight.delete(symbol));
  inflight.set(symbol,p);
  return p;
 }
 return {
  check,
  /** The coins of `symbols` that are available now, in the given order. */
  async available(symbols){
   const ok=await Promise.all(symbols.map(check));
   return symbols.filter((_,i)=>ok[i]);
  },
 };
}

// Which network pays a YEET (buy): the person's USDC on Base or their USDC on Solana.
//
//   YEET_BUY_CHAIN unset (or empty, or `auto`)  the choice is made per trade:
//     1. read the person's USDC on both networks (kept for BALANCE_TTL_MS; execute_trade always reads again)
//     2. a network that is paused (YEET_SOLANA_PAUSE / YEET_BASE_PAUSE) or whose driver is not ready is left out
//     3. of the networks whose balance covers the whole basket, the larger balance pays (a tie: Solana)
//     4. no network covers it alone: BALANCE_LOW, naming both balances. A basket is never split across networks.
//     A balance that cannot be read counts as 0 and is reported as null; the trade goes on when the other network
//     covers it. Both unreadable: TEMPORARILY_UNAVAILABLE (as before, for the one network).
//   YEET_BUY_CHAIN=sol|base  that network pays every buy (the override; pause, readiness and balance are then checked
//     by the pipeline for that network only, as before this module existed).
//
// The contract names the networks `base` and `solana`; the drivers name them `base` and `sol`.
import {formatUnits} from '../trade/router.mjs';
import {usdcOn} from './oneclick-leg.mjs';
import {CHAINS} from './driver-interface.mjs';
import {TradeError,usd} from '../trade/util.mjs';

export const BALANCE_TTL_MS=5_000;
/** Driver chain -> contract network name, and the name a person reads. */
export const NETWORK=Object.freeze({base:'base',sol:'solana'});
export const NETWORK_NAME=Object.freeze({base:'Base',sol:'Solana'});
const TRUE=['1','true','on','yes'];
const dollars=raw=>`$${(Number(raw)/1e6).toFixed(2)}`;

/** YEET_BUY_CHAIN as an override: 'sol' | 'base', or null when the choice is automatic. Throws on any other value. */
export function forcedBuyChain(env){
 const v=env.YEET_BUY_CHAIN?.trim().toLowerCase();
 if(!v||v==='auto')return null;
 if(!CHAINS.includes(v))throw Error('Invalid YEET_BUY_CHAIN');
 return v;
}
export const chainPaused=(env,chain)=>TRUE.includes(String((chain==='sol'?env.YEET_SOLANA_PAUSE:env.YEET_BASE_PAUSE)??'').toLowerCase());

/** The BALANCE_LOW sentence for a basket no single network covers. Balances are raw USDC (6 decimals) or null. */
export function balanceLowMessage({total,base,sol,open}){
 const part=(chain,raw)=>raw===null?`your ${NETWORK_NAME[chain]} balance could not be read just now`:`you have ${dollars(raw)} USDC on ${NETWORK_NAME[chain]}`;
 const closed=CHAINS.filter(c=>!open.includes(c)).map(c=>NETWORK_NAME[c]);
 return [`Not enough USDC for this ${dollars(total)} basket: ${part('base',base)} and ${part('sol',sol)}.`,
  'One network has to cover the whole basket.',
  closed.length?`${closed.join(' and ')} is not available right now.`:'',
  'Add funds, or lower the amount.'].filter(Boolean).join(' ').slice(0,500);
}

export function createFunding({env,wallets,drivers,catalog,now=Date.now,ttlMs=BALANCE_TTL_MS}){
 const cache=new Map();
 const solMint=()=>usdcOn('sol',catalog)?.address;
 const readers={
  base:w=>wallets.usdc(w.base.address),
  sol:async w=>{const m=solMint();return (await wallets.holdings(w.solana.address)).filter(h=>h.mint===m).reduce((a,h)=>a+h.raw,0n)},
 };
 /** {base, sol}: raw USDC per network, null where the read failed. Never throws. */
 async function balances(w,{fresh=false}={}){
  const key=`${w.base.address}|${w.solana.address}`,hit=cache.get(key);
  if(!fresh&&hit&&now()-hit.at<ttlMs&&now()>=hit.at)return hit.value;
  const [base,sol]=await Promise.all(['base','sol'].map(c=>readers[c](w).then(v=>BigInt(v),()=>null)));
  const value={base,sol};
  // A failed read is not kept: the next call tries again.
  if(base!==null&&sol!==null){cache.set(key,{at:now(),value});if(cache.size>500)cache.delete(cache.keys().next().value)}else cache.delete(key);
  return value;
 }
 const forced=()=>forcedBuyChain(env);
 const ready=chain=>{try{return !!drivers[chain]?.readiness?.().ok}catch{return false}};
 /** Networks a buy may be paid from right now: not paused, driver ready. */
 const open=()=>CHAINS.filter(c=>!chainPaused(env,c)&&ready(c));
 /** The network that pays `total` (raw USDC) out of `bal`, or null. Larger balance first; a tie goes to Solana. */
 function pick(bal,total){
  const f=forced();
  if(f)return bal[f]===null||bal[f]>=total?f:null;
  const covering=open().filter(c=>bal[c]!==null&&bal[c]>=total);
  if(!covering.length)return null;
  return covering.reduce((best,c)=>bal[c]>bal[best]?c:best,covering[0]);
 }
 /** The contract `funding` object: both balances and the network that would pay `total`. */
 const view=(bal,total)=>{const c=pick(bal,total);return {base_usdc:bal.base===null?null:usd(formatUnits(bal.base,6)),solana_usdc:bal.sol===null?null:usd(formatUnits(bal.sol,6)),chosen:c?NETWORK[c]:null}};
 return {
  balances,forced,open,pick,view,
  /** execute_trade without an override: the network that pays `total`, read fresh. Refuses when none can. */
  async choose(w,total){
   const bal=await balances(w,{fresh:true}),usable=open();
   if(!usable.length)throw new TradeError(CHAINS.some(c=>chainPaused(env,c))?'TRADING_PAUSED':'TEMPORARILY_UNAVAILABLE',CHAINS.some(c=>chainPaused(env,c))?'SOURCE_PAUSED':'no driver ready');
   const chain=pick(bal,total);
   if(chain)return {chain,balances:bal};
   if(usable.every(c=>bal[c]===null))throw new TradeError('TEMPORARILY_UNAVAILABLE','USDC balance unreadable on every open network');
   const e=new TradeError('BALANCE_LOW',`auto: base ${bal.base??'unread'} sol ${bal.sol??'unread'} need ${total} open ${usable.join('+')}`);
   e.userMessage=balanceLowMessage({total,base:bal.base,sol:bal.sol,open:usable});
   throw e;
  },
 };
}

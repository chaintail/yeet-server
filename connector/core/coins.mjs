// yeet_coins: the curated catalogue from the vendored yeet-win router (vendor/yeet-win/PINNED records the commit).
// Same filter as the router's tradableOnSolana (catalog.ts): Solana entries that are not the funding asset.
import {readFileSync} from 'node:fs';
const catalogue=JSON.parse(readFileSync(new URL('../vendor/yeet-win/packages/router/src/catalog.json',import.meta.url),'utf8'));
const usdc=/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;
function amount(name,fallback){
 const value=process.env[name]??fallback;
 if(!usdc.test(value))throw Error(`Invalid ${name}`);
 return value;
}
export function tradable(entries=catalogue){
 return entries.filter(e=>e.chain==='solana'&&e.kind!=='funding');
}
/** Prices stay null until the 1Click /tokens price feed is wired in (lane B). */
export function coins(){
 return {
  coins:tradable().slice(0,25).map(e=>({symbol:e.symbol,name:e.name,kind:e.kind,price_usd:null})),
  limits:{
   min_leg_usdc:amount('YEET_MIN_LEG_USDC','3'),
   max_trade_usdc:amount('YEET_MAX_TRADE_USDC','25'),
   max_legs:5,
   default_usdc:'20',
  },
 };
}

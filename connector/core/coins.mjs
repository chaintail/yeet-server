// yeet_coins and yeet_coin: the curated catalogue from the vendored yeet-win router (vendor/yeet-win/PINNED records the
// commit), with live prices from market.mjs (free public endpoints, no key; a number the source lacks is null).
// Same filter as the router's tradableOnSolana (catalog.ts): Solana entries that are not the funding asset.
import {readFileSync} from 'node:fs';
import {createMarket} from './market.mjs';
import {limitsFromEnv} from './trade/limits.mjs';
const catalogue=JSON.parse(readFileSync(new URL('../vendor/yeet-win/router/dist/src/catalog.json',import.meta.url),'utf8'));
export function tradable(entries=catalogue){
 return entries.filter(e=>e.chain==='solana'&&e.kind!=='funding');
}
const usdcText=raw=>{const s=(raw/1_000_000n).toString(),f=(raw%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${s}.${f}`:s};
/** The same minimum leg and account-blind per-trade ceiling the trade engine enforces (trade/limits.mjs): an unset,
 * empty or blank variable (compose passes unset ones as '') is its default, as it is there. */
const limits=(env=process.env)=>{const l=limitsFromEnv(env);return {
 min_leg_usdc:usdcText(l.minLegRaw),
 max_trade_usdc:usdcText(l.maxTradeRaw),
 max_legs:l.maxLegs,
 default_usdc:'20',
}};
export {limits as coinLimits};
const NO_CHANGE=Object.freeze({h1:null,h6:null,h24:null});
let shared;
const defaultMarket=()=>shared??=createMarket();
/** yeet_coins: every tradable coin with its price and its change over 1 hour, 6 hours and 24 hours, so "what is
 * moving" is one call. as_of: when the prices were read; null (and every price null) when they could not be. */
export async function coins({market=defaultMarket()}={}){
 const list=tradable().slice(0,25);
 const {as_of,bySymbol}=await market.quotes(list);
 return {
  coins:list.map(e=>{const q=bySymbol.get(e.symbol);return {symbol:e.symbol,name:e.name,kind:e.kind,price_usd:q?.price_usd??null,change_pct:q?{...q.change_pct}:{...NO_CHANGE}}}),
  as_of,
  limits:limits(),
 };
}
/** What a person may type for a coin ("wif", "$WIF", " Wif ") -> the catalogue symbol's form, or null. */
export function symbolOf(value){
 if(typeof value!=='string')return null;
 const s=value.trim().replace(/^\$/,'').toUpperCase();
 return /^[A-Z0-9]{2,12}$/.test(s)?s:null;
}
/** The follow-ups for one coin, in the order the model offers them. `say` is what the person would type. */
export const coinSuggestions=symbol=>[
 {id:'research',label:`Research ${symbol} deeper`,say:`Research ${symbol} deeper: its history and recent news`},
 {id:'yeet',label:`YEET ${symbol}`,say:`YEET ${symbol}`},
 {id:'moving',label:'What else is moving?',say:'What else is moving?'},
];
/**
 * yeet_coin: one coin, or null for a symbol that is not a tradable catalogue coin. `holding`: {amount, usd} from the
 * person's portfolio read, or null. `card_chart` (the 24 hourly prices) is for the card only: the connector moves it
 * to the result's _meta and the model never reads it. description, website and x are third-party (market.mjs).
 */
export async function coin(symbol,{market=defaultMarket(),holding=null}={}){
 const e=tradable().slice(0,25).find(c=>c.symbol===symbol);
 if(!e)return null;
 const [{as_of,bySymbol},profile,points]=await Promise.all([market.quotes(tradable().slice(0,25)),market.profile(e),market.history(e)]);
 const q=bySymbol.get(e.symbol)??null;
 return {
  symbol:e.symbol,name:e.name,kind:e.kind,
  price_usd:q?.price_usd??null,change_pct:q?{...q.change_pct}:{...NO_CHANGE},as_of:q?as_of:null,
  market_cap_usd:q?.market_cap_usd??null,volume_24h_usd:q?.volume_24h_usd??null,liquidity_usd:q?.liquidity_usd??null,
  description:profile?.description??null,website:profile?.website??q?.website??null,x:profile?.x??q?.x??null,
  holding,
  limits:limits(),
  suggestions:coinSuggestions(e.symbol),
  ...(q&&points?{card_chart:{points}}:{}),
 };
}

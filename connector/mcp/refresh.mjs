// A stale YEET app in ChatGPT (owner: "We need mcp to tell ChatGPT to tell the user when they need to refresh their
// plugin and give them a direct link to the plugins page"). ChatGPT keeps an app's tool list and card templates; after
// a deploy a person can be on old cards or an old tool list until they refresh the app.
//
// What the server can see (docs/APPS-SDK-FACTS.md):
//   - A card built from another yeet-win commit than the one vendored here: cards send `card_build` with every tool
//     call they make (contract $defs.card_build). The server's own card build is vendor/yeet-win/PINNED.
//   - A card from before build ids existed: a call to a card-only tool (execute_trade, submit_trade_signature,
//     daily_spin, lucky_spin) that carries no `card_build` can only come from such a card.
//   - It cannot see the tool list ChatGPT holds. A call for a tool or an argument this server no longer has is refused
//     by the protocol layer before any YEET code runs; no tool or field has been removed so far. A NEW tool missing on
//     the client side is not visible from here at all. The card covers part of that gap: it marks itself stale when
//     the host answers that a tool it calls is unknown, and when a result's `_meta['yeet/build']` differs from its own.
//
// What happens: the conversation is remembered as stale (key: the account and ChatGPT's anonymized conversation id
// `_meta["openai/session"]`, or the account alone), and the next result the MODEL reads (a call without `card_build`)
// carries the refresh guidance, once per conversation. yeet_overview also carries `app_refresh`. Kept in this
// process only: a restart forgets it, and stale cards report again with their next call.
import {readFileSync} from 'node:fs';
import {contract,META_KEYS} from './tool-contract.mjs';

/** Where the person manages apps in ChatGPT and what to do there: the contract's one constant (`x-yeet-app`). */
export const APP=Object.freeze(contract['x-yeet-app']);
export const BUILD_META_KEY=META_KEYS.build;
const SHA=/^[0-9a-f]{7,40}$/;
/** The yeet-win commit the vendored cards were built from (vendor/yeet-win/PINNED). */
export function vendoredBuild(text=readFileSync(new URL('../vendor/yeet-win/PINNED',import.meta.url),'utf8')){
 const sha=text.match(/^commit: ([0-9a-f]{40})$/m)?.[1];
 if(!sha)throw Error('vendor/yeet-win/PINNED has no commit');
 return sha;
}
export const CARD_BUILD=vendoredBuild();
/** Two build ids name the same commit when one is a prefix of the other (a short and a full sha). */
export const sameBuild=(a,b)=>SHA.test(a??'')&&SHA.test(b??'')&&(a.startsWith(b)||b.startsWith(a));

export const TTL_MS=12*3_600_000,MAX_KEYS=5000;
export function createStaleness({build=CARD_BUILD,now=Date.now,ttlMs=TTL_MS,max=MAX_KEYS}={}){
 const seen=new Map();   // key -> {at, told}
 const live=key=>{const v=seen.get(key);if(v&&now()-v.at>ttlMs){seen.delete(key);return undefined}return v};
 return {
  build,
  /** One tool call. cardBuild: its `card_build` argument or undefined; cardOnly: the tool is hidden from the model.
   * Returns true when this call shows a stale card. */
  note(key,{cardBuild,cardOnly=false}={}){
   const stale=typeof cardBuild==='string'?!sameBuild(cardBuild,build):cardOnly;
   if(stale&&!live(key)){seen.set(key,{at:now(),told:false});if(seen.size>max)seen.delete(seen.keys().next().value)}
   return stale;
  },
  isStale:key=>!!live(key),
  /** True once per key while it is stale: the caller then tells the model. */
  take(key){const v=live(key);if(!v||v.told)return false;v.told=true;return true},
  size:()=>seen.size,
 };
}
/** The process's one record (a server object is made per request; this outlives them). */
export const staleness=createStaleness();
/** account + conversation, as far as ChatGPT names the conversation. */
export const staleKey=(token,meta)=>`${token?.sub??token?.subject??'anon'}|${typeof meta?.['openai/session']==='string'?meta['openai/session'].slice(0,200):''}`;
/** yeet_overview.app_refresh. */
export const appRefresh=()=>({url:APP.manage_url,steps:APP.refresh_steps});
/** `refresh` first, then as much of the result's own guidance as the contract's 500 characters hold (whole sentences). */
export function withRefresh(refresh,own,max=500){
 let out=refresh;
 for(const s of String(own??'').split(/(?<=[.!?])\s+/).filter(Boolean)){if(out.length+1+s.length>max)break;out+=` ${s}`}
 return out;
}

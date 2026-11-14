// A stale YEET app in ChatGPT (owner: "We need mcp to tell ChatGPT to tell the user when they need to refresh their
// plugin and give them a direct link to the plugins page"). ChatGPT keeps an app's tool list and card templates; after
// a deploy a person can be on old cards or an old tool list until they refresh the app.
//
// What the server can see (docs/APPS-SDK-FACTS.md):
//   - A card built from another yeet-win commit than the one vendored here: cards send `card_build` with every tool
//     call they make (contract $defs.card_build). The server's own card build is vendor/yeet-win/PINNED.
//   - A card from before build ids existed: a call to a card-only tool (execute_trade, submit_trade_signature,
//     daily_spin, lucky_spin) that carries no `card_build` can only come from such a card.
//   - The tool list ChatGPT holds, at the entry call only: yeet_overview's schema allows one `app_version` (the
//     contract's tools version), so the model's call names the list it was made from (classifyToolsVersion below).
//     Elsewhere it stays invisible: a call for a tool or an argument this server no longer has is refused by the
//     protocol layer before any YEET code runs, and a NEW tool missing on the client side is not visible at all. The
//     card covers part of that gap: it marks itself stale when the host answers that a tool it calls is unknown, and
//     when a result's `_meta['yeet/build']` differs from its own.
//
// What happens: the conversation is remembered as stale (key: the account and ChatGPT's anonymized conversation id
// `_meta["openai/session"]`, or the account alone), and the next result the MODEL reads (a call without `card_build`)
// carries the refresh guidance, once per conversation. yeet_overview also carries `app_refresh`. Kept in this
// process only: a restart forgets it, and stale cards report again with their next call.
import {readFileSync} from 'node:fs';
import {contract,META_KEYS} from './tool-contract.mjs';

/** Where the person manages apps in ChatGPT and what to do there, and the tools version: the contract's one constant (`x-yeet-app`). */
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
  /** The conversation runs on another tool list than this server's (classifyToolsVersion). `told`: the model is told
   * in this very answer, so take() stays false for it. */
  mark(key,{told=false}={}){
   const v=live(key);
   if(v){if(told)v.told=true;return}
   seen.set(key,{at:now(),told});if(seen.size>max)seen.delete(seen.keys().next().value);
  },
  isStale:key=>!!live(key),
  /** True once per key while it is stale: the caller then tells the model. */
  take(key){const v=live(key);if(!v||v.told)return false;v.told=true;return true},
  size:()=>seen.size,
 };
}
// The tool list ChatGPT holds (contract x-yeet-app, yeet-win docs/CARDS.md "Tools version"): yeet_overview's schema
// allows one `app_version`, the current tools version, and the model copies it. So the entry call says which tool
// list the conversation runs on:
//   current   the value this server advertises: nothing to do
//   outdated  a value advertised before (tools_versions_past): the list is older than the server. Refresh only.
//   missing   no value: a list from before the property existed
//   malformed not a tools version at all
//   unknown   a well-formed value this server never advertised (a newer list after a roll-back, or an invented one)
// missing, malformed and unknown are never refused: the overview answers as always, with the soft refresh hint.
export const TOOLS_VERSIONS=Object.freeze({current:APP.tools_version,past:Object.freeze([...(APP.tools_versions_past??[])])});
const TOOLS_VERSION=/^tools-[1-9][0-9]{0,5}$/;
export function classifyToolsVersion(value,{current,past}=TOOLS_VERSIONS){
 if(value===undefined)return 'missing';
 if(typeof value!=='string'||!TOOLS_VERSION.test(value))return 'malformed';
 if(value===current)return 'current';
 return past.includes(value)?'outdated':'unknown';
}
/** What the log keeps of the value: a well-formed version as it is, otherwise only its type. */
export const loggedVersion=v=>typeof v==='string'&&TOOLS_VERSION.test(v)?v:v===undefined?null:`(${v===null?'null':typeof v})`;
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

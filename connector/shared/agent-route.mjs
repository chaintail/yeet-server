// The agent route (connector/docs/AGENT-ROUTE.md): a second MCP endpoint, on its own host (AGENT_RESOURCE, by default
// https://mcp.yeet.win), for coding agents (Claude Code, Codex, any MCP client). Same YEET account as the ChatGPT
// route, plain JSON, no cards, and trades the agent signs with its own key.
//
// YEET_AGENT_ROUTE=on turns it on. Anything else that is set is refused; unset or off leaves every service exactly as
// before: no agent endpoint (404), no agent class, no new OAuth client may register, every guard below inactive.
//
// Every OAuth client has a class, decided only by its redirect URIs (never by User-Agent or IP):
//   chatgpt  every redirect URI is one of ChatGPT's connector redirects (as/security-policy.mjs chatgptRedirect)
//   agent    none of them is (a loopback or https callback of a local agent)
// A client whose list mixes both is refused at registration. Tokens carry the class (`yeet_route`, stamped by the
// sign-in server) and the resource they were issued for (aud). The ChatGPT endpoint refuses agent tokens and the agent
// endpoint refuses ChatGPT tokens, at the authorization step and on every call, with WRONG_ROUTE.
import {RESOURCE} from './common.mjs';

const ON=['on'],OFF=['','off'];
/** Whether the agent route is on. Throws on a value it does not know (the service does not start). */
export function agentRouteOn(env=process.env){
 const v=(env.YEET_AGENT_ROUTE??'').trim().toLowerCase();
 if(ON.includes(v))return true;
 if(OFF.includes(v))return false;
 throw Error('Invalid YEET_AGENT_ROUTE (on or off)');
}
/** The agent endpoint's resource URL (its own host). */
export function agentResource(env=process.env){
 const v=(env.AGENT_RESOURCE??'').trim()||'https://mcp.yeet.win';
 const u=new URL(v);
 if(!/^https?:$/.test(u.protocol)||u.search||u.hash)throw Error('Invalid AGENT_RESOURCE');
 if(u.host===new URL(RESOURCE).host)throw Error('AGENT_RESOURCE must be on its own host, not the ChatGPT endpoint\'s');
 return u.href.replace(/\/$/,'')||u.href;
}
export const ROUTE_CLASSES=Object.freeze(['chatgpt','agent']);
export const WRONG_ROUTE='WRONG_ROUTE';
/** The ChatGPT endpoint's URL as a person would paste it. */
const chatgptUrl=()=>RESOURCE;
/** The sentence a model can relay, and the URL that is right for this client. */
export function wrongRoute(expected,env=process.env){
 if(expected==='agent')return {error:WRONG_ROUTE,correct_url:agentResource(env),
  message:`This is the ChatGPT version of YEET, installed in a coding agent. Agents connect to ${agentResource(env)} instead: remove this server and add that URL.`};
 return {error:WRONG_ROUTE,correct_url:chatgptUrl(),
  message:`This is the agent version of YEET (${agentResource(env)}), installed inside ChatGPT. In ChatGPT, add YEET with ${chatgptUrl()} instead.`};
}

const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]']);
/** A redirect URI a local agent may register: https anywhere, or http on a loopback address. No fragment, no
 * credentials. Custom schemes are refused (nothing on this route needs them). */
export function agentRedirect(uri){
 if(typeof uri!=='string'||uri.length>500)return false;
 let u;try{u=new URL(uri)}catch{return false}
 if(u.hash||u.username||u.password)return false;
 if(u.protocol==='https:')return true;
 return u.protocol==='http:'&&LOOPBACK.has(u.hostname);
}
/** The class of a client from its redirect URIs: 'chatgpt', 'agent', or null (empty, mixed, or not allowed). */
export function classOfRedirects(uris,isChatgpt){
 if(!Array.isArray(uris)||!uris.length)return null;
 if(uris.every(isChatgpt))return 'chatgpt';
 if(uris.some(isChatgpt))return null;
 return uris.every(agentRedirect)?'agent':null;
}

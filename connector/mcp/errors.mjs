import {advertisedScopes} from '#scope-catalog';
import {normalize,toolMessage,isRetryable,CANNOT_FILL_MESSAGE} from '#contracts/errors';
import {refusalGuidance} from './guidance.mjs';
import {META_KEYS,contract} from './tool-contract.mjs';
const APP=contract['x-yeet-app'];
/** ctx: as in guidance.mjs (the registered tool names); without it the guidance assumes every tool is there.
 * tool: the tool that failed, when known (an outage of a tool that can never send a trade may say nothing was traded). */
export function toolError(value,ctx,{tool}={}){
 const code=normalize(value?.error);
 // LIMIT_EXCEEDED: the core's sentence with the person's tier, limits and amount left today (trade/limits.mjs).
 // BALANCE_LOW: the core's sentence with the person's USDC on Base and on Solana (pipeline/funding.mjs).
 // AMOUNT_TOO_SMALL: only a SELL under the sell minimum has its own sentence (trade/limits.mjs skeetTooSmall).
 const own=(code==='LIMIT_EXCEEDED'||code==='BALANCE_LOW'||code==='AMOUNT_TOO_SMALL')&&typeof value?.message==='string'&&value.message.length>=1&&value.message.length<=500?value.message
  // TEMPORARILY_UNAVAILABLE (also what any unknown failure becomes): only the one known sentence, never the core's words.
  :value?.error==='TEMPORARILY_UNAVAILABLE'&&value?.message===CANNOT_FILL_MESSAGE?CANNOT_FILL_MESSAGE:null;
 const data={error:code,message:own??toolMessage(code),retryable:isRetryable(code)};
 // BALANCE_LOW: where the person adds USDC (contract $defs.failure fund_url, https only); the card shows Add funds.
 if(code==='BALANCE_LOW'&&typeof value?.fund_url==='string'&&/^https:\/\/[^\s]{1,500}$/.test(value.fund_url))data.fund_url=value.fund_url;
 // Agent guidance for the model (guidance.mjs); the card reads only error, message and fund_url.
 // TERMS_REQUIRED: the current terms (statements with their links, where to accept), and from yeet_accept_terms the
 // required statements that were not confirmed.
 // APP_OUTDATED: where they refresh the app and how (contract $defs.failure app_refresh, from x-yeet-app).
 if(code==='APP_OUTDATED')data.app_refresh={url:APP.manage_url,steps:APP.refresh_steps};
 const terms=code==='TERMS_REQUIRED'&&value?.terms&&typeof value.terms==='object'?value.terms:null;
 if(terms){data.terms=terms;if(Array.isArray(value.missing)&&value.missing.length)data.missing=value.missing.filter(x=>typeof x==='string').slice(0,12)}
 const guidance=refusalGuidance(code,data.message,ctx,{terms,reason:value?.reason,tool});
 if(guidance)data.guidance=guidance;
 // An error result never carries structuredContent: every tool's output schema describes its success only, and a
 // protocol client checks any structuredContent against it (a TERMS_REQUIRED object there was rejected with -32602). The model
 // and the card read the JSON text. Card only (_meta, contract x-yeet-meta.failure): what a card draws of the refusal,
 // for the bridge that hands it no text (window.openai.toolOutput is empty on an error).
 const card={error:code,message:data.message,...(data.fund_url?{fund_url:data.fund_url}:{}),...(terms?{terms:{mode:terms.mode==='page'?'page':'chat',...(typeof terms.page_url==='string'?{page_url:terms.page_url}:{})}}:{})};
 // 'mcp/www_authenticate': protocol key, read by the host to start a step-up authorization; never shown to the person.
 const meta={...(META_KEYS.failure?{[META_KEYS.failure]:card}:{}),...(code==='REAUTH_REQUIRED'?{'mcp/www_authenticate':[`Bearer error="insufficient_scope", scope="${advertisedScopes().join(' ')}"`]}:{})};
 return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],...(Object.keys(meta).length?{_meta:meta}:{})};
}

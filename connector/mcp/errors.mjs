import {consentScopes} from '#scope-catalog';
import {normalize,toolMessage,isRetryable} from '#contracts/errors';
import {refusalGuidance} from './guidance.mjs';
/** ctx: as in guidance.mjs (the registered tool names); without it the guidance assumes every tool is there. */
export function toolError(value,ctx){
 const code=normalize(value?.error);
 // LIMIT_EXCEEDED: the core's sentence with the person's tier, limits and amount left today (trade/limits.mjs).
 // BALANCE_LOW: the core's sentence with the person's USDC on Base and on Solana (pipeline/funding.mjs).
 const own=(code==='LIMIT_EXCEEDED'||code==='BALANCE_LOW')&&typeof value?.message==='string'&&value.message.length>=1&&value.message.length<=500?value.message:null;
 const data={error:code,message:own??toolMessage(code),retryable:isRetryable(code)};
 // BALANCE_LOW: where the person adds USDC (contract $defs.failure fund_url, https only); the card shows Add funds.
 if(code==='BALANCE_LOW'&&typeof value?.fund_url==='string'&&/^https:\/\/[^\s]{1,500}$/.test(value.fund_url))data.fund_url=value.fund_url;
 // Agent guidance for the model (guidance.mjs); the card reads only error, message and fund_url.
 const guidance=refusalGuidance(code,data.message,ctx);
 if(guidance)data.guidance=guidance;
 // Protocol key, read by the host to start a step-up authorization; never shown to the person.
 return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],...(code==='REAUTH_REQUIRED'?{_meta:{'mcp/www_authenticate':[`Bearer error="insufficient_scope", scope="${consentScopes.join(' ')}"`]}}:{})};
}

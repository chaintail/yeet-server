import {consentScopes} from '#scope-catalog';
import {normalize,toolMessage,isRetryable} from '#contracts/errors';
export function toolError(value){
 const code=normalize(value?.error);
 const data={error:code,message:toolMessage(code),retryable:isRetryable(code)};
 // Protocol key, read by the host to start a step-up authorization; never shown to the person.
 return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],...(code==='REAUTH_REQUIRED'?{_meta:{'mcp/www_authenticate':[`Bearer error="insufficient_scope", scope="${consentScopes.join(' ')}"`]}}:{})};
}

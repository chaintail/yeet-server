import {consentScopes,realScope,realAdvertised} from '#scope-catalog';
import {normalize,toolMessage,isRetryable} from '#contracts/errors';
export function toolError(value){
 const code=normalize(value?.error);
 const data={error:code,message:toolMessage(code),retryable:isRetryable(code)};
 return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],...(code==='REAUTH_REQUIRED'?{_meta:{'mcp/www_authenticate':[`Bearer error="insufficient_scope", scope="${consentScopes.filter(s=>s!==realScope||realAdvertised()).join(' ')}"`]}}:{})};
}
export function accountError(request){
 if(request?.method==='tools/call'&&request.params?.name==='save_research'&&!['trial','real'].includes(request.params.arguments?.account))return toolError({error:'ACCOUNT_REQUIRED'});
}

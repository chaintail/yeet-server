import {grantedSubset,refreshScopes} from '#scope-catalog';
import {html} from './auth-pages.mjs';
/** UI owner renders this state. Every consent, including a plain reconnect, needs the explicit submit. */
export function consentSelection(requested, priorGranted=[]){
 return {trade_requested:requested.includes('yeet:trade'),requires_confirm:true};
}
export function submittedScopes(requested,body){
 if(body.consent!=='yes')throw Error('Explicit consent required');
 return grantedSubset(requested);
}
/** Daily allowance shown on the consent page (the core enforces it; YEET_DAILY_CAP_USDC). */
export function dailyAllowance(value=process.env.YEET_DAILY_CAP_USDC){
 return typeof value==='string'&&/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(value)?value:'50';
}
/** Production consent fields: the scopes granted, plus one plain line about money when trading is requested. */
export function consentFields(requested,priorGranted=[]){
 // grantedSubset keeps only catalog scope names, so the list needs no escaping.
 const listed=grantedSubset(requested).join(' ');
 const trade=requested.includes('yeet:trade')?`<p>YEET can send up to ${html(dailyAllowance())} USDC a day from your YEET wallet, only when you tap ⚡ YEET.</p>`:'';
 return `<dt>Scopes granted</dt><dd>${listed}</dd></dl>${trade}`;
}
/** The production consent form exactly as as.mjs sends it (inside authDocument). */
export function consentForm({csrf,accountId,clientId,resource,requested,priorGranted=[],renewal=''}){
 return `<form method="POST"><input type="hidden" name="csrf" value="${html(csrf)}"><dl><dt>Authorized account</dt><dd>${html(accountId)}</dd><dt>Client</dt><dd>${html(clientId)}</dd><dt>Resource</dt><dd>${html(resource)}</dd>${consentFields(requested,priorGranted)}<input type="hidden" name="consent" value="yes">${renewal}<button type="submit">Authorize requested scopes</button></form>`;
}
export function ignoreRefreshScope(body){
 if(body?.grant_type==='refresh_token')delete body.scope;
 return body;
}
export {refreshScopes};
/** Record a consent on an oidc-provider Grant. as.mjs lists the yeet scopes as provider (OP) scopes, so the
 *  provider's op_scopes_missing check needs every requested OP scope granted or rejected at the OIDC level,
 *  not only on the resource; otherwise each consent re-prompts consent forever. Refused scopes are rejected
 *  at both levels so they are never granted and never re-prompt. */
export function applyConsentScopes(grant,{requested,granted,resource,opScopes,resourceScopes}){
 const refused=[...new Set(requested)].filter(x=>!granted.includes(x));
 grant.addOIDCScope(granted.filter(x=>opScopes.includes(x)).join(' '));
 grant.addResourceScope(resource,granted.filter(x=>resourceScopes.includes(x)).join(' '));
 const refusedOp=refused.filter(x=>opScopes.includes(x)),refusedRs=refused.filter(x=>resourceScopes.includes(x));
 if(refusedOp.length)grant.rejectOIDCScope(refusedOp.join(' '));
 if(refusedRs.length)grant.rejectResourceScope(resource,refusedRs.join(' '));
}

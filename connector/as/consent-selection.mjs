import {baseScopes,realScope,grantedSubset,refreshScopes,advertisedScopes} from '#scope-catalog';
import {html} from './auth-pages.mjs';
/** Authorization parameter that marks an explicit Real step-up (a Real call needed folio:real:read). */
export const STEP_UP_PARAM='folio_step_up';
export const isRealStepUp=params=>params?.[STEP_UP_PARAM]==='real';
/** UI owner renders this state. Every consent, including a plain reconnect, starts unticked;
 *  only an explicit Real step-up for a grant that lacks Real is preselected. */
export function consentSelection(requested, priorGranted=[], {stepUp=false}={}){
 const requestedReal=requested.includes(realScope);
 return {real_requested:requestedReal,real_selected:requestedReal&&stepUp===true&&!priorGranted.includes(realScope),requires_confirm:true};
}
export function submittedScopes(requested,body,advertised=advertisedScopes()){
 if(body.consent!=='yes')throw Error('Explicit consent required');
 // Accept only the UI's explicit checkbox value, never a hidden requested scope; never while Real is unadvertised.
 return grantedSubset(requested,body.real_consent==='yes'&&advertised.includes(realScope));
}
/** Production consent fields: list only scopes granted without the Real choice; offer Real only when requested and advertised. */
export function consentFields(requested,priorGranted=[],advertised=advertisedScopes(),{stepUp=false}={}){
 const selection=consentSelection(requested,priorGranted,{stepUp});
 const offerReal=selection.real_requested&&advertised.includes(realScope);
 // grantedSubset keeps only catalog scope names, so the list needs no escaping.
 const listed=grantedSubset(requested,false).join(' ');
 const real=offerReal?`<label><input type="checkbox" name="real_consent" value="yes"${selection.real_selected?' checked':''}> Also share my Real account (${realScope})</label>`:'';
 return `<dt>Scopes granted</dt><dd>${listed}</dd></dl>${real}`;
}
/** The production consent form exactly as as.mjs sends it (inside authDocument). */
export function consentForm({csrf,accountId,clientId,resource,requested,priorGranted=[],stepUp=false,renewal='',advertised=advertisedScopes()}){
 return `<form method="POST"><input type="hidden" name="csrf" value="${html(csrf)}"><dl><dt>Authorized account</dt><dd>${html(accountId)}</dd><dt>Client</dt><dd>${html(clientId)}</dd><dt>Resource</dt><dd>${html(resource)}</dd>${consentFields(requested,priorGranted,advertised,{stepUp})}<input type="hidden" name="consent" value="yes">${renewal}<button type="submit">Authorize requested scopes</button></form>`;
}
export function ignoreRefreshScope(body){
 if(body?.grant_type==='refresh_token')delete body.scope;
 return body;
}
export {refreshScopes};
/** Record a consent on an oidc-provider Grant. as.mjs lists the folio scopes as provider (OP) scopes, so the
 *  provider's op_scopes_missing check needs every requested OP scope granted or rejected at the OIDC level,
 *  not only on the resource; otherwise each consent re-prompts consent forever. Refused scopes (an unticked
 *  Real) are rejected at both levels so they are never granted and never re-prompt. */
export function applyConsentScopes(grant,{requested,granted,resource,opScopes,resourceScopes}){
 const refused=[...new Set(requested)].filter(x=>!granted.includes(x));
 grant.addOIDCScope(granted.filter(x=>opScopes.includes(x)).join(' '));
 grant.addResourceScope(resource,granted.filter(x=>resourceScopes.includes(x)).join(' '));
 const refusedOp=refused.filter(x=>opScopes.includes(x)),refusedRs=refused.filter(x=>resourceScopes.includes(x));
 if(refusedOp.length)grant.rejectOIDCScope(refusedOp.join(' '));
 if(refusedRs.length)grant.rejectResourceScope(resource,refusedRs.join(' '));
}

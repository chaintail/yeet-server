import {grantedSubset,refreshScopes} from '#scope-catalog';
import {html} from './auth-pages.mjs';
// Connecting YEET to ChatGPT is ONE screen (owner, 2026-11-13: "I just want to connect Google and then I'm instantly
// connected to ChatGPT... everything only ever happens inside ChatGPT"): the sign-in. After it the browser goes
// straight back to ChatGPT. The terms are accepted in the chat (core/terms.mjs, docs/TERMS-IN-CHAT.md), the win code
// is a card (yeet_referral), and nothing else sits between the sign-in and the redirect.
//
// The connect page below is what remains of the authorize step. It is shown only when the sign-in did not happen in
// this authorization (a browser that is already signed in to YEET: one deliberate press, "Connect", must exist for
// every authorization) or when the client is not ChatGPT. It shows no scope names, account ids or client URLs.
export const TERMS_URL='https://yeet.win/terms';
export const PRIVACY_URL='https://yeet.win/privacy';
/** UI owner renders this state. Every consent, including a plain reconnect, needs the explicit submit. */
export function consentSelection(requested, priorGranted=[]){
 return {prepare_requested:requested.includes('yeet:prepare')||requested.includes('yeet:trade'),requires_confirm:true};
}
export function submittedScopes(requested,body){
 if(body.consent!=='yes')throw Error('Explicit consent required');
 return grantedSubset(requested);
}
/**
 * The separate connect page is skipped only when all of these hold: the client is ChatGPT (its redirect URI is one of
 * ChatGPT's connector redirects, security-policy.mjs chatgptRedirect), and the person signed in on our page inside
 * THIS authorization (the interaction's binding carries that sign-in and its account). Anything else gets the page.
 */
export function skipsConnectPage({chatgpt,binding,accountId}){
 return chatgpt===true&&!!binding&&Number.isSafeInteger(binding.signedIn)&&binding.signedIn>0&&typeof accountId==='string'&&binding.account===accountId;
}
/** What ChatGPT will be able to do, in one sentence. No scope names. */
export const CONNECT_LEAD='ChatGPT will be able to see your YEET balance, coins, trades and XP, and prepare trades for you. Nothing trades until you confirm it yourself in the chat.';
/** The small legal line under the sign-in and on the connect page. */
export const legalLine=()=>`<p class="hint legal">See the <a href="${TERMS_URL}" target="_blank" rel="noopener">Terms</a> and <a href="${PRIVACY_URL}" target="_blank" rel="noopener">Privacy Policy</a>.</p>`;
/** How long ChatGPT stays connected (the refresh-token lifetime), as one small line. */
export function connectedFor(seconds){
 if(!Number.isSafeInteger(seconds)||seconds<=0)return '';
 const n=seconds%86400===0?`${seconds/86400} ${seconds===86400?'day':'days'}`:seconds%3600===0?`${seconds/3600} ${seconds===3600?'hour':'hours'}`:`${Math.round(seconds/60)} minutes`;
 return `<p class="hint">ChatGPT stays connected for up to ${n}, then asks you to connect again.</p>`;
}
/** The connect page exactly as as.mjs sends it (inside authDocument, title "Connect YEET to ChatGPT"). */
/** The connect page's sentence for a client of class agent (shared/agent-route.mjs). */
export const AGENT_CONNECT_LEAD='Your agent will be able to see the YEET budget you give it and trade with that budget by itself, with its own key. It can never reach your own wallet, and it can only send its budget back to you.';
export function consentForm({csrf,name,connectedSeconds=0,lead=CONNECT_LEAD}){
 const who=typeof name==='string'&&name?`<p class="lead">You are connecting as <strong>${html(name)}</strong>.</p>`:'';
 return `<form method="POST" data-yeet-connect><input type="hidden" name="csrf" value="${html(csrf)}">${who}<p>${lead}</p>${connectedFor(connectedSeconds)}${legalLine()}<input type="hidden" name="consent" value="yes"><button type="submit" name="decision" value="connect">Connect</button><button type="submit" name="decision" value="cancel" class="secondary">Cancel</button></form>`;
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

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
/** What each scope lets ChatGPT do, in plain words for the consent page. openid and offline_access are sign-in
 *  plumbing; they stay in the collapsed Details list only. */
export const SCOPE_WORDS=Object.freeze({
 'yeet:read':'See your YEET wallets, coins, trades and XP.',
 'yeet:write':'Get prices for trades and spin the daily wheel for you.',
 'yeet:trade':'Buy and sell coins with your YEET wallet, only after you tap YEET in the chat.',
});
/** Production consent fields: a plain list of what ChatGPT may do, the daily money line when trading is requested,
 *  and the raw scope names inside the collapsed Details element (consentForm). */
export function consentFields(requested,priorGranted=[]){
 const items=grantedSubset(requested).filter(s=>SCOPE_WORDS[s]).map(s=>`<li>${SCOPE_WORDS[s]}</li>`).join('');
 const trade=requested.includes('yeet:trade')?`<p class="limit">YEET can send up to ${html(dailyAllowance())} USDC a day from your YEET wallet, only when you tap YEET.</p>`:'';
 return `${items?`<p>ChatGPT will be able to:</p><ul class="can">${items}</ul>`:''}${trade}`;
}
/** The technical record behind the consent, collapsed by default. grantedSubset keeps only catalog scope names,
 *  so the scope list needs no escaping. */
export function consentDetails({accountId,clientId,resource,requested}){
 return `<details class="details"><summary>Details</summary><dl><dt>Your YEET account</dt><dd>${html(accountId)}</dd><dt>App asking for access</dt><dd>${html(clientId)}</dd><dt>YEET server</dt><dd>${html(resource)}</dd><dt>Scopes granted</dt><dd>${grantedSubset(requested).join(' ')}</dd></dl></details>`;
}
/** Five required agreements, then the optional product-email line. Plain text: there are no legal page URLs yet. */
export const AGREEMENTS=Object.freeze([
 ['agree_wallet','I agree to a YEET wallet created and secured by Privy.'],
 ['agree_chatgpt','I allow ChatGPT to use YEET for me with the access above.'],
 ['agree_near','I understand my trades are routed through NEAR Intents.'],
 ['agree_terms','I accept the YEET Terms of Service.'],
 ['agree_privacy','I accept the YEET Privacy Policy.'],
]);
export const EMAIL_CONSENT='product_email';
export function agreementFields(){
 return AGREEMENTS.map(([name,text])=>`<label><input type="checkbox" name="${name}" value="yes" required> ${text}</label>`).join('')
  +`<label><input type="checkbox" name="${EMAIL_CONSENT}" value="yes"> Send me YEET product emails (optional).</label>`;
}
/** Server-side check of the agreements; returns the optional email choice. */
export function requireAgreements(body){
 if(!AGREEMENTS.every(([name])=>body?.[name]==='yes'))throw Error('Required agreements missing');
 return {product_email:body[EMAIL_CONSENT]==='yes'};
}
/** The production consent form exactly as as.mjs sends it (inside authDocument). The button stays disabled
 *  until the required boxes are ticked (consent.js); the boxes are also `required` for browsers without scripts. */
export function consentForm({csrf,accountId,clientId,resource,requested,priorGranted=[],renewal=''}){
 return `<form method="POST" data-yeet-agreements><input type="hidden" name="csrf" value="${html(csrf)}"><p class="lead">ChatGPT wants to use your YEET account so you can trade from the chat.</p>${consentFields(requested,priorGranted)}<fieldset class="agreements"><legend>Please confirm</legend>${agreementFields()}${renewal}</fieldset>${consentDetails({accountId,clientId,resource,requested})}<input type="hidden" name="consent" value="yes"><button type="submit">Continue</button></form><script type="module" src="/account/consent.js"></script>`;
}
/** One screen after consent, before ChatGPT. There is no referral system: both buttons continue. */
export const REFERRAL_TITLE='Got a referral code?';
export function referralForm({csrf}){
 return `<form method="POST"><input type="hidden" name="csrf" value="${html(csrf)}"><input type="hidden" name="step" value="referral"><p>Type a friend's code, or keep WIN.</p><label for="referral_code">Referral code</label><div class="slots"><input id="referral_code" name="referral_code" value="WIN" maxlength="6" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="referral-rule"><span class="slot filled" aria-hidden="true">W</span><span class="slot filled" aria-hidden="true">I</span><span class="slot filled" aria-hidden="true">N</span><span class="slot" aria-hidden="true"></span><span class="slot" aria-hidden="true"></span><span class="slot" aria-hidden="true"></span></div><p class="hint" id="referral-rule">Up to 6 letters or numbers.</p><button type="submit" name="referral_action" value="win" class="brand">Let's win!</button><button type="submit" name="referral_action" value="skip" class="secondary">Skip</button></form>`;
}
/** The submitted code when "Let's win!" was pressed and it is 1-16 of A-Z0-9 (case folded); otherwise null. */
export function referralCode(body){
 if(body?.referral_action!=='win'||typeof body.referral_code!=='string')return null;
 const code=body.referral_code.trim().toUpperCase();
 return /^[A-Z0-9]{1,16}$/.test(code)?code:null;
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

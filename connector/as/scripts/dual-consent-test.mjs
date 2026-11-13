import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {allScopes,baseScopes,legacyScopes,refreshScopes,consentScopes,advertisedScopes,hasScope,expandScopes,canonicalScope} from '#scope-catalog';
import {consentSelection,consentForm,submittedScopes,ignoreRefreshScope,skipsConnectPage,CONNECT_LEAD,legalLine,connectedFor} from '../consent-selection.mjs';
import {termsBody} from '../terms-page.mjs';
import {termsObject,STATEMENTS} from '../../core/terms.mjs';
test('the scope catalog: three yeet scopes are advertised; yeet:trade is the old name of yeet:prepare and is still accepted',()=>{
 assert.deepEqual([...baseScopes],['yeet:read','yeet:write','yeet:prepare']);
 assert.deepEqual([...legacyScopes],['yeet:trade']);
 assert.deepEqual([...consentScopes],['openid','offline_access','yeet:read','yeet:write','yeet:prepare','yeet:trade']);
 assert.deepEqual(advertisedScopes(),['openid','offline_access','yeet:read','yeet:write','yeet:prepare'],'the old name is never advertised');
 assert.equal(canonicalScope('yeet:trade'),'yeet:prepare');
 // An old token reaches the tools that need yeet:prepare, and a new token is not refused where old code names the old scope.
 assert.equal(hasScope(['yeet:read','yeet:trade'],'yeet:prepare'),true);
 assert.equal(hasScope(['yeet:read','yeet:prepare'],'yeet:prepare'),true);
 assert.equal(hasScope(['yeet:read','yeet:prepare'],'yeet:trade'),true);
 assert.equal(hasScope(['yeet:read','yeet:write'],'yeet:prepare'),false);
 assert.deepEqual([...expandScopes(['yeet:trade'])].sort(),['yeet:prepare','yeet:trade']);
 assert.equal(consentSelection(allScopes).prepare_requested,true);
 assert.equal(consentSelection(['yeet:trade']).prepare_requested,true);
 assert.equal(consentSelection(['yeet:read']).prepare_requested,false);
 assert.deepEqual(submittedScopes([...allScopes,'other:x'],{consent:'yes'}),[...allScopes]);
 assert.throws(()=>submittedScopes(allScopes,{}),/Explicit consent/);
 // A stored grant under the old name refreshes unchanged.
 assert.deepEqual(refreshScopes(['yeet:read','yeet:trade','other:x']),['yeet:read','yeet:trade']);
 assert.deepEqual(ignoreRefreshScope({grant_type:'refresh_token',scope:allScopes.join(' '),refresh_token:'opaque'}),{grant_type:'refresh_token',refresh_token:'opaque'});
});
test('all deployed scope list imports use the one catalog; grant recording uses granted scope getters',()=>{
 // One shared introspection verifier and one AS scope list, both read from the catalog; no role keeps its own copy.
 assert.match(readFileSync(new URL('../../shared/introspection.mjs',import.meta.url),'utf8'),/from '#scope-catalog'/);
 assert.match(readFileSync(new URL('../scopes.mjs',import.meta.url),'utf8'),/from '#scope-catalog'/);
 assert.doesNotMatch(readFileSync(new URL('../../shared/common.mjs',import.meta.url),'utf8'),/scopes|Scopes|scope-catalog/);
 for(const svc of ['as','core','mcp'])for(const name of ['common.mjs','introspection.mjs'])
  assert.equal(existsSync(new URL(`../../${svc}/${name}`,import.meta.url)),false,`${svc}/${name}`);
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');assert.match(source,/grant.getResourceScope/);assert.doesNotMatch(source,/scopes: d.params.scope.split/);
});
test('the connect page: who is connecting, one true sentence, the session length, Terms and Privacy, Connect and Cancel; nothing else',()=>{
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(source,/authDocument\(r, promptTitle\(d\.prompt\.name\), consentForm\(\{/);
 const form=consentForm({csrf:'x',name:'Nimble Tapir 88',connectedSeconds:7*86400});
 assert.match(form,/You are connecting as <strong>Nimble Tapir 88<\/strong>\./);
 assert.ok(form.includes(CONNECT_LEAD));
 assert.equal(CONNECT_LEAD,'ChatGPT will be able to see your YEET balance, coins, trades and XP, and prepare trades for you. Nothing trades until you confirm it yourself in the chat.');
 assert.match(form,/ChatGPT stays connected for up to 7 days, then asks you to connect again\./);
 assert.match(form,/href="https:\/\/yeet\.win\/terms"/);assert.match(form,/href="https:\/\/yeet\.win\/privacy"/);
 assert.match(form,/<button type="submit" name="decision" value="connect">Connect<\/button><button type="submit" name="decision" value="cancel" class="secondary">Cancel<\/button>/);
 // No checkbox, no scope name, no account id, no client URL, no money limit, no "tap".
 assert.doesNotMatch(form,/checkbox|yeet:|yeet-privy-|client\.json|openid|USDC a day|50 USDC|\btap\b|only when|secured by Privy|<details/i);
 assert.doesNotMatch(form,/\bsign(ing|ature|ed)?\b/i);
 assert.match(consentForm({csrf:'<x>',name:'<b>'}),/value="&lt;x&gt;"[\s\S]*&lt;b&gt;/);
 assert.equal(connectedFor(0),'');assert.match(connectedFor(600),/up to 10 minutes/);
 assert.match(legalLine(),/Terms<\/a> and <a[^>]+>Privacy Policy<\/a>/);
});
test('the connect page is skipped only for ChatGPT and only when the person signed in on our page inside this authorization',()=>{
 const binding={account:'yeet-privy-a',signedIn:Date.now()};
 assert.equal(skipsConnectPage({chatgpt:true,binding,accountId:'yeet-privy-a'}),true);
 assert.equal(skipsConnectPage({chatgpt:false,binding,accountId:'yeet-privy-a'}),false,'any other client gets the page');
 assert.equal(skipsConnectPage({chatgpt:true,binding:{account:'yeet-privy-a'},accountId:'yeet-privy-a'}),false,'already signed in, no press in this authorization: the page asks');
 assert.equal(skipsConnectPage({chatgpt:true,binding,accountId:'yeet-privy-b'}),false,'another account');
 assert.equal(skipsConnectPage({chatgpt:true,binding:undefined,accountId:'yeet-privy-a'}),false);
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 // No screen between the sign-in and the redirect: no referral step, no agreement check, no pending consent.
 assert.doesNotMatch(source,/referralForm|requireAgreements|pendingConsent|REFERRAL_TITLE|renewable_consent/);
 assert.match(source,/noteSignIn\(d, id\);/);assert.match(source,/binding: takeSignIn\(d\)/);
 // The record is bound to this authorization request (client and PKCE challenge) and used once.
 assert.match(source,/d\.params\.code_challenge/);assert.match(source,/if \(key\) signedInHere\.delete\(key\);/);
});
test('the terms page: every statement of the current version with its link and a checkbox; required ones gate the button; the email line is optional',()=>{
 const page=termsBody({csrf:'x',terms:termsObject(null,{mode:'page',pageUrl:'https://chatgpt.yeet.win/account/terms'})});
 for(const s of STATEMENTS){
  assert.ok(page.includes(`name="agree_${s.id}" value="yes"${s.required?' required':''}>`),s.id);
  assert.ok(page.includes(`href="${s.url}"`),`${s.id}: its own link`);
 }
 assert.equal((page.match(/type="checkbox"/g)??[]).length,STATEMENTS.length);
 assert.doesNotMatch(page,/checked/,'nothing is ticked for the person');
 assert.match(page,/Send me YEET product emails\. \(optional\)/);
 assert.match(page,/<button type="submit">Accept<\/button>/);
 assert.match(termsBody({csrf:'x',terms:termsObject({accepted_at:Date.now()})}),/You accepted the YEET terms \(version \d{4}-\d{2}-\d{2}\)\./);
});
test('AS registers the yeet scopes and keeps the old name issuable',async()=>{
 const {issuableScopes}=await import('../scopes.mjs');assert.deepEqual([...issuableScopes],[...baseScopes,'yeet:trade']);
});

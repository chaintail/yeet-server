import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {allScopes,baseScopes,refreshScopes,consentScopes,advertisedScopes} from '#scope-catalog';
import {consentSelection,consentFields,consentForm,submittedScopes,ignoreRefreshScope} from '../consent-selection.mjs';
test('the scope catalog is exactly the three yeet scopes; submit alone persists the requested known subset',()=>{
 assert.deepEqual([...baseScopes],['yeet:read','yeet:write','yeet:trade']);
 assert.deepEqual([...consentScopes],['openid','offline_access','yeet:read','yeet:write','yeet:trade']);
 assert.deepEqual(advertisedScopes(),[...consentScopes]);
 assert.equal(consentSelection(allScopes).trade_requested,true);
 assert.equal(consentSelection(['yeet:read']).trade_requested,false);
 assert.deepEqual(submittedScopes([...allScopes,'other:x'],{consent:'yes'}),[...allScopes]);
 assert.throws(()=>submittedScopes(allScopes,{}),/Explicit consent/);
 assert.deepEqual(refreshScopes(['yeet:read','other:x']),['yeet:read']);
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

// Browser form submission: hidden inputs always post; a checkbox posts only when checked.
function submit(form,toggle={}){
 const body={};
 for(const [,attrs] of form.matchAll(/<input ([^>]*)>/g)){
  const attr=n=>attrs.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  const checked=toggle[attr('name')]??/\bchecked\b/.test(attrs);
  if(attr('type')==='checkbox'&&!checked)continue;
  body[attr('name')]=attr('value');
 }
 return body;
}
test('rendered production consent form lists the granted scopes and the daily allowance line only for trading',()=>{
 // as.mjs sends exactly consentForm(...) for the consent prompt; the test posts that same HTML.
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(source,/authDocument\(r, promptTitle\(d\.prompt\.name\), consentForm\(\{/);
 assert.doesNotMatch(source,/consentFields\(|name="consent"/);
 const requested=['openid','offline_access',...allScopes];
 const prior=process.env.YEET_DAILY_CAP_USDC;process.env.YEET_DAILY_CAP_USDC='40';
 try{
  const form=consentForm({csrf:'x',accountId:'yeet-privy-alice',clientId:'chatgpt',resource:'https://chatgpt.yeet.win',requested});
  assert.match(form,/Scopes granted<\/dt><dd>openid offline_access yeet:read yeet:write yeet:trade<\/dd>/);
  assert.match(form,/YEET can send up to 40 USDC a day from your YEET wallet, only when you tap ⚡ YEET\./);
  assert.doesNotMatch(form,/checked/);
  assert.equal(submit(form).csrf,'x');assert.equal(submit(form).consent,'yes');
  assert.deepEqual(submittedScopes(requested,submit(form)),requested);
  assert.doesNotMatch(consentFields(['openid','yeet:read']),/USDC/);
  process.env.YEET_DAILY_CAP_USDC='<b>';assert.match(consentFields(requested),/up to 50 USDC/);
 }finally{if(prior===undefined)delete process.env.YEET_DAILY_CAP_USDC;else process.env.YEET_DAILY_CAP_USDC=prior}
});
test('AS registers exactly the yeet scopes',async()=>{
 const {issuableScopes}=await import('../scopes.mjs');assert.deepEqual([...issuableScopes],[...baseScopes]);
});

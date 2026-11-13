import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Provider from 'oidc-provider';
import {allScopes,baseScopes} from '#scope-catalog';
import {applyConsentScopes,submittedScopes} from '../consent-selection.mjs';

// as.mjs configures the provider with the yeet scopes as OP scopes, so oidc-provider's
// consent prompt (op_scopes_missing) checks them against grant.getOIDCScopeEncountered().
const RESOURCE='https://chatgpt.yeet.win';
const opScopes=['openid','offline_access',...allScopes];
const provider=new Provider('https://as.test',{scopes:opScopes});
// Mirrors oidc-provider 9 lib/helpers/interaction_policy/prompts/consent.js op_scopes_missing / rs_scopes_missing.
const missing=(grant,requested)=>({
 op:requested.filter(s=>opScopes.includes(s)&&!grant.getOIDCScopeEncountered().split(' ').includes(s)),
 rs:requested.filter(s=>allScopes.includes(s)&&!grant.getResourceScopeEncountered(RESOURCE).split(' ').includes(s)),
});
const consent=(requested,body)=>{
 const grant=new provider.Grant({accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'});
 applyConsentScopes(grant,{requested,granted:submittedScopes(requested,body),resource:RESOURCE,opScopes,resourceScopes:allScopes});
 return grant;
};

test('consent loop: a consent without offline_access satisfies the provider consent prompt (no op_scopes_missing re-prompt)',()=>{
 const requested=['openid','yeet:write','yeet:read','yeet:prepare'];
 const grant=consent(requested,{consent:'yes'});
 assert.deepEqual(missing(grant,requested),{op:[],rs:[]});
 assert.deepEqual(grant.getResourceScope(RESOURCE).split(' ').sort(),[...baseScopes].sort());
});

test('consent loop: unknown requested scopes are rejected, not granted, and do not re-prompt',()=>{
 const requested=['openid','offline_access',...allScopes,'other:scope'];
 const grant=consent(requested,{consent:'yes'});
 assert.deepEqual(missing(grant,requested.filter(s=>s!=='other:scope')),{op:[],rs:[]});
 assert.equal(grant.getResourceScope(RESOURCE).split(' ').includes('other:scope'),false);
 assert.throws(()=>consent(requested,{}),/Explicit consent/);
});

test('as.mjs records consent through applyConsentScopes with the provider OP scope list',()=>{
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(source,/applyConsentScopes\(grant,/);
 assert.doesNotMatch(source,/addOIDCScope\(granted\.filter\(x => \["openid","offline_access"\]/);
});

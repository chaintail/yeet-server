// The sign-in and consent interaction pages for the two client classes: agent clients get the agent wording, ChatGPT keeps its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {promptTitle,agentAsk} from '../auth-pages.mjs';
import {consentForm,CONNECT_LEAD,AGENT_CONNECT_LEAD} from '../consent-selection.mjs';
test('ChatGPT class: titles and consent page are unchanged',()=>{
 const was=process.env.PRIVY_LOGIN;process.env.PRIVY_LOGIN='1';
 assert.equal(promptTitle('connect-login'),'Sign in to connect YEET to ChatGPT');
 assert.equal(promptTitle('consent'),'Connect YEET to ChatGPT');
 assert.equal(promptTitle('login'),'Sign in to YEET');
 process.env.PRIVY_LOGIN='0';assert.equal(promptTitle('connect-login'),'Sign in to connect YEET to ChatGPT (local)');
 if(was===undefined)delete process.env.PRIVY_LOGIN;else process.env.PRIVY_LOGIN=was;
 const form=consentForm({csrf:'x',name:'N'});
 assert.ok(form.startsWith('<form'));assert.ok(form.includes(CONNECT_LEAD));assert.doesNotMatch(form,/agent/i);
});
test('agent class: titles, who is asking, escaped name and loopback host:port',()=>{
 const was=process.env.PRIVY_LOGIN;process.env.PRIVY_LOGIN='1';
 assert.equal(promptTitle('connect-login',true),'Sign in to connect YEET to your agent');
 assert.equal(promptTitle('consent',true),'Connect YEET to your agent');
 if(was===undefined)delete process.env.PRIVY_LOGIN;else process.env.PRIVY_LOGIN=was;
 const ask=agentAsk('<b>Claude "Code"</b>','http://127.0.0.1:53682/callback');
 assert.match(ask,/A coding agent on this computer is asking to connect/);
 assert.ok(ask.includes('&lt;b&gt;Claude &quot;Code&quot;&lt;/b&gt;'));assert.doesNotMatch(ask,/<b>/);
 assert.ok(ask.includes('127.0.0.1:53682'));assert.ok(ask.includes('Only continue if you started this yourself.'));
 assert.doesNotMatch(ask,/ChatGPT/);
 const form=consentForm({csrf:'x',name:'N',lead:AGENT_CONNECT_LEAD,ask});
 assert.ok(form.startsWith(ask));assert.doesNotMatch(form,/ChatGPT/);
});
test('as.mjs passes the class to the sign-in page, the consent page and the login app',()=>{
 const src=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(src,/promptTitle\("connect-login", agent\)/);
 assert.match(src,/data-agent="1"/);
 assert.match(src,/\$\{ask\}<form method="POST" data-yeet-prompt="login">/);
 assert.match(readFileSync(new URL('../../login/src.jsx',import.meta.url),'utf8'),/dataset\.agent === "1"/);
});
// 2026-11-14: the agent consent page's Connect ended in a blank page (the card gone, only the stars) and no callback.
// The form's redirect chain ends at the agent's loopback callback, and form-action allowed only 'self' and chatgpt.com.
test('CSP form-action: agent-class pages allow the client\'s exact loopback callback origin; ChatGPT-class pages are unchanged',async()=>{
 const {interactionFormAction,CHATGPT_FORM_ACTION}=await import('../security-policy.mjs');
 const {privyPageCsp}=await import('../fund-page.mjs');
 const formAction=csp=>csp.split('; ').find(x=>x.startsWith('form-action ')).split(' ').slice(1);
 assert.equal(CHATGPT_FORM_ACTION,"'self' https://chatgpt.com");
 for(const uri of ['https://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com/connector/oauth/abc_123',undefined])
  assert.deepEqual(formAction(privyPageCsp('n',{formAction:interactionFormAction('chatgpt',uri),telegram:true})),["'self'",'https://chatgpt.com']);
 assert.deepEqual(formAction(privyPageCsp('n',{formAction:interactionFormAction('agent','http://127.0.0.1:35253/callback'),telegram:true})),["'self'",'http://127.0.0.1:35253']);
 assert.deepEqual(formAction(privyPageCsp('n',{formAction:interactionFormAction('agent','http://localhost:8976/oauth/callback?x=1')})),["'self'",'http://localhost:8976']);
 assert.deepEqual(formAction(privyPageCsp('n',{formAction:interactionFormAction('agent','http://127.0.0.1/cb')})),["'self'",'http://127.0.0.1']);
 // CSP has no IPv6 host syntax: an http://[::1] callback gets the http: scheme.
 assert.equal(interactionFormAction('agent','http://[::1]:4000/cb'),"'self' http:");
 // Never anything wider for a redirect an agent could not have registered.
 for(const uri of ['https://evil.example/cb','http://evil.example/cb',undefined,'not a url'])assert.equal(interactionFormAction('agent',uri),CHATGPT_FORM_ACTION);
});
test('as.mjs: the sign-in page and the consent page of an interaction both carry the client\'s form-action',()=>{
 const src=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(src,/function authDocument\(res, title, body, formAction = CHATGPT_FORM_ACTION\)/);
 assert.match(src,/privyPageCsp\(nonce, \{ formAction, telegram: true \}\)/);
 assert.match(src,/const formAction = interactionFormAction\(agent \? "agent" : "chatgpt", redirectUri\);/);
 const get=src.slice(src.indexOf('app.get("/interaction/:uid"'),src.indexOf('app.post("/interaction/:uid"'));
 assert.equal(get.match(/authDocument\(\s*r,\s*promptTitle\(/g).length,2);
 assert.match(get,/configuredRefreshWindow\(\) : 0,\n\s*\}\), formAction\),/,'consent page');
 assert.match(get,/\$\{legalLine\(\)\}<\/form>`,\n\s*formAction,\n\s*\),/,'sign-in page');
});
test('refusal for an unknown client or a link that is not valid names both ways in',async()=>{
 const {providerErrorPage,UNKNOWN_CLIENT_LINE}=await import('../auth-pages.mjs');
 assert.equal(UNKNOWN_CLIENT_LINE,'This sign-in link is not valid. Start again from ChatGPT or from your agent.');
 assert.ok(providerErrorPage('invalid_client').includes(`<p>${UNKNOWN_CLIENT_LINE}</p>`));
 const src=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(src,/const foreignClientBody = `<p>\$\{UNKNOWN_CLIENT_LINE\}<\/p>`;/);
 assert.doesNotMatch(src+providerErrorPage('x'),/Only ChatGPT can connect to YEET/);
});

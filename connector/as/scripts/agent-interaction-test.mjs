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

// The agent route's switch, client classes and refusal sentences (shared/agent-route.mjs), the registration policy
// (as/security-policy.mjs), the token class (shared/introspection.mjs validatePrincipal), the signing page with the
// switch off, and the agent MCP server's tool set (mcp/agent.mjs). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRouteOn,agentResource,agentRedirect,classOfRedirects,wrongRoute} from '../agent-route.mjs';
import {registrationRequest,clientClass,chatgptRedirect} from '../../as/security-policy.mjs';
import {validatePrincipal} from '../introspection.mjs';
import {AS,RESOURCE} from '../common.mjs';
import {signPageHtml,SIGN_TITLE} from '../../as/sign-page.mjs';
import {createAgentMcpServer,AGENT_TOOL_NAMES,HOW_IT_WORKS} from '../../mcp/agent.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const STABLE='https://chatgpt.com/connector_platform_oauth_redirect';
test('YEET_AGENT_ROUTE: off unless exactly on; anything unknown stops the service',()=>{
 assert.equal(agentRouteOn({}),false);assert.equal(agentRouteOn({YEET_AGENT_ROUTE:'off'}),false);assert.equal(agentRouteOn({YEET_AGENT_ROUTE:' ON '}),true);
 for(const v of ['1','yes','true','maybe'])assert.throws(()=>agentRouteOn({YEET_AGENT_ROUTE:v}),/Invalid YEET_AGENT_ROUTE/);
 assert.equal(agentResource({}),'https://mcp.yeet.win');
 assert.throws(()=>agentResource({AGENT_RESOURCE:RESOURCE}),/own host/);
 assert.throws(()=>agentResource({AGENT_RESOURCE:'https://mcp.yeet.win/?x=1'}),/Invalid AGENT_RESOURCE/);
});

test('client classes come from the redirect URIs alone: ChatGPT\'s, an agent\'s, or refused when mixed or not allowed',()=>{
 assert.equal(clientClass([STABLE]),'chatgpt');assert.equal(clientClass(['https://chatgpt.com/connector/oauth/abc_123']),'chatgpt');
 assert.equal(clientClass(['http://127.0.0.1:53682/callback']),'agent');assert.equal(clientClass(['http://localhost:3000/cb','http://[::1]:4000/cb']),'agent');
 assert.equal(clientClass(['https://agent.example/cb']),null,'https callbacks: any web site could pose as an agent');
 assert.equal(clientClass([STABLE,'http://127.0.0.1:1/cb']),null,'mixed');
 for(const u of ['https://agent.example/cb','http://agent.example/cb','myapp://cb','https://u:p@agent.example/cb','https://agent.example/cb#x'])assert.equal(agentRedirect(u),false,u);
 // a look-alike of ChatGPT's host is an agent, never chatgpt
 assert.equal(clientClass(['https://chatgpt.com.evil.example/connector_platform_oauth_redirect']),null);
 assert.equal(classOfRedirects([],chatgptRedirect),null);
});

test('registration: switch off, only ChatGPT\'s redirects (as before); on, an agent\'s too, never a mix',()=>{
 const body=uris=>({redirect_uris:uris});
 assert.ok(registrationRequest(body([STABLE])).body);
 assert.equal(registrationRequest(body(['http://127.0.0.1:1/cb'])).problem.error,'invalid_redirect_uri','off: refused as today');
 assert.equal(registrationRequest(body(['http://127.0.0.1:1/cb'])).problem.error_description,"only ChatGPT's connector redirect URIs can be registered");
 assert.ok(registrationRequest(body(['http://127.0.0.1:1/cb']),{agent:true}).body);
 assert.ok(registrationRequest(body([STABLE]),{agent:true}).body);
 assert.equal(registrationRequest(body([STABLE,'http://127.0.0.1:1/cb']),{agent:true}).problem.error,'invalid_redirect_uri');
 assert.equal(registrationRequest(body(['http://127.0.0.1:1/cb']),{agent:true,}).body.token_endpoint_auth_method,'none');
});

test('token class: off, every token is chatgpt and only the ChatGPT resource passes; on, the stamped class or the resource decides',()=>{
 const tok=extra=>({active:true,iss:AS,aud:RESOURCE,exp:Date.now()/1000+60,sub:'yeet-privy-abc',client_id:'c',scope:'yeet:read',...extra});
 assert.equal(validatePrincipal(tok({})).route,'chatgpt');
 assert.equal(validatePrincipal(tok({yeet_route:'agent'})).route,'chatgpt','off: the stamp is not read');
 assert.throws(()=>validatePrincipal(tok({aud:'https://mcp.yeet.win'})),/Invalid delegated principal/,'off: the agent resource is not valid');
 const on={YEET_AGENT_ROUTE:'on'};
 assert.equal(validatePrincipal(tok({aud:'https://mcp.yeet.win'}),on).route,'agent');
 assert.equal(validatePrincipal(tok({yeet_route:'agent'}),on).route,'agent','an agent token for the ChatGPT resource is still agent: the endpoint refuses it');
 assert.equal(validatePrincipal(tok({yeet_route:'chatgpt'}),on).route,'chatgpt');
 assert.throws(()=>validatePrincipal(tok({aud:'https://other.example'}),on),/Invalid delegated principal/);
});

test('WRONG_ROUTE: one sentence per direction, each naming the URL that is right',()=>{
 const a=wrongRoute('agent'),c=wrongRoute('chatgpt');
 assert.equal(a.error,'WRONG_ROUTE');assert.equal(a.correct_url,'https://mcp.yeet.win');assert.match(a.message,/^This is the ChatGPT version of YEET, installed in a coding agent\. Agents connect to https:\/\/mcp\.yeet\.win instead/);
 assert.equal(c.correct_url,RESOURCE);assert.match(c.message,/installed inside ChatGPT\. In ChatGPT, add YEET with /);
});

test('the signing page with the switch off opens trades only: an agent budget id is dropped, the title is the trade\'s',()=>{
 const page=signPageHtml({appId:'',tradeId:'a_aaaaaaaaaaaaaaaaaaaa',nonce:'n'});
 assert.match(page,/data-trade-id=""/);assert.ok(page.includes(`<h1>${SIGN_TITLE}</h1>`));
 assert.match(signPageHtml({appId:'',tradeId:'t_aaaaaaaaaaaaaaaaaaaa',nonce:'n'}),/data-trade-id="t_aaaaaaaaaaaaaaaaaaaa"/);
});

test('the agent MCP server: ten plain tools, no card metadata, refusals as JSON a model can relay',async()=>{
 const calls=[];
 const callCore=async(path,body)=>{calls.push([path,body]);if(path==='/agent/quote')throw {error:'LIMIT_EXCEEDED',message:'An agent trade is at most 10 USDC.',retryable:false,limits:{max_trade_usdc:'10'}};return {ok:true,path}};
 const server=createAgentMcpServer({token:{scope:'yeet:read yeet:write'},callCore});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
 const client=new Client({name:'t',version:'1'});await client.connect(b);
 const {tools}=await client.listTools();
 assert.deepEqual(tools.map(t=>t.name).sort(),[...AGENT_TOOL_NAMES].sort());assert.equal(tools.length,10);
 for(const t of tools){assert.equal(t._meta,undefined);assert.doesNotMatch(JSON.stringify(t),/openai\/|ui:\/\/|widget/)}
 assert.equal((await client.callTool({name:'agent_how_it_works',arguments:{}})).structuredContent.text,HOW_IT_WORKS);
 assert.deepEqual((await client.callTool({name:'agent_overview',arguments:{}})).structuredContent,{ok:true,path:'/agent/overview'});
 const q=await client.callTool({name:'agent_quote',arguments:{side:'buy',coins:['WIF'],amount_usdc:'20'}});
 assert.equal(q.isError,true);assert.deepEqual(JSON.parse(q.content[0].text),{error:'LIMIT_EXCEEDED',message:'An agent trade is at most 10 USDC.',retryable:false,limits:{max_trade_usdc:'10'}});
 // without yeet:prepare the trade tools refuse before reaching core
 const p=await client.callTool({name:'agent_prepare_trade',arguments:{quote_id:'p_aaaaaaaaaaaaaaaaaaaa'}});
 assert.equal(JSON.parse(p.content[0].text).error,'REAUTH_REQUIRED');assert.equal(calls.some(([path])=>path==='/agent/prepare'),false);
 await client.close();
});

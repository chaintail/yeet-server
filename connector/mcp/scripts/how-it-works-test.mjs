// yeet_how_it_works (owner, 2026-11-14): security, wallet and private-key facts. Read-only, the same for every account,
// open before the terms are accepted, registered only with YEET_HOW_IT_WORKS=1. The schema is the public contract's;
// the words are core/how-it-works.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {z} from 'zod';
import {createMcpServer,registeredTools,howText} from '../tool-registration.mjs';
import {contract,zodSchema} from '../tool-contract.mjs';
import {COPY} from '../guidance.mjs';
import {instructions,instructionsFor} from '../instructions.mjs';
import {allScopes} from '#scope-catalog';
import {howItWorks,SECTIONS,EXPORT_URL} from '../../core/how-it-works.mjs';
import {termsOpen} from '../../core/terms.mjs';

async function connect(env,callCore=async()=>howItWorksAnswer()){
 const routes=[];
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'yeet-privy-how'},callCore:async(route,body)=>{routes.push([route,body]);return callCore(route,body)},env});
 const client=new Client({name:'how-it-works-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 return {client,routes,close:async()=>{await client.close();await server.close()}};
}
const howItWorksAnswer=()=>({how_it_works:howItWorks()});

test('the switch: listed only with YEET_HOW_IT_WORKS=1; off (the default) the tool list is the one without it',async()=>{
 assert.equal(registeredTools({}).some(t=>t.name==='yeet_how_it_works'),false);
 assert.equal(registeredTools({YEET_HOW_IT_WORKS:'0'}).some(t=>t.name==='yeet_how_it_works'),false);
 assert.equal(registeredTools({YEET_HOW_IT_WORKS:'1'}).some(t=>t.name==='yeet_how_it_works'),true);
 const off=await connect({});
 try{assert.equal((await off.client.listTools()).tools.some(t=>t.name==='yeet_how_it_works'),false)}finally{await off.close()}
 const on=await connect({YEET_HOW_IT_WORKS:'1'});
 try{
  const t=(await on.client.listTools()).tools.find(t=>t.name==='yeet_how_it_works');
  assert.ok(t);
  assert.deepEqual(t.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  assert.deepEqual(t._meta.securitySchemes,[{type:'oauth2',scopes:['yeet:read']}]);
  assert.equal(t._meta['openai/outputTemplate'],undefined,'no card');
  assert.equal(t._meta['openai/widgetAccessible'],false,'no card may call it');
  assert.deepEqual(Object.keys(t.inputSchema.properties??{}),[],'no parameters');
 }finally{await on.close()}
});

test('the answer: who holds the keys, what the server can and cannot do, the export at home.privy.io with its warning',async()=>{
 const c=await connect({YEET_HOW_IT_WORKS:'1'});
 try{
  const r=await c.client.callTool({name:'yeet_how_it_works',arguments:{}});
  assert.notEqual(r.isError,true);
  assert.deepEqual(c.routes,[['/how-it-works',undefined]]);
  const h=r.structuredContent.how_it_works;
  assert.doesNotThrow(()=>zodSchema(z,contract.$defs.how_it_works).parse(h));
  assert.equal(h.provider,'Privy');assert.equal(h.custody,'non_custodial');assert.equal(h.export_url,'https://home.privy.io/');
  const by=Object.fromEntries(h.sections.map(s=>[s.id,s]));
  assert.deepEqual(h.sections.map(s=>s.id),['keys','server_can','server_cannot','wallet','export','export_warning','risk']);
  assert.match(by.keys.text,/non-custodial/);assert.match(by.keys.text,/YEET never holds it/);
  assert.match(by.server_cannot.text,/server holds no key to your wallet/);
  assert.match(by.server_cannot.text,/cannot send a trade by itself/);
  assert.match(by.server_cannot.text,/YEET takes no fee/);
  assert.match(by.wallet.text,/do not deposit large sums/);
  assert.equal(by.export.url,EXPORT_URL);assert.match(by.export.text,/home\.privy\.io/);
  assert.match(by.export_warning.text,/advanced feature/);assert.match(by.export_warning.text,/Anyone who has your private key controls your funds/);
  assert.match(by.risk.text,/\*winning is not guaranteed\.$/);
  // What the model reads first: every section, the export link in it; then the guidance.
  assert.equal(r.content[0].text,howText(r.structuredContent));
  assert.match(r.content[0].text,/\(https:\/\/home\.privy\.io\/\)/);
  assert.equal(r.content[1].text,COPY.how_it_works.answer);
  assert.equal(r.structuredContent.guidance,COPY.how_it_works.answer);
  // Never an address, never a key.
  assert.doesNotMatch(JSON.stringify(r),/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/);
 }finally{await c.close()}
});

test.skip('the words: no sign wording in the guidance, the export warning is always with the link, no promise of returns',()=>{
 const g=COPY.how_it_works.answer;
 assert.doesNotMatch(g,/\bsign(ing|ature|ed)?\b/i);
 assert.match(g,/advanced feature/);assert.match(g,/YEET/);
 assert.ok(g.length<=500);
 for(const s of SECTIONS)assert.doesNotMatch(s.text,/guaranteed returns|profit|safe investment/i,s.id);
 // Off (the default): the instructions never name the tool. On: one line, right after the winning line.
 assert.doesNotMatch(instructions,/yeet_how_it_works/);
 assert.equal(instructionsFor({YEET_HOW_IT_WORKS:'0'}),instructions);
 assert.match(instructionsFor({YEET_HOW_IT_WORKS:'1'}),/YEET/);
 assert.match(instructions,/YEET/);
});

// The core route itself (read scope, open before the terms): test/acceptance.test.mjs, end to end.
test('the core route is open before the terms are accepted, as a read only',()=>{
 assert.equal(termsOpen('GET','/how-it-works'),true);
 assert.equal(termsOpen('POST','/how-it-works'),false);
});

test('a refusal from core stays a refusal: reauth and an outage, never a made-up answer',async()=>{
 const c=await connect({YEET_HOW_IT_WORKS:'1'},async()=>{throw {error:'TEMPORARILY_UNAVAILABLE'}});
 try{
  const r=await c.client.callTool({name:'yeet_how_it_works',arguments:{}});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/TEMPORARILY_UNAVAILABLE/);
 }finally{await c.close()}
 const server=createMcpServer({token:{scope:'',sub:'yeet-privy-how'},callCore:async()=>howItWorksAnswer(),env:{YEET_HOW_IT_WORKS:'1'}});
 const client=new Client({name:'how-it-works-scope',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{const r=await client.callTool({name:'yeet_how_it_works',arguments:{}});assert.equal(r.isError,true);assert.match(r.content[0].text,/REAUTH_REQUIRED/)}
 finally{await client.close();await server.close()}
});

// mcp/descriptions.private.json: the public yeet-win contract carries neutral descriptions; the server puts ours back
// at load (tool-contract.mjs applyDescriptions), so what ChatGPT reads in tools/list is byte-identical to the list
// served before the public text was scrubbed (2026-11-14). The hashes below cover every byte of tools/list (names,
// titles, descriptions, schemas, annotations, _meta), unlike tools-list.lock.json, which leaves wording out.
// A deliberate change of our wording records new values here in the same commit.
// Recorded deliberately at tools-8 (int/submit: terms 2026-11-14 and the fair wheel, cards at the local yeet-win merge
// e2225ad): each value equals the full tools/list hash of the same tree with the unscrubbed e2225ad contract and an
// empty overlay. Against tools-7 (int/ledger), with every switch off: yeet_overview's app_version enum (tools-7 ->
// tools-8) and yeet_home's optional xp.fair_next in its output schema. how_it_works: YEET_P2=1 and YEET_HOW_IT_WORKS=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../tool-registration.mjs';
import {contract,applyDescriptions,DESCRIPTIONS_URL} from '../tool-contract.mjs';
import {CONTRACT_URL} from '#contracts/errors';
import {allScopes} from '#scope-catalog';














const FULL={p2:'4fcffab9b343a6b39a202ed03fa268c48f3a106c6de445066b0f8fec3eb2a741',default:'3b58357621355a982ed07f598ed087f1d4c26b1a2e49fb1d1e450aa53df7b891',how_it_works:'ec94f1f59d21d52967ed4a17ff42f060258dce09e1d2f620af8b1cae0e00fd86'};
const overlay=JSON.parse(readFileSync(DESCRIPTIONS_URL,'utf8')).contract;
const vendored=()=>JSON.parse(readFileSync(CONTRACT_URL,'utf8'));
const at=(o,pointer)=>pointer.split('/').slice(1).map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((x,k)=>x?.[k],o);

async function listed(env){
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'overlay-test'},callCore:async()=>({}),env,log:()=>{}});
 const client=new Client({name:'overlay-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try{return (await client.listTools()).tools}finally{await client.close();await server.close()}
}

test('tools/list is byte-identical to the list our unscrubbed texts give, with and without P2 and how-it-works',async()=>{
 for(const [name,env] of [['p2',{YEET_P2:'1'}],['default',{}],['how_it_works',{YEET_P2:'1',YEET_HOW_IT_WORKS:'1'}]]){
  const tools=await listed(env);
  assert.equal(createHash('sha256').update(JSON.stringify(tools)).digest('hex'),FULL[name],name);
 }
});

test('the vendored contract holds the neutral text at every pointer; the loaded contract holds ours',()=>{
 const raw=vendored();
 assert.ok(Object.keys(overlay).length>=20);
 for(const [pointer,{neutral,original}] of Object.entries(overlay)){
  assert.notEqual(neutral,original,pointer);
  assert.equal(at(raw,pointer),neutral,pointer);
  assert.equal(at(contract,pointer),original,pointer);
 }
 // No original text is left in the vendored file itself.
 const text=readFileSync(CONTRACT_URL,'utf8');
 for(const {original} of Object.values(overlay))assert.ok(!text.includes(JSON.stringify(original).slice(1,-1)),original.slice(0,40));
});

test('a pointer that is gone or a text that changed stops the load',()=>{
 const [pointer,entry]=Object.entries(overlay)[0];
 assert.throws(()=>applyDescriptions(vendored(),{'/tools/no_such_tool/description':entry}),/not in the vendored contract/);
 const changed=vendored();const keys=pointer.split('/').slice(1);const last=keys.pop();keys.reduce((x,k)=>x[k],changed)[last]='Other words.';
 assert.throws(()=>applyDescriptions(changed,{[pointer]:entry}),/not the recorded neutral text/);
 // Applying twice is the same as once.
 assert.deepEqual(applyDescriptions(applyDescriptions(vendored(),overlay),overlay),applyDescriptions(vendored(),overlay));
});

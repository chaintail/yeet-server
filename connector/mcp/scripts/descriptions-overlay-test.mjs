// mcp/descriptions.private.json: the public yeet-win contract carries neutral descriptions; the server puts ours back
// at load (tool-contract.mjs applyDescriptions), so what ChatGPT reads in tools/list is byte-identical to the list
// served before the public text was scrubbed (2026-11-14). The hashes below cover every byte of tools/list (names,
// titles, descriptions, schemas, annotations, _meta), unlike tools-list.lock.json, which leaves wording out.
// A deliberate change of our wording records new values here in the same commit.
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

const FULL={p2:'62665eac506c8d708057e85151da96a5e27f716b952e58df9a351e22dd6b69fc',default:'ba61b5b82f1826a38445f4be177022deca1653fdddc7aca36f34945e81ebebdd'};
const overlay=JSON.parse(readFileSync(DESCRIPTIONS_URL,'utf8')).contract;
const vendored=()=>JSON.parse(readFileSync(CONTRACT_URL,'utf8'));
const at=(o,pointer)=>pointer.split('/').slice(1).map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~')).reduce((x,k)=>x?.[k],o);

async function listed(env){
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'overlay-test'},callCore:async()=>({}),env,log:()=>{}});
 const client=new Client({name:'overlay-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 try{return (await client.listTools()).tools}finally{await client.close();await server.close()}
}

test('tools/list is byte-identical to the list before the public scrub, with and without P2',async()=>{
 for(const [name,env] of [['p2',{YEET_P2:'1'}],['default',{}]]){
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

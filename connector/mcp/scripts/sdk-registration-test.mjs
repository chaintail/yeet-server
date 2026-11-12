import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer,TOOLS} from '../tool-registration.mjs';
import {HOME_UI_URI,BASKET_UI_URI,RECEIPT_UI_URI,CONFIRM_META_KEY,TEMPLATE_MIME} from '../widgets.mjs';
import {allScopes} from '#scope-catalog';
import {instructions} from '../instructions.mjs';

const P0=['execute_trade','trade_status','yeet_coins','yeet_home','yeet_propose','yeet_quote'];
const coins={coins:[{symbol:'WIF',name:'dogwifhat',kind:'meme',price_usd:null}],limits:{min_leg_usdc:'3',max_trade_usdc:'25',max_legs:5,default_usdc:'20'}};
const proposal={proposal_id:'p_abcdefghij0123456789',revision:1,direction:'yeet',amount_usdc:'20',legs:[{symbol:'WIF',parts:10,amount_in:'20',est_out:'7.1',est_out_usd:'19.4',min_out:'7'}],totals:{in_usd:'20',out_usd:'19.4',cost_pct:3,time_estimate_s:40},quoted_at:'2026-11-12T00:00:00Z',warnings:[],next:'Tap ⚡ YEET in the card'};
async function connect(token,callCore){
 const server=createMcpServer({token,callCore});
 const client=new Client({name:'offline-contract-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 return {client,server,close:async()=>{await client.close();await server.close()}};
}

test('tools/list: the six P0 tools with annotations, scopes, cards and visibility from plan 2.2',async()=>{
 const {client,close}=await connect({scope:allScopes.join(' ')},async()=>{throw {error:'TEMPORARILY_UNAVAILABLE'}});
 try{
  const {tools}=await client.listTools();const by=Object.fromEntries(tools.map(t=>[t.name,t]));
  assert.deepEqual(tools.map(t=>t.name).sort(),P0);
  for(const t of tools){assert.equal(t.outputSchema.type,'object');assert.equal(t.inputSchema.type,'object');assert.ok(t.title&&t.description)}
  const scope=n=>by[n]._meta.securitySchemes[0];
  assert.deepEqual(Object.fromEntries(P0.map(n=>[n,scope(n).scopes[0]])),{execute_trade:'yeet:trade',trade_status:'yeet:read',yeet_coins:'yeet:read',yeet_home:'yeet:read',yeet_propose:'yeet:write',yeet_quote:'yeet:write'});
  for(const n of P0)assert.equal(scope(n).type,'oauth2');
  for(const n of ['yeet_home','yeet_coins','trade_status'])assert.equal(by[n].annotations.readOnlyHint,true,n);
  for(const n of ['yeet_propose','yeet_quote'])assert.deepEqual(by[n].annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},n);
  assert.deepEqual(by.execute_trade.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true});
  const template=Object.fromEntries(tools.map(t=>[t.name,t._meta?.['openai/outputTemplate']]));
  assert.deepEqual(template,{yeet_home:HOME_UI_URI,yeet_coins:undefined,yeet_propose:BASKET_UI_URI,yeet_quote:BASKET_UI_URI,execute_trade:RECEIPT_UI_URI,trade_status:RECEIPT_UI_URI});
  for(const t of tools)assert.equal(t._meta?.ui?.resourceUri,template[t.name]);
  const access=Object.fromEntries(tools.map(t=>[t.name,t._meta?.['openai/widgetAccessible']]));
  assert.deepEqual(access,{yeet_home:true,yeet_coins:undefined,yeet_propose:true,yeet_quote:true,execute_trade:true,trade_status:true});
  // execute_trade is card-only: hidden from the model, callable by the app.
  assert.equal(by.execute_trade._meta['openai/visibility'],'private');
  assert.deepEqual(by.execute_trade._meta.ui.visibility,['app']);
  for(const n of P0.filter(n=>n!=='execute_trade')){assert.equal(by[n]._meta['openai/visibility'],undefined,n);assert.equal(by[n]._meta.ui?.visibility,undefined,n)}
  assert.deepEqual(TOOLS.map(t=>t.name).sort(),P0);
 }finally{await close()}
});

test('server info and instructions are YEET (plan 2.4)',async()=>{
 const {client,close}=await connect({scope:''},async()=>({}));
 try{
  assert.equal(client.getServerVersion().name,'yeet');
  assert.equal(client.getInstructions(),instructions);
  assert.match(instructions,/YEET/);
  assert.match(instructions,/YEET/);
 }finally{await close()}
});

test('resources: the three card templates are served with the app MIME type and a script',async()=>{
 const {client,close}=await connect({scope:allScopes.join(' ')},async()=>({}));
 try{
  const {resources}=await client.listResources();
  assert.deepEqual(resources.map(r=>r.uri).sort(),[BASKET_UI_URI,HOME_UI_URI,RECEIPT_UI_URI].sort());
  for(const r of resources){
   const {contents:[c]}=await client.readResource({uri:r.uri});
   assert.equal(c.mimeType,TEMPLATE_MIME);assert.match(c.text,/<script>/);assert.ok(c.text.length<300_000);
   assert.deepEqual(c._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
  }
 }finally{await close()}
});

test('yeet_coins returns the core catalogue; stubbed tools return a typed TEMPORARILY_UNAVAILABLE',async()=>{
 const routes=[];
 const {client,close}=await connect({scope:allScopes.join(' ')},async(route,body)=>{routes.push([route,body]);if(route==='/coins')return coins;throw {error:'TEMPORARILY_UNAVAILABLE'}});
 try{
  const ok=await client.callTool({name:'yeet_coins',arguments:{}});assert.equal(ok.isError,undefined);assert.deepEqual(ok.structuredContent,coins);
  const calls={yeet_home:{},yeet_propose:{request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]},yeet_quote:{proposal_id:proposal.proposal_id},execute_trade:{proposal_id:proposal.proposal_id,revision:1,confirm:'a'.repeat(43)},trade_status:{trade_id:'t_abcdefghij0123456789'}};
  for(const [name,args] of Object.entries(calls)){
   const r=await client.callTool({name,arguments:args});
   assert.equal(r.isError,true,name);
   assert.deepEqual(JSON.parse(r.content[0].text),{error:'TEMPORARILY_UNAVAILABLE',message:'YEET is temporarily unavailable. Try again shortly.',retryable:true},name);
  }
  assert.deepEqual(routes.map(([r])=>r),['/coins','/home','/proposals',`/proposals/${proposal.proposal_id}/quote`,'/trades','/trades/t_abcdefghij0123456789']);
  assert.deepEqual(routes[3][1],{});assert.equal(routes[1][1],undefined);assert.equal(routes[5][1],undefined);
 }finally{await close()}
});

test('the confirm code reaches only the card _meta, never structuredContent or content',async()=>{
 const confirm={code:'C'.repeat(43),expires_at:'2026-11-12T00:02:00Z'};
 const {client,close}=await connect({scope:allScopes.join(' ')},async()=>({...proposal,confirm}));
 try{
  const r=await client.callTool({name:'yeet_propose',arguments:{request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}});
  assert.equal(r.isError,undefined);assert.deepEqual(r.structuredContent,proposal);
  assert.deepEqual(r._meta[CONFIRM_META_KEY],confirm);
  assert.doesNotMatch(JSON.stringify(r.content)+JSON.stringify(r.structuredContent),/CCCC/);
 }finally{await close()}
});

test('a missing scope gives REAUTH_REQUIRED with the insufficient_scope _meta and never reaches core',async()=>{
 const routes=[];const token={scope:''};
 const {client,close}=await connect(token,async route=>{routes.push(route);return coins});
 try{
  for(const [name,scope,args] of [['yeet_coins','yeet:read',{}],['yeet_propose','yeet:write',{request_id:'r',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}],['execute_trade','yeet:trade',{proposal_id:proposal.proposal_id,revision:1,confirm:'a'.repeat(43)}]]){
   token.scope=allScopes.filter(s=>s!==scope).join(' ');
   const r=await client.callTool({name,arguments:args});
   assert.equal(JSON.parse(r.content[0].text).error,'REAUTH_REQUIRED',name);
   assert.equal(r._meta['mcp/www_authenticate'][0],'Bearer error="insufficient_scope", scope="openid offline_access yeet:read yeet:write yeet:trade"');
  }
  assert.deepEqual(routes,[]);
 }finally{await close()}
});

test('core output that does not fit the contract becomes TEMPORARILY_UNAVAILABLE',async()=>{
 const {client,close}=await connect({scope:allScopes.join(' ')},async()=>({coins:'not a list'}));
 try{const r=await client.callTool({name:'yeet_coins',arguments:{}});assert.equal(JSON.parse(r.content[0].text).error,'TEMPORARILY_UNAVAILABLE')}finally{await close()}
});

test('authentication distinguishes AS uncertainty from a revoked bearer without exposing causes',async()=>{
 const {authenticate}=await import('../authenticate.mjs');
 const validate=token=>{if(!token.active)throw Error('revoked')};
 assert.deepEqual(await authenticate('token',{introspect:async()=>{throw Error('private AS stalled')},validate}),{status:503,error:'temporarily_unavailable'});
 assert.deepEqual(await authenticate('token',{introspect:async()=>({active:false}),validate}),{status:401,error:'invalid_token'});
 assert.deepEqual(await authenticate('token',{introspect:async()=>({active:true}),validate}),{token:{active:true}});
});

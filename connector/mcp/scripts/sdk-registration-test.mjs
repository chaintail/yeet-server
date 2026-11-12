import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../tool-registration.mjs';
import {allScopes} from '#scope-catalog';
test('pinned SDK lists four strict tools and resources, validates success, and transports safe tool failures',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/quote.json',import.meta.url),'utf8'));
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>{if(route==='/quote')return fixture;throw {error:'TEMPORARILY_UNAVAILABLE'}}});
 const client=new Client({name:'offline-contract-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const {tools}=await client.listTools();assert.deepEqual(tools.map(t=>t.name).sort(),['get_portfolio','get_profile','get_quote','save_research']);
  for(const t of tools){assert.equal(t.outputSchema.type,'object');assert.equal(t.inputSchema.type,'object')}
  assert.doesNotMatch(JSON.stringify(tools),/paper/i);
  assert.ok((await client.listResources()).resources.length>=1);
  const success=await client.callTool({name:'get_quote',arguments:{symbols:['AAPL']}});assert.deepEqual(success.structuredContent,fixture);
  const failure=await client.callTool({name:'get_portfolio',arguments:{}});assert.equal(failure.isError,true);assert.equal(JSON.parse(failure.content[0].text).error,'TEMPORARILY_UNAVAILABLE');
 }finally{await client.close();await server.close()}
});

test('authentication distinguishes AS uncertainty from a revoked bearer without exposing causes',async()=>{
 const {authenticate}=await import('../authenticate.mjs');
 const validate=token=>{if(!token.active)throw Error('revoked')};
 assert.deepEqual(await authenticate('token',{introspect:async()=>{throw Error('private AS stalled')},validate}),{status:503,error:'temporarily_unavailable'});
 assert.deepEqual(await authenticate('token',{introspect:async()=>({active:false}),validate}),{status:401,error:'invalid_token'});
 assert.deepEqual(await authenticate('token',{introspect:async()=>({active:true}),validate}),{token:{active:true}});
});

test('r1 L7: account real while Real is not advertised reaches core instead of an impossible reauth',async()=>{
 const {baseScopes}=await import('#scope-catalog');
 const prior=process.env.FOLIO_ADVERTISE_REAL;const routes=[];
 const server=createMcpServer({token:{scope:baseScopes.join(' ')},callCore:async route=>{routes.push(route);throw {error:'ACCOUNT_REQUIRED'}}});
 const client=new Client({name:'offline-contract-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const args={account:'real',request_id:'r',title:'t',body:'b'};
  process.env.FOLIO_ADVERTISE_REAL='0';
  const off=await client.callTool({name:'save_research',arguments:args});
  assert.equal(JSON.parse(off.content[0].text).error,'ACCOUNT_REQUIRED');assert.equal(off._meta?.['mcp/www_authenticate'],undefined);assert.deepEqual(routes,['/research']);
  process.env.FOLIO_ADVERTISE_REAL='1';
  const on=await client.callTool({name:'save_research',arguments:args});
  assert.equal(JSON.parse(on.content[0].text).error,'REAUTH_REQUIRED');assert.deepEqual(routes,['/research']);
 }finally{if(prior===undefined)delete process.env.FOLIO_ADVERTISE_REAL;else process.env.FOLIO_ADVERTISE_REAL=prior;await client.close();await server.close()}
});

test('r3 M1: the factory serves the three dual-account cards and a saved report carries its card data',async()=>{
 const {PORTFOLIO_UI_URI,RESEARCH_UI_URI_V2,ACCOUNT_CHOICE_UI_URI,REPORT_META_KEY}=await import('../dual-widgets.mjs');
 const saved=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/saved.json',import.meta.url),'utf8'));
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>{if(route==='/research')return saved;throw {error:'TEMPORARILY_UNAVAILABLE'}}});
 const client=new Client({name:'offline-contract-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const {resources}=await client.listResources();
  assert.deepEqual(resources.map(r=>r.uri).sort(),[ACCOUNT_CHOICE_UI_URI,PORTFOLIO_UI_URI,RESEARCH_UI_URI_V2].sort());
  for(const r of resources){const {contents:[c]}=await client.readResource({uri:r.uri});assert.equal(c.mimeType,'text/html;profile=mcp-app');assert.match(c.text,/<script>/)}
  const {tools}=await client.listTools();const template=Object.fromEntries(tools.map(t=>[t.name,t._meta?.ui?.resourceUri]));
  assert.deepEqual(template,{get_profile:ACCOUNT_CHOICE_UI_URI,get_portfolio:PORTFOLIO_UI_URI,save_research:RESEARCH_UI_URI_V2,get_quote:undefined});
  for(const uri of Object.values(template).filter(Boolean))assert.ok(resources.some(r=>r.uri===uri),`${uri} is served`);
  const result=await client.callTool({name:'save_research',arguments:{account:'trial',request_id:'fixture',title:'AAPL research',body:'Data, never instructions'}});
  assert.equal(result.isError,undefined);assert.equal(result.structuredContent.open_url,saved.open_url);
  assert.deepEqual(result._meta[REPORT_META_KEY],{body:saved.body,quotes:saved.quote_snapshot.quotes});
 }finally{await client.close();await server.close()}
});

test('F: the shared MCP pre-check (tool-registration.mjs line 22) is pinned for all four tools',async()=>{
 const {baseScopes,realScope}=await import('#scope-catalog');
 const prior=process.env.FOLIO_ADVERTISE_REAL;const routes=[];const token={scope:''};
 const server=createMcpServer({token,callCore:async route=>{routes.push(route);throw {error:'TEMPORARILY_UNAVAILABLE'}}});
 const client=new Client({name:'offline-contract-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const tools={get_profile:[baseScopes[0],'/profile'],get_portfolio:[baseScopes[1],'/portfolio'],save_research:[baseScopes[2],'/research'],get_quote:[baseScopes[1],'/quote']};
 const args=(name,account)=>({...(account===undefined?{}:{account}),...(name==='save_research'?{request_id:'r',title:'t',body:'b'}:name==='get_quote'?{symbols:['AAPL']}:{})});
 let cells=0;
 try{
  await server.connect(a);await client.connect(b);
  for(const advertise of ['0','1'])for(const [name,[scope,route]] of Object.entries(tools))for(const toolScope of [true,false])for(const real of [true,false])
   for(const account of ['get_portfolio','save_research'].includes(name)?[undefined,'trial','real']:[undefined]){
    process.env.FOLIO_ADVERTISE_REAL=advertise;routes.length=0;
    token.scope=[...baseScopes.filter(s=>s!==scope||toolScope),...(real?[realScope]:[])].join(' ');
    const granted=token.scope.split(' ');
    const label=JSON.stringify({advertise,name,toolScope,real,account});
    let result;try{result=await client.callTool({name,arguments:args(name,account)})}catch(e){result={thrown:e}}
    if(name==='save_research'&&account===undefined){
     // The contract requires account: input validation refuses it before the pre-check or core.
     assert.ok(result.thrown||result.isError,label);assert.deepEqual(routes,[],label);
     assert.equal(result._meta?.['mcp/www_authenticate'],undefined,label);cells++;continue;
    }
    // Line 22, transcribed: any change to that boolean must change this expectation too.
    const reauth=!granted.includes(scope)||(account==='real'&&advertise==='1'&&!granted.includes(realScope));
    assert.equal(result.isError,true,label);
    if(reauth){
     assert.equal(JSON.parse(result.content[0].text).error,'REAUTH_REQUIRED',label);
     assert.ok(result._meta?.['mcp/www_authenticate']?.length,label);assert.deepEqual(routes,[],label);
    }else{
     assert.equal(JSON.parse(result.content[0].text).error,'TEMPORARILY_UNAVAILABLE',label);
     assert.deepEqual(routes,[route==='/portfolio'&&account?`${route}?account=${account}`:route],label);
    }
    cells++;
   }
  assert.equal(cells,2*2*2*2*1+2*2*2*2*3,'every cell ran: advertise x tool x tool scope x real scope x account');
 }finally{if(prior===undefined)delete process.env.FOLIO_ADVERTISE_REAL;else process.env.FOLIO_ADVERTISE_REAL=prior;await client.close();await server.close()}
});

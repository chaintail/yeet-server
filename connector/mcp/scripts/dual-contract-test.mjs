import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {z} from 'zod';
import {toolSchemas,zodSchema,contract} from '../tool-contract.mjs';
import {toolError,accountError} from '../errors.mjs';
import {instructions,descriptions} from '../instructions.mjs';
import {allScopes} from '#scope-catalog';
test('every published schema has a top-level object, resolved references, and only four tools',()=>{
 assert.deepEqual(Object.keys(toolSchemas),['get_profile','get_portfolio','save_research','get_quote']);
 for(const schema of Object.values(toolSchemas)){
  assert.equal(schema.output.type,'object');assert.doesNotMatch(JSON.stringify(schema),/\$ref/);assert.equal(schema.input.additionalProperties,false);
 }
});
test('fixtures validate against frozen outputs including every error, empty/unknown Real and saved snapshot',()=>{
 const root=new URL('../../../contracts/fixtures/',import.meta.url);
 for(const name of readdirSync(root)){
  const value=JSON.parse(readFileSync(new URL(name,root),'utf8'));
  const schema=name.startsWith('error-')?contract.$defs.failure:toolSchemas[name==='saved.json'?'save_research':name==='quote.json'?'get_quote':'get_portfolio'].output;
  assert.doesNotThrow(()=>zodSchema(z,schema).parse(value),name);
 }
});
test('missing or both account is intercepted before SDK schema validation with standard error envelope',()=>{
 for(const account of [undefined,'both',null,0]){
  const result=accountError({method:'tools/call',params:{name:'save_research',arguments:{account}}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error,'ACCOUNT_REQUIRED');
 }
 assert.equal(accountError({method:'tools/call',params:{name:'save_research',arguments:{account:'trial'}}}),undefined);
});
test('step-up repeats complete scope catalog; tool failures never echo stacks or hosts',()=>{
 const prior=process.env.FOLIO_ADVERTISE_REAL;process.env.FOLIO_ADVERTISE_REAL='1';
 const result=toolError({error:'REAUTH_REQUIRED'});
 process.env.FOLIO_ADVERTISE_REAL='0';assert.doesNotMatch(JSON.stringify(toolError({error:'REAUTH_REQUIRED'})),/folio:real:read/);
 if(prior===undefined)delete process.env.FOLIO_ADVERTISE_REAL;else process.env.FOLIO_ADVERTISE_REAL=prior;assert.ok(result._meta['mcp/www_authenticate'][0].includes(allScopes.join(' ')));
 assert.doesNotMatch(JSON.stringify(toolError({error:'host-internal:38316 token=secret',message:'private'})),/internal|secret|private/);
});
test('model-visible catalog has no forbidden legacy term or action fields; instructions cover Real sharing',()=>{
 assert.doesNotMatch(JSON.stringify({instructions,descriptions,toolSchemas}),/paper/i);
 assert.doesNotMatch(JSON.stringify(toolSchemas.save_research.input),/"action"/);
 assert.match(instructions,/REAUTH_REQUIRED/);assert.match(instructions,/Never add/);assert.match(instructions,/untrusted data/);
});

test('679 HIGH-1: actual disabled router profile and portfolio fit published output schemas',async()=>{
 const {createDualRouter}=await import('../../core/dual-router.mjs');
 const {baseScopes}=await import('#scope-catalog');
 const active=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/active.json',import.meta.url),'utf8')).trial;
 const calls=[];
 const router=createDualRouter({realEnabled:false,ledger:{},app:async(role,route)=>{
  calls.push(route);
  assert.equal(role,'trial');return {status:200,payload:route==='/profile'?{status:'active',display_name:'Alias'}:active};
 }});
 const args={principal:{subject:'subject',client:'client',scopes:new Set(baseScopes)},bearer:'test'};
 const profile=await router.call('/profile',args);zodSchema(z,toolSchemas.get_profile.output).parse(profile);
 assert.deepEqual(calls,['/profile']);assert.equal(profile.accounts.trial.status,'active');
 assert.equal(profile.research_routing.reason,'real_disabled');
 zodSchema(z,toolSchemas.get_portfolio.output).parse(await router.call('/portfolio',args));
});

test('r1 M5: every contract error code is in the core and MCP error tables; only outages are retryable',async()=>{
 const {errorResult}=await import('../../core/dual-router.mjs');
 const {TOOL_ERRORS}=await import('#contracts/errors');
 const codes=contract.$defs.failure.properties.error.enum;assert.ok(codes.includes('SYMBOL_NOT_SUPPORTED'));
 assert.deepEqual(Object.keys(TOOL_ERRORS).sort(),[...codes].sort());
 for(const code of codes){
  const core=errorResult({code}),mcp=JSON.parse(toolError({error:code}).content[0].text);
  assert.equal(core.error,code,'core '+code);assert.equal(mcp.error,code,'mcp '+code);
  const retryable=TOOL_ERRORS[code].retryable;
  assert.equal(core.retryable,retryable,'core retryable '+code);assert.equal(mcp.retryable,retryable,'mcp retryable '+code);
  assert.equal(core.message,mcp.message,'core and mcp message '+code);
 }
 assert.deepEqual(codes.filter(code=>TOOL_ERRORS[code].retryable).sort(),['ACCOUNT_UNAVAILABLE','TEMPORARILY_UNAVAILABLE']);
});

test('r1 A: Real outage routing plus an explicitly named Trial save succeeds, and model-facing text permits only that exception',async()=>{
 const {createDualRouter}=await import('../../core/dual-router.mjs');
 const {allScopes}=await import('#scope-catalog');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createRequestLedger}=await import('../../core/request-ledger.mjs');
 const active=JSON.parse(readFileSync(new URL('../../../contracts/fixtures/active.json',import.meta.url),'utf8')).trial;
 const dir=mkdtempSync(join(tmpdir(),'dual-outage-'));const ledger=createRequestLedger(join(dir,'requests.sqlite'));
 try{
  const router=createDualRouter({ledger,app:async(role,route,a)=>{
   if(role==='real')throw Error('outage');
   if(route==='/profile')return {status:200,payload:{status:'active',display_name:'Alias'}};
   if(route==='/portfolio')return {status:200,payload:active};
   return {status:200,payload:{id:'d0e9e17e-9d40-44af-b3a1-9e09ba000002',request_id:a.body.request_id,title:a.body.title,body:a.body.body,created_at:'2026-10-29T00:00:00Z',quote_snapshot:{quotes:[],unknown:[],truncated:false},source:'ChatGPT'}};
  }});
  const args={principal:{subject:'subject',client:'client',scopes:new Set(allScopes)},bearer:'test'};
  const portfolio=await router.call('/portfolio',args);zodSchema(z,toolSchemas.get_portfolio.output).parse(portfolio);
  assert.deepEqual(portfolio.research_routing.allowed_accounts,[]);assert.equal(portfolio.research_routing.must_ask,true);
  const saved=await router.call('/research',{...args,body:{account:'trial',request_id:'outage-trial',title:'Review',body:'Data'}});
  zodSchema(z,toolSchemas.save_research.output).parse(saved);assert.equal(saved.account,'trial');
  await assert.rejects(router.call('/research',{...args,body:{account:'real',request_id:'outage-real',title:'Review',body:'Data'}}),e=>e.code==='TEMPORARILY_UNAVAILABLE');
  assert.match(instructions,/allowed_accounts is empty[^.]*save to Trial only when the person explicitly named Trial/);
  assert.match(instructions,/NOT_ELIGIBLE means save nothing/);assert.match(instructions,/Never pick an account/);
  assert.doesNotMatch(instructions,/If allowed_accounts is empty, save nothing/);
  assert.match(descriptions.save_research,/only a Trial save the person explicitly named is accepted/);assert.match(descriptions.save_research,/NOT_ELIGIBLE means save nothing/);
 }finally{ledger.close();rmSync(dir,{recursive:true,force:true})}
});

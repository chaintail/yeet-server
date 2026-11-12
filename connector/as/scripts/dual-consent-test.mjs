import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {allScopes,baseScopes,realScope,refreshScopes,consentScopes} from '#scope-catalog';
import {consentSelection,consentFields,consentForm,submittedScopes,ignoreRefreshScope,isRealStepUp} from '../consent-selection.mjs';
import {backfill} from '../backfill-consent.mjs';
test('initial Real opt-in unticked, plain reconnect unticked, explicit step-up selected, submit alone persists granted subset',()=>{
 assert.equal(consentSelection(allScopes).real_selected,false);
 assert.equal(consentSelection(allScopes,baseScopes).real_selected,false,'plain reconnect must not default to Real');
 assert.equal(consentSelection(allScopes,baseScopes,{stepUp:true}).real_selected,true);
 assert.equal(consentSelection(allScopes,allScopes,{stepUp:true}).real_selected,false);
 assert.equal(isRealStepUp({folio_step_up:'real'}),true);assert.equal(isRealStepUp({folio_step_up:'yes'}),false);assert.equal(isRealStepUp({}),false);
 assert.deepEqual(submittedScopes(allScopes,{consent:'yes'}),baseScopes);
 assert.deepEqual(submittedScopes(allScopes,{consent:'yes',real_consent:'yes'},consentScopes),allScopes);
 assert.deepEqual(submittedScopes(allScopes,{consent:'yes',real_consent:'yes'},baseScopes),baseScopes);
 assert.throws(()=>submittedScopes(allScopes,{real_consent:'yes'}),/Explicit consent/);
 const old=[...baseScopes];assert.deepEqual(refreshScopes(old),baseScopes);assert.equal(old.includes(realScope),false);
 assert.deepEqual(ignoreRefreshScope({grant_type:'refresh_token',scope:allScopes.join(' '),refresh_token:'opaque'}),{grant_type:'refresh_token',refresh_token:'opaque'});
});
test('backfill derives only actual granted scopes and preserves immutable family window',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dual-consent-')),op=join(dir,'oauth.sqlite'),cp=join(dir,'consent.sqlite');
 const o=new DatabaseSync(op),c=new DatabaseSync(cp);
 try{
  o.exec('CREATE TABLE models(model TEXT,id TEXT,payload TEXT)');c.exec('CREATE TABLE consent(grant_id TEXT,body TEXT)');
  o.prepare('INSERT INTO models VALUES(?,?,?)').run('Grant','g',JSON.stringify({accountId:'a',clientId:'c',openid:{scope:'openid'},resources:{resource:baseScopes.join(' ')}}));
  c.prepare('INSERT INTO consent VALUES(?,?)').run('g',JSON.stringify({accountId:'a',clientId:'c',resource:'resource',scopes:allScopes,refreshFamilyTTL:600}));
  assert.deepEqual(backfill(op,cp),{updated:1,unverifiable:0});
  const v=JSON.parse(c.prepare('SELECT body FROM consent').get().body);assert.equal(v.scopes.includes(realScope),false);assert.equal(v.refreshFamilyTTL,600);
 }finally{o.close();c.close();rmSync(dir,{recursive:true,force:true})}
});
test('all deployed scope list imports use the one catalog; grant recording uses granted scope getters',()=>{
 // One shared introspection verifier and one AS scope list, both read from the catalog; no role keeps its own copy.
 assert.match(readFileSync(new URL('../../shared/introspection.mjs',import.meta.url),'utf8'),/from '#scope-catalog'/);
 assert.match(readFileSync(new URL('../scopes.mjs',import.meta.url),'utf8'),/from '#scope-catalog'/);
 assert.doesNotMatch(readFileSync(new URL('../../shared/common.mjs',import.meta.url),'utf8'),/scopes|Scopes|scope-catalog/);
 for(const svc of ['as','core','mcp'])for(const name of ['common.mjs','introspection.mjs'])
  assert.equal(existsSync(new URL(`../../${svc}/${name}`,import.meta.url)),false,`${svc}/${name}`);
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');assert.match(source,/grant.getResourceScope/);assert.doesNotMatch(source,/scopes: d.params.scope.split/);
});

// Browser form submission: hidden inputs always post; a checkbox posts only when checked.
function submit(form,toggle={}){
 const body={};
 for(const [,attrs] of form.matchAll(/<input ([^>]*)>/g)){
  const attr=n=>attrs.match(new RegExp(`${n}="([^"]*)"`))?.[1];
  const checked=toggle[attr('name')]??/\bchecked\b/.test(attrs);
  if(attr('type')==='checkbox'&&!checked)continue;
  body[attr('name')]=attr('value');
 }
 return body;
}
test('r1 M3: rendered production consent form grants Real only when its checkbox is checked and Real is advertised',()=>{
 // as.mjs sends exactly consentForm(...) for the consent prompt; the test posts that same HTML.
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 assert.match(source,/authDocument\(r, promptTitle\(d\.prompt\.name\), consentForm\(\{/);
 assert.doesNotMatch(source,/consentFields\(|name="consent"/);
 const requested=['openid','offline_access',...allScopes];
 const render=(prior,advertised,stepUp=false)=>consentForm({csrf:'x',accountId:'folio-alice',clientId:'chatgpt',resource:'https://r/mcp',requested,priorGranted:prior,stepUp,advertised});
 const advertised=['openid','offline_access',...allScopes];
 const first=render([],advertised);
 assert.match(first,/name="real_consent"/);assert.doesNotMatch(first,/checked/);
 assert.match(first,/Scopes granted<\/dt><dd>openid offline_access folio:profile:read folio:portfolio:read folio:research:write<\/dd>/);
 assert.equal(submittedScopes(requested,submit(first),advertised).includes(realScope),false);
 assert.equal(submittedScopes(requested,submit(first,{real_consent:true}),advertised).includes(realScope),true);
 assert.equal(submit(first).csrf,'x');assert.equal(submit(first).consent,'yes');
 const reconnect=render(baseScopes,advertised);assert.doesNotMatch(reconnect,/checked/);
 assert.equal(submittedScopes(requested,submit(reconnect),advertised).includes(realScope),false);
 const stepUp=render(baseScopes,advertised,true);assert.match(stepUp,/checked/);
 assert.equal(submittedScopes(requested,submit(stepUp),advertised).includes(realScope),true);
 assert.equal(submittedScopes(requested,submit(stepUp,{real_consent:false}),advertised).includes(realScope),false);
 const off=['openid','offline_access',...baseScopes];const hidden=render([],off);
 assert.doesNotMatch(hidden,/real_consent|folio:real:read/);
 assert.equal(submittedScopes(requested,{...submit(hidden),real_consent:'yes'},off).includes(realScope),false);
 const noReal=consentFields(['openid',...baseScopes],[],advertised);assert.doesNotMatch(noReal,/real_consent/);
});
test('r1 L6: AS registers Real only when advertised',async()=>{
 const prior=process.env.FOLIO_ADVERTISE_REAL;
 try{
  for(const [flag,expected] of [['0',baseScopes],['1',allScopes]]){
   process.env.FOLIO_ADVERTISE_REAL=flag;
   const {issuableScopes}=await import(`../scopes.mjs?advertise=${flag}`);assert.deepEqual([...issuableScopes],[...expected]);
  }
 }finally{if(prior===undefined)delete process.env.FOLIO_ADVERTISE_REAL;else process.env.FOLIO_ADVERTISE_REAL=prior;}
});

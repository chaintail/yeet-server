// mcp/refresh.mjs: a stale YEET app in ChatGPT. The server's card build is the vendored pin and is stamped in every
// vendored template; a card built from another commit (or a card-only call with no build) marks the conversation
// stale; the next result the model reads says so once, with the page from the contract; cards get the server build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../tool-registration.mjs';
import {APP,CARD_BUILD,BUILD_META_KEY,createStaleness,sameBuild,staleKey,vendoredBuild,withRefresh,appRefresh,TOOLS_VERSIONS,classifyToolsVersion,loggedVersion} from '../refresh.mjs';
import {COPY,refreshGuidance} from '../guidance.mjs';
import {contract,CARDS,toolSchemas,zodSchema} from '../tool-contract.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {widgetHtml,WIDGET_VIEWS} from '../widgets.mjs';
import {vendoredPin} from '../../core/version.mjs';
import {allScopes} from '#scope-catalog';

const OLD='a'.repeat(40);
const overview={username:'Lucky Otter 42',usdc:'20',xp:5,tier:'Noob',streak_days:1,checkin_open:false,holdings_count:0,top_winner:null,trading:'live',suggestions:[{id:'discover',label:'Discover a new coin to yeet',say:'Help me find a new coin to yeet'}]};
const coins={coins:[],as_of:null,limits:{min_leg_usdc:'3',max_trade_usdc:'25',max_legs:5,default_usdc:'20'}};
const board={rows:[],me:{rank:null,xp:0}};
const status={trade_id:'t_abcdefghij0123456789',direction:'yeet',status:'settling',legs:[{symbol:'WIF',status:'PROCESSING',amount_in:'20',amount_out:null,origin_tx:null,destination_tx:null,refund_reason:null}],received:[],updated_at:'2026-11-12T00:00:05Z',xp_award:null};
const core=async route=>route==='/overview'?overview:route==='/coins'?coins:route.startsWith('/leaderboard')?board:route.startsWith('/trades/')?status:route==='/spin'?{xp_won:5,draw_xp:0,streak_xp:0,total:5,streak_days:1,next_spin_at:'2026-11-15T00:00:00Z'}:(()=>{throw {error:'TEMPORARILY_UNAVAILABLE'}})();
const CURRENT=contract['x-yeet-app'].tools_version;
/** The model's own entry call carries the current tools version, as its schema tells it to (`raw` sends args as given). */
const asModel=(name,args)=>name==='yeet_overview'&&!Object.hasOwn(args,'card_build')?{app_version:CURRENT,...args}:args;
async function connect({staleness=createStaleness(),sub='yeet-privy-refresh',routes=[],toolsVersions,logs=[]}={}){
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub},callCore:async(route,body)=>{routes.push([route,body]);return core(route)},env:{YEET_P2:'1'},staleness,log:l=>logs.push(JSON.parse(l)),...(toolsVersions?{toolsVersions}:{})});
 const client=new Client({name:'refresh-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const raw=(name,args={},meta)=>client.callTool({name,arguments:args,...(meta?{_meta:meta}:{})});
 const call=(name,args={},meta)=>raw(name,asModel(name,args),meta);
 return {client,call,raw,logs,staleness,routes,close:async()=>{await client.close();await server.close()}};
}
const REFRESH="YEET REFRESH.";

test('the page is the contract’s one constant; the server’s card build is the vendored pin and is stamped in every vendored template',()=>{
 assert.deepEqual(APP,contract['x-yeet-app']);assert.equal(APP.manage_url,'https://chatgpt.com/plugins');
 assert.equal(CARD_BUILD,vendoredBuild());assert.equal(CARD_BUILD,vendoredPin(),'the same pin GET /version reports as yeet_win_commit');
 assert.match(CARD_BUILD,/^[0-9a-f]{40}$/);
 assert.deepEqual(WIDGET_VIEWS,Object.keys(CARDS));
 for(const view of WIDGET_VIEWS){
  const html=widgetHtml(view);
  assert.ok(html.includes(`const BUILD="${CARD_BUILD}";`),`${view}: built from the pinned commit`);
  assert.ok(html.includes(APP.manage_url),`${view}: carries the refresh link`);
 }
 assert.equal(refreshGuidance(),REFRESH);assert.equal(refreshGuidance(),COPY.refresh.stale.replace('{url}',APP.manage_url).replace('{steps}',APP.refresh_steps));
 // No other file names the ChatGPT page: guidance and cards read it from the contract.
 for(const f of ['../guidance.mjs','../refresh.mjs','../tool-registration.mjs','../instructions.mjs'])assert.doesNotMatch(readFileSync(new URL(f,import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,''),/chatgpt\.com/,f);
});

test('staleness: a different card build, or a card-only call with none; the model’s own calls decide nothing; told once; forgotten after the TTL',()=>{
 let t=0;const s=createStaleness({build:CARD_BUILD,now:()=>t,ttlMs:1000,max:2});
 assert.equal(s.note('k',{cardBuild:CARD_BUILD}),false);assert.equal(s.note('k',{cardBuild:CARD_BUILD.slice(0,12)}),false,'a short sha of the same commit');
 assert.equal(s.note('k',{cardBuild:undefined,cardOnly:false}),false,'a model call carries no build and proves nothing');assert.equal(s.isStale('k'),false);assert.equal(s.take('k'),false);
 assert.equal(s.note('k',{cardBuild:OLD}),true);assert.equal(s.isStale('k'),true);
 assert.equal(s.take('k'),true);assert.equal(s.take('k'),false,'once per conversation');
 assert.equal(s.note('k',{cardBuild:OLD}),true);assert.equal(s.take('k'),false,'the same conversation is not told again');
 assert.equal(s.note('old',{cardOnly:true}),true,'a card from before build ids');assert.equal(s.take('other'),false,'another conversation is not affected');
 t=2000;assert.equal(s.isStale('k'),false);assert.equal(s.take('old'),false);
 s.note('a',{cardBuild:OLD});s.note('b',{cardBuild:OLD});s.note('c',{cardBuild:OLD});assert.ok(s.size()<=2,'bounded');
 assert.equal(sameBuild(OLD,'b'.repeat(40)),false);assert.equal(sameBuild('zz',OLD),false);
 assert.equal(staleKey({sub:'u'},{'openai/session':'conv1'}),'u|conv1');assert.equal(staleKey({sub:'u'},undefined),'u|');assert.notEqual(staleKey({sub:'u'},{'openai/session':'a'}),staleKey({sub:'u'},{'openai/session':'b'}));
 assert.deepEqual(appRefresh(),{url:APP.manage_url,steps:APP.refresh_steps});
 const long=withRefresh(REFRESH,'One. '+'x'.repeat(480)+'. Three.');assert.ok(long.length<=500);assert.ok(long.startsWith(REFRESH+' One.'));
});

test('a stale card’s call marks the conversation: the next result the model reads leads with the refresh guidance, once; yeet_overview also carries app_refresh',async()=>{
 const c=await connect();
 try{
  const fresh=await c.call('yeet_overview');
  assert.doesNotMatch(fresh.structuredContent.guidance,/out of date/);assert.equal(fresh.structuredContent.app_refresh,undefined);
  assert.equal(fresh._meta[BUILD_META_KEY],CARD_BUILD,'every result names the server’s card build, for the card only');
  assert.doesNotMatch(JSON.stringify([fresh.structuredContent,fresh.content]),new RegExp(CARD_BUILD));
  // The card of an older build polls its trade: the answer goes to the card, the conversation is marked.
  const fromCard=await c.call('trade_status',{trade_id:status.trade_id,card_build:OLD});
  assert.equal(fromCard.isError,undefined,JSON.stringify(fromCard.content));
  assert.doesNotMatch(fromCard.structuredContent.guidance,/out of date/,'a card’s own call is not where the model is told');
  assert.deepEqual(c.routes.at(-1),[`/trades/${status.trade_id}`,undefined],'card_build never reaches core');
  const o=await c.call('yeet_overview');
  assert.ok(o.structuredContent.guidance.startsWith(REFRESH+' Welcome Lucky Otter 42'),o.structuredContent.guidance);assert.ok(o.structuredContent.guidance.length<=500);
  assert.deepEqual(o.structuredContent.app_refresh,{url:'https://chatgpt.com/plugins',steps:'open YEET there, select Refresh, then start a new chat'});
  assert.equal(o.content[1].text,o.structuredContent.guidance,'in the text the model reads');
  const again=await c.call('yeet_overview');
  assert.doesNotMatch(again.structuredContent.guidance,/out of date/,'once per conversation');assert.equal(again.structuredContent.app_refresh,undefined);
 }finally{await c.close()}
});

test('a card-only call without a build is a card from before build ids; any model-read tool carries the guidance; conversations are separate',async()=>{
 const staleness=createStaleness();
 const c=await connect({staleness});
 try{
  const spin=await c.call('daily_spin',{},{'openai/session':'conv-old'});
  assert.equal(spin.isError,undefined,JSON.stringify(spin.content));
  const other=await c.call('yeet_coins',{},{'openai/session':'conv-new'});
  assert.doesNotMatch(other.structuredContent.guidance,/out of date/,'another conversation of the same person');
  const lb=await c.call('yeet_leaderboard',{},{'openai/session':'conv-old'});
  assert.ok(lb.structuredContent.guidance.startsWith(REFRESH),lb.structuredContent.guidance);
  assert.equal(JSON.parse(lb.content[0].text).guidance,lb.structuredContent.guidance);
  assert.doesNotMatch((await c.call('yeet_coins',{},{'openai/session':'conv-old'})).structuredContent.guidance,/out of date/);
  // A current card's calls never mark anything.
  await c.call('daily_spin',{card_build:CARD_BUILD},{'openai/session':'conv-ok'});
  assert.doesNotMatch((await c.call('yeet_coins',{},{'openai/session':'conv-ok'})).structuredContent.guidance,/out of date/);
 }finally{await c.close()}
});

test('a build that is not a commit id is refused as an argument; a refused call tells nothing',async()=>{
 const c=await connect();
 try{
  const bad=await c.call('trade_status',{trade_id:status.trade_id,card_build:'<script>'});
  assert.equal(bad.isError,true);
  assert.doesNotMatch((await c.call('yeet_coins')).structuredContent.guidance,/out of date/);
 }finally{await c.close()}
});

// ---- The tools version (contract x-yeet-app.tools_version; yeet-win docs/CARDS.md "Tools version") ----
const PAST={current:'tools-9',past:['tools-7','tools-8']};
const UPDATE="YEET UPDATE.";

test('tools version: one current value from the contract, the values advertised before it, and how a call is classified',()=>{
 assert.deepEqual(TOOLS_VERSIONS,{current:contract['x-yeet-app'].tools_version,past:contract['x-yeet-app'].tools_versions_past});
 assert.match(TOOLS_VERSIONS.current,/^tools-[1-9][0-9]*$/);assert.equal(TOOLS_VERSIONS.past.includes(TOOLS_VERSIONS.current),false);
 assert.equal(classifyToolsVersion(TOOLS_VERSIONS.current),'current');
 assert.equal(classifyToolsVersion('tools-9',PAST),'current');
 for(const v of PAST.past)assert.equal(classifyToolsVersion(v,PAST),'outdated',v);
 assert.equal(classifyToolsVersion(undefined,PAST),'missing');
 for(const v of ['','tools','tools-','tools-0','tools-07','Tools-8','tools-8 ','8',8,null,true,{},['tools-8'],'tools-8\n','x'.repeat(5000)])assert.equal(classifyToolsVersion(v,PAST),'malformed',JSON.stringify(v)?.slice(0,20));
 for(const v of ['tools-1','tools-6','tools-10','tools-999999'])assert.equal(classifyToolsVersion(v,PAST),'unknown',v);
 // The log keeps a well-formed value and otherwise only the type: never free text from a call.
 assert.deepEqual(['tools-8',undefined,null,5,'secret words',{a:1}].map(loggedVersion),['tools-8',null,'(null)','(number)','(string)','(object)']);
});

test('tools/list advertises app_version strictly (one value, required, the copy instruction); a call is read permissively and core never sees the value',async()=>{
 const c=await connect();
 try{
  const {tools}=await c.client.listTools(),o=tools.find(t=>t.name==='yeet_overview');
  assert.deepEqual(o.inputSchema.properties.app_version,{type:'string',enum:[CURRENT],description:'The tools version this tool list was built for.'});
  assert.deepEqual(o.inputSchema.required,['app_version']);assert.equal(o.inputSchema.type,'object');assert.equal(o.inputSchema.additionalProperties,false);
  assert.deepEqual(Object.keys(o.inputSchema.properties).sort(),['app_version','card_build']);
  for(const t of tools)if(t.name!=='yeet_overview')assert.equal(Object.hasOwn(t.inputSchema.properties??{},'app_version'),false,t.name);
  // What core checks a call against (core.mjs builds its input schemas from toolSchemas.input) has no such field:
  // GET /overview carries no arguments and must stay valid.
  assert.equal(Object.hasOwn(toolSchemas.yeet_overview.input.properties,'app_version'),false);assert.deepEqual(toolSchemas.yeet_overview.input.required,[]);
  assert.equal(zodSchema(z,toolSchemas.yeet_overview.input).safeParse({}).success,true);
  assert.deepEqual(toolSchemas.yeet_overview.advertisedInput.required,['app_version']);
  // Every form reaches the handler and gets the overview: none is rejected by the protocol layer.
  for(const v of [CURRENT,undefined,'tools-1','nonsense',7,null,['x']]){
   const r=await c.raw('yeet_overview',v===undefined?{}:{app_version:v},{'openai/session':`conv-${String(JSON.stringify(v))}`});
   assert.equal(r.isError,undefined,`${JSON.stringify(v)}: ${r.content?.[0]?.text?.slice(0,120)}`);assert.equal(r.structuredContent.username,'Lucky Otter 42');
  }
  assert.ok(c.routes.length>=7);for(const [route,body] of c.routes){assert.equal(route,'/overview');assert.equal(body,undefined,'nothing of it goes on to core')}
  // Still a closed schema for everything else.
  const bad=await c.raw('yeet_overview',{app_version:CURRENT,extra:1});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/extra|unrecognized/i);
 }finally{await c.close()}
});

test('a current client: the overview as always, no refresh hint, nothing logged, nothing marked',async()=>{
 const c=await connect({toolsVersions:PAST});
 try{
  const r=await c.raw('yeet_overview',{app_version:'tools-9'},{'openai/session':'conv-current'});
  assert.equal(r.isError,undefined);assert.equal(r.structuredContent.username,'Lucky Otter 42');
  assert.doesNotMatch(r.structuredContent.guidance,/out of date/);assert.equal(r.structuredContent.app_refresh,undefined);
  assert.equal(r.content[1].text,r.structuredContent.guidance);
  assert.deepEqual(c.logs,[]);assert.equal(c.staleness.size(),0);
  assert.doesNotMatch((await c.call('yeet_coins',{},{'openai/session':'conv-current'})).structuredContent.guidance,/out of date/);
 }finally{await c.close()}
});

test('a stale client (a tools version advertised before): refresh only. Nothing is loaded, the model is told to say they refresh YEET and start a new chat, the result passes a client’s output schema rules, the conversation is marked',async()=>{
 const c=await connect({toolsVersions:PAST});
 try{
  await c.client.listTools();   // the client now checks every result against the tool's output schema
  for(const [i,old] of PAST.past.entries()){
   const meta={'openai/session':`conv-old-${i}`},before=c.routes.length;
   const r=await c.raw('yeet_overview',{app_version:old},meta);
   assert.equal(r.isError,true,old);assert.equal(Object.hasOwn(r,'structuredContent'),false,'an error: the text, no structuredContent');
   assert.equal(c.routes.length,before,'core is not asked: nothing of the account is loaded');
   assert.equal(r.content.length,1);assert.equal(r.content[0].type,'text');
   const body=JSON.parse(r.content[0].text);
   assert.deepEqual(body,{error:'APP_OUTDATED',message:'Your YEET in ChatGPT is out of date. Refresh it, then start a new chat.',retryable:false,
    app_refresh:{url:'https://chatgpt.com/plugins',steps:'open YEET there, select Refresh, then start a new chat'},guidance:UPDATE});
   assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse(body));assert.ok(contract.tools.yeet_overview.errors.includes('APP_OUTDATED'));
   // Card only: what the welcome card draws ("Update YEET" and the button), and the server's card build.
   assert.deepEqual(r._meta,{'yeet/failure':{error:'APP_OUTDATED',message:body.message},[BUILD_META_KEY]:CARD_BUILD});
   assert.doesNotMatch(JSON.stringify(r.content),/Lucky Otter|20 USDC/,'nothing of the account');
   // Marked in the same store as a stale card, and already told: the next result does not say it a second time.
   assert.equal(c.staleness.isStale(staleKey({sub:'yeet-privy-refresh'},meta)),true);
   assert.doesNotMatch((await c.call('yeet_coins',{},meta)).structuredContent.guidance,/out of date/);
   // It stays refused for as long as the old list calls.
   assert.equal((await c.raw('yeet_overview',{app_version:old},meta)).isError,true);
  }
  assert.deepEqual(c.logs.map(l=>[l.event,l.tool,l.class,l.value,l.current]),PAST.past.flatMap(v=>[['tools_version','yeet_overview','outdated',v,'tools-9'],['tools_version','yeet_overview','outdated',v,'tools-9']]));
  // Another conversation of the same person on the current list is not touched.
  const ok=await c.raw('yeet_overview',{app_version:'tools-9'},{'openai/session':'conv-new'});assert.equal(ok.isError,undefined);assert.doesNotMatch(ok.structuredContent.guidance,/out of date/);
 }finally{await c.close()}
});

test('no value, a malformed one or an unknown one: never refused. The overview answers as always with the soft refresh hint, once per conversation, and it is logged',async()=>{
 const c=await connect({toolsVersions:PAST});
 try{
  for(const [i,[v,cls,logged]] of [[undefined,'missing',null],['latest','malformed','(string)'],[42,'malformed','(number)'],['tools-10','unknown','tools-10'],['tools-1','unknown','tools-1']].entries()){
   const meta={'openai/session':`conv-soft-${i}`},args=v===undefined?{}:{app_version:v};
   const r=await c.raw('yeet_overview',args,meta);
   assert.equal(r.isError,undefined,cls);assert.equal(r.structuredContent.username,'Lucky Otter 42');assert.deepEqual(r.structuredContent.suggestions,overview.suggestions);
   assert.ok(r.structuredContent.guidance.startsWith(REFRESH+' Welcome Lucky Otter 42'),r.structuredContent.guidance);
   assert.deepEqual(r.structuredContent.app_refresh,{url:'https://chatgpt.com/plugins',steps:'open YEET there, select Refresh, then start a new chat'});
   assert.deepEqual(c.logs.at(-1),{event:'tools_version',tool:'yeet_overview',class:cls,value:logged,current:'tools-9'});
   assert.equal(c.staleness.isStale(staleKey({sub:'yeet-privy-refresh'},meta)),true);
   const again=await c.raw('yeet_overview',args,meta);
   assert.equal(again.isError,undefined);assert.doesNotMatch(again.structuredContent.guidance,/out of date/,'once per conversation');assert.equal(again.structuredContent.app_refresh,undefined);
  }
  assert.equal(c.logs.length,10,'every such call is logged');
  assert.doesNotMatch(JSON.stringify(c.logs),/latest/,'never the free text of a call');
 }finally{await c.close()}
});

test('a card’s own overview call carries its build, not a tools version: it is not judged as an old tool list',async()=>{
 const c=await connect({toolsVersions:PAST});
 try{
  const meta={'openai/session':'conv-card'};
  const r=await c.raw('yeet_overview',{card_build:CARD_BUILD},meta);
  assert.equal(r.isError,undefined);assert.doesNotMatch(r.structuredContent.guidance,/out of date/);
  assert.deepEqual(c.logs,[]);assert.equal(c.staleness.isStale(staleKey({sub:'yeet-privy-refresh'},meta)),false);
 }finally{await c.close()}
});

// THE BUMP RULE (docs/DEPLOY-V2.md "Tools version"). tools-list.lock.json records, per tools version, the sha256 of
// what tools/list answers with every tool registered: names, input and output schemas, hints and _meta. Wording is
// left out (titles, descriptions, status lines): a change of words needs no refresh. This fails when that hash moves
// under the same version. Then, in yeet-win: raise x-yeet-app.tools_version, append the old value to
// tools_versions_past, set the app_version enum, record tools_hash; re-vendor; and ADD the new version's line here.
// A recorded line is never edited: an old list keeps the hash it had.
const WORDING=new Set(['title','description','openai/toolInvocation/invoking','openai/toolInvocation/invoked','openai/widgetDescription']);
const shapeOf=v=>Array.isArray(v)?v.map(shapeOf):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>!(WORDING.has(k)&&typeof v[k]==='string')).map(k=>[k,shapeOf(v[k])])):v;
export const toolsListHash=tools=>createHash('sha256').update(JSON.stringify(tools.map(t=>shapeOf({name:t.name,inputSchema:t.inputSchema,outputSchema:t.outputSchema,annotations:t.annotations,_meta:t._meta})).sort((a,b)=>a.name<b.name?-1:1))).digest('hex');
test('tools/list snapshot: its hash is the one recorded for this tools version; a change of shape needs a new version',async()=>{
 const lock=JSON.parse(readFileSync(new URL('../tools-list.lock.json',import.meta.url),'utf8'));
 const c=await connect();
 try{
  const {tools}=await c.client.listTools();
  assert.equal(tools.length,Object.keys(contract.tools).length,'every tool, P2 included');
  const hash=toolsListHash(tools);
  assert.ok(Object.hasOwn(lock,CURRENT),`tools-list.lock.json has no line for ${CURRENT}: add "${CURRENT}": "${hash}"`);
  assert.equal(hash,lock[CURRENT],`tools/list changed shape under ${CURRENT}. Do not edit the recorded hash: raise x-yeet-app.tools_version in yeet-win (docs/DEPLOY-V2.md "Tools version"), re-vendor, then add the new version's line: "${hash}"`);
  // One line per version ever advertised, each with its own hash; the contract's past values are all on record.
  for(const [v,h] of Object.entries(lock)){assert.match(v,/^tools-[1-9][0-9]*$/);assert.match(h,/^[0-9a-f]{64}$/)}
  assert.equal(new Set(Object.values(lock)).size,Object.keys(lock).length,'two versions never share a hash');
  for(const v of TOOLS_VERSIONS.past)assert.ok(Object.hasOwn(lock,v),`${v} was advertised: its line stays`);
  // The hash sees shape, not words.
  const reworded=structuredClone(tools);reworded[0].description='Other words.';reworded[0].title='Other';reworded[0].inputSchema.properties&&Object.values(reworded[0].inputSchema.properties).forEach(p=>{if(p.description)p.description='Other'});
  assert.equal(toolsListHash(reworded),hash);
  for(const change of [t=>{t[0].annotations.readOnlyHint=!t[0].annotations.readOnlyHint},t=>{t.pop()},t=>{t[0].inputSchema.properties={...t[0].inputSchema.properties,q:{type:'string'}}},t=>{t[0]._meta['openai/widgetAccessible']=!t[0]._meta['openai/widgetAccessible']},
   t=>{t.find(x=>x.name==='yeet_overview').inputSchema.properties.app_version.enum=['tools-999']}]){const t=structuredClone(tools);change(t);assert.notEqual(toolsListHash(t),hash)}
 }finally{await c.close()}
});

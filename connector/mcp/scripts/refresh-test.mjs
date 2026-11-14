// mcp/refresh.mjs: a stale YEET app in ChatGPT. The server's card build is the vendored pin and is stamped in every
// vendored template; a card built from another commit (or a card-only call with no build) marks the conversation
// stale; the next result the model reads says so once, with the page from the contract; cards get the server build.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../tool-registration.mjs';
import {APP,CARD_BUILD,BUILD_META_KEY,createStaleness,sameBuild,staleKey,vendoredBuild,withRefresh,appRefresh} from '../refresh.mjs';
import {COPY,refreshGuidance} from '../guidance.mjs';
import {contract,CARDS} from '../tool-contract.mjs';
import {widgetHtml,WIDGET_VIEWS} from '../widgets.mjs';
import {vendoredPin} from '../../core/version.mjs';
import {allScopes} from '#scope-catalog';

const OLD='a'.repeat(40);
const overview={username:'Lucky Otter 42',usdc:'20',xp:5,tier:'Noob',streak_days:1,checkin_open:false,holdings_count:0,top_winner:null,trading:'live',suggestions:[{id:'discover',label:'Discover a new coin to yeet',say:'Help me find a new coin to yeet'}]};
const coins={coins:[],limits:{min_leg_usdc:'3',max_trade_usdc:'25',max_legs:5,default_usdc:'20'}};
const board={rows:[],me:{rank:null,xp:0}};
const status={trade_id:'t_abcdefghij0123456789',direction:'yeet',status:'settling',legs:[{symbol:'WIF',status:'PROCESSING',amount_in:'20',amount_out:null,origin_tx:null,destination_tx:null,refund_reason:null}],received:[],updated_at:'2026-11-12T00:00:05Z',xp_award:null};
const core=async route=>route==='/overview'?overview:route==='/coins'?coins:route.startsWith('/leaderboard')?board:route.startsWith('/trades/')?status:route==='/spin'?{xp_won:5,draw_xp:0,streak_xp:0,total:5,streak_days:1,next_spin_at:'2026-11-15T00:00:00Z'}:(()=>{throw {error:'TEMPORARILY_UNAVAILABLE'}})();
async function connect({staleness=createStaleness(),sub='yeet-privy-refresh',routes=[]}={}){
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub},callCore:async(route,body)=>{routes.push([route,body]);return core(route)},env:{YEET_P2:'1'},staleness});
 const client=new Client({name:'refresh-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const call=(name,args={},meta)=>client.callTool({name,arguments:args,...(meta?{_meta:meta}:{})});
 return {client,call,staleness,routes,close:async()=>{await client.close();await server.close()}};
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

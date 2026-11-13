// Card signing on the MCP side (yeet-win docs/CARD-SIGNING.md sections 2.3a, 3 and 7): the signing CSP on the basket,
// portfolio and receipt resources, `_meta['yeet/signer']` on proposal and trade results, and `limits` reaching the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer,SIGNER_TOOLS,ACCOUNT_META_KEY} from '../tool-registration.mjs';
import {CARDS} from '../tool-contract.mjs';
import {resourceMeta,CONFIRM_META_KEY} from '../widgets.mjs';
import {SIGNER_META_KEY,SIGNING_VIEWS,signerAsset,signerMeta,signerMetaFromEnv,publicOrigin} from '#shared/signing.mjs';
import {allScopes} from '#scope-catalog';

delete process.env.YEET_P2;
const ORIGIN='https://chatgpt.yeet.win',APP='cmzyxwvutsrqponmlkjihgfed';
const ENV={RESOURCE:ORIGIN,PRIVY_APP_ID:APP};
const asset=signerAsset();
const limits={tier:'Noob',per_trade_usdc:'25',daily_limit_usdc:'100',left_today_usdc:'75'};
const proposal={proposal_id:'p_abcdefghij0123456789',revision:1,direction:'yeet',amount_usdc:'20',legs:[{symbol:'WIF',parts:10,amount_in:'20',est_out:'7.1',est_out_usd:'19.4',min_out:'7'}],totals:{in_usd:'20',out_usd:'19.4',cost_pct:3,time_estimate_s:40},quoted_at:'2026-11-12T00:00:00Z',warnings:[],next:'⚡ YEET is ready in the card.',limits};
const confirm={code:'c'.repeat(43),expires_at:'2026-11-12T00:01:00Z'};
const tradeAnswer={trade_id:'t_abcdefghij0123456789',proposal_id:proposal.proposal_id,direction:'yeet',status:'awaiting_signature',legs:[{symbol:'WIF',deposit_address:'D'.repeat(44),tx_hash:null,explorer_url:null,status:'awaiting_signature'}],sign_requests:[]};
const statusAnswer={trade_id:tradeAnswer.trade_id,direction:'yeet',status:'signing',legs:[{symbol:'WIF',status:'PENDING_DEPOSIT',amount_in:'20',amount_out:null,origin_tx:null,destination_tx:null,refund_reason:null}],received:[],updated_at:'2026-11-12T00:00:05Z',xp_award:null};
const submitAnswer={trade_id:tradeAnswer.trade_id,status:'submitted',legs:[{leg:0,symbol:'WIF',send_status:'signing',tx_hash:null}]};
const home={wallets:{base:{address:'0x'+'a'.repeat(40),usdc:'20'},solana:{address:'S'.repeat(44)}},ready:'ready',xp:null,recent_wins:[],limits};
const overviewAnswer={username:'Lucky Otter 42',usdc:'20',xp:5,tier:'Noob',streak_days:1,checkin_open:true,holdings_count:0,top_winner:null,trading:'live',needs_card_sign_in:'unknown',suggestions:[{id:'checkin',label:'Do your daily check-in',say:'Do my daily check-in'}]};
const core=async route=>{
 if(route==='/proposals'||route==='/proposals/skeet'||/\/quote$/.test(route))return {...proposal,confirm};
 if(route==='/trades')return tradeAnswer;
 if(/\/signature$/.test(route))return submitAnswer;
 if(/^\/trades\/t_/.test(route))return statusAnswer;
 if(route==='/home')return home;
 if(route==='/overview')return overviewAnswer;
 if(route==='/portfolio')return {solana:{address:'S'.repeat(44),holdings:[]},base:{address:'0x'+'a'.repeat(40),usdc:'20'},total_usd:'20',priced_at:'2026-11-12T00:00:00Z'};
 throw {error:'TEMPORARILY_UNAVAILABLE'};
};
async function connect(env){
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:core,env});
 const client=new Client({name:'signing-meta-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close()}};
}
const CALLS={
 yeet_propose:{request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]},yeet_quote:{proposal_id:proposal.proposal_id},
 skeet_propose:{request_id:'r2',legs:[{symbol:'WIF',percent:100}]},execute_trade:{proposal_id:proposal.proposal_id,revision:1,confirm:'a'.repeat(43)},
 submit_trade_signature:{trade_id:tradeAnswer.trade_id,leg:0,attempt_id:'b'.repeat(64),signed:'AQID'},trade_status:{trade_id:tradeAnswer.trade_id},
 yeet_home:{},yeet_portfolio:{},yeet_overview:{},
};
// CARD-SIGNING.md section 3, verbatim with the production origin.
const SIGNING_META={
 ui:{prefersBorder:true,csp:{connectDomains:['https://auth.privy.io','https://api.privy.io',ORIGIN],resourceDomains:[ORIGIN],frameDomains:['https://auth.privy.io',ORIGIN]}},
 'openai/widgetCSP':{connect_domains:['https://auth.privy.io','https://api.privy.io',ORIGIN],resource_domains:[ORIGIN],frame_domains:['https://auth.privy.io',ORIGIN],redirect_domains:[ORIGIN]},
};

test('the vendored signer is present and its URL carries its content hash',()=>{
 assert.ok(asset,'vendor/yeet-win/widget/yeet-signer.js is vendored');
 assert.ok(asset.bytes.length>500_000&&asset.bytes.length<1_500_000,`${asset.bytes.length} B`);
 assert.ok(asset.bytes.includes('YeetSigner')&&asset.bytes.includes('auth.privy.io'),'the Privy signer bundle');
 assert.match(asset.path,/^\/cards\/yeet-signer-[0-9a-f]{12}\.js$/);
 assert.deepEqual(signerMetaFromEnv(ENV),{privy_app_id:APP,script_url:`${ORIGIN}${asset.path}`,sign_page_url:`${ORIGIN}/sign`});
 // Off unless every piece is there: an https origin, an app id in the card's shape, the vendored file.
 assert.equal(signerMeta({origin:'http://127.0.0.1:38313',appId:APP}),null);
 assert.equal(signerMeta({origin:ORIGIN,appId:''}),null);
 assert.equal(signerMeta({origin:ORIGIN,appId:'bad id!'}),null);
 assert.equal(signerMeta({origin:ORIGIN,appId:APP,asset:null}),null);
 assert.equal(signerMetaFromEnv({}),null);
 assert.equal(publicOrigin('https://chatgpt.yeet.win/'),ORIGIN);assert.equal(publicOrigin('https://u:p@x.example'),null);
});

test('resources: overview, basket, portfolio, receipt and lucky declare exactly the signing CSP; home, wheel and leaderboard stay closed; no ui.domain',async()=>{
 assert.deepEqual([...SIGNING_VIEWS],['overview','basket','portfolio','receipt','lucky']);
 const {client,close}=await connect(ENV);
 try{
  for(const [view,{uri}] of Object.entries(CARDS)){
   const {contents:[c]}=await client.readResource({uri});
   assert.equal(c._meta.ui.domain,undefined,view);
   assert.equal(c._meta['openai/widgetDomain'],undefined,view);
   if(SIGNING_VIEWS.includes(view)){
    assert.deepEqual(c._meta.ui,SIGNING_META.ui,view);
    assert.deepEqual(c._meta['openai/widgetCSP'],SIGNING_META['openai/widgetCSP'],view);
   }else{
    assert.deepEqual(c._meta.ui.csp,{connectDomains:[],resourceDomains:[]},view);
    assert.deepEqual(c._meta['openai/widgetCSP'],{connect_domains:[],resource_domains:[]},view);
   }
  }
 }finally{await close()}
 // Signing not configured (no app id): every card keeps the closed CSP.
 const off=await connect({RESOURCE:ORIGIN});
 try{for(const {uri} of Object.values(CARDS)){const {contents:[c]}=await off.client.readResource({uri});assert.deepEqual(c._meta.ui.csp,{connectDomains:[],resourceDomains:[]},uri);assert.equal(c._meta['openai/widgetCSP'].frame_domains,undefined)}}
 finally{await off.close()}
 assert.deepEqual(resourceMeta('home',{signOrigin:ORIGIN}).ui.csp,{connectDomains:[],resourceDomains:[]});
});

test("results: _meta['yeet/signer'] on the overview, proposal and trade results only, card-only, next to the confirm code",async()=>{
 assert.deepEqual([...SIGNER_TOOLS].sort(),['execute_trade','skeet_propose','submit_trade_signature','trade_status','yeet_overview','yeet_propose','yeet_quote','yeet_unlock']);
 const want={privy_app_id:APP,script_url:`${ORIGIN}${asset.path}`,sign_page_url:`${ORIGIN}/sign`};
 const {client,close}=await connect(ENV);
 try{
  for(const [name,args] of Object.entries(CALLS)){
   const r=await client.callTool({name,arguments:args});
   assert.equal(r.isError,undefined,`${name}: ${JSON.stringify(r.content)}`);
   const seen=JSON.stringify(r.structuredContent)+JSON.stringify(r.content);
   assert.doesNotMatch(seen,/yeet\/signer|privy_app_id|yeet-signer/,`${name}: signer config leaked to the model`);
   if(SIGNER_TOOLS.has(name))assert.deepEqual(r._meta?.[SIGNER_META_KEY],want,name);
   else assert.equal(r._meta?.[SIGNER_META_KEY],undefined,name);
   if(['yeet_propose','yeet_quote','skeet_propose'].includes(name)){
    assert.deepEqual(r._meta[CONFIRM_META_KEY],confirm,name);
    // The contract now lists `limits`: CUT_TO_CONTRACT passes it through to the card.
    assert.deepEqual(r.structuredContent.limits,limits,name);
   }
  }
  const h=await client.callTool({name:'yeet_home',arguments:{}});assert.deepEqual(h.structuredContent.limits,limits);
 }finally{await close()}
 // Without signing configured the results are as before: no signer key; a trade answer has no _meta at all.
 const off=await connect({});
 try{
  const x=await off.client.callTool({name:'execute_trade',arguments:CALLS.execute_trade});assert.deepEqual(Object.keys(x._meta),['yeet/build'],'only the card build, no signer');
  const p=await off.client.callTool({name:'yeet_propose',arguments:CALLS.yeet_propose});assert.deepEqual(Object.keys(p._meta),['yeet/build',CONFIRM_META_KEY]);
 }finally{await off.close()}
 // Errors never carry it.
 const failing=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async()=>{throw {error:'TRADING_PAUSED'}},env:ENV});
 const c=new Client({name:'x',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await failing.connect(a);await c.connect(b);
 try{const r=await c.callTool({name:'execute_trade',arguments:CALLS.execute_trade});assert.equal(r.isError,true);assert.equal(r._meta?.[SIGNER_META_KEY],undefined)}
 finally{await c.close();await failing.close()}
});

test('a basket answer with the account facts: they ride in card-only _meta["yeet/account"], never in what the model reads',async()=>{
 const account={user:'did:privy:gina',email:null,masked:null,google:true,apple:false,wallets:[]};
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>{
  if(route==='/proposals'||route==='/proposals/skeet'||/\/quote$/.test(route))return {...proposal,confirm,card_account:account};
  return core(route);
 },env:ENV});
 const client=new Client({name:'account-meta',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  for(const name of ['yeet_propose','yeet_quote','skeet_propose']){
   const r=await client.callTool({name,arguments:CALLS[name]});
   assert.equal(r.isError,undefined,`${name}: ${JSON.stringify(r.content)}`);
   assert.deepEqual(r._meta[ACCOUNT_META_KEY],account,name);
   assert.deepEqual(r._meta[CONFIRM_META_KEY],confirm,name);
   assert.doesNotMatch(JSON.stringify([r.structuredContent,r.content]),/card_account|did:privy|yeet\/account/,`${name}: the account never reaches the model`);
  }
  // An answer without the facts (Privy did not answer): no key at all, the card keeps its own step.
  const plain=await connect(ENV);
  try{
   const r=await plain.client.callTool({name:'yeet_propose',arguments:CALLS.yeet_propose});assert.equal(r._meta[ACCOUNT_META_KEY],undefined);
   const s=await plain.client.callTool({name:'trade_status',arguments:CALLS.trade_status});assert.equal(s._meta[ACCOUNT_META_KEY],undefined);
  }
  finally{await plain.close()}
 }finally{await client.close();await server.close()}
});

test('trade_status with the account facts (the person confirmed an email on the YEET page while the card follows the trade): card-only _meta again, the answer the model reads is unchanged',async()=>{
 const linked={user:'did:privy:gina',email:'gina@gmail.example',masked:'g•••@g•••.example',google:true,apple:false,wallets:[]};
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>(/^\/trades\/t_/.test(route)?{...statusAnswer,card_account:linked}:core(route)),env:ENV});
 const client=new Client({name:'status-account-meta',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 const plain=await connect(ENV);
 try{
  const r=await client.callTool({name:'trade_status',arguments:CALLS.trade_status});
  assert.equal(r.isError,undefined,JSON.stringify(r.content));
  assert.deepEqual(r._meta[ACCOUNT_META_KEY],linked);
  assert.doesNotMatch(JSON.stringify([r.structuredContent,r.content]),/card_account|did:privy|yeet\/account|gmail/,'the account never reaches the model');
  const before=await plain.client.callTool({name:'trade_status',arguments:CALLS.trade_status});
  assert.deepEqual(r.structuredContent,before.structuredContent);assert.deepEqual(r.content,before.content);
 }finally{await plain.close();await client.close();await server.close()}
});

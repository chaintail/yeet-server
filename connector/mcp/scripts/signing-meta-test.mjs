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
const home={usdc:'20',ready:'ready',xp:null,recent_wins:[],limits};
const overviewAnswer={username:'Lucky Otter 42',usdc:'20',xp:5,tier:'Noob',streak_days:1,checkin_open:true,holdings_count:0,top_winner:null,trading:'live',suggestions:[{id:'checkin',label:'Do your daily check-in',say:'Do my daily check-in'}]};
const core=async route=>{
 if(route==='/proposals'||route==='/proposals/skeet'||/\/quote$/.test(route))return {...proposal,confirm};
 if(route==='/trades')return tradeAnswer;
 if(/\/signature$/.test(route))return submitAnswer;
 if(/^\/trades\/t_/.test(route))return statusAnswer;
 if(route==='/home')return home;
 if(route==='/overview')return overviewAnswer;
 if(route==='/portfolio')return {solana:{holdings:[]},base:{usdc:'20'},total_usd:'20',priced_at:'2026-11-12T00:00:00Z'};
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

test("results: _meta['yeet/signer'] on the proposal and trade results only (never the welcome card), card-only, next to the confirm code",async()=>{
 assert.deepEqual([...SIGNER_TOOLS].sort(),['execute_trade','skeet_propose','submit_trade_signature','trade_status','yeet_propose','yeet_quote']);
 // With no hint from the core the card gets the signer WITHOUT a page address: the trade page link is only handed
 // out bound to the account (boundSigner). The hint test below covers the bound address.
 const want={privy_app_id:APP,script_url:`${ORIGIN}${asset.path}`};
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

test('the trade page hint (core card_hint): on the card-only signer page address, never in what the model reads; a malformed one is dropped and then there is no page address at all',async()=>{
 const hint=`v1.${Buffer.from(JSON.stringify({m:['google'],p:'hint',a:'yeet-privy-ginaAAAAAAAAAAAAAAAAA',e:1900000000})).toString('base64url')}.${'A'.repeat(43)}`;
 const withHint=h=>createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>{
  const base=route==='/proposals'||route==='/proposals/skeet'||/\/quote$/.test(route)?{...proposal,confirm}:await core(route);
  return {...base,card_hint:h};
 },env:ENV});
 const open=async server=>{const client=new Client({name:'hint-meta',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return {client,close:async()=>{await client.close();await server.close()}}};
 const good=await open(withHint(hint));
 try{
  for(const name of SIGNER_TOOLS){
   const r=await good.client.callTool({name,arguments:CALLS[name]});
   assert.equal(r.isError,undefined,`${name}: ${JSON.stringify(r.content)}`);
   assert.equal(r._meta[SIGNER_META_KEY].sign_page_url,`${ORIGIN}/sign?h=${hint}`,name);
   // The card adds the trade to it (yeet-win basket: page + (page.includes('?') ? '&' : '?') + 'trade_id=...').
   assert.match(r._meta[SIGNER_META_KEY].sign_page_url,/^https:\/\/[^\s]{1,500}$/,name);
   assert.equal(r._meta[SIGNER_META_KEY].script_url,`${ORIGIN}${asset.path}`,name);
   assert.doesNotMatch(JSON.stringify([r.structuredContent,r.content]),/card_hint|v1\.ey/,`${name}: the hint never reaches the model`);
  }
 }finally{await good.close()}
 for(const bad of ['not-a-token','v1.abc.def" onload="x',42,`${hint} `,'https://evil.example/']){
  const s=await open(withHint(bad));
  try{
   const r=await s.client.callTool({name:'yeet_propose',arguments:CALLS.yeet_propose});
   assert.equal(r.isError,undefined,JSON.stringify(r.content));
   assert.equal('sign_page_url' in r._meta[SIGNER_META_KEY],false,`${String(bad)}: no unbound page address`);
   assert.equal(r._meta[SIGNER_META_KEY].script_url,`${ORIGIN}${asset.path}`);
   assert.doesNotMatch(JSON.stringify(r),/card_hint/);
  }finally{await s.close()}
 }
});

// The Add funds card's deposit addresses: card-only `_meta["yeet/deposit"]` on yeet_fund, never where the model reads.
test('yeet_fund: the deposit addresses go to _meta only, well-formed or not at all; method rides back; a core answer with an address is never passed on',async()=>{
 const {depositMeta,DEPOSIT_META_KEY}=await import('../tool-registration.mjs');
 const SOL='9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',BASE='0x5a1C0ffee0D15ea5e0000000000000000000B45E';
 const good={default:'solana',networks:[{network:'solana',address:SOL},{network:'base',address:BASE}]};
 assert.equal(DEPOSIT_META_KEY,'yeet/deposit');
 assert.deepEqual(depositMeta(good),good);assert.deepEqual(depositMeta({...good,extra:1,networks:good.networks.map(n=>({...n,walletId:'w'}))}),good,'only network and address');
 for(const bad of [null,{},{default:'solana',networks:[]},{default:'base',networks:[{network:'solana',address:SOL}]},{default:'solana',networks:[{network:'solana',address:BASE}]},
  {default:'base',networks:[{network:'base',address:SOL}]},{default:'solana',networks:[{network:'solana',address:SOL},{network:'solana',address:SOL}]},
  {default:'solana',networks:[{network:'solana',address:SOL},{network:'tron',address:BASE}]},{default:'solana',networks:[{network:'solana',address:`${SOL.slice(0,6)}…${SOL.slice(-4)}`}]}])
  assert.equal(depositMeta(bad),undefined,JSON.stringify(bad));
 let fund={usdc:'3.2',presets:['10','25','50','100'],fund_url:'https://chatgpt.yeet.win/fund?h=v1.x',card_deposit:good};
 const leaky=async route=>{
  if(route==='/fund')return fund;
  if(route==='/home')return {...home,card_deposit:good,wallets:{base:{address:BASE,usdc:'20'},solana:{address:SOL}}};
  if(route==='/portfolio')return {solana:{address:SOL,holdings:[]},base:{address:BASE,usdc:'20'},total_usd:'20',priced_at:'2026-11-12T00:00:00Z'};
  return core(route);
 };
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:leaky,env:ENV});
 const client=new Client({name:'deposit-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const reads=r=>JSON.stringify([r.structuredContent??null,r.content??null]);
 const clean=(r,label)=>assert.doesNotMatch(reads(r),/9WzDXw|YtAWWM|0x5a1C|B45E|card_deposit|yeet\/deposit/,`${label}: no part of an address where the model reads`);
 try{
  for(const [args,method] of [[{},undefined],[{method:'crypto'},'crypto'],[{method:'card'},'card']]){
   const r=await client.callTool({name:'yeet_fund',arguments:args});
   assert.equal(r.isError,undefined,JSON.stringify(r.content));
   assert.deepEqual(r._meta[DEPOSIT_META_KEY],good);assert.equal(r.structuredContent.method,method);clean(r,`yeet_fund ${method}`);
   assert.deepEqual(Object.keys(r.structuredContent).sort(),['fund_url','guidance','presets','usdc',...(method?['method']:[])].sort());
  }
  assert.equal((await client.callTool({name:'yeet_fund',arguments:{method:'bank'}})).isError,true);
  // A block that is not exactly right is dropped whole: the card then says the address is not available.
  fund={...fund,card_deposit:{default:'solana',networks:[{network:'solana',address:SOL},{network:'base',address:SOL}]}};
  const dropped=await client.callTool({name:'yeet_fund',arguments:{method:'crypto'}});
  assert.equal(dropped.isError,undefined);assert.equal(dropped._meta[DEPOSIT_META_KEY],undefined);clean(dropped,'a malformed block');
  // Only yeet_fund carries it; a home answer that still named wallets is cut to the contract; a portfolio answer
  // with an address fails closed (no result at all rather than an address).
  const h=await client.callTool({name:'yeet_home',arguments:{}});
  assert.equal(h.isError,undefined,JSON.stringify(h.content));assert.equal(h._meta?.[DEPOSIT_META_KEY],undefined);assert.equal('wallets' in h.structuredContent,false);clean(h,'yeet_home');
  const p=await client.callTool({name:'yeet_portfolio',arguments:{}});
  assert.equal(p.isError,true);assert.equal(p.structuredContent,undefined);clean(p,'yeet_portfolio');
 }finally{await client.close();await server.close()}
});

// An account on the ledger route (docs/LEDGER-ROUTE.md 1.5): the core's answer names the one way it can add money and
// follows the deposit. The permanent address rides in _meta like any deposit address; the stages are for the card and
// carry no address; the model is told the address is the person's own and permanent.
test.skip('yeet_fund on the ledger route: methods and the deposit watch pass through; the address is card-only; the model gets the "own permanent address" guidance',async()=>{
 const {DEPOSIT_META_KEY}=await import('../tool-registration.mjs');
 const {COPY}=await import('../guidance.mjs');
 const SOL='7iGsgjnCZweMbeC2Qrxj7zFaZhqV85rYLU5WgjHWiyKk';
 const own={default:'solana',networks:[{network:'solana',address:SOL}]},steps=['waiting','found','preparing','ready'];
 let fund={usdc:'3.2',presets:['10','25','50','100'],methods:['crypto'],card_deposit:own,watch:{steps,stage:'waiting'}};
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore:async route=>route==='/fund'?fund:core(route),env:ENV});
 const client=new Client({name:'ledger-fund-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 const reads=r=>JSON.stringify([r.structuredContent??null,r.content??null]);
 const call=async args=>{const r=await client.callTool({name:'yeet_fund',arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r.content));
  assert.doesNotMatch(reads(r),/7iGsgjn|WiyKk|card_deposit|yeet\/deposit/,'no part of the address where the model reads');return r};
 try{
  let r=await call({method:'crypto'});
  assert.deepEqual(r._meta[DEPOSIT_META_KEY],own);
  assert.deepEqual(r.structuredContent.methods,['crypto']);assert.deepEqual(r.structuredContent.watch,{steps,stage:'waiting'});assert.equal('fund_url' in r.structuredContent,false);
  assert.equal(r.structuredContent.guidance,COPY.yeet_fund_own.crypto);
  assert.match(r.structuredContent.guidance,/YEET/);assert.match(r.structuredContent.guidance,/Never write out an address/);assert.match(r.structuredContent.guidance,/reports back when the USDC arrives\.$/);
  // the card's own reads (no method) get the same
  assert.equal((await call({})).structuredContent.guidance,COPY.yeet_fund_own.crypto);
  // asked for a card payment: the answer still has no card payment, and the model says so
  r=await call({method:'card'});
  assert.equal(r.structuredContent.guidance,COPY.yeet_fund_own.no_card);assert.deepEqual(r.structuredContent.methods,['crypto']);
  fund={...fund,usdc:'4.2',watch:{steps,stage:'ready',arrived_usdc:'1'}};
  r=await call({});
  assert.equal(r.structuredContent.guidance,COPY.yeet_fund_own.ready);assert.equal(r.structuredContent.watch.arrived_usdc,'1');
  fund={...fund,watch:{steps,stage:'other_coin',coin:'SOL'}};
  assert.match((await call({})).structuredContent.guidance,/YEET/);
  fund={...fund,watch:{steps,stage:'other_coin'}};
  assert.match((await call({})).structuredContent.guidance,/\(another coin\)/);
  // not available yet (no partner key, or the set could not be made): no address, no watch, a plain line
  fund={usdc:'0',presets:['10','25','50','100'],methods:[]};
  r=await call({method:'crypto'});
  assert.equal(r._meta[DEPOSIT_META_KEY],undefined);assert.equal(r.structuredContent.guidance,COPY.yeet_fund_own.unavailable);
  // a watch that tries to carry an address fails closed: no result rather than an address
  fund={usdc:'3.2',presets:['10'],methods:['crypto'],card_deposit:own,watch:{steps,stage:'waiting',address:SOL}};
  const bad=await client.callTool({name:'yeet_fund',arguments:{}});
  assert.equal(bad.isError,true);assert.doesNotMatch(reads(bad),/7iGsgjn/);
  for(const k of Object.keys(COPY.yeet_fund_own)){assert.doesNotMatch(COPY.yeet_fund_own[k],/wallet|Base|Solana|device|expir|\bcode\b|email/i,k);assert.match(COPY.yeet_fund_own[k],/Never write out an address/,k)}
 }finally{await client.close();await server.close()}
});

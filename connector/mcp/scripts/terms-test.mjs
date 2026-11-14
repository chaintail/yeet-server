// Terms in the chat, at the connector: TERMS_REQUIRED from core becomes a typed refusal that carries the terms and
// tells the model what to do; yeet_terms and yeet_accept_terms; the overview's terms and win code; the card-only
// account for the device check; the old scope name.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {z} from 'zod';
import {createMcpServer,ACCOUNT_META_KEY} from '../tool-registration.mjs';
import {contract,zodSchema} from '../tool-contract.mjs';
import {COPY,termsGuidance} from '../guidance.mjs';
import {instructions} from '../instructions.mjs';
import {termsObject,TERMS_VERSION,REQUIRED_IDS,STATEMENTS} from '../../core/terms.mjs';
import {overview} from '../../core/overview.mjs';
import {allScopes} from '#scope-catalog';

const PAGE='https://chatgpt.yeet.win/account/terms';
const due=(mode='chat')=>termsObject(null,{mode,pageUrl:PAGE});
const done=()=>termsObject({accepted_at:Date.parse('2026-11-13T10:00:00Z')},{mode:'chat',pageUrl:PAGE});
const home={wallets:{base:{address:'0x'+'1'.repeat(40),usdc:'20'},solana:{address:'So1'.padEnd(44,'1')}},funding:{base_usdc:'20',solana_usdc:'0',chosen:'base'},ready:'ready',limits:{tier:'Noob'}};
const view=(terms,referral={status:'open',code:null,default_code:'WIN'})=>overview({home,username:'Lucky Otter 42',terms,referral});
async function connect(callCore,{scope=allScopes.join(' '),meta}={}){
 const server=createMcpServer({token:{scope,sub:'yeet-privy-a'},callCore,env:{}});
 const client=new Client({name:'terms-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close()},call:(name,args={})=>client.callTool({name,arguments:args,...(meta?{_meta:meta}:{})})};
}
const refuse=(extra={})=>{throw {error:'TERMS_REQUIRED',terms:due(),...extra}};

test('contract: the terms tools; accepting is not read-only and asks for the host’s approval; a card can never accept',()=>{
 const a=contract.tools.yeet_accept_terms,t=contract.tools.yeet_terms;
 assert.deepEqual(a.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false});
 assert.equal(a.visible,true);assert.equal(a.widgetAccessible,false);assert.equal(a.card,null);
 assert.deepEqual(t.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.match(a.description,/YEET/);assert.match(a.description,/YEET/);
 assert.match(a.description,/YEET/);
 assert.match(instructions,/yeet_accept_terms/);
 assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse({error:'TERMS_REQUIRED',message:'Accept the YEET terms in the chat to continue.',retryable:false,terms:due(),missing:['risk'],guidance:COPY.terms.missing}));
});

test("YEET text.",async()=>{
 const {call,close}=await connect(async()=>refuse());
 try{
  const calls={yeet_home:{},yeet_coins:{},yeet_portfolio:{},yeet_fund:{},yeet_referral:{},apply_referral:{skip:true},trade_status:{trade_id:'t_abcdefghij0123456789'},
   yeet_propose:{request_id:'11111111-1111-4111-8111-111111111111',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]},yeet_quote:{proposal_id:'p_abcdefghij0123456789'},
   execute_trade:{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)}};
  for(const [name,args] of Object.entries(calls)){
   const r=await call(name,args);
   assert.equal(r.isError,true,name);
   const body=JSON.parse(r.content[0].text);
   assert.equal(body.error,'TERMS_REQUIRED',`${name}: ${r.content[0].text.slice(0,120)}`);assert.equal(body.retryable,false);
   assert.equal(body.terms.accepted,false);assert.equal(body.terms.version,TERMS_VERSION);assert.equal(body.terms.terms_url,'https://yeet.win/terms');assert.equal(body.terms.privacy_url,'https://yeet.win/privacy');
   assert.deepEqual(body.terms.statements,STATEMENTS.map(s=>({...s})));
   for(const s of body.terms.statements)assert.match(s.url,/^https:\/\//,`${name} ${s.id}: its link`);
   assert.equal(body.terms.page_url,PAGE);assert.equal(body.terms.mode,'chat');
   assert.equal(body.guidance,termsGuidance(due()));
   // The same refusal for a card that only reads window.openai.toolOutput.
   assert.deepEqual(r.structuredContent,body,name);
   assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse(body),name);
  }
 }finally{await close()}
});

test('the guidance: show every statement with its link, accept only on the person’s own words, never for them; page mode sends them to the page',()=>{
 const g=COPY.terms.due_chat;
 assert.match(g,/has not accepted the current YEET terms/);assert.match(g,/YEET/);
 assert.match(g,/YEET/);
 assert.match(g,/YEET/);
 // The stale-app case (the tool is not in the model's list): refresh and say it again, never "it cannot be saved".
 assert.match(g,/YEET/);
 assert.match(termsGuidance(due()),/they refresh YEET at https:\/\/chatgpt\.com\/plugins and say it again/);
 assert.match(instructions,/YEET/);
 assert.match(instructions,/YEET/);
 // No text a person could be handed carries a raw id list or the version string.
 for(const t of [g,COPY.terms.missing,COPY.terms.version,COPY.terms.recorded,COPY.yeet_overview.terms_chat])assert.doesNotMatch(t,/2026-11-13|near_intents|no_advice/);
 assert.equal(termsGuidance(due('page')),COPY.terms.due_page);
 assert.match(COPY.terms.due_page,/YEET/);assert.match(COPY.terms.due_page,/YEET/);
 assert.equal(termsGuidance(due(),'missing'),COPY.terms.missing);assert.equal(termsGuidance(due(),'version'),COPY.terms.version);
 for(const [k,v] of Object.entries(COPY.terms)){assert.ok(v.length<=500,`${k}: ${v.length}`);assert.doesNotMatch(v,/\btap\b|\bsign(ing|ature)?\b/i,k)}
});

test('yeet_overview is not gated: it answers with terms.accepted false, the terms as its first suggestion and the terms guidance',async()=>{
 const {call,close}=await connect(async route=>{assert.equal(route,'/overview');return {...view(due()),card_account:{user:'did:privy:a',email:'luke@chaintail.xyz',masked:'l•••@c•••.xyz',google:false,apple:false,wallets:['0xabc']}}});
 try{
  const r=await call('yeet_overview');
  assert.equal(r.isError,undefined,JSON.stringify(r.content));
  const d=r.structuredContent;
  assert.equal(d.terms.accepted,false);assert.equal(d.terms.version,TERMS_VERSION);assert.equal(d.terms.statements.length,STATEMENTS.length);
  assert.deepEqual(d.suggestions[0],{id:'terms',label:'Review and accept the YEET terms',say:'Show me the YEET terms'});
  assert.equal(d.referral_open,false,'the win code waits for the terms');
  assert.match(d.guidance,/YEET/);assert.match(d.guidance,/each with its link/);
  // The connected account is for the card only: never in what the model reads.
  assert.deepEqual(r._meta[ACCOUNT_META_KEY],{user:'did:privy:a',email:'luke@chaintail.xyz',masked:'l•••@c•••.xyz',google:false,apple:false,wallets:['0xabc']});
  assert.doesNotMatch(JSON.stringify([r.structuredContent,r.content]),/chaintail|did:privy|card_account/);
 }finally{await close()}
});

test('after the terms: the overview offers the win code once, first; once applied or skipped it is gone',async()=>{
 let referral={status:'open',code:null,default_code:'WIN'};
 const {call,close}=await connect(async()=>view(done(),referral));
 try{
  let d=(await call('yeet_overview')).structuredContent;
  assert.equal(d.terms.accepted,true);assert.equal(d.referral_open,true);
  assert.deepEqual(d.suggestions[0],{id:'referral',label:'Got a win code?',say:'I have a win code'});
  assert.match(d.guidance,/YEET/);
  assert.match(d.guidance,/YEET/);
  for(const status of ['skipped','applied']){
   referral={status,code:status==='applied'?'WIN':null,default_code:'WIN'};
   d=(await call('yeet_overview')).structuredContent;
   assert.equal(d.referral_open,false,status);assert.ok(!d.suggestions.some(s=>s.id==='referral'),status);
  }
 }finally{await close()}
});

test('yeet_accept_terms: the happy path records through core with the conversation id and returns the overview; refusals are typed',async()=>{
 const seen=[];
 const {call,close}=await connect(async(route,body)=>{
  seen.push([route,body]);
  if(body.version!==TERMS_VERSION)refuse({reason:'version',missing:[...REQUIRED_IDS]});
  const missing=REQUIRED_IDS.filter(id=>!body.confirmed.includes(id));
  if(missing.length)refuse({reason:'missing',missing});
  return {terms:done(),overview:view(done())};
 },{meta:{'openai/session':'conv-42'}});
 try{
  const ok=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]});
  assert.equal(ok.isError,undefined,JSON.stringify(ok.content));
  assert.deepEqual(seen[0],['/terms/accept',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS],source:'chat',session:'conv-42'}]);
  assert.equal(ok.structuredContent.terms.accepted,true);assert.equal(ok.structuredContent.overview.username,'Lucky Otter 42');
  assert.equal(ok.structuredContent.guidance,COPY.terms.recorded);
  assert.match(ok.content[0].text,/^Recorded: the person accepted the YEET terms\. They are in\. Lucky Otter 42:/);
  assert.match(ok.structuredContent.guidance,/"Awesome, you’re in"/);assert.doesNotMatch(ok.structuredContent.guidance+ok.content.map(c=>c.text).join(' '),/unlock|6-digit|2026-11-13/i);
  // A missing statement: refused, named, nothing recorded.
  const short=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:REQUIRED_IDS.filter(id=>id!=='risk')});
  const b=JSON.parse(short.content[0].text);
  assert.equal(short.isError,true);assert.equal(b.error,'TERMS_REQUIRED');assert.deepEqual(b.missing,['risk']);assert.equal(b.guidance,COPY.terms.missing);
  // An old version: refused, with the current terms to show again.
  const old=await call('yeet_accept_terms',{version:'2026-10-01',confirmed:[...REQUIRED_IDS]});
  const o=JSON.parse(old.content[0].text);
  assert.equal(o.error,'TERMS_REQUIRED');assert.equal(o.terms.version,TERMS_VERSION);assert.equal(o.guidance,COPY.terms.version);
  // A call the model cannot make: no ids, or a malformed version, never reaches core.
  const n=seen.length;
  for(const bad of [{version:TERMS_VERSION,confirmed:[]},{version:'latest',confirmed:['terms']},{confirmed:['terms']}])assert.equal((await call('yeet_accept_terms',bad)).isError,true);
  assert.equal(seen.length,n);
 }finally{await close()}
});

test('yeet_terms: the statements and the status, read-only; the text the model reads lists each statement with its link',async()=>{
 let terms=due();
 const {call,close}=await connect(async route=>{assert.equal(route,'/terms');return {terms}});
 try{
  let r=await call('yeet_terms');
  assert.equal(r.structuredContent.terms.accepted,false);assert.equal(r.structuredContent.guidance,termsGuidance(due()));
  for(const s of STATEMENTS)assert.ok(r.content[0].text.includes(`${s.text} ${s.url}`),s.id);
  assert.match(r.content[0].text,/\[product_email, optional\]/);
  terms=done();r=await call('yeet_terms');
  assert.equal(r.structuredContent.terms.accepted,true);assert.equal(r.structuredContent.guidance,COPY.terms.accepted);
 }finally{await close()}
});

test('scopes: a token under the old name yeet:trade reaches the tools that need yeet:prepare; so does a new one; neither without it',async()=>{
 const args={proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)};
 assert.equal(contract.tools.execute_trade.scope,'yeet:prepare');assert.equal(contract.tools.submit_trade_signature.scope,'yeet:prepare');
 for(const [scope,reaches] of [['yeet:read yeet:write yeet:trade',true],['yeet:read yeet:write yeet:prepare',true],['yeet:read yeet:write',false]]){
  const routes=[];
  const {call,close}=await connect(async route=>{routes.push(route);throw {error:'CONFIRMATION_REQUIRED'}},{scope});
  try{
   const r=await call('execute_trade',args);
   assert.equal(JSON.parse(r.content[0].text).error,reaches?'CONFIRMATION_REQUIRED':'REAUTH_REQUIRED',scope);
   assert.deepEqual(routes,reaches?['/trades']:[],scope);
   if(!reaches)assert.equal(r._meta['mcp/www_authenticate'][0],'Bearer error="insufficient_scope", scope="openid offline_access yeet:read yeet:write yeet:prepare"');
  }finally{await close()}
 }
});

// ---- Founder, 2026-11-14 (a real ChatGPT session): the model said the app "doesn't expose an action" to save the
// acceptance, then talked about unlocking a wallet with a code that was nowhere. ----
test('yeet_accept_terms is in tools/list for every scope set and state, and the model may call it (never card-only)',async()=>{
 for(const scope of ['yeet:prepare yeet:trade','yeet:read yeet:write yeet:prepare yeet:trade','yeet:read','',allScopes.join(' ')]){
  for(const env of [{},{YEET_P2:'1'},{YEET_TERMS_MODE:'page'}]){
   const server=createMcpServer({token:{scope,sub:'yeet-privy-a'},callCore:async()=>({terms:due()}),env});
   const client=new Client({name:'terms-list',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
   await server.connect(a);await client.connect(b);
   try{
    const t=(await client.listTools()).tools.find(t=>t.name==='yeet_accept_terms');
    assert.ok(t,`listed for "${scope}" ${JSON.stringify(env)}`);
    assert.deepEqual(t._meta.ui.visibility,['model','app']);assert.equal(t._meta['openai/visibility'],undefined,'not private');
    assert.deepEqual(t.inputSchema.required,['version','confirmed']);
    assert.ok((await client.listTools()).tools.some(t=>t.name==='yeet_terms'));
   }finally{await client.close();await server.close()}
  }
 }
});

test('yeet_accept_terms records for a token with read, write and the old trade scope; without yeet:write it asks to connect again, never "cannot save"',async()=>{
 const core=async()=>({terms:done(),overview:view(done())});
 for(const [scope,ok] of [['yeet:read yeet:write yeet:trade',true],['yeet:read yeet:write yeet:prepare',true],['yeet:prepare yeet:trade',false]]){
  const {call,close}=await connect(core,{scope});
  try{
   const r=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]});
   if(ok){assert.equal(r.isError,undefined,scope);assert.equal(r.structuredContent.terms.accepted,true)}
   else{assert.equal(r.isError,true);assert.equal(JSON.parse(r.content[0].text).error,'REAUTH_REQUIRED',scope)}
  }finally{await close()}
 }
});

test('nothing the model reads before a trade lets it talk about unlocking, devices or codes: the overview, the terms and the acceptance',async()=>{
 const NOT=/unlock|locked|6-digit|one-time code|device|needs_card_sign_in|sign.?in|wallet_unlocked/i;
 const visible=r=>JSON.stringify(r.structuredContent,(k,v)=>k==='statements'?undefined:v)+' '+r.content.map(c=>c.text.replace(/Statements: .*$/,'')).join(' ');
 // (What the model is told never to mention is not something it is told about.)
 const told=r=>visible(r).replace(/Never mention[^.]*\./g,'');
 const {call,close}=await connect(async(route)=>route==='/overview'?{...view(due()),card_account:{user:'did:privy:a',email:'a@b.example',masked:'a•••@b•••.example',google:false,wallets:[]}}:route==='/terms'?{terms:due()}:{terms:done(),overview:view(done())});
 try{
  for(const [name,args] of [['yeet_overview',{}],['yeet_terms',{}],['yeet_accept_terms',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}]]){
   const r=await call(name,args);
   const read=told(r);
   assert.doesNotMatch(read,NOT,name);assert.doesNotMatch(read,/a@b\.example|did:privy/,`${name}: the account stays card-only`);
  }
 }finally{await close()}
 assert.doesNotMatch(instructions,/6-digit|one-time code/i);
 assert.match(instructions,/YEET/);
 for(const t of Object.values(contract.tools))assert.doesNotMatch(t.title+' '+t.description,/unlock|6-digit/i,t.title);
});

test('after the terms: "Awesome, you’re in", then the username, how to win, what is hot, something to YEET, and the daily spin while one waits',async()=>{
 const {welcomeSuggestions}=await import('../../core/overview.mjs');
 const after={...view(done()),suggestions:welcomeSuggestions({named:false,checkinOpen:true})};
 const {call,close}=await connect(async()=>({terms:done(),overview:after}));
 try{
  const r=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]});
  assert.deepEqual(r.structuredContent.overview.suggestions.map(s=>s.say),['Pick my username','How do I win?','What’s hot right now?','I know what I want to YEET','Do my daily check-in']);
  assert.equal(r.structuredContent.guidance,COPY.terms.recorded);
  assert.match(r.structuredContent.guidance,/YEET/);assert.match(r.structuredContent.guidance,/YEET/);
  assert.match(r.content[0].text,/Offer next: Pick my username \("Pick my username"\); How do I win\? /);
 }finally{await close()}
});

test('the profile is the model’s to manage: yeet_profile reads name, XP, tier and streak and nothing else; a rename is followed by the welcome card with the new name',async()=>{
 let name='Lucky Otter 42';
 const {call,client,close}=await connect(async(route,body)=>{
  if(route==='/username'){name=body.username;return {username:name}}
  return {...overview({home,username:name,terms:done(),xp:{total:120,streak_days:4,spin_available:false}}),card_account:{user:'did:privy:a',email:'a@b.example'}};
 });
 try{
  const p=await call('yeet_profile');
  assert.deepEqual(Object.keys(p.structuredContent).sort(),['guidance','streak_days','tier','username','xp']);
  assert.equal(p.content[0].text,'Profile: Lucky Otter 42, 120 XP (Noob), 4-day streak.');
  assert.doesNotMatch(JSON.stringify({s:p.structuredContent,c:p.content}),/0x1111|So1|a@b\.example|usdc/i,'no wallet, no address, no email, no balance');
  assert.match(p.structuredContent.guidance,/YEET/);
  const s=await call('yeet_set_username',{username:'kat_king'});
  assert.match(s.structuredContent.guidance,/YEET/);
  const o=await call('yeet_overview');
  assert.equal(o.structuredContent.username,'kat_king','the welcome card reads the new name');
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==='yeet_overview')._meta['openai/outputTemplate'],'ui://yeet/overview-v1.html');
  assert.equal(tools.find(t=>t.name==='yeet_profile')._meta['openai/outputTemplate'],undefined,'the profile is not a card');
  assert.equal(tools.find(t=>t.name==='yeet_set_username')._meta['openai/outputTemplate'],undefined,'the username is not a card');
  assert.match(contract.tools.yeet_set_username.description,/YEET/);
 }finally{await close()}
});

test("YEET text.",()=>{
 assert.match(instructions,/YEET/);
 // Every tool named there re-renders the current state: read-only, or idempotent on the same proposal.
 for(const n of ['trade_status','yeet_checkin','lucky_wheel','yeet_fund','yeet_referral'])assert.equal(contract.tools[n].annotations.readOnlyHint,true,n);
 assert.equal(contract.tools.yeet_quote.annotations.idempotentHint,true);assert.ok(contract.tools.yeet_quote.card&&contract.tools.yeet_quote.visible);
 const all=Object.values(COPY).flatMap(g=>Object.values(g));
 for(const t of all)assert.doesNotMatch(t,/card above|above card|earlier message|previous message|scroll (up|back)/i,t.slice(0,60));
});

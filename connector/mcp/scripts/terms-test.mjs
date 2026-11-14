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
import {COPY,UI,termsGuidance,consentNote,nextNote,uiFor} from '../guidance.mjs';
import {instructions,LAYOUT_LINE} from '../instructions.mjs';
import {termsObject,TERMS_VERSION,REQUIRED_IDS,STATEMENTS} from '../../core/terms.mjs';
import {overview} from '../../core/overview.mjs';
import {allScopes} from '#scope-catalog';

const PAGE='https://chatgpt.yeet.win/account/terms';
/** The confirmation rule (owner, 2026-11-14, after a live test): a ticked checkbox list plus Accept is the person's confirmation. */
const CONFIRM_RULE="YEET CONFIRM_RULE.";
/** The sentence that made the model refuse a ticked checkbox list: gone everywhere. */
const OLD_RULE="YEET OLD_RULE.";
const due=(mode='chat')=>termsObject(null,{mode,pageUrl:PAGE});
const done=()=>termsObject({accepted_at:Date.parse('2026-11-13T10:00:00Z')},{mode:'chat',pageUrl:PAGE});
const home={wallets:{base:{address:'0x'+'1'.repeat(40),usdc:'20'},solana:{address:'So1'.padEnd(44,'1')}},funding:{base_usdc:'20',solana_usdc:'0',chosen:'base'},ready:'ready',limits:{tier:'Noob'}};
const view=(terms,referral={status:'open',code:null,default_code:'WIN'})=>overview({home,username:'Lucky Otter 42',terms,referral});
async function connect(callCore,{scope=allScopes.join(' '),meta}={}){
 const server=createMcpServer({token:{scope,sub:'yeet-privy-a'},callCore,env:{}});
 const client=new Client({name:'terms-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 // The model's own entry call carries the current tools version, as its schema tells it to.
 return {client,close:async()=>{await client.close();await server.close()},call:(name,args={})=>client.callTool({name,arguments:name==='yeet_overview'?{app_version:contract['x-yeet-app'].tools_version,...args}:args,...(meta?{_meta:meta}:{})})};
}
const refuse=(extra={})=>{throw {error:'TERMS_REQUIRED',terms:due(),...extra}};

test('contract: the terms tools; accepting is not read-only and asks for the host’s approval; a card can never accept',()=>{
 const a=contract.tools.yeet_accept_terms,t=contract.tools.yeet_terms;
 // It adds one record and a first acceptance stands: a write that destroys nothing.
 assert.deepEqual(a.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.equal(a.visible,true);assert.equal(a.widgetAccessible,false);assert.equal(a.card,null);
 assert.deepEqual(t.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.ok(a.description.includes(` ${CONFIRM_RULE} `),a.description);assert.match(a.description,/YEET/);
 assert.match(a.description,/YEET/);
 assert.match(instructions,/yeet_accept_terms/);
 assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse({error:'TERMS_REQUIRED',message:'Accept the YEET terms in the chat to continue.',retryable:false,terms:due(),missing:['risk'],guidance:COPY.terms.missing}));
});

// Review 2026-11-14, item 2: a TERMS_REQUIRED result that carried structuredContent was rejected by an MCP client with
// -32602 (it checks any structuredContent against the tool's output schema, error or not). Every tool the contract
// lets answer TERMS_REQUIRED is called through a client that has read tools/list, so the SDK client applies exactly
// that check, and the same rules are applied here by hand against the advertised schema.
const ARGS={yeet_coin:{symbol:'WIF'},yeet_accept_terms:{version:TERMS_VERSION,confirmed:REQUIRED_IDS},apply_referral:{skip:true},trade_status:{trade_id:'t_abcdefghij0123456789'},
 yeet_propose:{request_id:'11111111-1111-4111-8111-111111111111',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]},yeet_quote:{proposal_id:'p_abcdefghij0123456789'},
 skeet_propose:{request_id:'22222222-2222-4222-8222-222222222222',legs:[{symbol:'WIF',percent:100}]},
 execute_trade:{proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'a'.repeat(43)},
 submit_trade_signature:{trade_id:'t_abcdefghij0123456789',leg:0,attempt_id:'a'.repeat(64),signed:'AQID'},
 lucky_spin:{lucky_id:'l_abcdefghij0123456789'},yeet_set_username:{username:'kat_king'}};
test('a TERMS_REQUIRED result of every tool passes an MCP client’s output schema rules: an error, the text, no structuredContent',async()=>{
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'yeet-privy-a'},callCore:async()=>refuse(),env:{YEET_P2:'1',YEET_HOW_IT_WORKS:'1'}});
 const client=new Client({name:'schema-rules',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const {tools}=await client.listTools();   // the client now holds every tool's output schema and checks results against it
  const gated=Object.entries(contract.tools).filter(([,t])=>t.errors.includes('TERMS_REQUIRED')).map(([n])=>n);
  assert.deepEqual(gated.sort(),Object.keys(contract.tools).filter(n=>n!=='yeet_overview'&&n!=='yeet_terms'&&n!=='yeet_how_it_works').sort());
  assert.deepEqual(tools.map(t=>t.name).sort(),Object.keys(contract.tools).sort());
  for(const name of gated){
   const listed=tools.find(t=>t.name===name);assert.equal(listed.outputSchema.type,'object',name);
   const input=zodSchema(z,contract.tools[name].inputSchema).safeParse(ARGS[name]??{});assert.ok(input.success,`${name}: the arguments of this check are valid`);
   // The SDK client throws McpError -32602 here when structuredContent is present and does not fit.
   const r=await client.callTool({name,arguments:ARGS[name]??{}});
   assert.equal(r.isError,true,name);
   assert.equal(Object.hasOwn(r,'structuredContent'),false,`${name}: an error result carries no structuredContent`);
   // The client's rules, by hand: with an output schema, structuredContent is required unless isError, and checked whenever present.
   if(r.structuredContent!==undefined)assert.ok(zodSchema(z,contract.tools[name].outputSchema).safeParse(r.structuredContent).success,name);
   // The JSON, then the consent layout as its own text block (guidance.mjs UI.consent).
   assert.equal(r.content.length,2,name);assert.equal(r.content[0].type,'text',name);assert.deepEqual(r.content[1],{type:'text',text:consentNote()},name);
   const body=JSON.parse(r.content[0].text);
   assert.equal(body.error,'TERMS_REQUIRED',`${name}: ${r.content[0].text.slice(0,160)}`);assert.equal(typeof body.message,'string');assert.equal(body.terms.version,TERMS_VERSION);
   assert.equal(body.guidance,termsGuidance(due()),name);
   assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse(body),name);
  }
  // The other way round: the check does bite. A structuredContent of that shape fails every one of these output schemas.
  for(const name of gated)assert.equal(zodSchema(z,contract.tools[name].outputSchema).safeParse({error:'TERMS_REQUIRED',message:'x',retryable:false,terms:due()}).success,false,name);
 }finally{await client.close();await server.close()}
});
test('yeet_accept_terms answering TERMS_REQUIRED (statements missing) carries the missing ids in the text only',async()=>{
 const {call,close}=await connect(async()=>refuse({missing:['risk'],reason:'missing'}));
 try{
  const r=await call('yeet_accept_terms',{version:TERMS_VERSION,confirmed:REQUIRED_IDS});
  assert.equal(r.isError,true);assert.equal(Object.hasOwn(r,'structuredContent'),false);
  const body=JSON.parse(r.content[0].text);assert.deepEqual(body.missing,['risk']);assert.equal(body.guidance,COPY.terms.missing);
  assert.equal(r._meta['yeet/failure'].missing,undefined,'the card draws one line; ids stay in the text');
 }finally{await close()}
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
   // No structuredContent on an error (the output schema describes the success only). Card only: what a card draws.
   assert.equal(Object.hasOwn(r,'structuredContent'),false,name);
   assert.deepEqual(r._meta,{'yeet/failure':{error:'TERMS_REQUIRED',message:body.message,terms:{mode:'chat',page_url:PAGE}}},name);
   assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse(body),name);
  }
 }finally{await close()}
});

test('the guidance: show every statement with its link, accept only on the person’s own words, never for them; page mode sends them to the page',()=>{
 const g=COPY.terms.due_chat;
 assert.match(g,/has not accepted the current YEET terms/);
 // Owner, 2026-11-14: a checkbox for every item, never one button that accepts all of them.
 for(const t of [g,COPY.yeet_overview.terms_chat]){
  // 2026-11-14 (live test): a ticked checkbox list plus Accept is the confirmation; the layout note has the details.
  assert.match(t,/YEET/);
  assert.match(t,/YEET/);
  assert.doesNotMatch(t,/one by one/);
  assert.doesNotMatch(t,/all of them/);
 }
 assert.match(COPY.terms.missing,/YEET/);
 // The stale-app case (the tool is not in the model's list): refresh and say it again, never "it cannot be saved".
 assert.match(g,/YEET/);
 assert.match(termsGuidance(due()),/they refresh YEET at https:\/\/chatgpt\.com\/plugins\?directoryTab=personal and say it again/);
 assert.match(instructions,/YEET/);
 assert.match(instructions,/YEET/);
 assert.doesNotMatch(instructions,/all of them/);
 // No text a person could be handed carries a raw id list or the version string.
 for(const t of [g,COPY.terms.missing,COPY.terms.version,COPY.terms.recorded,COPY.yeet_overview.terms_chat])assert.doesNotMatch(t,/2026-11-1[345]|near_intents|eligibility|no_advice/);
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
  assert.match(d.guidance,/YEET/);assert.match(d.guidance,/YEET/);
  // The connected account is for the card only: never in what the model reads.
  assert.deepEqual(r._meta[ACCOUNT_META_KEY],{user:'did:privy:a',email:'luke@chaintail.xyz',masked:'l•••@c•••.xyz',google:false,apple:false,wallets:['0xabc']});
  assert.doesNotMatch(JSON.stringify([r.structuredContent,r.content]),/chaintail|did:privy|card_account/);
 }finally{await close()}
});

test('after the terms: no win code button on the overview (owner ruling 2026-11-14), open, applied or skipped',async()=>{
 let referral={status:'open',code:null,default_code:'WIN'};
 const {call,close}=await connect(async()=>view(done(),referral));
 try{
  let d=(await call('yeet_overview')).structuredContent;
  assert.equal(d.terms.accepted,true);assert.equal(d.referral_open,true);
  assert.ok(!d.suggestions.some(s=>s.id==='referral'),'open: the core still lists it, the connector leaves it out');
  assert.doesNotMatch(d.guidance,/win code/);
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
 // Every tool named there re-renders the current state and destroys nothing. Three are plain reads. The status may
 // credit XP once and the lucky wheel saves today's wheel once (not read-only, the same again on a repeat); a quote
 // saves a new revision each time (review 2026-11-14, item 4: the hints say what a call does).
 for(const n of ['yeet_checkin','yeet_fund','yeet_referral'])assert.equal(contract.tools[n].annotations.readOnlyHint,true,n);
 for(const n of ['trade_status','lucky_wheel'])assert.deepEqual(contract.tools[n].annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},n);
 assert.deepEqual(contract.tools.yeet_quote.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false});assert.ok(contract.tools.yeet_quote.card&&contract.tools.yeet_quote.visible);
 const all=Object.values(COPY).flatMap(g=>Object.values(g));
 for(const t of all)assert.doesNotMatch(t,/card above|above card|earlier message|previous message|scroll (up|back)/i,t.slice(0,60));
});

// ---- The layout notes (owner, 2026-11-14, after a test in ChatGPT): consent, and the next steps once recorded. Each
// rides as its own text block; never in structuredContent or guidance. Owner ruling: no "Select all" of any kind. ----
const CONSENT=UI.consent;
/** Every mention of a select-all or accept-all control, as a sentence: each one must say there is none. */
const allControls=t=>t.split(/(?<=[.!?:;])\s+/).filter(x=>/select[- ]?all|accept[- ]?all|clear all/i.test(x));
test('consent layout: the contract, verbatim parts; plain; no select-all or accept-all offered anywhere',()=>{
 assert.equal(consentNote(),CONSENT);
 for(const part of [
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
  /YEET/,
 ])assert.match(CONSENT,part);
 assert.doesNotMatch(CONSENT,/playful|degen|joke(?!s\))|riff|Style:/i);
 // Nowhere is a select-all or accept-all offered: every sentence that names one says there is none.
 const texts=[...Object.values(UI),...Object.values(COPY).flatMap(Object.values),instructions,LAYOUT_LINE,nextNote(),...Object.values(contract.tools).map(t=>t.description)];
 for(const t of texts)for(const x of allControls(t))assert.match(x,/\bno\b|\bnever\b/i,`offered as a control: ${x}`);
 assert.match(LAYOUT_LINE,/YEET/);assert.ok(instructions.includes(LAYOUT_LINE));
});

test('consent layout on the overview and yeet_terms while the terms are due in the chat, and on TERMS_REQUIRED; never in page mode, once accepted or in structuredContent',async()=>{
 for(const [name,r] of [['yeet_overview',view(due())],['yeet_terms',{terms:due()}]])assert.equal(uiFor(name,r),CONSENT,name);
 for(const [name,r] of [['yeet_overview',view(due('page'))],['yeet_terms',{terms:due('page')}],['yeet_terms',{terms:done()}],['yeet_overview',view(done())],['yeet_accept_terms',{terms:done(),overview:null}],['yeet_coins',{coins:[]}]])assert.notEqual(uiFor(name,r),CONSENT,name);
 let terms=due();
 const {call,close}=await connect(async route=>route==='/overview'?view(terms):route==='/terms'?{terms}:refuse({terms}));
 try{
  for(const name of ['yeet_overview','yeet_terms']){
   const r=await call(name);
   assert.equal(r.isError,undefined,name);assert.equal(r.content.filter(b=>b.text===CONSENT).length,1,name);
   assert.equal(r.content.at(-1).text,CONSENT,`${name}: the consent layout comes last, no style reminder after it`);
   assert.doesNotMatch(JSON.stringify(r.structuredContent),/YEET consent layout|Required agreements/,name);
   assert.ok(!r.content.some(b=>/^YEET welcome layout|^Style:/.test(b.text)),`${name}: only the consent flow`);
  }
  const g=await call('yeet_coins');
  assert.equal(g.isError,true);assert.equal(g.content[1].text,CONSENT,'a gated tool answering TERMS_REQUIRED');
  terms=due('page');
  for(const name of ['yeet_overview','yeet_terms','yeet_coins'])assert.ok(!(await call(name)).content.some(b=>b.text===CONSENT),`${name}: page mode accepts on the page`);
  terms=done();
  for(const name of ['yeet_overview','yeet_terms'])assert.ok(!(await call(name)).content.some(b=>b.text===CONSENT),`${name}: accepted`);
 }finally{await close()}
});

test('next steps once recorded: congratulate, then exactly four buttons (the wheel first while it is registered), with no extra overview call',async()=>{
 const four=nextNote({tools:new Set(['yeet_checkin','yeet_coins','yeet_portfolio'])});
 assert.equal(nextNote(),four,'every tool there');
 assert.match(four,/YEET/);
 assert.match(four,/YEET/);
 // Owner ruling 2026-11-14: the tour is the first-steps note's (guidance firstNote); the next steps end with the closing line.
 assert.doesNotMatch(four,/show me around/i);
 assert.match(four,/YEET/);
 const three=nextNote({tools:new Set(['yeet_coins','yeet_portfolio'])});
 assert.match(three,/exactly these three buttons/);assert.doesNotMatch(three,/wheel|yeet_checkin/,'never a button for a tool that is not registered');
 assert.doesNotMatch(four.replace(UI.closing,''),/playful|degen|joke|riff/i,'plain apart from the closing line');
 // Through the server: the accept result carries it, after the guidance; the refusals and the other results never do.
 for(const env of [{},{YEET_P2:'1'}]){
  const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'yeet-privy-a'},callCore:async route=>route==='/terms/accept'?{terms:done(),overview:view(done())}:route==='/overview'?view(done()):{terms:done()},env});
  const client=new Client({name:'terms-next',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
  try{
   const r=await client.callTool({name:'yeet_accept_terms',arguments:{version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}});
   assert.equal(r.isError,undefined);
   const want=env.YEET_P2?four:three;
   assert.equal(r.content.length,3);assert.equal(r.content[1].text,r.structuredContent.guidance);assert.equal(r.content[2].text,want,JSON.stringify(env));
   assert.match(r.structuredContent.guidance,/YEET/);
   assert.doesNotMatch(JSON.stringify(r.structuredContent),/YEET next steps/);
   for(const name of ['yeet_terms','yeet_overview']){const o=await client.callTool({name,arguments:name==='yeet_overview'?{app_version:contract['x-yeet-app'].tools_version}:{}});assert.ok(!o.content.some(b=>/^YEET next steps/.test(b.text)),name)}
  }finally{await client.close();await server.close()}
 }
});

test("YEET text.",async()=>{
 const {readFileSync}=await import('node:fs');
 const files=['../descriptions.private.json','../guidance.mjs','../instructions.mjs','../tool-registration.mjs','../errors.mjs','../../../docs/TERMS-IN-CHAT.md'];
 for(const f of files){const t=readFileSync(new URL(f,import.meta.url),'utf8');assert.ok(!t.includes(OLD_RULE),f);if(!f.endsWith('.md'))assert.doesNotMatch(t,/never (from )?a single accept-all/,f)}
 assert.ok(readFileSync(new URL('../../../docs/TERMS-IN-CHAT.md',import.meta.url),'utf8').replace(/\s+/g,' ').includes(CONFIRM_RULE));
 const texts=[instructions,...Object.values(COPY).flatMap(Object.values),...Object.values(UI),...Object.values(contract.tools).map(t=>t.description)];
 for(const t of texts)assert.ok(!t.includes(OLD_RULE)&&!/confirm(ed)? (each required one|them) .*one by one/.test(t),t.slice(0,80));
 assert.equal(contract.tools.yeet_accept_terms.description,`YEET text: ${CONFIRM_RULE}.`);
 // The result text alone is enough to record after the gated checkbox confirmation (a description reaches ChatGPT only
 // after a refresh): the consent note that rides the overview, yeet_terms and TERMS_REQUIRED says so.
 assert.match(consentNote(),/YEET/);
 assert.match(consentNote(),/YEET/);
 for(const t of [COPY.terms.due_chat,COPY.yeet_overview.terms_chat])assert.match(t,/YEET/);
});

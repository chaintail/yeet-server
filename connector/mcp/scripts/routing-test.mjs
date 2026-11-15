// Tool routing and follow-ups (owner brief 2026-11-15). ChatGPT cannot run in a test, so scenarios A to E are checked
// on what the server SENDS: the registered tool descriptions and server instructions (routing: a coin question goes to
// yeet_coin, the native card is the view, no duplicate UI) and the result text (the coin card's brief-explanation and
// stamp lines; the spin reminder offer with exactly two choices, only on a successful spin, never on opening the
// check-in card or on a refused spin).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer,registeredTools} from '../tool-registration.mjs';
import {CARD_BUILD} from '../refresh.mjs';
import {COPY,UI,guidanceFor,uiFor,reminderDue} from '../guidance.mjs';
import {instructions,instructionsFor} from '../instructions.mjs';
import {allScopes} from '#scope-catalog';

const P2={YEET_P2:'1'};
const REMIND_9="YEET REMIND_9.",OTHER_TIME='"Choose another time"';
const NOT_NOW=/not now|dismiss(al)? (button|control)|maybe later/i;
const ARROWS=/[←-⇿⟰-⟿⤀-⥿⬀-⯿]/;

const coin=(symbol,over={})=>({symbol,name:symbol.toLowerCase(),kind:'meme',price_usd:'0.0123',change_pct:{h1:0.5,h6:-1.2,h24:3.4},as_of:'2026-11-15T09:00:00Z',market_cap_usd:1000000,volume_24h_usd:50000,liquidity_usd:200000,
 description:`${symbol} is a meme coin.`,website:null,x:null,holding:null,limits:{min_leg_usdc:'3',max_trade_usdc:'25',max_legs:5,default_usdc:'20'},
 suggestions:[{id:'research',label:`Research ${symbol} deeper`,say:`Research ${symbol} deeper`},{id:'yeet',label:`YEET ${symbol}`,say:`YEET ${symbol}`},{id:'moving',label:'What else is moving?',say:'What else is moving?'}],...over});
const spin=(over={})=>({xp_won:30,draw_xp:25,streak_xp:0,total:135,streak_days:3,next_spin_at:'2026-11-16T00:00:00Z',stamp:{coin:'BOME',count_after:2,slots:7,card:1,filled:2,set_completed:false},set_bonus_xp:0,spins_available:0,spin_reason:null,...over});

async function connect(callCore,env=P2){
 const server=createMcpServer({token:{scope:allScopes.join(' '),sub:'routing-test'},callCore,env,log:()=>{}});
 const client=new Client({name:'routing-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close()}};
}
const listed=async()=>{const {client,close}=await connect(async()=>({}));try{return Object.fromEntries((await client.listTools()).tools.map(t=>[t.name,t]))}finally{await close()}};
const allText=r=>JSON.stringify(r);

test('Scenario A, coin discovery: "What is BOME?" after a BOME stamp routes to yeet_coin, which answers with the card and a brief explanation',async()=>{
 const tools=await listed();
 const d=tools.yeet_coin.description;
 assert.match(d,/YEET/);
 assert.match(d,/YEET/);
 assert.match(d,/'What is BOME\?'/);
 assert.match(d,/YEET/);
 assert.match(d,/YEET/);
 // The check-in card's description sends a stamp's coin there too, and so do the server instructions.
 assert.match(tools.yeet_checkin.description,/YEET/);
 assert.match(instructions,/YEET/);
 // The call itself: the symbol as the person wrote it, one GET, the card and the guidance the model reads.
 const routes=[];
 const {client,close}=await connect(async route=>{routes.push(route);return coin('BOME')});
 try{
  const r=await client.callTool({name:'yeet_coin',arguments:{symbol:'BOME'}});
  assert.equal(r.isError,undefined,allText(r.content));assert.deepEqual(routes,['/coins/BOME']);
  const g=r.structuredContent.guidance;
  assert.match(g,/YEET/);
  assert.match(g,/YEET/);
  assert.equal(r.content.at(-1).text,COPY.style.card);
 }finally{await close()}
});

test('Scenario B, conversational reference: "What\'s this one about?" after a PENGU stamp is covered, and the symbol resolves to PENGU',async()=>{
 const tools=await listed();
 for(const phrase of ["'Tell me about this coin'","YEET 2.","'Is this token doing well?'"])assert.ok(tools.yeet_coin.description.includes(phrase),phrase);
 assert.match(tools.yeet_coin.description,/YEET/);
 assert.match(tools.yeet_coins.description,/YEET/);
 assert.match(instructions,/YEET/);
 // Whichever way the model writes the symbol it resolved, the card is for PENGU.
 const routes=[];
 const {client,close}=await connect(async route=>{routes.push(route);return coin('PENGU')});
 try{
  for(const symbol of ['PENGU','pengu','$PENGU']){const r=await client.callTool({name:'yeet_coin',arguments:{symbol}});assert.equal(r.isError,undefined,symbol)}
  assert.deepEqual(routes,['/coins/PENGU','/coins/PENGU','/coins/PENGU']);
 }finally{await close()}
});

test('Scenario C, reminder suggestion: a successful spin carries the two choices, no dismissal one; never the check-in card or a refused spin',async()=>{
 assert.ok(UI.reminder.includes(`YEET text: ${REMIND_9} ${OTHER_TIME}.`));
 assert.match(UI.reminder,/YEET/);
 assert.doesNotMatch(UI.reminder,NOT_NOW);assert.doesNotMatch(UI.reminder,ARROWS);
 
 assert.doesNotMatch(UI.reminder,/will (show|render)|always shows/i);
 let answer=spin(),refuse=null;
 const {client,close}=await connect(async route=>{
  if(route==='/spin'){if(refuse)throw refuse;return answer}
  return {};
 });
 try{
  const ok=await client.callTool({name:'daily_spin',arguments:{card_build:CARD_BUILD}});
  assert.equal(ok.isError,undefined,allText(ok.content));
  assert.equal(ok.content.filter(b=>b.text===UI.reminder).length,1,'the reminder note, once, as its own text block');
  assert.match(ok.structuredContent.guidance,/YEET/);
  assert.ok(!JSON.stringify(ok.structuredContent).includes(UI.reminder),'never in structuredContent');
  assert.doesNotMatch(allText(ok),NOT_NOW);
  // A spin still waiting, a streak of 1: no offer yet.
  for(const over of [{spins_available:1},{streak_days:1}]){
   answer=spin(over);const r=await client.callTool({name:'daily_spin',arguments:{card_build:CARD_BUILD}});
   assert.equal(r.isError,undefined);assert.doesNotMatch(allText(r),/Remind me daily|reminder note/,JSON.stringify(over));
  }
  // A refused spin: no offer.
  refuse={error:'TEMPORARILY_UNAVAILABLE'};
  const bad=await client.callTool({name:'daily_spin',arguments:{card_build:CARD_BUILD}});
  assert.equal(bad.isError,true);assert.doesNotMatch(allText(bad),/Remind me daily|reminder/i);
  refuse=null;
 }finally{await close()}
 // Opening the check-in card, with a spin waiting or already done at a long streak: never the offer.
 for(const checkin of [{total:5,streak_days:3,spin_available:true,spins_available:1},{total:9,streak_days:12,spin_available:false,spins_available:0}]){
  assert.doesNotMatch(guidanceFor('yeet_checkin',{checkin},{tools:new Set(registeredTools(P2).map(t=>t.name))}),/reminder/i);
  assert.equal(uiFor('yeet_checkin',{checkin}),undefined);
 }
 assert.equal(reminderDue({checkin:{streak_days:5,spins_available:0}}),false,'a check-in shape is not a spin');
});

test('Scenario D, custom reminder time: "Choose another time" asks for the time, then uses ChatGPT\'s own scheduled tasks after their choice',()=>{
 assert.ok(UI.reminder.includes(`YEET text: ${OTHER_TIME}.`));
 assert.ok(UI.reminder.includes(`YEET text: ${REMIND_9}.`));
 assert.match(UI.reminder,/YEET/);
 assert.match(UI.reminder,/YEET/);
 // The same two choices in the server instructions, keyed on the spin (the card's own report reaches the model as a
 // 'YEET card:' message, so the instructions say how to offer what it suggests).
 for(const ins of [instructions,instructionsFor({YEET_HOW_IT_WORKS:'1'})]){
  assert.ok(ins.includes("YEET text."));
  assert.match(ins,/YEET/);
  assert.match(ins,/YEET/);
 }
});

test('Scenario E, no duplicate UI: the native card is the view; no generic image, custom price card or dashboard; no tool says otherwise',async()=>{
 const tools=await listed();
 assert.match(tools.yeet_coin.description,/YEET/);
 assert.match(instructions,/YEET/);
 assert.match(instructions,/YEET/);
 // The card-backed results get the card style line (no chart or table of the model's own), not the general one.
 for(const name of ['yeet_coin','yeet_checkin','daily_spin','lucky_wheel','lucky_spin'])assert.doesNotMatch(COPY.style.card,/chart or table built/,name);
 assert.match(COPY.style.card,/YEET/);
 // Follow-ups stay in YEET from the entry card and the wheels.
 assert.match(tools.yeet_overview.description,/YEET/);
 assert.match(tools.lucky_wheel.description,/YEET/);
 // No contradiction: no tool description asks for images or a dashboard, and none offers a dismissal control.
 for(const [name,t] of Object.entries(tools)){
  assert.doesNotMatch(t.description,/(show|fetch|generate|find) (an? )?(image|logo|picture)|build (a|your own) (dashboard|price card)/i,name);
  assert.doesNotMatch(t.description,NOT_NOW,name);assert.doesNotMatch(t.description,ARROWS,name);
 }
 for(const text of [instructions,...Object.values(UI),...Object.values(COPY).flatMap(Object.values)])assert.doesNotMatch(text,NOT_NOW,text.slice(0,60));
});

test('the tool count is unchanged by the routing words (18, 23 with P2, 24 with how-it-works, as at e808287)',()=>{
 assert.equal(registeredTools({}).length,18);assert.equal(registeredTools(P2).length,23);assert.equal(registeredTools({...P2,YEET_HOW_IT_WORKS:'1'}).length,24);
});

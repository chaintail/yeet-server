// Agent guidance (mcp/guidance.mjs): the owner's wording rules over every string, one check per state, and the field
// in real tool results (structuredContent, the text the model reads, refusals) through the registered server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {COPY,TIER_XP,GUIDED_TOOLS,guidanceFor,refusalGuidance,fill} from '../guidance.mjs';
import {createMcpServer} from '../tool-registration.mjs';
import {CARD_BUILD} from '../refresh.mjs';
import {toolError} from '../errors.mjs';
import {contract,toolSchemas,zodSchema} from '../tool-contract.mjs';
import {FAILURE_CODES} from '#contracts/errors';
import {allScopes} from '#scope-catalog';
import {TIER_DEFAULTS,checkBasket,limitsFromEnv} from '../../core/trade/limits.mjs';

const ALL_P2={tools:new Set(Object.keys(contract.tools))};
const P01={tools:new Set(Object.entries(contract.tools).filter(([,t])=>t.priority!=='P2').map(([n])=>n))};
const entries=Object.entries(COPY).flatMap(([group,v])=>Object.entries(v).map(([key,text])=>[`${group}.${key}`,text]));
const sentences=t=>t.split(/(?<=[.!?])\s+(?=[A-Z"'])/).filter(Boolean);
const numbers=t=>t.match(/\d[\d,.]*\d|\d/g)??[];

/** The owner's rules for one guidance string (template or filled). */
function rules(label,text,{risk=false}={}){
 assert.equal(typeof text,'string',label);
 assert.ok(text.length>=10&&text.length<=500,`${label}: length ${text.length}`);
 assert.ok(sentences(text).length>=1&&sentences(text).length<=3,`${label}: ${sentences(text).length} sentences: ${text}`);
 assert.doesNotMatch(text,/\btap|\bpress|\bclick|only your/i,`${label}: never stress a button`);
 assert.doesNotMatch(text,/\b(demo|mock|sample|placeholder|fake|test)\b/i,label);
 // Owner, voice 39611: the person never thinks about what their wallet does in between. "signed in" and "sign-in" stay.
 assert.doesNotMatch(text,/\bsign(s|ed|ing)?\b(?![ -]?(in|out|up)\b)|\bsignatures?\b/i,`${label}: never names the wallet's act`);
 assert.doesNotMatch(text,/\b(mcp|folio)\b/i,label);
 assert.doesNotMatch(text,/profit|guarantee|\breturns?\b|moon|sure thing|can't lose|will go up/i,`${label}: no claims of returns`);
 assert.doesNotMatch(text,/execute_trade|submit_trade_signature|daily_spin|lucky_spin/,`${label}: never tells the model to trade or spin by itself`);
 if(risk)assert.match(text,/Meme coins can go to zero\.$/,label);
 else assert.doesNotMatch(text,/go to zero/i,`${label}: the risk line is for buy proposals only`);
}

test('every string in the copy table follows the wording rules; the risk line only on buy proposals',()=>{
 assert.ok(entries.length>=60,String(entries.length));
 for(const [label,text] of entries){
  const risk=label==='propose_yeet.risk';
  // Templates are checked with their slots filled by short values.
  rules(label,text.replace(/\{[a-z_]+\}/g,'7'),{risk});
 }
});

test('the XP tier thresholds in the copy are the core tiers (69 XP Winner, over 1,000 XP VIP)',()=>{
 const by=Object.fromEntries(TIER_DEFAULTS.map(t=>[t.name,t.minXp]));
 assert.equal(TIER_XP.winner_xp,String(by.Winner));
 assert.equal(TIER_XP.vip_over_xp,(by.VIP-1).toLocaleString('en-US'));
});

test('every contract tool and every refusal code has guidance',()=>{
 assert.deepEqual([...GUIDED_TOOLS].sort(),Object.keys(contract.tools).sort());
 for(const code of FAILURE_CODES){const g=refusalGuidance(code,toolError({error:code}).content[0].text,ALL_P2);rules(code,g)}
});

/** Numbers in a filled guidance come from the result (or the template itself): nothing is invented. */
function noInventedNumbers(label,text,result,templateKeys){
 // Counts the copy derives from the result (sign requests left) count as the result's.
 const lengths=[];JSON.stringify(result,(_k,v)=>{if(Array.isArray(v))lengths.push(String(v.length));return v});
 const allowed=new Set([...numbers(JSON.stringify(result)),...lengths,...templateKeys.flatMap(k=>numbers(k)),TIER_XP.winner_xp,TIER_XP.vip_over_xp]);
 for(const n of numbers(text))assert.ok(allowed.has(n),`${label}: ${n} is not in the result: ${text}`);
}
const g=(name,r,ctx=ALL_P2)=>{const out=guidanceFor(name,r,ctx);rules(name,out,{risk:/go to zero/.test(out)});noInventedNumbers(name,out,r,Object.values(COPY).flatMap(Object.values));return out};

const wallets=(usdc='0')=>({base:{address:'0x'+'1'.repeat(40),usdc},solana:{address:'1'.repeat(44)}});
const xp=(over={})=>({total:5,streak_days:1,spin_available:true,spins_available:1,...over});
test('yeet_home: paused, wallet set-up, no USDC (with and without a spin), ready (spin, USDC)',()=>{
 assert.equal(g('yeet_home',{wallets:wallets(),ready:'paused',xp:xp(),recent_wins:[]}),COPY.yeet_home.paused);
 assert.equal(g('yeet_home',{wallets:wallets(),ready:'paused',xp:null,recent_wins:[]},P01),COPY.yeet_home.paused_no_wheel);
 assert.equal(g('yeet_home',{wallets:wallets(),ready:'needs_signer',xp:xp(),recent_wins:[]}),COPY.yeet_home.needs_signer);
 const fund=g('yeet_home',{wallets:wallets('0'),ready:'needs_funds',fund_url:'https://chatgpt.yeet.win/fund',xp:xp(),recent_wins:[]});
 assert.equal(fund,COPY.yeet_home.needs_funds_spin);assert.match(fund,/Add funds/);assert.match(fund,/daily wheel is free/);
 assert.equal(g('yeet_home',{wallets:wallets('0'),ready:'needs_funds',xp:xp({spin_available:false,spins_available:0}),recent_wins:[]}),COPY.yeet_home.needs_funds);
 assert.equal(g('yeet_home',{wallets:wallets('0'),ready:'needs_funds',xp:null,recent_wins:[]},P01),COPY.yeet_home.needs_funds_no_wheel);
 // Zero balance: the model may give the YEET wallet address and its network for a direct USDC transfer, or Add funds.
 const direct="YEET direct.";
 for(const k of ['needs_funds_spin','needs_funds','needs_funds_no_wheel']){
  assert.ok(COPY.yeet_home[k].includes(` ${direct}`),k);assert.match(COPY.yeet_home[k],/YEET/,k);
 }
 for(const k of ['paused','needs_signer','ready_spin','ready_usdc','ready'])assert.doesNotMatch(COPY.yeet_home[k],/direct USDC transfer/,k);
 assert.equal(g('yeet_home',{wallets:wallets('40'),ready:'ready',xp:xp(),recent_wins:[]}),COPY.yeet_home.ready_spin);
 assert.equal(g('yeet_home',{wallets:wallets('40'),ready:'ready',xp:xp({spin_available:false,spins_available:0}),recent_wins:[]}),"YEET text.");
 assert.equal(g('yeet_home',{wallets:wallets(null),ready:'ready',xp:null,recent_wins:[]},P01),COPY.yeet_home.ready);
});

test('yeet_overview: offer the suggestions in order, never a coin; the lead follows the first suggestion; paused is said first',()=>{
 const S=(...ids)=>ids.map(id=>({id,label:'x',say:'y'}));
 const o=(suggestions,over={})=>({username:'Lucky Otter 42',usdc:'20',xp:5,tier:'Noob',streak_days:1,checkin_open:false,holdings_count:0,top_winner:null,trading:'live',needs_card_sign_in:'unknown',suggestions,...over});
 const plain=g('yeet_overview',o(S('discover','holdings','fund')));
 rules('overview',plain);
 assert.match(plain,/^Welcome Lucky Otter 42 in one short line/);assert.match(plain,/YEET/);
 assert.match(plain,/YEET/);assert.match(plain,/YEET/);
 assert.match(g('yeet_overview',o(S('fund','checkin'))),/YEET/);
 assert.match(g('yeet_overview',o(S('checkin','holdings'))),/YEET/);
 const paused=g('yeet_overview',o(S('checkin'),{trading:'paused'}));rules('overview paused',paused);assert.match(paused,/trading is paused right now/);
 for(const k of Object.keys(COPY.yeet_overview))assert.doesNotMatch(COPY.yeet_overview[k],/wallet|Base|Solana|chain/i,k);
});

test('yeet_fund: no USDC yet, some USDC, unread; the card reports back',()=>{
 const f=usdc=>g('yeet_fund',{usdc,presets:['10','25'],fund_url:'https://chatgpt.yeet.win/fund'});
 assert.equal(f('0'),COPY.yeet_fund.zero);assert.equal(f(null),COPY.yeet_fund.unread);
 assert.equal(f('3.2'),"YEET text.");
 for(const k of Object.keys(COPY.yeet_fund))assert.doesNotMatch(COPY.yeet_fund[k],/wallet|Base|Solana|address/i,k);
});

test('yeet_checkin: a spin waiting, or done for today with the streak',()=>{
 assert.equal(g('yeet_checkin',{checkin:{total:5,streak_days:1,spin_available:true,spins_available:1}}),COPY.yeet_checkin.open);
 assert.equal(g('yeet_checkin',{checkin:{total:9,streak_days:4,spin_available:false,spins_available:0}}),"YEET text.");
 assert.match(g('yeet_checkin',{checkin:{total:9,streak_days:1,spin_available:false}}),/their streak is 1 day:/);
});

test('funding is described for both networks: no string says USDC can only be added or held on Base',()=>{
 for(const [label,text] of entries)assert.doesNotMatch(text,/adds USDC on Base|Add USDC on Base|USDC on Base\.$/,label);
 for(const k of ['needs_funds_spin','needs_funds','needs_funds_no_wheel'])assert.match(COPY.yeet_home[k],/YEET/,k);
 assert.match(COPY.yeet_portfolio.empty,/YEET/);
 // yeet_home with funding: both balances and the network that pays; a zero on Base is not "needs funds" when Solana holds USDC.
 const home={wallets:wallets('0'),funding:{base_usdc:'0',solana_usdc:'40',chosen:'solana'},ready:'ready',xp:null,recent_wins:[]};
 assert.equal(g('yeet_home',home,P01),"YEET text.");
 // The contract says the same: funding on yeet_home and on a proposal, and fund_url no longer names one network.
 assert.ok(contract.tools.yeet_home.outputSchema.properties.funding);assert.ok(contract.$defs.proposal.properties.funding);
 assert.doesNotMatch(contract.tools.yeet_home.outputSchema.properties.fund_url.description,/adds USDC on Base\b/);
 assert.match(contract.tools.yeet_home.outputSchema.properties.fund_url.description,/YEET/);
 assert.doesNotMatch(contract['x-yeet-scopes']['yeet:prepare'],/tap/i);
 assert.equal(contract['x-yeet-scopes']['yeet:trade'],undefined,'the old scope name has no description any more');
});

test('yeet_coins: pick a few, do not read the list out',()=>{
 assert.equal(g('yeet_coins',{coins:[],limits:{}}),COPY.yeet_coins.list);
});

const proposal=(over={})=>({proposal_id:'p_abcdefghij0123456789',revision:1,direction:'yeet',amount_usdc:'20',legs:[{symbol:'WIF',parts:10,amount_in:'20',est_out:'7.1',est_out_usd:'19.4',min_out:'7'}],totals:{in_usd:'20',out_usd:'19.4',cost_pct:3,time_estimate_s:40},quoted_at:'2026-11-12T00:00:00Z',warnings:[],next:'⚡ YEET is ready in the card.',...over});
test('proposals: the YEET button and the risk line on buys, cost only when high, one note at most; SKEET without the risk line',()=>{
 const base=g('yeet_propose',proposal());
 assert.equal(base,`${COPY.propose_yeet.base} ${COPY.propose_yeet.risk}`);assert.doesNotMatch(base,/%|WIF/,'no cost, no coin list');
 const high=g('yeet_propose',proposal({warnings:['COST_HIGH'],totals:{in_usd:'20',out_usd:'18.6',cost_pct:7,time_estimate_s:40}}));
 assert.match(high,/swap costs are 7% of this basket/);assert.match(high,/Meme coins can go to zero\.$/);
 assert.equal(g('yeet_quote',proposal({revision:2,warnings:['BALANCE_LOW','COST_HIGH']})),`${COPY.propose_yeet.base} ${COPY.propose_yeet.balance_low} ${COPY.propose_yeet.risk}`);
 assert.equal(g('yeet_propose',proposal({warnings:['SIGNER_MISSING','BALANCE_LOW']})),`${COPY.propose_yeet.base} ${COPY.propose_yeet.signer_missing} ${COPY.propose_yeet.risk}`);
 const skeet=proposal({direction:'skeet',next:'⚡ SKEET is ready in the card.',legs:[{symbol:'WIF',parts:null,amount_in:'7',est_out:'19',est_out_usd:'19',min_out:'18.9'}]});
 assert.equal(g('skeet_propose',skeet),COPY.propose_skeet.base);
 assert.equal(g('yeet_quote',{...skeet,warnings:['COST_HIGH'],totals:{...skeet.totals,cost_pct:4.5}}),`${COPY.propose_skeet.base} Mention that swap costs are 4.5% of this sale right now.`);
});

test('execute_trade: going out from their wallet in the card, on its way, price moved; never says it is done',()=>{
 const t={trade_id:'t_abcdefghij0123456789',proposal_id:'p_abcdefghij0123456789',direction:'yeet',legs:[]};
 assert.equal(g('execute_trade',{...t,status:'awaiting_signature'}),COPY.execute_trade.awaiting_signature);
 assert.equal(g('execute_trade',{...t,status:'submitted'}),COPY.execute_trade.submitted);
 assert.equal(g('execute_trade',{...t,status:'requote_required'}),COPY.execute_trade.requote_required);
 for(const s of ['awaiting_signature','submitted'])assert.doesNotMatch(guidanceFor('execute_trade',{...t,status:s}),/\blanded\b|celebrate|XP/);
});

const status=(s,over={})=>({trade_id:'t_abcdefghij0123456789',direction:'yeet',status:s,legs:[],received:[],updated_at:'2026-11-12T00:00:00Z',xp_award:null,...over});
test("YEET text.",()=>{
 for(const s of ['submitted','settling','signing']){
  const out=g('trade_status',status(s));
  assert.equal(out,COPY.trade.settling_yeet,s);assert.match(out,/one by one/);assert.match(out,/a few minutes/);assert.match(out,/YEET/);assert.match(out,/YEET/);
 }
 assert.equal(g('trade_status',status('settling',{direction:'skeet'})),COPY.trade.settling_skeet);
 assert.equal(g('submit_trade_signature',{trade_id:'t_abcdefghij0123456789',status:'signing',legs:[],sign_requests:[{},{}]}),"YEET text.");
 assert.equal(g('submit_trade_signature',{trade_id:'t_abcdefghij0123456789',status:'signing',legs:[],sign_requests:[{}]}),"YEET text.");
 const won=g('trade_status',status('success',{xp_award:{points:70,total:75}}));
 assert.equal(won,"YEET text.");
 assert.equal(g('trade_status',status('success')),COPY.trade.success_yeet);
 assert.equal(g('trade_status',status('success',{xp_award:{points:70,total:75}}),P01),COPY.trade.success_yeet_no_wheel);
 assert.match(g('trade_status',status('success',{direction:'skeet',xp_award:{points:10,total:85}})),/YEET/);
 assert.equal(g('trade_status',status('partial')),COPY.trade.partial);
 assert.equal(g('trade_status',status('refunded')),COPY.trade.refunded_yeet);
 assert.equal(g('trade_status',status('refunded',{direction:'skeet'})),COPY.trade.refunded_skeet);
 assert.equal(g('trade_status',status('failed')),COPY.trade.failed);
});

const pf=(holdings,usdc,total)=>({solana:{address:'1'.repeat(44),holdings},base:{address:'0x'+'1'.repeat(40),usdc},total_usd:total,priced_at:'2026-11-12T00:00:00Z'});
test('yeet_portfolio: empty, USDC only, coins (with and without a total), unread balance',()=>{
 assert.equal(g('yeet_portfolio',pf([],'0','0')),COPY.yeet_portfolio.empty);
 assert.equal(g('yeet_portfolio',pf([],'12.5','12.5')),"YEET text.");
 assert.match(g('yeet_portfolio',pf([{symbol:'WIF',amount:'7',usd:'19'}],'1','20')),/YEET/);
 assert.equal(g('yeet_portfolio',pf([{symbol:'WIF',amount:'7',usd:null}],'1',null)),COPY.yeet_portfolio.holdings);
 assert.equal(g('yeet_portfolio',pf([],null,null)),COPY.yeet_portfolio.usdc_unread);
});

test('yeet_leaderboard and yeet_set_username',()=>{
 assert.equal(g('yeet_leaderboard',{rows:[],me:{rank:3,xp:120}}),"YEET text.");
 assert.equal(g('yeet_leaderboard',{rows:[],me:{rank:null,xp:0}}),COPY.yeet_leaderboard.unranked);
 assert.equal(g('yeet_set_username',{username:'kat_king'}),"YEET text.");
});

const spin=(over={})=>({xp_won:30,draw_xp:25,streak_xp:0,total:35,streak_days:1,next_spin_at:'2026-11-13T00:00:00Z',stamp:{coin:'BONK',count_after:3,slots:7,card:1,filled:3,set_completed:false},set_bonus_xp:0,spins_available:0,spin_reason:null,...over});
test('leaderboards from finished SKEETs and the coins board: ranked, not on it, empty; never a promise or a push to trade',()=>{
 const b=(board,rows,me={rank:null,xp:5})=>g('yeet_leaderboard',{rows,me,board,window:'today',unit:'usd',measure:'m'});
 const c=COPY.yeet_leaderboard;
 for(const board of ['winners','best_trade','losers']){
  assert.equal(b(board,[{rank:1,name:'a',usd:'5.00'}],{rank:1,xp:5,usd:'5.00'}),fill(c.result_ranked,{rank:1}),board);
  assert.equal(b(board,[{rank:1,name:'a',usd:'5.00'}]),c.result_unranked,board);
  assert.equal(b(board,[]),c.result_empty,board);
 }
 assert.equal(b('coins',[{rank:1,name:'WIF',symbol:'WIF',usd:'5.00',people:1}]),c.coins);assert.equal(b('coins',[]),c.coins_empty);
 // The XP board keeps its own lines, with or without the new fields.
 assert.equal(g('yeet_leaderboard',{rows:[],me:{rank:2,xp:40},board:'xp',window:'7d',unit:'xp',measure:'m'}),fill(c.ranked,{rank:2,xp:40}));
 for(const k of ['result_ranked','result_unranked','result_empty','coins','coins_empty'])rules(`yeet_leaderboard.${k}`,c[k].replace(/\{[a-z_]+\}/g,'7'));
});

test('daily_spin: names the coin stamp and how many of 7, a completed set, more spins, the lucky wheel or tomorrow',()=>{
 assert.equal(g('daily_spin',spin()),'Name the BONK stamp: 3 of 7 on their BONK card, plus 30 XP. YEET daily_spin.lucky.');
 assert.equal(g('daily_spin',spin({spins_available:2})),'Name the BONK stamp: 3 of 7 on their BONK card, plus 30 XP. They have 2 more spins today; offer it.');
 assert.equal(g('daily_spin',spin({spin_reason:'trade_bonus'})),`Name the BONK stamp: 3 of 7 on their BONK card, plus 30 XP. ${COPY.daily_spin.done}`);
 assert.equal(g('daily_spin',spin({stamp:{coin:'WIF',count_after:7,slots:7,card:1,filled:7,set_completed:true},set_bonus_xp:50})),"YEET text.");
 assert.equal(g('daily_spin',spin({stamp:undefined}),{tools:new Set(['daily_spin'])}),`YEET text: ${COPY.daily_spin.done}.`);
});

const lucky=(over={})=>({lucky:{lucky_id:'l_7k2m9q4x8v1b',wheel:[{coin:'WIF'},{coin:'BOME'},{coin:'PENGU'},{coin:'TRUMP'},{coin:'NEARKAT'}],slice:null,amount_usdc:'5',claimed:false,expires_at:'2026-11-14T00:00:00Z',...over}});
test('lucky wheel: ready, landed (offer to YEET its amount for the bonus spin, with lucky_id), claimed, unavailable',()=>{
 assert.equal(g('lucky_wheel',lucky()),COPY.lucky.ready);
 assert.equal(g('lucky_spin',lucky({slice:2})),"YEET text.");
 assert.equal(g('lucky_wheel',lucky({slice:2,claimed:true})),COPY.lucky.claimed);
 assert.equal(g('lucky_wheel',{lucky:null}),COPY.lucky.none);
});

test('refusals: LIMIT_EXCEEDED names the tier from the core sentence and what unlocks the next one; paused says what still works',()=>{
 const limits=limitsFromEnv({});
 const caps=(tier,xp,trade)=>({tier,xp,maxTradeRaw:BigInt(trade)*1_000_000n,dailyCapRaw:1000n*1_000_000n,spentRaw:0n,leftRaw:1000n*1_000_000n});
 const over=c=>{try{checkBasket(limits,[600n*1_000_000n],c)}catch(e){return e.userMessage}assert.fail('no refusal')};
 const noob=refusalGuidance('LIMIT_EXCEEDED',over(caps('Noob',10,25)));
 assert.equal(noob,"YEET text.");
 assert.match(refusalGuidance('LIMIT_EXCEEDED',over(caps('Winner',200,100))),/YEET/);
 assert.match(refusalGuidance('LIMIT_EXCEEDED',over(caps('VIP',2000,500))),/over their VIP limit.*SKEET is never capped\.$/);
 assert.equal(refusalGuidance('LIMIT_EXCEEDED','This trade would go over the per-trade or daily USDC limit.'),COPY.errors.LIMIT_EXCEEDED);
 for(const tier of ['Noob','Winner','VIP'])rules(tier,refusalGuidance('LIMIT_EXCEEDED',`as a ${tier} (1 XP)`));
 assert.equal(refusalGuidance('TRADING_PAUSED',null,ALL_P2),COPY.errors.TRADING_PAUSED);assert.match(COPY.errors.TRADING_PAUSED,/still work/);
 assert.equal(refusalGuidance('TRADING_PAUSED',null,P01),COPY.errors.TRADING_PAUSED_no_wheel);
 assert.match(refusalGuidance('TEMPORARILY_UNAVAILABLE'),/could not get a price/,'no route or no liquidity comes back as TEMPORARILY_UNAVAILABLE');
 assert.match(refusalGuidance('CONFIRMATION_REQUIRED'),/expired and nothing was traded/);
});

test('tool errors carry guidance in the JSON the model reads; the failure shape still validates and the card fields are unchanged',()=>{
 const failure=zodSchema(z,contract.$defs.failure);
 for(const code of FAILURE_CODES){
  const v=JSON.parse(toolError({error:code}).content[0].text);
  assert.equal(v.guidance,refusalGuidance(code,v.message),code);
  assert.doesNotThrow(()=>failure.parse(v),code);
 }
 const limit=JSON.parse(toolError({error:'LIMIT_EXCEEDED',message:'That\'s over your 25 USDC per-trade limit as a Noob (10 XP), so lower the amount.'}).content[0].text);
 assert.equal(limit.message,'That\'s over your 25 USDC per-trade limit as a Noob (10 XP), so lower the amount.');assert.match(limit.guidance,/Noob/);
 assert.equal(JSON.parse(toolError({error:'TRADING_PAUSED'},P01).content[0].text).guidance,COPY.errors.TRADING_PAUSED_no_wheel);
});

test('the contract lists guidance on every output schema (optional) so registration keeps it',()=>{
 assert.deepEqual(contract.$defs.guidance,{type:'string',minLength:1,maxLength:500,description:contract.$defs.guidance.description});
 for(const [name,s] of Object.entries(toolSchemas)){
  assert.equal(s.output.properties.guidance?.type,'string',name);assert.ok(!(s.output.required??[]).includes('guidance'),name);
 }
 assert.ok(!contract.$defs.failure.required.includes('guidance'));
});

async function connect(callCore,env={}){
 const server=createMcpServer({token:{scope:allScopes.join(' ')},callCore,env});
 const client=new Client({name:'guidance-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 return {client,close:async()=>{await client.close();await server.close()}};
}
test('registered tools: guidance in structuredContent and in the text the model reads; refusals too',async()=>{
 const confirm={code:'C'.repeat(43),expires_at:'2026-11-12T00:02:00Z'};
 const answers={'/proposals':{...proposal(),confirm},'/spin':spin(),'/lucky':lucky({slice:1})};
 const {client,close}=await connect(async route=>{if(route==='/proposals/skeet')throw {error:'TRADING_PAUSED'};return answers[route]},{YEET_P2:'1'});
 try{
  const p=await client.callTool({name:'yeet_propose',arguments:{request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}});
  assert.equal(p.isError,undefined,JSON.stringify(p.content));
  assert.equal(p.structuredContent.guidance,`${COPY.propose_yeet.base} ${COPY.propose_yeet.risk}`);
  assert.equal(JSON.parse(p.content[0].text).guidance,p.structuredContent.guidance);
  assert.doesNotMatch(JSON.stringify(p.structuredContent)+JSON.stringify(p.content),/CCCC/,'the confirm code stays card-only');
  // A card-only tool, called as a current card calls it: with its build.
  const s=await client.callTool({name:'daily_spin',arguments:{card_build:CARD_BUILD}});
  assert.equal(s.content[0].text,'You won 30 XP and a BONK stamp (3 of 7).');
  assert.equal(s.content[1].text,s.structuredContent.guidance);assert.match(s.content[1].text,/BONK stamp: 3 of 7/);
  const l=await client.callTool({name:'lucky_wheel',arguments:{}});
  assert.match(l.content[1].text,/^The lucky wheel landed on BOME: offer to YEET 5 USDC into BOME/);
  const x=await client.callTool({name:'skeet_propose',arguments:{request_id:'r2',legs:[{symbol:'WIF',percent:100}]}});
  assert.equal(x.isError,true);const v=JSON.parse(x.content[0].text);
  assert.equal(v.error,'TRADING_PAUSED');assert.equal(v.guidance,COPY.errors.TRADING_PAUSED);
 }finally{await close()}
});

test('yeet_home with no USDC: the text the model reads carries both wallet addresses and the direct-transfer guidance',async()=>{
 const home={wallets:{base:{address:'0x5a1C0ffee0D15ea5e0000000000000000000B45E',usdc:'0'},solana:{address:'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'}},ready:'needs_funds',fund_url:'https://chatgpt.yeet.win/fund',xp:null,recent_wins:[]};
 const {client,close}=await connect(async route=>{assert.equal(route,'/home');return home});
 try{
  const r=await client.callTool({name:'yeet_home',arguments:{}});
  assert.equal(r.isError,undefined,JSON.stringify(r.content));
  const text=JSON.parse(r.content[0].text);
  assert.equal(text.wallets.base.address,home.wallets.base.address);
  assert.equal(text.wallets.solana.address,home.wallets.solana.address);
  assert.equal(text.fund_url,home.fund_url);
  assert.equal(text.guidance,COPY.yeet_home.needs_funds_no_wheel);assert.match(text.guidance,/direct USDC transfer/);
  assert.deepEqual(r.structuredContent.wallets,home.wallets,'the card reads the same addresses');
 }finally{await close()}
});

test('fill: a slot without a value is never sent as text',()=>{
 assert.throws(()=>fill('{coin} stamp',{}));
 assert.equal(guidanceFor('daily_spin',{stamp:{coin:'WIF'}}),undefined,'a result the copy cannot read goes out without guidance');
});

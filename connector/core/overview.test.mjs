// core/overview.mjs: one USDC number, no wallet or chain, the follow-ups ordered by state; the answer fits the contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {overview,suggestionsFor,totalUsdc,SUGGESTIONS} from './overview.mjs';
import {toolSchemas,zodSchema} from '../mcp/tool-contract.mjs';

const out=zodSchema(z,toolSchemas.yeet_overview.output);
const wallets={base:{address:'0x'+'a'.repeat(40),usdc:'12.5'},solana:{address:'7x3qiZtcsqC2paa7p7XnfUffedPDNP7GvZVuMD7VXvDe'}};
const home=(o={})=>({wallets,funding:{base_usdc:'12.5',solana_usdc:'7.5',chosen:'base'},ready:'ready',xp:null,recent_wins:[],limits:{tier:'Winner',per_trade_usdc:'100',daily_limit_usdc:'420',left_today_usdc:'420'},...o});
const xp=(o={})=>({total:120,streak_days:4,spin_available:true,spins_available:1,...o});
const ids=list=>list.map(s=>s.id);

test('totalUsdc: one number over every network; null only when nothing could be read',()=>{
 assert.equal(totalUsdc('12.5','7.5'),'20');assert.equal(totalUsdc('0.000001',null),'0.000001');assert.equal(totalUsdc('0','0'),'0');
 assert.equal(totalUsdc(null,null),null);assert.equal(totalUsdc('3',undefined),'3');assert.equal(totalUsdc('1.10','2.005'),'3.105');
});

test('suggestions: the owner’s five, ordered by state (no USDC: fund first; check-in open: check-in first)',()=>{
 assert.deepEqual(Object.values(SUGGESTIONS).map(s=>s.label),['Do your daily check-in','Review your meme holdings','Discover a new coin to yeet','Fund my account','See what other people are yeeting']);
 assert.deepEqual(ids(suggestionsFor({usdc:'20',checkinOpen:true,holdings:2})),['checkin','holdings','discover','fund','others']);
 assert.deepEqual(ids(suggestionsFor({usdc:'0',checkinOpen:true,holdings:0})),['fund','checkin','discover','holdings','others']);
 assert.deepEqual(ids(suggestionsFor({usdc:'0',checkinOpen:false,holdings:0})),['fund','discover','holdings','others']);
 assert.deepEqual(ids(suggestionsFor({usdc:'20',checkinOpen:false,holdings:0})),['discover','holdings','fund','others']);
 assert.deepEqual(ids(suggestionsFor({usdc:null,checkinOpen:true,holdings:1,wheel:false,board:false})),['holdings','discover','fund'],'no wheel and no board in this deployment');
});

test('overview: fits the contract; USDC is the sum; no address and no network name anywhere in it',()=>{
 const bag={solana:{address:wallets.solana.address,holdings:[{symbol:'WIF',amount:'10',usd:'25'},{symbol:'USDC',amount:'7.5',usd:'7.5'}]},base:wallets.base,total_usd:'45',priced_at:'2026-11-13T00:00:00.000Z'};
 const v=overview({home:home(),bag,xp:xp(),winner:{symbol:'WIF',pct:25,since:'buy'},username:'Lucky Otter 42'});
 assert.doesNotThrow(()=>out.parse(v));
 assert.deepEqual(v,{username:'Lucky Otter 42',usdc:'20',xp:120,tier:'Winner',streak_days:4,checkin_open:true,holdings_count:1,top_winner:{symbol:'WIF',pct:25,since:'buy'},trading:'live',
  needs_card_sign_in:'unknown',suggestions:[SUGGESTIONS.checkin,SUGGESTIONS.holdings,SUGGESTIONS.discover,SUGGESTIONS.fund,SUGGESTIONS.others]});
 assert.doesNotMatch(JSON.stringify(v),/0xaaaa|7x3qiZ|\bbase\b|solana/i);
});

test('overview: soft failures are null fields; paused trading; a spent check-in; no XP in this deployment',()=>{
 const none=overview({home:home({funding:{base_usdc:null,solana_usdc:null,chosen:null},ready:'paused'}),username:'x',wheel:false,board:false});
 assert.doesNotThrow(()=>out.parse(none));
 assert.deepEqual([none.usdc,none.xp,none.streak_days,none.checkin_open,none.holdings_count,none.top_winner,none.trading],[null,null,null,null,null,null,'paused']);
 assert.deepEqual(ids(none.suggestions),['discover','holdings','fund']);
 const spent=overview({home:home(),xp:xp({spin_available:false,spins_available:0}),username:'x'});
 assert.equal(spent.checkin_open,false);assert.ok(!ids(spent.suggestions).includes('checkin'));
 const broke=overview({home:home({funding:{base_usdc:'0',solana_usdc:'0',chosen:null},ready:'needs_funds'}),xp:xp(),username:'x'});
 assert.equal(broke.usdc,'0');assert.deepEqual(ids(broke.suggestions).slice(0,2),['fund','checkin']);
 // An older engine answer without funding: the one balance it has.
 assert.equal(overview({home:home({funding:undefined}),username:'x'}).usdc,'12.5');
});

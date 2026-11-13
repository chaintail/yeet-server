// xp/boards.mjs: every board and window answers the contract shape, names its measure, and ranks from settled legs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {openXp} from './xp.mjs';
import {boardAnswer,normalize,windowStart,MEASURE,BOARDS} from './boards.mjs';
import {openTradeDb} from '../trade/db.mjs';
import {CATALOG} from '../trade/router.mjs';
import {coinDecimals} from '../trade/pnl.mjs';
import {toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';

const out=zodSchema(z,toolSchemas.yeet_leaderboard.output);
const NOW=Date.UTC(2026,10,14,12,0,0),DAY=86_400_000,HOUR=3_600_000;
const names=id=>`name-${id.slice(-1)}`;
let n=0;
function leg(db,{account,direction='yeet',symbol='WIF',coins,usdc,at,status='SUCCESS'}){
 const id=`t_${String(++n).padStart(20,'0')}`,d=coinDecimals(CATALOG,symbol);
 const coinRaw=String(BigInt(Math.round(coins*1e6))*10n**BigInt(d)/1_000_000n),usdcRaw=String(Math.round(usdc*1e6));
 db.prepare('INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)').run(id,`p_${String(n).padStart(20,'0')}`,account,direction,'success',at,at);
 db.prepare(`INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,oneclick_status,settled_out_raw,updated_at)
  VALUES(?,0,?,?,?,?,?,?,?,?)`).run(id,symbol,direction==='yeet'?usdcRaw:coinRaw,'dep','{}','sent',status,direction==='yeet'?coinRaw:usdcRaw,at);
}
/** a made 30 today on WIF (+150%) and 5 six days ago; b lost 8 today; c made 2 today on BOME (+20%); d only yeeted. */
function world(){
 const db=openTradeDb(':memory:'),x=openXp({now:()=>NOW,secret:'s'.repeat(32)});
 const A='yeet-privy-a',B='yeet-privy-b',C='yeet-privy-c',D='yeet-privy-d';
 leg(db,{account:A,coins:20,usdc:20,at:NOW-8*DAY});
 leg(db,{account:A,direction:'skeet',coins:5,usdc:10,at:NOW-6*DAY});       // +5 (+100%) six days ago
 leg(db,{account:A,direction:'skeet',coins:10,usdc:25,at:NOW-2*HOUR});      // +15 (+150%) today
 leg(db,{account:A,direction:'skeet',coins:5,usdc:20,at:NOW-HOUR});         // +15 (+300%) today
 leg(db,{account:B,coins:10,usdc:20,at:NOW-3*DAY});
 leg(db,{account:B,direction:'skeet',coins:10,usdc:12,at:NOW-HOUR});        // -8 today
 leg(db,{account:C,symbol:'BOME',coins:100,usdc:10,at:NOW-3*HOUR});
 leg(db,{account:C,symbol:'BOME',direction:'skeet',coins:100,usdc:12,at:NOW-HOUR}); // +2 (+20%) today
 leg(db,{account:D,coins:5,usdc:7.5,at:NOW-30*60_000});
 leg(db,{account:D,coins:99,usdc:99,at:NOW-HOUR,status:'REFUNDED'});
 x.ledger.award(A,'sign_in','d1');
 return {db,x,A,B,C,D,ask:(who,board,window)=>{const v=boardAnswer({x,db,catalog:CATALOG,who,board,window,names,now:NOW});out.parse(v);return v}};
}

test('normalize: week is xp over 7d; xp defaults to all time, the others to today and never to all time',()=>{
 assert.deepEqual(normalize(),{board:'xp',window:'all'});assert.deepEqual(normalize('week'),{board:'xp',window:'7d'});
 assert.deepEqual(normalize('xp','today'),{board:'xp',window:'today'});
 for(const b of BOARDS.filter(b=>b!=='xp')){assert.deepEqual(normalize(b),{board:b,window:'today'});assert.deepEqual(normalize(b,'all'),{board:b,window:'today'});assert.deepEqual(normalize(b,'7d'),{board:b,window:'7d'})}
 assert.equal(windowStart('today',NOW),Date.UTC(2026,10,14));assert.equal(windowStart('7d',NOW),NOW-7*DAY);assert.equal(windowStart('all',NOW),null);
});

test('winners: USDC made on SKEETs, today and over 7 days; losers and people with nothing sold are not on it',()=>{
 const w=world();
 const today=w.ask(w.C,'winners','today');
 assert.deepEqual(today.rows,[{rank:1,name:'name-a',usd:'30.00'},{rank:2,name:'name-c',usd:'2.00'}]);
 assert.deepEqual(today.me,{rank:2,xp:0,usd:'2.00'});
 assert.deepEqual([today.board,today.window,today.unit],['winners','today','usd']);
 assert.equal(today.measure,'USDC made on SKEETs today (UTC): USDC received minus the average YEET cost of the coins sold. Coins still held are not counted.');
 const week=w.ask(w.B,'winners','7d');
 assert.deepEqual(week.rows[0],{rank:1,name:'name-a',usd:'35.00'});assert.deepEqual(week.me,{rank:null,xp:0});
 assert.match(week.measure,/in the last 7 days/);
});

test('best_trade: each person’s biggest percent win on one SKEET, with its coin; losers: most USDC lost first',()=>{
 const w=world();
 const best=w.ask(w.A,'best_trade','today');
 assert.deepEqual(best.rows,[{rank:1,name:'name-a',pct:300,symbol:'WIF'},{rank:2,name:'name-c',pct:20,symbol:'BOME'}]);
 assert.deepEqual(best.me,{rank:1,xp:w.x.total(w.A),pct:300,symbol:'WIF'});assert.equal(best.unit,'pct');
 const lose=w.ask(w.B,'losers');
 assert.deepEqual(lose.rows,[{rank:1,name:'name-b',usd:'-8.00'}]);assert.deepEqual(lose.me,{rank:1,xp:0,usd:'-8.00'});assert.equal(lose.window,'today');
});

test('coins: USDC yeeted per coin and how many people, settled YEETs only; nobody has a place of their own',()=>{
 const w=world();
 const today=w.ask(w.D,'coins','today');
 assert.deepEqual(today.rows,[{rank:1,name:'BOME',symbol:'BOME',usd:'10.00',people:1},{rank:2,name:'WIF',symbol:'WIF',usd:'7.50',people:1}]);
 assert.deepEqual(today.me,{rank:null,xp:0});
 const week=w.ask(w.D,'coins','7d');
 assert.deepEqual(week.rows[0],{rank:1,name:'WIF',symbol:'WIF',usd:'27.50',people:2},'the refunded 99 is not counted');
});

test('xp: all time, 7 days (also as board week) and today; empty boards answer the same shape',()=>{
 const w=world();
 const all=w.ask(w.A,'xp');assert.deepEqual([all.board,all.window,all.unit,all.measure],['xp','all','xp','XP earned, all time.']);
 assert.equal(all.me.rank,1);assert.deepEqual(all.rows,[{rank:1,name:'name-a',xp:all.me.xp}]);
 assert.deepEqual(w.ask(w.A,'week').window,'7d');assert.equal(w.ask(w.A,'xp','today').measure,'XP earned today (UTC).');
 const empty=boardAnswer({x:openXp({now:()=>NOW,secret:'s'.repeat(32)}),db:openTradeDb(':memory:'),catalog:CATALOG,who:w.A,board:'winners',names,now:NOW});
 out.parse(empty);assert.deepEqual(empty.rows,[]);assert.deepEqual(empty.me,{rank:null,xp:0});
 for(const b of BOARDS)for(const win of ['today','7d','all'])assert.ok(MEASURE[b](win).length<=240,`${b} ${win}`);
});

test('equal results share a rank; no account id reaches a row',()=>{
 const w=world();
 leg(w.db,{account:'yeet-privy-e',symbol:'BOME',coins:100,usdc:10,at:NOW-3*HOUR});
 leg(w.db,{account:'yeet-privy-e',symbol:'BOME',direction:'skeet',coins:100,usdc:12,at:NOW-HOUR});
 const v=w.ask(w.C,'winners','today');
 assert.deepEqual(v.rows.map(r=>r.rank),[1,2,2]);
 assert.doesNotMatch(JSON.stringify(v),/yeet-privy/);
});

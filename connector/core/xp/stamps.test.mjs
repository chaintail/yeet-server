// Coin stamps on the daily spin wheel: determinism, one transaction with the XP row, 7-slot cards and the set bonus,
// replay safety, catalog changes, and the one-sentence tool text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {openLedger,SET_COMPLETE_XP} from './ledger.mjs';
import {createSpin,roll,rollCoin,BONUS_TABLE} from './spin.mjs';
import {stampCoins,STAMP_SLOTS} from './stamps.mjs';
import {openXp} from './xp.mjs';
import {fakeClock} from '../trade/fakes.mjs';
import {spinText} from '../../mcp/tool-registration.mjs';

const SECRET='test-xp-secret-0123456789abcdef';
const clock=(iso='2026-11-10T08:00:00.000Z')=>fakeClock(Date.parse(iso));
const DAY=86_400_000;
const n=(l,sql,...a)=>Number(l.db.prepare(sql).get(...a).n);

test('wheel coins: the 10 tradable Solana catalog coins, no USDC, catalog order',()=>{
 const coins=stampCoins();
 assert.equal(coins.length,10);assert.ok(!coins.includes('USDC'));
 assert.deepEqual(coins.slice(0,3),['SOL','WIF','BOME']);
});

test('determinism: the same account and day give the same coin, wheel and stamp, also after a restart',()=>{
 const now=clock();const l=openLedger(':memory:',{now});
 const spin=createSpin({ledger:l,secret:SECRET});
 const s=spin.spin('a');
 assert.equal(s.stamp.coin,rollCoin(SECRET,'a','2026-11-10',stampCoins()));
 assert.deepEqual(s.wheel.map(w=>w.coin),stampCoins());
 assert.deepEqual(s.wheel[s.slice],{coin:s.stamp.coin,xp:s.draw_xp});
 assert.equal(s.draw_xp,roll(SECRET,'a|2026-11-10'));
 const values=new Set(BONUS_TABLE.map(r=>r.xp));
 assert.ok(s.wheel.every(w=>values.has(w.xp)));
 assert.equal(new Set(s.wheel.map(w=>w.xp)).size,s.wheel.length,'every slice shows a different value');
 assert.deepEqual(s.stamp,{coin:s.stamp.coin,count_after:1,slots:7,card:1,filled:1,set_completed:false});
 // A second store with the same secret (a restart on a fresh file) draws the same coin and wheel for that day.
 const other=createSpin({ledger:openLedger(':memory:',{now}),secret:SECRET}).spin('a');
 assert.deepEqual([other.stamp,other.wheel,other.slice],[s.stamp,s.wheel,s.slice]);
 // Coins differ across accounts and days (not one fixed coin).
 const seen=new Set();for(let i=0;i<40;i++)seen.add(rollCoin(SECRET,`u${i}`,'2026-11-10',stampCoins()));
 assert.ok(seen.size>=5,String(seen.size));
});

test('replay safety: a repeat the same day returns the same stamp and adds nothing',()=>{
 const now=clock();const l=openLedger(':memory:',{now});const spin=createSpin({ledger:l,secret:SECRET});
 const s=spin.spin('a');
 for(let i=0;i<5;i++){now.advance(3600_000);assert.deepEqual(spin.spin('a'),s)}
 assert.equal(n(l,'SELECT SUM(count) n FROM xp_stamp'),1);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='daily_spin'"),1);
 // The store exposes no other way to add a stamp than the spin itself.
 assert.deepEqual(Object.keys(spin.stamps).sort(),['coins','forSpin','grantIn','lastOn','list','setsCompleted']);
});

test('transactionality: a failed stamp write leaves no XP row; a spin that pays no XP writes no stamp',()=>{
 const now=clock();const l=openLedger(':memory:',{now});const spin=createSpin({ledger:l,secret:SECRET});
 l.db.exec("CREATE TRIGGER boom BEFORE INSERT ON xp_stamp_spin BEGIN SELECT RAISE(ABORT,'boom'); END;");
 assert.throws(()=>spin.spin('a'),/boom/);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_event'),0);assert.equal(n(l,'SELECT COUNT(*) n FROM xp_stamp'),0);
 l.db.exec('DROP TRIGGER boom');
 assert.equal(spin.spin('a').stamp.count_after,1);
 // The daily_spin rule not live yet: refused, nothing written for that account.
 l.db.prepare("UPDATE xp_rule SET starts_at='2099-01-01T00:00:00.000Z' WHERE rule_id='daily_spin'").run();
 assert.throws(()=>spin.spin('b'),e=>e.code==='TEMPORARILY_UNAVAILABLE');
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE identity_id='b'"),0);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_stamp WHERE identity_id='b'"),0);
});

test('the 7th stamp completes a set and pays the bonus once; counts continue into the next card',()=>{
 const now=clock();const l=openLedger(':memory:',{now});const spin=createSpin({ledger:l,secret:SECRET,coins:['WIF']});
 let s;
 for(let d=1;d<=6;d++){s=spin.spin('a');assert.equal(s.stamp.filled,d);assert.equal(s.set_bonus_xp,0);now.advance(2*DAY)}
 const before=l.total('a');
 s=spin.spin('a');
 assert.deepEqual(s.stamp,{coin:'WIF',count_after:7,slots:7,card:1,filled:7,set_completed:true});
 assert.equal(s.set_bonus_xp,SET_COMPLETE_XP);assert.equal(s.sets_completed,1);
 assert.equal(s.total,before+s.xp_won+SET_COMPLETE_XP,'the bonus is apart from xp_won and in the total');
 assert.deepEqual(s.stamps,[{coin:'WIF',count:7,slots:7,card:2,progress:0,complete:true}]);
 assert.deepEqual(spin.spin('a'),s,'replay on the completing day: same result, bonus not paid twice');
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='set_completed'"),1);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_stamp_set'),1);
 now.advance(2*DAY);s=spin.spin('a');
 assert.deepEqual(s.stamp,{coin:'WIF',count_after:8,slots:7,card:2,filled:1,set_completed:false});
 assert.deepEqual(s.stamps,[{coin:'WIF',count:8,slots:7,card:2,progress:1,complete:true}]);
 for(let d=9;d<=14;d++){now.advance(2*DAY);s=spin.spin('a')}
 assert.equal(s.stamp.card,2);assert.equal(s.stamp.set_completed,true);assert.equal(s.sets_completed,2);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='set_completed'"),2);
 assert.equal(STAMP_SLOTS,7);
});

test('catalog change: a coin removed from the catalog keeps its stamps, stays listed, and its day replays the same',()=>{
 const now=clock();const db=new DatabaseSync(':memory:');
 const old=createSpin({ledger:openLedger(db,{now}),secret:SECRET,coins:['GONE']});
 const s=old.spin('a');assert.equal(s.stamp.coin,'GONE');
 const fresh=createSpin({ledger:openLedger(db,{now}),secret:SECRET});
 const list=fresh.stamps.list('a');
 assert.deepEqual(list.map(c=>c.coin),[...stampCoins(),'GONE']);
 assert.deepEqual(list.at(-1),{coin:'GONE',count:1,slots:7,card:1,progress:1,complete:false});
 const r=fresh.spin('a');
 assert.deepEqual(r.stamp,s.stamp,'stored coin, not a redraw on the new catalog');
 assert.deepEqual(r.wheel[r.slice],{coin:'GONE',xp:s.draw_xp});
 assert.equal(n({db},'SELECT SUM(count) n FROM xp_stamp'),1);
});

test('a spin stored before stamps existed gets its stamp on its first repeat, once',()=>{
 const now=clock();const l=openLedger(':memory:',{now});
 l.award('a','daily_spin','2026-11-10',{points:5+roll(SECRET,'a|2026-11-10')});
 const spin=createSpin({ledger:l,secret:SECRET});
 const s=spin.spin('a');assert.equal(s.stamp.count_after,1);
 assert.deepEqual(spin.spin('a'),s);assert.equal(n(l,'SELECT SUM(count) n FROM xp_stamp'),1);
});

test('home: stamps for every coin and sets_completed in the xp summary',()=>{
 const xp=openXp({secret:SECRET,now:clock()});
 const s=xp.doSpin('a');const sum=xp.summary('a');
 assert.equal(sum.stamps.length,10);assert.equal(sum.sets_completed,0);
 assert.deepEqual(sum.stamps,s.stamps);
});

test('tool text: one plain sentence',()=>{
 const base={xp_won:24,set_bonus_xp:0,stamp:{coin:'WIF',count_after:3,slots:7,card:1,filled:3,set_completed:false}};
 assert.equal(spinText(base),'You won 24 XP and a WIF stamp (3 of 7).');
 const done={xp_won:10,set_bonus_xp:30,stamp:{coin:'BOME',count_after:14,slots:7,card:2,filled:7,set_completed:true}};
 assert.equal(spinText(done),'You won 10 XP and a BOME stamp (7 of 7), completing a BOME set for 30 bonus XP.');
 for(const t of [spinText(base),spinText(done)]){
  assert.equal(t.split('. ').length,1);
  for(const w of ['demo','mock','sample','placeholder','reward','prize'])assert.ok(!t.toLowerCase().includes(w),w);
 }
});

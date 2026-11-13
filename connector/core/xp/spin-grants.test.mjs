// Extra spins: streak milestones on the 3rd and 7th day of every 7-day block each grant one extra spin for that day;
// grantSpin is the generic, unique-per-cause way in. Each extra spin is a full spin (XP + one stamp), consumed once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openLedger} from './ledger.mjs';
import {createSpin,roll,rollCoin,grantId,streakMilestone} from './spin.mjs';
import {stampCoins} from './stamps.mjs';
import {openXp} from './xp.mjs';
import {fakeClock} from '../trade/fakes.mjs';
import {spinText} from '../../mcp/tool-registration.mjs';

const SECRET='test-xp-secret-0123456789abcdef';
const DAY=86_400_000;
const setup=(iso='2026-11-01T09:00:00.000Z')=>{const now=fakeClock(Date.parse(iso));const l=openLedger(':memory:',{now});return {now,l,spin:createSpin({ledger:l,secret:SECRET})}};
const n=(l,sql,...a)=>Number(l.db.prepare(sql).get(...a).n);
const today=now=>new Date(now()).toISOString().slice(0,10);

test('21 days: milestones on 3, 7, 10, 14, 17, 21, one grant each, each extra spin pays XP and a stamp once',()=>{
 const {now,l,spin}=setup();
 const granted=[];
 for(let d=1;d<=21;d++){
  const s=spin.spin('a');
  assert.equal(s.spin_kind,'daily');assert.equal(s.streak_days,d);
  if(streakMilestone(d)){
   granted.push(d);
   assert.equal(s.spins_available,1,`day ${d}`);assert.equal(s.extra_spin_reason,'streak_milestone');
   const before=l.total('a');
   const x=spin.spin('a');
   const id=grantId('a',today(now),'streak_milestone',today(now));
   assert.equal(x.spin_kind,'extra');assert.equal(x.spin_reason,'streak_milestone');
   assert.equal(x.draw_xp,roll(SECRET,`a|${today(now)}|${id}`));assert.equal(x.streak_xp,0);
   assert.equal(x.xp_won,5+x.draw_xp);
   assert.equal(x.stamp.coin,rollCoin(SECRET,'a',`${today(now)}|${id}`,stampCoins()));
   assert.deepEqual(x.wheel[x.slice],{coin:x.stamp.coin,xp:x.draw_xp});
   assert.equal(x.total,before+x.xp_won+x.set_bonus_xp);
   assert.equal(x.spins_available,0);assert.equal(x.extra_spin_reason,null);
   assert.deepEqual(spin.spin('a'),x,'replay after the extra spin: the same extra spin');
  }else assert.equal(s.spins_available,0,`day ${d}`);
  now.advance(DAY);
 }
 assert.deepEqual(granted,[3,7,10,14,17,21]);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_spin_grant'),6);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_spin_grant WHERE used_at IS NULL'),0);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='extra_spin'"),6);
 assert.equal(n(l,'SELECT SUM(count) n FROM xp_stamp'),27,'21 daily + 6 extra stamps');
});

test('grantSpin: one grant per cause; a granted spin is a full spin; unknown reasons and empty refs are refused',()=>{
 const {now,l,spin}=setup();
 const day=today(now);
 spin.spin('a');
 const g=spin.grantSpin('a',day,'trade_bonus','trade-1');
 assert.equal(g.granted,true);
 assert.deepEqual(spin.grantSpin('a',day,'trade_bonus','trade-1'),{id:g.id,granted:false},'same cause: no second grant');
 assert.equal(spin.grantSpin('a',day,'trade_bonus','trade-2').granted,true);
 assert.deepEqual(spin.left('a'),{spins_available:2,extra_spin_reason:'trade_bonus'});
 const x1=spin.spin('a'),x2=spin.spin('a');
 assert.notEqual(x1.stamp.count_after+x1.stamp.coin,x2.stamp.count_after+x2.stamp.coin);
 assert.equal(x2.spins_available,0);
 assert.deepEqual(spin.spin('a'),x2);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='extra_spin'"),2);
 assert.equal(n(l,'SELECT SUM(count) n FROM xp_stamp'),3);
 assert.throws(()=>spin.grantSpin('a',day,'free_stuff','x'),/reason/);
 assert.throws(()=>spin.grantSpin('a',day,'trade_bonus',''),/unique ref/);
 assert.throws(()=>spin.grantSpin('a','soon','trade_bonus','x'),/day/);
 // The runtime exposes the same function for a future trade-bonus caller.
 const xp=openXp({secret:SECRET,now});
 assert.equal(xp.grantSpin('b',day,'trade_bonus','t').granted,true);
 assert.equal(xp.summary('b').spins_available,2);assert.equal(xp.summary('b').extra_spin_reason,'trade_bonus');
});

test('an extra spin granted before the daily spin waits for it: the daily spin goes first',()=>{
 const {now,spin}=setup();
 spin.grantSpin('a',today(now),'trade_bonus','t1');
 assert.equal(spin.left('a').spins_available,2);
 assert.equal(spin.spin('a').spin_kind,'daily');
 assert.equal(spin.spin('a').spin_kind,'extra');
});

test('grants expire at day end: unused extra spins do not carry over',()=>{
 const {now,l,spin}=setup('2026-11-01T23:00:00.000Z');
 spin.grantSpin('a',today(now),'trade_bonus','t1');
 spin.spin('a');
 assert.equal(spin.left('a').spins_available,1);
 now.advance(2*3600_000);// 01:00 next day
 assert.deepEqual(spin.left('a'),{spins_available:1,extra_spin_reason:null},'only the new daily spin');
 spin.spin('a');
 const r=spin.spin('a');assert.equal(r.spin_kind,'daily','yesterday’s grant is not used');
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='extra_spin'"),0);
 // A grant for a past day never counts.
 spin.grantSpin('a','2026-10-01','trade_bonus','old');
 assert.equal(spin.left('a').spins_available,0);
});

test('extra spin transaction: a failed stamp write leaves the grant unused and pays no XP',()=>{
 const {now,l,spin}=setup();
 spin.spin('a');spin.grantSpin('a',today(now),'trade_bonus','t1');
 l.db.exec("CREATE TRIGGER boom BEFORE INSERT ON xp_stamp_spin BEGIN SELECT RAISE(ABORT,'boom'); END;");
 assert.throws(()=>spin.spin('a'),/boom/);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='extra_spin'"),0);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_spin_grant WHERE used_at IS NULL'),1);
 l.db.exec('DROP TRIGGER boom');
 assert.equal(spin.spin('a').spin_kind,'extra');
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_spin_grant WHERE used_at IS NULL'),0);
});

test('a milestone grant is written with the daily spin and only once, even across replays',()=>{
 const {now,l,spin}=setup();
 spin.spin('a');now.advance(DAY);spin.spin('a');now.advance(DAY);
 const s=spin.spin('a');assert.equal(s.streak_days,3);
 spin.spin('a');spin.spin('a');spin.spin('a');
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_spin_grant WHERE reason='streak_milestone'"),1);
 assert.equal(n(l,"SELECT COUNT(*) n FROM xp_event WHERE event='extra_spin'"),1);
});

test('tool text mentions spins left today',()=>{
 const r={xp_won:30,set_bonus_xp:0,spins_available:1,stamp:{coin:'WIF',count_after:1,slots:7,card:1,filled:1,set_completed:false}};
 assert.equal(spinText(r),'You won 30 XP and a WIF stamp (1 of 7), and you have 1 more spin today.');
});

// The fair wheel (YEET_FAIR_WHEEL=on): commit before the seed, one seed per commitment, the draw from the revealed
// seeds, the same vectors as yeet-win packages/fair (fair-vectors.json is a copy of its test/vectors.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openLedger} from './ledger.mjs';
import {createSpin,BONUS_TABLE,roll,rollCoin} from './spin.mjs';
import {fairOutcome,commitmentOf,drawFromWords,landedWheel,fairWheelOn,SPIN_ID} from './fair.mjs';
import {openXp} from './xp.mjs';
import {fakeClock} from '../trade/fakes.mjs';

const SECRET='test-xp-secret-0123456789abcdef';
const DAY=86_400_000;
const VECTORS=JSON.parse(readFileSync(new URL('./fair-vectors.json',import.meta.url),'utf8'));
const setup=({fair=true,iso='2026-11-01T09:00:00.000Z'}={})=>{const now=fakeClock(Date.parse(iso));const l=openLedger(':memory:',{now});return {now,l,spin:createSpin({ledger:l,secret:SECRET,fair})}};
const row=(l,id)=>l.db.prepare('SELECT * FROM xp_fair_spin WHERE spin_id=?').get(id);
const n=(l,sql,...a)=>Number(l.db.prepare(sql).get(...a).n);
const SEED='card-seed-0123456789abcdef';

test('the switch: only YEET_FAIR_WHEEL=on turns it on',()=>{
 assert.equal(fairWheelOn({}),false);assert.equal(fairWheelOn({YEET_FAIR_WHEEL:'1'}),false);assert.equal(fairWheelOn({YEET_FAIR_WHEEL:'on'}),true);
});

test('the published vectors: same commitment and same draw as the public check',()=>{
 for(const v of VECTORS){
  assert.equal(commitmentOf(v.server_seed),v.commitment);
  assert.equal(createHash('sha256').update(v.server_seed).digest('hex'),v.commitment);
  const o=fairOutcome({serverSeed:v.server_seed,clientSeed:v.client_seed,spinId:v.spin_id,coins:v.coins,weights:BONUS_TABLE});
  assert.deepEqual({draw_xp:o.draw_xp,coin:o.coin,coin_index:o.coin_index,streak_draw_xp:o.streak_draw_xp},v.expect);
 }
});

test('rejection sampling: a word at or above the last whole multiple is skipped, never folded',()=>{
 const coins=['A','B','C'];
 // 2^32 mod 100 = 96, so 4294967200 is the first rejected word for the weight draw.
 assert.equal(drawFromWords([4294967200,4294967295],{weights:BONUS_TABLE,coins}),null);
 const r=drawFromWords([4294967200,0,4294967295,1,22],{weights:BONUS_TABLE,coins});
 // 0 -> xp 0; coin: 4294967295 >= 2^32 - (2^32 mod 3) is skipped, 1 -> B; streak: 22 -> still the first row (weight 23)
 assert.deepEqual([r.draw_xp,r.coin,r.streak_draw_xp,r.words_used],[0,'B',0,5]);
 // Over many seeds the draw follows the weights (within 1.5 points of each weight).
 const counts=new Map();const N=20000;
 for(let i=0;i<N;i+=1){const o=fairOutcome({serverSeed:'a'.repeat(64),clientSeed:`seed-${String(i).padStart(6,'0')}`,spinId:'s_'+'0'.repeat(24),coins,weights:BONUS_TABLE});counts.set(o.draw_xp,(counts.get(o.draw_xp)??0)+1)}
 for(const r of BONUS_TABLE)assert.ok(Math.abs((counts.get(r.xp)??0)/N*100-r.weight)<1.5,`xp ${r.xp}`);
});

test('ordering: the commitment is stored before any client seed is accepted',()=>{
 const {now,l,spin}=setup();
 // A seed for a spin that was never committed is refused, and nothing is written.
 assert.throws(()=>spin.spin('a',undefined,{client_seed:SEED,spin_id:'s_'+'1'.repeat(24)}),e=>e.code==='INVALID_ARGUMENT');
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_event'),0);
 // Showing the wheel commits: the row exists, unseeded, and the server seed is not published.
 const next=spin.fairNext('a');
 assert.ok(SPIN_ID.test(next.spin_id));assert.equal(Object.keys(next).sort().join(),'commitment,spin_id');
 const before=row(l,next.spin_id);
 assert.equal(before.client_seed,null);assert.equal(before.used_at,null);assert.equal(before.commitment,next.commitment);
 assert.deepEqual(spin.fairNext('a'),next,'showing it again: the same commitment');
 assert.deepEqual(spin.nextWheel('a'),JSON.parse(before.layout),'the wheel shown is the committed one');
 // The wrong spin id (a stale card) is refused too.
 assert.throws(()=>spin.spin('a',undefined,{client_seed:SEED,spin_id:'s_'+'2'.repeat(24)}),e=>e.code==='INVALID_ARGUMENT');
 assert.throws(()=>spin.spin('a',undefined,{client_seed:'short',spin_id:next.spin_id}),e=>e.code==='INVALID_ARGUMENT');
 assert.equal(row(l,next.spin_id).client_seed,null);
 now.advance(60_000);
 const s=spin.spin('a',undefined,{client_seed:SEED,spin_id:next.spin_id});
 const after=row(l,next.spin_id);
 assert.equal(after.client_seed,SEED);assert.equal(after.client_seed_by,'card');
 assert.ok(after.committed_at<after.used_at,`${after.committed_at} < ${after.used_at}`);
 // The reveal: the published commitment, the seed behind it, the card's seed, and the draw they give.
 assert.equal(s.fair.commitment,next.commitment);assert.equal(s.fair.spin_id,next.spin_id);
 assert.equal(commitmentOf(s.fair.server_seed),next.commitment);assert.equal(s.fair.client_seed,SEED);
 const o=fairOutcome({serverSeed:s.fair.server_seed,clientSeed:SEED,spinId:next.spin_id,coins:s.fair.coins,weights:BONUS_TABLE});
 assert.equal(s.draw_xp,o.draw_xp);assert.equal(s.stamp.coin,o.coin);assert.equal(s.xp_won,5+o.draw_xp);
 assert.deepEqual(s.wheel[s.slice],{coin:o.coin,xp:o.draw_xp});
 // The landed wheel is the committed one with at most two slices changed (a swap, or a value not shown before).
 const diff=s.wheel.filter((w,i)=>w.xp!==JSON.parse(before.layout)[i].xp).length;assert.ok(diff<=2,String(diff));
 assert.equal(s.fair_next,null,'nothing left today');
 
 assert.deepEqual(spin.spin('a'),s);
});

test('single use: a commitment takes one seed; an extra spin has its own commitment',()=>{
 const {l,spin}=setup();
 const first=spin.fairNext('a');
 spin.spin('a',undefined,{client_seed:SEED,spin_id:first.spin_id});
 // The used row cannot take another seed.
 assert.equal(Number(l.db.prepare('UPDATE xp_fair_spin SET client_seed=? WHERE spin_id=? AND client_seed IS NULL').run('x'.repeat(16),first.spin_id).changes),0);
 spin.grantSpin('a','2026-11-01','trade_bonus','t1');
 assert.throws(()=>spin.spin('a',undefined,{client_seed:SEED,spin_id:first.spin_id}),e=>e.code==='INVALID_ARGUMENT','the old spin id is not the extra spin\'s');
 const extra=spin.fairNext('a');assert.notEqual(extra.spin_id,first.spin_id);assert.notEqual(extra.commitment,first.commitment);
 const x=spin.spin('a',undefined,{client_seed:SEED,spin_id:extra.spin_id});
 assert.equal(x.spin_kind,'extra');assert.equal(x.fair.spin_id,extra.spin_id);
 const o=fairOutcome({serverSeed:x.fair.server_seed,clientSeed:SEED,spinId:extra.spin_id,coins:x.fair.coins,weights:BONUS_TABLE});
 assert.equal(x.draw_xp,o.draw_xp);assert.equal(x.stamp.coin,o.coin);
 assert.equal(n(l,'SELECT COUNT(*) n FROM xp_fair_spin WHERE client_seed IS NOT NULL'),2);
});

test('a card with no seed: the server commits first, then picks the seed, and says so',()=>{
 const {l,spin}=setup();
 const s=spin.spin('a');
 assert.equal(s.fair.client_seed_by,'server');
 const r=row(l,s.fair.spin_id);assert.ok(r.committed_at<=r.used_at);
 assert.equal(commitmentOf(s.fair.server_seed),s.fair.commitment);
});

test('streak milestone: the streak draw is the third draw of the same seeds',()=>{
 const {now,spin}=setup();
 let s;
 for(let d=0;d<3;d+=1){const f=spin.fairNext('a');s=spin.spin('a',undefined,{client_seed:SEED,spin_id:f.spin_id});now.advance(DAY)}
 assert.equal(s.streak_days,3);
 assert.equal(s.streak_xp,25+s.fair.streak_draw_xp);
 assert.ok(s.fair_next&&SPIN_ID.test(s.fair_next.spin_id),'the milestone\'s extra spin is committed in the same answer');
});

test('switch off: no table, no fair fields, the same draws as before, seeds ignored',()=>{
 const {l,spin}=setup({fair:false});
 assert.equal(spin.fairNext('a'),undefined);
 const s=spin.spin('a',undefined,{client_seed:SEED,spin_id:'s_'+'1'.repeat(24)});
 assert.equal('fair' in s,false);assert.equal('fair_next' in s,false);
 assert.equal(s.draw_xp,roll(SECRET,'a|2026-11-01'));assert.equal(s.stamp.coin,rollCoin(SECRET,'a','2026-11-01',spin.stamps.coins));
 assert.equal(l.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='xp_fair_spin'").get().n,0);
 const xp=openXp({secret:SECRET});assert.equal('fair_next' in xp.summary('a'),false);
});

test('summary carries fair_next with the switch on',()=>{
 const xp=openXp({secret:SECRET,fair:true});
 const sum=xp.summary('a');assert.ok(SPIN_ID.test(sum.fair_next.spin_id));
 const s=xp.doSpin('a',{client_seed:SEED,spin_id:sum.fair_next.spin_id});
 assert.equal(s.fair.commitment,sum.fair_next.commitment);
 assert.equal(xp.summary('a').fair_next,null);
});

test('landedWheel swaps the drawn value onto the drawn coin',()=>{
 const w=[{coin:'A',xp:0},{coin:'B',xp:2},{coin:'C',xp:5}];
 assert.deepEqual(landedWheel(w,'A',5),{wheel:[{coin:'A',xp:5},{coin:'B',xp:2},{coin:'C',xp:0}],slice:0});
 assert.deepEqual(landedWheel(w,'B',40),{wheel:[{coin:'A',xp:0},{coin:'B',xp:40},{coin:'C',xp:5}],slice:1});
});

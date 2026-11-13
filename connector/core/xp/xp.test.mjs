// Lane E: XP ledger, streak, daily spin, leaderboard, and trade settlement paying exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {openLedger,DEFAULT_RULES} from './ledger.mjs';
import {streakDays} from './streak.mjs';
import {roll,BONUS_TABLE,createSpin,streakMilestone,STREAK_BONUS,STREAK_RULES,streakMilestones,nextStreakMilestone} from './spin.mjs';
import {leaderboard,rankRows,handle} from './board.mjs';
import {openXp,homeXp,homeXpKeys,checkSpinTable,serverSpinTable} from './xp.mjs';
import {createEngine} from '../trade/engine.mjs';
import {openTradeDb} from '../trade/db.mjs';
import {fakeOneClick,fakeSigner,fakeBalances,fakeClock,BASE_WALLET,SOL_WALLET,FAKE_POLICY_ENV} from '../trade/fakes.mjs';
import {toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';

const SECRET='test-xp-secret-0123456789abcdef';
const out=name=>zodSchema(z,toolSchemas[name].output);
const clock=(iso='2026-11-12T12:00:00.000Z')=>fakeClock(Date.parse(iso));
const at=iso=>new Date(Date.parse(iso)).toISOString();

test('rule table: five events, caps as documented',()=>{
 assert.deepEqual(DEFAULT_RULES.map(r=>[r.event,r.points,r.per_day_cap,r.lifetime_cap]),
  [['sign_in',5,1,null],['first_yeet',50,null,1],['yeet_settled',20,5,null],['skeet_settled',10,5,null],['daily_spin',5,1,null]]);
});

test('ledger: dedupe per key, per-day cap resets at the UTC day, lifetime cap holds',()=>{
 const now=clock('2026-11-12T23:59:00.000Z');const l=openLedger(':memory:',{now});
 assert.equal(l.award('a','sign_in','2026-11-12'),5);
 assert.equal(l.award('a','sign_in','2026-11-12'),0,'same key: deduped');
 assert.equal(l.award('a','sign_in','other-key'),0,'per-day cap 1');
 assert.equal(l.award('a','first_yeet','t1'),50);assert.equal(l.award('a','first_yeet','t2'),0,'lifetime cap 1');
 for(let i=0;i<5;i++)assert.equal(l.award('a','yeet_settled',`t${i}`),20);
 assert.equal(l.award('a','yeet_settled','t5'),0,'per-day cap 5');
 now.advance(2*60_000);// 00:01 UTC next day
 assert.equal(l.award('a','yeet_settled','t5'),20,'new UTC day, new cap');
 assert.equal(l.award('a','sign_in','2026-11-13'),5);
 assert.equal(l.total('a'),5+50+100+20+5);assert.equal(l.total('b'),0);
 assert.throws(()=>l.award('a','deposit','x'),/Unknown XP event/);
});

test('draw: repeatable for a fixed seed and secret, different across days and secrets, follows the table',()=>{
 const a=roll(SECRET,'yeet-privy-a|2026-11-12');
 for(let i=0;i<5;i++)assert.equal(roll(SECRET,'yeet-privy-a|2026-11-12'),a);
 assert.ok(BONUS_TABLE.some(r=>r.xp===a));
 assert.equal(BONUS_TABLE.reduce((s,r)=>s+r.weight,0),100);
 assert.equal(BONUS_TABLE.reduce((s,r)=>s+r.xp*r.weight,0)/100,7.52);
 const days=Array.from({length:30},(_,i)=>roll(SECRET,`yeet-privy-a|2026-11-${String(i+1).padStart(2,'0')}`));
 assert.ok(new Set(days).size>=4,`draws vary across days: ${days}`);
 const other=Array.from({length:30},(_,i)=>roll('another-secret-0123456789',`yeet-privy-a|2026-11-${String(i+1).padStart(2,'0')}`));
 assert.notDeepEqual(other,days,'another secret, another sequence');
 // Over many seeds the draw lands near the table's weights.
 const n=20_000,hits=new Map();
 for(let i=0;i<n;i++){const x=roll(SECRET,`s|${i}`);hits.set(x,(hits.get(x)??0)+1)}
 for(const r of BONUS_TABLE)assert.ok(Math.abs(hits.get(r.xp)/n*100-r.weight)<1.2,`${r.xp}: ${hits.get(r.xp)}`);
});

test('streak: consecutive UTC days, across midnight and gaps; today without XP keeps yesterday’s streak',()=>{
 const now=clock();const l=openLedger(':memory:',{now});
 const ev=(iso,key)=>l.award('a','yeet_settled',key,{at:at(iso)});
 ev('2026-11-01T10:00:00Z','k1');
 ev('2026-11-03T23:59:59Z','k2');ev('2026-11-04T00:00:01Z','k3');ev('2026-11-05T12:00:00Z','k4');
 assert.equal(streakDays(l.db,'a','2026-11-01'),1);
 assert.equal(streakDays(l.db,'a','2026-11-02'),1,'no XP yet on the 2nd: yesterday still counts');
 assert.equal(streakDays(l.db,'a','2026-11-03'),1,'a gap day breaks it');
 assert.equal(streakDays(l.db,'a','2026-11-04'),2,'23:59 and 00:01 are two UTC days');
 assert.equal(streakDays(l.db,'a','2026-11-05'),3);
 assert.equal(streakDays(l.db,'a','2026-11-06'),3);
 assert.equal(streakDays(l.db,'a','2026-11-07'),0,'two days without XP: gone');
 assert.equal(streakDays(l.db,'b','2026-11-05'),0);
});

test("YEET text.",()=>{
 const now=clock('2026-11-10T08:00:00.000Z');const l=openLedger(':memory:',{now});
 const spin=createSpin({ledger:l,secret:SECRET});
 assert.equal(spin.available('a'),true);
 const s1=spin.spin('a');
 out('daily_spin').parse(s1);
 assert.equal(s1.xp_won,5+roll(SECRET,'a|2026-11-10'));assert.equal(s1.total,s1.xp_won);assert.equal(s1.streak_days,1);
 assert.equal(s1.draw_xp,roll(SECRET,'a|2026-11-10'));assert.equal(s1.streak_xp,0);
 assert.equal(s1.next_spin_at,'2026-11-11T00:00:00.000Z');
 assert.equal(spin.available('a'),false);
 now.advance(15*3600_000);// 23:00 same day
 assert.deepEqual(spin.spin('a'),s1,'repeat: same spin, nothing added');
 assert.equal(l.db.prepare("SELECT COUNT(*) n FROM xp_event WHERE event='daily_spin'").get().n,1);
 now.advance(3600_000);// 00:00 next day
 assert.equal(spin.available('a'),true);
 const s2=spin.spin('a');assert.equal(s2.streak_days,2);assert.equal(s2.xp_won,5+roll(SECRET,'a|2026-11-11'));
 now.advance(86_400_000);
 const s3=spin.spin('a');assert.equal(s3.streak_days,3);assert.equal(s3.xp_won,5+roll(SECRET,'a|2026-11-12')+STREAK_BONUS+roll(SECRET,'a|2026-11-12|streak'));
 assert.equal(s3.total,s1.xp_won+s2.xp_won+s3.xp_won);
 // The parts the card needs: the wheel lands on base + draw_xp; streak_xp (fixed bonus + its own draw) is shown apart.
 assert.equal(s3.draw_xp,roll(SECRET,'a|2026-11-12'));assert.equal(s3.streak_xp,STREAK_BONUS+roll(SECRET,'a|2026-11-12|streak'));
 out('daily_spin').parse(s3);
 assert.deepEqual(spin.spin('a'),s3,'repeat on a milestone day: same parts');
 assert.deepEqual([1,2,3,4,6,7,8,14,21,28,35].map(streakMilestone),[false,false,true,false,false,true,false,true,true,true,true]);
 // Without a secret there is no spin, and home says so.
 const off=createSpin({ledger:l,secret:undefined});
 assert.equal(off.available('z'),false);assert.throws(()=>off.spin('z'),e=>e.code==='TEMPORARILY_UNAVAILABLE');
});

test('leaderboard: tied XP shares a rank, the next rank skips; week board counts only the last 7 days; me',()=>{
 assert.deepEqual(rankRows([{id:'a',name:'A',xp:10},{id:'b',name:'B',xp:30},{id:'c',name:'C',xp:30},{id:'d',name:'D',xp:5},{id:'e',name:'E',xp:5}]).map(r=>[r.id,r.rank]),
  [['b',1],['c',1],['a',3],['d',4],['e',4]]);
 const now=clock('2026-11-12T12:00:00.000Z');const l=openLedger(':memory:',{now});
 l.award('old','first_yeet','t0',{at:at('2026-11-01T00:00:00Z')});// 50, outside the week
 l.award('x','yeet_settled','t1');l.award('y','yeet_settled','t2');l.award('z','skeet_settled','t3');
 const all=leaderboard(l.db,{kind:'xp',me:'y',at:now()});
 out('yeet_leaderboard').parse(all);
 assert.deepEqual(all.rows.map(r=>[r.rank,r.xp]),[[1,50],[2,20],[2,20],[4,10]]);
 assert.deepEqual(all.me,{rank:2,xp:20});
 const week=leaderboard(l.db,{kind:'week',me:'old',at:now()});
 assert.deepEqual(week.rows.map(r=>[r.rank,r.xp]),[[1,20],[1,20],[3,10]]);
 assert.deepEqual(week.me,{rank:null,xp:0},'no XP this week: no rank');
 assert.deepEqual(leaderboard(l.db,{me:'nobody',at:now()}).me,{rank:null,xp:0});
 for(let i=0;i<60;i++)l.award(`p${i}`,'sign_in','d');
 assert.equal(leaderboard(l.db,{at:now()}).rows.length,50,'at most 50 rows');
});

test('names: a short handle that leaks no account id, sign-in id, email or wallet address',()=>{
 const people=[
  {account:'yeet-privy-Qm9vYmFyYmF6cXV4MTIzNA',did:'did:privy:cm3abcdefghijklmnop',email:'alice.smith@example.com',wallets:[BASE_WALLET,SOL_WALLET]},
  {account:'yeet-privy-AAAAAAAAAAAAAAAAAAAAAA',did:'did:privy:zz9',email:'bob@example.org',wallets:['0x'+'ab'.repeat(20)]},
 ];
 // Every 5-character window of an identifier (case-insensitive) must be absent: more than first 4/last 4 never shows.
 const windows=s=>{const t=s.toLowerCase(),w=[];for(let i=0;i+5<=t.length;i++)w.push(t.slice(i,i+5));return w};
 for(const p of people){
  const name=handle(p.account);
  assert.match(name,/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);assert.ok(name.length<=32);
  assert.equal(handle(p.account),name,'stable');
  for(const id of [p.account,p.account.slice('yeet-privy-'.length),p.did,p.did.slice('did:privy:'.length),p.email,p.email.split('@')[0],...p.wallets])
   for(const w of windows(id))assert.ok(!name.toLowerCase().includes(w),`${name} contains ${w}`);
  assert.doesNotMatch(name,/@|0x|did|privy|yeet/i);
 }
 // And the board shows only handles.
 const l=openLedger(':memory:',{now:clock()});
 for(const p of people)l.award(p.account,'sign_in','d');
 const board=JSON.stringify(leaderboard(l.db,{at:Date.now()}));
 for(const p of people){assert.ok(!board.includes(p.account));assert.ok(board.includes(handle(p.account)))}
});

// Trades through the real engine (fake 1Click, signer and balances), XP subscribed to onSettled.
const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const basket=(id,legs=[{symbol:'WIF',parts:6},{symbol:'BOME',parts:4}])=>({request_id:id,amount_usdc:'20',legs});
async function engineOn(db,xp,now,oneclick=fakeOneClick()){
 return createEngine({db,env:{YEET_LIVE:'1',...FAKE_POLICY_ENV},client:oneclick,signer:fakeSigner(),balances:fakeBalances(),now,onSettled:e=>xp.onSettled(e),trackerIntervalMs:0});
}
const tradeOnce=async(engine,id,legs)=>{const p=await engine.propose(alice,basket(id,legs));return engine.execute(alice,{proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code})};

test('trade XP: paid once on settlement; never again after a tracker restart, a repeated event or a status read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yeet-xp-'));
 try{
  const now=clock(),tradeDb=openTradeDb(':memory:');
  let xp=openXp({file:join(dir,'xp.sqlite'),secret:SECRET,now});
  let engine=await engineOn(tradeDb,xp,now);
  const r=await tradeOnce(engine,'x1');
  const view0=engine.status(alice,r.trade_id);
  assert.equal(xp.tradeAward(alice.accountId,view0),null,'not final yet: no award');
  await engine.tracker.pollOnce();await engine.tracker.pollOnce();
  const view=engine.status(alice,r.trade_id);assert.equal(view.status,'success');
  assert.equal(xp.ledger.total(alice.accountId),70,'paid by onSettled, before any status read');
  const award=xp.tradeAward(alice.accountId,view);
  assert.deepEqual(award,{points:70,total:70},'first YEET 50 + YEET settled 20');
  out('trade_status').parse({...view,xp_award:award});
  // Restart: close and reopen the XP file, build a new engine (new tracker) on the same trade database.
  xp.close();xp=openXp({file:join(dir,'xp.sqlite'),secret:SECRET,now});
  engine.tracker.stop();engine=await engineOn(tradeDb,xp,now);
  assert.equal(await engine.tracker.pollOnce(),0);
  xp.onSettled({tradeId:r.trade_id,accountId:alice.accountId,direction:'yeet',status:'success'});
  xp.settleTrade({tradeId:r.trade_id,accountId:alice.accountId,direction:'yeet',status:'success'});
  assert.deepEqual(xp.tradeAward(alice.accountId,engine.status(alice,r.trade_id)),{points:70,total:70});
  assert.equal(xp.ledger.total(alice.accountId),70);
  assert.equal(xp.ledger.db.prepare('SELECT COUNT(*) n FROM xp_event').get().n,2);
  // A second trade earns only the per-trade rule; first_yeet is spent.
  const r2=await tradeOnce(engine,'x2');await engine.tracker.pollOnce();await engine.tracker.pollOnce();
  assert.deepEqual(xp.tradeAward(alice.accountId,engine.status(alice,r2.trade_id)),{points:20,total:90});
  // The award is the owner's only.
  assert.equal(xp.tradeAward('yeet-privy-bob',engine.status(alice,r2.trade_id)),null);
  xp.close();engine.tracker.stop();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('trade XP: a lost onSettled (crash before the hook) is paid by the next status read, once; refunds pay 0',async()=>{
 const now=clock(),tradeDb=openTradeDb(':memory:');
 const xp=openXp({secret:SECRET,now});
 const lost=await createEngine({db:tradeDb,env:{YEET_LIVE:'1',...FAKE_POLICY_ENV},client:fakeOneClick(),signer:fakeSigner(),balances:fakeBalances(),now,onSettled:()=>{throw Error('crash')},trackerIntervalMs:0});
 const r=await tradeOnce(lost,'l1',[{symbol:'WIF',parts:10}]);
 await lost.tracker.pollOnce();await lost.tracker.pollOnce();
 assert.equal(xp.ledger.total(alice.accountId),0);
 const view=lost.status(alice,r.trade_id);
 assert.deepEqual(xp.tradeAward(alice.accountId,view),{points:70,total:70});
 assert.deepEqual(xp.tradeAward(alice.accountId,view),{points:70,total:70});
 assert.equal(xp.ledger.total(alice.accountId),70);
 lost.tracker.stop();
 const refunded=await engineOn(tradeDb,xp,now,fakeOneClick({statuses:['status-refunded.json']}));
 const r2=await tradeOnce(refunded,'l2',[{symbol:'WIF',parts:10}]);await refunded.tracker.pollOnce();
 const v2=refunded.status(alice,r2.trade_id);assert.equal(v2.status,'refunded');
 assert.deepEqual(xp.tradeAward(alice.accountId,v2),{points:0,total:70});
 refunded.tracker.stop();
});

test('home summary: total, streak and spin availability; recent wins stay empty',()=>{
 const now=clock();const xp=openXp({secret:SECRET,now});
 const next={days:3,xp:STREAK_BONUS};
 assert.deepEqual(xp.summary('a'),{total:0,streak_days:0,spin_available:true,next_streak_milestone:next});
 xp.signIn('a');xp.signIn('a');
 assert.deepEqual(xp.summary('a'),{total:5,streak_days:1,spin_available:true,next_streak_milestone:next});
 const s=xp.doSpin('a');
 assert.deepEqual(xp.summary('a'),{total:5+s.xp_won,streak_days:1,spin_available:false,next_streak_milestone:next});
 assert.deepEqual(xp.recentWins(),[]);
});

test('streak milestones: one table, day 3 then every 7th day; next milestone ported from Folio',()=>{
 const paying=Array.from({length:70},(_,i)=>i+1).filter(d=>streakMilestone(d));
 assert.deepEqual(paying,[3,7,14,21,28,35,42,49,56,63,70]);
 for(const d of paying)assert.equal(streakMilestones(d).reduce((sum,r)=>sum+r.xp,0),STREAK_BONUS,`one rule pays on day ${d}`);
 assert.ok(STREAK_RULES.every(r=>r.roll&&r.xp===STREAK_BONUS));
 assert.deepEqual([0,1,2,3,6,7,13,27,28,34,35,100].map(d=>nextStreakMilestone(d)?.days),[3,3,3,7,7,14,14,28,35,35,42,105]);
 assert.deepEqual(nextStreakMilestone(5),{days:7,xp:25});
 // A custom table: rules firing on the same day add up; a one-time table runs out.
 const rules=[{days:2,repeat_every:2,xp:10,roll:false},{days:4,repeat_every:null,xp:7,roll:true}];
 assert.deepEqual(nextStreakMilestone(3,rules),{days:4,xp:17});
 assert.deepEqual(nextStreakMilestone(4,rules),{days:6,xp:10});
 assert.equal(nextStreakMilestone(4,[{days:4,repeat_every:null,xp:7,roll:true}]),null);
});

test('streak milestone: 25 XP plus a draw seeded id|day|streak, separate from the daily draw',()=>{
 const now=clock('2026-11-01T09:00:00.000Z');const l=openLedger(':memory:',{now});
 const spin=createSpin({ledger:l,secret:SECRET});
 const paid=[];
 for(let i=0;i<14;i++){
  const day=new Date(now()).toISOString().slice(0,10);
  const s=spin.spin('a');
  const daily=5+roll(SECRET,`a|${day}`);
  const bonus=s.xp_won-daily;paid.push(bonus);
  if(streakMilestone(s.streak_days))assert.equal(bonus,STREAK_BONUS+roll(SECRET,`a|${day}|streak`),`day ${s.streak_days}`);
  else assert.equal(bonus,0,`day ${s.streak_days}`);
  now.advance(86_400_000);
 }
 assert.deepEqual(paid.map((b,i)=>b>0?i+1:0).filter(Boolean),[3,7,14]);
 // The streak seed is its own: over many accounts it does not track the daily draw.
 const pairs=Array.from({length:200},(_,i)=>[roll(SECRET,`u${i}|2026-11-03`),roll(SECRET,`u${i}|2026-11-03|streak`)]);
 assert.ok(pairs.filter(([a,b])=>a!==b).length>100);
});

test('next_streak_milestone: today’s spin still counts until it happens; homeXp keeps only contract fields',()=>{
 const now=clock('2026-11-01T09:00:00.000Z');const xp=openXp({secret:SECRET,now});
 xp.doSpin('a');now.advance(86_400_000);xp.doSpin('a');now.advance(86_400_000);
 // Day 3: a sign-in already made today active (streak 3), but the spin that pays day 3 has not happened.
 xp.signIn('a');
 assert.equal(xp.summary('a').streak_days,3);
 assert.deepEqual(xp.summary('a').next_streak_milestone,{days:3,xp:25});
 xp.doSpin('a');
 assert.deepEqual(xp.summary('a').next_streak_milestone,{days:7,xp:25});
 // A missed day resets the run; the next milestone is day 3 again.
 now.advance(2*86_400_000);
 assert.deepEqual(xp.summary('a').next_streak_milestone,{days:3,xp:25});
 // No spin configured: no milestone can pay.
 assert.equal(openXp({secret:undefined,now}).summary('a').next_streak_milestone,null);
 // The pinned contract lists next_streak_milestone in yeet_home.xp, so the home block carries it unchanged and parses.
 const summary=xp.summary('a');
 const HOME_XP_KEYS=homeXpKeys(toolSchemas.yeet_home.output);
 assert.deepEqual(HOME_XP_KEYS,['total','streak_days','spin_available','next_streak_milestone']);
 const block=homeXp(summary,HOME_XP_KEYS);
 assert.deepEqual(block,summary);
 const xpSchema=zodSchema(z,toolSchemas.yeet_home.output.properties.xp);
 assert.equal(xpSchema.safeParse(block).success,true);
 assert.equal(xpSchema.safeParse({...block,next_streak_milestone:null}).success,true,'null when no milestone can pay');
 // The xp object stays closed: a field the contract does not list is refused.
 assert.equal(xpSchema.safeParse({...block,extra:1}).success,false);
});

test('spin: the public x-yeet-spin contract matches the server table and streak rules',()=>{
 const c=JSON.parse(readFileSync(new URL('../../vendor/yeet-win/contracts/yeet-tools.json',import.meta.url),'utf8'))['x-yeet-spin'];
 assert.equal(c.base_xp,DEFAULT_RULES.find(r=>r.rule_id==='daily_spin').points);
 assert.deepEqual(c.bonus_xp,BONUS_TABLE.map(r=>r.xp));
 assert.ok(STREAK_RULES.every(r=>r.xp===c.streak_bonus_xp),'one fixed streak bonus');
 assert.equal(c.streak_draw,STREAK_RULES.some(r=>r.roll));
});

test('spin: the server table passes the vendored x-yeet-spin check, and a drifted table is refused',()=>{
 const spec=JSON.parse(readFileSync(new URL('../../vendor/yeet-win/contracts/yeet-tools.json',import.meta.url),'utf8'))['x-yeet-spin'];
 assert.doesNotThrow(()=>checkSpinTable(spec));
 const t=serverSpinTable();
 assert.deepEqual(t,{base_xp:5,bonus:BONUS_TABLE,streak_bonus_xp:STREAK_BONUS});
 assert.throws(()=>checkSpinTable({...spec,base_xp:spec.base_xp+1}),/base_xp/);
 assert.throws(()=>checkSpinTable({...spec,streak_bonus_xp:spec.streak_bonus_xp+1}),/streak_bonus_xp/);
 assert.throws(()=>checkSpinTable({...spec,bonus_xp:[...spec.bonus_xp].reverse()}),/bonus xp/);
 assert.throws(()=>checkSpinTable(spec,{...t,bonus:t.bonus.map((r,i)=>i?r:{...r,weight:r.weight+1})}),/weights sum/);
 assert.throws(()=>checkSpinTable(undefined),/x-yeet-spin/);
});

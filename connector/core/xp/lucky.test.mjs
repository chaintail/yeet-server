// The lucky wheel (lucky.mjs), the quote-availability check (availability.mjs) and yeet_home's xp.wheel (spin.mjs
// nextWheel). Owner rules: 5 hot coins, the person spins, it lands on one coin; a settled YEET of 5 USDC into that coin
// gives one bonus daily spin plus a stamp of that coin.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openXp} from './xp.mjs';
import {luckyCoins,luckyIdFor,hotRanking,LUCKY_ID,LUCKY_SLICES} from './lucky.mjs';
import {createAvailability,quoteProbe,AVAILABILITY_TTL_MS} from './availability.mjs';
import {fakeOneClick} from '../trade/fakes.mjs';
import {findToken} from '../trade/router.mjs';

const SECRET='test-lucky-secret-0123456789abcdef';
const clock=(start='2026-11-13T09:00:00.000Z')=>{let t=Date.parse(start);const f=()=>t;f.advance=ms=>{t+=ms};return f};
const DAY=86_400_000;
// What 1Click answered today: no quote for MELANIA, LOUD and NEARKAT.
const NO_QUOTE=['MELANIA','LOUD','NEARKAT'];
const allBut=blocked=>async symbols=>symbols.filter(s=>!blocked.includes(s));
const open=(o={})=>{const now=clock(o.start);return {now,xp:openXp({secret:SECRET,now})}};
const refusal=code=>e=>e?.name==='TradeError'&&e.code===code;
const buy=(legs,status='success')=>({trade_id:'t_aaaaaaaaaaaaaaaaaaaa',direction:'yeet',status,legs:legs.map(([symbol,amount_in,s='SUCCESS'])=>({symbol,status:s,amount_in}))});
const grants=(xp,who)=>xp.ledger.db.prepare("SELECT reason,unique_ref,day FROM xp_spin_grant WHERE identity_id=? AND reason='trade_bonus'").all(who).map(r=>({...r}));
const stampsOf=(xp,who,coin)=>xp.spin.stamps.list(who).find(s=>s.coin===coin).count;
/** A spun lucky wheel for `who`, linked to proposal `p`; returns the landed coin. */
async function landed(xp,who,p='p_lucky'){
 const w=await xp.lucky.wheel(who,allBut(NO_QUOTE));
 const s=xp.lucky.spin(who,w.lucky.lucky_id);
 xp.lucky.link(who,s.lucky.lucky_id,p);
 return {id:s.lucky.lucky_id,coin:s.lucky.wheel[s.lucky.slice].coin,others:s.lucky.wheel.map(c=>c.coin).filter(c=>c!==s.lucky.wheel[s.lucky.slice].coin)};
}

test('lucky_wheel: five meme coins 1Click can quote, ranked per UTC day, the same for everyone; stored once per account and day',async()=>{
 const {now,xp}=open();
 assert.ok(!luckyCoins().includes('SOL')&&!luckyCoins().includes('USDC'),'meme coins only');
 const a=(await xp.lucky.wheel('a',allBut(NO_QUOTE))).lucky,b=(await xp.lucky.wheel('b',allBut(NO_QUOTE))).lucky;
 assert.match(a.lucky_id,LUCKY_ID);assert.equal(a.lucky_id,luckyIdFor(SECRET,'a','2026-11-13'));assert.notEqual(a.lucky_id,b.lucky_id);
 assert.equal(a.wheel.length,LUCKY_SLICES);
 for(const c of a.wheel)assert.ok(!NO_QUOTE.includes(c.coin),`${c.coin} had no quote`);
 const expected=hotRanking(SECRET,'2026-11-13',luckyCoins()).filter(c=>!NO_QUOTE.includes(c)).slice(0,5);
 assert.deepEqual(a.wheel.map(c=>c.coin),expected);assert.deepEqual(b.wheel,a.wheel,'one hot list per day');
 assert.deepEqual({slice:a.slice,amount_usdc:a.amount_usdc,claimed:a.claimed,expires_at:a.expires_at},{slice:null,amount_usdc:'5',claimed:false,expires_at:'2026-11-14T00:00:00.000Z'});
 // Stored: availability changing later the same day does not change the wheel already shown.
 assert.deepEqual((await xp.lucky.wheel('a',allBut([...NO_QUOTE,...expected.slice(0,2)]))).lucky,a);
 // Fewer than two tradeable coins: no wheel (retryable), nothing stored.
 now.advance(DAY);
 await assert.rejects(xp.lucky.wheel('a',async()=>['WIF']),refusal('TEMPORARILY_UNAVAILABLE'));
 const next=(await xp.lucky.wheel('a',allBut(NO_QUOTE))).lucky;
 assert.notEqual(next.lucky_id,a.lucky_id,'a new wheel on the next UTC day');
 // No secret: off.
 await assert.rejects(openXp({secret:undefined}).lucky.wheel('a',allBut([])),refusal('TEMPORARILY_UNAVAILABLE'));
});

test('lucky_spin: the server draws once and stores it; a second spin the same day returns the same coin; only the owner, only today',async()=>{
 const {now,xp}=open();
 const w=(await xp.lucky.wheel('a',allBut(NO_QUOTE))).lucky;
 const s=xp.lucky.spin('a',w.lucky_id).lucky;
 assert.ok(Number.isInteger(s.slice)&&s.slice>=0&&s.slice<5);assert.deepEqual(s.wheel,w.wheel);
 for(let i=0;i<3;i++)assert.deepEqual(xp.lucky.spin('a',w.lucky_id).lucky,s,'repeat: same slice');
 // A fresh database with the same secret draws the same slice (keyed draw, not random).
 const again=openXp({secret:SECRET,now});await again.lucky.wheel('a',allBut(NO_QUOTE));
 assert.equal(again.lucky.spin('a',w.lucky_id).lucky.slice,s.slice);
 // Someone else's lucky_id, an unknown one and a malformed one read the same.
 assert.throws(()=>xp.lucky.spin('b',w.lucky_id),refusal('INVALID_ARGUMENT'));
 assert.throws(()=>xp.lucky.spin('a','l_0000000000000000'),refusal('INVALID_ARGUMENT'));
 assert.throws(()=>xp.lucky.spin('a','nope'),refusal('INVALID_ARGUMENT'));
 // Yesterday's unspun wheel can no longer be spun; yesterday's spun wheel still reads back.
 const b=(await xp.lucky.wheel('b',allBut(NO_QUOTE))).lucky;
 now.advance(DAY);
 assert.throws(()=>xp.lucky.spin('b',b.lucky_id),refusal('INVALID_ARGUMENT'));
 assert.deepEqual(xp.lucky.spin('a',w.lucky_id).lucky,s);
});

test('yeet_propose lucky_id: only the caller’s own wheel, spun, from today',async()=>{
 const {now,xp}=open();
 const w=(await xp.lucky.wheel('a',allBut(NO_QUOTE))).lucky;
 assert.throws(()=>xp.lucky.check('a',w.lucky_id),refusal('INVALID_ARGUMENT'),'not spun yet');
 xp.lucky.spin('a',w.lucky_id);
 assert.equal(xp.lucky.check('a',w.lucky_id).lucky.lucky_id,w.lucky_id);
 assert.throws(()=>xp.lucky.check('b',w.lucky_id),refusal('INVALID_ARGUMENT'),'someone else’s lucky_id');
 assert.throws(()=>xp.lucky.link('b',w.lucky_id,'p_b'),refusal('INVALID_ARGUMENT'));
 now.advance(DAY);
 assert.throws(()=>xp.lucky.check('a',w.lucky_id),refusal('INVALID_ARGUMENT'),'expired');
});

test('lucky claim: wrong coin, under 5 USDC, refunded or failed leg, a SKEET: no grant; 5 USDC into the coin: one grant and one stamp, once',async()=>{
 const {xp}=open();
 const {id,coin,others}=await landed(xp,'a');
 const none=r=>assert.deepEqual(r,{claimed:false,fresh:false});
 none(xp.lucky.settle('a','p_lucky',buy([[others[0],'20']])));
 none(xp.lucky.settle('a','p_lucky',buy([[coin,'4.999999']])));
 none(xp.lucky.settle('a','p_lucky',buy([[coin,'5','REFUNDED']],'refunded')));
 none(xp.lucky.settle('a','p_lucky',buy([[coin,'5','FAILED'],[others[0],'5']],'partial')));
 none(xp.lucky.settle('a','p_lucky',buy([[coin,'5','PROCESSING']],'settling')));
 none(xp.lucky.settle('a','p_lucky',{...buy([[coin,'5']]),direction:'skeet'}));
 none(xp.lucky.settle('a','p_other',buy([[coin,'5']])),'a proposal not linked to the wheel');
 none(xp.lucky.settle('b','p_lucky',buy([[coin,'5']])),'someone else settling the linked proposal');
 assert.deepEqual(grants(xp,'a'),[]);assert.equal(xp.lucky.get('a',id).lucky.claimed,false);
 const before=stampsOf(xp,'a',coin);
 const r=xp.lucky.settle('a','p_lucky',buy([[coin,'5']]));
 assert.equal(r.claimed,true);assert.equal(r.fresh,true);assert.equal(r.grant.granted,true);
 assert.deepEqual(grants(xp,'a'),[{reason:'trade_bonus',unique_ref:id,day:'2026-11-13'}]);
 assert.equal(stampsOf(xp,'a',coin),before+1,'a stamp of the landed coin');
 assert.equal(xp.lucky.get('a',id).lucky.claimed,true);
 assert.equal(xp.lucky.spin('a',id).lucky.claimed,true,'lucky_spin reads claimed too');
 // Double settle (tracker event and trade_status, or a replay): nothing more.
 for(let i=0;i<3;i++)assert.deepEqual(xp.lucky.settle('a','p_lucky',buy([[coin,'5']])),{claimed:true,fresh:false});
 assert.equal(grants(xp,'a').length,1);assert.equal(stampsOf(xp,'a',coin),before+1);
 // A grant made directly for the same lucky_id is refused as a repeat.
 assert.equal(xp.spin.grantSpin('a','2026-11-13','trade_bonus',id).granted,false);
});

test('lucky claim: a basket counts when the landed coin’s own leg is at least 5 USDC and SUCCESS',async()=>{
 const {xp}=open();
 const {coin,others}=await landed(xp,'a');
 assert.equal(xp.lucky.settle('a','p_lucky',buy([[others[0],'10'],[coin,'4']])).claimed,false,'10 USDC in the basket, 4 into the coin');
 assert.equal(xp.lucky.settle('a','p_lucky',buy([[others[0],'3','FAILED'],[coin,'5.5']],'partial')).fresh,true,'partial trade, the coin leg succeeded');
});

test('the bonus spin: an ordinary extra daily spin (trade_bonus) with its own XP and stamp; the lucky stamp is not a spin',async()=>{
 const {xp}=open();
 const {coin}=await landed(xp,'a');
 const daily=xp.doSpin('a');assert.equal(daily.spins_available,0);
 xp.lucky.settle('a','p_lucky',buy([[coin,'5']]));
 // After the claim the daily spin's repeat is still the daily spin (the lucky stamp is skipped), and an extra is open.
 const s=xp.summary('a');assert.equal(s.spins_available,1);assert.equal(s.extra_spin_reason,'trade_bonus');
 const extra=xp.doSpin('a');
 assert.equal(extra.spin_kind,'extra');assert.equal(extra.spin_reason,'trade_bonus');assert.equal(extra.spins_available,0);
 assert.deepEqual(extra.wheel,s.wheel,'xp.wheel before an extra spin is that spin’s wheel');
 assert.equal(extra.wheel[extra.slice].coin,extra.stamp.coin);
 const repeat=xp.doSpin('a');assert.equal(repeat.spin_kind,'extra');assert.equal(repeat.xp_won,extra.xp_won,'nothing left: the latest spin again');
 assert.deepEqual(xp.summary('a').wheel,extra.wheel);
});

test('availability: a dry 1Click quote per coin through a fake client, cached for the TTL, one quote in flight per coin',async()=>{
 const inner=fakeOneClick();
 const blocked=new Set(NO_QUOTE.map(s=>findToken(s,'solana').assetId));
 const quotes=[];
 const client={authenticated:false,async quote(req){quotes.push(req);if(blocked.has(req.destinationAsset))throw Error('no quote');return inner.quote(req)}};
 let t=0;const now=()=>t;
 const a=createAvailability({probe:quoteProbe({client}),now});
 const coins=luckyCoins();
 assert.deepEqual(await a.available(coins),coins.filter(c=>!NO_QUOTE.includes(c)));
 assert.equal(quotes.length,coins.length);assert.ok(quotes.every(q=>q.dry===true),'dry quotes only: nothing moves');
 await Promise.all([a.available(coins),a.available(coins)]);
 assert.equal(quotes.length,coins.length,'cached within the TTL');
 t+=AVAILABILITY_TTL_MS;blocked.clear();
 assert.deepEqual(await a.available(coins),coins,'re-checked after the TTL: the coins quote again');
 assert.equal(quotes.length,2*coins.length);
 // Concurrent checks of one coin share one quote.
 let calls=0;const slow=createAvailability({probe:async()=>{calls++;await new Promise(r=>setTimeout(r,5));return true}});
 await Promise.all([slow.check('WIF'),slow.check('WIF'),slow.check('WIF')]);assert.equal(calls,1);
 // A probe that answers false or throws marks the coin unavailable.
 assert.deepEqual(await createAvailability({probe:async s=>s==='WIF'}).available(['WIF','BOME']),['WIF']);
});

test('xp.wheel: before any spin it is the wheel the daily spin then returns; left out without a spin secret',()=>{
 const {xp}=open();
 const w=xp.summary('z').wheel;
 assert.deepEqual(xp.doSpin('z').wheel,w);
 assert.equal('wheel' in openXp({secret:undefined}).summary('z'),false);
});

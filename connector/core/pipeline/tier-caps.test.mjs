// BUY caps by XP tier (owner ruling 2026-11-13, trade/limits.mjs TIER_DEFAULTS): Noob under 69 XP 25 per trade /
// 100 a day, Winner 69..1000 XP 100 / 420, VIP over 1000 XP 500 / 6767 USDC. A basket is one trade. SELLs are never
// capped and never counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePipeline,ALICE,aliceWallet,signAs,WIF_MINT} from './fakes.mjs';
import {USDC_SOLANA} from './solana/message.mjs';
import {limitsFromEnv,tierFor,capsFor,capsView,recordSpend,spentToday,checkBasket} from '../trade/limits.mjs';

const exec=(p,ctx,prop)=>p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
const buy=(p,usdc,legs=[{symbol:'WIF',parts:1}],id=`r-${usdc}-${Math.random()}`)=>p.propose(ALICE,{request_id:id,amount_usdc:String(usdc),legs});
const rich=[{mint:USDC_SOLANA,raw:10_000_000_000n,decimals:6},{mint:WIF_MINT,raw:10_000_000_000_000n,decimals:6}];
const usdc=n=>BigInt(n)*1_000_000n;
async function limitExceeded(pr,re){
 await assert.rejects(pr,e=>{assert.equal(e.code,'LIMIT_EXCEEDED');if(re)assert.match(e.userMessage,re);assert.ok(e.userMessage.length<=500);return true});
}

test('tier boundaries: 68 Noob, 69 Winner, 1000 Winner, 1001 VIP, with their per-trade and daily caps',()=>{
 const l=limitsFromEnv({});
 const at=xp=>{const t=tierFor(l,xp);return [t.name,t.maxTradeRaw,t.dailyCapRaw]};
 assert.deepEqual(at(0),['Noob',usdc(25),usdc(100)]);
 assert.deepEqual(at(68),['Noob',usdc(25),usdc(100)]);
 assert.deepEqual(at(69),['Winner',usdc(100),usdc(420)]);
 assert.deepEqual(at(1000),['Winner',usdc(100),usdc(420)]);
 assert.deepEqual(at(1001),['VIP',usdc(500),usdc(6767)]);
 assert.deepEqual(at(undefined),['Noob',usdc(25),usdc(100)],'unknown XP is the lowest tier');
 // The account-blind ceiling (driver re-checks) is the highest tier.
 assert.equal(l.maxTradeRaw,usdc(500));assert.equal(l.dailyCapRaw,usdc(6767));
 // Env overrides stay possible.
 assert.equal(tierFor(limitsFromEnv({YEET_TIER_NOOB_TRADE_USDC:'10'}),0).maxTradeRaw,usdc(10));
});

test('the old flat caps, when still set, are a global ceiling that clamps every tier',async()=>{
 const f=fakePipeline({xp:5000,holdings:rich,env:{YEET_MAX_TRADE_USDC:'25',YEET_DAILY_CAP_USDC:'50'}});
 const c=capsFor(f.db,f.p.limits,ALICE.accountId,f.now(),5000);
 assert.deepEqual(capsView(c),{tier:'VIP',per_trade_usdc:'25',daily_limit_usdc:'50',left_today_usdc:'50'});
 await limitExceeded(buy(f.p,26),/25 USDC per-trade limit as a VIP/);
});

for(const [xp,tier,trade,daily] of [[68,'Noob',25,100],[69,'Winner',100,420],[1000,'Winner',100,420],[1001,'VIP',500,6767]]){
 test(`${xp} XP (${tier}): per-trade cap ${trade}, daily limit ${daily}, exposed on the proposal and in the refusal`,async()=>{
  const f=fakePipeline({xp,holdings:rich});const {p,db}=f;
  const ok=await buy(p,trade);
  assert.deepEqual(ok.limits,{tier,per_trade_usdc:String(trade),daily_limit_usdc:String(daily),left_today_usdc:String(daily)});
  await limitExceeded(buy(p,trade+1),new RegExp(`your ${trade} USDC per-trade limit as a ${tier} \\(${xp} XP\\)`));
  // Daily: spend up to `trade` short of the limit, then one USDC over what is left.
  recordSpend(db,ALICE.accountId,f.now(),usdc(daily-trade+1));
  const left=trade-1;
  const near=await buy(p,left);
  assert.equal(near.limits.left_today_usdc,String(left));
  await limitExceeded(buy(p,left+1),new RegExp(`your ${daily} USDC daily limit as a ${tier} \\(${xp} XP\\): you have ${left} USDC left today`));
  // execute re-checks with the tier at the tap.
  await limitExceeded(exec(p,ALICE,ok));
 });
}

test('a basket counts as one trade: 5 coins of 6 USDC (30) is over the Noob 25 cap, 25 across 5 coins is fine',async()=>{
 const {p,db,now}=fakePipeline({xp:0,holdings:rich});
 const five=['WIF','BOME','TRUMP','PENGU','SPX'].map(symbol=>({symbol,parts:1}));
 await limitExceeded(buy(p,30,five),/25 USDC per-trade limit as a Noob/);
 const ok=await buy(p,25,five);
 assert.equal(ok.legs.length,5);
 const caps=capsFor(db,p.limits,ALICE.accountId,now(),0);
 assert.throws(()=>checkBasket(p.limits,[usdc(6),usdc(6),usdc(6),usdc(6),usdc(6)],caps),e=>e.code==='LIMIT_EXCEEDED');
 assert.equal(checkBasket(p.limits,[usdc(5),usdc(5),usdc(5),usdc(5),usdc(5)],caps),usdc(25));
});

test('the refusal points at the next tier; VIP has none',async()=>{
 const noob=fakePipeline({xp:10,holdings:rich});
 await limitExceeded(buy(noob.p,26),/Earn XP to reach Winner at 69 XP for 100 USDC per trade\./);
 const vip=fakePipeline({xp:5000,holdings:rich});
 await assert.rejects(buy(vip.p,501),e=>e.code==='LIMIT_EXCEEDED'&&!/Earn XP/.test(e.userMessage));
});

test('yeet_home carries the tier, both caps and what is left today',async()=>{
 const f=fakePipeline({xp:69,holdings:rich});
 recordSpend(f.db,ALICE.accountId,f.now(),usdc(20));
 const h=await f.p.home(ALICE);
 assert.deepEqual(h.limits,{tier:'Winner',per_trade_usdc:'100',daily_limit_usdc:'420',left_today_usdc:'400'});
 assert.deepEqual(capsView(capsFor(f.db,f.p.limits,ALICE.accountId,f.now(),69)),h.limits);
});

test('the tier is read per call: XP earned during the day lifts the cap at once',async()=>{
 let xp=68;
 const {p}=fakePipeline({xp:()=>xp,holdings:rich});
 await limitExceeded(buy(p,26),/Noob/);
 xp=69;
 assert.equal((await buy(p,26)).limits.tier,'Winner');
});

test('an XP store that cannot be read counts as 0 XP (Noob caps)',async()=>{
 const {p}=fakePipeline({xp:()=>{throw Error('xp down')},holdings:rich});
 await limitExceeded(buy(p,26),/Noob \(0 XP\)/);
});

test('the product sentence reaches the tool result: core failure -> MCP toolError (LIMIT_EXCEEDED and BALANCE_LOW only)',async()=>{
 const {failure,withUserMessage}=await import('../failure.mjs');
 const {toolError}=await import('../../mcp/errors.mjs');
 const {p}=fakePipeline({xp:0,holdings:rich});
 const e=await buy(p,26).catch(e=>e);
 const body=withUserMessage(failure(e.code),e);
 assert.equal(body.message,e.userMessage);
 const r=JSON.parse(toolError(body).content[0].text);
 assert.deepEqual(Object.keys(r),['error','message','retryable','guidance']);
 assert.equal(r.error,'LIMIT_EXCEEDED');assert.match(r.message,/25 USDC per-trade limit as a Noob \(0 XP\)/);
 // The guidance for the model names the tier from that sentence and what unlocks the next one (mcp/guidance.mjs).
 assert.match(r.guidance,/YEET/);
 // BALANCE_LOW carries the core's sentence with both balances (pipeline/funding.mjs); any other code keeps the catalogue text.
 const low=JSON.parse(toolError({error:'BALANCE_LOW',message:'you have $4.00 USDC on Base and you have $7.50 USDC on Solana.'}).content[0].text);
 assert.match(low.message,/USDC on Base/);
 const other=JSON.parse(toolError({error:'COST_TOO_HIGH',message:'made up'}).content[0].text);
 assert.notEqual(other.message,'made up');
 assert.equal(withUserMessage(failure('COST_TOO_HIGH'),{userMessage:'made up'}).message,failure('COST_TOO_HIGH').message);
});

test('SELL is never capped: above every cap, on an account whose daily BUY limit is used up, it goes through and is not counted',async()=>{
 const f=fakePipeline({xp:0,holdings:rich});const {p,db}=f;
 recordSpend(db,ALICE.accountId,f.now(),usdc(100));
 await limitExceeded(buy(p,3),/you have 0 USDC left today/);
 const s=await p.skeet(ALICE,{request_id:'big-sell',legs:[{symbol:'WIF',percent:100}]});
 const outRaw=BigInt(s.legs[0].est_out_raw??Math.round(Number(s.legs[0].est_out)*1e6));
 assert.ok(outRaw>usdc(6767),`the sell pays out more than every cap (${outRaw})`);
 const x=await exec(p,ALICE,s);
 assert.equal(x.status,'awaiting_signature');
 assert.equal(x.sign_requests.length,1);
 const out=await p.submit(ALICE,{trade_id:x.trade_id,leg:0,attempt_id:x.sign_requests[0].attempt_id,signed:signAs(aliceWallet,x.sign_requests[0])});
 assert.equal(out.legs[0].send_status,'signing');
 assert.equal(spentToday(db,ALICE.accountId,f.now()),usdc(100),'a SELL adds nothing to the daily BUY spend');
});

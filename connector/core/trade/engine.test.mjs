// Acceptance B-1: the trade engine against a fake 1Click (router fixtures), fake wallets/RPC and a fake signer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fakeEngine,fakeOneClick,fakeSigner,fakeBalances,fakeClock,BASE_WALLET,SOL_WALLET} from './fakes.mjs';
import {ReceiptSchema,CATALOG} from './router.mjs';
import {toolSchemas,zodSchema} from '../../mcp/tool-contract.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const bob={accountId:'yeet-privy-bob',clientId:alice.clientId};
const basket={request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:3},{symbol:'TRUMP',parts:2}]};
const out=name=>zodSchema(z,toolSchemas[name].output);
const strip=({confirm,...rest})=>rest;
async function code(p,re){await assert.rejects(p,e=>e.code===re,`expected ${re}`)}
const exec=(engine,ctx,p,c=p.confirm.code)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:c});

test('propose: dry plan, contract-shaped proposal, confirm code beside it; idempotent on request_id',async()=>{
 const {engine,oneclick}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 out('yeet_propose').parse(strip(p));
 assert.match(p.proposal_id,/^p_[a-z0-9]{20}$/);assert.equal(p.revision,1);assert.equal(p.direction,'yeet');assert.equal(p.next,'Tap ⚡ YEET in the card');
 assert.deepEqual(p.legs.map(l=>[l.symbol,l.parts,l.amount_in]),[['WIF',5,'10'],['BOME',3,'6'],['TRUMP',2,'4']]);
 assert.match(p.confirm.code,/^[A-Za-z0-9_-]{43}$/);assert.equal(Date.parse(p.confirm.expires_at)-Date.parse('2026-11-12T12:00:00Z'),120_000);
 assert.ok(oneclick.calls.quote.every(q=>q.dry===true&&q.recipient===SOL_WALLET&&q.refundTo===BASE_WALLET));
 const again=await engine.propose(alice,basket);
 assert.equal(again.proposal_id,p.proposal_id);assert.notEqual(again.confirm.code,p.confirm.code);
 assert.equal(oneclick.calls.quote.length,3,'the replayed request asks 1Click nothing');
 await code(engine.propose(alice,{...basket,amount_usdc:'21'}),'INVALID_ARGUMENT');
 const other=await engine.propose({...alice,clientId:'another-client'},basket);
 assert.notEqual(other.proposal_id,p.proposal_id,'idempotency is per account and client');
});

test('B-1 code single-use, and replay of a used code returns the same trade without a second transfer',async()=>{
 const {engine,signer}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 out('execute_trade').parse(r);
 assert.equal(r.status,'submitted');assert.match(r.trade_id,/^t_[a-z0-9]{20}$/);
 assert.deepEqual(r.legs.map(l=>l.status),['sent','sent','sent']);
 assert.ok(r.legs.every(l=>/^https:\/\/basescan\.org\/tx\/0x[0-9a-f]{64}$/.test(l.explorer_url)));
 assert.equal(signer.sent.length,3);
 assert.deepEqual(signer.sent.map(s=>s.amountRaw),['10000000','6000000','4000000'],'exact amountIn per leg');
 const replay=await exec(engine,alice,p);
 assert.deepEqual(replay,r);assert.equal(signer.sent.length,3);
});

test('B-1 expiry: a code older than 120 s is refused and moves nothing',async()=>{
 const {engine,signer,now}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 now.advance(120_001);
 await code(exec(engine,alice,p),'CONFIRMATION_REQUIRED');
 assert.equal(signer.sent.length,0);
});

test('B-1 wrong account or client: refused, and the owner can still use the code',async()=>{
 const {engine,signer}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 await code(exec(engine,bob,p),'CONFIRMATION_REQUIRED');
 await code(exec(engine,{...alice,clientId:'other'},p),'CONFIRMATION_REQUIRED');
 await code(exec(engine,alice,p,'x'.repeat(43)),'CONFIRMATION_REQUIRED');
 assert.equal(signer.sent.length,0);
 assert.equal((await exec(engine,alice,p)).status,'submitted');
});

test('B-1 revision mismatch: a code works only for its own, current revision',async()=>{
 const {engine}=await fakeEngine();
 const p1=await engine.propose(alice,basket);
 const p2=await engine.quote(alice,{proposal_id:p1.proposal_id,legs:[{symbol:'WIF',parts:10}]});
 out('yeet_quote').parse(strip(p2));
 assert.equal(p2.revision,2);assert.deepEqual(p2.legs.map(l=>l.symbol),['WIF']);
 await code(exec(engine,alice,p1),'CONFIRMATION_REQUIRED');
 await code(engine.execute(alice,{proposal_id:p1.proposal_id,revision:2,confirm:p1.confirm.code}),'CONFIRMATION_REQUIRED');
 await code(engine.execute(alice,{proposal_id:p1.proposal_id,revision:1,confirm:p2.confirm.code}),'CONFIRMATION_REQUIRED');
 assert.equal((await exec(engine,alice,p2)).status,'submitted');
 await code(engine.quote(alice,{proposal_id:p1.proposal_id}),'INVALID_ARGUMENT');
});

test('B-1 REQUOTE when a live leg is under the preview minimum: new revision and code; old code replays the requote',async()=>{
 const {engine,oneclick,signer}=await fakeEngine();
 const p=await engine.propose(alice,basket);
 oneclick.liveRatio=0.95;
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'requote_required');assert.deepEqual(r.legs,[]);
 out('execute_trade').parse(strip(r));
 assert.equal(r.requote.revision,2);assert.match(r.confirm.code,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(signer.sent.length,0);
 assert.deepEqual(await exec(engine,alice,p),strip(r),'the used code replays the same requote');
 oneclick.liveRatio=0.95;// the new preview is the live price; the same live price is fine now
 const done=await engine.execute(alice,{proposal_id:p.proposal_id,revision:2,confirm:r.confirm.code});
 assert.equal(done.status,'submitted');assert.equal(signer.sent.length,3);
});

test('B-1 REQUOTE when the preview is over 60 s old and the live output is worse (still above the minimum)',async()=>{
 const {engine,oneclick,now}=await fakeEngine();
 const fresh=await engine.propose(alice,basket);
 oneclick.liveRatio=0.995;// worse than the estimate, above min_out (99%)
 assert.equal((await exec(engine,alice,fresh)).status,'submitted','a fresh preview tolerates a small move');
 const old=await engine.propose(alice,{request_id:'r2',amount_usdc:'10',legs:[{symbol:'WIF',parts:10}]});
 now.advance(61_000);// preview 61 s old, code (120 s) still valid
 const r=await exec(engine,alice,old);
 assert.equal(r.status,'requote_required');assert.equal(r.requote.revision,2);
});

test('B-1 limits: minimum per coin, per-trade cap, cost ceiling, parts, coins, leg count',async()=>{
 const {engine,oneclick}=await fakeEngine();
 await code(engine.propose(alice,{request_id:'a',amount_usdc:'10',legs:[{symbol:'WIF',parts:8},{symbol:'BOME',parts:2}]}),'AMOUNT_TOO_SMALL');
 await code(engine.propose(alice,{request_id:'b',amount_usdc:'25.000001',legs:[{symbol:'WIF',parts:10}]}),'LIMIT_EXCEEDED');
 await code(engine.propose(alice,{request_id:'c',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:4}]}),'PARTS_NOT_TEN');
 await code(engine.propose(alice,{request_id:'d',amount_usdc:'20',legs:[{symbol:'DOGE',parts:10}]}),'COIN_NOT_SUPPORTED');
 await code(engine.propose(alice,{request_id:'e',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'wif',parts:5}]}),'INVALID_ARGUMENT');
 await code(engine.propose(alice,{request_id:'f',amount_usdc:'20',legs:['WIF','BOME','TRUMP','PENGU','SPX','TURBO'].map(symbol=>({symbol,parts:symbol==='WIF'?5:1}))}),'INVALID_ARGUMENT');
 oneclick.cost=0.09;
 await code(engine.propose(alice,{request_id:'g',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}),'COST_TOO_HIGH');
 oneclick.cost=0.04;
 const warn=await engine.propose(alice,{request_id:'h',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]});
 assert.ok(warn.warnings.includes('COST_HIGH'));
 const {engine:strict}=await fakeEngine({env:{YEET_LIVE:'1',YEET_MIN_LEG_USDC:'5',YEET_MAX_TRADE_USDC:'10',YEET_MAX_COST_BPS:'0'}});
 await code(strict.propose(alice,{request_id:'i',amount_usdc:'8',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:5}]}),'AMOUNT_TOO_SMALL');
 await code(strict.propose(alice,{request_id:'j',amount_usdc:'11',legs:[{symbol:'WIF',parts:10}]}),'LIMIT_EXCEEDED');
 await code(strict.propose(alice,{request_id:'k',amount_usdc:'10',legs:[{symbol:'WIF',parts:10}]}),'COST_TOO_HIGH');
 await assert.rejects(fakeEngine({env:{YEET_MAX_TRADE_USDC:'lots'}}),/Invalid YEET_MAX_TRADE_USDC/);
});

test('B-1 daily cap accumulates per account and UTC day, at proposal and again at the tap',async()=>{
 const {engine,now,signer}=await fakeEngine();
 for(const id of ['d1','d2']){const p=await engine.propose(alice,{request_id:id,amount_usdc:'25',legs:[{symbol:'WIF',parts:10}]});assert.equal((await exec(engine,alice,p)).status,'submitted')}
 await code(engine.propose(alice,{request_id:'d3',amount_usdc:'3',legs:[{symbol:'WIF',parts:10}]}),'LIMIT_EXCEEDED');
 const other=await engine.propose(bob,{request_id:'d3',amount_usdc:'3',legs:[{symbol:'WIF',parts:10}]});
 assert.equal(other.revision,1,'another account has its own cap');
 now.advance(12*3600_000);// next UTC day
 const props=[];for(const [id,amount] of [['d4','20'],['d5','25'],['d6','10']])props.push(await engine.propose(alice,{request_id:id,amount_usdc:amount,legs:[{symbol:'WIF',parts:10}]}));
 assert.equal((await exec(engine,alice,props[0])).status,'submitted');
 assert.equal((await exec(engine,alice,props[1])).status,'submitted');
 await code(exec(engine,alice,props[2]),'LIMIT_EXCEEDED');// 45 + 10 > 50: re-checked at the tap
 assert.equal(signer.sent.length,4);
});

test('B-1 kill switch pauses proposals and taps; YEET_LIVE unset gives TRADING_PAUSED and keeps the code',async()=>{
 const {engine:killed}=await fakeEngine({env:{YEET_LIVE:'1',YEET_KILL_SWITCH:'1'}});
 await code(killed.propose(alice,basket),'TRADING_PAUSED');
 const {engine:dry,signer,db}=await fakeEngine({env:{}});
 const p=await dry.propose(alice,basket);
 await code(exec(dry,alice,p),'TRADING_PAUSED');
 assert.equal(signer.sent.length,0);
 assert.equal(db.prepare('SELECT used_at FROM confirm_codes').all().filter(r=>r.used_at!==null).length,0,'the code was not used');
 assert.equal((await dry.home(alice)).ready,'paused');
 const {engine:live,db:ldb}=await fakeEngine();
 const q=await live.propose(alice,basket);
 // Flip the switch: a new engine (as after a restart with YEET_KILL_SWITCH set) on the same state.
 const {createEngine}=await import('./engine.mjs');
 const flipped=await createEngine({db:ldb,env:{YEET_LIVE:'1',YEET_KILL_SWITCH:'true'},client:fakeOneClick(),signer:fakeSigner(),balances:fakeBalances(),now:fakeClock(),trackerIntervalMs:0});
 await code(exec(flipped,alice,q),'TRADING_PAUSED');
});

test('B-1 partial leg failure: the trade is partial, the failed leg is reported and not counted against the cap',async()=>{
 const signer=fakeSigner({failLegs:[1]});
 const {engine,db}=await fakeEngine({signer});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'submitted');
 assert.deepEqual(r.legs.map(l=>[l.symbol,l.status]),[['WIF','sent'],['BOME','failed'],['TRUMP','sent']]);
 assert.equal(r.legs[1].tx_hash,null);
 const s=engine.status(alice,r.trade_id);
 out('trade_status').parse(s);
 assert.equal(s.status,'partial');assert.equal(s.legs[1].status,'FAILED');
 assert.equal(db.prepare('SELECT usdc_raw FROM daily_spend').get().usdc_raw,'14000000');
 const all=fakeSigner({failLegs:[0,1,2],failCode:'LIMIT_EXCEEDED'});
 const {engine:e2}=await fakeEngine({signer:all});
 const p2=await e2.propose(alice,basket);
 await code(exec(e2,alice,p2),'LIMIT_EXCEEDED');
 await code(exec(e2,alice,p2),'LIMIT_EXCEEDED');// replay answers the same
});

test('B-1 time budget: legs not sent in time stay unsent and the trade is partial',async()=>{
 const now=fakeClock();
 const signer=fakeSigner({onSend:()=>now.advance(8_000)});
 const {engine}=await fakeEngine({signer,now,budgetMs:15_000});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.deepEqual(r.legs.map(l=>l.status),['sent','sent','not_sent']);
 assert.equal(engine.status(alice,r.trade_id).status,'partial');
});

test('B-1 settled: the tracker folds /status with applyStatus; the receipt passes ReceiptSchema; onSettled fires once',async()=>{
 const settled=[];
 const {engine,db,oneclick}=await fakeEngine({onSettled:e=>settled.push(e)});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.equal(oneclick.calls.submit.length,3);
 assert.equal(engine.status(alice,r.trade_id).status,'submitted');
 await engine.tracker.pollOnce();
 const mid=engine.status(alice,r.trade_id);assert.equal(mid.status,'settling');assert.deepEqual(mid.received,[]);
 await engine.tracker.pollOnce();
 const s=engine.status(alice,r.trade_id);
 out('trade_status').parse(s);
 assert.equal(s.status,'success');
 assert.deepEqual(s.received.map(x=>x.symbol),['WIF','BOME','TRUMP']);
 assert.ok(s.legs.every(l=>l.status==='SUCCESS'&&l.amount_out&&/^0x[0-9a-f]{64}$/.test(l.origin_tx)&&l.destination_tx));
 const receipt=ReceiptSchema.parse(JSON.parse(db.prepare('SELECT receipt_json FROM trades WHERE id=?').get(r.trade_id).receipt_json));
 assert.equal(receipt.complete,true);assert.equal(receipt.legs.length,3);
 assert.deepEqual(receipt.legs[0].history.map(h=>h.status),['PENDING_DEPOSIT','PROCESSING','SUCCESS']);
 assert.equal(settled.length,1);assert.equal(settled[0].status,'success');
 assert.equal(await engine.tracker.pollOnce(),0,'nothing left to track');assert.equal(settled.length,1);
 await code(Promise.resolve().then(()=>engine.status(bob,r.trade_id)),'INVALID_ARGUMENT');
});

test('B-1 refunded legs: status refunded when every sent leg is refunded',async()=>{
 const oneclick=fakeOneClick({statuses:['status-refunded.json']});
 const {engine}=await fakeEngine({oneclick});
 const p=await engine.propose(alice,{...basket,legs:[{symbol:'WIF',parts:10}]});
 const r=await exec(engine,alice,p);
 await engine.tracker.pollOnce();
 const s=engine.status(alice,r.trade_id);
 assert.equal(s.status,'refunded');assert.equal(s.legs[0].refund_reason,'PARTIAL_DEPOSIT');assert.equal(s.legs[0].amount_out,null);
});

test('B-1 wallet checks at the tap: BALANCE_LOW and WALLET_NOT_READY; yeet_home readiness',async()=>{
 const balances=fakeBalances({usdc:'5'});const signer=fakeSigner({signerState:'none'});
 const {engine}=await fakeEngine({balances,signer});
 const p=await engine.propose(alice,basket);
 assert.ok(p.warnings.includes('BALANCE_LOW')&&p.warnings.includes('SIGNER_MISSING'));
 await code(exec(engine,alice,p),'WALLET_NOT_READY');
 assert.equal((await engine.home(alice)).ready,'needs_signer');
 signer.signerState='granted';
 await code(exec(engine,alice,p),'BALANCE_LOW');
 balances.usdcRaw=1_000_000n;
 const home=await engine.home(alice);out('yeet_home').parse(home);
 assert.equal(home.ready,'needs_funds');assert.equal(home.wallets.base.usdc,'1');assert.equal(home.xp,null);
 balances.usdcRaw=100_000_000n;
 assert.equal((await engine.home(alice)).ready,'ready');
});

test('SKEET: percent of holdings, sold to USDC on Base through the same tap; portfolio lists holdings',async()=>{
 const wif=CATALOG.find(c=>c.symbol==='WIF');
 const balances=fakeBalances({holdings:[{mint:wif.address,raw:8_000_000n,decimals:6,tokenAccount:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}]});
 const {engine,signer}=await fakeEngine({balances});
 const port=await engine.portfolio(alice);out('yeet_portfolio').parse(port);
 assert.deepEqual(port.solana.holdings.map(h=>[h.symbol,h.amount]),[['WIF','8']]);
 const p=await engine.skeet(alice,{request_id:'s1',legs:[{symbol:'WIF',percent:50}]});
 out('skeet_propose').parse(strip(p));
 assert.equal(p.direction,'skeet');assert.equal(p.next,'Tap SKEET in the card');assert.equal(p.legs[0].amount_in,'4');assert.equal(p.legs[0].parts,null);
 await code(engine.skeet(alice,{request_id:'s2',legs:[{symbol:'BOME',percent:50}]}),'BALANCE_LOW');
 await code(engine.quote(alice,{proposal_id:p.proposal_id,amount_usdc:'5'}),'INVALID_ARGUMENT');
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'submitted');assert.equal(signer.sent[0].chain,'solana');assert.equal(signer.sent[0].amountRaw,'4000000');
 assert.match(r.legs[0].explorer_url,/^https:\/\/solscan\.io\/tx\//);
});

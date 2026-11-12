// Engine hardening: allowed transitions, the append-only trade_events audit, the source-balance check and the
// stuck-trade alert outbox. Fakes only (no network, no signer, no funds).
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeEngine,fakeOneClick,fakeSigner,fakeBalances,fakeChain} from './fakes.mjs';
import {CATALOG} from './router.mjs';
import {openTradeDb,tx} from './db.mjs';
import {legalTransition,transitionTrade,transitionLeg,tradeEvents,TransitionRefused,TRADE_EDGES,LEG_EDGES} from './audit.mjs';
import {USDC_KEY,expectedDebit,compareDebit,listAlerts,raiseAlert} from './accounting.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const basket={request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:3},{symbol:'TRUMP',parts:2}]};
const one={...basket,legs:[{symbol:'WIF',parts:10}]};
const exec=(engine,ctx,p,c=p.confirm.code)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:c});
const tradeRow=(db,id)=>db.prepare('SELECT * FROM trades WHERE id=?').get(id);
const refused=e=>e instanceof TransitionRefused&&e.code==='TRANSITION_REFUSED';

function bareTrade(db,{id='t_x',status='signing',legStatus='queued'}={}){
 db.prepare("INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES(?,'p',1,'a','yeet',?,0,0)").run(id,status);
 db.prepare("INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,updated_at) VALUES(?,0,'WIF','1','0xd','{}',?,0)").run(id,legStatus);
 return id;
}

// (1) allowed-transition table

test('transitions: the table allows the forward edges only and nothing leaves a final status',()=>{
 for(const [from,to] of [[null,'signing'],[null,'requote_required'],['signing','submitted'],['signing','failed'],['submitted','settling'],['settling','success'],['settling','partial'],['partial','refunded']])
  assert.ok(legalTransition(from,to),`${from} -> ${to}`);
 for(const [from,to] of [['success','failed'],['failed','success'],['refunded','partial'],['settling','submitted'],['submitted','signing'],['requote_required','signing'],['partial','success'],[null,'success']])
  assert.ok(!legalTransition(from,to),`${from} -> ${to}`);
 for(const s of ['success','refunded','failed','requote_required'])assert.deepEqual(TRADE_EDGES[s],[]);
 for(const [from,to] of [[null,'queued'],['queued','sending'],['queued','failed'],['queued','not_sent'],['sending','sent'],['sending','failed']])
  assert.ok(legalTransition(from,to,'trade_legs'),`leg ${from} -> ${to}`);
 for(const [from,to] of [['sent','sending'],['sending','queued'],['sending','not_sent'],['failed','sent'],['not_sent','queued'],['queued','sent']])
  assert.ok(!legalTransition(from,to,'trade_legs'),`leg ${from} -> ${to}`);
 for(const s of ['sent','failed','not_sent'])assert.deepEqual(LEG_EDGES[s],[]);
});

test('transitions: guarded UPDATE refuses an illegal edge, a terminal state without evidence, and a stale `from` (0 rows)',()=>{
 const db=openTradeDb(':memory:');
 const id=bareTrade(db);
 assert.throws(()=>transitionTrade(db,{tradeId:id,from:'signing',to:'requote_required',evidence:{x:1},at:1}),refused);
 assert.throws(()=>transitionTrade(db,{tradeId:id,from:'signing',to:'failed',at:1}),refused,'terminal needs evidence');
 assert.throws(()=>transitionTrade(db,{tradeId:id,from:'signing',to:'failed',evidence:{},at:1}),refused,'empty evidence is none');
 assert.equal(transitionTrade(db,{tradeId:id,from:'submitted',to:'settling',at:1}),false,'row is not in `from`: 0 rows, refused');
 assert.equal(tradeRow(db,id).status,'signing');
 assert.equal(tradeEvents(db,id).length,0,'a refused transition writes no audit row');
 assert.equal(transitionTrade(db,{tradeId:id,from:'signing',to:'submitted',set:{updated_at:5},at:5}),true);
 assert.equal(tradeRow(db,id).status,'submitted');assert.equal(tradeRow(db,id).updated_at,5);
 // legs
 assert.throws(()=>transitionLeg(db,{tradeId:id,idx:0,from:'queued',to:'sent',evidence:{tx_hash:'0x1'},at:6}),refused);
 assert.equal(transitionLeg(db,{tradeId:id,idx:0,from:'queued',to:'sending',evidence:{idempotency_key:'k'},at:6}),true);
 assert.throws(()=>transitionLeg(db,{tradeId:id,idx:0,from:'sending',to:'sent',evidence:{source:'signer'},at:7}),refused,'a sent leg needs a hash or a 1Click status');
 assert.equal(transitionLeg(db,{tradeId:id,idx:0,from:'queued',to:'sending',evidence:{idempotency_key:'k'},at:7}),false,'second claim of a queued leg loses');
 assert.equal(db.prepare('SELECT send_status FROM trade_legs').get().send_status,'sending');
});

test('transitions: a refused trade transition in the tracker leaves the stored status alone and is noted',async()=>{
 const oneclick=fakeOneClick({statuses:['status-success.json']});
 const {engine,db}=await fakeEngine({oneclick});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 await engine.tracker.pollOnce();
 assert.equal(tradeRow(db,r.trade_id).status,'success');
 // An out-of-band write (a bug, an operator) puts a leg back in flight; the tracker would fold success -> signing.
 db.prepare("UPDATE trade_legs SET send_status='sending' WHERE trade_id=?").run(r.trade_id);
 assert.throws(()=>engine.tracker.refresh(r.trade_id),refused);
 assert.equal(tradeRow(db,r.trade_id).status,'success');
});

// (2) append-only trade_events

test('audit: a settled trade has one event per state change, terminal ones with evidence, in order',async()=>{
 const {engine,db}=await fakeEngine();
 const r=await exec(engine,alice,await engine.propose(alice,basket));
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 assert.equal(tradeRow(db,r.trade_id).status,'success');
 const ev=tradeEvents(db,r.trade_id);
 const trade=ev.filter(e=>e.kind==='trade').map(e=>[e.from_status,e.to_status]);
 assert.deepEqual(trade,[[null,'signing'],['signing','submitted'],['submitted','settling'],['settling','success']]);
 for(const idx of [0,1,2]){
  const legs=ev.filter(e=>e.kind==='leg'&&e.leg_id===idx);
  assert.deepEqual(legs.map(e=>[e.from_status,e.to_status]),[[null,'queued'],['queued','sending'],['sending','sent']]);
  assert.match(legs[2].evidence.tx_hash,/^0x[0-9a-f]{64}$/);
  assert.equal(legs[1].evidence.idempotency_key,db.prepare('SELECT idempotency_key FROM trade_legs WHERE trade_id=? AND idx=?').get(r.trade_id,idx).idempotency_key);
 }
 const done=ev.find(e=>e.to_status==='success');
 assert.deepEqual(done.evidence.legs.map(l=>l.oneclick_status),['SUCCESS','SUCCESS','SUCCESS']);
 assert.equal(done.evidence.complete,true);
 assert.ok(ev.every((e,i)=>i===0||e.id>ev[i-1].id));
});

test('audit: trade_events refuses UPDATE and DELETE',async()=>{
 const {engine,db}=await fakeEngine();
 const r=await exec(engine,alice,await engine.propose(alice,one));
 assert.ok(tradeEvents(db,r.trade_id).length>0);
 assert.throws(()=>db.prepare("UPDATE trade_events SET to_status='success'").run(),/append-only/);
 assert.throws(()=>db.prepare('DELETE FROM trade_events').run(),/append-only/);
});

test('audit: the event and the status change are one transaction',()=>{
 const db=openTradeDb(':memory:');
 const id=bareTrade(db);
 assert.throws(()=>tx(db,()=>{transitionTrade(db,{tradeId:id,from:'signing',to:'submitted',at:1});throw Error('crash after the update')}),/crash/);
 assert.equal(tradeRow(db,id).status,'signing');assert.equal(tradeEvents(db,id).length,0);
});

test('audit: refused and unsent legs carry their reason; a requote is recorded with evidence',async()=>{
 const signer=fakeSigner({failLegs:[1],failCode:'WALLET_NOT_READY'});
 const {engine,db}=await fakeEngine({signer});
 const r=await exec(engine,alice,await engine.propose(alice,basket));
 const failed=tradeEvents(db,r.trade_id).find(e=>e.kind==='leg'&&e.to_status==='failed');
 assert.equal(failed.leg_id,1);assert.equal(failed.from_status,'sending');assert.deepEqual(failed.evidence,{reason:'WALLET_NOT_READY',stage:'signer',not_sent:true});
 // requote
 const oneclick=fakeOneClick({liveRatio:0.9});
 const q=await fakeEngine({oneclick});
 const rq=await exec(q.engine,alice,await q.engine.propose(alice,one));
 assert.equal(rq.status,'requote_required');
 const [e]=tradeEvents(q.db,rq.trade_id);
 assert.equal(e.to_status,'requote_required');assert.equal(e.from_status,null);assert.equal(e.evidence.new_revision,2);
});

// (3) balance check

test('balance: a settled YEET debit matching the legs is ok; destination and source amounts are in the receipt',async()=>{
 const {engine,db,oneclick}=await fakeEngine();
 const r=await exec(engine,alice,await engine.propose(alice,basket));
 const check=engine.accounting.check(r.trade_id);
 assert.equal(check.verdict,'pending');assert.deepEqual(JSON.parse(check.before_json),{[USDC_KEY]:'100000000'},'read before any leg was signed');
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 const c=engine.accounting.check(r.trade_id);
 assert.equal(c.verdict,'ok');
 assert.equal(JSON.parse(c.detail_json).assets[USDC_KEY].debit,'20000000');
 assert.equal(tradeEvents(db,r.trade_id).at(-1).to_status,'balance_ok');
 const receipt=JSON.parse(tradeRow(db,r.trade_id).receipt_json);
 assert.deepEqual(receipt.accounting.source,{[USDC_KEY]:{before:'100000000',after:'80000000',debit:'20000000'}});
 const legs=db.prepare('SELECT deposit_address FROM trade_legs WHERE trade_id=? ORDER BY idx').all(r.trade_id);
 assert.deepEqual(receipt.accounting.destination.map(d=>d.settledOut),legs.map(l=>oneclick.deposits.get(l.deposit_address).amountOut),'settled amounts from 1Click /status');
 assert.ok(receipt.accounting.destination.every(d=>d.quotedOut&&d.minOut&&d.status==='SUCCESS'));
 assert.equal(listAlerts(db).length,0);
});

test('balance: an unexplained debit flags needs_review and an alert, and leaves the receipt and status alone',async()=>{
 const balances=fakeBalances(),signer=fakeSigner();
 const chain=fakeChain({balances,signer});
 const {engine,db}=await fakeEngine({balances,signer,chain,hooks:{afterCommit:()=>{chain.adjust[USDC_KEY]=-1_000_000}}});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r.trade_id).status,'success','the person still sees the result');
 assert.equal(JSON.parse(tradeRow(db,r.trade_id).receipt_json).complete,true);
 const c=engine.accounting.check(r.trade_id);
 assert.equal(c.verdict,'needs_review');
 const review=tradeEvents(db,r.trade_id).find(e=>e.to_status==='needs_review');
 assert.equal(review.kind,'review');assert.equal(review.from_status,'success');
 assert.equal(review.evidence.assets[USDC_KEY].debit,'21000000');assert.equal(review.evidence.assets[USDC_KEY].high,'20000000');
 assert.deepEqual(listAlerts(db).map(a=>[a.kind,a.trade_id]),[['balance_mismatch',r.trade_id]]);
 await engine.tracker.pollOnce();
 assert.equal(listAlerts(db).length,1,'checked once');
});

test('balance: a refunded leg may come back or not; SKEET checks the sold mint',async()=>{
 const oneclick=fakeOneClick({statuses:['status-refunded.json']});
 const {engine}=await fakeEngine({oneclick});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r.trade_id).status,'refunded');
 assert.equal(engine.accounting.check(r.trade_id).verdict,'ok','the fake never refunds: a full debit is inside [0, amount]');
 const wif=CATALOG.find(c=>c.symbol==='WIF');
 const balances=fakeBalances({holdings:[{mint:wif.address,raw:8_000_000n,decimals:6,tokenAccount:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}]});
 const s=await fakeEngine({balances});
 const rs=await exec(s.engine,alice,await s.engine.skeet(alice,{request_id:'s1',legs:[{symbol:'WIF',percent:50}]}));
 await s.engine.tracker.pollOnce();await s.engine.tracker.pollOnce();
 const c=s.engine.accounting.check(rs.trade_id);
 assert.equal(c.chain,'solana');assert.equal(c.verdict,'ok');
 assert.equal(JSON.parse(c.detail_json).assets[wif.address].debit,'4000000');
});

test('balance: failed reads never block the trade; a check is retried, then unavailable',async()=>{
 const balances=fakeBalances(),signer=fakeSigner();
 const chain=fakeChain({balances,signer,failReads:1});
 const {engine}=await fakeEngine({balances,signer,chain});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 assert.equal(r.status,'submitted','the snapshot read failed and the trade went ahead');
 assert.equal(engine.accounting.check(r.trade_id).verdict,'unavailable');
 const r2=await exec(engine,alice,await engine.propose(alice,{...one,request_id:'r2'}));
 chain.failReads=99;
 for(let i=0;i<6;i++)await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r2.trade_id).status,'success');
 const c=engine.accounting.check(r2.trade_id);
 assert.equal(c.verdict,'unavailable');assert.equal(c.attempts,5);
});

test('balance: expected debit range and tolerance',()=>{
 const legs=[{idx:0,amount_in_raw:'10',send_status:'sent',oneclick_status:'SUCCESS'},{idx:1,amount_in_raw:'5',send_status:'sent',oneclick_status:'REFUNDED'},
  {idx:2,amount_in_raw:'7',send_status:'sending',oneclick_status:null},{idx:3,amount_in_raw:'9',send_status:'not_sent',oneclick_status:null}];
 const e=expectedDebit(legs,{0:'u',1:'u',2:'u',3:'u'});
 assert.deepEqual(e,{u:{low:10n,high:22n}});
 assert.equal(compareDebit({before:{u:100n},after:{u:85n},expected:e,toleranceBps:0}).ok,true);
 assert.equal(compareDebit({before:{u:100n},after:{u:91n},expected:e,toleranceBps:0}).ok,false,'under the certain debit');
 assert.equal(compareDebit({before:{u:100n},after:{u:77n},expected:e,toleranceBps:0}).ok,false,'over every leg');
 assert.equal(compareDebit({before:{u:100n},after:{u:77n},expected:e,toleranceBps:500}).ok,true,'5% of 22 rounds up to 2');
});

// (4) stuck-trade outbox

test('alerts: a trade not final after YEET_STUCK_AFTER_MINUTES raises one stuck alert; stale raises its own',async()=>{
 const oneclick=fakeOneClick({statuses:['status-processing.json']});
 const {engine,db,now}=await fakeEngine({oneclick,env:{YEET_LIVE:'1',YEET_STUCK_AFTER_MINUTES:'10',YEET_TRACK_MAX_HOURS:'1'}});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 await engine.tracker.pollOnce();
 assert.equal(listAlerts(db).length,0);
 now.advance(10*60_000);
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 const [a]=listAlerts(db);
 assert.equal(listAlerts(db).length,1,'deduplicated');
 assert.equal(a.kind,'stuck');assert.equal(a.trade_id,r.trade_id);assert.equal(a.detail.status,'settling');assert.equal(a.detail.age_minutes,10);
 assert.equal(engine.accounting.ack(a.id),true);
 assert.equal(listAlerts(db).length,0);assert.equal(listAlerts(db,{all:true}).length,1);
 await engine.tracker.pollOnce();
 assert.equal(listAlerts(db,{all:true}).length,1,'an acknowledged alert is not raised again');
 now.advance(2*3600_000);
 await engine.tracker.pollOnce();
 assert.deepEqual(listAlerts(db).map(x=>x.kind),['stale']);
 assert.equal(engine.status(alice,r.trade_id).status,'failed');
 assert.equal(engine.accounting.sweepStuck().length,0,'a stale trade is final');
 await assert.rejects(fakeEngine({env:{YEET_STUCK_AFTER_MINUTES:'soon'}}),/Invalid YEET_STUCK_AFTER_MINUTES/);
});

test('alerts: a final partial trade raises a partial alert',async()=>{
 const signer=fakeSigner({failLegs:[1]});
 const {engine,db}=await fakeEngine({signer});
 const r=await exec(engine,alice,await engine.propose(alice,basket));
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 assert.equal(engine.status(alice,r.trade_id).status,'partial');
 assert.deepEqual(listAlerts(db).map(a=>[a.kind,a.trade_id]),[['partial',r.trade_id]]);
});

test('alerts: the ops script lists, sweeps and acknowledges alerts from the state file',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yeet-alerts-'));
 try{
  const file=join(dir,'trade.sqlite');
  const db=openTradeDb(file);
  db.prepare("INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES('t_old','p',1,'a','yeet','submitted',0,0)").run();
  raiseAlert(db,{key:'stale:t_y',tradeId:'t_y',kind:'stale',detail:{hours:24},at:1});
  db.close();
  const script=new URL('../scripts/trade-alerts.mjs',import.meta.url).pathname;
  const run=(...args)=>execFileSync(process.execPath,['--no-warnings',script,...args],{env:{...process.env,TRADE_DB:file},encoding:'utf8'}).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
  assert.deepEqual(run().map(a=>a.kind),['stale']);
  const swept=run('--sweep');
  assert.deepEqual(swept.map(a=>[a.kind,a.trade_id]),[['stale','t_y'],['stuck','t_old']]);
  assert.deepEqual(run('--ack',String(swept[0].id)),[{acked:swept[0].id,changed:true}]);
  assert.deepEqual(run().map(a=>a.kind),['stuck']);
  assert.equal(run('--all').length,2);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

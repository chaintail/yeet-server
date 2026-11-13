// A leg that is `sent` with its hash pending (a sponsored Base send Privy accepted) and that Privy later reports
// `failed` or `execution_reverted` becomes `failed` with evidence, goes back to the daily cap and shows as not sent.
// The audit edge sent -> failed is only open to such legs: never to a leg with a chain hash or a deposit 1Click saw.
// Real delegated adapter over fakePrivy; no network, no wallet, no funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeEngine,fakePrivy,fakePrivyEnv,fakeBalances,fakeOneClick} from './fakes.mjs';
import {createDelegatedSigner} from './signer-privy.mjs';
import {transitionLeg,tradeEvents,TransitionRefused,legalTransition,PENDING_FAILURE} from './audit.mjs';
import {openTradeDb} from './db.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const basket={request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:3},{symbol:'TRUMP',parts:2}]};
const exec=(engine,ctx,p)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code});
const legRows=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const spent=db=>db.prepare('SELECT usdc_raw FROM daily_spend').get()?.usdc_raw;
const noDepositSeen=oneclick=>{for(const d of oneclick.deposits.values())d.script=['status-pending.json']};

async function privyEngine(privy){
 const balances=fakeBalances();
 const signer=createDelegatedSigner({env:fakePrivyEnv(),fetch:privy.fetch,balances,didFor:id=>id===alice.accountId?'did:privy:alice':undefined});
 const e=await fakeEngine({signer,balances,env:{YEET_LIVE:'1'}});
 return {...e,privy};
}

function auditDb(){
 const db=openTradeDb(':memory:');
 db.exec(`INSERT INTO proposals(id,account_id,client_id,request_id,request_sha256,direction,amount_in_raw,slippage_bps,revision,status,created_at,updated_at) VALUES('p','a','c','r','h','yeet','1',100,1,'executed',0,0)`);
 db.exec(`INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES('t','p',1,'a','yeet','submitted',0,0)`);
 const leg=(idx,txHash,privyId,oneclick)=>db.prepare(`INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,tx_hash,privy_tx_id,oneclick_status,receipt_leg_json,updated_at) VALUES('t',?,'WIF','1',?,'{}','sent',?,?,?,'{}',0)`)
  .run(idx,`d${idx}`,txHash,privyId,oneclick);
 leg(0,null,'tx-0',null);                         // hash pending
 leg(1,'0x'+'ab'.repeat(32),'tx-1',null);         // chain hash known
 leg(2,null,'tx-2','PROCESSING');                 // 1Click already sees the deposit
 leg(3,null,'tx-3','PENDING_DEPOSIT');            // hash pending, 1Click waiting
 return db;
}
const fail=(idx,id,status='execution_reverted',extra={})=>({tradeId:'t',idx,from:'sent',to:'failed',evidence:{privy_transaction_id:id,privy_status:status,source:'privy_transaction',...extra},at:5});

test('audit: sent -> failed is the only edge back from sent, and it needs the Privy failure as evidence',()=>{
 assert.equal(legalTransition('sent','failed','trade_legs'),true);
 for(const to of ['not_sent','sending','queued','sent'])assert.equal(legalTransition('sent',to,'trade_legs'),false,to);
 assert.deepEqual([...PENDING_FAILURE],['failed','execution_reverted']);
 const db=auditDb();
 assert.throws(()=>transitionLeg(db,{tradeId:'t',idx:0,from:'sent',to:'failed',evidence:{reason:'x'},at:5}),TransitionRefused,'no Privy id or status');
 assert.throws(()=>transitionLeg(db,fail(0,'tx-0','broadcasted')),TransitionRefused,'a pending status is not a failure');
 assert.throws(()=>transitionLeg(db,fail(0,'tx-0','confirmed')),TransitionRefused);
 assert.throws(()=>transitionLeg(db,fail(0,'tx-0','failed',{tx_hash:'0x'+'cd'.repeat(32)})),TransitionRefused,'evidence with a chain hash');
 assert.throws(()=>transitionLeg(db,{tradeId:'t',idx:0,from:'sent',to:'not_sent',evidence:{privy_transaction_id:'tx-0',privy_status:'failed'},at:5}),TransitionRefused);
 assert.equal(transitionLeg(db,fail(0,'tx-other')),false,'another transaction id does not match the row');
 assert.equal(transitionLeg(db,fail(1,'tx-1','failed')),false,'a leg with a confirmed chain hash never takes this edge');
 assert.equal(transitionLeg(db,fail(2,'tx-2','failed')),false,'a deposit 1Click has seen never takes it');
 const status=idx=>db.prepare('SELECT send_status FROM trade_legs WHERE idx=?').get(idx).send_status;
 assert.deepEqual([0,1,2,3].map(status),['sent','sent','sent','sent'],'refused edges change nothing');
 assert.equal(tradeEvents(db,'t').length,0,'and write no audit row');
 assert.equal(transitionLeg(db,fail(0,'tx-0','execution_reverted')),true);
 assert.equal(transitionLeg(db,fail(3,'tx-3','failed')),true);
 assert.equal(transitionLeg(db,fail(0,'tx-0','failed')),false,'once only');
 assert.deepEqual([0,1,2,3].map(status),['failed','sent','sent','failed']);
 assert.deepEqual(tradeEvents(db,'t').map(e=>[e.leg_id,e.from_status,e.to_status,e.evidence.privy_status]),[[0,'sent','failed','execution_reverted'],[3,'sent','failed','failed']]);
 assert.throws(()=>transitionLeg(db,{tradeId:'t',idx:0,from:'failed',to:'sent',evidence:{tx_hash:'0x'+'ef'.repeat(32)},at:6}),TransitionRefused,'failed stays terminal');
});

test('recovery: a hash-pending leg Privy reports failed or execution_reverted is failed with evidence, released to the daily cap and shown as not sent',async()=>{
 const {engine,db,privy,oneclick,now}=await privyEngine(fakePrivy({confirmAfter:2}));
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.deepEqual(r.legs.map(l=>[l.status,l.tx_hash]),[['sent',null],['sent',null],['sent',null]]);
 noDepositSeen(oneclick);
 assert.equal(spent(db),'20000000');
 let legs=legRows(db,r.trade_id);
 // Privy later reports leg 0 reverted and leg 1 failed; leg 2 confirms normally.
 privy.txs.get(legs[0].privy_tx_id).status='execution_reverted';
 privy.txs.get(legs[1].privy_tx_id).status='failed';
 await engine.tracker.pollOnce();
 now.advance(30_000);
 await engine.tracker.pollOnce();
 legs=legRows(db,r.trade_id);
 assert.deepEqual(legs.map(l=>l.send_status),['failed','failed','sent']);
 assert.equal(legs[2].tx_hash,privy.txs.get(legs[2].privy_tx_id).chainHash,'the healthy leg still resolves its hash');
 assert.ok(legs.slice(0,2).every(l=>l.tx_hash===null),'a failed leg never gets a hash');
 // The daily cap gets the two failed legs back (10 + 6 USDC); the 4 USDC leg that moved stays spent.
 assert.equal(spent(db),'4000000');
 const failedEvents=tradeEvents(db,r.trade_id).filter(e=>e.kind==='leg'&&e.from_status==='sent'&&e.to_status==='failed');
 assert.deepEqual(failedEvents.map(e=>[e.leg_id,e.evidence.privy_transaction_id,e.evidence.privy_status,e.evidence.hash_pending,e.evidence.released_raw]),
  [[0,legs[0].privy_tx_id,'execution_reverted',true,legs[0].amount_in_raw],[1,legs[1].privy_tx_id,'failed',true,legs[1].amount_in_raw]]);
 // Receipt: the failed legs read as not sent.
 const s=engine.status(alice,r.trade_id);
 assert.deepEqual(s.legs.map(l=>[l.status,l.refund_reason,l.origin_tx]),[['FAILED','Not sent: the transfer failed',null],['FAILED','Not sent: the transfer failed',null],['PENDING_DEPOSIT',null,legs[2].tx_hash]]);
 assert.equal(s.status,'partial');
 assert.deepEqual(oneclick.calls.submit.map(c=>c.txHash),[legs[2].tx_hash],'deposit/submit only for the leg that moved');
 // Never sent again, and further ticks change nothing.
 const events=tradeEvents(db,r.trade_id).length;
 await engine.tracker.pollOnce();now.advance(60_000);await engine.tracker.pollOnce();
 assert.equal(privy.rpc.length,3,'one RPC send per leg, ever');
 assert.equal(spent(db),'4000000');
 assert.equal(tradeEvents(db,r.trade_id).filter(e=>e.kind==='leg'&&e.to_status==='failed').length,2);
 assert.ok(tradeEvents(db,r.trade_id).length>=events);
});

test('recovery: when every hash-pending leg fails, the trade and its proposal fail and the whole amount is back',async()=>{
 const {engine,db,privy,oneclick}=await privyEngine(fakePrivy({confirmAfter:99}));
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 noDepositSeen(oneclick);
 for(const l of legRows(db,r.trade_id))privy.txs.get(l.privy_tx_id).status='failed';
 await engine.tracker.pollOnce();
 assert.deepEqual(legRows(db,r.trade_id).map(l=>l.send_status),['failed','failed','failed']);
 assert.equal(spent(db),'0');
 assert.equal(engine.status(alice,r.trade_id).status,'failed');
 assert.equal(db.prepare('SELECT status FROM proposals WHERE id=?').get(p.proposal_id).status,'failed');
 assert.equal(oneclick.calls.submit.length,0);
 assert.equal(privy.rpc.length,3);
});

test('recovery: a hash-pending leg that confirms is never failed by a later Privy answer',async()=>{
 const {engine,db,privy,oneclick,now}=await privyEngine(fakePrivy({confirmAfter:1}));
 const r=await exec(engine,alice,await engine.propose(alice,basket));
 noDepositSeen(oneclick);
 await engine.tracker.pollOnce();
 let legs=legRows(db,r.trade_id);
 assert.ok(legs.every(l=>l.send_status==='sent'&&/^0x[0-9a-f]{64}$/.test(l.tx_hash)));
 // Privy changing its answer afterwards does not touch a leg with a chain hash (recovery no longer looks it up).
 for(const l of legs)privy.txs.get(l.privy_tx_id).status='execution_reverted';
 now.advance(30_000);await engine.tracker.pollOnce();
 legs=legRows(db,r.trade_id);
 assert.ok(legs.every(l=>l.send_status==='sent'));
 assert.equal(spent(db),'20000000');
});

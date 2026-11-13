// Migration 6 upgrades a state file written by the old engine in place: legacy legs, alerts and trades keep every
// column; the new leg states and tables are usable; one open attempt per leg is enforced by the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MIGRATIONS,migrate} from '../trade/db.mjs';

test('v5 state file upgrades to v6 with its rows intact',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(let v=0;v<5;v++){db.exec(MIGRATIONS[v]);db.exec(`PRAGMA user_version=${v+1}`)}
 db.prepare("INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES('t1','p1',1,'a','yeet','submitted',1,1)").run();
 db.prepare("INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,tx_hash,updated_at,privy_tx_id,refused_at) VALUES('t1',0,'WIF','5','0xdep','{}','sent','0xhash',1,'privy-1',7)").run();
 db.prepare("INSERT INTO trade_alerts(dedup_key,trade_id,kind,detail_json,created_at) VALUES('k','t1','stale','{}',1)").run();
 migrate(db);
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,MIGRATIONS.length);
 const l=db.prepare('SELECT * FROM trade_legs').get();
 assert.equal(l.send_status,'sent');assert.equal(l.tx_hash,'0xhash');assert.equal(l.privy_tx_id,'privy-1');assert.equal(l.refused_at,7);assert.equal(l.attempt_id,null);
 assert.equal(db.prepare('SELECT origin_chain FROM trades').get().origin_chain,null);
 assert.equal(db.prepare('SELECT kind FROM trade_alerts').get().kind,'stale');
 // New states and alert kinds accepted; unknown ones refused.
 db.prepare("INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,updated_at) VALUES('t1',1,'BOME','5','dep2','{}','awaiting_signature',1)").run();
 assert.throws(()=>db.prepare("INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,updated_at) VALUES('t1',2,'X','5','d','{}','maybe',1)").run(),/CHECK/);
 db.prepare("INSERT INTO trade_alerts(dedup_key,trade_id,kind,detail_json,created_at) VALUES('f','-','fee_payer_low','{}',1)").run();
 assert.throws(()=>db.prepare("UPDATE trades SET origin_chain='eth'").run(),/CHECK/);
 // One open attempt per leg.
 const ins=db.prepare("INSERT INTO client_trade(attempt_id,trade_id,leg_idx,attempt_no,account_id,wallet,chain,kind,status,payload_json,payload_sha256,expires_at,created_at,updated_at) VALUES(?,'t1',1,?,'a','w','sol','solana_tx',?,'{}','h',1,1,1)");
 ins.run('a1',1,'pending');
 assert.throws(()=>ins.run('a2',2,'pending'),/UNIQUE/);
 ins.run('a3',3,'abandoned');
 db.close();
});

test('v7 state file upgrades to v8 (Solana basket): batch_json NULL on old attempts, rent_accounts backfilled 0/1, nothing else rewritten',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(let v=0;v<7;v++){db.exec(MIGRATIONS[v]);db.exec(`PRAGMA user_version=${v+1}`)}
 db.prepare("INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at,origin_chain) VALUES('t1','p1',1,'a','yeet','signing',1,1,'sol')").run();
 db.prepare("INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,updated_at,attempt_id) VALUES('t1',0,'WIF','5','dep','{}','awaiting_signature',1,'a1'),('t1',1,'BOME','5','dep2','{}','awaiting_signature',1,'a2')").run();
 const ins=db.prepare("INSERT INTO client_trade(attempt_id,trade_id,leg_idx,attempt_no,account_id,wallet,chain,kind,status,payload_json,payload_sha256,expires_at,created_at,updated_at) VALUES(?,'t1',?,1,'a','w','sol','solana_tx','pending','{}','h',1,1,1)");
 ins.run('a1',0);ins.run('a2',1);
 const send=db.prepare("INSERT INTO sponsor_send(attempt_id,account_id,day,lamports,rent_lamports,idempotency_key,state,updated_at) VALUES(?,'a','2026-11-13',11600,?,'k','pending',1)");
 send.run('a1',2_039_280);send.run('a2',0);
 const before=db.prepare('SELECT * FROM client_trade ORDER BY attempt_id').all();
 migrate(db);
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);
 assert.equal(MIGRATIONS.length,8);
 const after=db.prepare('SELECT * FROM client_trade ORDER BY attempt_id').all();
 assert.equal(JSON.stringify(after.map(({batch_json,...r})=>r)),JSON.stringify(before),'old attempt rows unchanged');
 assert.ok(after.every(r=>r.batch_json===null),'a legacy attempt is single-leg');
 assert.deepEqual(db.prepare('SELECT attempt_id,rent_accounts FROM sponsor_send ORDER BY attempt_id').all().map(r=>[r.attempt_id,r.rent_accounts]),[['a1',1],['a2',0]]);
 // The open-attempt index still protects the anchor leg.
 assert.throws(()=>ins.run('a3',0),/UNIQUE/);
 db.close();
});

test('a legacy single-leg attempt (batch_json NULL, rent_accounts 1) still submits, confirms, and refunds exactly one rent account',async()=>{
 const {fakePipeline,signAs,ALICE,aliceWallet}=await import('./fakes.mjs');
 const f=fakePipeline();const {p,db,rpc}=f;
 const exec=async body=>{const pr=await p.propose(ALICE,body);return p.execute(ALICE,{proposal_id:pr.proposal_id,revision:pr.revision,confirm:pr.confirm.code})};
 const legacy=id=>db.prepare('UPDATE client_trade SET batch_json=NULL WHERE attempt_id=?').run(id);
 // Refund: a legacy pending attempt superseded by a newer trade gives back exactly its one rent account.
 const one=await exec({request_id:'l1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});
 legacy(one.sign_requests[0].attempt_id);
 assert.equal(db.prepare('SELECT accounts FROM sponsor_rent_day').get().accounts,1);
 const two=await exec({request_id:'l2',amount_usdc:'5',legs:[{symbol:'BOME',parts:1}]});
 assert.equal(db.prepare('SELECT status FROM client_trade WHERE attempt_id=?').get(one.sign_requests[0].attempt_id).status,'abandoned');
 assert.equal(db.prepare('SELECT accounts FROM sponsor_rent_day').get().accounts,1,'one back, one new');
 // Submit and confirm on a legacy row.
 const r=two.sign_requests[0];legacy(r.attempt_id);
 const s=await p.submit(ALICE,{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(aliceWallet,r)});
 assert.equal(s.legs[0].send_status,'signing');
 rpc.statuses.set(s.legs[0].tx_hash,{status:'confirmed',commitment:'confirmed',slot:5});
 await p.recoverTrade(r.trade_id);
 assert.equal(db.prepare('SELECT send_status FROM trade_legs WHERE trade_id=? AND idx=0').get(r.trade_id).send_status,'sent');
 // A request for a legacy attempt reads as the leg alone.
 const page=await p.signRequests(ALICE,one.trade_id);
 assert.deepEqual(page.map(q=>q.legs),[[0]]);
});

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

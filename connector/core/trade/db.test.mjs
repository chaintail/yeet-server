import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openTradeDb,migrate,MIGRATIONS} from './db.mjs';

test('migrations create the plan 4.2 tables once and re-open without change',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yeet-trade-db-'));
 try{
  const file=join(dir,'trade.sqlite');
  let db=openTradeDb(file);
  const tables=()=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);
  assert.deepEqual(tables(),['confirm_codes','daily_spend','proposal_legs','proposals','trade_legs','trades','wallets']);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,MIGRATIONS.length);
  db.close();db=openTradeDb(file);migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,MIGRATIONS.length);
  assert.deepEqual(tables(),['confirm_codes','daily_spend','proposal_legs','proposals','trade_legs','trades','wallets']);
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('CHECK and UNIQUE constraints from plan 4.2 hold',()=>{
 const db=openTradeDb(':memory:');
 assert.throws(()=>db.prepare("INSERT INTO wallets VALUES('a','ethereum','0x',NULL,'none',NULL,0)").run(),/CHECK/);
 assert.throws(()=>db.prepare("INSERT INTO wallets VALUES('a','base','0x',NULL,'maybe',NULL,0)").run(),/CHECK/);
 const p=db.prepare("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
 p.run('p1','a','c','r','h','yeet','1',100,1,'proposed',0,0);
 assert.throws(()=>p.run('p2','a','c','r','h','yeet','1',100,1,'proposed',0,0),/UNIQUE/);
 assert.throws(()=>p.run('p3','a','c','r2','h','yeet','1',100,1,'done',0,0),/CHECK/);
 db.close();
});

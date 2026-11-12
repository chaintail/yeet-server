import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
export function stable(value) {
 if(Array.isArray(value))return value.map(stable);
 if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
 return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function createRequestLedger(path, {now=Date.now, leaseMs=30_000}={}) {
 const db=new DatabaseSync(path);db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS request_ledger(subject TEXT,client TEXT,request_id TEXT,account TEXT NOT NULL CHECK(account IN ('trial','real')),hash TEXT NOT NULL,owner TEXT NOT NULL,expires INTEGER NOT NULL,result TEXT,PRIMARY KEY(subject,client,request_id));`);
 db.exec('CREATE TABLE IF NOT EXISTS connector_identities(subject TEXT PRIMARY KEY,did TEXT NOT NULL)');
 const conflict=()=>{throw Object.assign(Error('RESEARCH_REQUEST_CONFLICT'),{code:'RESEARCH_REQUEST_CONFLICT',status:409})};
 function lookup(subject,client,payload){
  const row=db.prepare('SELECT * FROM request_ledger WHERE subject=? AND client=? AND request_id=?').get(subject,client,payload.request_id);
  if(row && (row.account!==payload.account || row.hash!==fingerprint(payload)))conflict();
  return row;
 }
 return {
  lookup,
  rememberIdentity(subject,did){ db.prepare('INSERT INTO connector_identities VALUES(?,?) ON CONFLICT(subject) DO UPDATE SET did=excluded.did').run(subject,did); },
  identity(subject){ return db.prepare('SELECT did FROM connector_identities WHERE subject=?').get(subject)?.did; },
  reserve(subject,client,payload){
   db.exec('BEGIN IMMEDIATE');
   try {
    const row=lookup(subject,client,payload),owner=randomUUID();
    if(row?.result){db.exec('COMMIT');return {result:JSON.parse(row.result)}}
    if(row && row.expires>now()){db.exec('COMMIT');return {pending:true}}
    if(row)db.prepare('UPDATE request_ledger SET owner=?,expires=? WHERE subject=? AND client=? AND request_id=?').run(owner,now()+leaseMs,subject,client,payload.request_id);
    else db.prepare('INSERT INTO request_ledger VALUES(?,?,?,?,?,?,?,NULL)').run(subject,client,payload.request_id,payload.account,fingerprint(payload),owner,now()+leaseMs);
    db.exec('COMMIT');return {owner};
   }catch(e){db.exec('ROLLBACK');throw e}
  },
  release(subject,client,payload,owner){
   db.prepare('DELETE FROM request_ledger WHERE subject=? AND client=? AND request_id=? AND owner=? AND result IS NULL').run(subject,client,payload.request_id,owner);
  },
  commit(subject,client,payload,owner,result){
   const change=db.prepare('UPDATE request_ledger SET result=?,expires=0 WHERE subject=? AND client=? AND request_id=? AND owner=? AND result IS NULL')
    .run(JSON.stringify(result),subject,client,payload.request_id,owner);
   if(change.changes!==1)throw Object.assign(Error('TEMPORARILY_UNAVAILABLE'),{code:'TEMPORARILY_UNAVAILABLE'});
  },
  close(){db.close()}
 };
}

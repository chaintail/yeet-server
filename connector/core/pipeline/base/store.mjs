// Durable state for the Base driver on the shared trade database handle. Tables are created with CREATE TABLE IF NOT
// EXISTS here (design section 3), so package B adds no migration to trade/db.mjs.
//   base_attempt       one row per user transfer attempt (kind transfer) and per signed top-up (kind gas_topup).
//                      Shapes follow Folio bridge_attempt (transfer-record.ts @70848f097): state, nonce, signed bytes,
//                      hash, evidence; a signed row's identity is immutable, a replacement is a new row (replaced_by).
//   base_gas_ledger    WalletGasLedger snapshot per user wallet (Folio saveLedger/readLedger).
//   base_topup_day     top-ups and wei per account per UTC day (guard 10, new).
//   base_driver_state  alert latches (gas_wallet_low) so an alert fires once per crossing.
import {TradeError} from '../../trade/util.mjs';
import {WalletGasLedger} from './gas-ledger.mjs';

const SCHEMA=`
CREATE TABLE IF NOT EXISTS base_attempt(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN('transfer','gas_topup')),
 trade_id TEXT NOT NULL,
 leg_idx INTEGER NOT NULL,
 seq INTEGER NOT NULL DEFAULT 0,
 account_id TEXT NOT NULL,
 wallet TEXT NOT NULL,
 sender TEXT NOT NULL,
 nonce INTEGER NOT NULL,
 tx_json TEXT NOT NULL,
 payload_sha256 TEXT,
 deposit_address TEXT,
 amount_raw TEXT,
 needed_raw TEXT,
 expires_at INTEGER,
 deadline INTEGER,
 state TEXT NOT NULL CHECK(state IN('prepared','signed','awaiting_gas','submitted','uncertain','confirmed','failed','cancelled')),
 signed_raw TEXT,
 tx_hash TEXT,
 code TEXT,
 replaces TEXT,
 replaced_by TEXT,
 sent_at INTEGER,
 broadcast_at INTEGER,
 gas_paid_raw TEXT,
 evidence_json TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS base_attempt_open_transfer ON base_attempt(trade_id,leg_idx)
 WHERE kind='transfer' AND state IN('prepared','signed','awaiting_gas','submitted','uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS base_attempt_live_topup ON base_attempt(trade_id,leg_idx)
 WHERE kind='gas_topup' AND state IN('prepared','submitted','uncertain') AND replaced_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS base_attempt_hash ON base_attempt(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS base_attempt_wallet ON base_attempt(wallet,kind,state);
CREATE TABLE IF NOT EXISTS base_gas_ledger(
 wallet TEXT PRIMARY KEY,
 snapshot TEXT NOT NULL,
 updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS base_topup_day(
 day TEXT NOT NULL,
 account_id TEXT NOT NULL,
 count INTEGER NOT NULL,
 wei_raw TEXT NOT NULL,
 PRIMARY KEY(day,account_id)) STRICT;
CREATE TABLE IF NOT EXISTS base_driver_state(
 key TEXT PRIMARY KEY,
 value TEXT,
 updated_at INTEGER NOT NULL) STRICT;`;

let savepoints=0;
/** BEGIN IMMEDIATE, or a SAVEPOINT when the caller already holds a transaction on the shared handle. */
export function atomic(db,fn){
 if(db.isTransaction){
  const name=`base_sp_${++savepoints}`;db.exec(`SAVEPOINT ${name}`);
  try{const out=fn();db.exec(`RELEASE ${name}`);return out}
  catch(e){db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);throw e}
 }
 db.exec('BEGIN IMMEDIATE');
 try{const out=fn();db.exec('COMMIT');return out}
 catch(e){db.exec('ROLLBACK');throw e}
}

export const OPEN=Object.freeze(['prepared','signed','awaiting_gas','submitted','uncertain']);
const LIVE_TOPUP="kind='gas_topup' AND state IN('prepared','submitted','uncertain')";
const COLS=['id','kind','trade_id','leg_idx','seq','account_id','wallet','sender','nonce','tx_json','payload_sha256','deposit_address',
 'amount_raw','needed_raw','expires_at','deadline','state','signed_raw','tx_hash','code','replaces','replaced_by','sent_at','broadcast_at',
 'gas_paid_raw','evidence_json','created_at','updated_at'];
const inList=list=>list.map(()=>'?').join(',');

export function createBaseStore(db,now=Date.now){
 db.exec(SCHEMA);
 const all=(sql,...a)=>db.prepare(sql).all(...a),get=(sql,...a)=>db.prepare(sql).get(...a);
 return {
  db,
  atomic:fn=>atomic(db,fn),
  attempt:id=>get('SELECT * FROM base_attempt WHERE id=?',id),
  insert(row){
   const r={seq:0,evidence_json:'{}',created_at:now(),updated_at:now(),...row};
   const cols=COLS.filter(c=>r[c]!==undefined);
   db.prepare(`INSERT INTO base_attempt(${cols.join(',')}) VALUES(${inList(cols)})`).run(...cols.map(c=>r[c]));
   return this.attempt(r.id);
  },
  /** Compare-and-set: with `from`, the row must be in one of those states or SOURCE_ATTEMPT_BLOCKED is thrown. */
  update(id,patch,from){
   const keys=Object.keys(patch).filter(k=>COLS.includes(k)&&k!=='id');
   const sets=[...keys.map(k=>`${k}=?`),'updated_at=?'],args=[...keys.map(k=>patch[k]),now(),id];
   const where=from?` AND state IN(${inList(from)})`:'';
   const r=db.prepare(`UPDATE base_attempt SET ${sets.join(',')} WHERE id=?${where}`).run(...args,...(from??[]));
   if(r.changes!==1)throw new TradeError('SOURCE_ATTEMPT_BLOCKED',`attempt ${String(id).slice(0,12)} not in ${from}`);
   return this.attempt(id);
  },
  legTransfers:(tradeId,legIdx)=>all("SELECT * FROM base_attempt WHERE kind='transfer' AND trade_id=? AND leg_idx=? ORDER BY rowid",tradeId,legIdx),
  walletTransfers:(wallet,states)=>all(`SELECT * FROM base_attempt WHERE kind='transfer' AND wallet=? AND state IN(${inList(states)}) ORDER BY nonce,rowid`,wallet,...states),
  transfersIn:states=>all(`SELECT * FROM base_attempt WHERE kind='transfer' AND state IN(${inList(states)}) ORDER BY nonce,rowid`,...states),
  legTopups:(tradeId,legIdx)=>all("SELECT * FROM base_attempt WHERE kind='gas_topup' AND trade_id=? AND leg_idx=? ORDER BY seq",tradeId,legIdx),
  walletTopups:wallet=>all("SELECT * FROM base_attempt WHERE kind='gas_topup' AND wallet=? ORDER BY rowid",wallet),
  /** Guard 12: top-ups that hold a gas-wallet nonce (one at a time on the chain). */
  liveTopups:()=>all(`SELECT * FROM base_attempt WHERE ${LIVE_TOPUP} AND replaced_by IS NULL ORDER BY rowid`),
  /** Everything still waiting for a receipt, replaced rows included (whichever mines confirms). */
  unresolvedTopups:()=>all(`SELECT * FROM base_attempt WHERE ${LIVE_TOPUP} AND signed_raw IS NOT NULL ORDER BY rowid`),
  day(day,accountId){const r=get('SELECT count,wei_raw FROM base_topup_day WHERE day=? AND account_id=?',day,accountId);return {count:r?Number(r.count):0,wei:r?BigInt(r.wei_raw):0n}},
  dayTotal:day=>all('SELECT wei_raw FROM base_topup_day WHERE day=?',day).reduce((s,r)=>s+BigInt(r.wei_raw),0n),
  bumpDay(day,accountId,count,wei){
   const d=this.day(day,accountId);
   db.prepare('INSERT INTO base_topup_day(day,account_id,count,wei_raw) VALUES(?,?,?,?) ON CONFLICT(day,account_id) DO UPDATE SET count=excluded.count,wei_raw=excluded.wei_raw')
    .run(day,accountId,d.count+count,String(d.wei+wei));
  },
  ledger(wallet){const l=new WalletGasLedger('base'),r=get('SELECT snapshot FROM base_gas_ledger WHERE wallet=?',wallet);if(r)l.restore(r.snapshot);return l},
  saveLedger(wallet,l){db.prepare('INSERT INTO base_gas_ledger(wallet,snapshot,updated_at) VALUES(?,?,?) ON CONFLICT(wallet) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at').run(wallet,l.snapshot(),now())},
  flag:key=>get('SELECT value FROM base_driver_state WHERE key=?',key)?.value??null,
  setFlag(key,value){db.prepare('INSERT INTO base_driver_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,value,now())},
 };
}

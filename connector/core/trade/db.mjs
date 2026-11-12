// Trade engine state (port plan 4.2), SQLite via node:sqlite like identity-store.mjs. Migrations run in order at
// open time and are tracked with PRAGMA user_version, so a newer image upgrades an older state file in place.
// Columns beyond plan 4.2 are marked "(+)" and exist only because the engine needs them.
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

export const MIGRATIONS=Object.freeze([
 // 1: plan 4.2 tables.
 `CREATE TABLE wallets(
   account_id TEXT NOT NULL,
   chain TEXT NOT NULL CHECK(chain IN('base','solana')),
   address TEXT NOT NULL,
   privy_wallet_id TEXT,
   signer_state TEXT NOT NULL DEFAULT 'none' CHECK(signer_state IN('none','granted','revoked')),
   policy_id TEXT,
   updated_at INTEGER NOT NULL,
   PRIMARY KEY(account_id,chain)) STRICT;
  CREATE TABLE proposals(
   id TEXT PRIMARY KEY,
   account_id TEXT NOT NULL,
   client_id TEXT NOT NULL,
   request_id TEXT NOT NULL,
   request_sha256 TEXT NOT NULL,                                   -- (+) same request_id with another payload is refused
   direction TEXT NOT NULL CHECK(direction IN('yeet','skeet')),
   amount_in_raw TEXT NOT NULL,                                    -- USDC raw (yeet) or '0' (skeet: per leg)
   slippage_bps INTEGER NOT NULL,
   revision INTEGER NOT NULL,
   status TEXT NOT NULL CHECK(status IN('proposed','executing','executed','expired','failed')),
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL,
   UNIQUE(account_id,client_id,request_id)) STRICT;
  CREATE TABLE proposal_legs(
   proposal_id TEXT NOT NULL REFERENCES proposals(id),
   revision INTEGER NOT NULL,
   idx INTEGER NOT NULL,
   symbol TEXT NOT NULL,
   asset_id TEXT NOT NULL,
   parts INTEGER,                                                  -- null for skeet
   percent INTEGER,                                                -- (+) skeet: percent of the holding
   amount_in_raw TEXT NOT NULL,
   amount_in TEXT NOT NULL,                                        -- (+) formatted, as shown
   in_usd TEXT NOT NULL,                                           -- (+)
   dry_out_raw TEXT NOT NULL,
   dry_out TEXT NOT NULL,                                          -- (+) formatted
   dry_min_out_raw TEXT NOT NULL,
   dry_min_out TEXT NOT NULL,                                      -- (+) formatted
   out_usd TEXT NOT NULL,
   time_estimate_s INTEGER NOT NULL,                               -- (+)
   quoted_at INTEGER NOT NULL,
   PRIMARY KEY(proposal_id,revision,idx)) STRICT;
  CREATE TABLE confirm_codes(
   code_sha256 TEXT PRIMARY KEY,
   proposal_id TEXT NOT NULL,
   revision INTEGER NOT NULL,
   account_id TEXT NOT NULL,
   client_id TEXT NOT NULL,
   quote_sha256 TEXT NOT NULL,
   expires_at INTEGER NOT NULL,
   used_at INTEGER,
   trade_id TEXT) STRICT;
  CREATE INDEX confirm_codes_proposal ON confirm_codes(proposal_id,revision);
  CREATE TABLE trades(
   id TEXT PRIMARY KEY,
   proposal_id TEXT NOT NULL,
   revision INTEGER NOT NULL,
   account_id TEXT NOT NULL,
   direction TEXT NOT NULL CHECK(direction IN('yeet','skeet')),
   status TEXT NOT NULL CHECK(status IN('requote_required','signing','submitted','settling','success','partial','refunded','failed')),
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL,
   receipt_json TEXT,
   result_json TEXT) STRICT;                                       -- (+) the execute_trade answer, replayed for a used code
  CREATE INDEX trades_account ON trades(account_id,created_at);
  CREATE TABLE trade_legs(
   trade_id TEXT NOT NULL REFERENCES trades(id),
   idx INTEGER NOT NULL,
   symbol TEXT NOT NULL,                                           -- (+)
   amount_in_raw TEXT NOT NULL,                                    -- (+)
   deposit_address TEXT NOT NULL,
   deposit_memo TEXT,
   live_quote_json TEXT NOT NULL,                                  -- plan leg incl. 1Click signature and correlationId
   send_status TEXT NOT NULL CHECK(send_status IN('not_sent','sent','failed')),  -- (+)
   tx_hash TEXT,
   oneclick_status TEXT,
   settled_out_raw TEXT,
   refund_reason TEXT,
   receipt_leg_json TEXT,                                          -- (+) router ReceiptLeg, folded by applyStatus
   updated_at INTEGER NOT NULL,
   PRIMARY KEY(trade_id,idx)) STRICT;
  CREATE TABLE daily_spend(
   account_id TEXT NOT NULL,
   day TEXT NOT NULL,
   usdc_raw TEXT NOT NULL,
   PRIMARY KEY(account_id,day)) STRICT;`,
]);

/** Opens (and migrates) the trade database. `file` defaults to $STATE_DIR/trade.sqlite; ':memory:' for tests. */
export function openTradeDb(file=path.join(process.env.STATE_DIR||'/state','trade.sqlite')){
 const db=new DatabaseSync(file,{defensive:true,allowExtension:false,timeout:2000});
 db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;'+(file===':memory:'?'':' PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'));
 migrate(db);
 return db;
}

export function migrate(db){
 const {user_version:at}=db.prepare('PRAGMA user_version').get();
 for(let v=at;v<MIGRATIONS.length;v++){
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(MIGRATIONS[v]);db.exec(`PRAGMA user_version=${v+1}`);db.exec('COMMIT')}
  catch(e){db.exec('ROLLBACK');throw e}
 }
 return db;
}

/** Runs fn inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK on throw). Not reentrant. */
export function tx(db,fn){
 db.exec('BEGIN IMMEDIATE');
 try{const out=fn();db.exec('COMMIT');return out}
 catch(e){db.exec('ROLLBACK');throw e}
}

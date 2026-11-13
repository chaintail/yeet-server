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
 // 2: send recovery (review H1/H2/M5) and confirm-code minting limits. A leg is `queued` from the commit until its
 // transfer is attempted, `sending` (idempotency key stored) from just before the signer call until the signer or
 // 1Click confirms it, then `sent`. Only `failed` (the signer positively reports nothing was broadcast) and `not_sent`
 // (never attempted) give the amount back to the daily cap.
 `CREATE TABLE trade_legs_v2(
   trade_id TEXT NOT NULL REFERENCES trades(id),
   idx INTEGER NOT NULL,
   symbol TEXT NOT NULL,
   amount_in_raw TEXT NOT NULL,
   deposit_address TEXT NOT NULL,
   deposit_memo TEXT,
   live_quote_json TEXT NOT NULL,
   send_status TEXT NOT NULL CHECK(send_status IN('queued','sending','sent','failed','not_sent')),
   tx_hash TEXT,
   oneclick_status TEXT,
   settled_out_raw TEXT,
   refund_reason TEXT,
   receipt_leg_json TEXT,
   updated_at INTEGER NOT NULL,
   idempotency_key TEXT,                                           -- (+) signer key, written before the signer call
   send_attempts INTEGER NOT NULL DEFAULT 0,                       -- (+)
   deposit_submitted INTEGER NOT NULL DEFAULT 0,                   -- (+) 1Click /deposit/submit accepted (or not needed)
   PRIMARY KEY(trade_id,idx)) STRICT;
  INSERT INTO trade_legs_v2(trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at,deposit_submitted)
   SELECT trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at,1 FROM trade_legs;
  DROP TABLE trade_legs;
  ALTER TABLE trade_legs_v2 RENAME TO trade_legs;
  ALTER TABLE trades ADD COLUMN last_error TEXT;                   -- (+) last refresh or recovery error, for ops
  ALTER TABLE trades ADD COLUMN stale_at INTEGER;                  -- (+) tracking stopped without a final status
  ALTER TABLE confirm_codes ADD COLUMN minted_at INTEGER;          -- (+) per-account minting rate limit
  CREATE INDEX confirm_codes_account ON confirm_codes(account_id,minted_at);`,
 // 3: accounting (audit.mjs, accounting.mjs). trade_events is append-only (triggers refuse UPDATE and DELETE): one row
 // per trades.status / trade_legs.send_status change, written in the transaction of the change, plus 'review' rows
 // for accounting flags. trade_balance_checks holds the source balance before signing and after settlement.
 // trade_alerts is the ops outbox, one row per dedup key.
 `CREATE TABLE trade_events(
   id INTEGER PRIMARY KEY,
   trade_id TEXT NOT NULL,
   leg_id INTEGER,                                                 -- trade_legs.idx; null for the trade itself
   kind TEXT NOT NULL CHECK(kind IN('trade','leg','review')),
   from_status TEXT,                                               -- null when the row is created
   to_status TEXT NOT NULL,
   evidence_json TEXT,
   at INTEGER NOT NULL) STRICT;
  CREATE INDEX trade_events_trade ON trade_events(trade_id,id);
  CREATE TRIGGER trade_events_no_update BEFORE UPDATE ON trade_events BEGIN SELECT RAISE(ABORT,'trade_events is append-only'); END;
  CREATE TRIGGER trade_events_no_delete BEFORE DELETE ON trade_events BEGIN SELECT RAISE(ABORT,'trade_events is append-only'); END;
  CREATE TABLE trade_balance_checks(
   trade_id TEXT PRIMARY KEY REFERENCES trades(id),
   chain TEXT NOT NULL CHECK(chain IN('base','solana')),
   address TEXT NOT NULL,
   legs_json TEXT NOT NULL,                                        -- {leg idx: asset key}
   before_json TEXT,                                               -- {asset key: raw}; null when the read failed
   before_at INTEGER NOT NULL,
   after_json TEXT,
   after_at INTEGER,
   verdict TEXT NOT NULL CHECK(verdict IN('pending','ok','needs_review','unavailable')),
   detail_json TEXT,
   attempts INTEGER NOT NULL DEFAULT 0) STRICT;
  CREATE INDEX trade_balance_checks_pending ON trade_balance_checks(verdict);
  CREATE TABLE trade_alerts(
   id INTEGER PRIMARY KEY,
   dedup_key TEXT NOT NULL UNIQUE,
   trade_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN('stuck','stale','partial','balance_mismatch')),
   detail_json TEXT NOT NULL,
   created_at INTEGER NOT NULL,
   acked_at INTEGER) STRICT;
  CREATE INDEX trade_alerts_open ON trade_alerts(acked_at,id);`,
 // 4: Privy send state (PRIVY-SETUP-REVIEW). A sponsored Base send answers a Privy transaction id before the chain hash:
 // the leg is `sent` with privy_tx_id and no tx_hash until the tracker resolves the hash. send_request is the exact
 // body of the first attempt, replayed byte for byte. A cached 5xx on /rpc sets cached_failure_at: that key is never
 // sent again; key_generation counts the keys a leg has used (0 = the first, also the reference_id).
 `ALTER TABLE trade_legs ADD COLUMN privy_tx_id TEXT;
  ALTER TABLE trade_legs ADD COLUMN send_request TEXT;
  ALTER TABLE trade_legs ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE trade_legs ADD COLUMN cached_failure_at INTEGER;`,
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

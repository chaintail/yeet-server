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
 // 5: Privy refusals (first-trade review 2026-11-13). privy_error is the redacted error of the last Privy answer to this
 // leg's send ({status, code, message}, JSON). refused_at is set when a re-issue of a `sending` leg got a definite
 // refusal (4xx): the leg is never sent again, only looked up by reference_id and failed once Privy has nothing.
 `ALTER TABLE trade_legs ADD COLUMN privy_error TEXT;
  ALTER TABLE trade_legs ADD COLUMN refused_at INTEGER;`,
 // 6: user-signed trades (pipeline/, GAS-SPONSORSHIP-DESIGN.md). The person's own wallet signs every leg; YEET only adds
 // the network fee (Solana fee payer co-signs) or gas (Base top-up). New leg states: `awaiting_signature` (committed,
 // a sign request is out), `signing` (the person's signature checked, our co-sign claimed, bytes persisted, sent;
 // until the chain confirms), `awaiting_gas` (Base: signed, waiting for the gas top-up). `sent` now means landed on
 // chain. trades.origin_chain names the driver ('sol' | 'base'; null on rows written before this migration).
 // Lifted from Folio sponsorship.ts: client_trade (one row per sign attempt, at most one open per leg), sponsor_send
 // (written before the fee payer is called), sponsor_day (fee quota per account, chain and UTC day); sponsor_rent_day
 // counts the deposit-address token accounts the fee payer pays rent for (new: Folio pays rent only for the person).
 `CREATE TABLE trade_legs_v6(
   trade_id TEXT NOT NULL REFERENCES trades(id),
   idx INTEGER NOT NULL,
   symbol TEXT NOT NULL,
   amount_in_raw TEXT NOT NULL,
   deposit_address TEXT NOT NULL,
   deposit_memo TEXT,
   live_quote_json TEXT NOT NULL,
   send_status TEXT NOT NULL CHECK(send_status IN('queued','sending','sent','failed','not_sent','awaiting_signature','signing','awaiting_gas')),
   tx_hash TEXT,
   oneclick_status TEXT,
   settled_out_raw TEXT,
   refund_reason TEXT,
   receipt_leg_json TEXT,
   updated_at INTEGER NOT NULL,
   idempotency_key TEXT,
   send_attempts INTEGER NOT NULL DEFAULT 0,
   deposit_submitted INTEGER NOT NULL DEFAULT 0,
   privy_tx_id TEXT,
   send_request TEXT,
   key_generation INTEGER NOT NULL DEFAULT 0,
   cached_failure_at INTEGER,
   privy_error TEXT,
   refused_at INTEGER,
   attempt_id TEXT,                                                -- (+) the open or last client_trade attempt
   sign_kind TEXT CHECK(sign_kind IN('solana_tx','evm_tx')),       -- (+)
   PRIMARY KEY(trade_id,idx)) STRICT;
  INSERT INTO trade_legs_v6(trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at,idempotency_key,send_attempts,deposit_submitted,privy_tx_id,send_request,key_generation,cached_failure_at,privy_error,refused_at)
   SELECT trade_id,idx,symbol,amount_in_raw,deposit_address,deposit_memo,live_quote_json,send_status,tx_hash,oneclick_status,settled_out_raw,refund_reason,receipt_leg_json,updated_at,idempotency_key,send_attempts,deposit_submitted,privy_tx_id,send_request,key_generation,cached_failure_at,privy_error,refused_at FROM trade_legs;
  DROP TABLE trade_legs;
  ALTER TABLE trade_legs_v6 RENAME TO trade_legs;
  ALTER TABLE trades ADD COLUMN origin_chain TEXT CHECK(origin_chain IN('sol','base'));
  CREATE TABLE trade_alerts_v6(
   id INTEGER PRIMARY KEY,
   dedup_key TEXT NOT NULL UNIQUE,
   trade_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN('stuck','stale','partial','balance_mismatch','fee_payer_low','fee_payer_recovered','gas_wallet_low','gas_wallet_recovered','sponsor_review','expiry_proof_unavailable')),
   detail_json TEXT NOT NULL,
   created_at INTEGER NOT NULL,
   acked_at INTEGER) STRICT;
  INSERT INTO trade_alerts_v6 SELECT * FROM trade_alerts;
  DROP TABLE trade_alerts;
  ALTER TABLE trade_alerts_v6 RENAME TO trade_alerts;
  CREATE INDEX trade_alerts_open ON trade_alerts(acked_at,id);
  CREATE TABLE client_trade(
   attempt_id TEXT PRIMARY KEY,                                    -- sha256("yeet-attempt:" trade ":" leg ":" n)
   trade_id TEXT NOT NULL REFERENCES trades(id),
   leg_idx INTEGER NOT NULL,
   attempt_no INTEGER NOT NULL,
   account_id TEXT NOT NULL,
   wallet TEXT NOT NULL,                                           -- the address that must sign
   chain TEXT NOT NULL CHECK(chain IN('sol','base')),
   kind TEXT NOT NULL CHECK(kind IN('solana_tx','evm_tx')),
   status TEXT NOT NULL CHECK(status IN('pending','signing','confirming','confirmed','failed','abandoned')),
   payload_json TEXT NOT NULL,                                     -- the sign request payload as issued
   payload_sha256 TEXT NOT NULL,
   unsigned_base64 TEXT,                                           -- Solana: the exact unsigned bytes issued
   last_valid_block_height TEXT,
   expires_at INTEGER NOT NULL,
   signed_base64 TEXT,                                             -- the final signed bytes, committed before any send
   signature TEXT,                                                 -- chain transaction id
   sponsor_exit INTEGER NOT NULL DEFAULT 0,                        -- SELL: exempt from the per-account fee caps
   failure_reason TEXT,
   sent_at INTEGER,
   resends INTEGER NOT NULL DEFAULT 0,
   created_at INTEGER NOT NULL,
   updated_at INTEGER NOT NULL,
   UNIQUE(trade_id,leg_idx,attempt_no)) STRICT;
  CREATE UNIQUE INDEX client_trade_open ON client_trade(trade_id,leg_idx) WHERE status IN('pending','signing','confirming');
  CREATE INDEX client_trade_status ON client_trade(status,chain);
  CREATE TABLE sponsor_send(
   attempt_id TEXT PRIMARY KEY REFERENCES client_trade(attempt_id),
   account_id TEXT NOT NULL,
   day TEXT NOT NULL,
   lamports INTEGER NOT NULL,                                      -- fee reserved (network + priority)
   rent_lamports INTEGER NOT NULL,                                 -- deposit token account rent reserved (0 when it exists)
   idempotency_key TEXT NOT NULL,                                  -- sha256 of the exact unsigned bytes
   state TEXT NOT NULL CHECK(state IN('pending','signing','submitted','not_submitted','needs_review')),
   signature TEXT,
   updated_at INTEGER NOT NULL) STRICT;
  CREATE TABLE sponsor_day(
   day TEXT NOT NULL,
   account_id TEXT NOT NULL,
   chain TEXT NOT NULL,
   transactions INTEGER NOT NULL,
   lamports INTEGER NOT NULL,
   PRIMARY KEY(day,account_id,chain)) STRICT;
  CREATE TABLE sponsor_rent_day(
   day TEXT NOT NULL,
   account_id TEXT NOT NULL,
   accounts INTEGER NOT NULL,
   lamports INTEGER NOT NULL,
   PRIMARY KEY(day,account_id)) STRICT;`,
 // 7: gas sponsorship integration. Alert kinds for the Base driver and the deferred spend release (review findings
 // 1, 2, 3, 4, 7); spend_hold keeps a not-sent BUY amount spent until its 1Click deposit deadline has passed.
 `CREATE TABLE trade_alerts_v7(
   id INTEGER PRIMARY KEY,
   dedup_key TEXT NOT NULL UNIQUE,
   trade_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN('stuck','stale','partial','balance_mismatch','fee_payer_low','fee_payer_recovered','gas_wallet_low','gas_wallet_recovered','sponsor_review','expiry_proof_unavailable',
    'deposit_outside_pipeline','base_transfer_outside_bytes','base_topup_misused','base_transfer_stuck','gas_topup_stuck','gas_topup_replace_capped','gas_topup_receipt_mismatch','gas_charge_over_reservation')),
   detail_json TEXT NOT NULL,
   created_at INTEGER NOT NULL,
   acked_at INTEGER) STRICT;
  INSERT INTO trade_alerts_v7 SELECT * FROM trade_alerts;
  DROP TABLE trade_alerts;
  ALTER TABLE trade_alerts_v7 RENAME TO trade_alerts;
  CREATE INDEX trade_alerts_open ON trade_alerts(acked_at,id);
  CREATE TABLE spend_hold(
   trade_id TEXT NOT NULL, idx INTEGER NOT NULL, account_id TEXT NOT NULL,
   spent_at INTEGER NOT NULL,                                      -- the trade's created_at: the cap day the amount was spent on
   amount_raw TEXT NOT NULL, deposit_address TEXT NOT NULL, deposit_memo TEXT,
   release_after INTEGER NOT NULL,                                 -- the leg's 1Click deposit deadline
   state TEXT NOT NULL CHECK(state IN('held','released','kept')), oneclick_status TEXT,
   created_at INTEGER NOT NULL, resolved_at INTEGER,
   PRIMARY KEY(trade_id,idx)) STRICT;
  CREATE INDEX spend_hold_due ON spend_hold(state,release_after);`,
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

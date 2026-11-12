import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomBytes } from "node:crypto";
let db;
export const validAccount = (id) =>
  typeof id === "string" && /^yeet-privy-[a-zA-Z0-9_-]{1,80}$/.test(id);
/** Account cap: YEET creates an account on the first verified sign-in, never past this many. */
export function maxAccounts(value = process.env.YEET_MAX_ACCOUNTS) {
  const n = value === undefined || value === "" ? 200 : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000)
    throw Error("Invalid YEET_MAX_ACCOUNTS");
  return n;
}
function database() {
  if (db) return db;
  db = new DatabaseSync(
    path.join(process.env.STATE_DIR || "/state", "identities.sqlite"),
    { defensive: true, allowExtension: false, timeout: 2000 },
  );
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS identity_links(provider TEXT NOT NULL,app_id TEXT NOT NULL,did TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(provider,app_id,did)) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS identity_account_unique ON identity_links(account_id);",
  );
  return db;
}
let appId;
/** appId: the only identity app whose verified logins may create or reach accounts. */
export function initializeIdentityStore({ app } = {}) {
  if (typeof app !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(app))
    throw Error("Missing identity app configuration");
  maxAccounts();
  database();
  appId = app;
}
function validIdentity(value) {
  return (
    !!value &&
    value.provider === "privy.io" &&
    value.app_id === appId &&
    typeof value.did === "string" &&
    /^did:privy:[a-zA-Z0-9_-]{1,128}$/.test(value.did)
  );
}
/** Verified identity -> stable account id. Creates the account on first sign-in while under the cap. */
export function resolveIdentity(value, { now = Date.now() } = {}) {
  if (!appId || !validIdentity(value)) return undefined;
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const prior = conn
      .prepare(
        "SELECT account_id FROM identity_links WHERE provider=? AND app_id=? AND did=?",
      )
      .get(value.provider, value.app_id, value.did);
    if (prior) {
      conn.exec("COMMIT");
      return prior.account_id;
    }
    const { n } = conn.prepare("SELECT COUNT(*) n FROM accounts").get();
    if (n >= maxAccounts()) {
      conn.exec("COMMIT");
      return undefined;
    }
    const id = `yeet-privy-${randomBytes(16).toString("base64url")}`;
    conn.prepare("INSERT INTO accounts VALUES(?,?)").run(id, now);
    conn
      .prepare("INSERT INTO identity_links VALUES(?,?,?,?)")
      .run(value.provider, value.app_id, value.did, id);
    conn.exec("COMMIT");
    return id;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
/** An existing account reached through a link for the configured app; undefined otherwise. */
export function account(id) {
  if (!appId || !validAccount(id)) return undefined;
  const row = database()
    .prepare(
      "SELECT a.id,a.created_at FROM accounts a JOIN identity_links l ON l.account_id=a.id WHERE a.id=? AND l.app_id=?",
    )
    .get(id, appId);
  return row ? { id: row.id, created_at: row.created_at } : undefined;
}
export function accountCount() {
  return database().prepare("SELECT COUNT(*) n FROM accounts").get().n;
}

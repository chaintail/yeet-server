import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkUsername, UsernameError } from "./username.mjs";
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
/** Limited beta (YEET_BETA_USER_CAP): accounts YEET creates at most while the beta is limited. Unset or empty: no
 *  beta cap (YEET_MAX_ACCOUNTS alone applies, as before). A person who already has an account is never stopped by it;
 *  a new person at the cap gets the "beta is full" page (as/beta-full.mjs) and no account. Read on every call. */
export function betaCap(value = process.env.YEET_BETA_USER_CAP) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  if (!/^[0-9]{1,7}$/.test(String(value).trim()) || !Number.isSafeInteger(n) || n > 1_000_000)
    throw Error("Invalid YEET_BETA_USER_CAP");
  return n;
}
/** True when the beta cap is set and the accounts already created reach it. */
export function betaFull() {
  const cap = betaCap();
  return cap !== null && accountCount() >= cap;
}
function database() {
  if (db) return db;
  db = new DatabaseSync(
    path.join(process.env.STATE_DIR || "/state", "identities.sqlite"),
    { defensive: true, allowExtension: false, timeout: 2000 },
  );
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS identity_links(provider TEXT NOT NULL,app_id TEXT NOT NULL,did TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(provider,app_id,did)) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS identity_account_unique ON identity_links(account_id); CREATE TABLE IF NOT EXISTS usernames(account_id TEXT PRIMARY KEY REFERENCES accounts(id),name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,updated_at INTEGER NOT NULL) STRICT;",
  );
  return db;
}
let appId;
/** appId: the only identity app whose verified logins may create or reach accounts. */
export function initializeIdentityStore({ app } = {}) {
  if (typeof app !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(app))
    throw Error("Missing identity app configuration");
  maxAccounts();
  betaCap();
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
export function resolveIdentity(value, options) {
  return resolveSignUp(value, options).id;
}
/** resolveIdentity with the reason of a refusal: {id} for the linked or newly created account, or {refused}:
 *  "BETA_FULL" (a new person while the beta cap is reached), "MAX_ACCOUNTS" (YEET_MAX_ACCOUNTS reached) or
 *  "INVALID" (no store or not a verified identity of the configured app). The count and the insert are one
 *  transaction, so two sign-ups at once never pass the cap together. */
export function resolveSignUp(value, { now = Date.now() } = {}) {
  if (!appId || !validIdentity(value)) return { refused: "INVALID" };
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
      return { id: prior.account_id };
    }
    const { n } = conn.prepare("SELECT COUNT(*) n FROM accounts").get();
    const cap = betaCap();
    if (cap !== null && n >= cap) {
      conn.exec("COMMIT");
      return { refused: "BETA_FULL" };
    }
    if (n >= maxAccounts()) {
      conn.exec("COMMIT");
      return { refused: "MAX_ACCOUNTS" };
    }
    const id = `yeet-privy-${randomBytes(16).toString("base64url")}`;
    conn.prepare("INSERT INTO accounts VALUES(?,?)").run(id, now);
    conn
      .prepare("INSERT INTO identity_links VALUES(?,?,?,?)")
      .run(value.provider, value.app_id, value.did, id);
    conn.exec("COMMIT");
    return { id };
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
/** Verified identity -> the account it is already linked to, or undefined. Never creates an account (the signing
 *  page: a Privy sign-in there may only reach an account that exists). */
export function lookupIdentity(value) {
  if (!appId || !validIdentity(value)) return undefined;
  return database()
    .prepare("SELECT account_id FROM identity_links WHERE provider=? AND app_id=? AND did=?")
    .get(value.provider, value.app_id, value.did)?.account_id;
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
/** The Privy DID linked to an account for the configured app (the trade engine's wallet lookup); undefined otherwise. */
export function didFor(id) {
  if (!appId || !validAccount(id)) return undefined;
  return database()
    .prepare("SELECT did FROM identity_links WHERE account_id=? AND app_id=?")
    .get(id, appId)?.did;
}
/** The username the person set (username.mjs), or undefined. */
export function usernameOf(id) {
  if (!appId || !validAccount(id)) return undefined;
  return database().prepare("SELECT name FROM usernames WHERE account_id=?").get(id)?.name;
}
/** Sets an existing account's username and returns it as stored. Throws UsernameError: INVALID_ARGUMENT,
 *  USERNAME_NOT_ALLOWED, or USERNAME_TAKEN when another account holds it in any letter case. */
export function setUsername(id, value, { now = Date.now() } = {}) {
  const { name, key } = checkUsername(value);
  if (!account(id)) throw new UsernameError("INVALID_ARGUMENT");
  const conn = database();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const holder = conn.prepare("SELECT account_id FROM usernames WHERE name_key=?").get(key);
    if (holder && holder.account_id !== id) throw new UsernameError("USERNAME_TAKEN");
    conn.prepare("DELETE FROM usernames WHERE account_id=?").run(id);
    conn.prepare("INSERT INTO usernames VALUES(?,?,?,?)").run(id, name, key, now);
    conn.exec("COMMIT");
    return name;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

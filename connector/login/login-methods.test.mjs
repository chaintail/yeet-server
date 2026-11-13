// Sign-in methods from the Privy app configuration, without React or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { LOGIN_METHODS, NO_METHOD_LINE, enabledMethods, introLine } from "./login-methods.js";

const ids = (config) => enabledMethods(config).map((m) => m.id);

test("login methods: Google, Apple, then email; nothing else", () => {
  assert.deepEqual([...LOGIN_METHODS], ["google", "apple", "email"]);
});

test("login methods: only the methods the app has on, in page order; Apple appears once it is on for the app", () => {
  assert.deepEqual(ids({ wallet_auth: true, email_auth: false, google_oauth: false, apple_oauth: false }), []);
  assert.deepEqual(ids({ email_auth: true }), ["email"]);
  assert.deepEqual(ids({ email_auth: true, google_oauth: true }), ["google", "email"], "Apple is off for the app: no Apple button");
  assert.deepEqual(ids({ email_auth: true, google_oauth: true, apple_oauth: true }), ["google", "apple", "email"]);
  // Telegram and X are never offered, whatever the app has on (a Telegram account has no email for the device code).
  assert.deepEqual(ids({ twitter_oauth: true, telegram_auth: true, telegram_auth_config: { bot_id: "1", bot_name: "b" } }), []);
  assert.deepEqual(ids({ email_auth: "true", google_oauth: 1 }), [], "truthy non-booleans do not count");
});

test("login methods: no configuration means no method and the calm line", () => {
  for (const c of [undefined, null, "x", 0]) assert.deepEqual(ids(c), []);
  assert.equal(introLine([]), null);
  assert.equal(NO_METHOD_LINE, "Sign-in opens shortly.");
});

test("login methods: the intro line names only what is on", () => {
  const line = (config) => introLine(enabledMethods(config));
  assert.equal(line({ email_auth: true }), "Sign in with your email. New here? Signing in creates your YEET account and wallets.");
  assert.match(line({ email_auth: true, google_oauth: true, apple_oauth: true }), /^Sign in with Google, Apple or your email\./);
  assert.match(line({ google_oauth: true }), /^Sign in with Google\./);
});

// Sign-in methods from the Privy app configuration, without React or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { LOGIN_METHODS, NO_METHOD_LINE, enabledMethods, introLine } from "./login-methods.js";

const ids = (config) => enabledMethods(config).map((m) => m.id);
const BOT = { bot_id: "123456", bot_name: "yeet_bot", link_enabled: true, seamless_auth_enabled: false };

test("login methods: the provider config lists email, Google, Apple, X and Telegram", () => {
  assert.deepEqual([...LOGIN_METHODS], ["email", "google", "apple", "twitter", "telegram"]);
});

test("login methods: only the methods the app has on, in page order", () => {
  // The live app's answer at the time of writing: wallet login only.
  assert.deepEqual(ids({ wallet_auth: true, email_auth: false, google_oauth: false, apple_oauth: false }), []);
  assert.deepEqual(ids({ email_auth: true }), ["email"]);
  assert.deepEqual(ids({ twitter_oauth: true, email_auth: true, apple_oauth: true }), ["email", "apple", "twitter"]);
  assert.deepEqual(
    ids({ email_auth: true, google_oauth: true, apple_oauth: true, twitter_oauth: true, telegram_auth: true, telegram_auth_config: BOT }),
    ["email", "google", "apple", "twitter", "telegram"],
  );
});

test("login methods: Telegram needs the linked bot; truthy non-booleans do not count", () => {
  assert.deepEqual(ids({ telegram_auth: true }), []);
  assert.deepEqual(ids({ telegram_auth: true, telegram_auth_config: { ...BOT, bot_id: "" } }), []);
  assert.deepEqual(ids({ telegram_auth: true, telegram_auth_config: BOT }), ["telegram"]);
  assert.deepEqual(ids({ email_auth: "true", google_oauth: 1 }), []);
});

test("login methods: no configuration means no method and the calm line", () => {
  for (const c of [undefined, null, "x", 0]) assert.deepEqual(ids(c), []);
  assert.equal(introLine([]), null);
  assert.equal(NO_METHOD_LINE, "Sign-in opens shortly.");
});

test("login methods: the intro line names only what is on", () => {
  const line = (config) => introLine(enabledMethods(config));
  assert.equal(line({ email_auth: true }), "Sign in with your email. New here? Signing in creates your YEET account and wallets.");
  assert.match(line({ email_auth: true, twitter_oauth: true }), /^Sign in with your email or X\./);
  assert.match(
    line({ email_auth: true, google_oauth: true, apple_oauth: true, twitter_oauth: true, telegram_auth: true, telegram_auth_config: BOT }),
    /^Sign in with your email, Google, Apple, X or Telegram\./,
  );
  assert.match(line({ google_oauth: true }), /^Sign in with Google\./);
});

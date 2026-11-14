// Sign-in methods from the Privy app configuration, without React or the network.
import test from "node:test";
import assert from "node:assert/strict";
import { LOGIN_METHODS, NO_ACCOUNT_LINE, NO_METHOD_LINE, enabledMethods, introLine, oauthRefusal, betaFullRefusal, betaFullPage } from "./login-methods.js";

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

test("the trade page: a Google or Apple return that is no YEET account says so; backing out says nothing", () => {
  assert.equal(oauthRefusal("user_does_not_exist"), "No YEET account uses that one. Use the account you connected to ChatGPT with.");
  assert.equal(oauthRefusal("user_does_not_exist"), NO_ACCOUNT_LINE);
  assert.equal(oauthRefusal("oauth_user_denied"), "");
  assert.equal(oauthRefusal("unknown_auth_error"), "That did not finish. Try again.");
  assert.equal(oauthRefusal(undefined), "That did not finish. Try again.");
  for (const code of ["user_does_not_exist", "x"]) assert.doesNotMatch(oauthRefusal(code), /\bsign\w*|log ?in/i);
});

test("offered methods: Google and Apple by default; email only when the server or a signed link names it", async () => {
  const { DEFAULT_OFFERED, methodIds, offeredMethods } = await import("./login-methods.js");
  const all = enabledMethods({ email_auth: true, google_oauth: true, apple_oauth: true });
  const shown = (offered, enabled = all) => offeredMethods(enabled, offered).map((m) => m.id);
  assert.deepEqual([...DEFAULT_OFFERED], ["google", "apple"]);
  assert.deepEqual(shown(undefined), ["google", "apple"], "no list from the server: never email");
  assert.deepEqual(shown(["google", "apple"]), ["google", "apple"]);
  assert.deepEqual(shown(["google", "apple", "email"]), ["google", "apple", "email"], "the setting restores email");
  assert.deepEqual(shown("email"), ["email"], "a link for an email account shows only email");
  assert.deepEqual(shown("email,google"), ["google", "email"], "page order, whatever the list's order");
  // Apple is offered but off for the Privy app: no Apple button.
  assert.deepEqual(shown(["google", "apple"], enabledMethods({ email_auth: true, google_oauth: true })), ["google"]);
  // An unusable list falls back to the default, never to every method.
  for (const bad of [[], "", "telegram", ["x"], 7, null]) assert.deepEqual(shown(bad), ["google", "apple"]);
  assert.equal(methodIds("nope"), null);
  assert.deepEqual(methodIds(" google , email "), ["google", "email"]);
  assert.match(introLine(offeredMethods(all, undefined)), /^Sign in with Google or Apple\./);
});

test("limited beta: with sign-up off the intro line promises no account; Privy's refusals that mean no spot go to the page", () => {
  const methods = enabledMethods({ google_oauth: true, email_auth: true });
  assert.equal(introLine(methods, { signup: false }), "Sign in with Google or your email.");
  assert.match(introLine(methods), /New here\? Signing in creates your YEET account and wallets\.$/);
  // Privy's own user limit, on any page that may sign people up; "no such user" only when sign-up was off.
  for (const e of ["max_accounts_reached", { privyErrorCode: "max_accounts_reached" }, { code: "max_accounts_reached" }]) assert.equal(betaFullRefusal(e), true);
  assert.equal(betaFullRefusal({ privyErrorCode: "user_does_not_exist" }, { signup: false }), true);
  assert.equal(betaFullRefusal({ privyErrorCode: "user_does_not_exist" }), false, "sign-up on: not the beta");
  for (const e of [undefined, null, "", "oauth_user_denied", { privyErrorCode: "invalid_credentials" }, { code: "too_many_requests" }]) assert.equal(betaFullRefusal(e, { signup: false }), false, JSON.stringify(e));
  assert.equal(betaFullPage("/account/waitlist?from=chatgpt&back=%2Finteraction%2Fabc"), "/account/waitlist?from=chatgpt&back=%2Finteraction%2Fabc");
  for (const bad of [undefined, "", "https://evil.example/account/waitlist?x", "/account/waitlist", "/account/waitlist?x=<y>", "//evil.example"]) assert.equal(betaFullPage(bad), "/account/waitlist?from=web", String(bad));
});

// YEET_LOGIN_METHODS (as/login-methods.mjs) and where the pages get it: the trade page's data-methods.
import test from "node:test";
import assert from "node:assert/strict";
import { loginMethods, knownMethods, DEFAULT_LOGIN_METHODS } from "../login-methods.mjs";
import { signPageHtml } from "../sign-page.mjs";

test("YEET_LOGIN_METHODS: Google and Apple by default; email comes back with the setting", () => {
  assert.deepEqual([...DEFAULT_LOGIN_METHODS], ["google", "apple"]);
  assert.deepEqual(loginMethods(undefined), ["google", "apple"]);
  assert.deepEqual(loginMethods(""), ["google", "apple"]);
  assert.deepEqual(loginMethods("google,apple,email"), ["google", "apple", "email"]);
  assert.deepEqual(loginMethods(" Email , google "), ["google", "email"], "page order, trimmed, case folded");
  assert.deepEqual(loginMethods("google"), ["google"]);
});

test("YEET_LOGIN_METHODS: an unknown name or an empty list is refused", () => {
  for (const bad of ["google,telegram", "wallet", ",", " , "]) assert.throws(() => loginMethods(bad), /Invalid YEET_LOGIN_METHODS/);
});

test("knownMethods cuts any list to the known ids in page order", () => {
  assert.deepEqual(knownMethods(["email", "x", "google"]), ["google", "email"]);
  assert.deepEqual(knownMethods(null), []);
});

test("the trade page names the offered methods: Google and Apple unless told otherwise", () => {
  const page = (extra) => signPageHtml({ appId: "abcdefghij1234", tradeId: "t_" + "a".repeat(20), asset: null, back: null, nonce: "n", ...extra });
  assert.match(page({}), / data-methods="google,apple"/);
  assert.match(page({ methods: ["google", "apple", "email"] }), / data-methods="google,apple,email"/);
  assert.match(page({ methods: ["email", "<script>"] }), / data-methods="email"/);
});

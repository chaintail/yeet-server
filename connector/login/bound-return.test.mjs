// The bound sign-in page: where Google and Apple return to, what "started here" means, and its screens
// (login/bound-return.js). What the return is bound to is the server's business: as/scripts/account-bound-test.mjs
// and test/acceptance.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BOUND_CALLBACK_PATH, boundView, fromProvider, startedHere } from "./bound-return.js";

const src = readFileSync(new URL("./src.jsx", import.meta.url), "utf8");
const bound = src.slice(src.indexOf("function BoundSignIn"), src.indexOf("\ntry {"));

test("Google and Apple come back to one fixed address with no query, used by nothing but a bound sign-in; the hint is never in it", () => {
  assert.equal(BOUND_CALLBACK_PATH, "/account/login/bound");
  assert.doesNotMatch(BOUND_CALLBACK_PATH, /[?&=]|v1\./);
  assert.match(src, /customOAuthRedirectUrl: `\$\{location\.origin\}\$\{BOUND_CALLBACK_PATH\}`/);
  // Only the bound page is given that address; the ordinary sign-in keeps Privy's default (its own address).
  assert.ok(src.includes('config={bound ? { ...privyConfig(), customOAuthRedirectUrl: `${location.origin}${BOUND_CALLBACK_PATH}` } : privyConfig()}'));
});

test("the provider's return is recognised by Privy's own parameters", () => {
  assert.equal(fromProvider("?privy_oauth_code=x&privy_oauth_state=y"), true);
  assert.equal(fromProvider("?privy_oauth_state=y"), true);
  assert.equal(fromProvider("?next=fund&again=1"), false);
  assert.equal(fromProvider(""), false); assert.equal(fromProvider(undefined), false);
});

test("N1: nothing in the browser's storage carries a bound sign-in, so losing storage cannot turn it into an ordinary one", () => {
  // The page neither keeps nor reads a return context: the server's cookie decides what a return is bound to.
  assert.doesNotMatch(src, /keepBound|keptBound|ReturnToBound|yeet-bound-return|yeet-bound-refusal/);
  assert.doesNotMatch(bound, /sessionStorage|localStorage|markStarted|takeStarted/, "the bound page touches no storage and no started flag");
  // "Started here" is a press on this page, or the provider sending the person back to this page. Never a stored flag.
  assert.equal(startedHere({ pressed: true, search: "" }), true);
  assert.equal(startedHere({ pressed: false, search: "?privy_oauth_code=x&privy_oauth_state=y" }), true);
  assert.equal(startedHere({ pressed: false, search: "?next=fund&h=v1.a.b" }), false, "a later bound visit never submits by itself");
  assert.equal(startedHere({ pressed: undefined, search: "" }), false);
  assert.match(bound, /startedHere: startedHere\(\{ pressed, search: location\.search \}\)/);
});

test("N1: the ordinary sign-in's started flag is cleared on a bound page, on any visit that is not a provider return, and when a provider return fails", () => {
  assert.match(src, /if \(bound \|\| !fromProvider\(location\.search\)\) clearStarted\(\);/);
  assert.match(src, /if \(oauthFailed\) clearStarted\(\);/);
  // Success: read once and removed (takeStarted).
  const take = src.slice(src.indexOf("function takeStarted"), src.indexOf("/** What to call the signed-in person"));
  assert.match(take, /sessionStorage\.removeItem\(STARTED_KEY\)/);
  // The ordinary sign-in (which can create an account) is only ever rendered on a page the server did not mark bound.
  assert.match(src, /\) : bound \? \(\s*<BoundSignIn offered=\{host\.dataset\.methods\} \/>\s*\) : \(\s*<SignIn config=\{config\} \/>/);
});

test("screens: a session that was already there is never sent by itself and never ended by itself", () => {
  assert.equal(boundView({ ready: false, authenticated: true, startedHere: true }), "loading");
  assert.equal(boundView({ ready: true, authenticated: false, startedHere: false }), "methods");
  assert.equal(boundView({ ready: true, authenticated: true, startedHere: true }), "submit", "signed in on this page just now");
  assert.equal(boundView({ ready: true, authenticated: true, startedHere: false }), "confirm", "someone was already here: the person chooses");
  for (const ready of [true, false]) for (const authenticated of [true, false]) for (const started of [true, false])
    assert.ok(["loading", "methods", "submit", "confirm"].includes(boundView({ ready, authenticated, startedHere: started })));
});

test("the bound page logs out only from a button press; no query flag is read", () => {
  assert.doesNotMatch(src, /dataset\.again|[?&]again=|searchParams\.(get|has)\("again"\)/, "no query flag is read");
  assert.equal(bound.match(/logout\(\)/g).length, 1, "one logout call in the bound page");
  assert.match(bound, /onClick=\{useAnother\}/, "and it is behind a button");
  assert.doesNotMatch(bound.replace(/async function useAnother\(\)[\s\S]*?\n  \}\n/, ""), /logout\(\)/, "nowhere else, and never in an effect");
});

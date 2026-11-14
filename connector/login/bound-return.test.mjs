// The bound sign-in page's trip to Google or Apple and back, and its screens (login/bound-return.js).
import test from "node:test";
import assert from "node:assert/strict";
import { BOUND_CALLBACK_PATH, BOUND_FOR_MS, BOUND_KEY, boundContext, boundUrl, boundView, fromProvider, keepBound, keptBound } from "./bound-return.js";

const HINT = `v1.${"a".repeat(60)}.${"B".repeat(43)}`;
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test("Google and Apple come back to one fixed address with no query; the hint is never in it", () => {
  assert.equal(BOUND_CALLBACK_PATH, "/account/login");
  assert.doesNotMatch(BOUND_CALLBACK_PATH, /[?&=]|v1\./);
});

test("the context is read from the bound page's address and only in its exact shape", () => {
  assert.deepEqual(boundContext(`?next=fund&h=${HINT}`), { next: "fund", hint: HINT });
  assert.deepEqual(boundContext(`?next=terms&h=${HINT}`), { next: "terms", hint: HINT });
  for (const bad of ["", "?next=fund", `?h=${HINT}`, `?next=account&h=${HINT}`, "?next=fund&h=junk", `?next=https://evil.example&h=${HINT}`, undefined])
    assert.equal(boundContext(bad), null, String(bad));
});

test("kept before leaving, found on the way back, and the way back is the bound address on this origin", () => {
  const s = store(), t0 = 1_000_000;
  assert.equal(keepBound(s, { next: "fund", hint: HINT }, t0), true);
  assert.deepEqual(keptBound(s, { now: t0 + 60_000 }), { next: "fund", hint: HINT });
  assert.ok(s.m.has(BOUND_KEY), "looking does not remove it");
  assert.deepEqual(keptBound(s, { now: t0 + 60_000, take: true }), { next: "fund", hint: HINT });
  assert.equal(keptBound(s, { now: t0 + 60_000 }), null, "taken once");
  assert.equal(boundUrl({ next: "fund", hint: HINT }), `/account/login?next=fund&h=${HINT}`);
  assert.ok(boundUrl({ next: "terms", hint: HINT }).startsWith("/account/login?next=terms&h="));
});

test("what the tab kept is not trusted for anything but the way back: stale, altered or foreign values are dropped", () => {
  const t0 = 1_000_000;
  const s = store();
  keepBound(s, { next: "fund", hint: HINT }, t0);
  assert.equal(keptBound(s, { now: t0 + BOUND_FOR_MS }), null, "too old");
  assert.equal(keptBound(s, { now: t0 - 1 }), null, "from the future");
  for (const v of ['{"next":"fund","hint":"junk","at":1000000}', `{"next":"//evil.example","hint":"${HINT}","at":1000000}`, `{"next":"fund","hint":"${HINT}"}`, "not json", "null", `{"next":"fund","hint":"${HINT}&next=evil","at":1000000}`]) {
    const x = store(); x.setItem(BOUND_KEY, v);
    assert.equal(keptBound(x, { now: t0 + 1 }), null, v);
  }
  assert.equal(keepBound(store(), { next: "fund", hint: "junk" }), false);
  assert.equal(keepBound({ setItem() { throw Error("storage is off"); } }, { next: "fund", hint: HINT }), false);
  assert.equal(keptBound({ getItem() { throw Error("storage is off"); } }), null);
});

test("the provider's return is recognised by Privy's own parameters", () => {
  assert.equal(fromProvider("?privy_oauth_code=x&privy_oauth_state=y"), true);
  assert.equal(fromProvider("?privy_oauth_state=y"), true);
  assert.equal(fromProvider("?next=fund&again=1"), false);
  assert.equal(fromProvider(""), false);
});

test("screens: a session that was already there is never sent by itself and never ended by itself", () => {
  assert.equal(boundView({ ready: false, authenticated: true, startedHere: true }), "loading");
  assert.equal(boundView({ ready: true, authenticated: false, startedHere: false }), "methods");
  assert.equal(boundView({ ready: true, authenticated: true, startedHere: true }), "submit", "signed in on this page just now");
  assert.equal(boundView({ ready: true, authenticated: true, startedHere: false }), "confirm", "someone was already here: the person chooses");
  // No input makes the page log anyone out: there is no such screen, and no query flag is read.
  for (const ready of [true, false]) for (const authenticated of [true, false]) for (const startedHere of [true, false])
    assert.ok(["loading", "methods", "submit", "confirm"].includes(boundView({ ready, authenticated, startedHere })));
});

test("the sign-in page source: the bound page logs out only from a button press and returns to the fixed address", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./src.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /dataset\.again|[?&]again=|searchParams\.(get|has)\("again"\)/, "no query flag is read");
  const bound = src.slice(src.indexOf("function BoundSignIn"), src.indexOf("function ReturnToBound"));
  assert.equal(bound.match(/logout\(\)/g).length, 1, "one logout call in the bound page");
  assert.match(bound, /onClick=\{useAnother\}/, "and it is behind a button");
  assert.doesNotMatch(bound.replace(/async function useAnother\(\)[\s\S]*?\n  \}\n/, ""), /logout\(\)/, "nowhere else, and never in an effect");
  assert.match(src, /customOAuthRedirectUrl: `\$\{location\.origin\}\$\{BOUND_CALLBACK_PATH\}`/);
});

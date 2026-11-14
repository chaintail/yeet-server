// The terms page through the account's signed link (as/terms-page.mjs, shared/link-token.mjs): no sign-in, one Accept,
// the acceptance recorded for the token's account only, and every bad token falling back to the sign-in.
// In-process express on a loopback port; the core is a stand-in that runs the real terms rules.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { termsRoutes, TERMS_DONE } from "../terms-page.mjs";
import { deriveLinkKey, mintLinkToken, verifyLinkToken } from "#shared/link-token.mjs";
import { TERMS_VERSION, REQUIRED_IDS, STATEMENTS, termsObject, checkAcceptance, termsLinkFor } from "../../core/terms.mjs";

const key = deriveLinkKey("k".repeat(40));
const A = "yeet-privy-AAAAAAAAAAAAAAAAAAAAAA", B = "yeet-privy-BBBBBBBBBBBBBBBBBBBBBB";
const PAGE = "https://chatgpt.yeet.win/account/terms";
const accepted = new Map(), calls = [];
let version = TERMS_VERSION;
// The core's two terms routes as the sign-in server sees them (core.mjs), with the first acceptance standing.
async function core(route, account, body) {
  calls.push({ route, account, body });
  const terms = () => ({ ...termsObject(accepted.get(account) ?? null, { mode: "chat", pageUrl: PAGE }), version });
  if (route === "/terms") return { status: 200, body: { terms: terms() } };
  if (route === "/terms/accept") {
    const check = body.version === version ? checkAcceptance({ version: TERMS_VERSION, confirmed: body.confirmed }) : { ok: false, reason: "version" };
    if (!check.ok) return { status: 403, body: { error: "TERMS_REQUIRED", reason: check.reason, terms: terms() } };
    if (!accepted.has(account)) accepted.set(account, { accepted_at: Date.now(), statements: check.confirmed, source: body.source, via: body.via });
    return { status: 200, body: { terms: terms() } };
  }
  return { status: 404, body: null };
}
const app = express();
let ORIGIN = "";
termsRoutes(app, {
  session: (q) => (q.headers.cookie === "yeet_session=b" ? { id: B, csrf: "c" } : null),
  originOK: (q) => q.headers.origin === ORIGIN,
  formBody: express.urlencoded({ extended: false }),
  core,
  document: (_r, title, body) => `<title>${title}</title>${body}`,
  linkToken: (t) => verifyLinkToken(key, t, { purpose: "terms" }),
});
let server;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  ORIGIN = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
const mint = (extra = {}) => mintLinkToken(key, { purpose: "terms", account: A, ttl: 600, claims: { v: TERMS_VERSION }, ...extra });
const get = (t, cookie) => fetch(`${ORIGIN}/account/terms${t === undefined ? "" : `?t=${encodeURIComponent(t)}`}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const post = (fields, { origin = ORIGIN, cookie } = {}) =>
  fetch(`${ORIGIN}/account/terms`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const toSignIn = (r) => { assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/account/login?next=terms"); };

test("the core's link carries a terms token for that account and version, good for 10 minutes", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const url = termsLinkFor(A, { pageUrl: PAGE, key, now });
  assert.ok(url.startsWith(`${PAGE}?t=v1.`));
  assert.match(url, /^https:\/\/[^\s]{1,500}$/, "the contract's https_url");
  const claims = verifyLinkToken(key, new URL(url).searchParams.get("t"), { purpose: "terms", now });
  assert.deepEqual(claims, { v: TERMS_VERSION, p: "terms", a: A, e: now / 1000 + 600 });
  assert.equal(verifyLinkToken(key, new URL(url).searchParams.get("t"), { purpose: "terms", now: now + 600_000 }), null);
  assert.equal(termsLinkFor(A, { pageUrl: PAGE, key: null }), PAGE, "no key: the plain page, which asks for a sign-in");
  assert.equal(termsLinkFor(A, { pageUrl: null, key }), null);
  assert.equal(termsLinkFor("nobody", { pageUrl: PAGE, key }), PAGE);
});

test("YEET text.", async () => {
  const t = mint(), r = await get(t);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null, "the link opens no session");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer", "the token never rides on a click to a linked document");
  const page = await r.text();
  for (const s of STATEMENTS) { assert.ok(page.includes(s.text.replace(/'/g, "&#39;")), s.id); assert.ok(page.includes(`href="${s.url}"`), `${s.id} link`); }
  assert.equal(page.match(/<button/g).length, 1);
  assert.match(page, /<button type="submit">Accept<\/button>/);
  assert.equal(page.match(/type="checkbox"/g).length, 1, "only the optional line is a box");
  assert.match(page, /name="agree_product_email" value="yes">/);
  assert.doesNotMatch(page, /checked|required/);
  assert.ok(page.includes(`name="t" value="${t}"`));
  assert.doesNotMatch(page, /sign in|password|privy-login/i);
  assert.equal(accepted.size, 0, "looking records nothing");
});

test("Accept records the acceptance for the token's account, source page, and ends on go back to ChatGPT", async () => {
  const t = mint();
  // The Origin must be this server's: another site cannot post the form even with the token.
  assert.equal((await post({ t, version: TERMS_VERSION }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ t, version: TERMS_VERSION }, { origin: null })).status, 403);
  assert.equal(accepted.size, 0);
  const r = await post({ t, version: TERMS_VERSION });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const page = await r.text();
  assert.ok(page.includes(TERMS_DONE));
  assert.match(page, /Done\. You accepted the YEET terms\./); assert.match(page, /Go back to ChatGPT/);
  assert.doesNotMatch(page, /<a |<button|<form/, "the done state leads nowhere else");
  assert.deepEqual([...accepted.keys()], [A], "only the token's account");
  const row = accepted.get(A);
  assert.deepEqual(row.statements, [...REQUIRED_IDS], "every required line; the optional one was not ticked");
  assert.equal(row.source, "page"); assert.equal(row.via, "link");
  const sent = calls.findLast((c) => c.route === "/terms/accept");
  assert.equal(sent.account, A);
});

test("reuse is harmless: the same link again shows the done state and the first acceptance stands", async () => {
  const first = accepted.get(A), t = mint();
  const again = await get(t);
  assert.equal(again.status, 200);
  assert.ok((await again.text()).includes(TERMS_DONE));
  const r = await post({ t, version: TERMS_VERSION, agree_product_email: "yes" });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(TERMS_DONE));
  assert.equal(accepted.get(A), first, "the first acceptance stands");
});

test("the optional line counts only when the person ticks it; ids the page never showed are ignored", async () => {
  accepted.clear();
  const r = await post({ t: mint(), version: TERMS_VERSION, agree_product_email: "yes", agree_admin: "yes" });
  assert.equal(r.status, 200);
  assert.deepEqual(accepted.get(A).statements, [...REQUIRED_IDS, "product_email"]);
  accepted.clear();
});

test("missing, expired, tampered, wrong-purpose and wrong-version tokens fall back to the normal sign-in", async () => {
  const good = mint(), [v, body, sig] = good.split(".");
  const forB = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), a: B })).toString("base64url");
  const bad = {
    missing: undefined,
    empty: "",
    expired: mint({ now: Date.now() - 601_000 }),
    tampered_mac: `${v}.${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`,
    wrong_account: `${v}.${forB}.${sig}`,
    wrong_purpose: mintLinkToken(key, { purpose: "hint", account: A, ttl: 600, claims: { m: ["google"], v: TERMS_VERSION } }),
    other_key: mintLinkToken(deriveLinkKey("z".repeat(40)), { purpose: "terms", account: A, ttl: 600, claims: { v: TERMS_VERSION } }),
    old_version: mint({ claims: { v: "2020-01-01" } }),
    no_version: mint({ claims: {} }),
    junk: "v1.abc.def",
  };
  for (const [name, t] of Object.entries(bad)) {
    toSignIn(await get(t));
    if (t) { const r = await post({ t, version: TERMS_VERSION }); assert.equal(r.status, 303, name); assert.equal(r.headers.get("location"), "/account/terms", name); }
  }
  assert.equal(accepted.size, 0, "nothing was recorded for anyone");
  // The same bad token in a browser that IS signed in: the signed-in account's own page (checkboxes), not the link's.
  const r = await get(bad.expired, "yeet_session=b");
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /name="csrf" value="c"/); assert.match(page, /data-yeet-agreements/);
});

test("the link names the account: a signed-in browser of another account accepts for the link's account, never its own", async () => {
  const r = await post({ t: mint(), version: TERMS_VERSION }, { cookie: "yeet_session=b" });
  assert.equal(r.status, 200);
  assert.deepEqual([...accepted.keys()], [A]);
  accepted.clear();
});

test("the terms changed while the page was open: nothing is recorded and the person is sent back to ChatGPT", async () => {
  const t = mint();
  version = "2027-01-01";
  try {
    // The token names the old version: it is no token any more.
    toSignIn(await get(t));
    const stale = mintLinkToken(key, { purpose: "terms", account: A, ttl: 600, claims: { v: "2027-01-01" } });
    const r = await post({ t: stale, version: TERMS_VERSION });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /These terms changed\. Go back to ChatGPT/);
    assert.equal(accepted.size, 0);
  } finally { version = TERMS_VERSION; }
});

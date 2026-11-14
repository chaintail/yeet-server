// The terms page through the account's signed link (as/terms-page.mjs, shared/link-token.mjs): no sign-in, one Accept,
// the acceptance recorded for the token's account only (the required statements, source terms-link, the token used
// once), and a bad token never falling back to whatever session the browser holds.
// In-process express on a loopback port; the core is a stand-in that runs the real terms rules and the real store.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "yeet-terms-link-"));
const { termsRoutes, TERMS_DONE, TERMS_ALREADY } = await import("../terms-page.mjs");
const { hintReader, EXPIRED_LINK_LINE } = await import("../account-bound.mjs");
const { deriveLinkKey, mintLinkToken, verifyLinkToken } = await import("#shared/link-token.mjs");
const { TERMS_VERSION, REQUIRED_IDS, STATEMENTS, termsObject, checkAcceptance, termsLinkFor } = await import("../../core/terms.mjs");
const { acceptanceOf, recordAcceptance, useTermsLink, acceptViaLink } = await import("../../core/terms-store.mjs");

const key = deriveLinkKey("k".repeat(40));
const A = "yeet-privy-AAAAAAAAAAAAAAAAAAAAAA", B = "yeet-privy-BBBBBBBBBBBBBBBBBBBBBB";
const PAGE = "https://chatgpt.yeet.win/account/terms";
const calls = [];
let version = TERMS_VERSION;
// The core's two terms routes as the sign-in server reaches them, with core.mjs's own rules for the link path:
// required statements only, source terms-link, the token id used once (core/terms-store.mjs, the real tables).
async function core(route, account, body) {
  calls.push({ route, account, body });
  const terms = () => ({ ...termsObject(acceptanceOf(account, TERMS_VERSION), { mode: "chat", pageUrl: PAGE }), version });
  if (route === "/terms") return { status: 200, body: { terms: terms() } };
  if (route === "/terms/accept") {
    const viaLink = body.via === "link";
    if (viaLink && !/^[A-Za-z0-9_-]{16,32}$/.test(body.token_id ?? "")) return { status: 400, body: { error: "INVALID_ARGUMENT" } };
    const confirmed = viaLink ? body.confirmed.filter((id) => REQUIRED_IDS.includes(id)) : body.confirmed;
    const check = body.version === version ? checkAcceptance({ version: TERMS_VERSION, confirmed }) : { ok: false, reason: "version" };
    if (!check.ok) return { status: 403, body: { error: "TERMS_REQUIRED", reason: check.reason, terms: terms() } };
    if (viaLink) { if (acceptViaLink({ tokenId: body.token_id, accountId: account, version: TERMS_VERSION, statements: check.confirmed }).used) return { status: 409, body: { error: "LINK_USED", terms: terms() } }; }
    else recordAcceptance({ accountId: account, version: TERMS_VERSION, statements: check.confirmed, source: "page", clientId: "terms-page" });
    return { status: 200, body: { terms: terms() } };
  }
  return { status: 404, body: null };
}
const app = express();
let ORIGIN = "";
termsRoutes(app, {
  session: (q) => (q.headers.cookie === "yeet_session=b" ? { id: B, csrf: "c" } : q.headers.cookie === "yeet_session=a" ? { id: A, csrf: "ca" } : null),
  originOK: (q) => q.headers.origin === ORIGIN,
  formBody: express.urlencoded({ extended: false }),
  core,
  document: (_r, title, body) => `<title>${title}</title>${body}`,
  linkToken: (t) => verifyLinkToken(key, t, { purpose: "terms" }),
  hint: hintReader((t) => verifyLinkToken(key, t, { purpose: "hint" })),
});
let server;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  ORIGIN = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
let n = 0;
const tokenId = () => `id${String(++n).padStart(4, "0")}aaaaaaaaaaaa`;
const mint = (extra = {}) => mintLinkToken(key, { purpose: "terms", account: A, ttl: 600, claims: { v: TERMS_VERSION, j: tokenId() }, ...extra });
const hintFor = (account, extra = {}) => mintLinkToken(key, { purpose: "hint", account, ttl: 600, claims: { m: ["google"] }, ...extra });
const url = (params) => `${ORIGIN}/account/terms${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`;
const get = (params = {}, cookie) => fetch(url(params), { redirect: "manual", headers: cookie ? { cookie } : {} });
// Every required box ticked, as the person sends the form once each line is agreed to.
const TICKED = Object.fromEntries(REQUIRED_IDS.map((id) => [`agree_${id}`, "yes"]));
const post = (fields, { origin = ORIGIN, cookie } = {}) =>
  fetch(`${ORIGIN}/account/terms`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields) });
const isExpired = async (r, why) => { assert.equal(r.status, 410, why); const page = await r.text(); assert.ok(page.includes(EXPIRED_LINK_LINE), why); assert.doesNotMatch(page, /<form|<button|csrf|agree_/, why); };

test("the core's link carries a terms token for that account and version, with its own id, good for 10 minutes", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const link = termsLinkFor(A, { pageUrl: PAGE, key, now, id: "tokenid000000001" });
  assert.ok(link.startsWith(`${PAGE}?t=v1.`));
  assert.match(link, /^https:\/\/[^\s]{1,500}$/, "the contract's https_url");
  const claims = verifyLinkToken(key, new URL(link).searchParams.get("t"), { purpose: "terms", now });
  assert.deepEqual(claims, { v: TERMS_VERSION, j: "tokenid000000001", p: "terms", a: A, e: now / 1000 + 600 });
  assert.equal(verifyLinkToken(key, new URL(link).searchParams.get("t"), { purpose: "terms", now: now + 600_000 }), null);
  const other = termsLinkFor(A, { pageUrl: PAGE, key, now });
  assert.notEqual(new URL(other).searchParams.get("t"), new URL(termsLinkFor(A, { pageUrl: PAGE, key, now })).searchParams.get("t"), "every link has its own id");
  // A link that cannot be signed is not handed out at all: never the bare page address.
  assert.equal(termsLinkFor(A, { pageUrl: PAGE, key: null }), null);
  assert.equal(termsLinkFor("nobody", { pageUrl: PAGE, key }), null);
  assert.equal(termsLinkFor(A, { pageUrl: null, key }), null);
});

test("a valid link: each required statement with its own unticked checkbox and its link, one Accept gated by them, with no sign-in and no session", async () => {
  const t = mint(), r = await get({ t });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null, "the link opens no session");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer", "the token never rides on a click to a linked document");
  const page = await r.text();
  for (const s of STATEMENTS.filter((x) => x.required)) {
    assert.ok(page.includes(s.text.replace(/'/g, "&#39;")), s.id); assert.ok(page.includes(`href="${s.url}"`), `${s.id} link`);
    // Owner, 2026-11-14: a checkbox for every item, never one accept-all. A real labelled box, unticked, required.
    assert.ok(page.includes(`<label><input type="checkbox" name="agree_${s.id}" value="yes" required> <span>`), `${s.id} checkbox`);
  }
  assert.equal(page.match(/type="checkbox"/g).length, REQUIRED_IDS.length);
  assert.doesNotMatch(page, /checked/);
  assert.equal(page.match(/<button/g).length, 1);
  assert.match(page, /<button type="submit">Accept<\/button>/);
  assert.match(page, /data-yeet-agreements/); assert.match(page, /<script type="module" src="\/account\/consent\.js"><\/script>/);
  // The optional product-email choice is not on the bearer page at all.
  assert.doesNotMatch(page, /agree_product_email|product emails|optional/i);
  assert.ok(page.includes(`name="t" value="${t}"`));
  assert.doesNotMatch(page, /sign in|password|privy-login/i);
  assert.equal(acceptanceOf(A, TERMS_VERSION), null, "looking records nothing");
});

test("Accept records ONLY the required statements for the token's account, source terms-link; the optional opt-in is never taken from the link", async () => {
  const t = mint();
  // The Origin must be this server's: another site cannot post the form even with the token.
  assert.equal((await post({ t, version: TERMS_VERSION }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ t, version: TERMS_VERSION }, { origin: null })).status, 403);
  assert.equal(acceptanceOf(A, TERMS_VERSION), null);
  // Whoever holds the link adds the opt-in and an id the page never showed: neither is recorded.
  const r = await post({ t, version: TERMS_VERSION, ...TICKED, agree_product_email: "yes", agree_admin: "yes" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const page = await r.text();
  assert.ok(page.includes(TERMS_DONE));
  assert.doesNotMatch(page, /<a |<button|<form/, "the done state leads nowhere else");
  const row = acceptanceOf(A, TERMS_VERSION);
  assert.deepEqual(row.statements, [...REQUIRED_IDS], "the required lines and nothing else");
  assert.ok(!row.statements.includes("product_email"));
  assert.equal(row.source, "terms-link"); assert.equal(row.client_id, "terms-link");
  assert.equal(acceptanceOf(B, TERMS_VERSION), null, "only the token's account");
  const sent = calls.findLast((c) => c.route === "/terms/accept");
  assert.equal(sent.account, A); assert.deepEqual(sent.body.confirmed, [...REQUIRED_IDS]); assert.equal(sent.body.via, "link");
  assert.match(sent.body.token_id, /^[A-Za-z0-9_-]{16,32}$/);
});

test("one box left unticked, or none: nothing is recorded, the token is not spent, and the page asks for each line", async () => {
  const C = "yeet-privy-CCCCCCCCCCCCCCCCCCCCCC";
  const before = calls.filter((c) => c.route === "/terms/accept").length;
  for (const fields of [{}, Object.fromEntries(Object.entries(TICKED).slice(1)), { agree_all: "yes" }, { ...Object.fromEntries(Object.entries(TICKED).slice(1)), [`agree_${REQUIRED_IDS[0]}`]: "no" }]) {
    const id = tokenId(), t = mint({ account: C, claims: { v: TERMS_VERSION, j: id } });
    const r = await post({ t, version: TERMS_VERSION, ...fields });
    assert.equal(r.status, 400, JSON.stringify(fields));
    const page = await r.text();
    assert.match(page, /Agree to each line to continue\./);
    assert.equal(page.match(/type="checkbox"/g).length, REQUIRED_IDS.length, "the boxes again");
    assert.equal(useTermsLink(id, C), true, "a refused acceptance did not spend the token");
  }
  assert.equal(calls.filter((c) => c.route === "/terms/accept").length, before, "the core was never asked");
  assert.equal(acceptanceOf(C, TERMS_VERSION), null);
});

test("single use: a second Accept with the same token records nothing and reads as already accepted", async () => {
  const first = acceptanceOf(A, TERMS_VERSION);
  const used = calls.findLast((c) => c.route === "/terms/accept").body.token_id;
  // The same token again (minted with the id that was just used).
  const again = mint({ claims: { v: TERMS_VERSION, j: used } });
  const r = await post({ t: again, version: TERMS_VERSION, ...TICKED });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(TERMS_ALREADY));
  assert.deepEqual(acceptanceOf(A, TERMS_VERSION), first, "the first acceptance stands, untouched");
  assert.equal(useTermsLink(used, A), false, "the id stays used");
  // Opening the link again (GET) is the done state too.
  const page = await get({ t: again });
  assert.equal(page.status, 200); assert.ok((await page.text()).includes(TERMS_DONE));
  // A used token for an account whose terms are NOT accepted (it was spent elsewhere) is simply expired.
  assert.equal(useTermsLink("spentid000000001", B), true);
  await isExpired(await post({ t: mint({ account: B, claims: { v: TERMS_VERSION, j: "spentid000000001" } }), version: TERMS_VERSION, ...TICKED }), "a spent token");
  assert.equal(acceptanceOf(B, TERMS_VERSION), null);
  // A token with no id at all is no token.
  await isExpired(await get({ t: mint({ account: B, claims: { v: TERMS_VERSION } }) }), "no id");
});

test("a supplied token that is expired, tampered, of another purpose, key or version is REFUSED: never the session of whoever is here", async () => {
  const good = mint({ account: B }), [v, body, sig] = good.split(".");
  const forA = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), a: A })).toString("base64url");
  const bad = {
    empty: "",
    expired: mint({ account: B, now: Date.now() - 601_000 }),
    tampered_mac: `${v}.${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`,
    wrong_account: `${v}.${forA}.${sig}`,
    wrong_purpose: mintLinkToken(key, { purpose: "hint", account: B, ttl: 600, claims: { m: ["google"], v: TERMS_VERSION, j: tokenId() } }),
    other_key: mintLinkToken(deriveLinkKey("z".repeat(40)), { purpose: "terms", account: B, ttl: 600, claims: { v: TERMS_VERSION, j: tokenId() } }),
    old_version: mint({ account: B, claims: { v: "2020-01-01", j: tokenId() } }),
    junk: "v1.abc.def",
  };
  for (const [name, t] of Object.entries(bad)) {
    // No session, a session of the OTHER account, and a session of the same account: the expired state every time.
    for (const cookie of [undefined, "yeet_session=a", "yeet_session=b"]) {
      await isExpired(await get({ t }, cookie), `${name} GET ${cookie}`);
      await isExpired(await post({ t, version: TERMS_VERSION }, { cookie }), `${name} POST ${cookie}`);
    }
  }
  assert.equal(acceptanceOf(B, TERMS_VERSION), null, "nothing was recorded for anyone");
  // With nothing supplied at all, the page is the signed-in account's own, as before; with no session, the sign-in.
  const own = await get({}, "yeet_session=b");
  assert.equal(own.status, 200); assert.match(await own.text(), /name="csrf" value="c"/);
  const none = await get({});
  assert.equal(none.status, 303); assert.equal(none.headers.get("location"), "/account/login?next=terms");
});

test("an expired token with a hint: the fallback honours the hint. Only the hint's account gets its page; a session of another account never does", async () => {
  const expired = mint({ account: B, now: Date.now() - 601_000 }), h = hintFor(B);
  const bound = `/account/login?next=terms&h=${encodeURIComponent(h)}`;
  // Nobody signed in: the sign-in page, bound to B.
  let r = await get({ t: expired, h });
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), bound);
  // Signed in as A (not the link's account): never A's terms page; the bound sign-in for B.
  r = await get({ t: expired, h }, "yeet_session=a");
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), bound);
  // Signed in as B: B's own page.
  r = await get({ t: expired, h }, "yeet_session=b");
  assert.equal(r.status, 200); assert.match(await r.text(), /name="csrf" value="c"/);
  // The hint alone behaves the same.
  r = await get({ h }, "yeet_session=a");
  assert.equal(r.status, 303); assert.equal(r.headers.get("location"), bound);
  // A hint that does not verify is refused, with or without a token or a session.
  for (const badHint of ["", "junk", hintFor(B, { now: Date.now() - 700_000 }), h.slice(0, -2) + (h.endsWith("AA") ? "BB" : "AA"), mint({ account: B })])
    for (const cookie of [undefined, "yeet_session=a", "yeet_session=b"]) {
      await isExpired(await get({ t: expired, h: badHint }, cookie), `bad hint ${cookie}`);
      await isExpired(await get({ h: badHint }, cookie), `bad hint alone ${cookie}`);
    }
  // A valid token wins over anything else on the link: it names the account by itself.
  r = await get({ t: mint({ account: B }), h: "junk" }, "yeet_session=a");
  assert.equal(r.status, 200); assert.match(await r.text(), /data-yeet-terms-link/);
});

test("the link names the account: a signed-in browser of another account accepts for the link's account, never its own", async () => {
  const r = await post({ t: mint({ account: B }), version: TERMS_VERSION, ...TICKED }, { cookie: "yeet_session=a" });
  assert.equal(r.status, 200);
  assert.equal(acceptanceOf(B, TERMS_VERSION).source, "terms-link");
});

test("the terms changed while the page was open: nothing is recorded and the token is not spent", async () => {
  const C = "yeet-privy-CCCCCCCCCCCCCCCCCCCCCC";
  const t = mint({ account: C });
  version = "2027-01-01";
  try {
    // The token names the old version: it is no token any more.
    await isExpired(await get({ t }), "old version");
    const id = tokenId();
    const stale = mint({ account: C, claims: { v: "2027-01-01", j: id } });
    const r = await post({ t: stale, version: TERMS_VERSION, ...TICKED });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /These terms changed\. Go back to ChatGPT/);
    assert.equal(acceptanceOf(C, TERMS_VERSION), null);
    assert.equal(useTermsLink(id, C), true, "a refused acceptance did not spend the token");
  } finally { version = TERMS_VERSION; }
});

test("N3: the token and the acceptance are one transaction: a failed acceptance does not burn the link", async () => {
  const D = "yeet-privy-DDDDDDDDDDDDDDDDDDDDDD", id = "txid000000000001";
  // The acceptance cannot be written (here: statements that cannot be stored), AFTER the token row went in:
  // everything rolls back.
  assert.throws(() => acceptViaLink({ tokenId: id, accountId: D, version: TERMS_VERSION, statements: [10n] }), TypeError);
  assert.equal(acceptanceOf(D, TERMS_VERSION), null, "nothing was recorded");
  // The same token still works: it was not marked used by the failed try.
  const first = acceptViaLink({ tokenId: id, accountId: D, version: TERMS_VERSION, statements: [...REQUIRED_IDS], now: 1_800_000_000_000 });
  assert.equal(first.used, false); assert.equal(first.fresh, true);
  assert.equal(first.record.source, "terms-link"); assert.equal(first.record.client_id, "terms-link"); assert.equal(first.record.accepted_at, 1_800_000_000_000);
  // And then it is used: a second call records nothing and changes nothing.
  assert.deepEqual(acceptViaLink({ tokenId: id, accountId: D, version: TERMS_VERSION, statements: [...REQUIRED_IDS], now: 1_800_000_009_000 }), { used: true, record: null });
  assert.equal(acceptanceOf(D, TERMS_VERSION).accepted_at, 1_800_000_000_000);
  // A fresh token after the acceptance: the first acceptance stands (fresh: false), and that token is used too.
  const second = acceptViaLink({ tokenId: "txid000000000002", accountId: D, version: TERMS_VERSION, statements: [...REQUIRED_IDS], now: 1_800_000_010_000 });
  assert.equal(second.used, false); assert.equal(second.fresh, false); assert.equal(second.record.accepted_at, 1_800_000_000_000);
  assert.equal(useTermsLink("txid000000000002", D), false);
  assert.throws(() => acceptViaLink({ tokenId: "short", accountId: D, version: TERMS_VERSION, statements: [] }), /Invalid token id/);
  assert.throws(() => acceptViaLink({ tokenId: "txid000000000003", accountId: "nobody", version: TERMS_VERSION, statements: [] }), /Invalid account/);
  // The core's route calls exactly this, and no longer marks the token on its own first.
  const { readFileSync } = await import("node:fs");
  const coreSrc = readFileSync(new URL("../../core/core.mjs", import.meta.url), "utf8");
  assert.match(coreSrc, /acceptViaLink\(\{accountId:q\.subject,tokenId:b\.token_id,version:TERMS_VERSION,statements:check\.confirmed\}\)/);
  assert.doesNotMatch(coreSrc, /useTermsLink/);
});

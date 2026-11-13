// /fund route: session required, Privy-only, page headers and CSP; sign-in return target. In-process express on an
// ephemeral loopback port; no network beyond 127.0.0.1.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fundRoutes, fundCsp, privyPageCsp, afterSignIn, nextField, FUND_TITLE, BASE_RPC_ORIGIN } from "../fund-page.mjs";
import { BASE_RPC } from "../../login/fund-balance.js";

let enabled = true;
const app = express();
fundRoutes(app, { enabled: () => enabled, session: (q) => (q.headers.cookie === "yeet_session=good" ? { id: "yeet-privy-a" } : null) });
let server, base;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
const get = (cookie) => fetch(base + "/fund", { redirect: "manual", headers: cookie ? { cookie } : {} });
const directives = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test("no session: 303 to the sign-in page with the fund return target, nothing cached", async () => {
  for (const cookie of [undefined, "yeet_session=other"]) {
    const r = await get(cookie);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/account/login?next=fund");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("content-security-policy"), null);
  }
});

test("Privy sign-in not configured: 404 even with a session", async () => {
  enabled = false;
  try {
    assert.equal((await get("yeet_session=good")).status, 404);
    assert.equal((await get()).status, 404);
  } finally {
    enabled = true;
  }
});

test("signed in: page with nonce CSP for Privy and the Base RPC, popup-friendly opener policy", async () => {
  const r = await get("yeet_session=good");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const html = await r.text();
  const nonce = html.match(/<meta property="csp-nonce" content="([^"]+)">/)?.[1];
  assert.ok(nonce && nonce.length >= 32);
  const csp = r.headers.get("content-security-policy");
  assert.equal(csp, fundCsp(nonce));
  const d = directives(csp);
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["script-src"], ["'self'", `'nonce-${nonce}'`, "https://challenges.cloudflare.com"]);
  assert.deepEqual(d["connect-src"], ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems", BASE_RPC_ORIGIN]);
  assert.deepEqual(d["frame-src"], ["https://auth.privy.io", "https://challenges.cloudflare.com"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'none'"]);
  assert.ok(!csp.includes("unsafe-"), "no unsafe-inline or unsafe-eval");
  // The balance adapter's RPC is exactly the origin the CSP allows.
  assert.equal(new URL(BASE_RPC).origin, BASE_RPC_ORIGIN);
  assert.match(html, new RegExp(`<title>${FUND_TITLE}</title>`));
  assert.match(html, /<div id="yeet-fund">/);
  assert.match(html, /<script type="module" src="\/account\/privy-login\/fund\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/account\/auth-pages\.css">/);
  // Fresh nonce per response.
  const again = (await (await get("yeet_session=good")).text()).match(/csp-nonce" content="([^"]+)"/)[1];
  assert.notEqual(again, nonce);
});

test("sign-in page CSP is unchanged by the shared builder", () => {
  const n = "N";
  assert.equal(
    privyPageCsp(n, { formAction: "'self' https://chatgpt.com" }),
    `default-src 'self'; script-src 'self' 'nonce-${n}' https://challenges.cloudflare.com; style-src 'self' 'nonce-${n}'; connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems; frame-src https://auth.privy.io https://challenges.cloudflare.com; child-src https://auth.privy.io https://challenges.cloudflare.com; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'`,
  );
});

test("sign-in return target accepts only the fund page", () => {
  assert.equal(afterSignIn("fund"), "/fund");
  for (const v of [undefined, "", "/fund", "https://evil.example/", "//evil.example", ["fund"], "FUND"]) {
    assert.equal(afterSignIn(v), "/account/");
    assert.equal(nextField(v), "");
  }
  assert.equal(nextField("fund"), '<input type="hidden" name="next" value="fund">');
});

test("sign-in CSP: Telegram adds only Privy's widget script and oauth.telegram.org; the fund page keeps neither", () => {
  const d = directives(privyPageCsp("n", { formAction: "'self' https://chatgpt.com", telegram: true }));
  assert.deepEqual(d["script-src"], ["'self'", "'nonce-n'", "https://challenges.cloudflare.com", "https://auth.privy.io"]);
  assert.deepEqual(d["frame-src"], ["https://auth.privy.io", "https://challenges.cloudflare.com", "https://oauth.telegram.org"]);
  assert.deepEqual(d["child-src"], ["https://auth.privy.io", "https://challenges.cloudflare.com", "https://oauth.telegram.org"]);
  assert.deepEqual(d["connect-src"], ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems", "https://oauth.telegram.org"]);
  assert.deepEqual(d["form-action"], ["'self'", "https://chatgpt.com"]);
  assert.ok(!fundCsp("n").includes("telegram"));
});

// /agent/approve route: off unless YEET_AGENT_ACCESS=on and the Privy sign-in is configured; no session needed; page
// headers and CSP; the page script and nothing of the user code echoed. In-process express on an ephemeral loopback
// port; no network beyond 127.0.0.1.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { AGENT_PATH, AGENT_TITLE, agentAccess, agentCsp, agentRoutes } from "../agent-page.mjs";
import { privyPageCsp } from "../fund-page.mjs";
import { AGENT_PATH as PAGE_PATH, PRIVY_AUTH } from "../../login/agent-approve.js";

let on = true, enabled = true;
const app = express();
agentRoutes(app, { on: () => on, enabled: () => enabled });
let server, base;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));
const get = (query = "?user_code=ABCD-1234") => fetch(base + AGENT_PATH + query, { redirect: "manual" });
const directives = (csp) => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

test("the setting: only on turns the page on; default off", () => {
  for (const v of ["on", "ON", " on "]) assert.equal(agentAccess(v), true, v);
  for (const v of [undefined, null, "", "off", "1", "true", "yes", "onn"]) assert.equal(agentAccess(v), false, String(v));
  const was = process.env.YEET_AGENT_ACCESS;
  try {
    delete process.env.YEET_AGENT_ACCESS;
    assert.equal(agentAccess(), false);
    process.env.YEET_AGENT_ACCESS = "on";
    assert.equal(agentAccess(), true);
  } finally {
    if (was === undefined) delete process.env.YEET_AGENT_ACCESS;
    else process.env.YEET_AGENT_ACCESS = was;
  }
});

test("off (the setting, or no Privy sign-in): 404 with or without a code", async () => {
  for (const [a, b] of [[false, true], [true, false], [false, false]]) {
    on = a;
    enabled = b;
    try {
      assert.equal((await get()).status, 404);
      assert.equal((await get("")).status, 404);
    } finally {
      on = true;
      enabled = true;
    }
  }
});

test("on: the page for anyone (no session), nonce CSP of the Privy pages, no referrer, same-origin opener", async () => {
  const r = await get();
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const html = await r.text();
  const nonce = html.match(/<meta property="csp-nonce" content="([^"]+)">/)?.[1];
  assert.ok(nonce && nonce.length >= 32);
  const csp = r.headers.get("content-security-policy");
  assert.equal(csp, agentCsp(nonce));
  assert.equal(csp, privyPageCsp(nonce));
  const d = directives(csp);
  // Every call the page makes (device_verify, grants list and revoke) goes to Privy's auth host, which is allowed.
  assert.ok(d["connect-src"].includes(PRIVY_AUTH));
  assert.deepEqual(d["connect-src"], ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.ok(!csp.includes("unsafe-"), "no unsafe-inline or unsafe-eval");
  assert.ok(!/stripe|telegram/.test(csp), "nothing of the fund or sign-in extras");
  // The same page frame as the fund and consent pages: the shared document, the wordmark, one card.
  assert.match(html, new RegExp(`<title>${AGENT_TITLE}</title>`));
  assert.match(html, /<link rel="stylesheet" href="\/account\/auth-pages\.css">/);
  assert.match(html, /<section class="card" aria-labelledby="page-title"><h1 id="page-title" class="display">Approve an agent<\/h1>/);
  assert.match(html, /<div id="yeet-agent"><p role="status">Loading secure sign in…<\/p><\/div>/);
  assert.match(html, /<script type="module" src="\/account\/privy-login\/agent\.js"><\/script>/);
  // The code is read by the page script from the address; the server never writes it into the page.
  assert.ok(!html.includes("ABCD-1234"));
  const again = (await (await get()).text()).match(/csp-nonce" content="([^"]+)"/)[1];
  assert.notEqual(again, nonce);
});

test("a code that is not one is not echoed either, and the page is the same", async () => {
  const r = await get("?user_code=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(!html.includes("alert(1)"));
  assert.ok(!html.includes("<script>"));
});

test("the page script and the route agree on the path; only GET is served", async () => {
  assert.equal(PAGE_PATH, AGENT_PATH);
  assert.equal(AGENT_PATH, "/agent/approve");
  const r = await fetch(base + AGENT_PATH, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(r.status, 404);
});

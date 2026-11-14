// The agent approval page: served at /approve on the agent host only (mcp.yeet.win), with exactly its frame files, its
// bundle files (dist/agent-files.json) and the public identity config; 404 for everything else there; /approve and
// /agent/approve 404 on every other host. Off unless YEET_AGENT_ACCESS=on and the Privy sign-in is configured; no
// session needed; page headers and CSP; nothing of the user code echoed. In-process express on an ephemeral loopback
// port with fixture viewer and dist folders; no network beyond 127.0.0.1.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
  AGENT_PATH,
  OLD_AGENT_PATH,
  AGENT_TITLE,
  AGENT_MANIFEST,
  AGENT_VIEWER_FILES,
  AGENT_HOST_PATHS,
  AGENT_CONFIG_PATH,
  agentAccess,
  agentCsp,
  agentRoutes,
} from "../agent-page.mjs";
import { privyPageCsp } from "../fund-page.mjs";
import { AGENT_PATH as PAGE_PATH, PRIVY_AUTH } from "../../login/agent-approve.js";
import { AGENT_MANIFEST as BUILD_MANIFEST, agentBundleFiles } from "../../login/agent-files.mjs";
import { agentResource } from "#shared/agent-route.mjs";

const AGENT_HOST = "mcp.yeet.win";
const MAIN_HOST = "chatgpt.yeet.win";
const fixture = mkdtempSync(join(tmpdir(), "yeet-agent-page-"));
const viewerDir = join(fixture, "viewer"), distDir = join(fixture, "dist");
mkdirSync(join(viewerDir, "brand"), { recursive: true });
mkdirSync(distDir);
for (const p of AGENT_VIEWER_FILES) writeFileSync(join(viewerDir, p.slice("/account/".length)), `viewer ${p}`);
writeFileSync(join(viewerDir, "consent.js"), "not for the agent host");
for (const f of ["agent.js", "chunk-A.js", "login.js", "fund.js", "sign.js"]) writeFileSync(join(distDir, f), `dist ${f}`);
writeFileSync(join(distDir, AGENT_MANIFEST), JSON.stringify(["agent.js", "chunk-A.js", "../secret.js"]));
writeFileSync(join(fixture, "secret.js"), "outside");

let on = true, enabled = true, configCalls = 0;
const reachedApp = [];
const app = express();
agentRoutes(app, {
  on: () => on,
  enabled: () => enabled,
  host: AGENT_HOST,
  identityConfig: (_q, r) => {
    configCalls++;
    r.set("Cache-Control", "no-store").json({ appId: "app-fixture", methods: ["google"] });
  },
  viewerDir,
  distDir,
});
// Stands in for every other route of the sign-in server (login, fund, sign, OAuth): the agent host never gets here.
app.use((q, r) => {
  reachedApp.push(`${q.headers.host} ${q.method} ${q.path}`);
  r.status(200).send("sign-in app");
});
let server, port;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(fixture, { recursive: true, force: true });
});
/** fetch cannot set Host; the sign-in server routes on it (Caddy passes it through). */
const req = (host, path, method = "GET", body) =>
  new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, (r) => {
      let text = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (text += c));
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, text }));
    });
    q.on("error", (e) => reject(Object.assign(e, { message: `${e.message} (${method} ${path})` })));
    if (body) q.write(body);
    q.end();
  });
const page = (query = "?user_code=ABCD-1234", host = AGENT_HOST) => req(host, AGENT_PATH + query);
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

test("the address: /approve on the agent host, the default agent host is mcp.yeet.win", () => {
  assert.equal(AGENT_PATH, "/approve");
  assert.equal(PAGE_PATH, AGENT_PATH, "the page script's OAuth return address is location.origin + /approve");
  assert.equal(new URL(agentResource({})).host, AGENT_HOST);
  assert.equal(BUILD_MANIFEST, AGENT_MANIFEST);
  assert.deepEqual(AGENT_HOST_PATHS, ["/approve", ...AGENT_VIEWER_FILES, "/account/identity-config", "/account/privy-login/"]);
});

test("off (the setting, or no Privy sign-in): every path on the agent host is 404, with or without a code", async () => {
  for (const [a, b] of [[false, true], [true, false], [false, false]]) {
    on = a;
    enabled = b;
    try {
      for (const p of [AGENT_PATH + "?user_code=ABCD-1234", AGENT_PATH, AGENT_CONFIG_PATH, "/account/auth-pages.css", "/account/privy-login/agent.js"])
        assert.equal((await req(AGENT_HOST, p)).status, 404, p);
    } finally {
      on = true;
      enabled = true;
    }
  }
  assert.deepEqual(reachedApp, []);
});

test("on: the page for anyone (no session), nonce CSP of the Privy pages, no referrer, same-origin opener", async () => {
  const r = await page();
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["set-cookie"], undefined, "the page sets no cookie");
  const html = r.text;
  const nonce = html.match(/<meta property="csp-nonce" content="([^"]+)">/)?.[1];
  assert.ok(nonce && nonce.length >= 32);
  const csp = r.headers["content-security-policy"];
  assert.equal(csp, agentCsp(nonce));
  assert.equal(csp, privyPageCsp(nonce));
  const d = directives(csp);
  // Every call the page makes (device_verify, grants list and revoke) goes to Privy's auth host, which is allowed;
  // 'self' is the agent host it is served on, where its files and the identity config are.
  assert.ok(d["connect-src"].includes(PRIVY_AUTH));
  assert.deepEqual(d["connect-src"], ["'self'", "https://auth.privy.io", "https://*.rpc.privy.systems"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.ok(!csp.includes("unsafe-"), "no unsafe-inline or unsafe-eval");
  assert.ok(!/stripe|telegram|chatgpt/.test(csp), "nothing of the fund or sign-in extras, no ChatGPT origin");
  // The same page frame as the fund and consent pages: the shared document, the wordmark, one card.
  assert.match(html, new RegExp(`<title>${AGENT_TITLE}</title>`));
  assert.match(html, /<link rel="stylesheet" href="\/account\/auth-pages\.css">/);
  assert.match(html, /<section class="card" aria-labelledby="page-title"><h1 id="page-title" class="display">Approve an agent<\/h1>/);
  assert.match(html, /<div id="yeet-agent"><p role="status">Loading secure sign in…<\/p><\/div>/);
  assert.match(html, /<script type="module" src="\/account\/privy-login\/agent\.js"><\/script>/);
  // Every same-origin address the page references is one the agent host serves.
  for (const [, u] of html.matchAll(/(?:href|src)="(\/[^"]*)"/g))
    assert.ok(AGENT_VIEWER_FILES.includes(u) || u === "/account/privy-login/agent.js", u);
  // The code is read by the page script from the address; the server never writes it into the page.
  assert.ok(!html.includes("ABCD-1234"));
  const again = (await page()).text.match(/csp-nonce" content="([^"]+)"/)[1];
  assert.notEqual(again, nonce);
  assert.equal((await req(AGENT_HOST, AGENT_PATH, "HEAD")).status, 200);
  assert.equal((await req("MCP.YEET.WIN", AGENT_PATH)).status, 200, "host names are case-insensitive");
});

test("a code that is not one is not echoed either, and the page is the same", async () => {
  const r = await page("?user_code=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes("alert(1)"));
  assert.ok(!r.text.includes("<script>"));
});

test("on the agent host: exactly the frame files, the identity config and the agent bundle files; GET and HEAD only", async () => {
  for (const p of AGENT_VIEWER_FILES) {
    const r = await req(AGENT_HOST, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.text, `viewer ${p}`);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  }
  for (const f of ["agent.js", "chunk-A.js"]) {
    const r = await req(AGENT_HOST, `/account/privy-login/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(r.text, `dist ${f}`);
  }
  const before = configCalls;
  const c = await req(AGENT_HOST, AGENT_CONFIG_PATH);
  assert.equal(c.status, 200);
  assert.deepEqual(JSON.parse(c.text), { appId: "app-fixture", methods: ["google"] });
  assert.equal(configCalls, before + 1);
  for (const m of ["POST", "PUT", "DELETE", "PATCH"])
    for (const p of [AGENT_PATH, AGENT_CONFIG_PATH, "/account/privy-login/agent.js"])
      assert.equal((await req(AGENT_HOST, p, m, m === "DELETE" ? undefined : "{}")).status, 404, `${m} ${p}`);
  assert.deepEqual(reachedApp, []);
});

test("on the agent host: nothing else of the sign-in app, no other bundle file, no path tricks", async () => {
  const refused = [
    "/", OLD_AGENT_PATH, "/approve/", "/approve/x", "/account/login", "/account/", "/account/logout", "/account/wallets",
    "/account/email-step", "/account/waitlist", "/account/consent.js", "/account/privy-login/login.js",
    "/account/privy-login/fund.js", "/account/privy-login/sign.js", `/account/privy-login/${AGENT_MANIFEST}`,
    "/account/privy-login/..%2Fsecret.js", "/account/privy-login/%2e%2e/secret.js", "/account/privy-login/../secret.js",
    "/account/privy-login/", "/account/brand/app-icon.svg", "/fund", "/sign", "/sign/api/x", "/interaction/x", "/auth",
    "/token", "/reg", "/me", "/jwks", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server",
    "/favicon.ico", "/cards/yeet-signer.js", "/terms",
  ];
  for (const p of refused) assert.equal((await req(AGENT_HOST, p)).status, 404, p);
  assert.equal((await req(AGENT_HOST, "/account/login", "POST", "{}")).status, 404);
  assert.deepEqual(reachedApp, [], "no agent-host request reached the sign-in app");
});

test("on the ChatGPT host (any other host): /approve and /agent/approve are 404, everything else is the sign-in app", async () => {
  for (const host of [MAIN_HOST, "127.0.0.1"]) {
    for (const p of [AGENT_PATH, AGENT_PATH + "?user_code=ABCD-1234", OLD_AGENT_PATH, OLD_AGENT_PATH + "?user_code=ABCD-1234"])
      for (const m of ["GET", "HEAD", "POST"]) assert.equal((await req(host, p, m)).status, 404, `${host} ${m} ${p}`);
  }
  reachedApp.length = 0;
  const r = await req(MAIN_HOST, "/account/login");
  assert.equal(r.status, 200);
  assert.equal(r.text, "sign-in app");
  assert.deepEqual(reachedApp, [`${MAIN_HOST} GET /account/login`]);
  reachedApp.length = 0;
});

test("no manifest (login bundle not built): the agent host serves no bundle file at all", async () => {
  const a = express();
  const empty = mkdtempSync(join(tmpdir(), "yeet-agent-nodist-"));
  try {
    writeFileSync(join(empty, "agent.js"), "x");
    agentRoutes(a, { on: () => true, enabled: () => true, host: AGENT_HOST, identityConfig: (_q, r) => r.json({}), viewerDir, distDir: empty });
    const s = a.listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const status = await new Promise((resolve, reject) =>
      http.get({ host: "127.0.0.1", port: s.address().port, path: "/account/privy-login/agent.js", headers: { host: AGENT_HOST } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject),
    );
    await new Promise((r) => s.close(r));
    assert.equal(status, 404);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("agentBundleFiles: agent.js and its static and dynamic chunks, nothing of the other entries", () => {
  const metafile = {
    outputs: {
      "dist/agent.js": { imports: [{ path: "dist/chunk-A.js", kind: "import-statement" }, { path: "dist/Screen-B.js", kind: "dynamic-import" }] },
      "dist/chunk-A.js": { imports: [{ path: "dist/chunk-C.js", kind: "import-statement" }, { path: "https://x", kind: "import-statement", external: true }] },
      "dist/chunk-C.js": { imports: [{ path: "dist/chunk-A.js", kind: "import-statement" }] },
      "dist/Screen-B.js": { imports: [] },
      "dist/login.js": { imports: [{ path: "dist/chunk-A.js", kind: "import-statement" }, { path: "dist/chunk-L.js", kind: "import-statement" }] },
      "dist/chunk-L.js": { imports: [] },
    },
  };
  assert.deepEqual(agentBundleFiles(metafile), ["Screen-B.js", "agent.js", "chunk-A.js", "chunk-C.js"]);
  assert.deepEqual(agentBundleFiles({}), []);
});

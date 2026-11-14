// Agent approval page at https://mcp.yeet.win/approve (the agent host, AGENT_RESOURCE): the Verification URI of
// Privy's "CLI and agent access" (OAuth device authorization,
// https://docs.privy.io/recipes/agent-integrations/agent-authorization.md). An agent on the person's computer (Claude
// Code, Codex, a script) prints a short code and this address with ?user_code=<code>; the person signs in here with the
// YEET sign-in methods and approves or denies. On Approve, Privy lets that agent sign with the person's own YEET
// embedded wallet until the person revokes it (the page lists those agents with Revoke).
//
// The page script (login/agent.jsx, rules in login/agent-approve.js) talks only to Privy (https://auth.privy.io),
// with the person's own Privy access token: this server has no route for it, no secret in it, and nothing it could
// sign or approve with. The sign-in server serves it, but only on the agent host and only these paths:
//
//   GET/HEAD /approve                         the page
//   GET/HEAD AGENT_VIEWER_FILES               the page frame (styles, icon, logo, page script)
//   GET/HEAD /account/identity-config         the public Privy app id and sign-in methods
//   GET/HEAD /account/privy-login/<file>      only the files of the agent.js bundle (dist/agent-files.json, written
//                                             by login/build.mjs from esbuild's metafile)
//
// Everything else on the agent host is 404 here: no session, no cookie, no form, no sign-in route of the ChatGPT host
// is reachable from it. On every other host (chatgpt.yeet.win) /approve and the old /agent/approve are 404.
//
//   YEET_AGENT_ACCESS   "on" serves the page. Anything else (default): 404.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { document } from "./auth-pages.mjs";
import { privyPageCsp } from "./fund-page.mjs";

export const AGENT_PATH = "/approve";
/** The page's address before it moved to the agent host: 404 everywhere. */
export const OLD_AGENT_PATH = "/agent/approve";
export const AGENT_TITLE = "Approve an agent";
export const AGENT_CONFIG_PATH = "/account/identity-config";
export const AGENT_BUNDLE_PREFIX = "/account/privy-login/";
/** Written into login/dist/ by login/build.mjs (login/agent-files.mjs; the image has only login/dist/, so the name is
 * repeated there and a test keeps the two equal). */
export const AGENT_MANIFEST = "agent-files.json";
/** The files of the page frame (auth-pages.mjs document()), served from as/viewer/. */
export const AGENT_VIEWER_FILES = Object.freeze([
  "/account/icon.svg",
  "/account/brand/tokens.css",
  "/account/auth-pages.css",
  "/account/brand/type-data.js",
  "/account/page.js",
  "/account/brand/logo.svg",
]);
/** The path prefixes the agent host passes to the sign-in server (Caddy, connector/docs/AGENT-ROUTE.md). */
export const AGENT_HOST_PATHS = Object.freeze([AGENT_PATH, ...AGENT_VIEWER_FILES, AGENT_CONFIG_PATH, AGENT_BUNDLE_PREFIX]);

/** The setting: only "on" turns the page on. */
export const agentAccess = (value = process.env.YEET_AGENT_ACCESS) => String(value ?? "").trim().toLowerCase() === "on";

/** The Privy page policy of the sign-in server as it is: device_verify and the grants are on https://auth.privy.io.
 * 'self' is the agent host the page is served on. */
export const agentCsp = (nonce) => privyPageCsp(nonce);

export const agentBody = () =>
  `<div id="yeet-agent"><p role="status">Loading secure sign in…</p></div><script type="module" src="${AGENT_BUNDLE_PREFIX}agent.js"></script>`;

const hostOf = (q) => String(q.headers.host ?? "").toLowerCase();
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/;

/**
 * Mount before every other route. host: the agent host (new URL(AGENT_RESOURCE).host). on(): YEET_AGENT_ACCESS.
 * enabled(): the Privy sign-in is configured (PRIVY_LOGIN=1); the page cannot work without it. identityConfig: the
 * sign-in server's own GET /account/identity-config handler. viewerDir, distDir: as/viewer/ and login/dist/.
 * No session is needed: the person signs in with Privy on the page itself.
 */
export function agentRoutes(app, { on = agentAccess, enabled, host, identityConfig, viewerDir, distDir }) {
  const agentHost = String(host ?? "").toLowerCase();
  let bundle = null;
  const bundleFiles = () => {
    if (bundle) return bundle;
    try {
      const list = JSON.parse(readFileSync(join(distDir, AGENT_MANIFEST), "utf8"));
      if (Array.isArray(list) && list.includes("agent.js")) bundle = new Set(list.filter((f) => FILE.test(f)));
    } catch {}
    return bundle ?? new Set();
  };
  const page = (_q, r) => {
    const nonce = randomBytes(24).toString("base64");
    r.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": agentCsp(nonce),
      "Cross-Origin-Opener-Policy": "same-origin",
      // The address carries the user code: it never goes out in a Referer.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    r.type("html").send(document(AGENT_TITLE, agentBody(), nonce));
  };
  const file = (r, path) => r.set("X-Content-Type-Options", "nosniff").sendFile(path, { dotfiles: "deny" }, (e) => e && !r.headersSent && r.sendStatus(404));
  app.use((q, r, next) => {
    if (!agentHost || hostOf(q) !== agentHost) {
      // The ChatGPT host never serves the page, at its new or its old address.
      if (q.path === AGENT_PATH || q.path === OLD_AGENT_PATH) return r.sendStatus(404);
      return next();
    }
    // The agent host: only the page and what it loads, and only while it is on.
    if (!on() || !enabled() || (q.method !== "GET" && q.method !== "HEAD")) return r.sendStatus(404);
    if (q.path === AGENT_PATH) return page(q, r);
    if (q.path === AGENT_CONFIG_PATH) return identityConfig(q, r);
    if (AGENT_VIEWER_FILES.includes(q.path)) return file(r, join(viewerDir, q.path.slice("/account/".length)));
    if (q.path.startsWith(AGENT_BUNDLE_PREFIX)) {
      const f = q.path.slice(AGENT_BUNDLE_PREFIX.length);
      if (FILE.test(f) && bundleFiles().has(f)) return file(r, join(distDir, f));
    }
    return r.sendStatus(404);
  });
}

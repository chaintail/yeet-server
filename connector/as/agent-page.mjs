// Agent approval page at /agent/approve: the Verification URI of Privy's "CLI and agent access" (OAuth device
// authorization, https://docs.privy.io/recipes/agent-integrations/agent-authorization.md). An agent on the person's
// computer (Claude Code, Codex, a script) prints a short code and this address with ?user_code=<code>; the person
// signs in here with the YEET sign-in methods and approves or denies. On Approve, Privy lets that agent sign with the
// person's own YEET embedded wallet until the person revokes it (the page lists those agents with Revoke).
//
// The page script (login/agent.jsx, rules in login/agent-approve.js) talks only to Privy (https://auth.privy.io),
// with the person's own Privy access token: this server has no route for it, no secret in it, and nothing it could
// sign or approve with. It serves the page on the sign-in server's origin so the Privy session and sign-in methods
// are the YEET ones.
//
//   YEET_AGENT_ACCESS   "on" serves the page. Anything else (default): 404.
import { randomBytes } from "node:crypto";
import { document } from "./auth-pages.mjs";
import { privyPageCsp } from "./fund-page.mjs";

export const AGENT_PATH = "/agent/approve";
export const AGENT_TITLE = "Approve an agent";

/** The setting: only "on" turns the page on. */
export const agentAccess = (value = process.env.YEET_AGENT_ACCESS) => String(value ?? "").trim().toLowerCase() === "on";

/** The Privy page policy of the sign-in server as it is: device_verify and the grants are on https://auth.privy.io. */
export const agentCsp = (nonce) => privyPageCsp(nonce);

export const agentBody = () =>
  `<div id="yeet-agent"><p role="status">Loading secure sign in…</p></div><script type="module" src="/account/privy-login/agent.js"></script>`;

/**
 * GET /agent/approve. on(): YEET_AGENT_ACCESS. enabled(): the Privy sign-in is configured (PRIVY_LOGIN=1); the page
 * cannot work without it. No session is needed: the person signs in with Privy on the page itself.
 */
export function agentRoutes(app, { on = agentAccess, enabled }) {
  app.get(AGENT_PATH, (_q, r) => {
    if (!on() || !enabled()) return r.sendStatus(404);
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
  });
}

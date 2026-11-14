// The agent approval page (https://mcp.yeet.win/approve, as/agent-page.mjs), without React: the code the page is for, the calls to
// Privy made with the person's own Privy access token, and which screen the page shows.
//
// Privy's OAuth device authorization ("CLI and agent access",
// https://docs.privy.io/recipes/agent-integrations/agent-authorization.md): an agent on the person's computer asks
// Privy for a device code and shows the person a short user code and this page's address with ?user_code=<code>.
// The person signs in here and presses Approve or Deny; the page calls Privy's device_verify with that code. On
// Approve, Privy gives the agent its own tokens for THIS person's Privy user: the agent can then sign with the
// person's YEET embedded wallet, until the person revokes it below ("Agents with access", Privy's grants).
//
// No YEET server is involved in any of it: every call goes from the browser to https://auth.privy.io with the
// person's own Privy access token. YEET holds nothing that could sign, approve or revoke.
//
// Google and Apple send the person back to the bare page address (Privy matches allowed redirect addresses exactly,
// with no query): the code rides along in this tab's sessionStorage for at most CODE_TTL_MS. The page never approves
// by itself: Approve is always a press, after the person has seen the code.

export const AGENT_PATH = "/approve";
export const PRIVY_AUTH = "https://auth.privy.io";
export const CODE_KEY = "yeet-agent-user-code";
/** Privy's device and user codes live 10 minutes. */
export const CODE_TTL_MS = 10 * 60 * 1000;

export const APPROVE_LINE =
  "This lets the agent on your computer sign with your YEET wallet until you revoke it. Only approve a code you started yourself.";
export const LINES = Object.freeze({
  nocode: "Enter the code your agent shows, or open the link it printed.",
  approved: "Approved. Your agent finishes signing in by itself within a few seconds. You can close this page.",
  denied: "Denied. The agent got no access to your YEET wallet.",
  expired: "This code has expired or was already used. Start again from your agent to get a new code.",
  error: "YEET could not reach Privy just now. Nothing was approved. Try again.",
  signin: "Your sign-in here ended. Sign in again to continue.",
  invalid: "That doesn’t look like an agent code. Check it and try again.",
  grantsError: "The list of agents could not be loaded just now.",
  revokeError: "That agent could not be revoked just now. Try again.",
  none: "No agent has access to your YEET wallet.",
});

// Privy's examples are ABCD-1234 and BCDFG-HJKMN. Letters and digits, one optional dash, nothing else.
const CODE = /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/;
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A user code as Privy issues it (upper case, no spaces), or "" when it is not one. */
export function normalCode(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const v = value.replace(/\s+/g, "").toUpperCase();
  return CODE.test(v) ? v : "";
}

/** Keeps the code for the Google or Apple round trip of this tab. */
export function keepCode(storage, code, now = Date.now()) {
  try {
    if (code) storage?.setItem(CODE_KEY, JSON.stringify({ code, at: now }));
  } catch {
    /* storage off: Google and Apple come back without the code and the page asks for it */
  }
}
export function forgetCode(storage) {
  try {
    storage?.removeItem(CODE_KEY);
  } catch {
    /* nothing kept */
  }
}
/** The kept code while it can still be valid, else "". */
export function keptCode(storage, now = Date.now()) {
  let kept;
  try {
    kept = JSON.parse(storage?.getItem(CODE_KEY) ?? "null");
  } catch {
    return "";
  }
  if (!kept || typeof kept.at !== "number" || now - kept.at < 0 || now - kept.at > CODE_TTL_MS) return "";
  return normalCode(kept.code);
}
/** The code the page is for: the address's ?user_code= first, else the one this tab kept for the round trip. */
export function startCode({ search, storage, now = Date.now() }) {
  const given = normalCode(new URLSearchParams(search ?? "").get("user_code") ?? "");
  if (given) {
    keepCode(storage, given, now);
    return given;
  }
  return keptCode(storage, now);
}

const headers = (appId, token, json) => ({
  ...(json ? { "content-type": "application/json" } : {}),
  "privy-app-id": appId,
  authorization: `Bearer ${token}`,
});

/**
 * POST /api/oauth/v2/device_verify {user_code, action} with the person's Privy access token.
 * -> {status: approved | denied | expired | signin | error}. Privy answers 400 for an invalid or expired code.
 */
export async function deviceVerify({ fetch: f = fetch, appId, token, userCode, action }) {
  if (action !== "approve" && action !== "deny") throw Error("action must be approve or deny");
  if (!token) return { status: "signin" };
  const code = normalCode(userCode);
  if (!code) return { status: "expired" };
  let r;
  try {
    r = await f(`${PRIVY_AUTH}/api/oauth/v2/device_verify`, {
      method: "POST",
      headers: headers(appId, token, true),
      body: JSON.stringify({ user_code: code, action }),
    });
  } catch {
    return { status: "error" };
  }
  if (r.status === 400 || r.status === 404 || r.status === 410) return { status: "expired" };
  if (r.status === 401 || r.status === 403) return { status: "signin" };
  if (!r.ok) return { status: "error" };
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* no body */
  }
  if (body?.success !== true) return { status: "error" };
  return { status: action === "approve" ? "approved" : "denied" };
}

/** A Privy time: ISO text (the OpenAPI schema) or epoch seconds (the guide's example). -> Date or null. */
export function when(value) {
  let ms = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) ms = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && value) ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
  return ms === null || Number.isNaN(ms) ? null : new Date(ms);
}

/** GET /api/oauth/v2/grants -> {status: ok, grants: [{id, created, lastUsed}]} | {status: signin | error}. */
export async function listGrants({ fetch: f = fetch, appId, token }) {
  if (!token) return { status: "signin" };
  let r;
  try {
    r = await f(`${PRIVY_AUTH}/api/oauth/v2/grants`, { method: "GET", headers: headers(appId, token, false) });
  } catch {
    return { status: "error" };
  }
  if (r.status === 401 || r.status === 403) return { status: "signin" };
  if (!r.ok) return { status: "error" };
  let body = null;
  try {
    body = await r.json();
  } catch {
    return { status: "error" };
  }
  if (!Array.isArray(body?.data)) return { status: "error" };
  const grants = body.data
    .filter((g) => g && typeof g.id === "string" && GRANT_ID.test(g.id))
    .map((g) => ({ id: g.id, created: when(g.created_at), lastUsed: when(g.last_used_at) }))
    .sort((a, b) => (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0));
  return { status: "ok", grants };
}

/** DELETE /api/oauth/v2/grants/{id} -> {status: ok | signin | error}. An id Privy no longer knows counts as revoked. */
export async function revokeGrant({ fetch: f = fetch, appId, token, id }) {
  if (!token) return { status: "signin" };
  if (typeof id !== "string" || !GRANT_ID.test(id)) return { status: "error" };
  let r;
  try {
    r = await f(`${PRIVY_AUTH}/api/oauth/v2/grants/${encodeURIComponent(id)}`, { method: "DELETE", headers: headers(appId, token, false) });
  } catch {
    return { status: "error" };
  }
  if (r.status === 404) return { status: "ok" };
  if (r.status === 401 || r.status === 403) return { status: "signin" };
  if (!r.ok) return { status: "error" };
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* no body */
  }
  return body?.success === true ? { status: "ok" } : { status: "error" };
}

/** One line per agent: when it was approved and when it was last used. `timeZone` only for tests. */
export function grantLine(grant, { timeZone } = {}) {
  const fmt = (d) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(d);
  const made = grant?.created ? `Approved ${fmt(grant.created)}` : "Approved";
  return grant?.lastUsed ? `${made} · last used ${fmt(grant.lastUsed)}` : `${made} · not used yet`;
}

/**
 * Which screen the page shows.
 *   loading   Privy is starting, or the sign-in methods are still loading
 *   signin    nobody is signed in: the YEET sign-in methods (nothing is created here)
 *   nocode    signed in, no code: a field for the code the agent shows
 *   confirm   signed in, a code: the code, what approving means, Approve and Deny
 *   approved | denied | expired | error   the answer to the last press
 */
export function agentView({ ready, authenticated, code, result }) {
  if (!ready) return "loading";
  if (!authenticated) return "signin";
  if (result && ["approved", "denied", "expired", "error"].includes(result)) return result;
  return code ? "confirm" : "nocode";
}

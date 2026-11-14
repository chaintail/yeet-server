// What the agent approval page does (login/agent-approve.js): which code it is for, the calls to Privy with the
// person's own token and how each answer reads, the agents list and revoke, which screen shows. No React; fetch is
// a recording stand-in, nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PATH, APPROVE_LINE, CODE_KEY, CODE_TTL_MS, LINES, PRIVY_AUTH, agentView, deviceVerify, forgetCode, grantLine,
  keepCode, keptCode, listGrants, normalCode, revokeGrant, startCode, when,
} from "./agent-approve.js";

const APP = "cm0appid0000000000000000";
function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}
/** fetch that answers `status`/`body` (or throws) and records each call. */
function privy(status, body, { raw = false, fail = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    if (fail) throw TypeError("fetch failed");
    return new Response(raw ? body : body === undefined ? null : JSON.stringify(body), { status });
  };
  f.calls = calls;
  return f;
}

test("the words on the page are the agreed ones", () => {
  assert.equal(APPROVE_LINE, "This lets the agent on your computer sign with your YEET wallet until you revoke it. Only approve a code you started yourself.");
  assert.equal(AGENT_PATH, "/agent/approve");
  assert.equal(PRIVY_AUTH, "https://auth.privy.io");
});

test("codes: Privy's shapes are taken as they are, upper-cased, spaces dropped; anything else is no code", () => {
  for (const [given, want] of [["ABCD-1234", "ABCD-1234"], ["BCDFG-HJKMN", "BCDFG-HJKMN"], ["abcd-1234", "ABCD-1234"], [" ABCD 1234 ", "ABCD1234"], ["WXYZ2345", "WXYZ2345"]])
    assert.equal(normalCode(given), want, given);
  for (const bad of ["", "ABC", "ABCD--1234", "ABCD-1234-EFGH", "<script>", "ABCD_1234", "A".repeat(41), null, undefined, 1234, ["ABCD-1234"]])
    assert.equal(normalCode(bad), "", String(bad));
});

test("the code: from the address first and kept for the Google or Apple round trip; the kept one only while fresh", () => {
  const s = memory(), t = 1_800_000_000_000;
  assert.equal(startCode({ search: "?user_code=abcd-1234", storage: s, now: t }), "ABCD-1234");
  assert.deepEqual(JSON.parse(s.getItem(CODE_KEY)), { code: "ABCD-1234", at: t });
  // Google sends the person back to the bare address with its own parameters: the kept code.
  assert.equal(startCode({ search: "?privy_oauth_code=x&privy_oauth_state=y", storage: s, now: t + 60_000 }), "ABCD-1234");
  // A new code in the address replaces the kept one.
  assert.equal(startCode({ search: "?user_code=WXYZ-9876", storage: s, now: t + 61_000 }), "WXYZ-9876");
  // Past Privy's 10 minutes, or from the future, or damaged: nothing.
  assert.equal(keptCode(s, t + 61_000 + CODE_TTL_MS + 1), "");
  assert.equal(keptCode(s, t), "");
  s.setItem(CODE_KEY, "{not json");
  assert.equal(keptCode(s, t), "");
  s.setItem(CODE_KEY, JSON.stringify({ code: "<b>", at: t }));
  assert.equal(keptCode(s, t), "");
  forgetCode(s);
  assert.equal(s.getItem(CODE_KEY), null);
  assert.equal(startCode({ search: "", storage: s, now: t }), "");
  // A bad code in the address is no code, and does not replace a kept good one.
  keepCode(s, "ABCD-1234", t);
  assert.equal(startCode({ search: "?user_code=%3Cscript%3E", storage: s, now: t }), "ABCD-1234");
  // Storage that throws (blocked) never breaks the page.
  const broken = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); }, removeItem() { throw Error("blocked"); } };
  assert.equal(startCode({ search: "?user_code=ABCD-1234", storage: broken, now: t }), "ABCD-1234");
  assert.equal(keptCode(broken, t), "");
  forgetCode(broken);
  assert.equal(startCode({ search: "", storage: undefined }), "");
});

test("device_verify: the request is Privy's, with the person's token and the app id, nothing else", async () => {
  for (const action of ["approve", "deny"]) {
    const f = privy(200, { success: true });
    const out = await deviceVerify({ fetch: f, appId: APP, token: "user-token", userCode: "abcd-1234", action });
    assert.deepEqual(out, { status: action === "approve" ? "approved" : "denied" });
    assert.equal(f.calls.length, 1);
    const [c] = f.calls;
    assert.equal(c.url, "https://auth.privy.io/api/oauth/v2/device_verify");
    assert.equal(c.method, "POST");
    assert.deepEqual(c.headers, { "content-type": "application/json", "privy-app-id": APP, authorization: "Bearer user-token" });
    assert.deepEqual(c.body, { user_code: "ABCD-1234", action });
  }
  await assert.rejects(deviceVerify({ fetch: privy(200, {}), appId: APP, token: "t", userCode: "ABCD-1234", action: "allow" }));
});

test("device_verify answers: expired or used code, signed out, Privy down, an answer that is not success", async () => {
  const run = (f, extra = {}) => deviceVerify({ fetch: f, appId: APP, token: "t", userCode: "ABCD-1234", action: "approve", ...extra });
  assert.deepEqual(await run(privy(400, { error: "invalid_grant" })), { status: "expired" });
  assert.deepEqual(await run(privy(404, {})), { status: "expired" });
  assert.deepEqual(await run(privy(401, {})), { status: "signin" });
  assert.deepEqual(await run(privy(403, {})), { status: "signin" });
  assert.deepEqual(await run(privy(500, {})), { status: "error" });
  assert.deepEqual(await run(privy(0, null, { fail: true })), { status: "error" });
  assert.deepEqual(await run(privy(200, { success: false })), { status: "error" });
  assert.deepEqual(await run(privy(200, "not json", { raw: true })), { status: "error" });
  // No token or no valid code: no call at all.
  const f = privy(200, { success: true });
  assert.deepEqual(await run(f, { token: null }), { status: "signin" });
  assert.deepEqual(await run(f, { userCode: "<b>" }), { status: "expired" });
  assert.equal(f.calls.length, 0);
});

test("times: ISO (the OpenAPI schema) and epoch seconds (the guide) both read; junk is no time", () => {
  assert.equal(when("2026-05-30T12:00:00.000Z").toISOString(), "2026-05-30T12:00:00.000Z");
  assert.equal(when(1717000000).toISOString(), "2024-05-29T16:26:40.000Z");
  assert.equal(when("1717000000").toISOString(), "2024-05-29T16:26:40.000Z");
  assert.equal(when(1717000000000).toISOString(), "2024-05-29T16:26:40.000Z");
  for (const v of [null, undefined, "", "yesterday", 0, -1, NaN, {}]) assert.equal(when(v), null, String(v));
});

test("agents with access: Privy's list, newest first, ids checked; each line says when it was approved and used", async () => {
  const f = privy(200, {
    data: [
      { id: "grant_old", grant_type: "device_code", created_at: 1717000000, last_used_at: 1717003600 },
      { id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", grant_type: "device_code", created_at: "2026-05-30T12:00:00.000Z" },
      { id: "../../users", grant_type: "device_code", created_at: 1 },
      null,
    ],
  });
  const out = await listGrants({ fetch: f, appId: APP, token: "user-token" });
  assert.equal(out.status, "ok");
  assert.deepEqual(out.grants.map((g) => g.id), ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "grant_old"]);
  const [c] = f.calls;
  assert.equal(c.url, "https://auth.privy.io/api/oauth/v2/grants");
  assert.equal(c.method, "GET");
  assert.deepEqual(c.headers, { "privy-app-id": APP, authorization: "Bearer user-token" });
  assert.equal(grantLine(out.grants[0], { timeZone: "America/New_York" }), "Approved May 30, 2026, 8:00 AM · not used yet");
  assert.equal(grantLine(out.grants[1], { timeZone: "America/New_York" }), "Approved May 29, 2024, 12:26 PM · last used May 29, 2024, 1:26 PM");
  assert.equal(grantLine({ id: "x", created: null, lastUsed: null }), "Approved · not used yet");
  assert.deepEqual(await listGrants({ fetch: privy(200, { data: [] }), appId: APP, token: "t" }), { status: "ok", grants: [] });
  for (const [f2, want] of [[privy(401, {}), "signin"], [privy(500, {}), "error"], [privy(200, { nope: 1 }), "error"], [privy(200, "x", { raw: true }), "error"], [privy(0, null, { fail: true }), "error"]])
    assert.equal((await listGrants({ fetch: f2, appId: APP, token: "t" })).status, want);
  assert.deepEqual(await listGrants({ fetch: privy(200, { data: [] }), appId: APP, token: "" }), { status: "signin" });
});

test("revoke: DELETE of that one grant with the person's token; gone already counts as revoked", async () => {
  const f = privy(200, { success: true });
  assert.deepEqual(await revokeGrant({ fetch: f, appId: APP, token: "user-token", id: "grant_abc123" }), { status: "ok" });
  assert.equal(f.calls[0].url, "https://auth.privy.io/api/oauth/v2/grants/grant_abc123");
  assert.equal(f.calls[0].method, "DELETE");
  assert.deepEqual(f.calls[0].headers, { "privy-app-id": APP, authorization: "Bearer user-token" });
  assert.deepEqual(await revokeGrant({ fetch: privy(404, {}), appId: APP, token: "t", id: "grant_abc123" }), { status: "ok" });
  assert.deepEqual(await revokeGrant({ fetch: privy(401, {}), appId: APP, token: "t", id: "grant_abc123" }), { status: "signin" });
  assert.deepEqual(await revokeGrant({ fetch: privy(500, {}), appId: APP, token: "t", id: "grant_abc123" }), { status: "error" });
  assert.deepEqual(await revokeGrant({ fetch: privy(200, { success: false }), appId: APP, token: "t", id: "grant_abc123" }), { status: "error" });
  assert.deepEqual(await revokeGrant({ fetch: privy(0, null, { fail: true }), appId: APP, token: "t", id: "grant_abc123" }), { status: "error" });
  // An id that is not one never becomes a path.
  const g = privy(200, { success: true });
  for (const id of ["../users", "a/b", "", null, "x".repeat(129)]) assert.deepEqual(await revokeGrant({ fetch: g, appId: APP, token: "t", id }), { status: "error" });
  assert.equal(g.calls.length, 0);
});

test("screens: Privy first, then sign-in, then the code; an answer replaces the buttons; nothing approves by itself", () => {
  assert.equal(agentView({ ready: false, authenticated: true, code: "ABCD-1234" }), "loading");
  assert.equal(agentView({ ready: true, authenticated: false, code: "ABCD-1234" }), "signin");
  assert.equal(agentView({ ready: true, authenticated: false, code: "ABCD-1234", result: "approved" }), "signin");
  assert.equal(agentView({ ready: true, authenticated: true, code: "" }), "nocode");
  assert.equal(agentView({ ready: true, authenticated: true, code: "ABCD-1234" }), "confirm");
  for (const r of ["approved", "denied", "expired", "error"]) assert.equal(agentView({ ready: true, authenticated: true, code: "ABCD-1234", result: r }), r);
  assert.equal(agentView({ ready: true, authenticated: true, code: "ABCD-1234", result: "signin" }), "confirm");
});

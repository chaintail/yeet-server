import assert from "node:assert/strict";
import {
  allowedAccount,
  exactOrigin,
  sameOwner,
  boundBrowser,
  refreshFamilyTTL,
  operatorClient,
  chatgptRedirect,
  bindInteraction,
  rateLimiter,
} from "../security-policy.mjs";
{
  // Anonymous interactions cannot lock out sign-in: at capacity the oldest anonymous binding makes room.
  const db = {}, t0 = 1_000_000;
  const ix = (uid, accountId) => ({ uid, exp: (t0 + 3600000) / 1000, prompt: { name: "login" }, session: accountId ? { accountId } : undefined });
  bindInteraction(db, ix("signed", "acct-1"), { token: "tok", id: "acct-1" }, t0, 3);
  bindInteraction(db, ix("anon-1"), null, t0 + 1, 3);
  bindInteraction(db, ix("anon-2"), null, t0 + 2, 3);
  bindInteraction(db, ix("next"), null, t0 + 3, 3);
  assert.deepEqual(Object.keys(db).sort(), ["anon-2", "next", "signed"]);
  // Bindings that carry an identity are never evicted.
  const full = {};
  bindInteraction(full, ix("a", "x"), { token: "t1", id: "x" }, t0, 2);
  bindInteraction(full, ix("b", "y"), { token: "t2", id: "y" }, t0, 2);
  assert.throws(() => bindInteraction(full, ix("c"), null, t0, 2), /Interaction capacity/);
}
{
  let t = 0;
  const allow = rateLimiter({ perClient: 2, global: 5, now: () => t });
  assert.deepEqual([allow("a"), allow("a"), allow("a")], [true, true, false]);
  assert.ok(allow("b") && allow("b") && allow("c"));
  assert.equal(allow("d"), false, "global ceiling");
  t = 60000;
  assert.ok(allow("a"), "new window");
}
assert.ok(chatgptRedirect("https://chatgpt.com/connector_platform_oauth_redirect"));
for (const uri of [
  undefined,
  "",
  "https://attacker.example/cb",
  "https://chatgpt.com.attacker.example/cb",
  "https://attacker.example/https://chatgpt.com/",
  "http://chatgpt.com/cb",
  "https://chatgpt.com:8443/cb",
  "https://user@chatgpt.com/cb",
  "https://sub.chatgpt.com/cb",
])
  assert.equal(chatgptRedirect(uri), false, String(uri));
const policy = { eligible: true, clients: { blocked: true } };
assert.ok(allowedAccount(policy, { privy: true, client: "ok" }));
for (const p of [
  undefined,
  { eligible: false },
  { ...policy, suspended: true },
])
  assert.equal(allowedAccount(p, { privy: true }), false);
assert.equal(allowedAccount(policy, { privy: true, client: "blocked" }), false);
for (const origin of [
  undefined,
  "null",
  "https://evil.example",
  "https://lab.example.evil",
])
  assert.equal(exactOrigin(origin, "https://lab.example"), false);
assert.ok(exactOrigin("https://lab.example", "https://lab.example/path"));
assert.equal(sameOwner({ id: "a" }, "b"), false);
assert.ok(
  boundBrowser(
    { token: "browser-a", account: "a" },
    { token: "browser-a", id: "a" },
    "a",
  ),
);
for (const session of [
  null,
  { token: "browser-b", id: "a" },
  { token: "browser-a", id: "b" },
])
  assert.equal(
    boundBrowser({ token: "browser-a", account: "a" }, session, "a"),
    false,
  );
assert.equal(boundBrowser(null, null, "a"), false);
const now = Math.floor(Date.now() / 1000);
assert.equal(refreshFamilyTTL(null, { iiat: now - 500 }), 100);
assert.equal(refreshFamilyTTL(null, { iiat: now - 601 }), 0);
assert.throws(() => refreshFamilyTTL(null, { iiat: now + 1 }));
assert.throws(() => refreshFamilyTTL(null, {}));
console.log(
  "PASS eligibility, exact Origin, browser binding and absolute refresh family policy",
);

for (const value of [
  undefined,
  null,
  "",
  " ",
  "\t",
  "local-chatgpt-fixture",
  "x".repeat(2049),
  "client\u0000",
]) {
  assert.equal(operatorClient(value, { privy: true }), undefined);
}
assert.equal(
  operatorClient("https://chatgpt.com/oauth/client.json", { privy: true }),
  "https://chatgpt.com/oauth/client.json",
);
assert.equal(operatorClient(undefined), "local-chatgpt-fixture");
assert.equal(
  operatorClient("local-chatgpt-fixture", { privy: true, test: true }),
  "local-chatgpt-fixture",
);
console.log(
  "PASS explicit bounded Privy operator client, fixture gate, native mock default",
);

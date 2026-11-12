import assert from "node:assert/strict";
import {
  allowedAccount,
  exactOrigin,
  sameOwner,
  boundBrowser,
  refreshFamilyTTL,
  operatorClient,
} from "../security-policy.mjs";
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

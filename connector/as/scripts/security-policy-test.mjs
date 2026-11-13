import assert from "node:assert/strict";
import {
  allowedAccount,
  exactOrigin,
  sameOwner,
  boundBrowser,
  refreshFamilyTTL,
  operatorClient,
  chatgptRedirect,
  registrationRequest,
  configuredRefreshWindow,
  REFRESH_WINDOW_MAX,
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
assert.ok(chatgptRedirect("https://chatgpt.com/connector/oauth/AbC_12-x"));
for (const uri of [
  undefined,
  "",
  "https://chatgpt.com/",
  "https://chatgpt.com/some/other/path",
  "https://chatgpt.com/connector_platform_oauth_redirect/",
  "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
  "https://chatgpt.com/connector_platform_oauth_redirect#x",
  "https://CHATGPT.com/connector_platform_oauth_redirect",
  "https://chatgpt.com:443/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/",
  "https://chatgpt.com/connector/oauth/a/b",
  "https://chatgpt.com/connector/oauth/a?b=1",
  "https://chatgpt.com/connector/oauth/a%2Fb",
  "https://chatgpt.com/connector/oauth/" + "a".repeat(129),
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
// The family window is absolute from the first refresh token (iiat), up to 7 days.
assert.equal(REFRESH_WINDOW_MAX, 604800);
assert.equal(configuredRefreshWindow("604800"), 604800);
assert.equal(configuredRefreshWindow("14400"), 14400);
assert.equal(configuredRefreshWindow(undefined), 600);
for (const bad of ["604801", "599", "", "7d", "1e6"]) assert.throws(() => configuredRefreshWindow(bad), /refresh family window/, bad);
assert.equal(refreshFamilyTTL(null, { iiat: now - 86400 }, 604800), 604800 - 86400);
assert.equal(refreshFamilyTTL(null, { iiat: now - 604800 }, 604800), 0);
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
{
  // Registration: every redirect URI must be one of ChatGPT's documented connector redirect URIs, exactly.
  const stable = "https://chatgpt.com/connector_platform_oauth_redirect";
  const ok = registrationRequest({ redirect_uris: [stable], token_endpoint_auth_method: "none" });
  assert.deepEqual(ok, { body: { redirect_uris: [stable], token_endpoint_auth_method: "none" } });
  assert.ok(registrationRequest({ redirect_uris: [stable, "https://chatgpt.com/connector/oauth/cb1"] }).body);
  // No method given: registered as a public client, never client_secret_basic.
  assert.equal(registrationRequest({ redirect_uris: [stable] }).body.token_endpoint_auth_method, "none");
  assert.equal(registrationRequest({ redirect_uris: [stable], token_endpoint_auth_method: "private_key_jwt" }).body.token_endpoint_auth_method, "private_key_jwt");
  for (const method of ["client_secret_basic", "client_secret_post", "client_secret_jwt", "tls_client_auth", 7, null])
    assert.equal(registrationRequest({ redirect_uris: [stable], token_endpoint_auth_method: method }).problem?.error, method === null ? undefined : "invalid_client_metadata", String(method));
  for (const uris of [
    ["https://evil.example/cb"],
    ["https://chatgpt.com.evil.example/cb"],
    ["http://localhost:3000/cb"],
    ["http://chatgpt.com/cb"],
    ["https://user:pw@chatgpt.com/cb"],
    ["https://chatgpt.com/some/other/path"],
    ["https://chatgpt.com/a", "https://chatgpt.com/b"],
    [stable, "https://evil.example/cb"],
    [42],
    [],
    stable,
    undefined,
  ])
    assert.equal(registrationRequest({ redirect_uris: uris }).problem?.error, "invalid_redirect_uri", JSON.stringify(uris));
  assert.equal(registrationRequest(undefined).problem?.error, "invalid_redirect_uri");
  console.log("PASS registration accepts only ChatGPT's exact redirect URIs and public or private_key_jwt clients");
}

import assert from "node:assert/strict";
import { AS, RESOURCE } from "#shared/common.mjs";
import { validatePrincipal } from "#shared/introspection.mjs";
const token = {
  active: true,
  iss: AS,
  aud: RESOURCE,
  exp: Date.now() / 1000 + 300,
  sub: "yeet-privy-synthetic",
  client_id: "client",
  scope: "yeet:read yeet:trade other:scope",
};
const principal = validatePrincipal(token);
assert.equal(principal.subject, token.sub);
assert.deepEqual([...principal.scopes], ["yeet:read", "yeet:trade"]);
for (const delta of [
  { sub: "folio-privy-synthetic" },
  { sub: "arbitrary" },
  { sub: "yeet-privy-" },
  { sub: "yeet-privy-" + "x".repeat(81) },
  { client_id: "x".repeat(2049) },
  { active: false },
  { iss: "wrong" },
  { aud: "wrong" },
  { exp: 0 },
  { client_id: "" },
])
  assert.throws(() => validatePrincipal({ ...token, ...delta }));
console.log(
  "PASS yeet-privy principal shape, scope filter, tenant/issuer/audience/expiry negatives; authoritative core eligibility remains separately required",
);

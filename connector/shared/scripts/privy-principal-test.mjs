import assert from "node:assert/strict";
import { AS, RESOURCE } from "#shared/common.mjs";
import { validatePrincipal } from "#shared/introspection.mjs";
const token = {
  active: true,
  iss: AS,
  aud: RESOURCE,
  exp: Date.now() / 1000 + 300,
  sub: "folio-privy-synthetic",
  client_id: "client",
  scope: "folio:profile:read",
};
process.env.PRIVY_LOGIN = "0";
assert.throws(() => validatePrincipal(token));
assert.equal(
  validatePrincipal({ ...token, sub: "folio-alice" }).subject,
  "folio-alice",
);
process.env.PRIVY_LOGIN = "1";
assert.equal(validatePrincipal(token).subject, token.sub);
for (const delta of [
  { sub: "folio-alice" },
  { sub: "arbitrary" },
  { sub: "folio-privy-" },
  { sub: "folio-privy-" + "x".repeat(81) },
  { active: false },
  { iss: "wrong" },
  { aud: "wrong" },
  { exp: 0 },
  { client_id: "" },
])
  assert.throws(() => validatePrincipal({ ...token, ...delta }));
console.log(
  "PASS isolated Privy principal shape, tenant/issuer/audience/expiry negatives; authoritative core eligibility remains separately required",
);

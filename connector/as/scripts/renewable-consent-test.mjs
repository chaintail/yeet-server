import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "renewable-"));
process.env.RESOURCE = "https://chatgpt.yeet.win";
process.env.TEST_PROFILE = "1";
process.env.REFRESH_CONSENT_COMPAT = "1";
const { recordConsent, renewableHooks } =
  await import("../renewable-consent.mjs");
const client = {
  clientId: "local-chatgpt-fixture",
  grantTypeAllowed: () => true,
};
const ctx = { oidc: { client } };
const source = {
  clientId: client.clientId,
  accountId: "yeet-privy-a",
  grantId: "grant-a",
  resource: process.env.RESOURCE,
  scopes: new Set(["openid", "yeet:read"]),
};
let active = true;
const hooks = renewableHooks({
  eligible: async () => active,
  validGrant: async () => active,
});
assert.equal(await hooks.issueRefreshToken(ctx, client, source), false);
assert.equal(await hooks.expiresWithSession(ctx, source), true);
recordConsent({
  grantId: source.grantId,
  accountId: source.accountId,
  clientId: source.clientId,
  resource: source.resource,
  scopes: [...source.scopes],
});
assert.equal(await hooks.issueRefreshToken(ctx, client, source), true);
assert.equal(await hooks.expiresWithSession(ctx, source), false);
for (const delta of [
  { accountId: "other" },
  { resource: "https://wrong.example" },
  { scopes: new Set(["yeet:trade"]) },
  { grantId: "missing" },
  { clientId: "other" },
])
  assert.equal(
    await hooks.issueRefreshToken(ctx, client, { ...source, ...delta }),
    false,
  );
assert.throws(
  () =>
    recordConsent({
      grantId: source.grantId,
      accountId: "other",
      clientId: source.clientId,
      resource: source.resource,
      scopes: [...source.scopes],
    }),
  /Conflicting/,
);
active = false;
assert.equal(await hooks.issueRefreshToken(ctx, client, source), false);
assert.equal(await hooks.expiresWithSession(ctx, source), true);
active = true;
process.env.REFRESH_CONSENT_COMPAT = "0";
assert.equal(await hooks.issueRefreshToken(ctx, client, source), false);
assert.equal(await hooks.expiresWithSession(ctx, source), true);
assert.equal(
  await hooks.issueRefreshToken(ctx, client, {
    ...source,
    scopes: new Set(["offline_access"]),
  }),
  true,
);
{
  // The window in force when the person consents is stored with the grant: 7 days with the compose default, and a
  // later change of REFRESH_FAMILY_TTL never stretches or shortens an existing family.
  const { consentRefreshWindow } = await import("../renewable-consent.mjs");
  const { refreshFamilyTTL } = await import("../security-policy.mjs");
  process.env.REFRESH_CONSENT_COMPAT = "1";
  process.env.REFRESH_FAMILY_TTL = "604800";
  const week = { ...source, grantId: "grant-week", scopes: ["openid", "offline_access", "yeet:read"] };
  recordConsent(week);
  const token = { grantId: week.grantId, accountId: week.accountId, clientId: week.clientId, resource: week.resource };
  assert.equal(consentRefreshWindow(token), 604800);
  process.env.REFRESH_FAMILY_TTL = "14400";
  assert.equal(consentRefreshWindow(token), 604800);
  const now = Math.floor(Date.now() / 1000);
  // Six days and 23 hours after the first refresh token, a rotated token still has an hour left.
  assert.equal(refreshFamilyTTL(null, { iiat: now - (604800 - 3600) }, consentRefreshWindow(token)), 3600);
  // Grants without a consent record keep the 10-minute default.
  assert.equal(consentRefreshWindow({ ...token, grantId: "no-record" }), 600);
  delete process.env.REFRESH_FAMILY_TTL;
}
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
console.log(
  "PASS immutable consent binding, native flag-off defaults, missing/unchecked consent, eligibility and scope/resource/account/client bounds",
);

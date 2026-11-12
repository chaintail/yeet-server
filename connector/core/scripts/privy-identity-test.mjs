import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, SignJWT } from "jose";
process.env.PRIVY_APP_ID = "synthetic-test-app";
process.env.PRIVY_JWKS_URL =
  "https://auth.privy.io/api/v1/apps/synthetic-test-app/jwks.json";
const { verifiedPrivy } = await import("#shared/privy-identity.mjs");
const { privateKey, publicKey } = await generateKeyPair("ES256");
const now = Math.floor(Date.now() / 1000);
const token = (claims = {}) =>
  new SignJWT({ sid: "synthetic-session", ...claims })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(claims.iss || "privy.io")
    .setAudience(claims.aud || process.env.PRIVY_APP_ID)
    .setSubject(claims.sub || "did:privy:test-alice")
    .setIssuedAt(claims.iat ?? now)
    .setExpirationTime(claims.exp ?? now + 3600)
    .sign(privateKey);
const good = await verifiedPrivy(await token(), { verificationKey: publicKey });
assert.deepEqual(good, {
  provider: "privy.io",
  app_id: "synthetic-test-app",
  did: "did:privy:test-alice",
});
for (const claims of [
  { iss: "wrong" },
  { aud: "wrong" },
  { sub: "wallet-address" },
  { iat: now + 100 },
  { exp: now - 1 },
  { iat: now - 8000 },
  { exp: now + 10000 },
])
  await assert.rejects(
    verifiedPrivy(await token(claims), { verificationKey: publicKey }),
  );
const wrong = await generateKeyPair("ES256");
await assert.rejects(
  verifiedPrivy(await token(), { verificationKey: wrong.publicKey }),
);
await assert.rejects(
  verifiedPrivy("x".repeat(17000), { verificationKey: publicKey }),
);
const rsa = await generateKeyPair("RS256");
const algorithmToken = await new SignJWT({ sid: "test" })
  .setProtectedHeader({ alg: "RS256", typ: "JWT" })
  .setIssuer("privy.io")
  .setAudience(process.env.PRIVY_APP_ID)
  .setSubject("did:privy:test-alice")
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(rsa.privateKey);
await assert.rejects(
  verifiedPrivy(algorithmToken, { verificationKey: rsa.publicKey }),
);
const state = mkdtempSync(path.join(os.tmpdir(), "yeet-privy-test-"));
process.env.STATE_DIR = state;
process.env.YEET_MAX_ACCOUNTS = "2";
const { initializeIdentityStore, resolveIdentity, account, accountCount, maxAccounts } =
  await import("../identity-store.mjs");
assert.equal(resolveIdentity(good), undefined, "nothing resolves before the store is initialized");
assert.throws(() => initializeIdentityStore({ app: "x" }), /identity app/);
initializeIdentityStore({ app: process.env.PRIVY_APP_ID });
// First verified sign-in creates the account; later sign-ins return the same stable id.
const alice = resolveIdentity(good);
assert.match(alice, /^yeet-privy-[a-zA-Z0-9_-]{22}$/);
assert.equal(resolveIdentity(good), alice);
assert.deepEqual(Object.keys(account(alice)), ["id", "created_at"]);
assert.equal(accountCount(), 1);
// Wrong app, malformed DIDs and other providers never create or reach an account.
for (const value of [
  { ...good, app_id: "different-app" },
  { ...good, provider: "other" },
  { ...good, did: "wallet-address" },
  null,
])
  assert.equal(resolveIdentity(value), undefined);
assert.equal(accountCount(), 1);
const bob = resolveIdentity({ ...good, did: "did:privy:test-bob" });
assert.notEqual(bob, alice);
// The cap (YEET_MAX_ACCOUNTS=2) stops new accounts; existing people still sign in.
assert.equal(resolveIdentity({ ...good, did: "did:privy:test-carol" }), undefined);
assert.equal(resolveIdentity(good), alice);
assert.equal(accountCount(), 2);
assert.equal(account("yeet-privy-unknown"), undefined);
assert.equal(account("folio-privy-x"), undefined);
// Accounts are bound to the identity app: another app id sees none of them.
initializeIdentityStore({ app: "another-synthetic-app" });
assert.equal(account(alice), undefined);
for (const bad of ["0", "-1", "1.5", "x", "2000000"])
  assert.throws(() => maxAccounts(bad), /YEET_MAX_ACCOUNTS/);
assert.equal(maxAccounts(""), 200);
rmSync(state, { recursive: true, force: true });
console.log(
  "PASS Privy ES256/claims negatives; account created on first verified sign-in, stable, app-bound and capped by YEET_MAX_ACCOUNTS",
);

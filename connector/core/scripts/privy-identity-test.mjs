import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
const state = mkdtempSync(path.join(os.tmpdir(), "folio-privy-test-"));
process.env.STATE_DIR = state;
process.env.PRIVY_ELIGIBLE_FILE = path.join(state, "eligible.json");
const entries = ["alice", "bob"].map((name, i) => ({
  provider: "privy.io",
  app_id: process.env.PRIVY_APP_ID,
  did: `did:privy:test-${name}`,
  account_id: `folio-privy-${name}`,
  portfolio: [{ symbol: i ? "MSFT" : "AAPL", quantity: i ? 20 : 10 }],
}));
writeFileSync(process.env.PRIVY_ELIGIBLE_FILE, JSON.stringify(entries));
const { initializeIdentityStore, resolveIdentity, account } =
  await import("../identity-store.mjs");
initializeIdentityStore();
assert.equal(resolveIdentity(good), "folio-privy-alice");
assert.equal(resolveIdentity(good), "folio-privy-alice");
assert.equal(resolveIdentity({ ...good, did: "did:privy:unknown" }), undefined);
assert.equal(resolveIdentity({ ...good, app_id: "different-app" }), undefined);
assert.deepEqual(account("folio-privy-bob").portfolio, [
  { symbol: "MSFT", quantity: 20 },
]);
assert.equal(account("folio-alice"), undefined);
for (const invalid of [
  [entries[0], entries[0]],
  [entries[0], { ...entries[1], account_id: entries[0].account_id }],
]) {
  writeFileSync(process.env.PRIVY_ELIGIBLE_FILE, JSON.stringify(invalid));
  assert.throws(initializeIdentityStore, /Duplicate/);
}
writeFileSync(
  process.env.PRIVY_ELIGIBLE_FILE,
  JSON.stringify(
    entries.map((e) => ({ ...e, account_id: "folio-privy-remapped" })),
  ),
);
assert.throws(initializeIdentityStore, /remapping/);
rmSync(state, { recursive: true, force: true });
console.log(
  "PASS Privy ES256/claims negatives and stable allowlisted two-account mapping",
);

import assert from "node:assert/strict";
import {
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
process.env.PRIVY_APP_ID = "synthetic-test-app";
process.env.PRIVY_JWKS_URL =
  "https://auth.privy.io/api/v1/apps/synthetic-test-app/jwks.json";
const { verifiedPrivy } = await import("#shared/privy-identity.mjs");
const keys = await Promise.all([
  generateKeyPair("ES256"),
  generateKeyPair("ES256"),
]);
const jwks = await Promise.all(
  keys.map(async (k, i) => ({
    ...(await exportJWK(k.publicKey)),
    kid: String(i),
    alg: "ES256",
    use: "sig",
  })),
);
let current = 0,
  outage = false,
  calls = 0;
const resolver = createRemoteJWKSet(new URL(process.env.PRIVY_JWKS_URL), {
  cooldownDuration: 0,
  cacheMaxAge: 1,
  [customFetch]: async () => {
    calls++;
    if (outage) throw Error("Synthetic outage");
    return Response.json({ keys: [jwks[current]] });
  },
});
const now = Math.floor(Date.now() / 1000);
async function signed(i, { typ = "JWT", expiry = true } = {}) {
  let jwt = new SignJWT({ sid: "synthetic-session" })
    .setProtectedHeader({ alg: "ES256", kid: String(i), typ })
    .setIssuer("privy.io")
    .setAudience(process.env.PRIVY_APP_ID)
    .setSubject("did:privy:test-alice")
    .setIssuedAt(now);
  if (expiry) jwt = jwt.setExpirationTime(now + 3600);
  return jwt.sign(keys[i].privateKey);
}
await verifiedPrivy(await signed(0), { verificationKey: resolver });
current = 1;
await verifiedPrivy(await signed(1), { verificationKey: resolver });
assert.ok(calls >= 2);
await assert.rejects(
  verifiedPrivy(await signed(1, { typ: "wrong" }), {
    verificationKey: keys[1].publicKey,
  }),
);
await assert.rejects(
  verifiedPrivy(await signed(1, { expiry: false }), {
    verificationKey: keys[1].publicKey,
  }),
);
outage = true;
const uncached = createRemoteJWKSet(new URL(process.env.PRIVY_JWKS_URL), {
  [customFetch]: async () => {
    throw Error("Synthetic outage");
  },
});
await assert.rejects(
  verifiedPrivy(await signed(1), { verificationKey: uncached }),
);
console.log(
  "PASS trusted JWKS rotation, outage fail closed, JWT type and missing expiry",
);

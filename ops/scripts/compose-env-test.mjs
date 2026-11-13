// Every setting a service's code reads reaches that service: ops/compose.yml passes it in `environment`, the
// service's env_file carries it (secrets), or the image sets it. Catches a deploy that needs a hand-added line.
// Run: node ops/scripts/compose-env-test.mjs (no Docker needed).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const connector = path.join(repo, "connector");
const compose = fs.readFileSync(path.join(repo, "ops/compose.yml"), "utf8");

// environment names per service, from the compose file's `  <service>:` blocks.
function composeEnv() {
  const out = {};
  let service = null, inEnv = false, inServices = false;
  for (const line of compose.split("\n")) {
    if (/^\S/.test(line)) inServices = /^services:\s*$/.test(line);
    if (!inServices) { service = null; continue; }
    const svc = /^  ([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (svc) { service = svc[1]; out[service] = new Set(); inEnv = false; continue; }
    if (/^\S/.test(line)) { service = null; inEnv = false; continue; }
    if (!service) continue;
    if (/^    environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (/^    \S/.test(line)) { inEnv = false; continue; }
    const kv = inEnv && /^      ([A-Z][A-Z0-9_]*):/.exec(line);
    if (kv) out[service].add(kv[1]);
  }
  return out;
}

function sources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "scripts", "viewer", "dist"].includes(entry.name)) files.push(...sources(p));
    } else if (/\.mjs$/.test(entry.name) && !/test|fakes|fixture/.test(entry.name)) files.push(p);
  }
  return files;
}
// process.env.X, env.X, env['X'], and a name passed to a reader helper: amount('YEET_X'), usdcEnv(env,'YEET_X'),
// publicId("YEET_X"), v('PRIVY_X'). Error constructors are not readers.
const NAME = /(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)|\benv\[['"]([A-Z][A-Z0-9_]+)['"]\]|\b(?!\w*Error\()[A-Za-z_]\w*\(\s*(?:env\s*,\s*)?['"]((?:YEET|PRIVY|ONECLICK|REFRESH)_[A-Z0-9_]+)['"]/g;
function readNames(dirs) {
  const names = new Set();
  for (const dir of dirs)
    for (const file of sources(path.join(connector, dir)))
      for (const m of fs.readFileSync(file, "utf8").matchAll(NAME)) names.add(m[1] || m[2] || m[3]);
  return names;
}

// Set inside the image or by the compose file outside `environment`, or used only by tests and local runs.
const IN_IMAGE = ["LISTEN_HOST", "SECRETS_DIR", "AS_PORT", "ADMIN_PORT", "CONNECTOR_PORT", "CORE_PORT", "TRADE_DB", "NODE_ENV", "YEET_SERVER_COMMIT"];
// Secret values: only from /var/lib/yeet-connector/config/<role>.env (env_file), never in compose.
const SECRETS = {
  core: ["PRIVY_APP_SECRET", "YEET_PRIVY_AUTHORIZATION_KEY", "ONECLICK_JWT", "YEET_XP_SECRET"],
  as: [],
  mcp: [],
};
// Read only by operator scripts run by hand (policy setup), never by the running service.
const OPERATOR_ONLY = { core: ["YEET_POLICY_ADMIN_QUORUM_ID"], as: [], mcp: [] };

const roles = { as: ["as", "shared"], core: ["core", "shared"], mcp: ["mcp", "shared"] };
const env = composeEnv();
for (const [role, dirs] of Object.entries(roles)) {
  const passed = env[role];
  assert.ok(passed?.size, `compose service ${role} has an environment block`);
  const missing = [...readNames(dirs)].filter(
    (n) => !passed.has(n) && !IN_IMAGE.includes(n) && !SECRETS[role].includes(n) && !OPERATOR_ONLY[role].includes(n),
  );
  // shared/ is read by every role; a name only some roles need is listed here.
  const sharedOnly = { mcp: ["PRIVY_APP_ID", "PRIVY_JWKS_URL", "DEV_IDENTITY_STUB", "TEST_PROFILE", "STATE_DIR", "SECRETS_DIR"], core: ["PUBLIC_MODE", "DEV_IDENTITY_STUB", "TEST_PROFILE", "CORE_INTERNAL"], as: ["AS_INTERNAL"] };
  const real = missing.filter((n) => !sharedOnly[role].includes(n));
  assert.deepEqual(real, [], `${role} reads names compose does not pass: ${real.join(", ")}`);
  for (const s of SECRETS[role]) assert.ok(!passed.has(s), `${role}: secret ${s} must come from env_file, not compose`);
}
// Decision (b): the sign-in server publishes no signer id (no addSigners step). Core keeps YEET_PRIVY_KEY_QUORUM_ID
// only to report wallets that still carry the old signer (ops/remove-yeet-signer.mjs removes it).
assert.ok(!env.as.has("YEET_SIGNER_ID"));
assert.ok(env.core.has("YEET_PRIVY_KEY_QUORUM_ID"));
console.log(`PASS compose passes every setting each service reads (${Object.keys(roles).join(", ")})`);

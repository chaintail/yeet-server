// Card signing (yeet-win docs/CARD-SIGNING.md): the person signs a trade with their own Privy embedded wallet, inside
// the ChatGPT card or on the first-party page /sign. One place for what the tool server (connector/mcp), the sign-in server (which
// serves the signer script and the page) and the tests must agree on:
//   - the signer script: vendor/yeet-win/widget/yeet-signer.js (yeet-win packages/widget/scripts/build-signer.mjs),
//     served at /cards/yeet-signer-<sha256:12>.js (content hash in the path: cached for a year, never stale);
//   - the card's `_meta['yeet/signer']` = {privy_app_id, script_url, sign_page_url};
//   - the frame domains a signing card declares: Privy's frame domains and the connector
//     origin.
// The Privy app id is public configuration (PRIVY_APP_ID, the same name the sign-in server and core read). No secret.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const SIGNER_META_KEY = 'yeet/signer';
export const SIGN_PAGE_PATH = '/sign';
export const SIGNER_PATH_PREFIX = '/cards/yeet-signer';
/** The cards that load the person's wallet in the card: the overview (the device sign-in), and those that hold a YEET or
 * SKEET button (basket; portfolio opens a SKEET basket in place; the lucky wheel opens its YEET basket in place) or
 * follow a trade. */
export const SIGNING_VIEWS = Object.freeze(['overview', 'basket', 'portfolio', 'receipt', 'lucky']);
export const PRIVY_AUTH = 'https://auth.privy.io';
export const PRIVY_API = 'https://api.privy.io';
/** The card accepts an app id only in this shape (yeet-win src/yeet-card.js takeSigner). */
export const APP_ID = /^[a-z0-9]{10,40}$/i;

export const SIGNER_FILE = new URL('../vendor/yeet-win/widget/yeet-signer.js', import.meta.url);
let cached;
/** The vendored signer: {bytes, hash (12 hex of sha256), path}, or null when it is not vendored. Read once. */
export function signerAsset(file = SIGNER_FILE) {
  if (file === SIGNER_FILE && cached !== undefined) return cached;
  let out = null;
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 0) {
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      out = Object.freeze({bytes, hash, path: `${SIGNER_PATH_PREFIX}-${hash}.js`});
    }
  } catch { out = null; }
  if (file === SIGNER_FILE) cached = out;
  return out;
}

/** The public https origin the connector is reached at (RESOURCE is the bare origin in production), or null. */
export function publicOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

/**
 * Where a card finds its signer, or null when signing is not configured here (no https origin, no valid Privy app id
 * or no vendored signer). Without it the card keeps its pre-signing behaviour.
 */
export function signerMeta({origin, appId, asset = signerAsset()} = {}) {
  const o = publicOrigin(origin);
  if (!o || typeof appId !== 'string' || !APP_ID.test(appId) || !asset) return null;
  return {privy_app_id: appId, script_url: `${o}${asset.path}`, sign_page_url: `${o}${SIGN_PAGE_PATH}`};
}
/** signerMeta from the environment: RESOURCE (the connector's public URL) and PRIVY_APP_ID. */
export const signerMetaFromEnv = (env = process.env, asset = signerAsset()) => signerMeta({origin: env.RESOURCE, appId: env.PRIVY_APP_ID, asset});

/**
 * The domains a signing card declares (yeet-win packages/widget/index.mjs signingCsp, CARD-SIGNING.md section 3):
 *   connect: Privy auth + wallet API, the connector   resource: the connector (the signer script)
 *   frame: Privy's wallet iframe, the connector       redirect: the connector (openExternal to the signing page)
 */
export function signingCsp(origin) {
  const o = new URL(origin).origin;
  return {connect: [PRIVY_AUTH, PRIVY_API, o], resource: [o], frame: [PRIVY_AUTH, o], redirect: [o]};
}

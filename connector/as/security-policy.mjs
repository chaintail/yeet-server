import { classOfRedirects } from "#shared/agent-route.mjs";
// Provider hooks retain native issuance/rotation; application checks fail closed.
export function allowedAccount(
  policy,
  { privy = false, known = false, client } = {},
) {
  return (
    !!policy &&
    (privy ? policy.eligible === true : known) &&
    !policy.suspended &&
    !(client && policy.clients?.[client])
  );
}
// Operator mutations may restore an existing account's eligibility. Older lab
// cores expose only eligible; retain that stricter fallback, never infer existence.
export function operatorAccountExists(policy) {
  return !!policy && (Object.hasOwn(policy, 'exists')
    ? policy.exists === true : policy.eligible === true);
}
export function exactOrigin(origin, base) {
  return origin === new URL(base).origin;
}
// Public deployments only authorize ChatGPT. Redirect URIs are compared as exact strings against the ones OpenAI
// documents for connectors (developers.openai.com/apps-sdk/build/auth, "Redirect URIs"): the stable
// https://chatgpt.com/connector_platform_oauth_redirect, which ChatGPT uses with servers that support RFC 9207 issuer
// identification (this one does), and the callback-ID form https://chatgpt.com/connector/oauth/{callback_id} that it
// uses with other servers. ChatGPT's client metadata document (https://chatgpt.com/oauth/client.json) lists only the
// stable URI.
export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
export function chatgptRedirect(uri) {
  return typeof uri === "string" && (uri === CHATGPT_REDIRECT_URI || CHATGPT_CALLBACK_REDIRECT.test(uri));
}
/** The client's class from its redirect URIs alone (shared/agent-route.mjs): 'chatgpt', 'agent' or null. */
export const clientClass = (uris) => classOfRedirects(uris, chatgptRedirect);
// Token endpoint authentication a registered client may ask for: what ChatGPT's metadata lists (none for PKCE
// public clients, private_key_jwt for signed assertions). Shared-secret methods are kept for the two internal
// introspection clients only and are never handed to a registered client.
export const CLIENT_AUTH_METHODS = ["none", "private_key_jwt"];
// Dynamic registration (POST /reg) stores a client only when every redirect_uris entry passes chatgptRedirect and
// its token endpoint authentication is one of CLIENT_AUTH_METHODS, so nobody can fill the sign-in server's state with
// clients that the authorization step would refuse anyway. A request without token_endpoint_auth_method is
// registered as a public client ("none"): the RFC 7591 default (client_secret_basic) is not offered, and the
// registration answer tells the client which method it got.
// Returns { problem } with the OAuth error answer, or { body } with the registration to store.
// With the agent route on (shared/agent-route.mjs, `agent: true`) a client whose redirect URIs are all a local agent's
// (http on a loopback address) registers too, as class agent; a list that mixes ChatGPT's and others is
// refused either way.
export function registrationRequest(body, { agent = false } = {}) {
  const uris = body?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10)
    return { problem: { error: "invalid_redirect_uri", error_description: agent ? "redirect_uris must list 1 to 10 redirect URIs" : "redirect_uris must list ChatGPT redirect URIs" } };
  if (agent ? !clientClass(uris) : !uris.every(chatgptRedirect))
    return { problem: { error: "invalid_redirect_uri", error_description: agent ? "redirect URIs must be all ChatGPT's connector redirects, or all loopback http callbacks of an agent" : "only ChatGPT's connector redirect URIs can be registered" } };
  const method = body.token_endpoint_auth_method ?? "none";
  if (!CLIENT_AUTH_METHODS.includes(method))
    return { problem: { error: "invalid_client_metadata", error_description: "token_endpoint_auth_method must be none or private_key_jwt" } };
  return { body: { ...body, token_endpoint_auth_method: method } };
}
export function sameOwner(existing, id) {
  return !existing || existing.id === id;
}
export function boundBrowser(binding, session, account) {
  if (!binding) return false;
  if (binding.token && binding.token !== session?.token) return false;
  return (
    (!binding.account || binding.account === account) &&
    sameOwner(session, account)
  );
}
// REFRESH_FAMILY_TTL is the absolute lifetime of one refresh token family: oidc-provider carries the first refresh
// token's issue time (iiat) through every rotation, and refreshFamilyTTL below gives each rotated token only what is
// left of iiat + window. Using the connection does not extend it; when it runs out, ChatGPT has to connect again.
// Upper bound: 7 days. Rotation with reuse detection, the per-refresh consent, grant and eligibility checks, and the
// 5-minute access tokens stay in force for the whole window.
export const REFRESH_WINDOW_MAX = 7 * 24 * 3600;
export function configuredRefreshWindow(value = process.env.REFRESH_FAMILY_TTL) {
  const seconds = value === undefined ? 600 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 600 || seconds > REFRESH_WINDOW_MAX)
    throw Error("Invalid refresh family window");
  return seconds;
}
export class AuthorizationExpired extends Error {}
export function requireFreshBinding(binding, now = Date.now()) {
  if (!binding || !Number.isSafeInteger(binding.expires) || binding.expires <= now)
    throw new AuthorizationExpired("Authorization expired");
  return binding;
}
export const BINDING_CAPACITY = 2000;
const anonymous = (row) => !row.token && !row.account;
export function bindInteraction(db, interaction, session, now = Date.now(), capacity = BINDING_CAPACITY) {
  if (db[interaction.uid]) requireFreshBinding(db[interaction.uid], now);
  // Retain expired bindings until their provider interaction is gone: a reload
  // must not turn a ten-minute authorization into a fresh authorization.
  for (const [key, row] of Object.entries(db))
    if ((row.retainUntil ?? row.expires + 3600000) <= now) delete db[key];
  if (!db[interaction.uid]) {
    // At capacity, the oldest binding with no browser session and no account
    // makes room (an unauthenticated GET must not lock everyone out); bindings
    // that carry an identity are never evicted.
    while (Object.keys(db).length >= capacity) {
      const oldest = Object.entries(db)
        .filter(([, row]) => anonymous(row))
        .sort(([, a], [, b]) => a.expires - b.expires)[0];
      if (!oldest) throw Error("Interaction capacity");
      delete db[oldest[0]];
    }
    db[interaction.uid] = {
      token: session?.token || null,
      account: interaction.prompt?.name === 'login' &&
        interaction.prompt.reasons?.includes('account_unavailable')
        ? session?.id || null : interaction.session?.accountId || null,
      expires: now + 600000,
      retainUntil: Math.max(now + 600000, interaction.exp * 1000 || now + 3600000),
    };
  }
  return db[interaction.uid];
}
export function refreshFamilyTTL(_ctx, token, window = 600) {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(token.iiat) || token.iiat > now)
    throw Error("Invalid refresh family issuance");
  configuredRefreshWindow(window);
  return Math.max(0, token.iiat + window - now);
}

// An operator must target the actual client; public Privy has no fixture default.
export function operatorClient(value, { privy = false, test = false } = {}) {
  const client =
    value === undefined && !privy ? "local-chatgpt-fixture" : value;
  if (
    typeof client !== "string" ||
    client.length === 0 ||
    client.length > 2048 ||
    /[\s\u0000-\u001f\u007f]/u.test(client)
  )
    return undefined;
  if (privy && !test && client === "local-chatgpt-fixture") return undefined;
  return client;
}

// Fixed-window rate limit keyed by client address, under a process-wide
// ceiling. Returns true when the request may proceed.
export function rateLimiter({ perClient, global, windowMs = 60000, now = Date.now }) {
  let start = now(), total = 0, byClient = new Map();
  return (key) => {
    if (now() - start >= windowMs) {
      start = now();
      total = 0;
      byClient = new Map();
    }
    const n = (byClient.get(key) ?? 0) + 1;
    if (n > perClient || total + 1 > global) return false;
    byClient.set(key, n);
    total++;
    return true;
  };
}

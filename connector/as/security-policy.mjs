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
// Public deployments only authorize ChatGPT: the redirect must be https://chatgpt.com (registration and CIMD are
// open, and the consent page speaks of ChatGPT).
export const CHATGPT_ORIGIN = "https://chatgpt.com";
export function chatgptRedirect(uri) {
  try {
    const u = new URL(uri);
    return u.origin === CHATGPT_ORIGIN && !u.username && !u.password;
  } catch {
    return false;
  }
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
export function configuredRefreshWindow(value = process.env.REFRESH_FAMILY_TTL) {
  const seconds = value === undefined ? 600 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 600 || seconds > 14400)
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

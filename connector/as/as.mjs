import { fileURLToPath } from "node:url";
import {applyConsentScopes,consentSelection,consentForm,submittedScopes,ignoreRefreshScope,skipsConnectPage,legalLine} from './consent-selection.mjs';
import {termsRoutes} from './terms-page.mjs';
import {
  observeAuthorization,
  observeAuthorizationRejected,
  observeAccepted,
  observeEffective,
  observeToken,
  diagnostic,
  observeServerError,
} from "./diagnostics.mjs";
import { document, credentials, html, expiredAuthorizationBody, promptTitle, providerErrorPage } from "./auth-pages.mjs";
import express from "express";
import { providerCsp } from "./provider-csp.mjs";
import { fundRoutes, privyPageCsp, afterSignIn, nextField, boundNext, FUND_NEXT } from "./fund-page.mjs";
import { hintReader, expectedReader, mismatchBody, EXPIRED_LINK_LINE } from "./account-bound.mjs";
import { signRoutes } from "./sign-page.mjs";
import { ACCOUNT_TITLE, USERNAME_PATH, accountBody, usernameMessage } from "./account-page.mjs";
import {
  compatibilityClient,
  recordConsent,
  renewableHooks,
  consentRefreshWindow,
} from "./renewable-consent.mjs";
import {
  allowedAccount,
  exactOrigin,
  sameOwner,
  boundBrowser,
  refreshFamilyTTL,
  operatorClient,
  operatorAccountExists,
  configuredRefreshWindow,
  AuthorizationExpired,
  requireFreshBinding,
  bindInteraction,
  chatgptRedirect,
  registrationRequest,
  CLIENT_AUTH_METHODS,
  rateLimiter,
} from "./security-policy.mjs";
import { inspectBody } from "./body-replay.mjs";
import { SQLiteAdapter as Adapter } from "./adapter.mjs";
import Provider, { errors } from "oidc-provider";
import { resourceUserinfo } from "./userinfo.mjs";
import {accountInteractionPolicy,recoveringAccount,prepareInteractionSession,verifiedInteractionLogin} from './account-recovery.mjs';
import { generateKeyPair, exportJWK } from "jose";
import { randomBytes, createHmac } from "node:crypto";
import fs from "node:fs";
import {
  AS,
  RESOURCE,
  read,
  write,
  verifyIdentity,
  lookupAccount,
  secret,
  coreCall,
  coreEnsureWallets,
  coreSend,
  equal,
  port,
  TEST,
  PUBLIC,
} from "#shared/common.mjs";
import { issuableScopes } from "./scopes.mjs";
import { loginMethods } from "./login-methods.mjs";
import { requireLinkKey, verifyLinkToken } from "#shared/link-token.mjs";
configuredRefreshWindow();
// YEET_LOGIN_METHODS (login-methods.mjs): a wrong value stops the server here, not at the first sign-in.
loginMethods();
// The key the page link tokens are verified with (shared/link-token.mjs). No usable key: the server does not start.
const LINK_KEY = requireLinkKey("as");
const publicBase = process.env.PUBLIC_BASE_URL || AS;
if (
  PUBLIC &&
  (new URL(publicBase).protocol !== "https:" ||
    new URL(publicBase).host !== new URL(AS).host ||
    Number(process.env.ACCESS_TTL || 5) < 300 ||
    Number(process.env.ACCESS_TTL || 5) > 600 ||
    new URL(AS).protocol !== "https:" ||
    new URL(RESOURCE).protocol !== "https:" ||
    process.env.COOKIE_SECURE !== "1" ||
    process.env.DEV_IDENTITY_STUB === "1" ||
    process.env.TEST_PROFILE === "1" ||
    process.env.CIMD_TEST_FIXTURES === "1")
)
  throw Error("Invalid public configuration");
if (process.env.MOCK_PASSWORD_LOGIN === "1")
  throw Error("Password sign-in is not available");
if (process.env.PRIVY_LOGIN === "1" && process.env.DEV_IDENTITY_STUB === "1")
  throw Error("Identity modes must be separate");
if (process.env.PRIVY_LOGIN === "1") {
  const { privyConfig } = await import("#shared/privy-identity.mjs");
  privyConfig();
}
if (
  process.env.PRIVY_LOGIN !== "1" &&
  !(TEST && process.env.DEV_IDENTITY_STUB === "1")
)
  throw Error("No identity verifier configured");
let jwks = read("keys.json", null);
if (!jwks) {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [
      {
        ...(await exportJWK(privateKey)),
        kid: "research-key-1",
        use: "sig",
        alg: "RS256",
      },
    ],
  };
  write("keys.json", jwks);
}
const INTERACTION_TTL = 600;
const client = {
  client_id: "local-chatgpt-fixture",
  redirect_uris: ["http://127.0.0.1:38314/callback"],
  response_types: ["code"],
  grant_types: ["authorization_code", "refresh_token"],
  token_endpoint_auth_method: "none",
  application_type: "native",
};
const cookies = read("cookies.json", null) || [randomBytes(32).toString("hex")];
write("cookies.json", cookies);
// Every account comes from core's identity store (created on first verified sign-in), so eligibility is core's answer.
async function policy(id) {
  return coreCall("/policy", id, secret("core-as"));
}
async function findAccount(ctx, id) {
  const p = await policy(id);
  if (
    !allowedAccount(p, {
      privy: true,
      client: ctx.oidc?.client?.clientId,
    })
  )
    return undefined;
  return { accountId: id, claims: async () => ({ sub: id }) };
}
const provider = new Provider(AS, {
  adapter: Adapter,
  jwks,
  ...renewableHooks({
    eligible,
    validGrant: async (id, account, client) => {
      const grant = await provider.Grant.find(id);
      return (
        !!grant && grant.accountId === account && grant.clientId === client
      );
    },
  }),
  cookies: {
    keys: cookies,
    short: { secure: process.env.COOKIE_SECURE === "1" },
    long: { secure: process.env.COOKIE_SECURE === "1" },
  },
  clients: [
    ...(PUBLIC ? [] : [client]),
    {
      client_id: "core-resource",
      client_secret: secret("core-introspection"),
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "client_secret_basic",
    },
    {
      client_id: "mcp-resource",
      client_secret: secret("introspection"),
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  scopes: ["openid", "offline_access", ...issuableScopes],
  pkce: { required: () => true, methods: ["S256"] },
  revokeGrantPolicy: () => true,
  // Discovery and client metadata: authorization code with PKCE and refresh tokens only (no implicit or hybrid
  // response types). client_secret_basic stays for the two internal introspection clients above; discovery and
  // registration offer external clients only CLIENT_AUTH_METHODS (see oauthSurface below).
  responseTypes: ["code"],
  clientAuthMethods: [...CLIENT_AUTH_METHODS, "client_secret_basic"],
  ttl: {
    AccessToken: Number(process.env.ACCESS_TTL || 5),
    AuthorizationCode: 60,
    IdToken: Number(process.env.ACCESS_TTL || 5),
    // An authorization (sign-in, consent, referral) has 10 minutes, the same as its browser binding.
    Interaction: INTERACTION_TTL,
    // The provider's browser session matches the YEET sign-in session (1 hour).
    Session: 3600,
    // A grant outlives the longest refresh family that can be issued under it, plus the authorization itself.
    Grant: () => configuredRefreshWindow() + INTERACTION_TTL + 60,
    RefreshToken: (ctx, token) =>
      refreshFamilyTTL(ctx, token, consentRefreshWindow(token)),
  },
  rotateRefreshToken: () => true,
  features: {
    devInteractions: { enabled: false },
    // Nothing signs out through the provider (YEET sign-out is /account/logout), so there is no end-session page.
    rpInitiatedLogout: { enabled: false },
    revocation: { enabled: true },
    introspection: {
      enabled: true,
      allowedPolicy: (_ctx, c) =>
        ["mcp-resource", "core-resource"].includes(c.clientId),
    },
    registration: { enabled: true },
    clientIdMetadataDocument: { enabled: true, ack: "draft-02" },
    resourceIndicators: {
      enabled: true,
      defaultResource: () => RESOURCE,
      useGrantedResource: () => true,
      getResourceServerInfo: (_ctx, r) => {
        if (r !== RESOURCE && !(TEST && r === "https://other.example/resource"))
          throw new errors.InvalidTarget("Unknown resource");
        return {
          scope: issuableScopes.join(" "),
          audience: r,
          accessTokenFormat: "opaque",
        };
      },
    },
  },
  findAccount,
  // Errors the provider shows in the browser (unknown client, redirect_uri mismatch) use the YEET page, not the
  // library page with its external font. Only the OAuth error code is shown; its description stays in the logs.
  renderError: async (ctx, out) => {
    ctx.type = "html";
    ctx.set("Cache-Control", "no-store");
    ctx.body = providerErrorPage(out?.error);
  },
  interactions: { policy: accountInteractionPolicy(), url: (_ctx, i) => `/interaction/${i.uid}` },
  ...(TEST && process.env.CIMD_TEST_FIXTURES === "1"
    ? {
        fetch: async (url, options) => {
          if (!String(url).startsWith("https://cimd.test/"))
            return fetch(url, options);
          const name = new URL(url).pathname;
          if (name === "/redirect")
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            });
          if (name === "/oversized") return new Response("x".repeat(100000));
          // ChatGPT's published document (https://chatgpt.com/oauth/client.json, 2026-11-12), moved to this host.
          if (name === "/chatgpt")
            return Response.json({
              client_id: String(url),
              client_uri: "https://chatgpt.com/",
              redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
              token_endpoint_auth_method: "private_key_jwt",
              token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
              grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
              response_types: ["code"],
              client_name: "ChatGPT",
              token_endpoint_auth_signing_alg: "RS256",
              jwks_uri: "https://chatgpt.com/oauth/jwks.json",
            });
          return Response.json({
            ...client,
            client_id: String(url),
            redirect_uris: ["https://client.example/callback"],
            application_type: "web",
          });
        },
      }
    : {}),
});
provider.on("authorization.success", observeEffective);
provider.on("authorization.error", observeAuthorizationRejected);
provider.on("server_error", observeServerError);
provider.on("userinfo.error", (ctx, error) =>
  diagnostic("oauth_userinfo_rejected", { error_code: error?.error, status: ctx.status }),
);
provider.on("grant.success", observeToken);
// A registered client that redeems an authorization code is kept; one that never does expires (adapter.mjs).
provider.on("grant.success", (ctx) => {
  if (ctx.oidc?.params?.grant_type === "authorization_code" && ctx.oidc.client)
    Adapter.keepClient(ctx.oidc.client.clientId);
});
// Discovery lists the token endpoint methods external clients can use; the internal introspection clients'
// client_secret_basic is not offered to anyone else.
const DISCOVERY = new Set(["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);
provider.use(async (ctx, next) => {
  await next();
  if (DISCOVERY.has(ctx.path) && ctx.status === 200 && ctx.body && typeof ctx.body === "object")
    ctx.body.token_endpoint_auth_methods_supported = [...CLIENT_AUTH_METHODS];
});
provider.on("grant.error", (ctx) =>
  diagnostic("oauth_token_rejected", {
    grant_type: ["authorization_code", "refresh_token"].includes(
      ctx.oidc?.params?.grant_type,
    )
      ? ctx.oidc.params.grant_type
      : "other",
    status: ctx.status,
  }),
);
provider.proxy = process.env.TRUST_PROXY === "1";
// Initialize the protected dispatcher locally; private probe must fail, public mode has no TLS fixture dependency.
const originalWarn = console.warn;
console.warn = (message, ...rest) => {
  if (String(message).includes("failed to setup SSRF protection"))
    throw Error("SSRF protection unavailable");
  originalWarn(message, ...rest);
};
const { default: protectedFetch } =
  await import(new URL("./helpers/fetch_request.js", import.meta.resolve("oidc-provider")).href); // lib/helpers/, wherever node_modules is
let ssrfFailed = false;
try {
  await protectedFetch(
    provider,
    PUBLIC
      ? "https://127.0.0.1:1/ssrf-probe"
      : "https://tls-fixture:38315/metadata",
    {},
  );
} catch (e) {
  if (e.message === "SSRF protection unavailable") ssrfFailed = true;
}
if (ssrfFailed) throw Error("CIMD startup fails closed");
const app = express();
app.disable("x-powered-by");
app.use((q, r, next) => {
  if (q.path === "/me") {
    r.once("finish", () => diagnostic("oauth_userinfo_result", { status: r.statusCode }));
  }
  next();
});
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
if (PUBLIC)
  app.use((q, r, next) => {
    if (q.headers.host !== new URL(publicBase).host) return r.sendStatus(421);
    next();
  });
// Per client address (req.ip; trust proxy above), under a global ceiling ten times higher.
function limit(max) {
  const allow = rateLimiter({ perClient: max, global: max * 10 });
  return (q, r, next) => {
    if (!allow(q.ip ?? "unknown"))
      return r
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "development rate limit" });
    next();
  };
}
if (PUBLIC) {
  app.use("/account/login", limit(20));
  app.use("/account/wallets", limit(30));
  app.use("/account/terms", limit(40));
  app.use("/interaction", limit(64));
  app.use("/reg", limit(20));
  app.use("/auth", limit(60));
  app.use("/sign/api", limit(60));
  app.use("/fund/api", limit(60));
}
// Body parsers run only on this server's own forms; oidc-provider reads its routes' bodies itself.
const formBody = express.urlencoded({ extended: false, limit: "32kb" });
// Registration accepts only ChatGPT's redirect URIs (same check as the interaction step) and public or
// private_key_jwt clients. Client id metadata documents (https://chatgpt.com/oauth/client.json) never come through
// here and keep working.
app.post(
  "/reg",
  inspectBody("json", (body) => {
    const out = registrationRequest(body);
    return out.problem ? { reject: { status: 400, body: out.problem } } : { body: out.body };
  }),
);
// Compatibility: the provider otherwise rejects PRM scope growth on refresh.
app.post(
  "/token",
  inspectBody("form", (body) =>
    body?.grant_type === "refresh_token" && "scope" in body ? { body: ignoreRefreshScope(body) } : undefined,
  ),
);
// Resource-bound access tokens (aud=RESOURCE) cannot pass oidc-provider's userinfo; see userinfo.mjs.
app.all("/me", resourceUserinfo({
  resource: RESOURCE,
  findAccessToken: (value) => provider.AccessToken.find(value),
  findGrant: (id) => provider.Grant.find(id),
  findClient: (id) => provider.Client.find(id),
  findAccount: (id, token) => findAccount({ oidc: { client: { clientId: token.clientId } } }, id, token),
}));
app.use("/auth", (q, _r, next) => {
  if (q.method === "GET") observeAuthorization(q, RESOURCE);
  next();
});
function authDocument(res, title, body) {
  if (process.env.PRIVY_LOGIN !== "1") return document(title, body);
  const nonce = randomBytes(24).toString("base64");
  res.set(
    "Content-Security-Policy",
    // Privy sign-in plus embedded wallets: auth API, wallet RPC hosts, the wallet iframe and the Turnstile challenge.
    privyPageCsp(nonce, { formAction: "'self' https://chatgpt.com", telegram: true }),
  );
  return document(title, body, nonce);
}
// `bound` (a page opened from an account-bound link, account-bound.mjs): only that account's methods, no new
// account, and a clean start when the person is trying again after coming in as someone else.
const loginFields = (bound = null, again = false) =>
  process.env.PRIVY_LOGIN === "1"
    ? `<div id="privy-login"${bound ? ` data-bound="1" data-methods="${bound.methods.join(",")}"${again ? ' data-again="1"' : ""}` : ""}><p role="status">Loading secure sign in…</p></div><script type="module" src="/account/privy-login/login.js"></script>`
    : credentials();
// Signed hints on account-bound links (shared/link-token.mjs purpose `hint`): verified here, never trusted from the page.
const readHint = hintReader((t) => verifyLinkToken(LINK_KEY, t, { purpose: "hint" }));
const expectedAccount = expectedReader((route, account) => coreSend(route, account, secret("core-as")));
// Public values only: the sign-in page needs the app id.
app.get("/account/identity-config", (_q, r) =>
  process.env.PRIVY_LOGIN === "1"
    ? r.set("Cache-Control", "no-store").json({
        // Decision (b): no signer id is published; the page never attaches a YEET signer to a wallet.
        appId: process.env.PRIVY_APP_ID,
        // The sign-in methods a page with no account-bound link offers (YEET_LOGIN_METHODS, login-methods.mjs).
        methods: loginMethods(),
      })
    : r.sendStatus(404),
);
const csrf = (uid) =>
  createHmac("sha256", secret("csrf")).update(uid).digest("base64url");
function session(req) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("yeet_session="))
    ?.slice(13);
  const row = read("sessions.json")[token];
  return row && row.expires > Date.now() ? { ...row, token } : null;
}
function cookie(res, name, value, age = 3600) {
  res.append(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
  );
}
function retireStaleSession(current,res){
  const sessions=read('sessions.json');
  delete sessions[current.token];
  write('sessions.json',sessions);
  cookie(res,'yeet_session','',0);
}
function originOK(req) {
  return exactOrigin(req.headers.origin, publicBase);
}
async function eligible(id, client) {
  return allowedAccount(await policy(id), {
    privy: true,
    client,
  });
}
// PUBLIC: an interaction whose redirect is not on chatgpt.com is refused before any binding, sign-in or consent.
async function foreignClient(d) {
  if (!PUBLIC) return false;
  let uri = d.params.redirect_uri;
  if (!uri) {
    const c = await provider.Client.find(d.params.client_id);
    uri = c?.redirectUris?.length === 1 ? c.redirectUris[0] : undefined;
  }
  return !chatgptRedirect(uri);
}
const foreignClientBody = "<p>Only ChatGPT can connect to YEET. Start again from ChatGPT.</p>";
function interactionBinding(d, s) {
  const db = read("interaction-bindings.json");
  const binding = bindInteraction(db, d, s);
  write("interaction-bindings.json", db);
  return binding;
}
function saveBinding(uid, binding) {
  const db = read("interaction-bindings.json");
  db[uid] = binding;
  write("interaction-bindings.json", db);
}
// Per-account record of the last grant id. (The product-email choice and the win code moved into the chat: core
// terms_acceptances and referrals; older rows here are left as they are and no longer read.)
function accountConsent(accountId, patch) {
  const db = read("account-consents.json");
  if (patch) {
    db[accountId] = { ...db[accountId], ...patch, updated: Date.now() };
    write("account-consents.json", db);
  }
  return db[accountId];
}
// The sign-in that happened inside an authorization. The provider gives the consent step a new interaction id, so the
// record is keyed by the authorization request itself: the client and its PKCE challenge (one per authorization).
// Kept in this process for the life of an authorization (10 minutes) and used once; after a restart the connect
// page is shown instead.
const signedInHere = new Map();
const authorizationKey = (d) =>
  typeof d.params.code_challenge === "string" && d.params.code_challenge.length >= 43
    ? createHmac("sha256", secret("csrf")).update(`${d.params.client_id}|${d.params.code_challenge}|${d.params.state ?? ""}`).digest("base64url")
    : null;
function noteSignIn(d, account) {
  const key = authorizationKey(d);
  if (!key) return;
  for (const [k, v] of signedInHere) if (Date.now() - v.signedIn > INTERACTION_TTL * 1000) signedInHere.delete(k);
  if (signedInHere.size < 5000) signedInHere.set(key, { account, signedIn: Date.now() });
}
function takeSignIn(d) {
  const key = authorizationKey(d);
  const v = key ? signedInHere.get(key) : undefined;
  if (key) signedInHere.delete(key);
  return v && Date.now() - v.signedIn <= INTERACTION_TTL * 1000 ? v : undefined;
}
/** The client is ChatGPT: its redirect URI is one of ChatGPT's connector redirects (security-policy.mjs). */
async function chatgptClient(d) {
  let uri = d.params.redirect_uri;
  if (!uri) {
    const c = await provider.Client.find(d.params.client_id);
    uri = c?.redirectUris?.length === 1 ? c.redirectUris[0] : undefined;
  }
  return chatgptRedirect(uri);
}
/** Makes the grant for this authorization (the advertised and accepted scope names only) and returns to the client. */
async function finishConnect(q, r, d) {
  if ((d.params.resource || RESOURCE) !== RESOURCE) throw Error("Invalid resource");
  const requested = (d.params.scope || "").split(" ").filter(Boolean);
  const granted = submittedScopes(requested, { consent: "yes" });
  // Every authorization gets a new grant: a second ChatGPT login never inherits an older one.
  const grant = new provider.Grant({ accountId: d.session.accountId, clientId: d.params.client_id });
  applyConsentScopes(grant, { requested, granted, resource: RESOURCE, opScopes: ["openid", "offline_access", ...issuableScopes], resourceScopes: issuableScopes });
  const grantId = await grant.save();
  // ChatGPT stays connected for the refresh window (REFRESH_FAMILY_TTL); the connect page says so in one line.
  if (compatibilityClient(d.params.client_id))
    recordConsent({
      grantId,
      accountId: d.session.accountId,
      clientId: d.params.client_id,
      resource: d.params.resource || RESOURCE,
      scopes: [...grant.getOIDCScope().split(" "), ...grant.getResourceScope(RESOURCE).split(" ")].filter(Boolean),
    });
  accountConsent(d.session.accountId, { grantId });
  await provider.interactionFinished(q, r, { consent: { grantId } }, { mergeWithLastSubmission: true });
}
app.get("/account/login", (q, r) => {
  const next = nextField(q.query.next);
  // From an account-bound link (the funding page, or the terms page whose own token ran out): the hint rides along.
  const bound = boundNext(q.query.next) ? readHint(q.query.h) : null;
  const c = randomBytes(24).toString("hex");
  cookie(r, "yeet_login", c, 300);
  r.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  r.type("html").send(
    authDocument(
      r,
      promptTitle("login"),
      `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="${c}">${next}${bound ? `<input type="hidden" name="hint" value="${html(bound.token)}">` : ""}${loginFields(bound, q.query.again === "1")}${process.env.PRIVY_LOGIN === "1" ? "" : '<button type="submit">Sign in</button>'}</form>`,
    ),
  );
});
function openSession(r, id) {
  const token = randomBytes(32).toString("base64url");
  const db = read("sessions.json");
  db[token] = {
    id,
    csrf: randomBytes(24).toString("hex"),
    expires: Date.now() + 3600000,
  };
  write("sessions.json", db);
  cookie(r, "yeet_session", token);
  cookie(r, "yeet_login", "", 0);
}
app.post("/account/login", formBody, async (q, r) => {
  try {
    const c = q.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("yeet_login="))
      ?.slice(11);
    if (!c || !equal(c, q.body.csrf) || !originOK(q)) return r.sendStatus(403);
    // The form came from an account-bound link (account-bound.mjs): the person must be the link's account. They are
    // looked up, never resolved: no account is created here, and none is linked or switched.
    if (typeof q.body.hint === "string" && q.body.hint) {
      r.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      const bound = boundNext(q.body.next) ? readHint(q.body.hint) : null;
      if (!bound) return r.status(400).type("html").send(authDocument(r, promptTitle("login"), `<p class="notice" role="alert">${html(EXPIRED_LINK_LINE)}</p>`));
      const id = await lookupAccount(q.body);
      if (id !== bound.account) {
        const say = await expectedAccount(bound);
        const retry = `/account/login?next=${q.body.next}&h=${encodeURIComponent(bound.token)}&again=1`;
        return r.status(403).type("html").send(authDocument(r, promptTitle("login"), mismatchBody({ use: say.use, retry })));
      }
      if (!(await eligible(id))) return r.sendStatus(403);
      // A YEET session of another account in this browser ends here: the person just proved they are this one.
      const current = session(q);
      if (current && current.id !== id) {
        const db = read("sessions.json");
        delete db[current.token];
        write("sessions.json", db);
      }
      openSession(r, id);
      return r.redirect(q.body.next === FUND_NEXT ? `/fund?h=${encodeURIComponent(bound.token)}` : afterSignIn(q.body.next));
    }
    const id = await verifyIdentity(q.body);
    if (!sameOwner(session(q), id) || !(await eligible(id)))
      return r.sendStatus(403);
    openSession(r, id);
    r.redirect(afterSignIn(q.body.next));
  } catch {
    r.status(401).json({ error: "sign in failed" });
  }
});
// Server-side wallet setup: the sign-in page posts its Privy access token; after the token is verified, core creates
// whichever wallet is missing with the YEET signer attached (core/trade/wallet-ensure.mjs). Safe to call again.
const WALLET_SETUP_FAILED = "YEET could not set up your wallets. Nothing was charged. Tap Try again.";
app.post("/account/wallets", express.json({ limit: "32kb" }), async (q, r) => {
  r.set("Cache-Control", "no-store");
  if (process.env.PRIVY_LOGIN !== "1" && !TEST) return r.sendStatus(404);
  if (!originOK(q)) return r.sendStatus(403);
  let id;
  try {
    id = await verifyIdentity(q.body ?? {});
  } catch {
    return r.status(401).json({ code: "SIGN_IN_REQUIRED", message: "Your sign in expired. Please sign in again." });
  }
  if (!(await eligible(id))) return r.status(403).json({ code: "NOT_ELIGIBLE", message: "This account cannot use YEET." });
  try {
    const { status, body } = await coreEnsureWallets(id, secret("core-as"));
    if (status === 200 && body && typeof body.ready === "boolean")
      return r.json({ ready: body.ready, chains: body.chains });
    r.status(status >= 400 && status < 500 ? 409 : 502).json({
      code: typeof body?.code === "string" ? body.code : "WALLET_SETUP_FAILED",
      message: typeof body?.message === "string" ? body.message : WALLET_SETUP_FAILED,
    });
  } catch {
    r.status(502).json({ code: "WALLET_SETUP_FAILED", message: WALLET_SETUP_FAILED });
  }
});
app.post("/account/logout", (q, r) => {
  const s = session(q);
  if (!s || !equal(q.headers["x-csrf-token"], s.csrf) || !originOK(q))
    return r.sendStatus(403);
  const db = read("sessions.json");
  delete db[s.token];
  write("sessions.json", db);
  cookie(r, "yeet_session", "", 0);
  r.json(
    process.env.PRIVY_LOGIN === "1"
      ? { ok: true, identity_logout: true }
      : { ok: true },
  );
});
app.get("/account/logout-identity", (_q, r) => {
  if (process.env.PRIVY_LOGIN !== "1") return r.sendStatus(404);
  r.type("html").send(
    authDocument(
      r,
      "Sign out",
      '<div id="privy-login" data-mode="logout"></div><script type="module" src="/account/privy-login/login.js"></script>',
    ),
  );
});
// Page styles, then the sign-in bundle built from ../login (npm run build:login writes login/dist/login.js).
app.use("/account", express.static(fileURLToPath(new URL("./viewer/", import.meta.url)), { fallthrough: true }));
app.use("/account/privy-login", express.static(fileURLToPath(new URL("../login/dist/", import.meta.url)), { fallthrough: true }));
// Without a live session this page never claims a sign-in: it sends the browser to the sign-in page.
// The account page: the username field (core/username.mjs) and a link to add funds.
async function currentUsername(id) {
  try {
    const { status, body } = await coreSend("/username", id, secret("core-as"));
    return status === 200 && body ? { username: body.username ?? null, name: body.name ?? "" } : {};
  } catch {
    return {};
  }
}
async function sendAccountPage(r, s, extra = {}, status = 200) {
  const now = await currentUsername(s.id);
  r.status(status).set("Cache-Control", "no-store").type("html")
    .send(authDocument(r, ACCOUNT_TITLE, accountBody({ csrf: s.csrf, ...now, ...extra })));
}
app.get("/account/", async (q, r) => {
  const s = session(q);
  if (!s) return r.redirect(303, "/account/login");
  await sendAccountPage(r, s, { saved: q.query.username === "saved" });
});
app.post(USERNAME_PATH, formBody, async (q, r) => {
  const s = session(q);
  if (!s) return r.redirect(303, "/account/login");
  if (!equal(q.body?.csrf, s.csrf) || !originOK(q)) return r.sendStatus(403);
  const value = typeof q.body.username === "string" ? q.body.username.slice(0, 64) : "";
  let status = 503, body = null;
  try {
    ({ status, body } = await coreSend("/username", s.id, secret("core-as"), { username: value }));
  } catch {}
  if (status === 200) return r.redirect(303, "/account/?username=saved");
  await sendAccountPage(r, s, { value, error: usernameMessage(body?.error) }, status === 409 ? 409 : 400);
});
// Add funds: a direct USDC transfer on Base or on Solana (address, QR code, wallet links), or USDC on Base by card
// through Privy funding (Coinbase Onramp). Needs a YEET sign-in session and the Privy sign-in.
fundRoutes(app, { enabled: () => process.env.PRIVY_LOGIN === "1", session, hint: readHint, expected: expectedAccount, lookup: lookupAccount, originOK });
// The YEET terms as a first-party page with checkboxes (terms-page.mjs): the same record as yeet_accept_terms.
termsRoutes(app, { session, originOK, equal, formBody, hint: readHint, linkToken: (t) => { try { return verifyLinkToken(LINK_KEY, t, { purpose: "terms" }); } catch { return null; } }, core: (route, account, body) => coreSend(route, account, secret("core-as"), body), document: authDocument });
// Card signing (sign-page.mjs): the signer script the trade card loads, and the first-party signing page with its two
// routes. The page's caller is the Privy user signed in on the page, matched to the account already linked to it.
signRoutes(app, {
  enabled: () => process.env.PRIVY_LOGIN === "1" || (TEST && process.env.DEV_IDENTITY_STUB === "1"),
  appId: () => process.env.PRIVY_APP_ID ?? "",
  methods: loginMethods,
  hint: readHint,
  expected: expectedAccount,
  lookup: lookupAccount,
  core: (route, account, body, timeoutMs) => coreSend(route, account, secret("core-as"), body, timeoutMs),
  originOK,
});
// Browsers ask for /favicon.ico on their own; answer with the YEET icon the pages link to.
const ICON = fs.readFileSync(new URL("./viewer/icon.svg", import.meta.url));
app.get("/favicon.ico", (_q, r) => r.set("Cache-Control", "public, max-age=86400").type("image/svg+xml").send(ICON));
app.get("/", (_q, r) => r.redirect("https://yeet.win"));
function interactionError(e, r, next) {
  if (e instanceof AuthorizationExpired || e instanceof errors.SessionNotFound)
    return r.status(400).type("html").send(authDocument(r,
      "Authorization page expired or unavailable",
      expiredAuthorizationBody));
  return next(e);
}
app.get("/interaction/:uid", async (q, r, next) => {
  try {
    const d = await provider.interactionDetails(q, r);
    if (d.uid !== q.params.uid) return r.sendStatus(403);
    if (await foreignClient(d))
      return r.status(400).type("html").send(authDocument(r, "Connection refused", foreignClientBody));
    const s = await prepareInteractionSession(d,session(q),{
      eligible,retire: current=>retireStaleSession(current,r),
    });
    const binding = interactionBinding(d, s);
    if (s && !(await eligible(s.id, d.params.client_id)))
      throw Error("Account unavailable");
    // One screen: the person signed in on our page inside this authorization and the client is ChatGPT, so the
    // browser goes straight back to ChatGPT (consent-selection.mjs skipsConnectPage).
    if (d.prompt.name === "consent" && skipsConnectPage({ chatgpt: await chatgptClient(d), binding: takeSignIn(d), accountId: d.session?.accountId })) {
      if (!boundBrowser(binding, s, d.session.accountId)) throw Error("Browser identity changed");
      return await finishConnect(q, r, d);
    }
    if (process.env.REFRESH_DIAGNOSTICS === "1")
      observeAccepted(d, await provider.Client.find(d.params.client_id));
    const data = {
      uid: d.uid,
      prompt: d.prompt.name,
      csrf: csrf(d.uid),
      identity: "YEET",
    };
    const requestedScopes = (d.params.scope || "").split(" ").filter(Boolean);
    const prior = d.grantId ? await provider.Grant.find(d.grantId) : undefined;
    const priorScopes = prior?.getResourceScope(RESOURCE).split(" ").filter(Boolean) || [];
    if (TEST) {
      data.consent_selection = consentSelection(requestedScopes, priorScopes);
      data.client_auth_method = (
        await provider.Client.find(d.params.client_id)
      ).tokenEndpointAuthMethod;
      return r.json(data);
    }
    const login = d.prompt.name === "login";
    if (!login) {
      const who = await currentUsername(d.session.accountId);
      r.type("html").send(
        authDocument(r, promptTitle(d.prompt.name), consentForm({
          csrf: data.csrf, name: who.name || who.username || "",
          connectedSeconds: compatibilityClient(d.params.client_id) ? configuredRefreshWindow() : 0,
        })),
      );
      return;
    }
    const identity = s && !recoveringAccount(d)
      ? `<input type="hidden" name="session_login" value="yes">`
      : loginFields();
    const known = s && !recoveringAccount(d) ? await currentUsername(s.id) : null;
    const action = known ? `Continue as ${html(known.name || known.username || "your YEET account")}` : "Sign in";
    r.type("html").send(
      authDocument(
        r,
        promptTitle("connect-login"),
        `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="${data.csrf}">${identity}${(!s || recoveringAccount(d)) && process.env.PRIVY_LOGIN === "1" ? "" : `<button type="submit">${action}</button>`}${legalLine()}</form>`,
      ),
    );
  } catch (e) {
    interactionError(e, r, next);
  }
});
app.post("/interaction/:uid", formBody, async (q, r, next) => {
  try {
    const d = await provider.interactionDetails(q, r);
    if (d.uid !== q.params.uid) return r.sendStatus(403);
    if (await foreignClient(d)) return r.sendStatus(400);
    if (!equal(q.body.csrf, csrf(d.uid)) || !originOK(q))
      return r.sendStatus(403);
    if (d.prompt.name === "login") {
      const s = session(q);
      const binding = requireFreshBinding(read("interaction-bindings.json")[d.uid]);
      const id = await verifiedInteractionLogin(d,s,binding,q.body,{verifyIdentity,eligible});
      binding.account = id;
      binding.signedIn = Date.now();
      noteSignIn(d, id);
      const bindings = read("interaction-bindings.json");
      bindings[d.uid] = binding;
      write("interaction-bindings.json", bindings);
      await provider.interactionFinished(
        q,
        r,
        { login: { accountId: id } },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    if (d.prompt.name === "consent" && q.body.decision === "cancel") {
      await provider.interactionFinished(q, r, { error: "access_denied", error_description: "The person cancelled" }, { mergeWithLastSubmission: false });
      return;
    }
    if (d.prompt.name === "consent" && q.body.consent === "yes") {
      const s = session(q);
      const binding = requireFreshBinding(read("interaction-bindings.json")[d.uid]);
      if (
        !binding ||
        binding.expires <= Date.now() ||
        !boundBrowser(binding, s, d.session.accountId) ||
        !(await eligible(d.session.accountId, d.params.client_id))
      )
        throw Error("Browser identity or eligibility changed");
      await finishConnect(q, r, d);
      return;
    }
    r.sendStatus(400);
  } catch (e) {
    interactionError(e, r, next);
  }
});
if (PUBLIC) app.use(providerCsp);
app.use(provider.callback());
app.use((e, _q, r, _n) => {
  observeServerError(null, e);
  return r.status(400).json({ error: "request rejected" });
});
export const server = app.listen(port("AS_PORT", 38312), process.env.LISTEN_HOST || "0.0.0.0");
const admin = express();
admin.disable("x-powered-by");
admin.use(express.json({ limit: "8kb" }));
admin.use((q, r, next) => {
  if (!equal(q.headers.authorization, `Bearer ${secret("operator")}`))
    return r.sendStatus(401);
  next();
});
admin.post("/policy", async (q, r) => {
  try {
    const { account, disconnect, reconnect, suspended } = q.body;
    const client = operatorClient(q.body.client, {
      privy: process.env.PRIVY_LOGIN === "1",
      test: TEST,
    });
    if (!client) return r.sendStatus(400);
    if (!operatorAccountExists(await policy(account)))
      return r.sendStatus(400);
    await coreCall("/policy", account, secret("core-operator"), {
      account,
      client,
      disconnect,
      reconnect,
      suspended,
    });
    if (disconnect) {
      for (const id of Adapter.grantsFor(account, client)) {
        const grant = await provider.Grant.find(id);
        if (grant) await grant.destroy();
      }
    }
    r.json({ ok: true });
  } catch {
    r.sendStatus(503);
  }
});
export const adminServer = admin.listen(port("ADMIN_PORT", 38317), process.env.LISTEN_HOST || "0.0.0.0");

import { fileURLToPath } from "node:url";
import {applyConsentScopes,consentSelection,consentForm,submittedScopes,ignoreRefreshScope,requireAgreements,referralForm,referralCode,REFERRAL_TITLE} from './consent-selection.mjs';
import {
  observeAuthorization,
  observeAuthorizationRejected,
  observeAccepted,
  observeEffective,
  observeToken,
  diagnostic,
  observeServerError,
} from "./diagnostics.mjs";
import { document, credentials, html, renewableConsentCopy, expiredAuthorizationBody, promptTitle } from "./auth-pages.mjs";
import express from "express";
import { providerCsp } from "./provider-csp.mjs";
import { fundRoutes, privyPageCsp, afterSignIn, nextField } from "./fund-page.mjs";
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
} from "./security-policy.mjs";
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
  secret,
  coreCall,
  equal,
  port,
  TEST,
  PUBLIC,
} from "#shared/common.mjs";
import { issuableScopes } from "./scopes.mjs";
configuredRefreshWindow();
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
  throw Error("Invalid public demo configuration");
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
  ttl: {
    AccessToken: Number(process.env.ACCESS_TTL || 5),
    AuthorizationCode: 60,
    RefreshToken: (ctx, token) =>
      refreshFamilyTTL(ctx, token, consentRefreshWindow(token)),
  },
  rotateRefreshToken: () => true,
  features: {
    devInteractions: { enabled: false },
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
function limit(max) {
  let start = Date.now(),
    count = 0;
  return (_q, r, next) => {
    if (Date.now() - start >= 60000) {
      start = Date.now();
      count = 0;
    }
    if (++count > max)
      return r
        .set("Retry-After", "60")
        .status(429)
        .json({ error: "development rate limit" });
    next();
  };
}
if (PUBLIC) {
  app.use("/demo/login", limit(20));
  app.use("/interaction", limit(64));
  app.use("/reg", limit(20));
  app.use("/auth", limit(60));
}
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));
// Resource-bound access tokens (aud=RESOURCE) cannot pass oidc-provider's userinfo; see userinfo.mjs.
app.all("/me", resourceUserinfo({
  resource: RESOURCE,
  findAccessToken: (value) => provider.AccessToken.find(value),
  findGrant: (id) => provider.Grant.find(id),
  findClient: (id) => provider.Client.find(id),
  findAccount: (id, token) => findAccount({ oidc: { client: { clientId: token.clientId } } }, id, token),
}));
// Compatibility: the provider otherwise rejects PRM scope growth on refresh.
app.use("/token", (q,_r,next) => { ignoreRefreshScope(q.body); next(); });
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
    privyPageCsp(nonce, { formAction: "'self' https://chatgpt.com" }),
  );
  return document(title, body, nonce);
}
const loginFields = () =>
  process.env.PRIVY_LOGIN === "1"
    ? '<div id="privy-login"><p role="status">Loading secure sign in…</p></div><script type="module" src="/demo/privy-login/login.js"></script>'
    : credentials();
// Public values only: the sign-in page needs the app id, and the signer step needs the YEET signer and policy ids.
const publicId = (name) => {
  const value = process.env[name];
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
};
app.get("/demo/identity-config", (_q, r) =>
  process.env.PRIVY_LOGIN === "1"
    ? r.set("Cache-Control", "no-store").json({
        appId: process.env.PRIVY_APP_ID,
        signerId: publicId("YEET_SIGNER_ID"),
        policyIds: {
          base: publicId("YEET_BASE_POLICY_ID"),
          solana: publicId("YEET_SOLANA_POLICY_ID"),
        },
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
function retireDemoSession(current,res){
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
// Per-account consent extras, next to the grant id they came with: product-email choice, referral code, screen shown.
function accountConsent(accountId, patch) {
  const db = read("account-consents.json");
  if (patch) {
    db[accountId] = { ...db[accountId], ...patch, updated: Date.now() };
    write("account-consents.json", db);
  }
  return db[accountId];
}
// The referral screen shows once: for an account that has not seen it and holds no grant for this client.
const referralDue = (accountId, clientId) =>
  !accountConsent(accountId)?.referral_shown && Adapter.grantsFor(accountId, clientId).length === 0;
app.get("/demo/login", (q, r) => {
  const next = nextField(q.query.next);
  const c = randomBytes(24).toString("hex");
  cookie(r, "yeet_login", c, 300);
  r.type("html").send(
    authDocument(
      r,
      promptTitle("login"),
      `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="${c}">${next}${loginFields()}${process.env.PRIVY_LOGIN === "1" ? "" : '<button type="submit">Sign in</button>'}</form>`,
    ),
  );
});
app.post("/demo/login", async (q, r) => {
  try {
    const c = q.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("yeet_login="))
      ?.slice(11);
    if (!c || !equal(c, q.body.csrf) || !originOK(q)) return r.sendStatus(403);
    const id = await verifyIdentity(q.body);
    if (!sameOwner(session(q), id) || !(await eligible(id)))
      return r.sendStatus(403);
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
    r.redirect(afterSignIn(q.body.next));
  } catch {
    r.status(401).json({ error: "sign in failed" });
  }
});
app.post("/demo/logout", (q, r) => {
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
app.get("/demo/logout-identity", (_q, r) => {
  if (process.env.PRIVY_LOGIN !== "1") return r.sendStatus(404);
  r.type("html").send(
    authDocument(
      r,
      "Sign out",
      '<div id="privy-login" data-mode="logout"></div><script type="module" src="/demo/privy-login/login.js"></script>',
    ),
  );
});
// Page styles, then the sign-in bundle built from ../login (npm run build:login writes login/dist/login.js).
app.use("/demo", express.static(fileURLToPath(new URL("./viewer/", import.meta.url)), { fallthrough: true }));
app.use("/demo/privy-login", express.static(fileURLToPath(new URL("../login/dist/", import.meta.url)), { fallthrough: true }));
app.get("/demo/", (_q, r) =>
  r
    .type("html")
    .send(
      authDocument(
        r,
        "YEET",
        '<p>You are signed in to YEET. Go back to ChatGPT to keep going.</p>',
      ),
    ),
);
// Add funds: USDC on Base through Privy funding (Coinbase Onramp). Needs a YEET sign-in session and the Privy sign-in.
fundRoutes(app, { enabled: () => process.env.PRIVY_LOGIN === "1", session });
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
      eligible,retire: current=>retireDemoSession(current,r),
    });
    const binding = interactionBinding(d, s);
    if (s && !(await eligible(s.id, d.params.client_id)))
      throw Error("Account unavailable");
    // Consent was submitted for this interaction; the referral screen comes next (also on reload).
    if (d.prompt.name === "consent" && binding.pendingConsent) {
      if (TEST) return r.json({ uid: d.uid, prompt: "referral", csrf: csrf(d.uid), referral_code: "WIN" });
      return r.type("html").send(authDocument(r, REFERRAL_TITLE, referralForm({ csrf: csrf(d.uid) })));
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
      const renewal = compatibilityClient(d.params.client_id)
        ? renewableConsentCopy(configuredRefreshWindow())
        : "";
      r.type("html").send(
        authDocument(r, promptTitle(d.prompt.name), consentForm({
          csrf: data.csrf, accountId: d.session.accountId, clientId: d.params.client_id,
          resource: d.params.resource || RESOURCE, requested: requestedScopes, priorGranted: priorScopes, renewal,
        })),
      );
      return;
    }
    const identity = s && !recoveringAccount(d)
      ? `<input type="hidden" name="session_login" value="yes"><p>Signed in as <strong>${html(s.id)}</strong></p>`
      : loginFields();
    const action = s && !recoveringAccount(d) ? `Continue as ${html(s.id)}` : "Sign in";
    r.type("html").send(
      authDocument(
        r,
        promptTitle(d.prompt.name),
        `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="${data.csrf}">${identity}${(!s || recoveringAccount(d)) && process.env.PRIVY_LOGIN === "1" ? "" : `<button type="submit">${action}</button>`}</form>`,
      ),
    );
  } catch (e) {
    interactionError(e, r, next);
  }
});
app.post("/interaction/:uid", async (q, r, next) => {
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
    if (d.prompt.name === "consent" && (q.body.consent === "yes" || q.body.step === "referral")) {
      const s = session(q);
      const binding = requireFreshBinding(read("interaction-bindings.json")[d.uid]);
      if (
        !binding ||
        binding.expires <= Date.now() ||
        !boundBrowser(binding, s, d.session.accountId) ||
        !(await eligible(d.session.accountId, d.params.client_id))
      )
        throw Error("Browser identity or eligibility changed");
      if ((d.params.resource || RESOURCE) !== RESOURCE) throw Error("Invalid resource");
      const requested = (d.params.scope || "").split(" ").filter(Boolean);
      let pending = binding.pendingConsent, referral = null;
      if (q.body.step === "referral") {
        if (!pending) return r.sendStatus(400);
        referral = referralCode(q.body);
      } else {
        // A repeated consent submit while the referral screen is due goes back to that screen.
        if (pending) return r.redirect(303, `/interaction/${d.uid}`);
        const granted = submittedScopes(requested, q.body);
        let agreed;
        try { agreed = requireAgreements(q.body); } catch { return r.sendStatus(400); }
        pending = { granted, renewable: q.body.renewable_consent === "yes", product_email: agreed.product_email };
        if (referralDue(d.session.accountId, d.params.client_id)) {
          saveBinding(d.uid, { ...binding, pendingConsent: pending });
          return r.redirect(303, `/interaction/${d.uid}`);
        }
      }
      // Every authorization gets a new grant: a second ChatGPT login never inherits an older one.
      const grant = new provider.Grant({ accountId: d.session.accountId, clientId: d.params.client_id });
      applyConsentScopes(grant, { requested, granted: pending.granted, resource: RESOURCE, opScopes: ["openid", "offline_access", ...issuableScopes], resourceScopes: issuableScopes });
      const grantId = await grant.save();
      if (
        compatibilityClient(d.params.client_id) &&
        pending.renewable
      )
        recordConsent({
          grantId,
          accountId: d.session.accountId,
          clientId: d.params.client_id,
          resource: d.params.resource || RESOURCE,
          scopes: [...grant.getOIDCScope().split(" "), ...grant.getResourceScope(RESOURCE).split(" ")].filter(Boolean),
        });
      accountConsent(d.session.accountId, {
        grantId,
        product_email: pending.product_email,
        ...(q.body.step === "referral" ? { referral_shown: true } : {}),
        ...(referral ? { referral } : {}),
      });
      if (binding.pendingConsent) {
        const { pendingConsent: _done, ...rest } = binding;
        saveBinding(d.uid, rest);
      }
      await provider.interactionFinished(
        q,
        r,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
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

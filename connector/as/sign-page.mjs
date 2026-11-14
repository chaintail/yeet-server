// Card signing on the connector's own origin (yeet-win docs/CARD-SIGNING.md section 2):
//
//   GET  /cards/yeet-signer-<hash>.js  the vendored Privy signer the trade card loads by <script> (hash = first 12 hex of
//                                      its sha256, so the URL changes with the content: cached for a year, immutable;
//                                      another hash is redirected to the stable name below)
//   GET  /cards/yeet-signer.js         the same bytes under a stable name, cached 5 minutes
//   GET  /sign?trade_id=t_...          the first-party signing page: the card opens it with window.openai.openExternal
//                                      when it cannot sign inline (an account that connected with Google or Apple has
//                                      no emailed code for the card; or the card's frame refused the wallet). It runs
//                                      the same signer at top level. A browser with no YEET session gets the connect
//                                      screen's sign-in methods (login/sign.jsx, loaded on demand; nothing is created
//                                      there). Google and Apple return to the bare /sign (Privy matches redirect
//                                      addresses exactly, with no query); the page keeps the trade id for that trip.
//   POST /sign/api/requests            {trade_id, privy_access_token} -> the trade's open sign requests
//   POST /sign/api/signature           {trade_id, leg, attempt_id, signed, privy_access_token} -> submit_trade_signature
//                                      (once per sign request; a Solana request may pay several legs, `legs` /
//                                      `leg_summaries`, with one signature: `leg` is its anchor, legs[0])
//   POST /sign/api/email-linked        {trade_id, privy_access_token} -> {ok}: the person linked an email login to
//                                      their Privy user on the page (the optional step after a Google or Apple
//                                      trade); core drops its cached sign-in facts for that account, so the next
//                                      basket card emails the code. Nothing is believed from the page: core reads
//                                      the facts from Privy.
//
// Who may sign what. The page holds no YEET session of its own; every API call carries the Privy access token of the
// person signed in on the page, and nothing else identifies them:
//   1. the token is verified here (shared/privy-identity.mjs: ES256 against the YEET Privy app's JWKS, issuer privy.io,
//      audience = PRIVY_APP_ID, at most 2 hours old) and gives the Privy user id (did:privy:...);
//   2. core maps that id to the account ALREADY linked to it (POST /identity/lookup; never creates an account; a
//      suspended account is refused). This is the same link the ChatGPT sign-in made, so it is the trade's account
//      exactly when the person signed in with the same Privy user;
//   3. core answers only for a trade of that account and an attempt of that account (pipeline owned(),
//      attempt.account_id) and accepts only the bytes of its own sign request for that account's wallet.
// The page itself signs only the server-issued requests it gets back, and only with the embedded wallet whose address
// equals the request's `wallet`. Requests must come from this origin (exact Origin header).
import {readFileSync} from "node:fs";
import {randomBytes} from "node:crypto";
import express from "express";
import {html} from "./auth-pages.mjs";
import {privyPageCsp} from "./fund-page.mjs";
import {DEFAULT_LOGIN_METHODS, knownMethods} from "./login-methods.mjs";
import {APP_ID, PRIVY_API, SIGN_PAGE_PATH, SIGNER_PATH_PREFIX, signerAsset} from "#shared/signing.mjs";

const TRADE_ID = /^t_[a-z0-9]{20}$/;
const read = (file) => readFileSync(new URL(file, import.meta.url));
const ASSETS = {
  "/sign/sign.js": ["text/javascript; charset=utf-8", read("./viewer/sign/sign.js")],
  // The page's flow with no DOM (the session, the trade, the press and hold, the optional email step).
  "/sign/flow.mjs": ["text/javascript; charset=utf-8", read("./viewer/sign/flow.mjs")],
  "/sign/sign.css": ["text/css; charset=utf-8", read("./viewer/sign/sign.css")],
  // The card-builder contract (sign request -> Privy wallet RPC body, wallet answer -> `signed`), the one source both
  // the card (vendored verbatim) and this page use.
  "/sign/wallet-request.mjs": ["text/javascript; charset=utf-8", read("../core/pipeline/wallet-request.mjs")],
};
export const SIGN_TITLE = "Finish your trade";
/** Script headers: any card origin (a ChatGPT card host) may load it. */
const SCRIPT_HEADERS = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};
export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT_CACHE = "public, max-age=300";

/** The page's policy: the Privy page policy of the sign-in server (fund-page.mjs) plus Privy's wallet API host. */
export const signCsp = (nonce) => privyPageCsp(nonce, {connect: [PRIVY_API]});

/** ChatGPT appends ?redirectUrl=... to openExternal targets; offer it back only when it is a chatgpt.com https URL. */
export function returnUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && u.hostname === "chatgpt.com" && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export function signPageHtml({appId, tradeId, asset, back, nonce, methods = DEFAULT_LOGIN_METHODS}) {
  const data = [
    // The sign-in methods this page offers a browser with no session (YEET_LOGIN_METHODS; as/login-methods.mjs).
    ["methods", knownMethods(methods).join(",")],
    ["app-id", appId && APP_ID.test(appId) ? appId : ""],
    ["trade-id", TRADE_ID.test(tradeId ?? "") ? tradeId : ""],
    ["back", back ?? ""],
  ].map(([k, v]) => ` data-${k}="${html(v)}"`).join("");
  const signer = asset ? `<script nonce="${html(nonce)}" src="${html(asset.path)}"></script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#09071C"><meta name="referrer" content="no-referrer"><meta property="csp-nonce" content="${html(nonce)}"><title>${html(SIGN_TITLE)} · YEET</title><link rel="icon" type="image/svg+xml" href="/account/icon.svg"><link rel="stylesheet" href="/sign/sign.css">${signer}<script nonce="${html(nonce)}" type="module" src="/sign/sign.js"></script></head><body><main id="yeet-sign"${data}><section class="card" aria-live="polite"><header class="top"><span class="mark">YEET</span><h1>${html(SIGN_TITLE)}</h1></header><div id="sign-body"><p class="line" role="status">Getting your trade…</p></div></section></main></body></html>`;
}

/**
 * Mounts the routes. deps:
 *   enabled()            the API is on (Privy sign-in, or the development identity in tests)
 *   appId()              the public Privy app id (PRIVY_APP_ID)
 *   lookup(body)         verified credential -> linked account id or null; throws when the credential does not verify
 *   core(route, account, body, timeoutMs) -> {status, body}  (core-as credential, x-yeet-subject = account)
 *   originOK(req)        exact Origin of this server
 *   asset                signerAsset() (null when the signer is not vendored)
 *   methods()            the sign-in methods the page offers with no session (YEET_LOGIN_METHODS)
 */
export function signRoutes(app, {enabled, appId, lookup, core, originOK, asset = signerAsset(), methods = () => [...DEFAULT_LOGIN_METHODS]}) {
  app.get(`${SIGNER_PATH_PREFIX}.js`, (_q, r) => {
    if (!asset) return r.sendStatus(404);
    r.set({...SCRIPT_HEADERS, "Cache-Control": SHORT_CACHE, ETag: `"${asset.hash}"`}).send(asset.bytes);
  });
  app.get(/^\/cards\/yeet-signer-([0-9a-f]{12})\.js$/, (q, r) => {
    // Another hash (a card that met a newer or older connector mid-deploy): the stable name, never other bytes under
    // this immutable URL and never a cacheable 404 that would outlive the deploy.
    if (!asset || q.params[0] !== asset.hash) return r.set("Cache-Control", "no-store").redirect(302, `${SIGNER_PATH_PREFIX}.js`);
    r.set({...SCRIPT_HEADERS, "Cache-Control": IMMUTABLE, ETag: `"${asset.hash}"`}).send(asset.bytes);
  });
  for (const [path, [type, bytes]] of Object.entries(ASSETS))
    app.get(path, (_q, r) => r.set({"Content-Type": type, "Cache-Control": SHORT_CACHE, "X-Content-Type-Options": "nosniff"}).send(bytes));

  app.get(SIGN_PAGE_PATH, (q, r) => {
    const nonce = randomBytes(24).toString("base64");
    const tradeId = typeof q.query.trade_id === "string" ? q.query.trade_id : "";
    r.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": signCsp(nonce),
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    const id = enabled() ? appId() : "";
    r.type("html").send(signPageHtml({appId: id, tradeId, asset: id ? asset : null, back: returnUrl(q.query.redirectUrl), nonce, methods: methods()}));
  });

  const json = express.json({limit: "64kb"});
  const fail = (r, status, code, message) => r.status(status).json({code, message});
  // Another account's trade and an unknown trade answer the same. The page adds who is here and "Use another account".
  const NOT_YOURS = "This trade belongs to a different YEET account than the one you’re using here. Use the Google, Apple or email account you connected to ChatGPT with.";
  /** Verifies the caller and returns the account id, or answers the refusal and returns null. */
  async function who(q, r) {
    r.set("Cache-Control", "no-store");
    if (!enabled()) { r.sendStatus(404); return null; }
    if (!originOK(q)) { r.sendStatus(403); return null; }
    const b = q.body ?? {};
    if (!TRADE_ID.test(b.trade_id ?? "")) { fail(r, 400, "INVALID_ARGUMENT", "Open this page from the YEET card in ChatGPT."); return null; }
    let account;
    try { account = await lookup({privy_access_token: b.privy_access_token, identity_token: b.identity_token}); }
    catch { fail(r, 401, "SIGN_IN_REQUIRED", "Your session here ended. Confirm it’s you again."); return null; }
    if (!account) { fail(r, 404, "TRADE_NOT_FOUND", NOT_YOURS); return null; }
    return account;
  }
  /** Core's refusal as the page reads it. An unknown trade and another account's trade look the same. */
  function refusal(r, status, body) {
    if (status === 400 || (status === 409 && body?.error === "INVALID_ARGUMENT")) return fail(r, 404, "TRADE_NOT_FOUND", NOT_YOURS);
    if (status === 403) return fail(r, 403, "NOT_ELIGIBLE", "This account can’t trade with YEET.");
    if (status === 409 && typeof body?.error === "string") return fail(r, 409, body.error, typeof body.message === "string" ? body.message : "Your wallet’s answer wasn’t accepted. Nothing was sent.");
    return fail(r, 502, "TEMPORARILY_UNAVAILABLE", "YEET couldn’t reach your trade. Try again in a minute.");
  }
  const leg = (l) => ({leg: l.leg, symbol: l.symbol, send_status: l.send_status});

  app.post(`${SIGN_PAGE_PATH}/api/requests`, json, async (q, r) => {
    const account = await who(q, r);
    if (!account) return;
    let out;
    try { out = await core(`/sign/trades/${q.body.trade_id}/requests`, account, {}, 15000); }
    catch { return refusal(r, 502, null); }
    if (out.status !== 200 || !out.body) return refusal(r, out.status, out.body);
    const b = out.body;
    r.json({trade_id: b.trade_id, direction: b.direction, status: b.status, legs: (b.legs ?? []).map(leg), sign_requests: b.sign_requests ?? []});
  });

  app.post(`${SIGN_PAGE_PATH}/api/signature`, json, async (q, r) => {
    const account = await who(q, r);
    if (!account) return;
    const {trade_id, leg: idx, attempt_id, signed} = q.body;
    let out;
    try { out = await core(`/sign/trades/${trade_id}/signature`, account, {leg: idx, attempt_id, signed}, 20000); }
    catch { return refusal(r, 502, null); }
    if (out.status !== 200 || !out.body) return refusal(r, out.status, out.body);
    const b = out.body;
    r.json({trade_id: b.trade_id, status: b.status, legs: (b.legs ?? []).map(leg), ...(b.sign_requests?.length ? {sign_requests: b.sign_requests} : {})});
  });

  // The optional step after a Google or Apple trade: the person linked an email login on the page. The caller is
  // verified like every other call; core only forgets what it cached about that account's sign-in.
  app.post(`${SIGN_PAGE_PATH}/api/email-linked`, json, async (q, r) => {
    const account = await who(q, r);
    if (!account) return;
    try { await core("/sign/account/login-refresh", account, {}, 5000); } catch { /* core reads Privy again within a minute */ }
    r.json({ok: true});
  });
}

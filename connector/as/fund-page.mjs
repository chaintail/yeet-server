// "Add funds" page at /fund. It is served by the sign-in server so it shares the origin (and the Privy session and
// embedded wallets) of the YEET sign-in page. The page script (login/fund.jsx) shows the person's own wallet address
// for a direct USDC transfer on Base or Solana first (QR code, wallet links, live balance), then card payment: Privy's
// deposit modal, which runs Stripe's embedded onramp (card, Apple Pay, Google Pay) inside this page, and the older
// Coinbase Onramp flow, which Privy opens in its own popup window.
import { randomBytes } from "node:crypto";
import express from "express";
import { document, html } from "./auth-pages.mjs";
import { MISMATCH_CODE, MISMATCH_LINE, mismatchBody } from "./account-bound.mjs";

export const FUND_PATH = "/fund";
/** The only post-sign-in destination the sign-in form accepts besides its default. */
export const FUND_NEXT = "fund";
/** Public Base RPC the page reads the USDC balance from (eth_call, read only). Keep in sync with login/fund-balance.js. */
export const BASE_RPC_ORIGIN = "https://mainnet.base.org";
/** Public Solana RPC the page reads the USDC on Solana balance from (getTokenAccountsByOwner, read only). Keep in sync
 * with login/fund-balance.js SOLANA_RPC. */
export const SOLANA_RPC_ORIGIN = "https://api.mainnet-beta.solana.com";

/**
 * Content-Security-Policy for pages that run the Privy bundle: auth API, wallet RPC hosts, the wallet iframe and the
 * Turnstile challenge. `connect` adds connect-src origins, `formAction` replaces form-action. `telegram` allows
 * Privy's Telegram sign-in: PrivyProvider adds https://auth.privy.io/js/telegram-login.js (Telegram's login widget),
 * which frames and calls https://oauth.telegram.org and opens its sign-in window there.
 */
export const TELEGRAM_ORIGIN = "https://oauth.telegram.org";
export function privyPageCsp(nonce, { connect = [], formAction = "'self'", telegram = false, script = [], frame = [], img = [] } = {}) {
  const tg = telegram ? [TELEGRAM_ORIGIN] : [];
  return [
    "default-src 'self'",
    [`script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`, ...(telegram ? ["https://auth.privy.io"] : []), ...script].join(" "),
    `style-src 'self' 'nonce-${nonce}'`,
    ["connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems", ...connect, ...tg].join(" "),
    ["frame-src https://auth.privy.io https://challenges.cloudflare.com", ...tg, ...frame].join(" "),
    ["child-src https://auth.privy.io https://challenges.cloudflare.com", ...tg, ...frame].join(" "),
    ["img-src 'self' data: blob:", ...img].join(" "),
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Sources for Stripe's embedded crypto onramp, which Privy's deposit modal runs inside this page (card, Apple Pay,
 * Google Pay). Only the fund page gets them. The lists are Stripe's own CSP directives for Stripe.js, Link and
 * Crypto: https://docs.stripe.com/security/guide.md#content-security-policy . The `@stripe/crypto` package (1.1.3,
 * imported by @privy-io/react-auth 3.51.4) adds three script elements on import: https://js.stripe.com/v3 ,
 * https://js.stripe.com/crypto-onramp/v1/crypto-onramp.js and https://crypto-js.stripe.com/crypto-onramp-outer.js ;
 * without these sources a headless Chromium run of the loader under this policy reports script-src-elem violations
 * for all three and Privy's modal fails with "@stripe/crypto is required".
 */
export const STRIPE_CSP = Object.freeze({
  script: Object.freeze(["https://js.stripe.com", "https://*.js.stripe.com", "https://crypto-js.stripe.com"]),
  frame: Object.freeze(["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com", "https://link.com", "https://*.link.com"]),
  connect: Object.freeze(["https://api.stripe.com", "https://link.com", "https://*.link.com"]),
  img: Object.freeze(["https://*.stripe.com", "https://*.link.com"]),
});

// The QR code is inline SVG drawn by the page script; wallet links are plain navigations. Neither needs a CSP source.
export const fundCsp = (nonce) =>
  privyPageCsp(nonce, {
    connect: [BASE_RPC_ORIGIN, SOLANA_RPC_ORIGIN, ...STRIPE_CSP.connect],
    script: STRIPE_CSP.script,
    frame: STRIPE_CSP.frame,
    img: STRIPE_CSP.img,
  });

export const FUND_TITLE = "Add funds";
const fundBody = (hint) =>
  `<div id="yeet-fund"${hint ? ` data-hint="${html(hint)}"` : ""}><p role="status">Loading your YEET wallet…</p></div><script type="module" src="/account/privy-login/fund.js"></script>`;
/** The sign-in page for the funding page; `h` carries the link's signed hint on, `again` asks for a clean start. */
export const fundSignIn = (loginPath, hint, again = false) =>
  `${loginPath}?next=${FUND_NEXT}${hint ? `&h=${encodeURIComponent(hint.token)}` : ""}${hint && again ? "&again=1" : ""}`;

/**
 * GET /fund. Requires a YEET sign-in session; without one the person is sent to the sign-in page, which returns here.
 * enabled(): the Privy sign-in is configured (the page cannot work without it). session(req): the current session or null.
 *
 * The account the page is for (as/account-bound.mjs). A link the core minted for the connected account carries
 * ?h=<signed hint>: the page is then for THAT account. A browser signed in to YEET as another account is refused
 * here; with no session the sign-in page gets the hint and offers only that account's methods. Without a valid hint
 * the page is for the account of the YEET session, as before.
 *
 * POST /fund/api/check {privy_access_token, hint?} -> {ok: true}, or 409 ACCOUNT_MISMATCH {message, use}.
 * The page shows wallet addresses of the Privy user in the browser, so before it shows any, the server compares the
 * account behind that Privy user with the account the page is for (lookup never creates an account). Money sent to
 * the address of another account would land in the wrong wallet: the page shows nothing until this answers ok.
 *   hint(text) -> {token, account, methods} or null     expected(hint) -> {message, use}
 *   lookup(body) -> account id or null; throws when the Privy token does not verify     originOK(req)
 */
export function fundRoutes(app, { enabled, session, loginPath = "/account/login", hint = () => null, expected = async () => ({ message: MISMATCH_LINE, use: null }), lookup = null, originOK = () => false }) {
  app.get(FUND_PATH, async (q, r) => {
    if (!enabled()) return r.sendStatus(404);
    r.set("Cache-Control", "no-store");
    const bound = hint(q.query.h), s = session(q);
    if (!s) return r.redirect(303, fundSignIn(loginPath, bound));
    if (bound && s.id !== bound.account) {
      const say = await expected(bound).catch(() => ({ use: null }));
      return r.status(403).set("Referrer-Policy", "no-referrer").type("html").send(document(FUND_TITLE, mismatchBody({ use: say.use, retry: fundSignIn(loginPath, bound, true) })));
    }
    const nonce = randomBytes(24).toString("base64");
    r.set({
      "Content-Security-Policy": fundCsp(nonce),
      // Privy watches the Coinbase popup it opens (window.closed); a stricter opener policy would cut that link.
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    r.type("html").send(document(FUND_TITLE, fundBody(bound?.token), nonce));
  });

  app.post(`${FUND_PATH}/api/check`, express.json({ limit: "32kb" }), async (q, r) => {
    r.set("Cache-Control", "no-store");
    if (!enabled() || !lookup) return r.sendStatus(404);
    if (!originOK(q)) return r.sendStatus(403);
    const s = session(q);
    if (!s) return r.status(401).json({ code: "SIGN_IN_REQUIRED", message: "Your session here ended. Sign in again." });
    const b = q.body ?? {}, bound = hint(b.hint);
    // The account the page is for: the link's when it carries a valid hint, else the YEET session's.
    const want = bound ?? { token: null, account: s.id, methods: [] };
    let account;
    try { account = await lookup({ privy_access_token: b.privy_access_token, identity_token: b.identity_token }); }
    catch { return r.status(401).json({ code: "SIGN_IN_REQUIRED", message: "Your session here ended. Sign in again." }); }
    if (account === want.account && s.id === want.account) return r.json({ ok: true });
    const say = await expected(want).catch(() => ({ message: MISMATCH_LINE, use: null }));
    r.status(409).json({ code: MISMATCH_CODE, message: MISMATCH_LINE, use: say.use ?? null });
  });
}

/** Where the sign-in form sends the person after a successful sign-in. Only the fund page is accepted. */
export const afterSignIn = (next) => (next === FUND_NEXT ? FUND_PATH : next === "terms" ? "/account/terms" : "/account/");
/** The destinations a signed hint may ride to through the sign-in page. */
export const boundNext = (next) => next === FUND_NEXT || next === "terms";
/** Hidden field the sign-in form carries when it was opened from the fund page. */
export const nextField = (next) => (next === FUND_NEXT || next === "terms" ? `<input type="hidden" name="next" value="${next}">` : "");

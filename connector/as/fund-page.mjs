// "Add funds" page at /fund. It is served by the sign-in server so it shares the origin (and the Privy session and
// embedded wallets) of the YEET sign-in page. The page script (login/fund.jsx) shows the person's own wallet address
// for a direct USDC transfer on Base or Solana first (QR code, wallet links, live balance), then card payment: Privy's
// deposit modal, which runs Stripe's embedded onramp (card, Apple Pay, Google Pay) inside this page, and the older
// Coinbase Onramp flow, which Privy opens in its own popup window.
import { randomBytes } from "node:crypto";
import express from "express";
import { document, html } from "./auth-pages.mjs";
import { MISMATCH_CODE, MISMATCH_LINE, EXPIRED_CODE, EXPIRED_LINK_LINE, NO_HINTS, mismatchBody, expiredBody } from "./account-bound.mjs";

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
/** The sign-in page for the funding page; `h` carries the link's signed hint on. */
export const fundSignIn = (loginPath, hint) => `${loginPath}?next=${FUND_NEXT}${hint ? `&h=${encodeURIComponent(hint.token)}` : ""}`;

/**
 * GET /fund. Requires a YEET sign-in session; without one the person is sent to the sign-in page, which returns here.
 * enabled(): the Privy sign-in is configured (the page cannot work without it). session(req): the current session or null.
 *
 * The account the page is for (as/account-bound.mjs). A link the core minted for the connected account carries
 * ?h=<signed hint>: the page is then for THAT account. A browser signed in to YEET as another account is refused
 * here; with no session the sign-in page gets the hint and offers only that account's methods. A hint that is on the
 * link but does not verify (expired, altered) is refused with the expired state: it is never dropped in favour of
 * the session the browser happens to hold. Only a link with no hint at all is for the account of the YEET session.
 *
 * POST /fund/api/check {privy_access_token, hint?} -> {ok: true, user, addresses: {base, solana}}, or
 * 409 ACCOUNT_MISMATCH, or 410 LINK_EXPIRED (a hint that was sent and does not verify).
 * The server compares the account behind the Privy user in the browser with the account the page is for (lookup
 * never creates an account), and answers with that account's Privy user id and ITS wallet addresses as the core
 * holds them. The page shows only those addresses, and only while the Privy user in the browser is that user
 * (login/fund-approval.js): money sent to the address of another account would land in the wrong wallet.
 *   hint                account-bound.mjs hintReader
 *   lookup(body) -> account id or null; throws when the Privy token does not verify     originOK(req)
 *   wallets(account) -> {user: did, addresses: {base, solana}} or null (core /account/wallets)
 */
export function fundRoutes(app, { enabled, session, loginPath = "/account/login", hint = NO_HINTS, lookup = null, wallets = async () => null, originOK = () => false }) {
  app.get(FUND_PATH, async (q, r) => {
    if (!enabled()) return r.sendStatus(404);
    r.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const { supplied, hint: bound } = hint.state(q.query.h), s = session(q);
    if (supplied && !bound) return r.status(410).type("html").send(document(FUND_TITLE, expiredBody()));
    if (!s) return r.redirect(303, fundSignIn(loginPath, bound));
    if (bound && s.id !== bound.account)
      return r.status(403).type("html").send(document(FUND_TITLE, mismatchBody({ retry: fundSignIn(loginPath, bound) })));
    const nonce = randomBytes(24).toString("base64");
    r.set({
      "Content-Security-Policy": fundCsp(nonce),
      // Privy watches the Coinbase popup it opens (window.closed); a stricter opener policy would cut that link.
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
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
    const b = q.body ?? {}, { supplied, hint: bound } = hint.state(b.hint);
    if (supplied && !bound) return r.status(410).json({ code: EXPIRED_CODE, message: EXPIRED_LINK_LINE });
    // The account the page is for: the link's when it carries a hint, else (no hint at all) the YEET session's.
    const want = bound ? bound.account : s.id;
    let account;
    try { account = await lookup({ privy_access_token: b.privy_access_token, identity_token: b.identity_token }); }
    catch { return r.status(401).json({ code: "SIGN_IN_REQUIRED", message: "Your session here ended. Sign in again." }); }
    if (account !== want || s.id !== want) return r.status(409).json({ code: MISMATCH_CODE, message: MISMATCH_LINE });
    // The addresses come from the core's own record of THAT account, never from the browser.
    let own = null;
    try { own = await wallets(want); } catch { own = null; }
    const ok = (v) => typeof v === "string" && v.length >= 20 && v.length <= 64;
    if (!own || typeof own.user !== "string" || !ok(own.addresses?.base))
      return r.status(503).json({ code: "TEMPORARILY_UNAVAILABLE", message: "YEET could not read your wallets just now. Try again in a moment." });
    r.json({ ok: true, user: own.user, addresses: { base: own.addresses.base, solana: ok(own.addresses.solana) ? own.addresses.solana : null } });
  });
}

/** Where the sign-in form sends the person after a successful sign-in. Only the fund page is accepted. */
export const afterSignIn = (next) => (next === FUND_NEXT ? FUND_PATH : next === "terms" ? "/account/terms" : "/account/");
/** The destinations a signed hint may ride to through the sign-in page. */
export const boundNext = (next) => next === FUND_NEXT || next === "terms";
/** Hidden field the sign-in form carries when it was opened from the fund page. */
export const nextField = (next) => (next === FUND_NEXT || next === "terms" ? `<input type="hidden" name="next" value="${next}">` : "");

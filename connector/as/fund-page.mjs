// "Add funds" page at /fund. It is served by the sign-in server so it shares the origin (and the Privy session and
// embedded wallets) of the YEET sign-in page. The page script (login/fund.jsx) shows the person's own wallet address
// for a direct USDC transfer on Base or Solana first (QR code, wallet links, live balance), then card payment: Privy's
// deposit modal, which runs Stripe's embedded onramp (card, Apple Pay, Google Pay) inside this page, and the older
// Coinbase Onramp flow, which Privy opens in its own popup window.
import { randomBytes } from "node:crypto";
import { document } from "./auth-pages.mjs";

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
const FUND_BODY =
  '<div id="yeet-fund"><p role="status">Loading your YEET wallet…</p></div><script type="module" src="/account/privy-login/fund.js"></script>';

/**
 * GET /fund. Requires a YEET sign-in session; without one the person is sent to the sign-in page, which returns here.
 * enabled(): the Privy sign-in is configured (the page cannot work without it). session(req): the current session or null.
 */
export function fundRoutes(app, { enabled, session, loginPath = "/account/login" }) {
  app.get(FUND_PATH, (q, r) => {
    if (!enabled()) return r.sendStatus(404);
    r.set("Cache-Control", "no-store");
    if (!session(q)) return r.redirect(303, `${loginPath}?next=${FUND_NEXT}`);
    const nonce = randomBytes(24).toString("base64");
    r.set({
      "Content-Security-Policy": fundCsp(nonce),
      // Privy watches the Coinbase popup it opens (window.closed); a stricter opener policy would cut that link.
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    r.type("html").send(document(FUND_TITLE, FUND_BODY, nonce));
  });
}

/** Where the sign-in form sends the person after a successful sign-in. Only the fund page is accepted. */
export const afterSignIn = (next) => (next === FUND_NEXT ? FUND_PATH : "/account/");
/** Hidden field the sign-in form carries when it was opened from the fund page. */
export const nextField = (next) => (next === FUND_NEXT ? `<input type="hidden" name="next" value="${FUND_NEXT}">` : "");

// "Add funds" page at /fund. It is served by the sign-in server so it shares the origin (and the Privy session and
// embedded wallets) of the YEET sign-in page. The page script (login/fund.jsx) opens Privy's funding flow for USDC on
// Base; Privy opens Coinbase Onramp in its own popup window, where Coinbase shows Apple Pay or Google Pay.
import { randomBytes } from "node:crypto";
import { document } from "./auth-pages.mjs";

export const FUND_PATH = "/fund";
/** The only post-sign-in destination the sign-in form accepts besides its default. */
export const FUND_NEXT = "fund";
/** Public Base RPC the page reads the USDC balance from (eth_call, read only). Keep in sync with login/fund-balance.js. */
export const BASE_RPC_ORIGIN = "https://mainnet.base.org";

/**
 * Content-Security-Policy for pages that run the Privy bundle: auth API, wallet RPC hosts, the wallet iframe and the
 * Turnstile challenge. `connect` adds connect-src origins, `formAction` replaces form-action.
 */
export function privyPageCsp(nonce, { connect = [], formAction = "'self'" } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
    `style-src 'self' 'nonce-${nonce}'`,
    ["connect-src 'self' https://auth.privy.io https://*.rpc.privy.systems", ...connect].join(" "),
    "frame-src https://auth.privy.io https://challenges.cloudflare.com",
    "child-src https://auth.privy.io https://challenges.cloudflare.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

export const fundCsp = (nonce) => privyPageCsp(nonce, { connect: [BASE_RPC_ORIGIN] });

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

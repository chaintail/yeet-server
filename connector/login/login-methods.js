// Which sign-in methods the sign-in page shows. Read from the Privy app's public configuration, so a method that is
// switched off in the Privy dashboard never appears as a button that cannot work. No React, no network: the page
// passes in the app configuration the Privy client loaded (usePrivyClient_experimental().app.getConfig(), the
// AppResponse type of @privy-io/api-types as installed with @privy-io/react-auth 3.47.0).

/** Every method the page can offer, in the order it shows them. `key` is the AppResponse flag that turns it on. */
export const METHODS = Object.freeze([
  { id: "google", label: "Google", key: "google_oauth", oauth: true },
  { id: "apple", label: "Apple", key: "apple_oauth", oauth: true },
  { id: "email", label: "email", key: "email_auth" },
]);

/** PrivyClientConfig.loginMethods names (LoginMethod in the 3.47.0 types) for every method the page can offer. */
export const LOGIN_METHODS = Object.freeze(METHODS.map((m) => m.id));

/**
 * The methods turned on in the app configuration, in page order. Telegram also needs the bot the dashboard links to
 * the app (telegram_auth_config); without it Privy's Telegram flow cannot start. A missing or unreadable
 * configuration means no method.
 */
export function enabledMethods(appConfig) {
  if (!appConfig || typeof appConfig !== "object") return [];
  return METHODS.filter((m) => {
    if (appConfig[m.key] !== true) return false;
    if (m.id === "telegram") {
      const bot = appConfig.telegram_auth_config;
      return !!bot && typeof bot.bot_id === "string" && bot.bot_id !== "" && typeof bot.bot_name === "string" && bot.bot_name !== "";
    }
    return true;
  });
}

/**
 * The methods a page offers when the server names none: Google and Apple. The server's list is YEET_LOGIN_METHODS
 * (as/login-methods.mjs), sent with /account/identity-config and on the trade page; a page opened from an
 * account-bound link gets that account's own methods instead. Email is off by default because one person using an
 * emailed code and Google could hold two YEET accounts, and YEET never merges accounts.
 */
export const DEFAULT_OFFERED = Object.freeze(["google", "apple"]);

/** "google,email" or ["google","email"] -> the known ids in page order; null when it names nothing usable. */
export function methodIds(value) {
  const given = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids = LOGIN_METHODS.filter((id) => given.some((g) => typeof g === "string" && g.trim() === id));
  return ids.length ? ids : null;
}

/**
 * What the page shows: the methods the Privy app has on (enabledMethods) that are also offered here. `offered` is the
 * server's list or a signed link's; anything unusable falls back to DEFAULT_OFFERED, never to every method.
 */
export function offeredMethods(enabled, offered) {
  const ids = methodIds(offered) ?? DEFAULT_OFFERED;
  return (Array.isArray(enabled) ? enabled : []).filter((m) => ids.includes(m.id));
}

/** "a", "a or b", "a, b or c". */
const joinOr = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);

/** The line above the sign-in methods, naming only what is on. Null when nothing is on. `signup: false` (the limited
 *  beta is full): only the sign-in, no word about creating an account. */
export function introLine(methods, { signup = true } = {}) {
  if (!methods.length) return null;
  const names = methods.map((m) => (m.id === "email" ? "your email" : m.label));
  return signup ? `Sign in with ${joinOr(names)}. New here? Signing in creates your YEET account and wallets.` : `Sign in with ${joinOr(names)}.`;
}

/** Shown instead of any button when the app has no sign-in method turned on. */
export const NO_METHOD_LINE = "Sign-in opens shortly.";

/** What the trade page says when a Google or Apple account is not a YEET account (nothing is created there). */
export const NO_ACCOUNT_LINE = "No YEET account uses that one. Use the account you connected to ChatGPT with.";
/**
 * A Google or Apple return that did not end in a session on the trade page, by Privy's error code (PrivyErrorCode in
 * @privy-io/react-auth 3.51.4: user_does_not_exist when sign-up is off, oauth_user_denied when the person backed out).
 * "" means: say nothing.
 */
export function oauthRefusal(code) {
  if (code === "user_does_not_exist") return NO_ACCOUNT_LINE;
  if (code === "oauth_user_denied") return "";
  return "That did not finish. Try again.";
}

/**
 * The limited beta (as/beta-full.mjs). A sign-in Privy refused because the person is new and no spot is left: with
 * sign-up off (the server said the beta is full) Privy answers user_does_not_exist and creates nobody; Privy's own
 * user limit for the app answers max_accounts_reached (PrivyErrorCode USER_LIMIT_REACHED in @privy-io/react-auth
 * 3.51.4). Either way the page goes to the "beta is full" page. `error`: what Privy threw, or a flow's error state.
 */
export const PRIVY_USER_LIMIT = "max_accounts_reached";
export function betaFullRefusal(error, { signup = true } = {}) {
  const code = typeof error === "string" ? error : error?.privyErrorCode ?? error?.code;
  return code === PRIVY_USER_LIMIT || (!signup && code === "user_does_not_exist");
}
/** The "beta is full" page the server put on the sign-in field (data-full), or the web one when it is missing. */
export function betaFullPage(value) {
  return typeof value === "string" && /^\/account\/waitlist\?[A-Za-z0-9=&%_.-]{0,300}$/.test(value) ? value : "/account/waitlist?from=web";
}

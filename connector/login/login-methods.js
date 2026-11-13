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

/** "a", "a or b", "a, b or c". */
const joinOr = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`);

/** The line above the sign-in methods, naming only what is on. Null when nothing is on. */
export function introLine(methods) {
  if (!methods.length) return null;
  const names = methods.map((m) => (m.id === "email" ? "your email" : m.label));
  return `Sign in with ${joinOr(names)}. New here? Signing in creates your YEET account and wallets.`;
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

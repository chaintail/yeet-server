// Usernames people pick for themselves. Shown on the leaderboard in place of the default name (xp/board.mjs handle).
// 3 to 16 letters, digits or underscores, unique ignoring case, never a reserved name. Stored with the identity
// (identity-store.mjs). No React, no network.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 16;
export const USERNAME_PATTERN = "^[A-Za-z0-9_]{3,16}$";
const SHAPE = new RegExp(USERNAME_PATTERN);

/** Names nobody may take: they read as YEET itself, its staff or its partners. Matched without underscores and
 *  trailing digits, so "Admin_1" and "yeet99" are refused too. */
export const RESERVED = Object.freeze([
  "admin", "administrator", "yeet", "yeetwin", "skeet", "support", "help", "helpdesk", "staff", "team", "mod",
  "moderator", "official", "system", "root", "owner", "security", "billing", "chatgpt", "openai", "privy", "near",
  "nearintents", "null", "undefined", "anonymous",
]);

/** Error codes and the words people see for them (the sign-in server's account page and the yeet_set_username
 *  tool once the contract lists it). */
export const USERNAME_ERRORS = Object.freeze({
  INVALID_ARGUMENT: "Use 3 to 16 letters, numbers or underscores.",
  USERNAME_NOT_ALLOWED: "That username is reserved. Pick another one.",
  USERNAME_TAKEN: "That username is taken. Pick another one.",
});

export class UsernameError extends Error {
  constructor(code) {
    super(code);
    this.name = "UsernameError";
    this.code = code;
  }
}

/** The failure shape core answers with. */
export const usernameFailure = (code) => ({
  error: code,
  message: USERNAME_ERRORS[code] ?? USERNAME_ERRORS.INVALID_ARGUMENT,
  retryable: false,
});

/** {name, key} for a valid username (a leading @ and outer spaces are dropped); throws UsernameError otherwise.
 *  key is the lower-case form uniqueness is checked on. */
export function checkUsername(value) {
  if (typeof value !== "string") throw new UsernameError("INVALID_ARGUMENT");
  const name = value.trim().replace(/^@/, "");
  if (!SHAPE.test(name)) throw new UsernameError("INVALID_ARGUMENT");
  const key = name.toLowerCase();
  const bare = key.replace(/_/g, "").replace(/[0-9]+$/, "");
  if (RESERVED.includes(key) || RESERVED.includes(bare)) throw new UsernameError("USERNAME_NOT_ALLOWED");
  return { name, key };
}

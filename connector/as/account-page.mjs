// The signed-in account page (/account/): where to go next, the username field and a link to add funds.
// The username itself lives in core (core/username.mjs); this page only shows and posts it.
import { html } from "./auth-pages.mjs";
import { USERNAME_ERRORS, USERNAME_MAX, USERNAME_MIN, USERNAME_PATTERN } from "../core/username.mjs";

export const ACCOUNT_TITLE = "Your YEET account";
export const USERNAME_PATH = "/account/username";
export const USERNAME_SAVED = "Username saved. The leaderboard shows it now.";

/** The words for a core error code; anything unknown reads as a temporary problem. */
export const usernameMessage = (code) =>
  USERNAME_ERRORS[code] ?? "YEET could not save your username right now. Please try again.";

/**
 * csrf: the session's form token. username: the one set, or null. name: what the leaderboard shows now.
 * value: what to put back in the field after a refused save. error / saved: the line under the field.
 */
export function accountBody({ csrf, username = null, name = "", value, error = "", saved = false }) {
  const field = value ?? username ?? "";
  const shown = name ? `<p class="hint">The leaderboard shows you as <strong>${html(name)}</strong>.</p>` : "";
  const line = error
    ? `<p role="alert" class="notice" id="username-note">${html(error)}</p>`
    : `<p role="status" class="saved" id="username-note">${saved ? html(USERNAME_SAVED) : ""}</p>`;
  return `<p class="lead">You are signed in. Go back to ChatGPT to keep going.</p>`
    + `<form method="POST" action="${USERNAME_PATH}" class="profile"><input type="hidden" name="csrf" value="${html(csrf)}">`
    + `<label for="username">Username</label>${shown}`
    + `<input id="username" name="username" value="${html(field)}" minlength="${USERNAME_MIN}" maxlength="${USERNAME_MAX}" pattern="${USERNAME_PATTERN.slice(1, -1)}" autocomplete="username" autocapitalize="none" spellcheck="false" aria-describedby="username-rule username-note"${error ? ' aria-invalid="true"' : ""}>`
    + `<p class="hint" id="username-rule">3 to 16 letters, numbers or underscores.</p>`
    + `<button type="submit">Save username</button>${line}</form>`
    + `<a class="button secondary" href="/fund">Add funds</a>`;
}

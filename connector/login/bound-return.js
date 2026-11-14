// The sign-in page opened from an account-bound link (as/account-bound.mjs), without React or the network: what the
// page keeps across the trip to Google or Apple, and which screen it shows.
//
// Google and Apple send the person back to ONE fixed address, <origin>/account/login with no query: Privy matches
// allowed redirect addresses exactly, and the bound page's own address carries a hint that is different in every
// link. So the page keeps where it was (the destination and the hint) in this tab's sessionStorage before it leaves,
// and on the way back the bare page sends the browser to the bound address again. The SERVER verifies the hint
// again there, and again when the form is posted; what the tab kept only says where to go back to.
export const BOUND_KEY = "yeet-bound-return";
export const BOUND_FOR_MS = 15 * 60_000;
export const BOUND_CALLBACK_PATH = "/account/login";
export const BOUND_DESTINATIONS = Object.freeze(["fund", "terms"]);
const HINT = /^v1\.[A-Za-z0-9_-]{8,300}\.[A-Za-z0-9_-]{43}$/;

const valid = (c) => !!c && BOUND_DESTINATIONS.includes(c.next) && typeof c.hint === "string" && HINT.test(c.hint);
/** The bound context in a page address ("?next=fund&h=<hint>"), or null. */
export function boundContext(search) {
  const q = new URLSearchParams(search ?? "");
  const c = { next: q.get("next"), hint: q.get("h") };
  return valid(c) ? c : null;
}
/** The bound page's address for a context. Only ever a path on this origin. */
export const boundUrl = (c) => `${BOUND_CALLBACK_PATH}?next=${c.next}&h=${encodeURIComponent(c.hint)}`;
/** Google or Apple is sending the person back (Privy's parameters are in the address). */
export function fromProvider(search) {
  const q = new URLSearchParams(search ?? "");
  return q.has("privy_oauth_code") || q.has("privy_oauth_state");
}
/** Keeps the context for the trip. Storage that refuses is fine: the person then starts again from ChatGPT's link. */
export function keepBound(storage, context, now = Date.now()) {
  if (!valid(context)) return false;
  try {
    storage.setItem(BOUND_KEY, JSON.stringify({ next: context.next, hint: context.hint, at: now }));
    return true;
  } catch {
    return false;
  }
}
/** What was kept, while it is fresh and well formed; null otherwise. `take` removes it. */
export function keptBound(storage, { now = Date.now(), take = false } = {}) {
  try {
    const v = JSON.parse(storage.getItem(BOUND_KEY) ?? "null");
    if (take) storage.removeItem(BOUND_KEY);
    return valid(v) && Number.isFinite(v.at) && now - v.at >= 0 && now - v.at < BOUND_FOR_MS ? { next: v.next, hint: v.hint } : null;
  } catch {
    return null;
  }
}
/**
 * Which screen the bound page shows.
 *   loading   Privy is starting
 *   methods   nobody is here: the account's own sign-in methods
 *   submit    the person signed in on this page just now (also across Google or Apple): the form goes to the
 *             server, which decides whether they are the link's account
 *   confirm   Privy already knew someone when the page opened. Nothing is sent and nobody is logged out by itself:
 *             the person presses Continue, or presses Use another account (the only thing that ends that session)
 */
export function boundView({ ready, authenticated, startedHere }) {
  if (!ready) return "loading";
  if (!authenticated) return "methods";
  return startedHere ? "submit" : "confirm";
}

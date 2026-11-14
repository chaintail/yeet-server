// The sign-in page opened from an account-bound link (as/account-bound.mjs), without React or the network: where
// Google and Apple return to, and which screen the page shows.
//
// Google and Apple send the person back to ONE fixed address with no query, BOUND_CALLBACK_PATH: Privy matches
// allowed redirect addresses exactly, and the bound page's own address carries a hint that is different in every
// link. Only a bound sign-in ever returns there. What it is bound to is kept by the SERVER (an httpOnly cookie it
// set when it served the bound page): the server answers that address with the bound page again, or, when its
// cookie is missing or stale, with "This link has expired…" and nothing else. This page keeps nothing for the trip:
// there is no value in the browser's storage whose loss could turn a bound sign-in into an ordinary one.
export const BOUND_CALLBACK_PATH = "/account/login/bound";

/** Google or Apple is sending the person back (Privy's parameters are in the address). */
export function fromProvider(search) {
  const q = new URLSearchParams(search ?? "");
  return q.has("privy_oauth_code") || q.has("privy_oauth_state");
}
/**
 * The sign-in was started on this page: by a press here (`pressed`: an emailed code never leaves the page), or by
 * the press that sent the person to Google or Apple, who is now sending them back to this very page. Nothing kept
 * in storage says so, so nothing can be left behind to say it on a later visit.
 */
export const startedHere = ({ pressed, search }) => pressed === true || fromProvider(search);
/**
 * Which screen the bound page shows.
 *   loading   Privy is starting
 *   methods   nobody is here: the account's own sign-in methods
 *   submit    the person signed in on this page just now (also across Google or Apple): the form goes to the
 *             server, which decides whether they are the link's account
 *   confirm   Privy already knew someone when the page opened. Nothing is sent and nobody is logged out by itself:
 *             the person presses Continue, or presses Use another account (the only thing that ends that session)
 */
export function boundView({ ready, authenticated, startedHere: started }) {
  if (!ready) return "loading";
  if (!authenticated) return "methods";
  return started ? "submit" : "confirm";
}

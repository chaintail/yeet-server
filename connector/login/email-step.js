// The email step of the connect screen, with no React and no DOM (email-step.jsx draws it; email-step.test.mjs runs
// it against stand-ins). Right after a Google or Apple sign-in, a person whose Privy user has no email login gets one
// screen: "Check your email", the 6-digit code that was just sent to the address Google or Apple gave, Send again,
// Use a different email, Skip for now. With the code the email becomes a login of the SAME Privy user, which is what
// the trade card inside ChatGPT needs (only the emailed code works in its frame).
//
// Rules this file keeps:
//   - who sees it (needsEmailStep): the setting is on (YEET_SIGNUP_EMAIL_STEP, sent with /account/identity-config),
//     the page is the ordinary sign-in (never a page opened from an account-bound link), the person came through
//     Google or Apple, and their Privy user has no email login. A person who has one never sees it;
//   - nothing is created, merged, moved or switched. An address that is a login of ANOTHER Privy user is left where
//     it is: the person keeps going without it or types another address. Privy's transfer call is never made;
//   - the Privy user after the code must be the user from before it. Otherwise the step ends in `changed` and reports
//     nothing: the page then never posts the sign-in. The server checks the same again (as/signup-email.mjs);
//   - the step belongs to the Privy user it started with. Immediately before a code is sent and immediately before
//     a code is used, the user of the browser's session NOW is read again (`current`); so is it whenever the page
//     comes back into view (`check`). Anyone else, or nobody: `changed`, and no Privy call is made. A screen left
//     open while the browser's session became another person's can therefore not give that person an email;
//   - every code goes out through one function (send): 30 seconds after the first code to an address, 60 after the
//     second, 120 after that, and five codes per step at most, whichever button asked. The count survives a reload
//     (`store`: counts and times only, the address as a hash); a reload inside the wait sends nothing;
//   - it never stands in the way: Skip for now always ends it, and so does a server that cannot start it.
//
// createEmailStep({user, link, start, current, store, onChange, now})
//     -> {begin, confirm, resend, sendTo, different, skip, check, state}
//   user      the Privy user of the page's session as the React SDK has it (id, linkedAccounts)
//   link      {sendCode(email), linkWithCode(code) -> user}: useLinkEmail of @privy-io/react-auth, no Privy window
//   current   async () -> the Privy user id of the browser's session at this moment, or null (required)
//   store     {get() -> text or null, set(text)}: the page's sessionStorage entry; none: nothing is kept
//   start     () -> token: POST /account/email-step. The server's signed note of who started the step; it goes
//             back with the sign-in form, where the server compares it with who is signing in
//   onChange  (state) after every change
//
// state:
//   view      starting | code | email (no address to send to: type one) | taken (the address is another account's)
//             | changed (the session is no longer the person who started; the page stops)
//   typing    on the code screen, "Use a different email" was pressed: the email field shows under the code
//   masked    the address the code went to, as l•••@g•••.com          custom   the person typed that address
//   provider  Google | Apple        error   one line or null        wait   a call is open (`doing`: send | check)
//   sentAt    when the last code went out from this page (ms)      live   a code sent by this page can be entered
//   nextAt    when the next code to this address may go out (ms); resendIn(state, now) is the seconds until then
//   sendsLeft codes this step may still send
//   outcome   null while the step is open, then `linked` or `skipped`. `token` goes with either.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Seconds until the next code to the same address: after its first, its second, and every later one. */
export const RESEND_DELAYS = Object.freeze([30, 60, 120]);
export const RESEND_SECONDS = RESEND_DELAYS[0];
/** Codes one step sends at most, over every address and every reload of the page. */
export const MAX_SENDS = 5;

export const COPY = Object.freeze({
  title: "Check your email",
  title_email: "Add your email",
  line: (masked) => `Enter the code we just sent to ${masked}`,
  email_line: "Enter your email and we’ll send you a code.",
  code_label: "6-digit code",
  confirm: "Continue",
  checking: "Checking…",
  resend: "Send again",
  resend_in: (seconds) => `Send again in ${seconds}s`,
  different: "Use a different email",
  email_label: "Email",
  relay: "Signed up with a hidden or relay email? Use that exact same address.",
  send: "Send code",
  sending: "Sending…",
  skip: "Skip for now",
  starting: "One moment…",
  taken: (provider) => `That email already has its own YEET account. You can keep going with ${provider}, or use a different email.`,
  keep_going: (provider) => `Keep going with ${provider}`,
  bad_email: "Enter your email address, like name@example.com.",
  bad_code: "Enter the 6-digit code from the email.",
  refused: "That code didn’t work. Check the latest email from YEET, or press Send again.",
  rate: "Too many tries just now. Wait a minute, then try again.",
  send_failed: "The code didn’t go out. Press Send again, or skip for now.",
  wait: (seconds) => `You can get a new code for that email in ${seconds}s.`,
  no_more: "No more codes for now. Skip for now, and add your email later.",
  reloaded: "This page was loaded again, so the last code can’t be used here. Press Send again for a new one.",
  changed: "Something changed with your account, so nothing was connected. Go back to ChatGPT and connect YEET again.",
  start_over: "Start over",
});

/** l•••@g•••.com (the form the card and the trade page show; core/account-login.mjs maskEmail). */
export function maskEmail(email) {
  const m = typeof email === "string" ? /^([^\s@])[^\s@]*@([^\s@.])[^\s@]*\.([^\s@.]+)$/.exec(email) : null;
  return m ? `${m[1]}•••@${m[2]}•••.${m[3]}` : null;
}

/**
 * Who is here, from the Privy user of the React SDK (User.linkedAccounts): `email` is a linked email LOGIN,
 * `oauthEmail` the address Google (first) or Apple gave, which is no login by itself.
 */
export function personOf(user) {
  const accounts = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : [];
  const mail = (v) => (typeof v === "string" && EMAIL.test(v) ? v : null);
  const email = mail(accounts.find((a) => a?.type === "email")?.address);
  const google = accounts.find((a) => a?.type === "google_oauth"),
    apple = accounts.find((a) => a?.type === "apple_oauth");
  return {
    id: typeof user?.id === "string" && user.id ? user.id : null,
    email,
    google: !!google,
    apple: !!apple,
    oauthEmail: mail(google?.email) ?? mail(apple?.email),
    provider: google ? "Google" : apple ? "Apple" : null,
  };
}

/** Whether this person meets the step. `enabled`: the server's setting; `bound`: the page came from a signed link. */
export function needsEmailStep({ enabled, user, bound = false }) {
  if (enabled !== true || bound) return false;
  const p = personOf(user);
  return !!p.id && !p.email && (p.google || p.apple);
}

/**
 * Why Privy refused a step (PrivyClientError / PrivyApiError of @privy-io/react-auth 3.51.4: privyErrorCode, code,
 * status, message): `taken` the address is a login of ANOTHER Privy user (linked_to_another_user, or
 * account_transfer_required when the app offers a transfer, which this page never makes); `has_one` this user
 * already has an email login (cannot_link_more_of_type); `rate` (too_many_requests, 429); null: a wrong or expired
 * code, or an outage.
 */
export function linkProblem(e) {
  const text = `${e?.privyErrorCode ?? ""} ${e?.code ?? ""} ${e?.status ?? ""} ${e?.message ?? ""}`;
  if (/linked_to_another_user|account_transfer_required|another user|already (linked|exists|in use)/i.test(text)) return "taken";
  if (/cannot_link_more|already has an email/i.test(text)) return "has_one";
  if (/too_many_requests|too many|rate.?limit|\b429\b/i.test(text)) return "rate";
  return null;
}

/** Seconds until another code may be asked for; 0 when it may. */
export function resendIn(state, now = Date.now()) {
  if (!state?.nextAt) return 0;
  return Math.max(0, Math.ceil((state.nextAt - now) / 1000));
}

/** The Privy user id in an access token (its `sub`), unverified: for comparing with the step's own user only. */
export function tokenUser(token) {
  try {
    const part = String(token).split(".")[1];
    const sub = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

/** A short one-way mark of a text (cyrb53): what the browser keeps in place of a user id or an address. */
export function mark(text) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

/**
 * What the step remembers about the codes it sent: {u, n, a: {mark: [count, nextAt]}}. `u` marks the Privy user; a
 * record of anyone else, or one that does not read, is a new record.
 */
function sendLedger(store, userId) {
  const u = mark(userId);
  let kept = { u, n: 0, a: {} };
  try {
    const v = JSON.parse(store?.get?.() ?? "null");
    if (v && v.u === u && Number.isSafeInteger(v.n) && v.n >= 0 && v.a && typeof v.a === "object" && !Array.isArray(v.a)) kept = { u, n: v.n, a: v.a };
  } catch {
    /* a new record */
  }
  const key = (address) => mark(`${userId}|${String(address).toLowerCase()}`);
  const row = (address) => {
    const r = kept.a[key(address)];
    return Array.isArray(r) && Number.isSafeInteger(r[0]) && Number.isFinite(r[1]) ? r : [0, 0];
  };
  return {
    left: () => Math.max(0, MAX_SENDS - kept.n),
    nextAt: (address) => row(address)[1],
    sent(address, at) {
      const count = row(address)[0] + 1;
      const nextAt = at + RESEND_DELAYS[Math.min(count, RESEND_DELAYS.length) - 1] * 1000;
      kept.n += 1;
      kept.a[key(address)] = [count, nextAt];
      try {
        store?.set?.(JSON.stringify(kept));
      } catch {
        /* kept for this page only */
      }
      return nextAt;
    },
  };
}

/** Digits only, six at most: what the code field holds after typing or pasting "123 456" or "Code: 123456". */
export const codeDigits = (value) => String(value ?? "").replace(/[^0-9]/g, "").slice(0, 6);

export function createEmailStep({ user, link, start, current, store = null, onChange = () => {}, now = Date.now }) {
  const person = personOf(user);
  const ledger = sendLedger(store, person.id ?? "");
  const st = { view: "starting", typing: false, email: "", masked: null, custom: false, provider: person.provider ?? "Google", error: null, wait: false, doing: null, sentAt: 0, nextAt: 0, sendsLeft: ledger.left(), live: false, outcome: null, token: "" };
  let stopped = false;
  const snapshot = () => ({ ...st });
  // Once the step stopped (`changed`), nothing a call still open brings back can move it again.
  const set = (patch) => {
    if (stopped) return;
    Object.assign(st, patch);
    onChange(snapshot());
  };
  const open = () => st.outcome === null && !stopped;
  const finish = (outcome) => set({ outcome, wait: false, error: null });
  /** The session is no longer the person who started: the step ends, reports nothing, and calls nothing more. */
  function stop() {
    if (stopped) return;
    set({ view: "changed", typing: false, wait: false, error: null, token: "", outcome: null });
    stopped = true;
  }
  /** Whether the browser's session is, right now, the Privy user this step started with. */
  async function same() {
    if (!person.id || typeof current !== "function") return false;
    try {
      return (await current()) === person.id;
    } catch {
      return false;
    }
  }
  /** For the page: when it comes back into view, or its Privy user changes. */
  async function check() {
    if (!open()) return;
    if (!(await same())) stop();
  }
  const shown = (address, custom) => ({ view: "code", typing: false, email: address, masked: maskEmail(address), custom });

  /**
   * The ONE way a code goes out, whichever button asked: the wait for that address, the step's limit, who is here
   * now, then Privy. `custom`: the person typed the address.
   */
  async function send(address, custom) {
    const waiting = ledger.nextAt(address) > now();
    // A code to this address is still fresh: none goes out. The address on the screen keeps its countdown.
    if (waiting && address === st.email) return set({ typing: false, wait: false, error: null });
    if (waiting) return set({ wait: false, error: COPY.wait(Math.ceil((ledger.nextAt(address) - now()) / 1000)) });
    if (!ledger.left()) return set({ wait: false, error: COPY.no_more, sendsLeft: 0 });
    set({ wait: true, doing: "send", error: null });
    if (!(await same())) return stop();
    try {
      await link.sendCode(address);
    } catch (e) {
      const why = linkProblem(e);
      // The address is another account's: it stays there. Nothing was sent, nothing is kept.
      if (why === "taken") return set({ view: "taken", typing: false, wait: false, email: "", masked: null, live: false, nextAt: 0 });
      // An email login appeared meanwhile (another tab): that is the end this step is for.
      if (why === "has_one") return finish("linked");
      // The screen stays where the person can act: the typed address again, or Send again.
      const error = why === "rate" ? COPY.rate : COPY.send_failed;
      if (custom) return set({ wait: false, error });
      return set({ ...shown(address, false), wait: false, error, live: false, nextAt: 0 });
    }
    const at = now();
    const nextAt = ledger.sent(address, at);
    set({ ...shown(address, custom), wait: false, sentAt: at, nextAt, sendsLeft: ledger.left(), live: true });
  }

  /** The server's note first, then the code to the address Google or Apple gave. No address: the person types one. */
  async function begin() {
    if (st.view !== "starting" || st.wait) return;
    set({ wait: true });
    if (!(await same())) return stop();
    let token = "";
    try {
      token = await start();
    } catch {
      token = "";
    }
    // The server cannot start the step (it is off, or unreachable): the person connects as before, without it.
    if (typeof token !== "string" || !token) return finish("skipped");
    set({ token, wait: false });
    const address = person.oauthEmail;
    if (!address) return set({ view: "email" });
    // The page was loaded again while the last code to this address is fresh, or the step has no code left: nothing
    // goes out by itself. The code screen shows when Send again works.
    if (ledger.nextAt(address) > now()) return set({ ...shown(address, false), nextAt: ledger.nextAt(address), error: COPY.reloaded });
    if (!ledger.left()) return set({ ...shown(address, false), error: COPY.no_more });
    return send(address, false);
  }

  async function confirm(code) {
    if (!open() || st.wait || st.view !== "code") return;
    const value = String(code ?? "").trim();
    if (!/^[0-9]{6}$/.test(value)) return set({ error: COPY.bad_code });
    // No code of this page is out (it was loaded again): Privy has nothing to compare with.
    if (!st.live) return set({ error: ledger.left() ? COPY.reloaded : COPY.no_more });
    set({ wait: true, doing: "check", error: null });
    // Who is here NOW, before the code is used: the email must never become a login of anyone but the starter.
    if (!(await same())) return stop();
    let after;
    try {
      after = await link.linkWithCode(value);
    } catch (e) {
      const why = linkProblem(e);
      if (why === "taken") return set({ view: "taken", typing: false, wait: false, email: "", masked: null, live: false, nextAt: 0 });
      if (why === "has_one") return finish("linked");
      return set({ wait: false, error: why === "rate" ? COPY.rate : COPY.refused });
    }
    const who = personOf(after);
    // And after it: the session must still be the person who started. Anything else ends here and reports nothing.
    if (!who.id || who.id !== person.id) return stop();
    if (!who.email) return set({ wait: false, error: COPY.refused });
    finish("linked");
  }

  async function resend() {
    if (!open() || st.wait || st.view !== "code" || !st.email || resendIn(st, now()) > 0) return;
    return send(st.email, st.custom);
  }

  /** Use a different email: the field under the code, or the whole screen when no code is out (`taken`). */
  function different() {
    if (!open() || st.wait || st.view === "starting") return;
    if (st.view === "code") return set({ typing: !st.typing, error: null });
    set({ view: "email", typing: false, error: null });
  }
  async function sendTo(email) {
    if (!open() || st.wait || !(st.view === "email" || (st.view === "code" && st.typing))) return;
    const address = String(email ?? "").trim();
    if (!EMAIL.test(address)) return set({ error: COPY.bad_email });
    return send(address, true);
  }

  /** Skip for now, and "Keep going with Google": the account connects without an email login. */
  function skip() {
    if (!open()) return;
    finish("skipped");
  }

  return { begin, confirm, resend, sendTo, different, skip, check, state: snapshot };
}

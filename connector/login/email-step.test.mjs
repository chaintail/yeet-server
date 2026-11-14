// The email step of the connect screen (email-step.js), with no React and no network: who sees it, and the step
// itself against a stand-in for Privy's useLinkEmail and for POST /account/email-step.
import test from "node:test";
import assert from "node:assert/strict";
import { COPY, MAX_SENDS, RESEND_DELAYS, RESEND_SECONDS, codeDigits, createEmailStep, linkProblem, mark, maskEmail, needsEmailStep, personOf, resendIn, tokenUser } from "./email-step.js";

const google = (email = "luke@gmail.com") => ({ type: "google_oauth", email });
const apple = (email = null) => ({ type: "apple_oauth", email });
const emailLogin = (address) => ({ type: "email", address });
const wallet = { type: "wallet", walletClientType: "privy", chainType: "ethereum", address: "0x1" };
const person = (id, ...linkedAccounts) => ({ id: `did:privy:${id}`, linkedAccounts });
const LIAM = person("liam", google(), wallet);

const refuse = (code, status = 400) => Object.assign(Error(code), { privyErrorCode: code, status });
/** Privy and the server as the step calls them. `sent` / `codes`: what went out. */
function memory(text = null) {
  const m = { text, get: () => m.text, set: (v) => { m.text = v; } };
  return m;
}
function world({ user = LIAM, taken = [], start = async () => "note-1", after = null, sendFails = null, store = memory(), clock = 1_000_000 } = {}) {
  // `here`: the Privy user id of the browser's session right now (another tab can change it under the screen).
  const w = { sent: [], codes: [], starts: 0, states: [], clock, here: user?.id ?? null, asked: 0, store };
  let address = "";
  w.step = createEmailStep({
    user,
    link: {
      async sendCode(email) {
        if (sendFails) throw sendFails;
        if (taken.includes(`send:${email}`)) throw refuse("linked_to_another_user");
        w.sent.push(email);
        address = email;
      },
      async linkWithCode(code) {
        w.codes.push(code);
        if (code === "429429") throw refuse("too_many_requests", 429);
        if (code !== "123456") throw refuse("invalid_credentials", 401);
        if (taken.includes(address)) throw refuse("linked_to_another_user");
        return after ?? { ...user, linkedAccounts: [...user.linkedAccounts, emailLogin(address)] };
      },
    },
    start: async () => { w.starts++; return start(); },
    current: async () => { w.asked++; if (w.here instanceof Error) throw w.here; return w.here; },
    store,
    onChange: (s) => w.states.push(s),
    now: () => w.clock,
  });
  return w;
}

test("who sees the step: Google or Apple with no email login, on the ordinary sign-in, with the setting on", () => {
  assert.equal(needsEmailStep({ enabled: true, user: LIAM }), true);
  assert.equal(needsEmailStep({ enabled: true, user: person("ava", apple()) }), true, "Apple, also with no address");
  assert.equal(needsEmailStep({ enabled: true, user: person("bob", google("bob@gmail.com"), emailLogin("bob@work.example")) }), false, "already has an email login");
  assert.equal(needsEmailStep({ enabled: true, user: person("emil", emailLogin("eric@chaintail.example")) }), false, "came in with an emailed code");
  assert.equal(needsEmailStep({ enabled: true, user: person("w", wallet) }), false, "neither Google nor Apple");
  assert.equal(needsEmailStep({ enabled: true, user: null }), false);
  assert.equal(needsEmailStep({ enabled: true, user: { linkedAccounts: [google()] } }), false, "no user id, no step");
  assert.equal(needsEmailStep({ enabled: true, user: LIAM, bound: true }), false, "a page from an account-bound link never shows it");
});

test("the setting off: nobody sees the step, whatever the page was sent", () => {
  for (const enabled of [false, undefined, null, "true", 1]) assert.equal(needsEmailStep({ enabled, user: LIAM }), false, String(enabled));
});

test("who is here: the email login, and the address Google (first) or Apple gave", () => {
  assert.deepEqual(personOf(LIAM), { id: "did:privy:liam", email: null, google: true, apple: false, oauthEmail: "luke@gmail.com", provider: "Google" });
  assert.equal(personOf(person("ava", apple("x7k2@privaterelay.appleid.com"))).oauthEmail, "x7k2@privaterelay.appleid.com");
  assert.equal(personOf(person("both", apple("a@icloud.com"), google("g@gmail.com"))).oauthEmail, "g@gmail.com");
  assert.equal(personOf(person("bad", google("not an email"))).oauthEmail, null);
  assert.equal(personOf(person("ava", apple())).provider, "Apple");
  assert.equal(maskEmail("luke@gmail.com"), "l•••@g•••.com");
  assert.equal(maskEmail("nope"), null);
});

test("the code field keeps six digits from whatever is typed or pasted", () => {
  assert.equal(codeDigits("123 456"), "123456");
  assert.equal(codeDigits("Your code: 123456."), "123456");
  assert.equal(codeDigits("1234567"), "123456");
  assert.equal(codeDigits("abc"), "");
  assert.equal(codeDigits(null), "");
});

test("Privy's refusals: another user's address, an email login that is already there, the rate limit", () => {
  assert.equal(linkProblem(refuse("linked_to_another_user")), "taken");
  assert.equal(linkProblem(refuse("account_transfer_required")), "taken", "a transfer is never made: the address stays where it is");
  assert.equal(linkProblem(refuse("cannot_link_more_of_type")), "has_one");
  assert.equal(linkProblem(Error("User already has an email account linked.")), "has_one");
  assert.equal(linkProblem(refuse("too_many_requests", 429)), "rate");
  assert.equal(linkProblem(refuse("invalid_credentials", 401)), null);
  assert.equal(linkProblem(undefined), null);
});

test("the step: the code goes to the Google address by itself, the code links it, the note goes on", async () => {
  const w = world();
  assert.equal(w.step.state().view, "starting");
  await w.step.begin();
  assert.equal(w.starts, 1);
  assert.deepEqual(w.sent, ["luke@gmail.com"], "sent automatically, nothing typed");
  let s = w.step.state();
  assert.equal(s.view, "code");
  assert.equal(COPY.line(s.masked), "Enter the code we just sent to l•••@g•••.com");
  assert.equal(s.outcome, null);
  await w.step.confirm("123456");
  s = w.step.state();
  assert.equal(s.outcome, "linked");
  assert.equal(s.token, "note-1");
  await w.step.begin();
  assert.equal(w.starts, 1, "begin runs once");
});

test("a wrong code, a malformed one and the rate limit keep the person on the screen; none ends the step", async () => {
  const w = world();
  await w.step.begin();
  await w.step.confirm("12345");
  assert.equal(w.step.state().error, COPY.bad_code);
  assert.deepEqual(w.codes, [], "a malformed code never reaches Privy");
  await w.step.confirm("000000");
  assert.equal(w.step.state().error, COPY.refused);
  await w.step.confirm("429429");
  assert.equal(w.step.state().error, COPY.rate);
  assert.equal(w.step.state().view, "code");
  assert.equal(w.step.state().outcome, null);
  await w.step.confirm("123456");
  assert.equal(w.step.state().outcome, "linked");
});

test("Skip for now always ends the step, with the note and without an email", async () => {
  const w = world();
  await w.step.begin();
  w.step.skip();
  const s = w.step.state();
  assert.equal(s.outcome, "skipped");
  assert.equal(s.token, "note-1", "the server still compares who connects with who was asked");
  assert.deepEqual(w.codes, []);
  await w.step.confirm("123456");
  assert.deepEqual(w.codes, [], "nothing is linked after Skip");
  // Also when the code could not go out at all.
  const down = world({ sendFails: Error("network") });
  await down.step.begin();
  assert.equal(down.step.state().view, "code");
  assert.equal(down.step.state().error, COPY.send_failed);
  assert.equal(resendIn(down.step.state(), down.clock), 0, "Send again works at once after a failed send");
  down.step.skip();
  assert.equal(down.step.state().outcome, "skipped");
});

test("a server that cannot start the step (off, or unreachable): the person connects as before, nothing is sent", async () => {
  for (const start of [async () => { throw Error("email-step-404"); }, async () => "", async () => null]) {
    const w = world({ start });
    await w.step.begin();
    assert.equal(w.step.state().outcome, "skipped");
    assert.equal(w.step.state().token, "");
    assert.deepEqual(w.sent, []);
  }
});

test("the email is another account's (found when the code is entered): nothing is merged or switched, both ways out work", async () => {
  const w = world({ taken: ["luke@gmail.com"] });
  await w.step.begin();
  await w.step.confirm("123456");
  let s = w.step.state();
  assert.equal(s.view, "taken");
  assert.equal(s.outcome, null);
  assert.equal(COPY.taken(s.provider), "That email already has its own YEET account. You can keep going with Google, or use a different email.");
  assert.equal(COPY.keep_going(s.provider), "Keep going with Google");
  // Keep going with Google: connected without an email login.
  w.step.skip();
  assert.equal(w.step.state().outcome, "skipped");

  // Use a different email: one field, then the code for that address.
  const v = world({ taken: ["luke@gmail.com"] });
  await v.step.begin();
  await v.step.confirm("123456");
  v.step.different();
  assert.equal(v.step.state().view, "email");
  await v.step.sendTo("not an address");
  assert.equal(v.step.state().error, COPY.bad_email);
  await v.step.sendTo(" luke@work.example ");
  s = v.step.state();
  assert.equal(s.view, "code");
  assert.equal(s.masked, "l•••@w•••.example");
  assert.equal(s.custom, true);
  assert.deepEqual(v.sent, ["luke@gmail.com", "luke@work.example"]);
  await v.step.confirm("123456");
  assert.equal(v.step.state().outcome, "linked");
});

test("the email is another account's (found when the code is sent): the same screen, and Apple is named for Apple", async () => {
  const w = world({ user: person("ava", apple("ava@icloud.com")), taken: ["send:ava@icloud.com"] });
  await w.step.begin();
  const s = w.step.state();
  assert.equal(s.view, "taken");
  assert.equal(COPY.taken(s.provider), "That email already has its own YEET account. You can keep going with Apple, or use a different email.");
  assert.deepEqual(w.sent, []);
});

test("the session is another Privy user after the code: the step stops and reports nothing", async () => {
  const w = world({ after: person("someone-else", google(), emailLogin("luke@gmail.com")) });
  await w.step.begin();
  await w.step.confirm("123456");
  const s = w.step.state();
  assert.equal(s.view, "changed");
  assert.equal(s.outcome, null, "the page never posts the sign-in");
  assert.equal(s.token, "");
  w.step.skip();
  assert.equal(w.step.state().outcome, null, "Skip cannot carry a changed session on");
  // A user with no id is the same refusal.
  const x = world({ after: { linkedAccounts: [emailLogin("luke@gmail.com")] } });
  await x.step.begin();
  await x.step.confirm("123456");
  assert.equal(x.step.state().view, "changed");
});

test("an email login that is already there (linked in another tab) is the end the step is for", async () => {
  const w = world({ sendFails: refuse("cannot_link_more_of_type") });
  await w.step.begin();
  assert.equal(w.step.state().outcome, "linked");
});

test("Use a different email shows one field under the code; the new address gets the code", async () => {
  const w = world();
  await w.step.begin();
  w.step.different();
  assert.equal(w.step.state().view, "code");
  assert.equal(w.step.state().typing, true);
  await w.step.sendTo("x7k2m9@privaterelay.appleid.com");
  const s = w.step.state();
  assert.equal(s.typing, false);
  assert.equal(s.masked, "x•••@p•••.com");
  assert.deepEqual(w.sent, ["luke@gmail.com", "x7k2m9@privaterelay.appleid.com"]);
});

test("Send again waits out its cooldown, then sends to the same address", async () => {
  const w = world();
  await w.step.begin();
  assert.equal(resendIn(w.step.state(), w.clock), RESEND_SECONDS);
  await w.step.resend();
  assert.deepEqual(w.sent, ["luke@gmail.com"], "inside the cooldown nothing goes out");
  w.clock += (RESEND_SECONDS - 1) * 1000;
  assert.equal(resendIn(w.step.state(), w.clock), 1);
  w.clock += 1000;
  assert.equal(resendIn(w.step.state(), w.clock), 0);
  await w.step.resend();
  assert.deepEqual(w.sent, ["luke@gmail.com", "luke@gmail.com"]);
});

test("every code goes through one gate: 30 s, then 60 s, then 120 s per address, five codes per step", async () => {
  assert.deepEqual([...RESEND_DELAYS], [30, 60, 120]);
  assert.equal(MAX_SENDS, 5);
  const w = world();
  await w.step.begin();
  const waits = [];
  for (let i = 0; i < 4; i++) {
    waits.push(resendIn(w.step.state(), w.clock));
    w.clock += waits.at(-1) * 1000;
    await w.step.resend();
  }
  assert.deepEqual(waits, [30, 60, 120, 120]);
  assert.equal(w.sent.length, 5);
  assert.equal(w.step.state().sendsLeft, 0);
  // The sixth never goes out: not by Send again, not by typing an address.
  w.clock += 3600_000;
  await w.step.resend();
  assert.equal(w.step.state().error, COPY.no_more);
  w.step.different();
  await w.step.sendTo("luke@work.example");
  assert.equal(w.step.state().error, COPY.no_more);
  assert.equal(w.sent.length, 5);
  w.step.skip();
  assert.equal(w.step.state().outcome, "skipped", "the person still connects");
});

test("Use a different email with the SAME address does not get around the wait", async () => {
  const w = world();
  await w.step.begin();
  w.step.different();
  await w.step.sendTo("luke@gmail.com");
  assert.deepEqual(w.sent, ["luke@gmail.com"], "no second code");
  let s = w.step.state();
  assert.equal(s.view, "code");
  assert.equal(s.typing, false);
  assert.equal(s.error, null);
  assert.equal(resendIn(s, w.clock), RESEND_SECONDS, "the countdown is the one that was running");
  // Another address gets its code, and going back to the first one inside its wait is refused with the seconds.
  w.clock += 5000;
  w.step.different();
  await w.step.sendTo("luke@work.example");
  assert.deepEqual(w.sent, ["luke@gmail.com", "luke@work.example"]);
  w.step.different();
  await w.step.sendTo("LUKE@gmail.com");
  s = w.step.state();
  assert.equal(s.error, COPY.wait(25));
  assert.equal(s.email, "luke@work.example");
  assert.equal(w.sent.length, 2);
});

test("a reload inside the wait sends nothing by itself; the count and the wait come back from the store", async () => {
  const store = memory();
  const first = world({ store });
  await first.step.begin();
  assert.deepEqual(first.sent, ["luke@gmail.com"]);
  // What the browser keeps: counts and times. No address, no user id.
  assert.doesNotMatch(store.text, /liam|gmail|did:privy|@/);
  assert.deepEqual(Object.keys(JSON.parse(store.text)).sort(), ["a", "n", "u"]);
  // The page is loaded again 10 seconds later.
  const again = world({ store, clock: first.clock + 10_000 });
  await again.step.begin();
  let s = again.step.state();
  assert.deepEqual(again.sent, [], "no code by itself");
  assert.equal(s.view, "code");
  assert.equal(s.masked, "l•••@g•••.com");
  assert.equal(resendIn(s, again.clock), 20, "Send again in 20s");
  assert.equal(s.error, COPY.reloaded);
  await again.step.resend();
  assert.deepEqual(again.sent, []);
  // The code from before the reload cannot be used on this page, and is never handed to Privy.
  await again.step.confirm("123456");
  assert.deepEqual(again.codes, []);
  assert.equal(again.step.state().error, COPY.reloaded);
  // After the wait: Send again sends the second code, and the wait after it is the second one.
  again.clock += 20_000;
  await again.step.resend();
  assert.deepEqual(again.sent, ["luke@gmail.com"]);
  assert.equal(resendIn(again.step.state(), again.clock), 60);
  await again.step.confirm("123456");
  assert.equal(again.step.state().outcome, "linked");
  // A reload after the wait sends by itself, and counts.
  const third = world({ store, clock: again.clock + 600_000 });
  await third.step.begin();
  assert.deepEqual(third.sent, ["luke@gmail.com"]);
  assert.equal(third.step.state().sendsLeft, MAX_SENDS - 3);
  // Another person in the same browser starts with a clean count; a record that does not read is a clean count too.
  const ava = world({ store, user: person("ava", apple("ava@icloud.com")), clock: third.clock });
  assert.equal(ava.step.state().sendsLeft, MAX_SENDS);
  assert.equal(world({ store: memory("{not json") }).step.state().sendsLeft, MAX_SENDS);
  assert.equal(world({ store: null }).step.state().sendsLeft, MAX_SENDS);
  assert.notEqual(mark("did:privy:liam|luke@gmail.com"), mark("did:privy:liam|luke@work.example"));
});

test("the browser's session became someone else before the code is SENT: nothing is sent, the step stops", async () => {
  const w = world();
  w.here = "did:privy:someone-else";
  await w.step.begin();
  assert.equal(w.step.state().view, "changed");
  assert.equal(w.starts, 0, "not even the server is asked");
  assert.deepEqual(w.sent, []);
  // Later, on Send again and on a typed address.
  for (const act of [(v) => v.step.resend(), async (v) => { v.step.different(); await v.step.sendTo("x@work.example"); }]) {
    const v = world();
    await v.step.begin();
    v.clock += 31_000;
    v.here = "did:privy:someone-else";
    await act(v);
    assert.equal(v.step.state().view, "changed");
    assert.equal(v.step.state().token, "");
    assert.deepEqual(v.sent, ["luke@gmail.com"]);
  }
});

test("the browser's session became someone else before the code is USED: Privy is never called with it", async () => {
  for (const here of ["did:privy:someone-else", null, Error("no session")]) {
    const w = world();
    await w.step.begin();
    w.here = here;
    await w.step.confirm("123456");
    const s = w.step.state();
    assert.deepEqual(w.codes, [], "linkWithCode did not run");
    assert.equal(s.view, "changed");
    assert.equal(s.outcome, null);
    assert.equal(s.token, "");
    // Nothing brings the stopped screen back, even when the first person returns.
    w.here = LIAM.id;
    await w.step.confirm("123456");
    await w.step.resend();
    w.step.different();
    w.step.skip();
    await w.step.check();
    assert.deepEqual(w.codes, []);
    assert.equal(w.step.state().view, "changed");
    assert.equal(w.step.state().outcome, null);
  }
});

test("the user is read at the moment of each call, not remembered", async () => {
  const w = world();
  await w.step.begin();
  const before = w.asked;
  await w.step.confirm("000000");
  assert.equal(w.asked, before + 1);
  await w.step.confirm("123456");
  assert.equal(w.asked, before + 2);
  // A step with no way to read the live user never sends anything.
  const blind = createEmailStep({ user: LIAM, link: { sendCode: async () => assert.fail("sent"), linkWithCode: async () => assert.fail("linked") }, start: async () => "note" });
  await blind.begin();
  assert.equal(blind.state().view, "changed");
});

test("coming back to the page (focus, visibility, a changed Privy user): a stale screen stops before it is used", async () => {
  const w = world();
  await w.step.begin();
  await w.step.check();
  assert.equal(w.step.state().view, "code", "the same person: nothing happens");
  w.here = "did:privy:someone-else";
  await w.step.check();
  assert.equal(w.step.state().view, "changed");
  // A call that is still open when the step stops cannot finish it.
  let release;
  const slow = world();
  await slow.step.begin();
  const held = createEmailStep({
    user: LIAM,
    link: { sendCode: async () => {}, linkWithCode: () => new Promise((r) => { release = () => r({ ...LIAM, linkedAccounts: [...LIAM.linkedAccounts, emailLogin("luke@gmail.com")] }); }) },
    start: async () => "note",
    current: async () => slow.here,
  });
  await held.begin();
  const pending = held.confirm("123456");
  await new Promise((r) => setImmediate(r));
  slow.here = null;
  await held.check();
  release();
  await pending;
  assert.equal(held.state().view, "changed");
  assert.equal(held.state().outcome, null);
});

test("the user id in an access token", () => {
  const token = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  assert.equal(tokenUser(token({ sub: "did:privy:liam" })), "did:privy:liam");
  for (const bad of [token({}), token({ sub: 7 }), "harness-token", "", null, undefined, "a.b.c"]) assert.equal(tokenUser(bad), null);
});

test("no address from Apple: the person types one, with the line about hidden addresses", async () => {
  const w = world({ user: person("ava", apple()) });
  await w.step.begin();
  assert.equal(w.step.state().view, "email");
  assert.deepEqual(w.sent, []);
  assert.equal(COPY.relay, "Signed up with a hidden or relay email? Use that exact same address.");
  await w.step.sendTo("ava@icloud.com");
  assert.equal(w.step.state().view, "code");
});

test("wording: simple words only", () => {
  const lines = Object.values(COPY).map((v) => (typeof v === "function" ? v("Google") : v));
  for (const line of lines) assert.doesNotMatch(line, /\bsign(ing|ature)?\b|wallet|device|unlock/i, line);
  assert.equal(COPY.title, "Check your email");
  assert.equal(COPY.resend, "Send again");
  assert.equal(COPY.different, "Use a different email");
  assert.equal(COPY.skip, "Skip for now");
});

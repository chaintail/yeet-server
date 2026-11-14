// The email step of the connect screen (email-step.js), with no React and no network: who sees it, and the step
// itself against a stand-in for Privy's useLinkEmail and for POST /account/email-step.
import test from "node:test";
import assert from "node:assert/strict";
import { COPY, RESEND_SECONDS, codeDigits, createEmailStep, linkProblem, maskEmail, needsEmailStep, personOf, resendIn } from "./email-step.js";

const google = (email = "luke@gmail.com") => ({ type: "google_oauth", email });
const apple = (email = null) => ({ type: "apple_oauth", email });
const emailLogin = (address) => ({ type: "email", address });
const wallet = { type: "wallet", walletClientType: "privy", chainType: "ethereum", address: "0x1" };
const person = (id, ...linkedAccounts) => ({ id: `did:privy:${id}`, linkedAccounts });
const LIAM = person("liam", google(), wallet);

const refuse = (code, status = 400) => Object.assign(Error(code), { privyErrorCode: code, status });
/** Privy and the server as the step calls them. `sent` / `codes`: what went out. */
function world({ user = LIAM, taken = [], start = async () => "note-1", after = null, sendFails = null } = {}) {
  const w = { sent: [], codes: [], starts: 0, states: [], clock: 1_000_000 };
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
  assert.equal(resendIn(w.step.state(), w.clock), RESEND_SECONDS);
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

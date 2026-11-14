// The email step of the connect screen, drawn (the rules and every line of text: email-step.js). One screen right
// after a Google or Apple sign-in: the code that was just emailed, Send again, Use a different email, Skip for now.
//
// Privy: useLinkEmail of @privy-io/react-auth (3.51.4: sendCode({email}), linkWithCode({code}) -> {user}), the
// headless hook. No Privy window opens; the email becomes a login of the user who is signed in on this page.
//
// <EmailStep onDone={({token, outcome}) => ...} />
//   onDone   called once, when the person entered the code (`linked`) or went on without (`skipped`). `token` is the
//            server's note of who started the step ("" when the server did not start it); the sign-in form carries it.
//            It is never called when the session turned out to be someone else: the page stops there.
import React, { useEffect, useRef, useState } from "react";
import { usePrivy, useLinkEmail } from "@privy-io/react-auth";
import { COPY, codeDigits, createEmailStep, resendIn } from "./email-step.js";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";

/** POST /account/email-step: the server's note for the person signed in here. */
async function startOnServer(getAccessToken) {
  const token = await getAccessToken();
  if (!token) throw Error("no-token");
  const res = await fetch("/account/email-step", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ privy_access_token: token }),
  });
  if (!res.ok) throw Error(`email-step-${res.status}`);
  const body = await res.json();
  return typeof body?.step === "string" ? body.step : "";
}

/** The page heading (as/viewer/page.js draws it in the display type); the page's own heading comes back after. */
function useHeading(text) {
  const first = useRef(null);
  useEffect(() => {
    const h = document.getElementById("page-title");
    if (first.current === null) first.current = h?.querySelector(".visually-hidden")?.textContent || h?.textContent || "";
    if (text) globalThis.YeetPage?.title?.(text);
  }, [text]);
  useEffect(
    () => () => {
      if (first.current) globalThis.YeetPage?.title?.(first.current);
    },
    [],
  );
}

const onEnter = (action) => (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  action();
};

export function EmailStep({ onDone }) {
  const { user, getAccessToken, logout } = usePrivy();
  const { sendCode, linkWithCode } = useLinkEmail();
  // The hooks hand out new functions as the session changes; the step always calls the latest.
  const calls = useRef({});
  calls.current = { sendCode, linkWithCode, getAccessToken };
  const [state, setState] = useState(null);
  const [code, setCode] = useState(""),
    [email, setEmail] = useState(""),
    [, setTick] = useState(0);
  const step = useRef(null);
  const told = useRef(false);
  if (!step.current)
    step.current = createEmailStep({
      user,
      link: {
        sendCode: (address) => calls.current.sendCode({ email: address }),
        linkWithCode: async (value) => (await calls.current.linkWithCode({ code: value })).user,
      },
      start: () => startOnServer(calls.current.getAccessToken),
      onChange: setState,
    });
  const s = state ?? step.current.state();

  useEffect(() => {
    step.current.begin();
  }, []);
  useEffect(() => {
    if (!s.outcome || told.current) return;
    told.current = true;
    onDone({ token: s.token, outcome: s.outcome });
  }, [s.outcome, s.token, onDone]);
  // Send again counts down by the second.
  const waitS = resendIn(s);
  useEffect(() => {
    if (!waitS) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1000);
    return () => clearTimeout(timer);
  });
  // A new code went out, or the code was refused: the field is empty again.
  const refused = s.error === COPY.refused;
  useEffect(() => setCode(""), [s.sentAt, refused]);
  useHeading(s.view === "email" ? COPY.title_email : COPY.title);

  const confirm = (value = code) => step.current.confirm(value);
  function typed(value) {
    const digits = codeDigits(value);
    setCode(digits);
    // Six digits typed, pasted or filled in from the message: nothing more to press.
    if (digits.length === 6 && digits !== code) confirm(digits);
  }
  async function startOver() {
    try {
      await logout();
    } catch {
      /* the reload shows what the browser still holds */
    }
    location.reload();
  }

  const notice = (
    <p role="alert" className={s.error ? "notice" : undefined}>
      {words(s.error || "")}
    </p>
  );
  const skip = (
    <button type="button" className="link quiet" onClick={() => step.current.skip()}>
      {COPY.skip}
    </button>
  );
  const emailField = (
    <>
      <label htmlFor="yeet-step-email">{COPY.email_label}</label>
      <input
        id="yeet-step-email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={onEnter(() => step.current.sendTo(email))}
      />
      <p className="hint">{COPY.relay}</p>
      <button type="button" className={s.view === "code" ? "secondary" : undefined} disabled={s.wait} onClick={() => step.current.sendTo(email)}>
        {s.wait && s.doing === "send" ? COPY.sending : COPY.send}
      </button>
    </>
  );

  const screen = s.outcome ? "starting" : s.view;
  return (
    <Swap id={screen}>
      {screen === "starting" ? (
        <p role="status">{COPY.starting}</p>
      ) : screen === "changed" ? (
        <>
          <p role="alert" className="notice">
            {words(COPY.changed)}
          </p>
          <button type="button" onClick={startOver}>
            {COPY.start_over}
          </button>
        </>
      ) : screen === "taken" ? (
        <>
          <p className="lead">{words(COPY.taken(s.provider))}</p>
          <button type="button" onClick={() => step.current.skip()}>
            {COPY.keep_going(s.provider)}
          </button>
          <button type="button" className="secondary" onClick={() => step.current.different()}>
            {COPY.different}
          </button>
        </>
      ) : screen === "email" ? (
        <>
          <p>{COPY.email_line}</p>
          {emailField}
          {notice}
          {skip}
        </>
      ) : (
        <>
          <p className="lead">{COPY.line(s.masked)}</p>
          <label htmlFor="yeet-step-code" className="visually-hidden">
            {COPY.code_label}
          </label>
          <input
            id="yeet-step-code"
            className="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="••••••"
            aria-invalid={s.error ? "true" : undefined}
            value={code}
            onChange={(e) => typed(e.target.value)}
            onKeyDown={onEnter(() => confirm())}
            autoFocus
          />
          <button type="button" disabled={s.wait} onClick={() => confirm()}>
            {s.wait && s.doing === "check" ? COPY.checking : COPY.confirm}
          </button>
          {notice}
          <button type="button" className="link" disabled={s.wait || waitS > 0} onClick={() => step.current.resend()}>
            {waitS > 0 ? COPY.resend_in(waitS) : COPY.resend}
          </button>
          <button type="button" className="link quiet" aria-expanded={s.typing} disabled={s.wait} onClick={() => step.current.different()}>
            {COPY.different}
          </button>
          {s.typing ? emailField : null}
          {skip}
        </>
      )}
    </Swap>
  );
}

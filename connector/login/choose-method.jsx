// The sign-in methods as one component, shared by the connect screen (src.jsx) and the trade page's sign-in step
// (sign.jsx): Continue with Google, Continue with Apple, then email with a code, each only when the Privy app has it
// on (login-methods.js). The fields have no name, so a surrounding form never posts them.
//
// Props:
//   methods      enabledMethods(appConfig)
//   signup       true (the connect screen): a new person gets an account. false (the trade page): only an existing
//                YEET account can come in; nothing is ever created there.
//   intro        the line above the buttons (default: introLine(methods))
//   verifyLabel  the button under the code field (default "Sign in")
//   onStart      called when the person starts any method (also before the Google or Apple redirect)
//   pageNotice   a line from the page to show where the component shows its own errors (the trade page: a Google or
//                Apple sign-in that came back refused)
//   onFull       called instead of showing an error when Privy refused a new person for the limited beta
//                (login-methods.js betaFullRefusal): the connect screen then goes to the "beta is full" page
import React, { useEffect, useState } from "react";
import { usePrivy, useLoginWithEmail, useLoginWithOAuth, useLoginWithTelegram, usePrivyClient_experimental } from "@privy-io/react-auth";
import { betaFullRefusal, enabledMethods, introLine, offeredMethods } from "./login-methods.js";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";

// How long the page keeps asking the Privy client for the app configuration after Privy reports ready.
const CONFIG_WAIT_MS = 5000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Enter in a field inside the page's sign-in form runs `action` instead of posting that form. */
const onEnter = (action) => (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  action();
};

/**
 * The sign-in methods the Privy app has on, read from the app configuration the Privy client loaded at page load.
 * Null while it is still loading; [] when nothing is on or the configuration cannot be read.
 * `offered`: the ids this page offers (the server's YEET_LOGIN_METHODS, or the methods of the account a signed link
 * names); the result is cut to them, and to Google and Apple when the page was given no list.
 */
export function useEnabledMethods(offered) {
  const { ready } = usePrivy();
  const client = usePrivyClient_experimental();
  const [methods, setMethods] = useState(null);
  useEffect(() => {
    if (!ready) return;
    const started = Date.now();
    let timer;
    const look = () => {
      let config;
      try {
        config = client?.app?.getConfig();
      } catch {
        config = undefined;
      }
      if (config || Date.now() - started >= CONFIG_WAIT_MS) return setMethods(offeredMethods(enabledMethods(config), offered));
      timer = setTimeout(look, 250);
    };
    look();
    return () => clearTimeout(timer);
    // `offered` is fixed for the life of a page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, client]);
  return methods;
}

/**
 * Email one-time code, then Google, Apple, X and Telegram, each only when the app has it on.
 */
export function ChooseMethod({ methods, signup = true, intro, verifyLabel = "Sign in", onStart, pageNotice = "", onFull }) {
  const { ready } = usePrivy();
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sentTo, setSentTo] = useState(""),
    [error, setError] = useState("");
  const { initOAuth, loading } = useLoginWithOAuth();
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const { login: loginWithTelegram, state: telegramState } = useLoginWithTelegram();
  const sending = state.status === "sending-code",
    checking = state.status === "submitting-code",
    telegramBusy = telegramState?.status === "loading";
  const busy = !ready || loading || sending || checking || telegramBusy;
  const emailOn = methods.some((m) => m.id === "email");
  const others = methods.filter((m) => m.id !== "email");
  const started = () => onStart?.();
  /** True when the refusal was the limited beta's and the page is going to the "beta is full" page. */
  const full = (e) => {
    if (!onFull || !betaFullRefusal(e, { signup })) return false;
    onFull();
    return true;
  };

  async function send() {
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError("Enter your email address, like name@example.com.");
      return;
    }
    setError("");
    try {
      await sendCode({ email: address, disableSignup: !signup });
      setSentTo(address);
      setCode("");
    } catch (e) {
      if (full(e)) return;
      setError("We could not send a code to that address. Check it and try again.");
    }
  }
  async function verify() {
    const value = code.trim();
    if (!/^[0-9]{6}$/.test(value)) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    setError("");
    try {
      await loginWithCode({ code: value });
    } catch (e) {
      if (full(e)) return;
      setError(
        signup
          ? "That code did not work. Check the latest email from YEET or send a new code."
          : "That did not work. Check the latest code, or use the account you connected to ChatGPT with.",
      );
    }
  }
  async function social(provider) {
    setError("");
    try {
      await initOAuth({ provider, disableSignup: !signup });
    } catch (e) {
      if (full(e)) return;
      setError(signup ? "Sign in could not start. Please try again." : "That could not start in this window. Try again, or open this page in your browser.");
    }
  }
  async function telegram() {
    setError("");
    try {
      await loginWithTelegram({ disableSignup: !signup });
    } catch (e) {
      if (full(e)) return;
      setError("Telegram sign in did not finish. Please try again.");
    }
  }
  const start = (m) => (m.oauth ? social(m.id) : telegram());

  const notice = (
    <p role="alert" className={error || pageNotice ? "notice" : undefined}>
      {words(error || pageNotice || "")}
    </p>
  );
  return (
    <Swap id={sentTo ? "code" : "choose"}>
      {sentTo ? (
        <>
          <p>
            We sent a 6-digit code to <strong>{sentTo}</strong>. It can take a minute to arrive.
          </p>
          <label htmlFor="yeet-code">Code from the email</label>
          <input
            id="yeet-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={onEnter(verify)}
            autoFocus
          />
          <button type="button" disabled={busy} onClick={verify}>
            {checking ? "Checking…" : verifyLabel}
          </button>
          {notice}
          <button type="button" className="secondary" disabled={busy} onClick={send}>
            {sending ? "Sending…" : "Send a new code"}
          </button>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setSentTo("");
              setCode("");
              setError("");
            }}
          >
            Use a different email
          </button>
        </>
      ) : (
        <>
          <p>{words(intro ?? introLine(methods, { signup }))}</p>
          {others.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={i > 0 ? "secondary" : undefined}
              disabled={busy}
              onClick={() => {
                started();
                start(m);
              }}
            >
              {m.id === "telegram" && telegramBusy ? "Waiting for Telegram…" : `Continue with ${m.label}`}
            </button>
          ))}
          {emailOn && others.length ? (
            <p className="divider">
              <span>or</span>
            </p>
          ) : null}
          {emailOn ? (
            <>
              <label htmlFor="yeet-email">Email</label>
              <input
                id="yeet-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={onEnter(() => {
                  started();
                  send();
                })}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  started();
                  send();
                }}
              >
                {sending ? "Sending code…" : "Email me a code"}
              </button>
              {notice}
            </>
          ) : null}
          {emailOn ? null : notice}
        </>
      )}
    </Swap>
  );
}

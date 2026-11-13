import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithTelegram,
  usePrivyClient_experimental,
  useUser,
} from "@privy-io/react-auth";
import { privyConfig } from "./privy-app.jsx";
import { NO_METHOD_LINE, enabledMethods, introLine } from "./login-methods.js";
import {
  CHAINS,
  embeddedWallets,
  requestServerSetup,
  setupErrorReport,
} from "./wallet-setup.js";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";

// How long the page keeps asking the Privy client for the app configuration after Privy reports ready.
const CONFIG_WAIT_MS = 5000;

// How long wallet setup may run before the page shows the "taking longer" notice and a Try again button.
const WALLET_WAIT_MS = 20000;

// The server sets up both wallets in one call; the step list moves to the Solana step after this long.
const STEP_TICK_MS = 1200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EndSession() {
  const { ready, logout } = usePrivy();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await logout();
            location.assign("/account/login");
          } catch {
            setError("Sign out could not finish. Please try again.");
            setBusy(false);
          }
        }}
      >
        Sign out
      </button>
      <p role="status">{words(error)}</p>
    </>
  );
}

/** Enter in a field inside the page's sign-in form runs `action` instead of posting that form. */
const onEnter = (action) => (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  action();
};

/**
 * The sign-in methods the Privy app has on, read from the app configuration the Privy client loaded at page load.
 * Null while it is still loading; [] when nothing is on or the configuration cannot be read.
 */
function useEnabledMethods() {
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
      if (config || Date.now() - started >= CONFIG_WAIT_MS) return setMethods(enabledMethods(config));
      timer = setTimeout(look, 250);
    };
    look();
    return () => clearTimeout(timer);
  }, [ready, client]);
  return methods;
}

/**
 * Email one-time code, then Google, Apple, X and Telegram, each only when the app has it on. The fields have no
 * name, so the page form never posts them.
 */
function ChooseMethod({ methods }) {
  const { ready } = usePrivy();
  const { initOAuth, loading } = useLoginWithOAuth();
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const { login: loginWithTelegram, state: telegramState } = useLoginWithTelegram();
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sentTo, setSentTo] = useState(""),
    [error, setError] = useState("");
  const sending = state.status === "sending-code",
    checking = state.status === "submitting-code",
    telegramBusy = telegramState?.status === "loading";
  const busy = !ready || loading || sending || checking || telegramBusy;
  const emailOn = methods.some((m) => m.id === "email");
  const others = methods.filter((m) => m.id !== "email");

  async function send() {
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError("Enter your email address, like name@example.com.");
      return;
    }
    setError("");
    try {
      await sendCode({ email: address, disableSignup: false });
      setSentTo(address);
      setCode("");
    } catch {
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
    } catch {
      setError("That code did not work. Check the latest email from YEET or send a new code.");
    }
  }
  async function social(provider) {
    setError("");
    try {
      await initOAuth({ provider, disableSignup: false });
    } catch {
      setError("Sign in could not start. Please try again.");
    }
  }
  async function telegram() {
    setError("");
    try {
      await loginWithTelegram({ disableSignup: false });
    } catch {
      setError("Telegram sign in did not finish. Please try again.");
    }
  }
  const start = (m) => (m.oauth ? social(m.id) : telegram());

  const notice = (
    <p role="alert" className={error ? "notice" : undefined}>
      {words(error)}
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
            {checking ? "Checking…" : "Sign in"}
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
          <p>{words(introLine(methods))}</p>
          {others.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={i > 0 ? "secondary" : undefined}
              disabled={busy}
              onClick={() => {
                markStarted();
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
                  markStarted();
                  send();
                })}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  markStarted();
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

/** Set when the person starts a sign-in on this page; read once after it (also across the Google or Apple redirect). */
const STARTED_KEY = "yeet-sign-in-started";
function markStarted() {
  try {
    sessionStorage.setItem(STARTED_KEY, "1");
  } catch {
    /* without storage the person presses Continue once more */
  }
}
function takeStarted() {
  try {
    const v = sessionStorage.getItem(STARTED_KEY) === "1";
    sessionStorage.removeItem(STARTED_KEY);
    return v;
  } catch {
    return false;
  }
}
/** What to call the signed-in person on the Continue button: their email, as Privy has it. */
export function accountLabel(user) {
  return user?.email?.address || user?.google?.email || user?.apple?.email || "your YEET account";
}

/** Puts the Privy access token on the page form and submits it; the server then opens the YEET session. */
async function submitSession(getAccessToken) {
  const token = await getAccessToken();
  if (!token) throw Error("no-token");
  const form = document.getElementById("privy-login").closest("form");
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "privy_access_token";
  input.value = token;
  form.append(input);
  form.requestSubmit();
}

/**
 * Signed in. When a wallet is missing (the person signed up while Privy did not create wallets at login), the page
 * creates it, links both wallets to the YEET signer and continues on its own, showing each step. When both wallets
 * are already there, the person taps Continue to YEET, which links them (if needed) and continues.
 */
function FinishSignIn({ config }) {
  const { ready, user, getAccessToken, logout } = usePrivy();
  const { refreshUser } = useUser();
  const userRef = useRef(user);
  userRef.current = user;
  const wallets = embeddedWallets(user);
  // Decided once: a person who arrives without both wallets goes through the automatic setup screen.
  const [setup] = useState(() => !wallets.base || !wallets.solana);
  const [step, setStep] = useState("check"),
    [done, setDone] = useState([]),
    [attempt, setAttempt] = useState(0),
    [slow, setSlow] = useState(false),
    [setupFailed, setSetupFailed] = useState(false),
    [failMessage, setFailMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);
  // The sign-in was started on this page a moment ago: that press is the one this connection needs, so go straight on.
  const [auto] = useState(() => takeStarted());
  const went = useRef(false);

  /** Server setup: the server creates any missing wallet (no signer is attached: the person signs every trade). */
  async function serverSetup() {
    await requestServerSetup({ getAccessToken });
    await refreshUser().catch(() => null);
  }

  async function runSetup() {
    running.current = true;
    setSetupFailed(false);
    setFailMessage("");
    setDone([]);
    setStep("base");
    const tick = setTimeout(() => {
      setDone(["base"]);
      setStep("solana");
    }, STEP_TICK_MS);
    try {
      await requestServerSetup({ getAccessToken });
      clearTimeout(tick);
      setDone([...CHAINS]);
      setStep("link");
      await refreshUser().catch(() => null);
      setDone([...CHAINS, "link"]);
      await submitSession(getAccessToken);
    } catch (e) {
      clearTimeout(tick);
      // No client-error endpoint on the server yet: a structured, secret-free line in the browser console.
      console.error(JSON.stringify(setupErrorReport(e, userRef.current)));
      setFailMessage(e?.serverMessage || "");
      setSetupFailed(true);
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    if (!setup || !ready || running.current) return;
    runSetup();
    // runSetup reads the latest hooks; it runs once per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, ready, attempt]);

  useEffect(() => {
    if (!setup) return;
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), WALLET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [setup, attempt]);

  function retry() {
    // A create call that is still open cannot be cancelled; reloading starts clean from the stored session.
    if (running.current) return location.reload();
    setAttempt((n) => n + 1);
  }

  async function continueLogin() {
    setBusy(true);
    setError("");
    try {
      await serverSetup();
    } catch (e) {
      console.error(JSON.stringify(setupErrorReport(e, user)));
      setSetupFailed(true);
      setError(
        e?.serverMessage ||
          (e?.code === "wallets-not-ready"
            ? "Your YEET wallets are still being set up. Try again in a moment."
            : "YEET could not finish connecting. Nothing was charged. Try again."),
      );
      setBusy(false);
      return;
    }
    setSetupFailed(false);
    try {
      await submitSession(getAccessToken);
    } catch {
      setError("Sign in could not continue. Please try again.");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (setup || !auto || !ready || went.current) return;
    went.current = true;
    continueLogin();
    // continueLogin reads the latest hooks; it runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, auto, ready]);

  if (setup)
    return (
      <>
        <p role="status" aria-live="polite">
          {words(setupFailed ? failMessage || "YEET could not finish connecting. Nothing was charged." : slow ? "Still connecting. This can take a moment." : "Connecting YEET to ChatGPT…")}
        </p>
        {setupFailed || slow ? (
          <button type="button" onClick={retry}>
            Try again
          </button>
        ) : null}
        <button type="button" className="secondary" onClick={logout}>
          Use another account
        </button>
      </>
    );

  return (
    <>
      <button type="button" disabled={!ready || busy} onClick={continueLogin}>
        {busy ? "Connecting…" : setupFailed ? "Try again" : `Continue as ${accountLabel(user)}`}
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={logout}>
        Use another account
      </button>
      <p role="alert" className={error ? "notice" : undefined}>
        {words(error)}
      </p>
    </>
  );
}

const LOADING = <p role="status">Loading secure sign in…</p>;

function SignIn({ config }) {
  const { ready, authenticated } = usePrivy();
  const methods = useEnabledMethods();
  // Every sign-in method ends here, so the YEET signer step runs after email, Google, Apple, X and Telegram alike.
  const screen = !ready ? "loading" : authenticated ? "finish" : methods === null ? "loading" : !methods.length ? "none" : "methods";
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        LOADING
      ) : screen === "finish" ? (
        <FinishSignIn config={config} />
      ) : screen === "none" ? (
        <p role="status">{words(NO_METHOD_LINE)}</p>
      ) : (
        <ChooseMethod methods={methods} />
      )}
    </Swap>
  );
}

try {
  const response = await fetch("/account/identity-config", {
    credentials: "same-origin",
  });
  if (!response.ok) throw Error();
  const config = await response.json();
  createRoot(document.getElementById("privy-login")).render(
    <PrivyProvider appId={config.appId} config={privyConfig()}>
      {document.getElementById("privy-login").dataset.mode === "logout" ? (
        <EndSession />
      ) : (
        <SignIn config={config} />
      )}
    </PrivyProvider>,
  );
} catch {
  const line = document.createElement("p");
  line.className = "notice";
  line.setAttribute("role", "alert");
  line.textContent = "Secure sign in is unavailable. Please try again later.";
  document.getElementById("privy-login").replaceChildren(line);
}

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useUser, useLoginWithOAuth } from "@privy-io/react-auth";
import { privyConfig } from "./privy-app.jsx";
import { NO_METHOD_LINE, oauthRefusal, betaFullRefusal, betaFullPage } from "./login-methods.js";
import { BOUND_CALLBACK_PATH, boundView, fromProvider, startedHere } from "./bound-return.js";
import { ChooseMethod, useEnabledMethods } from "./choose-method.jsx";
import { needsEmailStep } from "./email-step.js";
import { EmailStep } from "./email-step.jsx";
import {
  CHAINS,
  embeddedWallets,
  requestServerSetup,
  setupErrorReport,
} from "./wallet-setup.js";
import { words } from "./brand-words.jsx";
import { Swap } from "./screen.jsx";

// How long wallet setup may run before the page shows the "taking longer" notice and a Try again button.
const WALLET_WAIT_MS = 20000;

// The server sets up both wallets in one call; the step list moves to the Solana step after this long.
const STEP_TICK_MS = 1200;

/**
 * The limited beta is full and this person has no YEET account (as/beta-full.mjs): the Privy session is ended (so the
 * "Sign in" line there starts clean) and the page goes to the "beta is full" page the server put on the field.
 */
async function toBetaFull(logout) {
  clearStarted();
  try {
    await logout?.();
  } catch {
    /* the page goes on either way */
  }
  location.assign(betaFullPage(document.getElementById("privy-login")?.dataset.full));
}

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

/** Set when the person starts a sign-in on this page; read once after it (also across the Google or Apple redirect). */
const STARTED_KEY = "yeet-sign-in-started";
function markStarted() {
  try {
    sessionStorage.setItem(STARTED_KEY, "1");
  } catch {
    /* without storage the person presses Continue once more */
  }
}
function clearStarted() {
  try {
    sessionStorage.removeItem(STARTED_KEY);
  } catch {
    /* nothing kept */
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

/**
 * Puts the Privy access token on the page form and submits it; the server then opens the YEET session.
 * `emailStep`: the server's note from the email step (email-step.jsx), when that step ran. The server compares it
 * with who is signing in (as/signup-email.mjs).
 */
async function submitSession(getAccessToken, emailStep = "") {
  const token = await getAccessToken();
  if (!token) throw Error("no-token");
  const form = document.getElementById("privy-login").closest("form");
  const field = (name, value) => {
    form.querySelector(`input[type=hidden][name="${name}"]`)?.remove();
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  };
  field("privy_access_token", token);
  if (emailStep) field("email_step", emailStep);
  form.requestSubmit();
}

/**
 * Signed in. When a wallet is missing (the person signed up while Privy did not create wallets at login), the page
 * creates it, links both wallets to the YEET signer and continues on its own, showing each step. When both wallets
 * are already there, the person taps Continue to YEET, which links them (if needed) and continues.
 *
 * The email step (email-step.jsx) comes first for a person who came through Google or Apple and has no email login:
 * right away when the page goes on by itself (the sign-in was started here, or the wallets are being set up), after
 * the press on Continue otherwise. `gate`: step (the step shows) | ask (Continue leads to the step) | open (go on).
 * Whether the person entered the code or skipped, the page then goes on exactly as it would have.
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
  // Decided once, from the person as they arrived: entering the code gives them an email login, and the step stays.
  const [gate, setGate] = useState(() => (needsEmailStep({ enabled: config.emailStep, user }) ? (setup || auto ? "step" : "ask") : "open"));
  const [stepped, setStepped] = useState(false);
  const emailStep = useRef("");
  const afterStep = useRef(({ token }) => {
    emailStep.current = token || "";
    setStepped(true);
    setGate("open");
  }).current;

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
      await submitSession(getAccessToken, emailStep.current);
    } catch (e) {
      clearTimeout(tick);
      // A new person while the beta is full: the server created no account and no wallet.
      if (e?.code === "BETA_FULL") return toBetaFull(logout);
      // No client-error endpoint on the server yet: a structured, secret-free line in the browser console.
      console.error(JSON.stringify(setupErrorReport(e, userRef.current)));
      setFailMessage(e?.serverMessage || "");
      setSetupFailed(true);
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    if (!setup || !ready || gate !== "open" || running.current) return;
    runSetup();
    // runSetup reads the latest hooks; it runs once per attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, ready, attempt, gate]);

  useEffect(() => {
    if (!setup || gate !== "open") return;
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), WALLET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [setup, attempt, gate]);

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
      if (e?.code === "BETA_FULL") return toBetaFull(logout);
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
      await submitSession(getAccessToken, emailStep.current);
    } catch {
      setError("Sign in could not continue. Please try again.");
      setBusy(false);
    }
  }

  useEffect(() => {
    // After the email step the page goes on by itself too: the person already pressed Continue, or started here.
    if (setup || !(auto || stepped) || !ready || gate !== "open" || went.current) return;
    went.current = true;
    continueLogin();
    // continueLogin reads the latest hooks; it runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, auto, stepped, ready, gate]);

  if (gate === "step") return <EmailStep onDone={afterStep} />;

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
      <button type="button" disabled={!ready || busy} onClick={gate === "ask" ? () => setGate("step") : continueLogin}>
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
  const { ready, authenticated, logout } = usePrivy();
  // false while the limited beta is full (as.mjs /account/identity-config): Privy signs in existing users only.
  const signup = config.signup !== false;
  // Only the methods the server offers here (YEET_LOGIN_METHODS, sent with /account/identity-config).
  const methods = useEnabledMethods(config.methods);
  // A Google or Apple return that failed: that sign-in is over, and so is its "started here" flag.
  const { state: oauth } = useLoginWithOAuth();
  const oauthFailed = oauth?.status === "error";
  // A Google or Apple return Privy refused for the limited beta: the "beta is full" page.
  const oauthFull = oauthFailed && betaFullRefusal(oauth.error, { signup });
  useEffect(() => {
    if (oauthFailed) clearStarted();
    if (oauthFull) toBetaFull(logout);
    // logout is stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthFailed, oauthFull]);
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
        <ChooseMethod methods={methods} signup={signup} onStart={markStarted} onFull={() => toBetaFull(logout)} />
      )}
    </Swap>
  );
}

/**
 * The sign-in page opened from an account-bound link (as/account-bound.mjs; the funding page, or the terms page
 * whose own token ran out). The server put that account's methods on the page (data-methods). Differences from the
 * plain sign-in, all on purpose:
 *   - nothing is created (signup off) and no wallet set-up is asked for: this page only lets an existing account in;
 *   - the SERVER compares who signed in with the link's account and refuses anyone else. Nothing here decides that;
 *   - Google and Apple return to the fixed /account/login/bound (bound-return.js), which the server answers with
 *     this same bound page (its own cookie says for which link) or with the expired state. Nothing is kept in the
 *     browser's storage for the trip, and the "started here" flag of the ordinary sign-in is never set or read;
 *   - a session Privy already had when the page opened is neither sent nor ended by itself (boundView "confirm"):
 *     the person presses Continue, or Use another account. Nothing in the address can log anyone out.
 */
function BoundSignIn({ offered }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const methods = useEnabledMethods(offered);
  const [pressed, setPressed] = useState(false);
  // A Google or Apple return that was refused (the account must already exist): from the flow's own state.
  const { loading, state } = useLoginWithOAuth();
  const refusal = state?.status === "error" ? oauthRefusal(state.error?.privyErrorCode) : "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(false);
  const sent = useRef(false);
  const view = boundView({ ready, authenticated, startedHere: startedHere({ pressed, search: location.search }) });
  async function send() {
    if (sent.current) return;
    sent.current = true;
    setBusy(true);
    setError("");
    try {
      await submitSession(getAccessToken);
    } catch {
      sent.current = false;
      setBusy(false);
      setError("That could not continue. Please try again.");
    }
  }
  useEffect(() => {
    if (view === "submit") send();
    // send reads the latest hooks; it runs once per sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  /** The one place this page ends a session, and only from the button. */
  async function useAnother() {
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch {
      setError("That could not finish. Please try again.");
    }
    setBusy(false);
  }
  const screen = view === "methods" && methods === null ? "loading" : view === "methods" && !methods.length ? "none" : view;
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        LOADING
      ) : screen === "submit" ? (
        <p role={error ? "alert" : "status"} className={error ? "notice" : undefined}>
          {words(error || "That’s you. One moment…")}
        </p>
      ) : screen === "confirm" ? (
        <>
          <button type="button" disabled={busy} onClick={send}>
            {busy ? "One moment…" : `Continue as ${accountLabel(user)}`}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={useAnother}>
            Use another account
          </button>
          <p role="alert" className={error ? "notice" : undefined}>
            {words(error)}
          </p>
        </>
      ) : screen === "none" ? (
        <p role="status">{words(NO_METHOD_LINE)}</p>
      ) : (
        <ChooseMethod
          methods={methods}
          signup={false}
          intro="Use the account you connected to ChatGPT with."
          pageNotice={loading || seen ? "" : refusal}
          onStart={() => {
            setSeen(true);
            setPressed(true);
          }}
        />
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
  const host = document.getElementById("privy-login");
  const bound = host.dataset.bound === "1";
  // The ordinary sign-in's "started here" flag lives for one sign-in only. A bound page never uses it, and a visit
  // that is not a return from Google or Apple never inherits one (from a sign-in that failed, was left, or ended).
  if (bound || !fromProvider(location.search)) clearStarted();
  createRoot(host).render(
    <PrivyProvider appId={config.appId} config={bound ? { ...privyConfig(), customOAuthRedirectUrl: `${location.origin}${BOUND_CALLBACK_PATH}` } : privyConfig()}>
      {host.dataset.mode === "logout" ? (
        <EndSession />
      ) : bound ? (
        <BoundSignIn offered={host.dataset.methods} />
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

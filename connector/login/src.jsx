import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useUser, useLoginWithOAuth } from "@privy-io/react-auth";
import { privyConfig } from "./privy-app.jsx";
import { NO_METHOD_LINE, oauthRefusal } from "./login-methods.js";
import { ChooseMethod, useEnabledMethods } from "./choose-method.jsx";
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
  // Only the methods the server offers here (YEET_LOGIN_METHODS, sent with /account/identity-config).
  const methods = useEnabledMethods(config.methods);
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
        <ChooseMethod methods={methods} onStart={markStarted} />
      )}
    </Swap>
  );
}

/**
 * The sign-in page opened from an account-bound link (as/account-bound.mjs; the funding page, or the terms page
 * whose own token ran out). The server put that account's methods on the page (data-methods). Differences from the
 * plain sign-in, all on purpose:
 *   - nothing is created (signup off) and no wallet set-up is asked for: this page only lets an existing account in;
 *   - once Privy knows the person, the form is posted at once; the SERVER compares who that is with the link's
 *     account and refuses anyone else. Nothing here decides that;
 *   - `again`: the person came in as another account and pressed Try again. The Privy session of that other account
 *     is ended first, once (never on the way back from Google or Apple), so the methods show again.
 */
function BoundSignIn({ offered, again }) {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const methods = useEnabledMethods(offered);
  const { loading, state } = useLoginWithOAuth();
  const refusal = state?.status === "error" ? oauthRefusal(state.error?.privyErrorCode) : "";
  const [cleared, setCleared] = useState(!again);
  const [error, setError] = useState("");
  const [seen, setSeen] = useState(false);
  const sent = useRef(false);
  useEffect(() => {
    if (!ready || cleared) return;
    // Drop the flag from the address first: a reload or a provider return must not end the new session again.
    try {
      const u = new URL(location.href);
      u.searchParams.delete("again");
      history.replaceState(null, "", u);
    } catch {
      /* the flag stays; the provider-return check below still holds */
    }
    (authenticated ? logout() : Promise.resolve()).catch(() => {}).finally(() => setCleared(true));
  }, [ready, cleared, authenticated, logout]);
  useEffect(() => {
    if (!ready || !cleared || !authenticated || sent.current) return;
    sent.current = true;
    submitSession(getAccessToken).catch(() => {
      sent.current = false;
      setError("That could not continue. Please try again.");
    });
  }, [ready, cleared, authenticated, getAccessToken]);
  const screen = !ready || !cleared ? "loading" : authenticated ? "finish" : methods === null ? "loading" : !methods.length ? "none" : "methods";
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        LOADING
      ) : screen === "finish" ? (
        <p role={error ? "alert" : "status"} className={error ? "notice" : undefined}>
          {words(error || "That’s you. One moment…")}
        </p>
      ) : screen === "none" ? (
        <p role="status">{words(NO_METHOD_LINE)}</p>
      ) : (
        <ChooseMethod
          methods={methods}
          signup={false}
          intro="Use the account you connected to ChatGPT with."
          pageNotice={loading || seen ? "" : refusal}
          onStart={() => setSeen(true)}
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
  const query = new URLSearchParams(location.search);
  const fromProvider = query.has("privy_oauth_code") || query.has("privy_oauth_state");
  createRoot(host).render(
    <PrivyProvider appId={config.appId} config={privyConfig()}>
      {host.dataset.mode === "logout" ? (
        <EndSession />
      ) : host.dataset.bound === "1" ? (
        <BoundSignIn offered={host.dataset.methods} again={host.dataset.again === "1" && !fromProvider} />
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

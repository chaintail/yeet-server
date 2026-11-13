import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useCreateWallet,
  useLoginWithEmail,
  useLoginWithOAuth,
  useLoginWithTelegram,
  usePrivyClient_experimental,
  useSigners,
  useUser,
} from "@privy-io/react-auth";
// Privy 3.47.0: the Solana embedded wallet is created through the /solana entry's useCreateWallet.
import { useCreateWallet as useCreateSolanaWallet } from "@privy-io/react-auth/solana";
import { privyConfig } from "./privy-app.jsx";
import { NO_METHOD_LINE, enabledMethods, introLine } from "./login-methods.js";
import {
  CHAINS,
  attachYeetSigner,
  embeddedWallets,
  ensureWallets,
  setupErrorReport,
} from "./wallet-setup.js";
import { SetupProgress } from "./setup-screen.jsx";

// How long the page keeps asking the Privy client for the app configuration after Privy reports ready.
const CONFIG_WAIT_MS = 5000;

// How long wallet setup may run before the page shows the "taking longer" notice and a Try again button.
const WALLET_WAIT_MS = 20000;

// Right after sign-in Privy may still be creating the wallets itself (createOnLogin). The page waits this long and
// re-reads the user before it creates a missing wallet; a create that meets an existing wallet counts as done.
const LOGIN_CREATE_GRACE_MS = 2500;
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
      <p role="status">{error}</p>
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
      {error}
    </p>
  );
  return (
    <>
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
                onKeyDown={onEnter(send)}
              />
              <button type="button" disabled={busy} onClick={send}>
                {sending ? "Sending code…" : "Email me a code"}
              </button>
              {notice}
            </>
          ) : null}
          {emailOn && others.length ? (
            <p className="divider">
              <span>or</span>
            </p>
          ) : null}
          {others.map((m, i) => (
            <button
              key={m.id}
              type="button"
              className={emailOn || i > 0 ? "secondary" : undefined}
              disabled={busy}
              onClick={() => start(m)}
            >
              {m.id === "telegram" && telegramBusy ? "Waiting for Telegram…" : `Continue with ${m.label}`}
            </button>
          ))}
          {emailOn ? null : notice}
        </>
      )}
    </>
  );
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
  const { addSigners } = useSigners();
  const { createWallet: createBase } = useCreateWallet();
  const { createWallet: createSolana } = useCreateSolanaWallet();
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);

  async function runSetup(first) {
    running.current = true;
    setSetupFailed(false);
    setStep("check");
    try {
      if (first) await new Promise((resolve) => setTimeout(resolve, LOGIN_CREATE_GRACE_MS));
      let current = (await refreshUser().catch(() => null)) || userRef.current;
      current = await ensureWallets({
        user: current,
        createBase: () => createBase(),
        createSolana: () => createSolana(),
        refreshUser,
        onStep: (chain) => {
          setStep(chain);
          setDone(CHAINS.slice(0, CHAINS.indexOf(chain)));
        },
      });
      setDone([...CHAINS]);
      setStep("link");
      await attachYeetSigner({ config, user: current, addSigners });
      setDone([...CHAINS, "link"]);
      await submitSession(getAccessToken);
    } catch (e) {
      // No client-error endpoint on the server yet: a structured, secret-free line in the browser console.
      console.error(JSON.stringify(setupErrorReport(e, userRef.current)));
      setSetupFailed(true);
    } finally {
      running.current = false;
    }
  }

  useEffect(() => {
    if (!setup || !ready || running.current) return;
    runSetup(attempt === 0);
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
      await attachYeetSigner({ config, user, addSigners });
    } catch (e) {
      console.error(JSON.stringify(setupErrorReport(e, user)));
      setSetupFailed(true);
      setError(
        e?.code === "wallets-not-ready"
          ? "Your YEET wallets are still being set up. Try again in a moment."
          : "YEET could not finish setting up trading on your wallets. Nothing was charged. Tap Try again.",
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

  if (setup)
    return (
      <>
        <p>You are signed in. YEET sets up your wallets on Base and Solana, then you go back to ChatGPT.</p>
        <SetupProgress step={step} done={done} slow={slow} failed={setupFailed} onRetry={retry} />
        <button type="button" className="secondary" onClick={logout}>
          Use another account
        </button>
      </>
    );

  return (
    <>
      <p>You are signed in. YEET sets up your wallets on Base and Solana, then you go back to ChatGPT.</p>
      <button type="button" disabled={!ready || busy} onClick={continueLogin}>
        {busy ? "Setting up…" : setupFailed ? "Try again" : "Continue to YEET"}
      </button>
      <button type="button" className="secondary" disabled={busy} onClick={logout}>
        Use another account
      </button>
      <p role="alert" className={error ? "notice" : undefined}>
        {error}
      </p>
    </>
  );
}

function SignIn({ config }) {
  const { ready, authenticated } = usePrivy();
  const methods = useEnabledMethods();
  if (!ready) return <p role="status">Loading secure sign in…</p>;
  // Every sign-in method ends here, so the YEET signer step runs after email, Google, Apple, X and Telegram alike.
  if (authenticated) return <FinishSignIn config={config} />;
  if (methods === null) return <p role="status">Loading secure sign in…</p>;
  if (!methods.length) return <p role="status">{NO_METHOD_LINE}</p>;
  return (
    <>
      <p>{introLine(methods)}</p>
      <ChooseMethod methods={methods} />
    </>
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
  document.getElementById("privy-login").textContent =
    "Secure sign in is unavailable. Please try again later.";
}

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useLoginWithEmail,
  useLoginWithOAuth,
  useSigners,
} from "@privy-io/react-auth";
import { PROVIDERS, embeddedWallets, privyConfig } from "./privy-app.jsx";

// How long the page waits for Privy to create the wallets at login (createOnLogin) before it offers a reload.
// A reload signs in again from the stored session, and Privy then creates any wallet that is still missing.
const WALLET_WAIT_MS = 15000;
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

/**
 * Lets the YEET server sign for both embedded wallets, within the YEET policies (one policy per chain).
 * Runs for every sign-in method (email, Google, Apple) when /account/identity-config returns a signer id, so
 * sign-in keeps working before the signer is registered. A wallet that already has a delegated signer is left
 * as it is, so a retry after a partial failure only adds what is missing.
 */
async function attachYeetSignerIfConfigured({ config, user, addSigners }) {
  if (!config.signerId) return;
  const wallets = embeddedWallets(user);
  if (!wallets.base || !wallets.solana) throw Error("wallets-not-ready");
  for (const [chain, wallet] of Object.entries(wallets)) {
    if (wallet.delegated) continue;
    const policy = config.policyIds?.[chain];
    await addSigners({
      address: wallet.address,
      signers: [{ signerId: config.signerId, ...(policy ? { policyIds: [policy] } : {}) }],
    });
  }
}

/** Enter in a field inside the page's sign-in form runs `action` instead of posting that form. */
const onEnter = (action) => (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  action();
};

/** Email one-time code, then Google and Apple. The fields have no name, so the page form never posts them. */
function ChooseMethod() {
  const { ready } = usePrivy();
  const { initOAuth, loading } = useLoginWithOAuth();
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [sentTo, setSentTo] = useState(""),
    [error, setError] = useState("");
  const sending = state.status === "sending-code",
    checking = state.status === "submitting-code";
  const busy = !ready || loading || sending || checking;

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
          <p className="divider">
            <span>or</span>
          </p>
          {PROVIDERS.map(([provider, label]) => (
            <button
              key={provider}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => social(provider)}
            >
              Continue with {label}
            </button>
          ))}
        </>
      )}
    </>
  );
}

/** Signed in: wait for both wallets, give the YEET signer access, then hand the session to the page form. */
function FinishSignIn({ config }) {
  const { ready, user, getAccessToken, logout } = usePrivy();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false),
    [setupFailed, setSetupFailed] = useState(false),
    [error, setError] = useState(""),
    [waitedTooLong, setWaitedTooLong] = useState(false);
  const wallets = embeddedWallets(user);
  const walletsPending = !!config.signerId && (!wallets.base || !wallets.solana);

  useEffect(() => {
    if (!walletsPending) return;
    const timer = setTimeout(() => setWaitedTooLong(true), WALLET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [walletsPending]);

  async function continueLogin() {
    setBusy(true);
    setError("");
    try {
      await attachYeetSignerIfConfigured({ config, user, addSigners });
    } catch (e) {
      setSetupFailed(true);
      setError(
        e?.message === "wallets-not-ready"
          ? "Your YEET wallets are still being set up. Try again in a moment."
          : "YEET could not finish setting up trading on your wallets. Nothing was charged. Tap Try again.",
      );
      setBusy(false);
      return;
    }
    setSetupFailed(false);
    try {
      const token = await getAccessToken();
      if (!token) throw Error();
      const form = document.getElementById("privy-login").closest("form");
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "privy_access_token";
      input.value = token;
      form.append(input);
      form.requestSubmit();
    } catch {
      setError("Sign in could not continue. Please try again.");
      setBusy(false);
    }
  }

  const label = busy
    ? "Setting up…"
    : walletsPending
      ? "Setting up your YEET wallets…"
      : setupFailed
        ? "Try again"
        : "Continue to YEET";
  return (
    <>
      <p>You are signed in. YEET sets up your wallets on Base and Solana, then you go back to ChatGPT.</p>
      {walletsPending && waitedTooLong ? (
        <>
          <p role="alert" className="notice">Setting up your wallets is taking longer than usual.</p>
          <button type="button" onClick={() => location.reload()}>
            Try again
          </button>
        </>
      ) : (
        <button type="button" disabled={!ready || busy || walletsPending} onClick={continueLogin}>
          {label}
        </button>
      )}
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
  if (!ready) return <p role="status">Loading secure sign in…</p>;
  return authenticated ? (
    <FinishSignIn config={config} />
  ) : (
    <>
      <p>Sign in with your email, Google or Apple. New here? Signing in creates your YEET account and wallets.</p>
      <ChooseMethod />
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

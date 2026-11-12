import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useLoginWithOAuth,
  useSigners,
} from "@privy-io/react-auth";
const PROVIDERS = [
  ["google", "Google"],
  ["apple", "Apple"],
  ["telegram", "Telegram"],
  ["twitter", "X"],
];
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
            location.assign("/demo/login");
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
/** The person's YEET embedded wallets (created on login), one per chain. */
function embeddedWallets(user) {
  const wallets = (user?.linkedAccounts || []).filter(
    (a) =>
      a.type === "wallet" &&
      (a.walletClientType === "privy" || a.walletClientType === "privy-v2") &&
      !a.imported,
  );
  return {
    base: wallets.find((w) => w.chainType === "ethereum"),
    solana: wallets.find((w) => w.chainType === "solana"),
  };
}
/**
 * Lets the YEET server sign for both embedded wallets, within the YEET policies. Runs only when
 * /demo/identity-config returns a signer id, so sign-in keeps working before the signer is registered.
 * A wallet that already has a delegated signer is left as it is.
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
function SignIn({ config }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { initOAuth, loading } = useLoginWithOAuth();
  const wallets = embeddedWallets(user);
  const walletsPending = !!config.signerId && (!wallets.base || !wallets.solana);
  async function social(provider) {
    setError("");
    try {
      await initOAuth({ provider, disableSignup: false });
    } catch {
      setError("Sign in could not start. Please try again.");
    }
  }
  async function continueLogin() {
    setBusy(true);
    setError("");
    try {
      await attachYeetSignerIfConfigured({ config, user, addSigners });
    } catch (e) {
      setError(
        e?.message === "wallets-not-ready"
          ? "Your YEET wallets are still being set up. Try again in a moment."
          : "YEET could not finish setting up your wallets. Please try again.",
      );
      setBusy(false);
      return;
    }
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
  return (
    <>
      <p>
        Sign in with Google, Apple, Telegram or X. New here? Signing in creates
        your YEET account and your YEET wallets.
      </p>
      {authenticated ? (
        <>
          <button
            type="button"
            disabled={!ready || busy || walletsPending}
            onClick={continueLogin}
          >
            {busy
              ? "Continuing…"
              : walletsPending
                ? "Setting up your YEET wallets…"
                : "Continue to YEET"}
          </button>
          <button type="button" disabled={busy} onClick={logout}>
            Use another account
          </button>
        </>
      ) : (
        PROVIDERS.map(([provider, label]) => (
          <button
            key={provider}
            type="button"
            disabled={!ready || busy || loading}
            onClick={() => social(provider)}
          >
            Continue with {label}
          </button>
        ))
      )}
      <p role="status">{error}</p>
    </>
  );
}
try {
  const response = await fetch("/demo/identity-config", {
    credentials: "same-origin",
  });
  if (!response.ok) throw Error();
  const config = await response.json();
  createRoot(document.getElementById("privy-login")).render(
    <PrivyProvider
      appId={config.appId}
      config={{
        scriptNonce: document.querySelector('meta[property="csp-nonce"]')
          ?.content,
        appearance: {
          logo: <strong>YEET</strong>,
          theme: "dark",
          accentColor: "#ffe14d",
          walletList: [],
        },
        loginMethods: PROVIDERS.map(([provider]) => provider),
        embeddedWallets: {
          disableAutomaticMigration: true,
          ethereum: { createOnLogin: "all-users" },
          solana: { createOnLogin: "all-users" },
        },
        externalWallets: { walletConnect: { enabled: false } },
      }}
    >
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

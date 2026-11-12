import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PrivyProvider,
  usePrivy,
  useLoginWithOAuth,
} from "@privy-io/react-auth";
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
            setError("Privy sign out could not finish. Please try again.");
            setBusy(false);
          }
        }}
      >
        Sign out of Privy
      </button>
      <p role="status">{error}</p>
    </>
  );
}
function SignIn() {
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const { initOAuth, loading } = useLoginWithOAuth();
  async function social(provider) {
    setError("");
    try {
      await initOAuth({ provider, disableSignup: true });
    } catch {
      setError("Existing-account sign in could not start. Please try again.");
    }
  }
  async function continueLogin() {
    setBusy(true);
    setError("");
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
        Sign in to your existing Privy profile using a method already linked to
        it. Creating or linking accounts is unavailable in this lab. Portfolio
        and research data are mock data.
      </p>
      {authenticated ? (
        <>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={continueLogin}
          >
            {busy ? "Continuing…" : "Continue with signed-in identity"}
          </button>
          <button type="button" disabled={busy} onClick={logout}>
            Use another identity
          </button>
        </>
      ) : (
        ["google", "apple", "telegram"].map((provider) => (
          <button
            key={provider}
            type="button"
            disabled={!ready || busy || loading}
            onClick={() => social(provider)}
          >
            Continue with {provider[0].toUpperCase() + provider.slice(1)}
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
  const { appId } = await response.json();
  createRoot(document.getElementById("privy-login")).render(
    <PrivyProvider
      appId={appId}
      config={{
        scriptNonce: document.querySelector('meta[property="csp-nonce"]')
          ?.content,
        appearance: { logo: <strong>Folio</strong>, walletList: [] },
        loginMethods: ["google", "apple", "telegram"],
        embeddedWallets: {
          disableAutomaticMigration: true,
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
        externalWallets: { walletConnect: { enabled: false } },
      }}
    >
      {document.getElementById("privy-login").dataset.mode === "logout" ? (
        <EndSession />
      ) : (
        <SignIn />
      )}
    </PrivyProvider>,
  );
} catch {
  document.getElementById("privy-login").textContent =
    "Secure sign in is unavailable. Please try again later.";
}

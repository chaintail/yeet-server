// "Add funds" page (/fund): the person's YEET Base wallet, a copy button, and Privy's funding flow for USDC on Base.
// Privy 3.47.0 useFundWallet: fundWallet({address, options}) resolves with {status: 'completed'|'cancelled', ...};
// onUserExited fires when the person closes the flow. Neither proves a payment arrived, so the page re-reads the
// balance on chain after the flow closes.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useFundWallet } from "@privy-io/react-auth";
import { embeddedWallets, privyConfig } from "./privy-app.jsx";
import { DEFAULT_AMOUNT, baseUsdcReader, formatUsdc, fundOptions, validAmount } from "./fund-balance.js";

const SIGN_IN = "/account/login?next=fund";

function useBalance(reader, address) {
  const [state, setState] = useState({ status: "idle" });
  const refresh = useCallback(async () => {
    if (!address) return;
    setState((s) => ({ ...s, status: "loading" }));
    try {
      setState({ status: "ready", units: await reader.balance(address) });
    } catch {
      setState({ status: "error" });
    }
  }, [reader, address]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return [state, refresh];
}

function Fund({ reader }) {
  const { ready, authenticated, user } = usePrivy();
  const address = embeddedWallets(user).base?.address;
  const [balance, refreshBalance] = useBalance(reader, address);
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const closed = useRef(null);
  const { fundWallet } = useFundWallet({
    onUserExited: () => closed.current?.(),
  });

  useEffect(() => {
    if (ready && !authenticated) location.assign(SIGN_IN);
  }, [ready, authenticated]);

  if (!ready || !authenticated) return <p role="status">Loading your YEET wallet…</p>;
  if (!address)
    return (
      <p role="status">
        Your YEET wallets are still being set up. Reload this page in a moment.
      </p>
    );

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("Copy did not work here. Select the address and copy it by hand.");
    }
  }

  async function addFunds() {
    const value = validAmount(amount);
    if (!value) {
      setMessage("Enter an amount from 1 to 10,000 dollars.");
      return;
    }
    setBusy(true);
    setMessage("");
    let status;
    try {
      // Settles on whichever comes first: the promise or the exit callback.
      const result = await new Promise((resolve, reject) => {
        closed.current = () => resolve({ status: "closed" });
        fundWallet({ address, options: fundOptions(value) }).then(resolve, reject);
      });
      status = result?.status;
    } catch {
      setMessage("Adding funds could not start. Please try again.");
    } finally {
      closed.current = null;
      setBusy(false);
    }
    if (status === "completed")
      setMessage("Payment sent. Card payments can take a few minutes to reach your wallet.");
    else if (status) setMessage("Funding closed. If you paid, the balance updates within a few minutes.");
    refreshBalance();
  }

  return (
    <>
      <p>Add USDC on Base to your YEET wallet. YEET trades from this balance.</p>
      <label htmlFor="fund-address">Your YEET wallet on Base</label>
      <input id="fund-address" readOnly value={address} onFocus={(e) => e.target.select()} />
      <button type="button" className="secondary" onClick={copy}>
        {copied ? "Copied" : "Copy address"}
      </button>
      <p>Send USDC on Base to this address.</p>
      <label htmlFor="fund-amount">Amount in US dollars</label>
      <input
        id="fund-amount"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button type="button" disabled={busy} onClick={addFunds}>
        {busy ? "Adding funds…" : "Add funds"}
      </button>
      <p>Pay by card, Apple Pay or Google Pay through Coinbase, where your device and region support it.</p>
      <dl>
        <dt>Balance</dt>
        <dd>
          {balance.status === "ready"
            ? `${formatUsdc(balance.units)} USDC`
            : balance.status === "error"
              ? "Balance unavailable right now."
              : "Checking…"}
        </dd>
      </dl>
      <button type="button" className="secondary" disabled={balance.status === "loading"} onClick={refreshBalance}>
        Refresh balance
      </button>
      <p role="status">{message}</p>
      <p>When you are done, go back to ChatGPT to trade.</p>
    </>
  );
}

const root = document.getElementById("yeet-fund");
try {
  const response = await fetch("/account/identity-config", { credentials: "same-origin" });
  if (!response.ok) throw Error();
  const config = await response.json();
  const reader = baseUsdcReader();
  createRoot(root).render(
    <PrivyProvider appId={config.appId} config={privyConfig()}>
      <Fund reader={reader} />
    </PrivyProvider>,
  );
} catch {
  root.textContent = "Adding funds is unavailable right now. Please try again later.";
}

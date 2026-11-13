// "Add funds" page (/fund). Crypto first: the person's own YEET wallet address on Base or Solana (QR code, copy, wallet
// links for an amount they pick) with a live balance watch; then Privy's funding flow for USDC on Base by card.
// Privy 3.47.0 useFundWallet: fundWallet({address, options}) resolves with {status: 'completed'|'cancelled', ...};
// onUserExited fires when the person closes the flow. Neither proves a payment arrived, so the page re-reads the
// balance on chain after the flow closes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useFundWallet } from "@privy-io/react-auth";
import { embeddedWallets, privyConfig } from "./privy-app.jsx";
import { DEFAULT_AMOUNT, baseUsdcReader, solanaUsdcReader, formatUsdc, fundOptions, validAmount } from "./fund-balance.js";
import { AMOUNT_CHIPS, NETWORKS, chipFromSearch, sendAmount, validAddress, walletLinks } from "./fund-links.js";
import { watchBalance } from "./fund-watch.js";
import { qrCode, qrPath } from "./qr.js";
import { Swap } from "./screen.jsx";
import { words } from "./brand-words.jsx";

const SIGN_IN = "/account/login?next=fund";
const WALLET_NAMES = { rainbow: "Rainbow", coinbase: "Coinbase Wallet", phantom: "Phantom", solflare: "Solflare" };

function Fund({ readers }) {
  const { ready, authenticated, user } = usePrivy();
  const wallets = embeddedWallets(user);
  const addresses = {
    base: validAddress("base", wallets.base?.address) ? wallets.base.address : null,
    solana: validAddress("solana", wallets.solana?.address) ? wallets.solana.address : null,
  };
  useEffect(() => {
    if (ready && !authenticated) location.assign(SIGN_IN);
  }, [ready, authenticated]);
  const screen = !ready || !authenticated ? "loading" : addresses.base ? "fund" : "waiting";
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        <p role="status">{words("Loading your YEET wallet…")}</p>
      ) : screen === "waiting" ? (
        <p role="status">{words("Your YEET wallets are still being set up. Reload this page in a moment.")}</p>
      ) : (
        <FundWallet readers={readers} addresses={addresses} />
      )}
    </Swap>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The balance of the selected network, read now and every few seconds while the tab is visible. */
function useWatchedBalance(reader, address, network) {
  const [balance, setBalance] = useState({ status: "loading" });
  const [arrived, setArrived] = useState(null);
  const watcher = useRef(null);
  useEffect(() => {
    setBalance({ status: "loading" });
    setArrived(null);
    const w = watchBalance({
      read: () => reader.balance(address),
      onUpdate: (u) => {
        setBalance((b) => (u.status === "ready" ? u : { ...b, status: b.units === undefined ? "error" : "ready", stale: true }));
        if (u.status === "ready" && u.arrived > 0n) setArrived({ units: u.arrived, total: u.units, network });
      },
    });
    watcher.current = w;
    return () => w.stop();
  }, [reader, address, network]);
  const refresh = useCallback(() => watcher.current?.refresh(), []);
  return [balance, arrived, refresh];
}

function Qr({ value, label }) {
  const code = useMemo(() => qrCode(value), [value]);
  const box = code.size + 8;
  return (
    <div className="qr">
      <svg viewBox={`0 0 ${box} ${box}`} role="img" aria-label={label} shapeRendering="crispEdges">
        <rect width={box} height={box} fill="#fff" />
        <path d={qrPath(code, 4)} fill="#06071C" />
      </svg>
    </div>
  );
}

function FundWallet({ readers, addresses }) {
  const networks = ["base", "solana"].filter((n) => addresses[n]);
  const [network, setNetwork] = useState("base");
  const address = addresses[network];
  const net = NETWORKS[network];
  const [balance, arrived, refreshBalance] = useWatchedBalance(readers[network], address, network);
  const [copied, setCopied] = useState(false);
  // The funding card in the chat opens this page with ?amount=<preset>: the page starts on that chip.
  const [chip, setChip] = useState(() => chipFromSearch(globalThis.location?.search));
  const [custom, setCustom] = useState("");
  const [linkNote, setLinkNote] = useState("");

  // Card payment (Privy funding flow, USDC on Base): unchanged from before, now the second way to add funds.
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const closed = useRef(null);
  const { fundWallet } = useFundWallet({
    onUserExited: () => closed.current?.(),
  });

  const sendValue = chip === "other" ? sendAmount(custom) : chip;
  const links = sendValue ? walletLinks(network, address, sendValue) : [];

  function pickNetwork(n) {
    setNetwork(n);
    setCopied(false);
    setLinkNote("");
  }

  async function copy() {
    if (await copyText(address)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else setLinkNote("Copy did not work here. Select the address and copy it by hand.");
  }

  function copyFor(id) {
    const wallet = WALLET_NAMES[id];
    copyText(address).then((ok) =>
      setLinkNote(
        ok
          ? `Address copied. In ${wallet}, send ${sendValue} ${net.asset} to it.`
          : `Copy did not work here. Select the address above and send ${sendValue} ${net.asset} to it in ${wallet}.`,
      ),
    );
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
        fundWallet({ address: addresses.base, options: fundOptions(value) }).then(resolve, reject);
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
    // Card payments land on Base: watch that balance.
    if (network !== "base") pickNetwork("base");
    else refreshBalance();
  }

  return (
    <>
      <p className="lead">{words("Send USDC to your YEET wallet from any wallet or exchange, or pay by card. YEET trades from this balance.")}</p>
      <dl className="balance">
        <dt>Balance on {net.name}</dt>
        <dd className={balance.status === "ready" ? undefined : "quiet"}>
          {balance.status === "ready"
            ? `${formatUsdc(balance.units)} USDC`
            : balance.status === "error"
              ? "Unavailable right now"
              : "Checking…"}
        </dd>
      </dl>
      {arrived ? (
        <div className="arrived" role="status">
          <p className="arrived-amount">+{formatUsdc(arrived.units)} USDC arrived</p>
          <p className="hint">
            Balance {formatUsdc(arrived.total)} {NETWORKS[arrived.network].asset}. {words("Back to ChatGPT to YEET.")}
          </p>
        </div>
      ) : null}

      <h2 className="section">Send USDC</h2>
      {networks.length > 1 ? (
        <div className="switch" role="group" aria-label="Network">
          {networks.map((n) => (
            <button key={n} type="button" aria-pressed={n === network} onClick={() => pickNetwork(n)}>
              {NETWORKS[n].name}
            </button>
          ))}
        </div>
      ) : null}
      <p className="asset">
        <strong>{net.asset}</strong>
      </p>
      <Qr value={address} label={`QR code of your YEET wallet address for ${net.asset}`} />
      <p className="label" id="fund-address-label">{words(`Your YEET wallet on ${net.name}`)}</p>
      <div className="row">
        <output id="fund-address" className="address" aria-labelledby="fund-address-label">
          {address}
        </output>
        <button type="button" className="secondary" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="limit warn">Send only {net.asset} to this address. Other coins or networks can be lost.</p>

      <p className="pick" id="send-amount-label">
        Send from a wallet app: pick an amount in USDC
      </p>
      <div className="chips" role="group" aria-labelledby="send-amount-label">
        {AMOUNT_CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            className="chip"
            aria-label={`${c} USDC`}
            aria-pressed={chip === c}
            onClick={() => (setChip(c), setLinkNote(""))}
          >
            {c}
          </button>
        ))}
        <button type="button" className="chip" aria-pressed={chip === "other"} onClick={() => (setChip("other"), setLinkNote(""))}>
          Other
        </button>
      </div>
      {chip === "other" ? (
        <>
          <label htmlFor="send-custom">Amount in USDC</label>
          <input
            id="send-custom"
            inputMode="decimal"
            autoComplete="off"
            value={custom}
            aria-invalid={custom && !sendValue ? true : undefined}
            onChange={(e) => (setCustom(e.target.value), setLinkNote(""))}
          />
          {custom && !sendValue ? <p className="hint">Enter an amount above 0, up to 6 decimals.</p> : null}
        </>
      ) : null}
      {links.length ? (
        <div className="wallets">
          {links.map((l) =>
            l.href ? (
              <a
                key={l.id}
                className={l.id === "wallet" ? "button" : "button secondary"}
                href={l.href}
                rel="noopener noreferrer"
                onClick={l.copy ? () => copyFor(l.id) : undefined}
              >
                {l.label}
              </a>
            ) : (
              <button key={l.id} type="button" className="secondary" onClick={() => copyFor(l.id)}>
                {l.label}: copy address
              </button>
            ),
          )}
          <p className="hint">
            {network === "base"
              ? `Opens a request for ${sendValue} USDC on Base to your YEET wallet. Check the amount and network in your wallet before you send.`
              : `Opens a Solana Pay request for ${sendValue} USDC on Solana to your YEET wallet. Phantom opens USDC with your address copied.`}
          </p>
        </div>
      ) : null}
      <p role="status" className={linkNote ? "saved" : undefined}>{linkNote}</p>

      <p className="divider">or pay by card</p>
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
      <p className="hint fund-ways">Pay by card, Apple Pay or Google Pay through Coinbase, where your device and region support it.</p>
      <p role="status" className={message ? "saved" : undefined}>{words(message)}</p>
      <button type="button" className="secondary" disabled={balance.status === "loading"} onClick={refreshBalance}>
        Refresh balance
      </button>
      <p className="hint back">
        When you are done, go back to ChatGPT to trade. <a href="/account/">Set your username</a>
      </p>
    </>
  );
}

const root = document.getElementById("yeet-fund");
try {
  const response = await fetch("/account/identity-config", { credentials: "same-origin" });
  if (!response.ok) throw Error();
  const config = await response.json();
  const readers = { base: baseUsdcReader(), solana: solanaUsdcReader() };
  createRoot(root).render(
    <PrivyProvider appId={config.appId} config={privyConfig()}>
      <Fund readers={readers} />
    </PrivyProvider>,
  );
} catch {
  const line = document.createElement("p");
  line.className = "notice";
  line.setAttribute("role", "alert");
  line.textContent = "Adding funds is unavailable right now. Please try again later.";
  root.replaceChildren(line);
}

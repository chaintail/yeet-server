// "Add funds" page (/fund). Crypto first: the person's own YEET wallet address on Base or Solana (QR code, copy, wallet
// links for an amount they pick) with a live balance watch; then card payment through Privy's funding modal.
//
// Card payment, @privy-io/react-auth 3.51.4:
// - useDepositFunds().depositFunds({destination, fiat}) (https://docs.privy.io/wallets/funding/use-deposit-funds.md)
//   opens Privy's deposit modal. With Stripe preferred it runs Stripe's embedded onramp inside the modal: card, Apple
//   Pay, Google Pay and ACH where Stripe serves the person (US except New York, and the EU). It resolves with
//   {method: 'fiat', status: 'submitted' | 'confirmed'} and rejects on errors and when the person closes the modal.
// - useFundWallet().fundWallet({address, options}) is the older flow (deprecated in 3.51.4, never shows Stripe): it
//   opens Coinbase Onramp in a popup window. Kept as the second button. It resolves with
//   {status: 'completed' | 'cancelled'}; onUserExited fires when the person closes the flow.
// Neither result proves a payment arrived, so the page re-reads the balance on chain after either flow closes.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useDepositFunds, useFundWallet } from "@privy-io/react-auth";
import { embeddedWallets, privyConfig } from "./privy-app.jsx";
import { DEFAULT_AMOUNT, baseUsdcReader, solanaUsdcReader, cardDeposit, formatUsdc, fundOptions, validAmount } from "./fund-balance.js";
import { AMOUNT_CHIPS, NETWORKS, chipFromSearch, sendAmount, validAddress, walletLinks } from "./fund-links.js";
import { watchBalance } from "./fund-watch.js";
import { qrCode, qrPath } from "./qr.js";
import { Swap } from "./screen.jsx";
import { approvalKey, approvalOf, approvedAddresses, currentApproval, readCheck } from "./fund-approval.js";
import { words } from "./brand-words.jsx";

// The link this page was opened from may carry a signed hint for ONE account (as/account-bound.mjs): the server put
// it on the page, and it rides along to the sign-in page and to the account check.
const HINT = document.getElementById("yeet-fund")?.dataset.hint || "";
const SIGN_IN = `/account/login?next=fund${HINT ? `&h=${encodeURIComponent(HINT)}` : ""}`;
const CHECK_FAILED = "YEET could not check your account just now. Nothing was changed.";

/** Asks the server whether the Privy user in this browser is the account this page is for (POST /fund/api/check). */
async function checkAccount(getAccessToken) {
  try {
    const token = await getAccessToken();
    if (!token) return { status: "signin" };
    const r = await fetch("/fund/api/check", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ privy_access_token: token, ...(HINT ? { hint: HINT } : {}) }),
    });
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* no body */
    }
    return readCheck(r.status, body);
  } catch {
    return { status: "error" };
  }
}

function Fund({ readers }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const wallets = embeddedWallets(user);
  // The approval is tied to who is here and which wallets the browser holds (fund-approval.js). When either changes,
  // `key` changes in this same render: the kept answer no longer counts, nothing is shown, and the server is asked again.
  const key = ready && authenticated ? approvalKey(user?.id, wallets) : null;
  const [kept, setKept] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const hasWallet = !!wallets.base?.address;
  useEffect(() => {
    if (ready && !authenticated) location.assign(SIGN_IN);
  }, [ready, authenticated]);
  useEffect(() => {
    if (!key || !hasWallet) return;
    let live = true;
    checkAccount(getAccessToken).then((out) => {
      // An answer to an earlier question (another user, other wallets, an older try) is dropped.
      if (!live) return;
      if (out.status === "signin") return location.assign(SIGN_IN);
      setKept(approvalOf(key, out));
    });
    return () => {
      live = false;
    };
  }, [key, hasWallet, getAccessToken, attempt]);
  const approval = currentApproval(kept, key);
  // Only what the server confirmed for the bound account, and only while the same Privy user is here.
  const shown = approvedAddresses({ userId: user?.id, wallets, approval });
  const addresses = {
    base: shown && validAddress("base", shown.base) ? shown.base : null,
    solana: shown && validAddress("solana", shown.solana) ? shown.solana : null,
  };
  /** Another account is here. The person presses this: it ends that session and opens the sign-in for the right one. */
  async function tryAgain() {
    try {
      await logout();
    } catch {
      /* the sign-in page offers Use another account */
    }
    location.assign(SIGN_IN);
  }
  const screen =
    !ready || !authenticated ? "loading"
    : !hasWallet ? "waiting"
    : approval.status === "checking" ? "loading"
    : approval.status === "expired" ? "expired"
    : approval.status === "mismatch" || (approval.status === "ok" && !addresses.base) ? "mismatch"
    : approval.status !== "ok" ? "error"
    : "fund";
  return (
    <Swap id={screen}>
      {screen === "loading" ? (
        <p role="status">{words("Loading your YEET wallet…")}</p>
      ) : screen === "expired" ? (
        <p role="alert" className="notice">
          {words(approval.message || "This link has expired. Go back to ChatGPT and ask for a new one.")}
        </p>
      ) : screen === "mismatch" ? (
        <>
          <p role="alert" className="notice">
            {words("This is a different YEET account than the one in your ChatGPT.")}
          </p>
          <button type="button" onClick={tryAgain}>
            Try again
          </button>
        </>
      ) : screen === "error" ? (
        <>
          <p role="alert" className="notice">
            {words(CHECK_FAILED)}
          </p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </>
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
  // The funding card in the chat opens this page with ?amount=<preset>: the page starts on that chip, and the card
  // payment amount below starts on the same number.
  const [preset] = useState(() => chipFromSearch(globalThis.location?.search));
  const [chip, setChip] = useState(preset);
  const [custom, setCustom] = useState("");
  const [linkNote, setLinkNote] = useState("");

  // Card payment, the second way to add funds: Privy's deposit modal (Stripe preferred) on the selected network, and
  // the older Coinbase flow on Base.
  const [amount, setAmount] = useState(preset ?? DEFAULT_AMOUNT);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");
  const closed = useRef(null);
  const { depositFunds } = useDepositFunds();
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

  const PAID = "Payment sent. Card payments can take a few minutes to reach your wallet.";
  const CLOSED = "Funding closed. If you paid, the balance updates within a few minutes.";

  /** Card, Apple Pay or Google Pay in Privy's deposit modal; USDC arrives on the network selected above. */
  async function payInModal() {
    const value = validAmount(amount);
    if (!value) {
      setMessage("Enter an amount from 1 to 10,000 dollars.");
      return;
    }
    setBusy("modal");
    setMessage("");
    try {
      await depositFunds(cardDeposit(network, address, value));
      setMessage(PAID);
    } catch (e) {
      // depositFunds rejects both when the person closes the modal ("User exited flow") and when it cannot run.
      setMessage(/exit|cancel|clos/i.test(String(e?.message)) ? CLOSED : "Card payment could not start. Try Pay with Coinbase, or send USDC to your address above.");
    } finally {
      setBusy(null);
    }
    refreshBalance();
  }

  /** Coinbase Onramp in its own window; USDC arrives on Base. */
  async function payWithCoinbase() {
    const value = validAmount(amount);
    if (!value) {
      setMessage("Enter an amount from 1 to 10,000 dollars.");
      return;
    }
    setBusy("coinbase");
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
      setBusy(null);
    }
    if (status === "completed") setMessage(PAID);
    else if (status) setMessage(CLOSED);
    // Coinbase payments land on Base: watch that balance.
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
      <button type="button" disabled={!!busy} onClick={payInModal}>
        {busy === "modal" ? "Opening payment…" : "Pay with card or Apple Pay"}
      </button>
      <p className="hint fund-ways">
        Card, Apple Pay or Google Pay, where your device and region support it. You get {net.asset}.
      </p>
      <button type="button" className="secondary" disabled={!!busy} onClick={payWithCoinbase}>
        {busy === "coinbase" ? "Opening Coinbase…" : "Pay with Coinbase"}
      </button>
      <p className="hint fund-ways">Opens Coinbase in its own window. You get USDC on Base.</p>
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

// Privy's modal backdrop (#privy-dialog-backdrop, 3.51.4) is a fixed full-viewport layer whose only paint is
// backdrop-filter: blur(3px): no colour. On iPhone the page behind it was reported fully black; desktop Chromium
// shows it blurred, not dimmed. This page already has backdrop-filter on the card and an animated fixed layer under
// it, the combination WebKit is known to paint black. The rule below gives the backdrop a plain translucent colour
// and no filter, so the page stays visible and dimmed. The style element carries the page's CSP nonce.
function dimBehindModal() {
  const style = document.createElement("style");
  style.nonce = document.querySelector('meta[property="csp-nonce"]')?.content ?? "";
  style.textContent =
    "#privy-dialog-backdrop{background:rgba(6,7,28,.62)!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;transition:none!important}";
  document.head.append(style);
}

const root = document.getElementById("yeet-fund");
dimBehindModal();
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

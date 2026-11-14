// Direct USDC transfers to the person's own YEET wallet: payment request links for wallet apps, per network. No React
// and no network here, so node --test loads it (fund-links.test.mjs checks every string).
//
// Each wallet link uses that wallet's own documented format. A wallet with no documented way to fill in a USDC send
// gets `copy: true`: the page copies the address and says so, and links only to a documented page of that app.
import { BASE_CHAIN_ID, BASE_USDC } from "./fund-balance.js";

/** Native USDC on Solana (Circle), 6 decimals. */
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const AMOUNT_CHIPS = Object.freeze(["10", "25", "50", "100"]);
/** The chip the page starts on when its address carries ?amount= (the funding card in the chat sends its preset): one
 * of AMOUNT_CHIPS, or null. */
export function chipFromSearch(search) {
  let v = null;
  try { v = new URLSearchParams(typeof search === "string" ? search : "").get("amount"); } catch { v = null; }
  return AMOUNT_CHIPS.includes(v) ? v : null;
}
export const NETWORKS = Object.freeze({
  base: Object.freeze({ id: "base", name: "Base", asset: "USDC on Base" }),
  solana: Object.freeze({ id: "solana", name: "Solana", asset: "USDC on Solana" }),
});

const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const validAddress = (network, address) =>
  typeof address === "string" && (network === "base" ? BASE_ADDRESS : network === "solana" ? SOLANA_ADDRESS : /^$/).test(address);

/**
 * A USDC amount to send: digits with up to 6 decimals, more than 0 and at most 1,000,000. Returns the normalized
 * decimal string ("10.50" -> "10.5", "007" -> "7") or null. No signs, exponents, separators or bare ".5".
 */
export function sendAmount(value) {
  const s = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const m = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, ""),
    frac = (m[2] ?? "").replace(/0+$/, "");
  const units = BigInt(whole) * 10n ** 6n + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
  if (units <= 0n || units > 1_000_000n * 10n ** 6n) return null;
  return frac ? `${whole}.${frac}` : whole;
}

/** The amount in USDC base units (6 decimals) as a decimal integer string. */
export function usdcUnits(amount) {
  const a = sendAmount(amount);
  if (!a) throw Error("invalid-amount");
  const [whole, frac = ""] = a.split(".");
  return (BigInt(whole) * 10n ** 6n + BigInt(frac.padEnd(USDC_DECIMALS, "0"))).toString();
}

function checked(network, address, amount) {
  if (!validAddress(network, address)) throw Error("invalid-address");
  const a = sendAmount(amount);
  if (!a) throw Error("invalid-amount");
  return a;
}

/**
 * EIP-681 ERC-20 transfer request: USDC on Base to `address`, amount in base units.
 * Format: https://eips.ethereum.org/EIPS/eip-681 ("ethereum:<token>@<chain id>/transfer?address=<to>&uint256=<units>").
 */
export function baseTransferRequest(address, amount) {
  const a = checked("base", address, amount);
  return `ethereum:${BASE_USDC}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${usdcUnits(a)}`;
}

/**
 * MetaMask "Send an ERC-20 token" deeplink: the same request on MetaMask's universal link host.
 * Format: https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/
 * ("https://link.metamask.io/send/{contractAddress}@{chainId}/transfer?address=...&uint256=...", amount in the
 * token's smallest unit). metamask.app.link is the older host for the same paths; the docs now give link.metamask.io.
 */
export function metamaskLink(address, amount) {
  const a = checked("base", address, amount);
  return `https://link.metamask.io/send/${BASE_USDC}@${BASE_CHAIN_ID}/transfer?address=${address}&uint256=${usdcUnits(a)}`;
}

/**
 * Solana Pay transfer request for USDC to `address`; amount in "user" units (USDC, not base units), no exponent.
 * Format: https://github.com/solana-foundation/pay/blob/main/typescript/packages/solana-pay/spec/SPEC.md
 * ("solana:<recipient>?amount=<amount>&spl-token=<spl-token>"; recipient is the wallet, never its token account).
 */
export function solanaTransferRequest(address, amount) {
  const a = checked("solana", address, amount);
  return `solana:${address}?amount=${a}&spl-token=${SOLANA_USDC}`;
}

/**
 * Phantom has no documented link that fills in a token send (its provider deeplinks need a connected session:
 * https://docs.phantom.com/phantom-deeplinks/deeplinks-ios-and-android). It documents a link to a token's page,
 * where Send is: https://docs.phantom.com/phantom-deeplinks/other-methods/fungible
 * ("https://phantom.com/ul/v1/fungible?token=<CAIP-19 token, URL-encoded>", Solana mainnet as solana:101).
 */
export const PHANTOM_USDC_PAGE = `https://phantom.com/ul/v1/fungible?token=${encodeURIComponent(`solana:101/address:${SOLANA_USDC}`)}`;

/**
 * The ways to send for one network and amount: `href` is the link to open (null for copy only), `copy` means the
 * page copies the address first. First entry: the network's standard request, which any wallet app that handles it
 * opens. Copy only: Rainbow (publishes no link formats for sends), Coinbase Wallet (its docs give only
 * https://go.cb-w.com/dapp?cb_url=..., which opens a web page in its browser; the page now redirects, archived at
 * https://web.archive.org/web/2025/https://docs.cdp.coinbase.com/coinbase-wallet/developer-guidance/mobile-dapp-integration)
 * and Solflare (session methods and an in-app browser link only: https://docs.solflare.com/solflare/technical/deeplinks).
 */
export function walletLinks(network, address, amount) {
  if (network === "base")
    return [
      { id: "wallet", label: "Open in a wallet app", href: baseTransferRequest(address, amount), copy: false },
      { id: "metamask", label: "Open in MetaMask", href: metamaskLink(address, amount), copy: false },
      { id: "rainbow", label: "Rainbow", href: null, copy: true },
      { id: "coinbase", label: "Coinbase Wallet", href: null, copy: true },
    ];
  if (network === "solana")
    return [
      { id: "wallet", label: "Open in a wallet app", href: solanaTransferRequest(address, amount), copy: false },
      { id: "phantom", label: "Open in Phantom", href: (checked("solana", address, amount), PHANTOM_USDC_PAGE), copy: true },
      { id: "solflare", label: "Solflare", href: null, copy: true },
    ];
  throw Error("invalid-network");
}

/** The name of each wallet a copy button stands for (the ids of walletLinks above). */
export const WALLET_NAMES = Object.freeze({ rainbow: "Rainbow", coinbase: "Coinbase Wallet", phantom: "Phantom", solflare: "Solflare" });
/**
 * What a wallet's copy button does, with the page's own copy and note functions handed in (fund.jsx):
 * copies the address, then says where to paste it. Returns the promise of the note it set.
 *   copyToWallet({id, address, amount, asset, copy: async text => boolean, note: text => void})
 */
export function copyToWallet({ id, address, amount, asset, copy, note }) {
  const wallet = WALLET_NAMES[id];
  if (!wallet) throw Error(`No wallet named ${id}`);
  return copy(address).then((ok) => {
    const line = ok
      ? `Address copied. In ${wallet}, send ${amount} ${asset} to it.`
      : `Copy did not work here. Select the address above and send ${amount} ${asset} to it in ${wallet}.`;
    note(line);
    return line;
  });
}

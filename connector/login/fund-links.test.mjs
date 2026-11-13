// Wallet links for a direct USDC transfer: exact strings per network and wallet, amounts with decimals, bad input.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AMOUNT_CHIPS,
  NETWORKS,
  PHANTOM_USDC_PAGE,
  SOLANA_USDC,
  baseTransferRequest,
  metamaskLink,
  sendAmount,
  solanaTransferRequest,
  usdcUnits,
  validAddress,
  walletLinks,
} from "./fund-links.js";
import { BASE_USDC, solanaUsdcAccountsCall } from "./fund-balance.js";

const EVM = "0x5a1C0ffee0D15ea5e0000000000000000000B45E";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("constants: native USDC on Base and on Solana, chips, network names", () => {
  assert.equal(BASE_USDC, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(SOLANA_USDC, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(solanaUsdcAccountsCall(SOL).params[1].mint, SOLANA_USDC, "the balance read and the links use one mint");
  assert.deepEqual(AMOUNT_CHIPS, ["10", "25", "50", "100"]);
  assert.equal(NETWORKS.base.asset, "USDC on Base");
  assert.equal(NETWORKS.solana.asset, "USDC on Solana");
});

test("amounts: up to 6 decimals, above 0, at most 1,000,000; normalized; base units exact", () => {
  for (const [v, want, units] of [
    ["10", "10", "10000000"],
    ["25", "25", "25000000"],
    ["100", "100", "100000000"],
    ["10.50", "10.5", "10500000"],
    [" 7.25 ", "7.25", "7250000"],
    ["0.000001", "0.000001", "1"],
    ["12.345678", "12.345678", "12345678"],
    ["007", "7", "7000000"],
    ["1000000", "1000000", "1000000000000"],
    ["1000000.000000", "1000000", "1000000000000"],
    [5, "5", "5000000"],
  ]) {
    assert.equal(sendAmount(v), want, String(v));
    assert.equal(usdcUnits(v), units, String(v));
  }
  for (const v of ["", "0", "0.0", "0.0000001", "1.1234567", "1000000.000001", "10000000", "-5", "+5", "1e6", "1E2", ".5", "5.", "5,00", "1 000", "0x10", "abc", "Infinity", "NaN", null, undefined, {}, [], 0, -1, 1.5e-7]) {
    assert.equal(sendAmount(v), null, JSON.stringify(v));
    assert.throws(() => usdcUnits(v), /invalid-amount/, JSON.stringify(v));
  }
});

test("addresses: Base is 0x and 40 hex, Solana is base58 32 to 44", () => {
  assert.ok(validAddress("base", EVM));
  assert.ok(validAddress("solana", SOL));
  for (const bad of ["", "0x123", EVM + "0", EVM.slice(2), "0xZZ89205a3a3b2a69de6dbf7f01ed13b2108b2c43", SOL, null]) assert.ok(!validAddress("base", bad), String(bad));
  for (const bad of ["", "0OIl" + SOL.slice(4), SOL + "a", "abc", EVM, "solana:" + SOL, null]) assert.ok(!validAddress("solana", bad), String(bad));
  assert.ok(!validAddress("ethereum", EVM));
});

test("Base: EIP-681 USDC transfer request, chain 8453, amount in 6-decimal units", () => {
  assert.equal(
    baseTransferRequest(EVM, "25"),
    "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x5a1C0ffee0D15ea5e0000000000000000000B45E&uint256=25000000",
  );
  assert.equal(
    baseTransferRequest(EVM, "10.5"),
    "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x5a1C0ffee0D15ea5e0000000000000000000B45E&uint256=10500000",
  );
  assert.equal(baseTransferRequest(EVM, "0.000001").split("uint256=")[1], "1");
});

test("MetaMask: documented link.metamask.io send form of the same request", () => {
  assert.equal(
    metamaskLink(EVM, "50"),
    "https://link.metamask.io/send/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x5a1C0ffee0D15ea5e0000000000000000000B45E&uint256=50000000",
  );
  assert.equal(metamaskLink(EVM, "99.99").split("uint256=")[1], "99990000");
  assert.equal(metamaskLink(EVM, "12.345678"), "https://link.metamask.io/send/" + baseTransferRequest(EVM, "12.345678").slice("ethereum:".length));
});

test("Solana: Solana Pay transfer request with the USDC mint, amount in USDC (not base units)", () => {
  assert.equal(
    solanaTransferRequest(SOL, "100"),
    "solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=100&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  assert.equal(
    solanaTransferRequest(SOL, "10.50"),
    "solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=10.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  assert.match(solanaTransferRequest(SOL, "0.25"), /\?amount=0\.25&/);
});

test("Phantom: documented fungible page link for USDC on Solana (CAIP-19, URL-encoded)", () => {
  assert.equal(PHANTOM_USDC_PAGE, "https://phantom.com/ul/v1/fungible?token=solana%3A101%2Faddress%3AEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
});

test("bad input is rejected by every builder: wrong-network address, bad amount, unknown network", () => {
  for (const f of [baseTransferRequest, metamaskLink]) {
    assert.throws(() => f(SOL, "10"), /invalid-address/);
    assert.throws(() => f(EVM + "&uint256=1", "10"), /invalid-address/);
    for (const a of ["0", "-1", "1e6", "abc", "1.1234567", ""]) assert.throws(() => f(EVM, a), /invalid-amount/, a);
  }
  assert.throws(() => solanaTransferRequest(EVM, "10"), /invalid-address/);
  assert.throws(() => solanaTransferRequest(SOL + "?amount=9", "10"), /invalid-address/);
  for (const a of ["0", "-1", "1e6", "abc", "1.1234567", ""]) assert.throws(() => solanaTransferRequest(SOL, a), /invalid-amount/, a);
  assert.throws(() => walletLinks("ethereum", EVM, "10"), /invalid-network/);
  assert.throws(() => walletLinks("base", SOL, "10"), /invalid-address/);
  assert.throws(() => walletLinks("solana", SOL, "0"), /invalid-amount/);
});

test("wallet lists: the standard request first, then documented links, copy only where nothing is documented", () => {
  assert.deepEqual(walletLinks("base", EVM, "25"), [
    { id: "wallet", label: "Open in a wallet app", href: baseTransferRequest(EVM, "25"), copy: false },
    { id: "metamask", label: "Open in MetaMask", href: metamaskLink(EVM, "25"), copy: false },
    { id: "rainbow", label: "Rainbow", href: null, copy: true },
    { id: "coinbase", label: "Coinbase Wallet", href: null, copy: true },
  ]);
  assert.deepEqual(walletLinks("solana", SOL, "25"), [
    { id: "wallet", label: "Open in a wallet app", href: solanaTransferRequest(SOL, "25"), copy: false },
    { id: "phantom", label: "Open in Phantom", href: PHANTOM_USDC_PAGE, copy: true },
    { id: "solflare", label: "Solflare", href: null, copy: true },
  ]);
  for (const l of [...walletLinks("base", EVM, "1"), ...walletLinks("solana", SOL, "1")])
    if (l.href) assert.match(l.href, /^(ethereum:|solana:|https:\/\/(link\.metamask\.io|phantom\.com)\/)/, l.href);
});

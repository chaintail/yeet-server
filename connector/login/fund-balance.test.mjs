// Fund page logic without React or the network: Privy funding options, amount input, balance adapter.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_USDC,
  BASE_RPC,
  SOLANA_RPC,
  baseUsdcReader,
  balanceOfCall,
  formatUsdc,
  fundOptions,
  solanaUsdcAccountsCall,
  solanaUsdcReader,
  validAmount,
} from "./fund-balance.js";

const ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

test("fund options: USDC on Base (8453), card first, Coinbase as provider", () => {
  assert.deepEqual(fundOptions("25"), {
    chain: { id: 8453 },
    asset: "USDC",
    amount: "25",
    defaultFundingMethod: "card",
    card: { preferredProvider: "coinbase" },
    uiConfig: { receiveFundsTitle: "Add USDC on Base", receiveFundsSubtitle: "Send USDC on Base to your YEET wallet." },
  });
  assert.equal(fundOptions(" 10.50 ").amount, "10.5");
  assert.throws(() => fundOptions("0"), /invalid-amount/);
});

test("amount input: 1 to 10000 dollars, at most 2 decimals", () => {
  for (const [v, want] of [["1", "1"], ["10000", "10000"], ["99.99", "99.99"], ["007", "7"]]) assert.equal(validAmount(v), want);
  for (const v of ["", "0", "0.99", "10000.01", "1.234", "-5", "1e3", "abc", null, undefined, "5,00"]) assert.equal(validAmount(v), null, String(v));
});

test("balanceOf call targets native Base USDC with the padded address", () => {
  const call = balanceOfCall(ADDR);
  assert.equal(call.to, BASE_USDC);
  assert.equal(call.data, "0x70a08231000000000000000000000000abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(call.data.length, 2 + 8 + 64);
  for (const bad of ["", "0x123", ADDR + "00", "AbCdEf0123456789aBcDeF0123456789AbCdEf0123"]) assert.throws(() => balanceOfCall(bad), /invalid-address/);
});

test("USDC formatting rounds down to cents", () => {
  assert.equal(formatUsdc(0n), "0.00");
  assert.equal(formatUsdc(1_999_999n), "1.99");
  assert.equal(formatUsdc(1_234_567_890_000n), "1,234,567.89");
});

test("balance adapter: one eth_call to the configured RPC, parses the result, fails closed", async () => {
  const calls = [];
  const reply = (body, ok = true) => async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, json: async () => body };
  };
  const reader = baseUsdcReader({ fetchImpl: reply({ jsonrpc: "2.0", id: 1, result: "0x" + (25_000_000n).toString(16).padStart(64, "0") }) });
  assert.equal(await reader.balance(ADDR), 25_000_000n);
  assert.equal(calls[0].url, BASE_RPC);
  assert.deepEqual(calls[0].body, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [balanceOfCall(ADDR), "latest"] });
  for (const fetchImpl of [reply({}, false), reply({ error: { code: -32000 } }), reply({ result: "0x" }), reply({ result: "nothex" })])
    await assert.rejects(baseUsdcReader({ fetchImpl }).balance(ADDR), /balance-unavailable/);
  await assert.rejects(baseUsdcReader({ fetchImpl: reply({}) }).balance("0xnope"), /invalid-address/);
});

const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const tokenAccount = (amount, over = {}) => ({
  pubkey: "3hNzYSQs2ziFhnXYzxNqQ1HGnW8pQs9Gf4KfoRErfw9i",
  account: { data: { program: "spl-token", parsed: { type: "account", info: { mint: MINT, owner: SOL, tokenAmount: { amount, decimals: 6 }, ...over } } } },
});

test("Solana USDC reader: getTokenAccountsByOwner for the USDC mint on the public RPC, sums accounts, fails closed", async () => {
  assert.equal(SOLANA_RPC, "https://api.mainnet-beta.solana.com");
  assert.deepEqual(solanaUsdcAccountsCall(SOL), {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [SOL, { mint: MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
  });
  const calls = [];
  const reply = (body, ok = true) => async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, json: async () => body };
  };
  const ok = (accounts) => reply({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: accounts } });
  assert.equal(await solanaUsdcReader({ fetchImpl: ok([tokenAccount("12000000")]) }).balance(SOL), 12_000_000n);
  assert.equal(calls[0].url, SOLANA_RPC);
  assert.deepEqual(calls[0].body, solanaUsdcAccountsCall(SOL));
  assert.equal(await solanaUsdcReader({ fetchImpl: ok([tokenAccount("1"), tokenAccount("2500000")]) }).balance(SOL), 2_500_001n);
  assert.equal(await solanaUsdcReader({ fetchImpl: ok([]) }).balance(SOL), 0n, "no USDC account yet is 0");
  for (const fetchImpl of [
    reply({}, false),
    reply({ error: { code: -32602 } }),
    reply({ result: {} }),
    ok([tokenAccount("-1")]),
    ok([tokenAccount("1.5")]),
    ok([tokenAccount(12)]),
    ok([tokenAccount("1", { mint: "So11111111111111111111111111111111111111112" })]),
    ok([tokenAccount("1", { owner: "11111111111111111111111111111111" })]),
    ok([{ account: { data: "base64" } }]),
  ])
    await assert.rejects(solanaUsdcReader({ fetchImpl }).balance(SOL), /balance-unavailable/);
  for (const bad of ["", "0x" + "1".repeat(40), SOL + "0", "abc"]) await assert.rejects(solanaUsdcReader({ fetchImpl: ok([]) }).balance(bad), /invalid-address/);
});

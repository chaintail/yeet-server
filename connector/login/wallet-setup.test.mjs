// Wallet setup after sign-in (wallet-setup.js), with fake Privy calls: no React, no network.
import test from "node:test";
import assert from "node:assert/strict";
import * as walletSetup from "./wallet-setup.js";
import {
  STEPS,
  embeddedWallets,
  ensureWallets,
  setupComplete,
  setupErrorReport,
  walletAlreadyExists,
  requestServerSetup,
} from "./wallet-setup.js";
import { readFileSync } from "node:fs";

const BASE = { type: "wallet", walletClientType: "privy", chainType: "ethereum", address: "0xb45e", delegated: false };
const SOL = { type: "wallet", walletClientType: "privy", chainType: "solana", address: "So1ana", delegated: false };
const GOOGLE = { type: "google_oauth", email: "person@example.com" };
const user = (...accounts) => ({ id: "did:privy:abc", linkedAccounts: [GOOGLE, ...accounts] });
const EXISTS = Error("User already has an embedded wallet.");
const noSleep = async () => {};

/** A fake Privy account: create calls add the wallet (once, like Privy), refreshUser reads it back after `lag` reads. */
function fakePrivy(start, { lag = 0, failCreate = null } = {}) {
  const state = { accounts: [...start.linkedAccounts], calls: [], reads: 0, signers: [] };
  let pendingReads = 0,
    lastAdded = null;
  const add = (wallet) => {
    if (state.accounts.some((a) => a.type === "wallet" && a.chainType === wallet.chainType)) throw EXISTS;
    state.accounts.push({ ...wallet });
    lastAdded = wallet.chainType;
    pendingReads = lag;
  };
  return {
    state,
    createBase: async () => {
      state.calls.push("base");
      if (failCreate === "base") throw Error("network down");
      add(BASE);
      return BASE;
    },
    createSolana: async () => {
      state.calls.push("solana");
      if (failCreate === "solana") throw Error("network down");
      add(SOL);
      return { wallet: SOL };
    },
    refreshUser: async () => {
      state.reads++;
      if (pendingReads > 0) {
        pendingReads--;
        return { ...start, linkedAccounts: state.accounts.filter((a) => a.chainType !== lastAdded) };
      }
      return { ...start, linkedAccounts: [...state.accounts] };
    },
    addSigners: async ({ address, signers }) => {
      state.signers.push({ address, signers });
      state.accounts = state.accounts.map((a) => (a.address === address ? { ...a, delegated: true } : a));
      return { user: { ...start, linkedAccounts: [...state.accounts] } };
    },
  };
}

test("wallet setup: finds the Privy embedded wallets per chain and ignores other accounts", () => {
  const external = { type: "wallet", walletClientType: "metamask", chainType: "ethereum", address: "0xext" };
  const imported = { ...BASE, address: "0ximp", imported: true };
  assert.deepEqual(embeddedWallets(user(external, imported, SOL)), { base: undefined, solana: SOL });
  assert.deepEqual(embeddedWallets(user(BASE, SOL)), { base: BASE, solana: SOL });
  assert.deepEqual(embeddedWallets(null), { base: undefined, solana: undefined });
});

test("wallet setup: a user with no wallets gets one Base and one Solana wallet, in that order", async () => {
  const privy = fakePrivy(user());
  const steps = [];
  const out = await ensureWallets({ user: user(), ...privy, onStep: (s) => steps.push(s), sleep: noSleep });
  assert.deepEqual(steps, ["base", "solana"]);
  assert.deepEqual(privy.state.calls, ["base", "solana"]);
  const w = embeddedWallets(out);
  assert.equal(w.base.address, BASE.address);
  assert.equal(w.solana.address, SOL.address);
});

test("wallet setup: only the missing wallet is created; nothing is created when both exist", async () => {
  const onlyBase = fakePrivy(user(BASE));
  const steps = [];
  await ensureWallets({ user: user(BASE), ...onlyBase, onStep: (s) => steps.push(s), sleep: noSleep });
  assert.deepEqual(onlyBase.state.calls, ["solana"]);
  assert.deepEqual(steps, ["solana"]);

  const both = fakePrivy(user(BASE, SOL));
  const out = await ensureWallets({ user: user(BASE, SOL), ...both, sleep: noSleep });
  assert.deepEqual(both.state.calls, []);
  assert.deepEqual(both.state.reads, 0);
  assert.equal(embeddedWallets(out).solana.address, SOL.address);
});

test("wallet setup: 'already has an embedded wallet' counts as success and never creates a second wallet", async () => {
  // The page's copy of the user is stale: Privy already made both wallets (createOnLogin finished meanwhile).
  const privy = fakePrivy(user(BASE, SOL));
  const out = await ensureWallets({ user: user(), ...privy, sleep: noSleep });
  // The Base call answers "already has"; the re-read then shows the Solana wallet too, so it is not asked for.
  assert.deepEqual(privy.state.calls, ["base"]);
  assert.equal(privy.state.accounts.filter((a) => a.chainType === "ethereum").length, 1);
  assert.equal(privy.state.accounts.filter((a) => a.chainType === "solana").length, 1);
  assert.ok(embeddedWallets(out).base && embeddedWallets(out).solana);
  assert.ok(walletAlreadyExists(EXISTS));
  assert.ok(walletAlreadyExists({ message: "x", privyErrorCode: "embedded_wallet_already_exists" }));
  assert.ok(!walletAlreadyExists(Error("network down")));
  assert.ok(!walletAlreadyExists(undefined));
});

test("wallet setup: waits for a new wallet to show up on the user before moving on", async () => {
  const privy = fakePrivy(user(), { lag: 2 });
  let slept = 0;
  const out = await ensureWallets({ user: user(), ...privy, sleep: async () => slept++ });
  assert.ok(embeddedWallets(out).base && embeddedWallets(out).solana);
  assert.ok(slept >= 2, `slept ${slept}`);
});

test("wallet setup: a failed create or a wallet that never shows up stops with a code", async () => {
  const failing = fakePrivy(user(), { failCreate: "solana" });
  await assert.rejects(ensureWallets({ user: user(), ...failing, sleep: noSleep }), { code: "create-solana-failed" });
  assert.deepEqual(failing.state.calls, ["base", "solana"]);

  const never = { createBase: async () => BASE, createSolana: async () => ({ wallet: SOL }), refreshUser: async () => user() };
  await assert.rejects(ensureWallets({ user: user(), ...never, attempts: 3, sleep: noSleep }), { code: "wallets-not-ready" });
});

test("decision (b): sign-in never attaches the YEET signer; setup is complete with both wallets, delegated or not", () => {
  assert.equal(walletSetup.attachYeetSigner, undefined);
  assert.equal(walletSetup.chainsMissingSigner, undefined);
  assert.ok(!setupComplete({ signerId: "quorum-1" }, user(BASE)));
  assert.ok(setupComplete({ signerId: "quorum-1" }, user(BASE, SOL)), "no signer needed even if one is configured");
  const page = readFileSync(new URL("./src.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /addSigners|useSigners|attachYeetSigner/);
});

test("wallet setup: the failure report is structured and carries no addresses or emails", async () => {
  const report = setupErrorReport({ code: "create-solana-failed" }, user(BASE));
  assert.deepEqual(report, {
    event: "wallet_setup_failed",
    code: "create-solana-failed",
    has_base: true,
    has_solana: false,
    base_linked: false,
    solana_linked: false,
  });
  const text = JSON.stringify(report);
  assert.ok(!text.includes(BASE.address) && !text.includes("example.com"));
  assert.equal(setupErrorReport(Error("x"), null).code, "unexpected");
});

test("wallet setup: the waiting screen names each step in product words", () => {
  assert.deepEqual(
    STEPS.map((s) => s.text),
    ["Creating your Base wallet", "Creating your Solana wallet", "Linking to YEET"],
  );
  for (const s of STEPS) assert.doesNotMatch(s.text, /\b(demo|mock|sample|placeholder)\b/i);
});

// Server setup (POST /account/wallets): the page only posts its Privy access token and reads the answer.
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const READY = { ready: true, chains: { base: { signer: "none" }, solana: { signer: "none" } } };

test("server setup posts the Privy access token and returns the server's answer", async () => {
  const calls = [];
  const out = await requestServerSetup({
    getAccessToken: async () => "tok",
    fetch: async (url, init) => (calls.push({ url, init }), answer(200, READY)),
  });
  assert.equal(out.ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/account/wallets");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { privy_access_token: "tok" });
  assert.equal(out.chains.base.signer, "none");
});

test("server setup retries a server error and a network failure, then succeeds", async () => {
  const seq = [() => answer(502, { code: "PRIVY_HTTP_500", message: "x" }), () => { throw TypeError("net"); }, () => answer(200, READY)];
  let i = 0;
  const out = await requestServerSetup({ getAccessToken: async () => "tok", fetch: async () => seq[i++](), sleep: async () => {} });
  assert.equal(out.ready, true);
  assert.equal(i, 3);
});

test("server setup surfaces the server's plain text after the last attempt", async () => {
  await assert.rejects(
    requestServerSetup({
      getAccessToken: async () => "tok",
      fetch: async () => answer(502, { code: "PRIVY_HTTP_429", message: "Too many wallet requests right now." }),
      sleep: async () => {},
    }),
    (e) => e.code === "PRIVY_HTTP_429" && e.serverMessage === "Too many wallet requests right now.",
  );
  await assert.rejects(
    requestServerSetup({ getAccessToken: async () => "tok", fetch: async () => answer(401, { code: "SIGN_IN_REQUIRED", message: "m" }) }),
    (e) => e.code === "SIGN_IN_REQUIRED",
  );
});

// USDC on Base: funding options for Privy and a read-only balance adapter. No React here, so node --test can load it.

/** Native USDC on Base (Circle), 6 decimals. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = 8453;
/** Public Base RPC. The fund page CSP allows exactly this origin (as/fund-page.mjs BASE_RPC_ORIGIN). */
export const BASE_RPC = "https://mainnet.base.org";
export const DEFAULT_AMOUNT = "25";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Dollar amount as typed: 1 to 10000, at most 2 decimals. Returns the normalized string or null. */
export function validAmount(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 10000 ? String(n) : null;
}

/**
 * Options for Privy useFundWallet().fundWallet({address, options}) in @privy-io/react-auth 3.47.0 (FundWalletConfig,
 * the branch with `asset`, which requires `amount`): Base by chain id, USDC, card first with Coinbase as provider.
 */
export function fundOptions(amount) {
  const value = validAmount(amount);
  if (!value) throw Error("invalid-amount");
  return {
    chain: { id: BASE_CHAIN_ID },
    asset: "USDC",
    amount: value,
    defaultFundingMethod: "card",
    card: { preferredProvider: "coinbase" },
    uiConfig: { receiveFundsTitle: "Add USDC on Base", receiveFundsSubtitle: "Send USDC on Base to your YEET wallet." },
  };
}

/** eth_call payload for USDC balanceOf(address). */
export function balanceOfCall(address) {
  if (!ADDRESS.test(address)) throw Error("invalid-address");
  return { to: BASE_USDC, data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") };
}

/** 6-decimal base units to a dollar string with 2 decimals (rounded down, so it never overstates). */
export function formatUsdc(units) {
  const cents = BigInt(units) / 10000n;
  const whole = cents / 100n,
    frac = cents % 100n;
  return `${whole.toLocaleString("en-US")}.${frac.toString().padStart(2, "0")}`;
}

/** Native USDC on Solana (Circle), 6 decimals. login/fund-links.js uses the same mint. */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Public Solana RPC (answers browser CORS). The fund page CSP allows exactly this origin (as/fund-page.mjs SOLANA_RPC_ORIGIN). */
export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** getTokenAccountsByOwner payload: the owner's USDC token accounts, parsed, at confirmed commitment. */
export function solanaUsdcAccountsCall(owner) {
  if (!SOLANA_ADDRESS.test(owner)) throw Error("invalid-address");
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [owner, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
  };
}

/** USDC on Solana: the sum of the owner's USDC token accounts in base units. No account is a balance of 0. */
export function solanaUsdcReader({ fetchImpl = (...a) => globalThis.fetch(...a), rpcUrl = SOLANA_RPC } = {}) {
  return {
    async balance(owner) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(solanaUsdcAccountsCall(owner)),
      });
      if (!response.ok) throw Error("balance-unavailable");
      const body = await response.json();
      const accounts = body?.result?.value;
      if (!Array.isArray(accounts)) throw Error("balance-unavailable");
      let total = 0n;
      for (const a of accounts) {
        const info = a?.account?.data?.parsed?.info;
        const units = info?.tokenAmount?.amount;
        if (info?.mint !== SOLANA_USDC_MINT || info?.owner !== owner || typeof units !== "string" || !/^\d{1,20}$/.test(units))
          throw Error("balance-unavailable");
        total += BigInt(units);
      }
      return total;
    },
  };
}

/** Balance adapter over JSON-RPC eth_call. fetchImpl is injected; tests never reach the network. */
export function baseUsdcReader({ fetchImpl = (...a) => globalThis.fetch(...a), rpcUrl = BASE_RPC } = {}) {
  return {
    async balance(address) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [balanceOfCall(address), "latest"] }),
      });
      if (!response.ok) throw Error("balance-unavailable");
      const body = await response.json();
      if (typeof body?.result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(body.result)) throw Error("balance-unavailable");
      return BigInt(body.result);
    },
  };
}

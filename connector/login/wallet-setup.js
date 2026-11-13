// Wallet setup after sign-in, without React: the YEET server creates the missing wallets, owned by the person, with no
// additional signer (requestServerSetup; no browser wallet call). ensureWallets (browser creation) is kept for
// reference only and is not used by the page. src.jsx passes in the Privy 3.47.0 calls:
//   createBase   = useCreateWallet().createWallet            (Ethereum; resolves with the Wallet)
//   createSolana = useCreateWallet().createWallet from "@privy-io/react-auth/solana" (resolves with {wallet})
//   refreshUser  = useUser().refreshUser                      (resolves with the User)
// Both create calls throw "User already has an embedded wallet." (error code embedded_wallet_already_exists) when a
// wallet of that kind exists; that counts as success here. A wallet that already exists is never created again.

/** The person's YEET embedded wallets, one per chain (Privy User.linkedAccounts). */
export function embeddedWallets(user) {
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

/** Chains in setup order. */
export const CHAINS = ["base", "solana"];

/** The setup steps the waiting screen shows, in order. */
export const STEPS = [
  { id: "base", text: "Creating your Base wallet" },
  { id: "solana", text: "Creating your Solana wallet" },
  { id: "link", text: "Linking to YEET" },
];

/** True when a create call failed only because the wallet already exists. */
export function walletAlreadyExists(error) {
  const text = [error?.message, error?.privyErrorCode, error?.code, error?.error_code]
    .filter((x) => typeof x === "string")
    .join(" ");
  return /already has an embedded wallet|embedded_wallet_already_exists/i.test(text);
}

/** A setup error with a stable code for the page and the client log. */
export class SetupError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = "SetupError";
    this.code = code;
    this.cause = cause;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates whichever of the two embedded wallets the user lacks, one at a time, and returns the user once both are
 * on it. After each create it re-reads the user until the wallet shows up (`attempts` reads, `delayMs` apart).
 * onStep(chain) runs before a wallet is created; chains that already have a wallet are skipped without a step.
 */
export async function ensureWallets({
  user,
  createBase,
  createSolana,
  refreshUser,
  onStep = () => {},
  attempts = 10,
  delayMs = 1000,
  sleep = pause,
}) {
  const create = { base: createBase, solana: createSolana };
  let current = user;
  for (const chain of CHAINS) {
    if (embeddedWallets(current)[chain]) continue;
    onStep(chain);
    try {
      await create[chain]();
    } catch (e) {
      if (!walletAlreadyExists(e)) throw new SetupError(`create-${chain}-failed`, e);
    }
    let found = false;
    for (let i = 0; i < attempts && !found; i++) {
      if (i) await sleep(delayMs);
      try {
        current = (await refreshUser()) || current;
      } catch {
        // A failed read is retried like a wallet that has not shown up yet.
      }
      found = !!embeddedWallets(current)[chain];
    }
    if (!found) throw new SetupError("wallets-not-ready");
  }
  return current;
}

/**
 * Asks the YEET server to set up the wallets (POST /account/wallets): it creates whichever wallet is missing, owned by
 * the person, with the YEET signer attached. Resolves with {ready, chains: {base, solana}: {address, created, signer}}.
 * A network failure or a server error is retried (`attempts` calls, `delayMs` apart); the call is idempotent. A
 * refusal throws a SetupError whose `serverMessage` is the server's plain text for the page.
 */
export async function requestServerSetup({ getAccessToken, fetch = globalThis.fetch, attempts = 3, delayMs = 1500, sleep = pause }) {
  for (let i = 1; ; i++) {
    const token = await getAccessToken();
    if (!token) throw new SetupError("no-token");
    let res, body;
    try {
      res = await fetch("/account/wallets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ privy_access_token: token }),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      if (i >= attempts) throw new SetupError("server-unreachable", e);
      await sleep(delayMs);
      continue;
    }
    if (res.ok && body && typeof body.ready === "boolean") return body;
    if (res.status >= 500 && i < attempts) {
      await sleep(delayMs);
      continue;
    }
    const error = new SetupError(typeof body?.code === "string" ? body.code : `server-${res.status}`);
    error.serverMessage = typeof body?.message === "string" ? body.message : "";
    throw error;
  }
}

// Decision (b), gas sponsorship: the YEET server signer is never attached to a person's wallet. The person signs every
// trade in their own wallet; sign-in has no addSigners step. Wallets that still carry the old signer are cleaned up by
// ops/remove-yeet-signer.mjs.

/** True when the user has both wallets (no signer is needed: the person signs every trade). */
export function setupComplete(_config, user) {
  const w = embeddedWallets(user);
  return !!w.base && !!w.solana;
}

/** Structured, secret-free description of a setup failure (for the browser console). */
export function setupErrorReport(error, user) {
  const w = embeddedWallets(user);
  return {
    event: "wallet_setup_failed",
    code: error?.code || "unexpected",
    has_base: !!w.base,
    has_solana: !!w.solana,
    base_linked: !!w.base?.delegated,
    solana_linked: !!w.solana?.delegated,
  };
}

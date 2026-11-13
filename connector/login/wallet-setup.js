// Wallet setup after sign-in, without React or the network: find the person's YEET embedded wallets, create the
// ones that are missing, and give the YEET signer access to both. src.jsx passes in the Privy 3.47.0 calls:
//   createBase   = useCreateWallet().createWallet            (Ethereum; resolves with the Wallet)
//   createSolana = useCreateWallet().createWallet from "@privy-io/react-auth/solana" (resolves with {wallet})
//   refreshUser  = useUser().refreshUser                      (resolves with the User)
//   addSigners   = useSigners().addSigners                    (resolves with {user})
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
 * Lets the YEET server sign for both embedded wallets, within the YEET policies (one policy per chain). Runs when
 * /account/identity-config returns a signer id, so sign-in keeps working before the signer is registered. A wallet
 * that already has a delegated signer is left as it is, so a retry after a partial failure only adds what is missing.
 * Returns the latest user (addSigners answers with it).
 */
export async function attachYeetSigner({ config, user, addSigners }) {
  if (!config.signerId) return user;
  let current = user;
  for (const chain of CHAINS) {
    const wallet = embeddedWallets(current)[chain];
    if (!wallet) throw new SetupError("wallets-not-ready");
    if (wallet.delegated) continue;
    const policy = config.policyIds?.[chain];
    try {
      const out = await addSigners({
        address: wallet.address,
        signers: [{ signerId: config.signerId, ...(policy ? { policyIds: [policy] } : {}) }],
      });
      current = out?.user || current;
    } catch (e) {
      throw new SetupError(`link-${chain}-failed`, e);
    }
  }
  return current;
}

/** True when the user has both wallets and, if YEET has a signer, both carry it. */
export function setupComplete(config, user) {
  const w = embeddedWallets(user);
  if (!w.base || !w.solana) return false;
  return !config.signerId || (!!w.base.delegated && !!w.solana.delegated);
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

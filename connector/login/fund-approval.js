// The funding page shows a wallet address only while ALL of this holds (no React, no network):
//   - the server approved this exact visit: POST /fund/api/check compared the account behind the Privy user in the
//     browser with the account the page is for, and answered with that account's Privy user id and ITS wallet
//     addresses as the core holds them (as/fund-page.mjs);
//   - the Privy user in the browser now is still that user;
//   - the wallets the browser holds for that user are those same addresses.
// The addresses shown are the server's, never the browser's. The approval is tied to who was asked about
// (approvalKey): when the Privy user or its wallets change, the old approval no longer matches, the addresses are
// hidden in that same render and the server is asked again; an answer for an earlier question is dropped.

const text = (v) => (typeof v === "string" && v ? v : "");
/** Who the server is asked about: the Privy user id and the wallet addresses the browser holds for it. */
export function approvalKey(userId, wallets) {
  if (!text(userId)) return null;
  return [userId, text(wallets?.base?.address).toLowerCase(), text(wallets?.solana?.address)].join("|");
}
/** A check answer as the page keeps it: tied to the key it was asked for. */
export const approvalOf = (key, answer) => ({ key, ...answer });
/** The kept answer for THIS key, or "checking" when it belongs to another user or other addresses (or there is none). */
export function currentApproval(kept, key) {
  return kept && key && kept.key === key ? kept : { key, status: "checking" };
}
/**
 * The addresses the page may show, {base, solana}, or null. `approval`: currentApproval(...). `userId` and
 * `wallets`: the Privy user in the browser right now and its embedded wallets.
 */
export function approvedAddresses({ userId, wallets, approval }) {
  if (!approval || approval.status !== "ok" || !text(userId)) return null;
  if (approval.key !== approvalKey(userId, wallets)) return null;
  if (approval.user !== userId) return null;
  const base = text(approval.addresses?.base), solana = text(approval.addresses?.solana);
  if (!base || base.toLowerCase() !== text(wallets?.base?.address).toLowerCase()) return null;
  // Solana addresses are case sensitive. One the browser holds must be the server's; one the server does not confirm is not shown.
  const held = text(wallets?.solana?.address);
  if (held && solana && held !== solana) return null;
  return { base, solana: held && solana ? solana : null };
}
/** Reads a check response: -> {status: ok, user, addresses} | mismatch | expired | signin | error. */
export function readCheck(status, body) {
  if (status === 200 && body?.ok === true && text(body.user) && text(body.addresses?.base))
    return { status: "ok", user: body.user, addresses: { base: body.addresses.base, solana: text(body.addresses.solana) || null } };
  if (status === 409 && body?.code === "ACCOUNT_MISMATCH") return { status: "mismatch", message: text(body.message) };
  if (status === 410 && body?.code === "LINK_EXPIRED") return { status: "expired", message: text(body.message) };
  if (status === 401) return { status: "signin" };
  return { status: "error" };
}

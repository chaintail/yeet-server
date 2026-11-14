// What the funding page may show (login/fund-approval.js): only addresses the server confirmed for the bound
// account, only for the Privy user the approval was given for, hidden the moment either changes.
import test from "node:test";
import assert from "node:assert/strict";
import { approvalKey, approvalOf, approvedAddresses, currentApproval, readCheck } from "./fund-approval.js";

const A = { id: "did:privy:a", wallets: { base: { address: "0xAaAa000000000000000000000000000000000001" }, solana: { address: "SoLaNaAddressOfA1111111111111111111111111111" } } };
const B = { id: "did:privy:b", wallets: { base: { address: "0xBbBb000000000000000000000000000000000002" }, solana: { address: "SoLaNaAddressOfB2222222222222222222222222222" } } };
const serverFor = (u) => ({ status: "ok", user: u.id, addresses: { base: u.wallets.base.address.toLowerCase(), solana: u.wallets.solana.address } });
const keyOf = (u) => approvalKey(u.id, u.wallets);

test("approved: the server's addresses for the same user and the same wallets", () => {
  const approval = currentApproval(approvalOf(keyOf(A), serverFor(A)), keyOf(A));
  assert.deepEqual(approvedAddresses({ userId: A.id, wallets: A.wallets, approval }), { base: A.wallets.base.address.toLowerCase(), solana: A.wallets.solana.address });
});

test("the check passed for A, then Privy's user becomes B: A's approval shows nothing of B, in the same render", () => {
  const kept = approvalOf(keyOf(A), serverFor(A));
  // The page computes the key from who is here NOW. The kept answer is for another key: it reads as "checking".
  const now = currentApproval(kept, keyOf(B));
  assert.deepEqual(now, { key: keyOf(B), status: "checking" });
  assert.equal(approvedAddresses({ userId: B.id, wallets: B.wallets, approval: now }), null);
  // Even handed the old approval directly, B's addresses are never shown under it.
  assert.equal(approvedAddresses({ userId: B.id, wallets: B.wallets, approval: kept }), null);
  // Nor A's addresses while B is the user here.
  assert.equal(approvedAddresses({ userId: B.id, wallets: A.wallets, approval: kept }), null);
});

test("a stale answer is dropped: an answer for an earlier question never approves the current one", () => {
  // Asked for A, the user changed to B, A's answer arrives late and is kept under A's key.
  const late = approvalOf(keyOf(A), serverFor(A));
  assert.equal(currentApproval(late, keyOf(B)).status, "checking");
  // Asked for B; the server says mismatch. A's old ok is not what the page reads.
  const b = approvalOf(keyOf(B), { status: "mismatch", message: "x" });
  assert.equal(currentApproval(b, keyOf(B)).status, "mismatch");
  assert.equal(approvedAddresses({ userId: B.id, wallets: B.wallets, approval: currentApproval(b, keyOf(B)) }), null);
});

test("the wallets in the browser changed under the same user: hidden until the server confirms them", () => {
  const kept = approvalOf(keyOf(A), serverFor(A));
  const moved = { base: { address: B.wallets.base.address }, solana: A.wallets.solana };
  assert.equal(currentApproval(kept, approvalKey(A.id, moved)).status, "checking");
  assert.equal(approvedAddresses({ userId: A.id, wallets: moved, approval: kept }), null);
});

test("only addresses the server confirmed are shown; the server's answer must be about this very user and these wallets", () => {
  const key = keyOf(A);
  // The server names another user than the one here.
  assert.equal(approvedAddresses({ userId: A.id, wallets: A.wallets, approval: approvalOf(key, { ...serverFor(A), user: B.id }) }), null);
  // The server's address is not the one the browser holds.
  assert.equal(approvedAddresses({ userId: A.id, wallets: A.wallets, approval: approvalOf(key, { ...serverFor(A), addresses: serverFor(B).addresses }) }), null);
  assert.equal(approvedAddresses({ userId: A.id, wallets: A.wallets, approval: approvalOf(key, { ...serverFor(A), addresses: { base: serverFor(A).addresses.base, solana: B.wallets.solana.address } }) }), null);
  // The server confirmed no Solana address: Base only, never the browser's own Solana address.
  assert.deepEqual(approvedAddresses({ userId: A.id, wallets: A.wallets, approval: approvalOf(key, { ...serverFor(A), addresses: { base: serverFor(A).addresses.base, solana: null } }) }), { base: serverFor(A).addresses.base, solana: null });
  // Solana is case sensitive.
  assert.equal(approvedAddresses({ userId: A.id, wallets: A.wallets, approval: approvalOf(key, { ...serverFor(A), addresses: { base: serverFor(A).addresses.base, solana: A.wallets.solana.address.toLowerCase() } }) }), null);
  for (const approval of [null, undefined, { key, status: "checking" }, { key, status: "mismatch" }, { key, status: "error" }, { key, status: "ok" }])
    assert.equal(approvedAddresses({ userId: A.id, wallets: A.wallets, approval }), null);
  assert.equal(approvalKey("", A.wallets), null); assert.equal(approvalKey(undefined, A.wallets), null);
  assert.equal(approvedAddresses({ userId: undefined, wallets: A.wallets, approval: approvalOf(key, serverFor(A)) }), null);
});

test("the server's answers as the page reads them", () => {
  assert.deepEqual(readCheck(200, { ok: true, user: "did:privy:a", addresses: { base: "0x1", solana: "S1" } }), { status: "ok", user: "did:privy:a", addresses: { base: "0x1", solana: "S1" } });
  assert.deepEqual(readCheck(200, { ok: true }), { status: "error" }, "an ok with no addresses approves nothing");
  assert.deepEqual(readCheck(200, { ok: true, user: "did:privy:a", addresses: {} }), { status: "error" });
  assert.deepEqual(readCheck(409, { code: "ACCOUNT_MISMATCH", message: "m" }), { status: "mismatch", message: "m" });
  assert.deepEqual(readCheck(410, { code: "LINK_EXPIRED", message: "e" }), { status: "expired", message: "e" });
  assert.deepEqual(readCheck(401, null), { status: "signin" });
  for (const [s, b] of [[500, null], [503, { code: "TEMPORARILY_UNAVAILABLE" }], [409, {}], [403, null]]) assert.deepEqual(readCheck(s, b), { status: "error" });
});

test("the page source: addresses come only from the approval, and the user's own wallet object never reaches the wallet view", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./fund.jsx", import.meta.url), "utf8");
  const fund = src.slice(src.indexOf("function Fund("), src.indexOf("async function copyText"));
  assert.match(fund, /const shown = approvedAddresses\(\{ userId: user\?\.id, wallets, approval \}\)/);
  assert.match(fund, /<FundWallet readers=\{readers\} addresses=\{addresses\} \/>/);
  assert.match(fund, /base: shown && validAddress\("base", shown\.base\) \? shown\.base : null/);
  assert.doesNotMatch(fund, /addresses = \{[^}]*wallets\.(base|solana)/, "never the browser's own addresses");
  assert.match(fund, /currentApproval\(kept, key\)/);
});

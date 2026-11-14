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

test("N2: when the user or the wallets change, the funding screen is out of the tree in that same render, with no exit animation", async () => {
  const { fundView } = await import("./fund-approval.js");
  const { shownScreen, exitMs, OUT_MS } = await import("./screen-swap.js");
  const kept = approvalOf(keyOf(A), serverFor(A));
  // Render 1: A is approved. The funding screen, with A's (server-confirmed) addresses.
  const r1 = fundView({ ready: true, authenticated: true, userId: A.id, wallets: A.wallets, kept });
  assert.equal(r1.screen, "fund"); assert.equal(r1.addresses.base, serverFor(A).addresses.base);
  const settled = { id: r1.screen, leaving: false };
  // Render 2: Privy's user is B now; the kept answer is still A's (the new check has not answered).
  for (const [who, wallets] of [[B.id, B.wallets], [A.id, { base: B.wallets.base, solana: A.wallets.solana }], [B.id, A.wallets]]) {
    const r2 = fundView({ ready: true, authenticated: true, userId: who, wallets, kept });
    assert.notEqual(r2.screen, "fund");
    assert.deepEqual(r2.addresses, { base: null, solana: null }, "what this render passes down holds no address");
    // What the page's Swap puts in the tree for that render: this render's children, never the kept funding node.
    const tree = shownScreen({ id: r2.screen, view: settled, instant: true });
    assert.deepEqual(tree, { id: r2.screen, from: "children", leaving: false });
    // The whole of what is rendered, as data: nothing of the previous approval is in it.
    const rendered = JSON.stringify({ tree, screen: r2.screen, addresses: r2.addresses });
    for (const old of [serverFor(A).addresses.base, serverFor(A).addresses.solana, A.wallets.base.address]) assert.ok(!rendered.includes(old), old);
  }
  // Signed out: the same.
  const out = fundView({ ready: true, authenticated: false, userId: undefined, wallets: {}, kept });
  assert.equal(out.screen, "loading"); assert.deepEqual(out.addresses, { base: null, solana: null });
  assert.equal(shownScreen({ id: out.screen, view: settled, instant: true }).from, "children");
  // Without `instant` the old node WOULD stay for the exit animation: that is the case the page must never use.
  assert.deepEqual(shownScreen({ id: "loading", view: settled, instant: false }), { id: "fund", from: "kept", leaving: false });
  assert.equal(exitMs({ instant: true }), 0); assert.equal(exitMs({}), OUT_MS); assert.equal(OUT_MS, 420); assert.equal(exitMs({ reducedMotion: true }), 0);
  // The same screen asked again is simply the children.
  assert.deepEqual(shownScreen({ id: "fund", view: settled }), { id: "fund", from: "children", leaving: false });
});

test("fundView: an address is only ever on the fund screen, and only the server's", async () => {
  const { fundView } = await import("./fund-approval.js");
  const base = { ready: true, authenticated: true, userId: A.id, wallets: A.wallets };
  const at = (answer) => fundView({ ...base, kept: answer ? approvalOf(keyOf(A), answer) : null });
  assert.equal(at(null).screen, "loading");
  assert.equal(at({ status: "mismatch" }).screen, "mismatch");
  assert.equal(at({ status: "expired", message: "e" }).screen, "expired");
  assert.equal(at({ status: "error" }).screen, "error");
  assert.equal(at({ ...serverFor(A), user: B.id }).screen, "mismatch", "an ok that is not about this user approves nothing");
  assert.equal(fundView({ ...base, wallets: {}, kept: null }).screen, "waiting");
  assert.equal(fundView({ ...base, ready: false, kept: approvalOf(keyOf(A), serverFor(A)) }).screen, "loading");
  for (const v of [at(null), at({ status: "mismatch" }), at({ status: "expired" }), at({ status: "error" }), at({ ...serverFor(A), user: B.id })]) assert.deepEqual(v.addresses, { base: null, solana: null });
  // An address the page's own validator refuses is not shown either.
  assert.equal(fundView({ ...base, kept: approvalOf(keyOf(A), serverFor(A)), validAddress: () => false }).screen, "mismatch");
});

test("the page source: the screen and the addresses come from fundView, the Swap is instant, and the wallet view is keyed to the approval", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./fund.jsx", import.meta.url), "utf8");
  const fund = src.slice(src.indexOf("function Fund("), src.indexOf("async function copyText"));
  assert.match(fund, /const \{ screen, key, hasWallet, approval, addresses \} = fundView\(\{ ready, authenticated, userId: user\?\.id, wallets, kept, validAddress \}\)/);
  assert.match(fund, /<Swap id=\{screen\} instant>/);
  assert.match(fund, /<FundWallet key=\{approval\.key\} readers=\{readers\} addresses=\{addresses\} \/>/);
  assert.doesNotMatch(fund, /wallets\.(base|solana)\??\.address/, "never the browser's own addresses");
  const swap = readFileSync(new URL("./screen.jsx", import.meta.url), "utf8");
  assert.match(swap, /const shown = shownScreen\(\{ id, view, instant \}\)/);
  assert.match(swap, /\{shown\.from === "children" \? children : view\.node\}/);
});

test("N4: every wallet copy button runs: the address is copied and the note names the wallet", async () => {
  const { WALLET_NAMES, copyToWallet, walletLinks, NETWORKS } = await import("./fund-links.js");
  const { readFileSync } = await import("node:fs");
  const ids = new Set();
  const ADDRESS = { base: "0x8dC686928241E69D693A7a7A7a7270429e3c6c50", solana: "7x3qiZtcsqC2paa7p7XnfUffedPDNP7GvZVuMD7VXvDe" };
  for (const network of Object.keys(ADDRESS)) for (const l of walletLinks(network, ADDRESS[network], "25")) if (l.copy) ids.add(l.id);
  assert.deepEqual([...ids].sort(), ["coinbase", "phantom", "rainbow", "solflare"]);
  assert.ok(NETWORKS);
  for (const id of ids) {
    assert.equal(typeof WALLET_NAMES[id], "string", id);
    for (const ok of [true, false]) {
      const copied = [], notes = [];
      const line = await copyToWallet({ id, address: "ADDR", amount: "25", asset: "USDC", copy: async (t) => { copied.push(t); return ok; }, note: (t) => notes.push(t) });
      assert.deepEqual(copied, ["ADDR"], id); assert.deepEqual(notes, [line], id);
      assert.ok(line.includes(WALLET_NAMES[id]), line); assert.doesNotMatch(line, /undefined/);
      assert.match(line, ok ? /^Address copied\. In .+, send 25 USDC to it\.$/ : /^Copy did not work here\./);
    }
  }
  assert.throws(() => copyToWallet({ id: "metamask", address: "A", amount: "1", asset: "USDC", copy: async () => true, note() {} }), /No wallet named metamask/);
  // The page calls that function and names nothing it does not import or define.
  const src = readFileSync(new URL("./fund.jsx", import.meta.url), "utf8");
  assert.match(src, /copyToWallet\(\{ id, address, amount: sendValue, asset: net\.asset, copy: copyText, note: setLinkNote \}\)/);
  assert.doesNotMatch(src, /WALLET_NAMES/);
});

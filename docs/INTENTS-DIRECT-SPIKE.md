# NEAR Intents direct: multi-coin trade spike

One user signature swaps USDC into several meme coins and withdraws each to a Solana address. Our own solver account
fills it from inventory it holds inside the verifier contract. One NEAR transaction settles both sides. 1Click is used
only to get funds INTO the verifier and as a price source; the swap and the withdrawals never touch it, and no solver
relay is involved.

- Tool: `ops/intents-direct-spike.mjs`
- Module: `connector/core/intents/` (builders, signers, verifier RPC client, NEAR transaction, Omni bridge client,
  funding, the plan, the live steps)
- Tests: `connector/core/intents/intents.test.mjs` (39 tests, fixed vectors), part of `./runtests.sh`
- Dependencies added: **none**. NEAR transactions, borsh and NEP-413 are written by hand on `node:crypto`,
  `@noble/hashes` and `viem`, which the connector already pins.

A second model built on this one, where balances stay inside the verifier and the solver buys coins just in time, is
in `docs/INTENTS-BALANCE-MODEL.md`. Since that work `--margin-bps` defaults to 0 (it was 100 when this was written),
and `--plan` also runs that model's checks.

Status on 2026-11-13: `--plan` passes for both signing standards against mainnet. **Nothing has been sent or spent;
the live run has not been done.** What is proven and what is not is in sections 4 and 7.

All protocol facts below were read from primary sources on 2026-11-13:

| short name | source |
|---|---|
| contract | https://github.com/near/intents at `dbad9c8a4659e8bd7f42c152ec79448a8e9d281c` |
| SDK | https://github.com/defuse-protocol/sdk-monorepo at `930d2816081fbb1854fb7eace2c0d82e114703de` |
| Omni contract | https://github.com/Near-One/omni-bridge at `af6d95bb4c6a9e31aba0cd9d6f0fe5f7c8cd2dc9` |
| Omni JS | npm `@omni-bridge/near` and `@omni-bridge/core` 0.21.0 (read, not installed) |
| docs | https://docs.near-intents.org (the pages named in each row) |
| chain | NEAR mainnet view calls and transaction `7biSAtiJPQcoGb3evR1aouZChogem1YFqBmGyLiTH9Yj` |

---

## 1. Where the research map was wrong, and what replaced it

`NEAR-INTENTS-DIRECT-RESEARCH.md` is right about the verifier itself. Four things it says about getting coins OUT are
out of date. Each would have failed on the live run.

1. **Solana coins do not leave by the PoA bridge any more.** The map says `ft_withdraw` with memo
   `WITHDRAW_TO:<address>` to the token contract. WIF, BOME, TRUMP, USDC and every other `sol-*.omft.near` token we
   trade now leave through **`omni.bridge.near`**:
   - SDK `packages/intents-sdk/src/constants/poa-tokens-migrated-to-omni-bridge.ts` lists them, and
     `bridges/poa-bridge/poa-bridge.ts` `supports()` refuses them.
   - Chain: every recent WIF withdrawal from `intents.near` is `ft_transfer_call` to `omni.bridge.near`
     (for example tx `7biSAti…`), and `omni.bridge.near.get_bridged_token` maps each token to its Solana mint.
   - The docs page https://docs.near-intents.org/integration/bridging/overview.md still lists Solana under the PoA
     bridge. It is stale.
2. **The withdrawal intent has a different shape** (SDK `bridges/omni-bridge/omni-bridge-utils.ts`
   `createWithdrawIntentsPrimitive`):
   `{"intent":"ft_withdraw","token":"<sol-….omft.near>","receiver_id":"omni.bridge.near","amount":"<raw>","msg":"{\"recipient\":\"sol:<address>\",\"fee\":\"0\",\"native_token_fee\":\"<yoctoNEAR>\",\"external_id\":\"<uuid>\"}","min_gas":"37400000000000"}`.
   No memo. The whole `amount` arrives on Solana (6 decimals on both sides, read from `get_token_decimals`).
3. **The bridge fee is paid in NEAR, not in the coin.** The Omni fee API
   (`GET https://mainnet.api.bridge.nearone.org/api/v3/transfer-fee`) answers `transferred_token_fee: null` for our
   coins and a `native_token_fee` of about **0.0605 NEAR ($0.21) per coin when the recipient has no token account
   for that mint yet, and about 0.0029 NEAR ($0.01) when it has one** (both values also seen in real transactions).
4. **The NEAR account that signs `execute_intents` must hold a storage balance on `omni.bridge.near`.** Omni contract
   `near/omni-bridge/src/lib.rs` `ft_on_transfer` takes `env::signer_account_id()` as the storage payer; `init_transfer`
   and `storage.rs` `try_to_transfer_balance_from_message_account` return the tokens when that account is not
   registered or has too little available. The protocol's own relayer signs as `intents.near`, which keeps about 72 NEAR
   there. Our account needs its own deposit (step `--register-omni`). The map does not mention this at all.

Who pays the bridge fee is a choice (`--bridge-fee`), both read from `init_transfer`:

| mode | what the user signs | who pays the relayer | extra inventory |
|---|---|---|---|
| `signer` (default) | `token_diff` + one `ft_withdraw` per coin | the NEAR account that sends the transaction, from its storage balance on the bridge (`has_storage_balance(signer, storage + native_fee)`) | none |
| `intent` | `token_diff` + (`storage_deposit` + `ft_withdraw`) per coin | the user, in wNEAR that the solver adds to the diff; the `storage_deposit` intent sends exactly `native_token_fee` to the transfer's derived storage account (this is what the protocol's own frontends send; tx `7biSAti…`) | the solver stocks wNEAR; the signer still needs the message storage (0.00469 NEAR per transfer) |

`signer` is the default because it needs fewer intents, no wNEAR, and no race between the storage deposit and the
transfer (the bridge handles that race with a promise yield, but it is one more thing that can time out).

Smaller corrections: the `storage_deposit` intent's field is `deposit_for_account_id` (`account_id` is an accepted
alias; `core/src/intents/tokens.rs`). An ERC-191 payload altered after signing is refused as "public key … doesn't
exist for account …", not "invalid signature": the contract recovers a different key from the altered text.

---

## 2. Protocol facts the code relies on

### Verifier `intents.near`

| fact | source |
|---|---|
| Mainnet only. `execute_intents(signed: Vec<MultiPayload>)` and the view `simulate_intents(signed)`; neither checks who calls. | contract `contracts/defuse/src/contract/intents/mod.rs`; docs `integration/verifier-contract/introduction.md` |
| Order of checks per payload: signature, payload JSON, `verifying_contract`, deadline, the key belongs to `signer_id`, nonce (salt, intent deadline <= nonce deadline, not expired), nonce unused, then the intents run in list order; after the whole batch every token must net to zero. | contract `core/src/engine/mod.rs` `execute_signed_intent`, `verify_intent_nonce`, `finalize` |
| Payload: `{signer_id, verifying_contract:"intents.near", deadline (RFC 3339), nonce (base64, 32 bytes), intents:[…]}` as ONE compact JSON string; the string signed is the string sent. | contract `core/src/payload/mod.rs`; `crates/primitives/time/src/lib.rs` |
| Nonce V1: `56 28 f6 c6` \| `00` \| salt (4 bytes) \| deadline (8 bytes, i64 **nanoseconds**, little-endian) \| 15 random bytes. | contract `core/src/nonce/{versioned,salted,expirable}.rs` |
| Salt today `252812b3` (view `current_salt`); fee `1` pip = 0.0001% (view `fee`). Both are read live before every build. | chain |
| `token_diff`: prefixed ids `nep141:<contract>`, signed amount strings, any number of tokens. Fee = ceil(\|delta\| x fee / 1,000,000) on every negative delta. | contract `core/src/intents/token_diff.rs`; `crates/primitives/fees/src/lib.rs` |
| `ft_withdraw`: unprefixed `token`; does not take part in the zero-sum check, so it can spend what a diff in the same batch credited. | contract `core/src/intents/tokens.rs`; `core/src/engine/state/deltas.rs`; docs `integration/verifier-contract/deposits-and-withdrawals/withdrawals.md` |
| Balances: view `mt_batch_balance_of({account_id, token_ids})`. | docs `integration/verifier-contract/deposits-and-withdrawals/balances.md` |

### Signing

| standard | wire object | bytes the key signs | source |
|---|---|---|---|
| `raw_ed25519` | `{standard, payload:"<json>", public_key:"ed25519:<Solana address>", signature:"ed25519:<base58 64 bytes>"}` | the UTF-8 bytes of `payload`, no prefix, no hash | contract `core/src/payload/raw.rs` |
| `erc191` | `{standard, payload:"<json>", signature:"secp256k1:<base58 65 bytes>"}` (no public key: it is recovered) | keccak256(`"\x19Ethereum Signed Message:\n"` + byte length + payload); the last signature byte is **0 or 1** | contract `core/src/payload/erc191.rs`, `crates/signatures/erc191/src/lib.rs`, `crates/crypto/src/secp256k1.rs` |
| `nep413` (our solver) | `{standard, payload:{message:"<json without nonce>", nonce, recipient:"intents.near"}, public_key, signature}` | sha256(borsh(u32 `2147484061`, message, nonce[32], recipient, no callback)) | contract `core/src/payload/nep413.rs`, `crates/signatures/nep413/src/lib.rs` |

Accounts need no registration (contract `src/contract/intents/state.rs` `has_public_key`,
`core/src/public_key.rs` `to_implicit_account_id`): an ed25519 key owns the account `hex(32 key bytes)`, which for a
Solana wallet is its address in hex; a secp256k1 key owns `0x` + the EVM address in **lowercase**.

### Getting funds in

Deposits go through a 1Click quote with `recipientType: "INTENTS"` (docs
`integration/market-makers/hot-to-omni.md`, changelog entry of 2026-11-11 closing the Bridge API). A same-asset quote
(USDC on Solana to USDC on Solana) is the deposit. Dry quotes on 2026-11-13, no API key: the same-asset deposit quoted
`amountOut == amountIn` (4.5 USDC in, 4.5 out), and 2 USDC of WIF quoted $1.98 out.

### NEAR transaction

Written by hand in `near-tx.mjs` (nearcore `TransactionV0` borsh layout); checked against near-api-js's own vectors
(`test/unit/transactions/serialize.test.ts`, `data/transaction1.json` at `999eeee`). An implicit NEAR account is the
hex of an ed25519 key and exists once NEAR is sent to it. **The same key and the same account id are the solver's
verifier account**, so one key file is solver and caller.

---

## 3. Commands for the Director, in order

`--plan` first. It needs no secret and sends nothing:

```
node ops/intents-direct-spike.mjs --plan
```

Expected last lines: one `{"step":"plan_result","standard":"raw_ed25519","ok":true,…}`, one for `erc191`, then
`{"step":"done","mode":"plan","ok":true}` and exit code 0.

The live run. `NEARKEY` is a path for a NEW key file (the tool creates it, mode 0600); `WALLET` is the test wallet
file made by `ops/test-wallet-init.mjs`. Every step prints JSON lines, never a key, and can be run again safely: it
keeps its progress in `NEARKEY.state.json` and never pays twice.

```
export INTENTS_SPIKE_CONFIRM=send-spike
S="node ops/intents-direct-spike.mjs --live --near-key NEARKEY --wallet WALLET"

$S --setup                              # 1. creates the key, prints the NEAR account id and what it needs
$S --setup --fund-near-from-1click      # 1b. or send 0.6 NEAR to that account id from any NEAR wallet instead
$S --setup                              #     again: near_balance must now be about 0.5 or more
$S --register-omni                      # 2. storage balance on omni.bridge.near (about 0.26 NEAR)
$S --stock                              # 3. solver inventory: 2 USDC each of WIF, BOME, TRUMP
$S --deposit-user                       # 4. 4.5 USDC into the user's verifier account
$S --trade                              # 5. sign both intents, simulate, execute, follow to Solana (up to 10 min)
$S --status                             # 6. any time: balances everywhere and the trade's state
$S --withdraw-all solver                # 7. afterwards: the solver's USDC and leftover coins back to the wallet
```

| step | what you should see | if not |
|---|---|---|
| `--setup` | `{"step":"setup","near_account":"<64 hex>","account_exists":false,…,"needs":{…}}` the first time | |
| `--setup --fund-near-from-1click` | stages `quoted`, `transfer_sent`, `solana_confirmed`, `oneclick_status … SUCCESS`, then `{"step":"fund_near","stage":"result","account_exists":true,"near_balance":"0.5…"}` | `account_exists:false` after SUCCESS means 1Click delivered wNEAR, not NEAR: fund the account directly. `REFUNDED` returns the USDC to the wallet. |
| `--register-omni` | `near_tx_outcome … "ok":true`, then `{"stage":"result","enough":true}` | "no access key yet": the account has no NEAR |
| `--stock` | three funding legs, then `{"step":"stock","stage":"result","balances":{"WIF":"13…","BOME":"34…","TRUMP":"18…"},"ok":true}` | a leg `still_pending`: run the step again |
| `--deposit-user` | `{"step":"deposit_user","stage":"result","usdc_balance":"4500000","ok":true}` | |
| `--trade` | `simulated … "outcome":"PASSED"`, `near_tx_sent`, `near_tx_outcome … "ok":true`, `verifier_balances` (user USDC delta `-4500000`, solver `+4499995`), three `arrived_on_solana` lines, then `{"stage":"result","ok":true,"seconds":{…}}` and exit code 0 | `refused` names the fix. If the simulation does not pass, nothing is sent. |

Options: `--user-evm` makes the user sign ERC-191 with the wallet's EVM key (the user's verifier account is then the
`0x…` address, so run `--deposit-user --user-evm` first); `--new-trade` files a finished trade away so a second one
can run; `--recipient <solana address>` (default: the wallet's own); `--bridge-fee intent`; `--coins`, `--usdc`,
`--stock-usdc`, `--margin-bps 100`, `--fee-payer privy` (the YEET fee payer pays the Solana fees of the deposits
instead of the wallet), `--follow-s 600`, `--deadline-s 300`. Env read: `ONECLICK_JWT`, `SOLANA_RPC_URL`,
`NEAR_RPC_URL` (all optional; public endpoints otherwise).

A second trade with the other signing standard, from the inventory left over (about a quarter of each coin):

```
$S --deposit-user --user-evm --usdc 1.2
$S --trade --user-evm --usdc 1.2 --new-trade
```

The timing the owner asked for is in the final `result` line of `--trade`:
`seconds.sign_to_submit`, `submit_to_included`, `submit_to_executed`, `submit_to_arrival` per coin,
`submit_to_last_arrival`, and `bridge[].bridge_seconds` (the bridge's own record). Every stage also has an ISO
timestamp in `timestamps`.

---

## 4. What `--plan` proved (2026-11-13, mainnet, public RPC)

Throwaway keys, so the accounts hold nothing. For each of `raw_ed25519` and `erc191` (the solver signs `nep413`):

| check | `simulate_intents` answered |
|---|---|
| the real trade `[solver, user]` | panic `insufficient balance or overflow` |
| the real user payload alone | the same |
| the real solver payload alone | the same |
| user payload without the USDC debit, **with all three withdrawal intents** | no panic; `intents_executed` lists the payload with the intent hash we computed locally; `invariant_violated.unmatched_deltas` = exactly the three coin amounts |
| solver payload without the coin debits; both together | the same shape |
| each coin's route: `get_bridged_token` = our catalogue mint, the bridge is registered on the token, equal decimals | open for WIF, BOME, TRUMP |

"Insufficient balance" is raised while the engine applies the first delta. Signature, payload JSON, verifying
contract, deadline, key ownership, salt and nonce are all checked before that, so they were accepted. The second
group shows the same payloads running to the very end of the engine, withdrawals included, with only the missing
counterparty funds reported. The contract offers no way to simulate with made-up balances.

Negative cases (each on a payload that otherwise runs to the end):

| case | answer |
|---|---|
| intent altered after signing, `raw_ed25519` | `invalid signature` |
| intent altered after signing, `erc191` | `public key 'secp256k1:…' doesn't exist for account '0x…'` |
| solver `nep413` message altered | `invalid signature` |
| deadline in the past | `deadline has expired` |
| the same nonce twice in one batch | `nonce was already used` |
| diffs that do not net to zero | `invariant_violated` |
| nonce with a salt the contract does not hold | `invalid salt` |
| intent deadline later than the nonce deadline | `deadline is greater than nonce` |
| signed for another verifying contract | `wrong verifying_contract` |

18 of 18 checks as expected for each standard, in both `--bridge-fee` modes. A five-coin basket
(WIF, BOME, TRUMP, MELANIA, SPX; one payload of 2,539 bytes) passed the same plan.

Also proven by the unit tests against primary data: our NEP-413 hashing reproduces the `intent_hash` values the
mainnet contract logged for two real payloads; our Omni storage account derivation and both Omni intents are byte for
byte those of a real mainnet withdrawal; the three signing standards verify the contract's own test vectors; the NEAR
transaction bytes match near-api-js's vectors.

---

## 5. Costs

| item | amount | note |
|---|---|---|
| verifier fee | 1 pip (0.0001%) of each amount given | read live |
| NEAR gas, `execute_intents` | 300 Tgas attached = 0.03 NEAR prepaid at today's price; a real one-withdrawal call burnt 32 Tgas (0.0032 NEAR) | the rest is refunded |
| Omni relayer fee | about 0.0605 NEAR ($0.21) per coin to a wallet without that token account; about 0.0029 NEAR ($0.01) with one | so about $0.63 for a first three-coin trade, $0.03 after |
| Omni storage | 0.00141 NEAR once to register; 0.00469 NEAR locked per pending transfer | `--register-omni` deposits 1.3 x one trade's need |
| 1Click, deposit into the verifier | same-asset quote: out = in | dry quote, no API key |
| 1Click, buying inventory | about 1% at $2 size (2 USDC gave $1.98 of WIF) | dry quote |
| Solana | each 1Click deposit address needs a token account: 0.00204 SOL rent plus the fee, five or six times | from the wallet, or `--fee-payer privy` |

**Test-wallet USDC for the live run: 12.5** (2 for NEAR, 6 for inventory, 4.5 for the user). 10.5 if the NEAR account
is funded directly. Plus about 0.015 SOL in the wallet unless the fee payer is used. The second, ERC-191 trade adds
1.2 USDC. Afterwards the solver holds the user's 4.5 USDC and the unused inventory inside the verifier;
`--withdraw-all solver` sends them back to the wallet.

The solver's margin (default 100 bps under the quoted amount) does not cover the first-time bridge fee at this size:
in `signer` mode the solver pays about $0.63 on a $4.50 trade. For production the fee belongs in the price.

---

## 6. Risks

- **Bridge time.** Not documented. Two real WIF withdrawals today took 68 s and 69 s from the NEAR transaction to the
  Solana payout (Omni API `/api/v4/transfers/transfer`: `initialised` to `finalised`). The SDK's own table
  (`constants/withdrawal-timing.ts`) carries a p99 of 1,387 s for Solana. Our own number does not exist until
  `--trade` runs. For comparison, our 1Click settles measured 114 s and 171 s.
- **A withdrawal that fails.** The swap is atomic and already final when a withdrawal fails. Three cases, from
  contract `src/contract/tokens/nep141/withdraw.rs` `ft_resolve_withdraw` and Omni `init_transfer`:
  1. The bridge refuses the transfer (the signer has no storage balance or too little, or the wait for the storage
     deposit times out): the tokens come back and the verifier credits them to **the user's verifier balance**.
     `--trade` reports this as `withdrawals_returned_to_verifier`. Withdraw again with `--withdraw-all user` (a fresh
     signed payload with new `ft_withdraw` intents); in the product this is a "retry withdrawal" sign request.
  2. The `ft_transfer_call` itself fails (not enough gas, or the bridge not registered on the token): the contract
     does **not** refund, by design. We attach the SDK's 37.4 Tgas minimum and `--trade` refuses unless
     `storage_balance_of(omni.bridge.near)` exists on each token, which are the two known causes.
  3. The bridge accepts and the relayer does not pay out (for example the `native_token_fee` we named is below what
     it takes at that moment): the tokens are burnt on NEAR and the transfer is pending at the bridge. This is the
     bridge's own failure mode; `--status` shows the bridge record. The tool takes the fee from the bridge's API
     seconds before signing; we have no remedy of our own beyond that.
- **PENGU.** Its token is `sol-0x….omdep.near`, an Omni-native id, not a migrated `omft` one. The SDK sends both
  kinds through the same builder, so it probably works unchanged, but nothing here checked it: the spike refuses it.
- **Gas ceiling.** Each Omni withdrawal reserves 52.4 Tgas up front (77.4 in `intent` mode). One 300 Tgas transaction
  carries at most 5 withdrawals in `signer` mode and 3 in `intent` mode; the tool refuses more. Whether the network
  accepts more than 300 Tgas per transaction today was not checked.
- **Price source.** 1Click answered "No liquidity available" to a dry quote for a $1 MELANIA leg. The tool then
  prices from 1Click's token list (`price_source: "tokens_list"`), which can be stale. Our solver carries that risk.
- **Inventory and price risk.** The solver trades from its own stock at a quote taken seconds earlier; the intents
  expire after 5 minutes. Stock must be bought ahead and rebalanced.
- **NEAR for a new account.** Whether 1Click delivers native NEAR to an implicit account that does not exist yet is
  not documented. The SDK withdraws `nep141:wrap.near` to a NEAR account as native NEAR (`native_withdraw`,
  `bridges/direct-bridge/direct-bridge-utils.ts`), which would create the account, but 1Click's own behaviour was not
  observed. Sending NEAR directly is the certain way.
- **Salt rotation.** The salt can change between build and execute; the trade then fails in simulation with
  `invalid salt` and nothing is sent. Run `--trade` again.
- **Docs lag the code.** Section 1 exists because the official docs still describe the old route. Re-run `--plan`
  before any live run: its route check reads the chain.

---

## 7. Not proven yet

- The live trade itself: funded balances passing `simulate_intents`, `execute_intents` from our own account, the
  three coins arriving on Solana, and the timing.
- The `signer` fee path on the bridge with **our** account as signer (read in the contract source, never run by us).
  The `intent` path is the one seen on chain, but there too the signer was `intents.near`, not an outside account.
- 1Click crediting an account inside the verifier from a Solana USDC deposit (`recipientType: INTENTS`): accepted in
  dry quotes, including for an EVM-style `0x…` account; not executed.
- Privy producing these signatures (section 8): the spike signs with local keys.

---

## 8. Plugging into the YEET pipeline as a second route

Today a Solana basket is N 1Click quotes paid by one user-signed Solana transaction (`pipeline/solana/driver.mjs`,
`prepareLegs`). The direct route changes what the person signs from a transaction to a **message**:

1. **Funds.** The person's USDC must be in their verifier account. Either a deposit step before the first trade
   (one signed Solana transfer to a 1Click deposit address, as now, with `recipientType: INTENTS` and the same-asset
   quote), or keep a balance there. Base USDC can credit the same account (the recipient is any account id).
2. **Build** (server): read `current_salt` and `fee`, price the legs, read the Omni fee per coin, then
   `basket.mjs buildBasketTrade` gives the user payload string and the solver's signed diff. Store both with the trade.
3. **One sign request per basket.** A new sign-request kind next to `solana_tx` and `evm_tx`
   (`pipeline/wallet-request.mjs`), carrying the payload string. `intents/wallet-adapter.mjs` has the mapping:

   | wallet | Privy wallet RPC (`POST /v1/wallets/{id}/rpc`, or the same method in the card SDK) | answer | wire object |
   |---|---|---|---|
   | Solana | `{"method":"signMessage","params":{"message":"<base64 of the payload's UTF-8 bytes>","encoding":"base64"}}` | `data.signature`, base64 of 64 bytes | `raw_ed25519`; `public_key` = `ed25519:` + the Solana address; account = the address bytes in hex |
   | EVM | `{"method":"personal_sign","params":{"message":"<the payload string>","encoding":"utf-8"}}` | `data.signature`, `0x` + 65 bytes ending `1b` or `1c` | `erc191`; **subtract 27 from the last byte** (the contract takes 0 or 1), base58, prefix `secp256k1:`; account = the address in lowercase |

   `multiPayloadFromPrivy` verifies the answer locally before anything is submitted. This matters for Solana: Privy's
   page does not say that `signMessage` signs the bytes without a prefix. If it adds one, the check fails here and the
   route falls back to 1Click. Whether YEET's Privy policies allow `personal_sign` / `signMessage` was not checked.
4. **Submit** (server): `simulate_intents([solver, user])` must pass, then our NEAR account sends `execute_intents`.
   No fee payer, no Solana transaction, no deposit address per leg.
5. **Track.** The NEAR transaction outcome settles the swap in a few seconds; then the Omni transfer per coin
   (`omni.mjs transfers`) and the token balances on Solana, as `live.mjs followTrade` does. A returned withdrawal
   becomes a "retry withdrawal" sign request.

What it needs that the 1Click route does not: a solver account with inventory inside the verifier and a rebalancing
job; NEAR for gas and for the bridge; the bridge storage balance kept topped up; our own refund and status handling.
What it gives: one signature for the whole basket instead of one transaction over N quotes, an atomic swap, and no
dependence on 1Click's routing for meme liquidity.

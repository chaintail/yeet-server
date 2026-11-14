# NEAR Intents balance model: funds stay inside the verifier, coins are bought just in time

Extends `docs/INTENTS-DIRECT-SPIKE.md` (same tool, same module). Status on 2026-11-13: `--plan` passes on mainnet for
both user signing standards. **Nothing has been sent or spent. No live step has been run.** Section 9 lists what the
live run still has to prove; the timings are the main item.

- Tool: `ops/intents-direct-spike.mjs`
- New code: `connector/core/intents/jit.mjs` (builders, pricing rule), `balance-plan.mjs` (plan), `live-jit.mjs`
  (live steps), `omni-deposit.mjs` (deposit without 1Click)
- Tests: `jit.test.mjs` (16), `omni-deposit.test.mjs` (4), part of `./runtests.sh`

## 1. The model in ten lines

1. Each person has an account inside the contract `intents.near` (the verifier). The account is owned by their own
   key: their Privy Solana key (account id = the address in hex) or their EVM key (account id = the `0x` address).
2. Their USDC sits in that account. So do the coins they buy. Nothing sits on Solana or Base between trades.
3. Funding: USDC sent from Solana or Base is credited to that account (through 1Click, or from Solana directly through
   the Omni bridge program with no 1Click at all).
4. A buy is ONE signed message from the person: "I give 3 USDC, I receive at least N WIF, M BOME, K TRUMP". No
   withdrawal, no transaction of theirs, no gas.
5. Our solver account holds USDC only, no coin stock. After the person signs, it buys exactly those coins inside the
   verifier (a 1Click quote with the verifier on both sides), about 12 s by 1Click's own estimate.
6. Our NEAR account then sends one `execute_intents` with the solver's message and the person's message. Both settle
   atomically or not at all.
7. The person receives everything the solver bought, not only the minimum they signed for. We keep nothing
   (`--margin-bps 0`, the owner's ruling for the hackathon; it stays a setting).
8. If the solver cannot buy in time, it does not execute. The person's message expires; nothing of theirs moved.
9. A sell is the reverse: the solver pays USDC at once from its float, then sells the coin it received.
10. A withdrawal to Solana happens …: one more signed message.

## 2. Sources

Everything below was read or probed on 2026-11-13. "Probe" means a read-only call made by this spike: a dry quote, a
view call, a simulation, or a public transaction read.

| short name | source |
|---|---|
| OpenAPI | https://1click.chaindefuser.com/docs/v0/openapi.yaml |
| fees | https://docs.near-intents.org/resources/fees.md |
| fee config | https://docs.near-intents.org/integration/distribution-channels/1click-api/fee-config.md |
| API keys | https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md |
| signed intents | https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution.md |
| reusable addresses | https://docs.near-intents.org/integration/distribution-channels/1click-api/reusable-deposit-addresses.md |
| swap limits | https://docs.near-intents.org/resources/swap-limits.md |
| deposits | https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits.md |
| balances | https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances.md |
| bridges | https://docs.near-intents.org/integration/bridging/overview.md |
| Omni overview | https://docs.near-intents.org/learn/omni-bridge/overview.md |
| market makers | https://docs.near-intents.org/integration/market-makers/quickstart.md and `message-bus/rpc.md` |
| changelog | https://docs.near-intents.org/changelog/overview.md |
| contract | https://github.com/near/intents at `dbad9c8a4659e8bd7f42c152ec79448a8e9d281c` |
| Omni repo | https://github.com/Near-One/omni-bridge at `af6d95bb4c6a9e31aba0cd9d6f0fe5f7c8cd2dc9` |

## 3. Just-in-time sourcing inside the verifier: it works without an API key

**Mechanics, verified by probe:**

1. `POST /v0/quote` with `depositType: "INTENTS"`, `recipientType: "INTENTS"`, `refundType: "INTENTS"` and the
   solver's account as `recipient` and `refundTo` is answered **without an `X-API-Key`**, dry and committed.
2. A committed quote returns `depositAddress` = a 64-hex account **inside the verifier** (probe:
   `548b34d8…7225`, `cc02aa35…dab8`). OpenAPI, `Quote.depositAddress`: "The deposit address inside NEAR Intents (the
   verifier smart contract) when `depositType` is `INTENTS`".
3. The solver pays the quote with a `transfer` intent: `{"intent":"transfer","receiver_id":"<depositAddress>",
   "tokens":{"nep141:sol-5ce3…omft.near":"<amountIn>"}}`. We sign it with the solver key (NEP-413) and our own NEAR
   account submits it with `execute_intents`. No 1Click endpoint is needed for this step.
   - Proof of the shape: `POST /v0/generate-intent` (type `swap_transfer`) answered HTTP 201 **without a key** with
     exactly this intent for our probe quote. `--plan` compares it with ours on every run (`sourcing_probe`: `SAME`).
   - Contract: `core/src/intents/tokens.rs` `Transfer` moves balances inside the contract, takes no fee, refuses a
     transfer to the signer itself (`--plan`: `INVALID_INTENT`).
   - The signed-intents doc says `generate-intent` and `submit-intent` "use partner authentication". Today both
     answer without a key (`submit-intent` with an empty body returns a validation error, not 401). We do not depend
     on either: we execute the transfer ourselves. If they start to require a key, nothing here changes.
4. 1Click delivers the coin to the solver's verifier account. Since 2026-10-27 its swaps settle on the NEAR Private
   Shard (changelog), so the swap itself has no public transaction; the credit to our account is public and is what
   the tool waits for (`mt_batch_balance_of`).

**Dry quotes, no API key, verifier on both sides** (20:20 to 20:25 UTC; `amountInUsd`/`amountOutUsd` are 1Click's marks):

| coin | 5 USDC buys | sold straight back gives | `timeEstimate` buy / sell | same buy, chain to chain | its `timeEstimate` |
|---|---|---|---|---|---|
| WIF | 32,949,747 raw ($4.947) | 4.9115 USDC | 12 s / 12 s | $4.735 of WIF | 19 s |
| BOME | quoted at every size | 4.959 USDC | 12 s / 12 s | $4.78 of BOME | 19 s |
| TRUMP | quoted at every size | 4.960 USDC | 12 s / 12 s | $4.78 of TRUMP | 19 s |

All 12 coin and size combinations (WIF, BOME, TRUMP at 5, 10, 15, 25 USDC) quoted in both directions, also at 1 and
1.5 USDC. No minimum was met (swap limits: the USD minimums apply to chain-to-chain quotes only). Base USDC
(`nep141:base-0x8335…omft.near`) as the paying asset quoted the same amounts.

**Fees seen in the quotes.** Our code sets no `appFees`. The echo of every keyless swap quote carries
`"appFees":[{"recipient":"5880ad2b…47dd","fee":20}]`: that entry is **1Click's own platform fee**, added by 1Click
(the recipient is a 1Click account holding 181 tokens). The fees page says keyless requests pay "an additional 0.25%
(25 bps)" and keyed requests 20 bps (1 bp for stablecoin pairs and same-asset routes). What we observe keyless is 20
on swaps, 1 on USDC(Base) to USDC(Solana), and an empty list on a same-asset deposit. Whether 5 more bps hide in the
price cannot be seen from outside; the round trip below bounds everything together. `refundFee` and `withdrawFee`
are 0 on internal quotes; on chain-to-chain quotes `withdrawFee` is a flat amount worth about $0.21, which is what
makes small trades expensive there.

### All-in cost of a buy, balances staying inside the verifier

One single-coin buy. "Sourcing" is half of what a buy plus an immediate sell loses (it needs no USD mark; it contains
1Click's 20 bps and the market makers' spread). Protocol fee: 1 pip on each leg, under $0.0001. NEAR gas: 2 calls of
ours at an upper bound of 0.003 NEAR each at $3.54 (25 recent `execute_intents` calls on mainnet cost 0.00055 to
0.0011 NEAR without a withdrawal; ours is unmeasured). Our fee: 0.

| coin | size | sourcing | NEAR gas (bound) | **all-in** | all-in % | chain to chain today | % |
|---|---|---|---|---|---|---|---|
| WIF | 5 | $0.036 | $0.021 | **$0.057** | 1.15% | $0.248 | 4.97% |
| WIF | 10 | $0.077 | $0.021 | **$0.099** | 0.99% | $0.294 | 2.94% |
| WIF | 15 | $0.122 | $0.021 | **$0.143** | 0.95% | $0.347 | 2.31% |
| WIF | 25 | $0.210 | $0.021 | **$0.231** | 0.92% | $0.452 | 1.81% |
| BOME | 5 | $0.021 | $0.021 | **$0.042** | 0.84% | $0.219 | 4.39% |
| BOME | 10 | $0.041 | $0.021 | **$0.062** | 0.62% | $0.224 | 2.24% |
| BOME | 15 | $0.061 | $0.021 | **$0.082** | 0.55% | $0.231 | 1.54% |
| BOME | 25 | $0.103 | $0.021 | **$0.124** | 0.50% | $0.239 | 0.96% |
| TRUMP | 5 | $0.020 | $0.021 | **$0.042** | 0.83% | $0.213 | 4.26% |
| TRUMP | 10 | $0.040 | $0.021 | **$0.061** | 0.61% | $0.225 | 2.25% |
| TRUMP | 15 | $0.061 | $0.021 | **$0.082** | 0.55% | $0.209 | 1.39% |
| TRUMP | 25 | $0.099 | $0.021 | **$0.121** | 0.48% | $0.228 | 0.91% |

A 5 USDC buy costs 4 to 6 cents all-in instead of 21 to 25 cents. The gas is per trade, not per coin, so a
three-coin basket pays it once. The docs put the keyed 1Click fee at the same 20 bps we already see without a key.
WIF's spread is about twice that of BOME and TRUMP at every size. The chain route
also charges Solana fees and token-account rent that the table leaves out. `--plan` prints this table live
(`cost_table`); `--sizes` changes the sizes.

### If keyless sourcing stops working

In order of preference: (a) the same quotes with an `X-API-Key` (section 10); (b) outside sourcing, built
(`--source outside`, section 5); (c) the relay's `quote` + `publish_intent` (the earlier probe got `null` for meme
pairs without a key; with a market-maker key this needs KYC/KYB); (d) a small pre-held coin stock as a buffer
(`--stock`, `--trade` of the first spike).

## 4. The buy flow and the order we chose

**Chosen: firm quotes, then the person signs, then the solver pays the quotes, then it executes.**

1. Committed quotes (verifier on both sides), one per coin, in parallel. A committed quote costs and commits nothing
   until it is paid; it gives `amountOut` and `minAmountOut` (`--source-slippage-bps`, default 100).
2. The person signs one `token_diff`: `-total USDC`, `+floor` of each coin, deadline 120 s. The floor is
   `minAmountOut` less the contract's 1 pip.
3. The tool simulates the person's payload alone. It must pass every check and stop only at the missing counterparty
   (`INVARIANT_VIOLATED`). Otherwise nothing is bought.
4. The solver signs ONE payload with one `transfer` intent per quote; our NEAR account executes it (first NEAR call);
   1Click is told the transaction hash (`/v0/deposit/submit`, optional).
5. The tool watches the solver's coin balances (`mt_batch_balance_of`) until each has grown by at least the minimum,
   or 1Click reports `REFUNDED`/`FAILED`, or the deadline minus `--min-left-s` (10 s) passes.
6. The solver signs its settlement: the exact mirror `token_diff`, plus a `transfer` intent that hands the person
   everything it sourced above the floor. `simulate_intents([solver, user])` must pass.
7. Second NEAR call: `execute_intents([solver, user])`. The tool then reads both accounts' balances.

Bounds, checked in code:

- The solver spends exactly the USDC the person pays. Its USDC loss is the contract fee (3 raw units on 3 USDC);
  `--max-loss-bps` (default 10) refuses anything larger before the person signs.
- The solver never gives more of a coin than it holds at that moment, and never settles a leg that delivered less
  than the person's floor (`settleBuy` returns `short`; unit tests cover one unit below the floor).
- Not executed means: the person's intent expires, their balances did not change, and the solver holds at most one
  basket of coins. `--unload` sells them back to USDC inside the verifier; a leg 1Click refunds returns by itself.

**The alternative, source first and then ask for the signature**, was not chosen. For it: the person signs for
amounts that already exist, so the trade cannot fail after signing. Against it: the solver buys before anyone is
committed, so every abandoned confirmation leaves it holding coins and paying the spread twice to unload (0.8% to
1.8% of the basket); with a human in front of a wallet prompt that is the common case, not the rare one. In the
chosen order the cost of failure falls on the solver only when 1Click fails or is slow, and the person never signs
for a price we then miss: they sign a floor and get the actual fill.

**Sell:** committed quote for coin to USDC for the amount the solver will hold (the amount given less 1 pip); the
person signs `-coin`, `+USDC floor`; the solver signs the mirror; one `execute_intents` pays the person at once from
the solver's float; then the solver pays the quote with the coin (second call), and sends the person the USDC above
the floor (third call). The solver's risk is the unload failing after it has paid: it then holds one position.

## 5. Two sourcing routes, both measured by the live run

| | inside (`--source inside`, default) | outside (`--source outside`) |
|---|---|---|
| what the solver holds | USDC in its verifier account | USDC on Solana (the test wallet in the spike) |
| how a coin is bought | 1Click quote, verifier on both sides; other market makers supply the coin | 1Click quote paid with USDC on Solana, coin delivered to the solver's verifier account (`recipientType: INTENTS`) |
| chain transactions per buy | 0 | 1 Solana transfer per coin |
| 1Click `timeEstimate` | 12 s | 22 s; our earlier chain settles took 114 s and 171 s |
| person's deadline (default) | 120 s | 300 s |
| extra cost | none | Solana fee and 0.00204 SOL token-account rent per deposit address (about $0.16 at $80/SOL) unless the fee payer covers it |
| where the person's USDC ends | back in the solver's float: nothing to rebalance | in the solver's verifier account, while the Solana pool shrinks; `--refill` moves it back |
| refill | not needed | one Omni withdrawal of USDC, about 0.003 NEAR, 68 to 69 s observed for other people's withdrawals |

The owner's own version of outside sourcing (buy on Jupiter, then deposit the coin) is not built. Steps: (1) a
Jupiter swap USDC to coin in a solver Solana wallet (Jupiter quote and swap API, one Solana transaction, a few
seconds); (2) a same-asset deposit of the coin into the solver's verifier account: either a 1Click same-asset quote
or the Omni `init_transfer` of section 7 with the coin's mint (WIF, BOME and TRUMP are registered at the bridge);
(3) settle as now. Code it needs: a Jupiter client, a solver Solana key with SOL, and the deposit builder that
already exists (`omni-deposit.mjs`). Expected extra latency compared with inside sourcing: one bridge deposit, 68 to
73 s observed for six real Omni deposits today, so the person's deadline has to be minutes, not 120 s. It gives
Jupiter's price (deeper for long-tail coins) at the cost of that wait; inside sourcing is the faster and simpler
default for coins 1Click quotes.

## 6. Balances, funding, withdrawal

- **Portfolio read.** `mt_tokens_for_owner({account_id, from_index, limit})` lists the token ids an account holds;
  `mt_batch_balance_of({account_id, token_ids})` gives the amounts (balances doc; probe on an account with 181
  tokens). `verifier.holdings(account)` does both. No key, no cost. `yeet_overview` would call it for the person's
  account and price the ids with the 1Click token list.
- **Funding through 1Click.** A same-asset quote (USDC on Solana in, the same USDC out) with `recipientType:
  "INTENTS"` and the person's account as recipient: `amountOut == amountIn`, `appFees: []`, `timeEstimate` 20 s
  (Base: 35 s). Each quote is one deposit address for one deposit, and the Solana side pays the address's token
  account rent each time. A **reusable deposit address** (one permanent address per person and chain) needs a partner
  `X-API-Key` and the person's session token; without the key "`POST /v0/quote` is rejected" (reusable addresses
  doc). USDC from Base credits a different token id (`base-0x8335…omft.near`); converting it to the Solana USDC id
  inside the verifier quoted 4.499479 for 4.5 (1 bp), 10 s.
- **Funding without 1Click:** section 7.
- **Withdrawal on request.** One signed payload with `ft_withdraw` to `omni.bridge.near` (first spike, section 1).
  `--withdraw-user --coin X` does it and times the arrival on Solana.

## 7. Can we use the contracts only, with no 1Click at all?

**Swaps and withdrawals: yes, and the spike already does** (`execute_intents` from our own account; `ft_withdraw`
through `omni.bridge.near`). With our own solver holding coin stock (first spike) no 1Click call is involved in a
trade at all. With just-in-time sourcing, 1Click is the place the solver buys from: that is a liquidity source, not a
protocol requirement.

**Deposits from Solana: yes, fully on-chain, and it is what the network itself does today.**

- The Omni bridge program on Solana is `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` (Omni repo README, "Mainnet
  Addresses"). Its instruction `init_transfer(payload {amount, recipient, fee, native_fee, message})` moves the
  tokens into the bridge's vault and posts a Wormhole message
  (`solana/programs/bridge_token_factory/src/instructions/user/init_transfer.rs`).
- With `recipient = "near:intents.near"` and `message = "<the owner's account id>"`, the NEAR side
  (`near/omni-bridge/src/lib.rs` `fin_transfer` to `process_fin_transfer_to_near` to `send_tokens`) sends the token
  to `intents.near` with that message, and the verifier credits the named account (deposits doc: an account id as
  `msg` assigns ownership).
- **The token that results is the same one.** View `omni.bridge.near.get_token_id("sol:EPjF…Dt1v")` answers
  `sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`: the USDC id the verifier and 1Click already use. No
  second kind of USDC appears. The same holds for WIF.
- **Seen on chain:** recent USDC deposits into `intents.near` are exactly this call. Example
  `3fdso6JNkxjunpdsoeurz4tqmKxw413uEthm86ZbsZ6ZfvwxBc1qBsXavNRrEQUdA9k4CMtyBeU8vgZJMtYSbmN`: recipient
  `near:intents.near`, message a 64-hex account, fee 0, native fee 124,533 lamports (about $0.01). The bridge's API
  records six such deposits as credited on NEAR **68 to 73 s** after the Solana transaction. One was 0.000111 USDC,
  so there is no practical minimum.
- **Our builder reproduces that transaction byte for byte** (19 accounts, all derived, and the instruction data;
  `omni-deposit.test.mjs` against the fixture). `--deposit-user --via omni --omni-from <address>` builds the
  transaction for 4.5 USDC and simulates it on Solana mainnet without signatures: it ran to the Wormhole message and
  ended in success, 57,426 compute units (the real one used 57,456), from a public address that holds USDC.
- Fees: `native_fee` in lamports from `GET https://mainnet.api.bridge.nearone.org/api/v3/transfer-fee` (124,501
  lamports, $0.01, for 4.5 USDC), a Wormhole message fee, and the Solana fee. No rent for a deposit address. Our fee
  payer can be the `payer`; the person signs as `user` (two signers, as in the real transaction).
- Who finalises: a relayer submits the Wormhole proof to `omni.bridge.near.fin_transfer` and earns the native fee.
  The Omni overview says anyone can submit the proof; the contract at this commit marks `fin_transfer` with
  `#[trusted_relayer]` (relayers are managed by the bridge's DAO roles). So in practice we rely on the bridge's own
  relayer unless we become one. Not verified further.
- Trust: inbound transfers from Solana are verified through Wormhole; outbound ones are signed by the NEAR MPC
  network (Omni overview).

**Deposits from Base: no contract-only route for USDC today.** The Omni bridge contract on Base is
`0xd025b38762B4A4E36F0Cde483b86CB13ea00D989` with `initTransfer(token, amount, fee, nativeFee, recipient, message)`,
but `omni.bridge.near.get_token_id("base:0x8335…2913")` answers `ERR_TOKEN_NOT_REGISTERED`: Base USDC is not an Omni
token. Inside the verifier it is the PoA token `base-0x8335…omft.near`, and the PoA bridge has no user-callable
contract on Base: deposits go to operator-watched addresses issued by an API (the Bridge API, closing since
2026-11-11, replaced by 1Click quotes; changelog). The Omni README also lists Base finality towards NEAR as 1,026 s.
So Base funding needs 1Click (35 s by its estimate).

**NEAR-native deposits:** `ft_transfer_call` on any NEP-141 token to `intents.near` with `msg` = the owner account
(deposits doc). Useful for a solver that already holds tokens on NEAR; our users do not.

**Conclusion.** A flow with no 1Click is possible today for a Solana user: Omni deposit (about 70 s), swap against
our own solver, Omni withdrawal (68 to 69 s observed). What it takes: the live deposit step (the builder and the
simulation exist; signing with the wallet and following the bridge record are the missing part), SOL for the native
fee from the person or our fee payer, and a solver that either holds coin stock or sources outside 1Click (Jupiter
plus Omni deposit, section 5). What is slower or riskier than the 1Click deposit: about 70 s against 1Click's 20 s
estimate (our measured 1Click settles were 114 s and 171 s, so possibly not slower at all); we depend on the
bridge's relayer and on Wormhole instead of on 1Click; there is no automatic refund path of ours if a transfer is
not finalised; and Base is not covered. While this document was written (20:29 UTC) 1Click answered "Quoting for
this pair is not available" to every quote touching the Solana chain, for at least several minutes, while the Omni
program kept processing deposits and internal and Base quotes kept working. The quotes were back on the next plan
run some minutes later. The cause is unknown (it may be a limit on our address after about 150 dry quotes). It is the
practical argument for having the direct deposit.

**Live step, described (not built):** `--live --deposit-user --via omni [--usdc N]`: read the bridge fee; build the
`init_transfer` transaction with the wallet as `user` (and as `payer`, or the YEET fee payer with `--fee-payer
privy`); save it; broadcast; confirm on Solana; poll `GET /api/v4/transfers/transfer?transaction_hash=<signature>`
until `Finalised` on NEAR; read `mt_batch_balance_of` for the person's account; print the seconds from send to
credited. Resumable the same way as the other funding legs.

## 8. Commands for the Director, in order

`--plan` first (no secret, sends nothing). `WALLET_ADDRESS` is the test wallet's public Solana address; with it the
plan also simulates the 1Click-free deposit:

```
node ops/intents-direct-spike.mjs --plan --usdc 3 --omni-from WALLET_ADDRESS
```

Expected: two `plan_result`, `survey_result`, two `balance_plan_result`, `omni_deposit_result`, all `"ok":true`,
then `{"step":"done","mode":"plan","ok":true}`, exit code 0. Look at the `deposit_route` line: `"available":true`
means 1Click takes Solana deposits right now. If it is false, steps 1b, 3, 4 and 6 will be refused at the quote
(nothing is paid); wait and run the plan again.

The live run. Each step prints JSON lines with ISO timestamps, never a key; the last line has `"stage":"result"`
and `seconds`. Each can be run again safely (state in `NEARKEY.state.json`).

```
export INTENTS_SPIKE_CONFIRM=send-spike
S="node ops/intents-direct-spike.mjs --live --near-key NEARKEY --wallet WALLET"

$S --setup                                   # 1.  creates the NEAR key, prints the account id
$S --setup --fund-near-from-1click           # 1b. 2 USDC to NEAR; or send 0.6 NEAR to that account id yourself
$S --register-omni                           # 2.  bridge storage balance (about 0.26 NEAR): needed by steps 8, 9, 11
$S --solver-usdc 3.5                         # 3.  the solver's float inside the verifier
$S --deposit-user 6                          # 4.  the user's USDC inside the verifier
$S --jit-buy --usdc 3 --coins WIF,BOME,TRUMP --source inside               # 5. the model
$S --jit-buy --usdc 3 --coins WIF,BOME,TRUMP --source outside --new-trade  # 6. the outside route, same size
$S --jit-sell --coin WIF --percent 100       # 7.  sell all WIF back to USDC
$S --withdraw-user --coin BOME               # 8.  one coin out to Solana, timed
$S --refill --refill-usdc 3                  # 9.  the solver's USDC back to Solana, timed (the outside pool refill)
$S --status                                  # 10. balances, both portfolios, every step's state
$S --unload                                  # 11. only if a buy was not executed: sell what the solver holds
$S --withdraw-all user                       #     afterwards: everything back to the wallet
$S --withdraw-all solver
```

| step | the result line should show | if not |
|---|---|---|
| `--solver-usdc 3.5` | `"status":"SUCCESS"`, `usdc_balance` 3500000, `seconds.solana_send_to_credited` | `still_pending`: run it again |
| `--deposit-user 6` | `usdc_balance` 6000000, `"ok":true` | |
| `--jit-buy … inside` | `"executed":true,"ok":true`; `user_delta.USDC` `-3000000` and three positive coin deltas equal to `legs[].user_receives`; `solver_delta.USDC` `-3`; `seconds` = `quote`, `user_signature`, `sourcing` per coin, `sourcing_all`, `simulate`, `execute`, `total` | `"executed":false` with a `reason`: the user moved nothing; `solver_delta_since_start` shows what the solver holds; run `--unload`, then `--jit-buy … --new-trade` |
| `--jit-buy … outside` | the same, with `solver_delta.USDC` `2999997` and no `sourcing_tx_hash`; `seconds.sourcing` is Solana send to credited | the same; a longer `--deadline-s` (default 300) if it ran out |
| `--jit-sell` | `"ok":true`; `user_paid_at_once`, `unloaded_usdc`, `surplus_to_user`; `seconds.user_paid_after`, `seconds.unload` | `unload` not `done`: run it again, it resumes |
| `--withdraw-user`, `--refill` | `"ok":true`, `received_on_solana`, `seconds.submit_to_arrival`, `bridge[].bridge_seconds` | `note` says run again: it keeps following, sends nothing twice |

**Funds needed.** Test-wallet USDC: **14.5** (2 NEAR funding + 3.5 solver float + 6 user + 3 outside buy); 12.5
when the NEAR account is funded directly. NEAR: **0.6** (0.26 goes to the bridge storage balance, which pays the
relayer for every withdrawal: about 0.06 NEAR for a coin the wallet has no token account for, 0.003 otherwise; each
`execute_intents` prepays up to 0.03 and gets most of it back). SOL in the wallet: about 0.015 for six deposit
addresses, or `--fee-payer privy`. Everything except fees comes back with the two `--withdraw-all` steps. A single
4.5 USDC inside buy instead (`--solver-usdc 5`, `--deposit-user 4.5`, `--jit-buy --usdc 4.5`) needs 11.5.

Options: `--user-evm` (the user signs ERC-191 with the wallet's EVM key; deposit with `--deposit-user 6 --user-evm`
first), `--margin-bps` (default 0), `--source-slippage-bps` (100), `--deadline-s`, `--min-left-s` (10),
`--max-loss-bps` (10), `--new-trade`, `--recipient`, `--follow-s`.

## 9. Not proven until the live run

- **Every timing.** 12 s is 1Click's estimate for an internal quote, not a measurement. Unknown: how long 1Click
  takes to notice a `transfer` to its deposit account, whether three legs fill within a 120 s deadline, the two
  NEAR calls' latency, and the bridge times for our own account.
- That 1Click acts on a plain `transfer` intent executed by a third party (us) rather than one submitted through
  its `submit-intent` endpoint. The OpenAPI describes exactly this; it was not executed.
- What 1Click delivers relative to `amountOut` (the person's surplus), and its behaviour when the price moves
  between quote and payment (refund to the solver's verifier account, by `refundType: INTENTS`).
- Whether `/v0/status` reports an internal quote's `swapDetails.amountOut`. The tool does not depend on it for
  buys (it reads the verifier balance) but uses it when several legs pay into USDC (`--unload`).
- NEAR gas actually burnt per call (the table uses an upper bound).
- Privy producing these signatures (first spike, section 8). The spike signs with local keys.
- The Omni deposit beyond the Solana simulation: the credit on NEAR for our own transaction.
- Whether 1Click's refusal of Solana-chain quotes at 20:29 UTC was an outage or a limit on our address.

## 10. Partner keys: which feature needs which key

| feature | key needed | source and what we saw |
|---|---|---|
| verifier contract: `execute_intents`, `simulate_intents`, balances, our own solver matched by us | none, no KYC | contract; `--plan` |
| 1Click `/v0/tokens`, `/v0/quote` (chain or verifier on either side), `/v0/status`, `/v0/deposit/submit` | none | probes; OpenAPI lists `X-API-Key` as the security scheme, the API answers without it |
| 1Click fee | without a key: docs say +25 bps on every non-`ANY_INPUT` quote; we see a 20 bps `appFees` entry. With a key: 20 bps, 1 bp on stablecoin pairs and same-asset routes; with our own `appFees` a 50/50 split with 1Click keeping at least 20 bps | fees, fee config |
| 1Click `generate-intent` / `submit-intent` (signed-intent mode: 1Click's relayer executes, we pay no NEAR gas) | docs: partner key. Today both answer without one. We do not use them | signed intents; probe |
| reusable deposit addresses (`ANY_INPUT`, one permanent address per person) | **partner key required**, plus the person's session token | reusable addresses |
| limit orders (`/v0/orders`) | partner key in the OpenAPI | OpenAPI |
| solver relay: JSON-RPC `quote` / `publish_intent`, WebSocket (being a market maker for other people's flow) | partner JWT from the Partner Portal **with KYC/KYB** | market makers quickstart: "request an API Key through the Partner Portal and go through KYC/KYB"; `message-bus/rpc.md` |
| rate limits | no numbers published; the OpenAPI defines HTTP 429 `rate-limit-exceeded` on the orders endpoints | OpenAPI |

Same portal for both keys: https://partners.near-intents.org (the 1Click page calls it the Partner Dashboard). The
1Click key page does not mention KYC/KYB; only the market-maker page does. Whether one JWT serves both, and whether
the 1Click key alone requires KYC, is not stated in the docs and was not tested (we signed up for nothing).

**For the owner:** keyless sourcing with the verifier on both sides works, so no key is needed for this model. A
1Click key is still worth having for two things: reusable deposit addresses (one permanent funding address per
person instead of a quote per deposit) and the documented fee schedule. To get it: sign up at the Partner Portal and
request access; set it as `ONECLICK_JWT` (the client already sends it as `X-API-Key`). The market-maker key matters
only if we want to fill other apps' orders.

## 11. Custom tokens: can any coin enter the verifier?

Not as stated. Three layers:

1. **The verifier accepts any NEP-141 token on NEAR, permissionlessly** ("Any NEP-141 token can be deposited",
   deposits doc; also NEP-171 and NEP-245). Two accounts can trade any such token with `token_diff`, so our own
   solver can make a market in a token nobody else supports.
2. **1Click only handles the tokens it lists** (`GET /v0/tokens`: 231 today; 115 PoA `*.omft.near`, 24 Omni
   `*.omdep.near`). Quotes, deposit addresses and just-in-time sourcing exist for those only. The docs describe no
   self-listing: "The list is continuously expanding — join our Telegram for announcements" (asset support page).
3. **Getting a Solana or Base token onto NEAR is the gated part.** PoA tokens are created by the bridge's
   operators. The Omni bridge documents a two-call flow, `log_metadata` on the source chain and `deploy_token` on
   NEAR (Omni repo README, "Token Operations"), but in the contract both NEAR methods carry
   `#[access_control_any(roles(Role::DAO, Role::TokenDeployer))]` (`near/omni-bridge/src/lib.rs`). So an arbitrary
   SPL or ERC-20 token cannot be bridged by anyone today: someone with the TokenDeployer role has to deploy its NEAR
   side once. After that, anyone can move it (`init_transfer`, as in section 7).

For a tokenized stock on Solana or Base: (a) ask the Omni bridge team (Near One; the Partner Portal or the NEAR
Intents Telegram are the documented contacts) to deploy the token's NEAR side; (b) then deposits and withdrawals
work through the bridge contracts, and our solver can quote it inside the verifier with no further permission;
(c) a 1Click listing is a separate request and is needed only for 1Click quotes and deposit addresses. From Base,
expect the bridge's 1,026 s finality towards NEAR per transfer. Tokens with transfer restrictions (allow-lists,
freezes) would also need the bridge vault and the verifier to be permitted holders: not examined.

## 12. Risks

- **Custody in a smart contract.** Every balance is an entry in `intents.near`. A bug or a pause there affects all
  funds at once; today only the amount in flight is exposed. The docs list audits and a bug bounty
  (https://docs.near-intents.org/security-compliance/security.md, not read here); we reviewed only the paths we use.
- **Bridges on the way out.** Leaving needs the Omni bridge (MPC signatures, a relayer). A paused bridge means
  balances are safe but cannot leave.
- **Solver price risk.** By construction none on a buy (it spends what the person pays). On a sell, one position
  between paying the person and unloading: bounded by the quote's `minAmountOut`, real if the unload is refunded.
- **Sourcing failure or slowness.** The person waits up to the deadline and gets nothing; the solver may hold a
  basket to unload (0.8% to 1.8% round trip). Every failed buy is a visible product failure, so the deadline and
  the fallback route matter. 1Click's refusal of Solana quotes today shows the dependency is real.
- **Coins on other bridges.** PENGU is `sol-0x….omdep.near`; the spike refuses it. The model does not depend on
  the bridge for holding or trading it, only for withdrawal (same builder in the SDK, unchecked here).
- **No yield on idle USDC**, and Base deposits arrive as a different USDC id that must be converted (1 bp).
- **Solver float and gas.** The float must cover the largest basket in flight per concurrent trade; NEAR for gas
  and the bridge storage balance must be kept topped up. Concurrency was not designed here: two buys at once need
  separate floats or a queue (the access-key nonce also orders our transactions).
- **Exit without us.** The person's key alone controls the account: nothing of ours is needed to authorise a
  withdrawal. Practically they need (1) the `ft_withdraw` payload signed with their key (`signMessage` /
  `personal_sign`, exportable from Privy), (2) someone to submit it: `execute_intents` checks no caller, so any NEAR
  account with a few cents of NEAR can, and that account needs a storage balance on `omni.bridge.near` (or the
  payload must carry the wNEAR `storage_deposit` variant). Public tools: the defuse SDK
  (`@defuse-protocol/intents-sdk`) builds such withdrawals, and near-intents.org's own app should show the same
  account to a Solana or EVM wallet holding that key, because the account id is derived from the key. Neither was
  tested with a Privy-exported key. So an exit with only their key and public tools is possible but takes several
  manual steps. A small "withdraw everything" page of ours that needs only their signature would make it routine.

## 13. Plugging into YEET as a second route behind the same cards

- **Funding card.** Unchanged for the person: they send USDC. The server asks for a deposit that credits their
  verifier account (1Click same-asset quote; later the Omni transaction signed as a normal `solana_tx` request, or a
  reusable address once we have a key).
- **Buy and sell cards.** One sign request of a new kind **`intent_message`** next to `solana_tx` and `evm_tx`
  (`pipeline/wallet-request.mjs`), carrying the payload string:
  - Solana wallet: Privy `signMessage` with the payload's UTF-8 bytes (base64); wire object `raw_ed25519`.
  - EVM wallet: Privy `personal_sign` with the payload string; wire object `erc191` (subtract 27 from the last
    signature byte). `intents/wallet-adapter.mjs` has both mappings and verifies the answer locally.
  - No fee payer, no Solana transaction, no deposit address per leg. Card copy: "at least N coins" with the quoted
    amount as the expected fill.
- **Server pipeline** (`jit.mjs` + `live-jit.mjs` are the reference): firm quotes; build the payload; store it with
  the trade; sign request; on the signature: simulate, pay the quotes, wait, settle, read balances. States for the
  card: `awaiting_signature`, `sourcing`, `settled`, `expired` (nothing moved, offer retry).
- **`yeet_overview` / portfolio.** `verifier.holdings(<person's account>)` for the positions, the 1Click token list
  for prices, the solver's own trade records for cost basis. The current Solana/Base balance reads stay for funds
  not yet deposited.
- **Withdraw card.** One `intent_message` with `ft_withdraw`; then the bridge record and the Solana balance.
- **Route choice.** The 1Click chain route stays as the fallback (coins the verifier route cannot source, or a
  person who wants the coin in their wallet at once).

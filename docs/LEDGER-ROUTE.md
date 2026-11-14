# The ledger route: trades that settle inside the NEAR Intents ledger

Status 2026-11-14, branch `int/ledger` (production `int/auth` 617b49e merged in; cards at yeet-win c671cc5, branch
`feat/deposit-3-steps`, `tools-7`).
A second trade route behind the same cards, **off by default**. With `YEET_ROUTE` unset or `chain` and
`YEET_LEDGER_ACCOUNTS` empty, nothing of this route is created, read or written, and the 1Click chain-to-chain route
and today's funding card run as before (every test of `int/auth` passes unchanged). Not deployed.

The route is the proven spike made part of the pipeline: `docs/INTENTS-BALANCE-MODEL.md`, `ops/intents-direct-spike.mjs`,
real trades in `receipts/intents-live/` (3-coin buy with one approval in 28.6 s, sell paid in 4 s).

- Code: `connector/core/ledger-route/` (`config.mjs`, `route.mjs`, `solver.mjs`, `check.mjs`, and for funding
  `deposits.mjs` and `deposit-rpc.mjs`), on the spike's modules in `connector/core/intents/`.
- Hooks: `connector/core/pipeline/pipeline.mjs` (every use is behind `ledgerRoute`, which is `null` while the route is off),
  `core/trade/proposals.mjs` (`clientFor`), `core/pipeline/wallet-request.mjs` (request kind `near_intent`),
  `mcp/tool-registration.mjs` (`cutSignRequests`), `core/core.mjs` (start check, and `/fund` for an account on this
  route), `mcp/guidance.mjs` (`yeet_fund_own`), `ops/compose.yml` (settings passed through).
- Tests: `connector/core/ledger-route/ledger-route.test.mjs` (25), `deposits.test.mjs` (19), `deposit-rpc.test.mjs` (16),
  `ops-tools.test.mjs` (6),
  `connector/core/intents/*.test.mjs` (63, from the spike), one in `mcp/scripts/signing-meta-test.mjs`.
- Operator tools: `ops/ledger-route-check.mjs` (read-only check; deposit addresses; deposit watch), `ops/send-usdc.mjs`.

## 1. Design

### 1.1 Whose key, which account

- **The key is the person's Privy embedded Solana wallet key**, signing standard **`raw_ed25519`**: the signature is
  over the UTF-8 bytes of the message, no prefix, no hash. It is what the spike's real trades used (the test wallet's
  Solana key) and it is one plain wallet call: Privy `signMessage` (`chain_type: solana`, the message as base64). The
  vendored card signer (`yeet-signer.js`) passes any wallet RPC body through, so it can make this call as it is.
  `erc191` with the EVM wallet (`personal_sign`) passes the contract too (spike `--plan`), but has no live trade behind
  it; it is not used.
- **The ledger account id is the hex of the 32 bytes of the Solana address** (`ledgerAccountOf`, an implicit account of
  `intents.near`). Nothing is created or registered; the account exists as soon as a token is credited to it.
- **Custody.** Only that key can move the account's balance. The server stores no key of the person. What it holds is
  the one message the person approved for one trade, which can do exactly one thing: exchange the stated amounts
  against our solver before its deadline (180 s by default). It names no other receiver and cannot be changed without
  breaking the signature. The solver account is ours and holds only our working USDC.

### 1.2 What the person approves

One message per trade, whatever the number of coins: a single `token_diff` intent.

- Buy: `-total USDC`, `+minimum` of each coin. Sell: `-amount` of each coin, `+minimum USDC`.
- The minimum is the firm sourcing quote's `minAmountOut` less the ledger's fee (1 pip). The person receives
  everything the solver sourced, not only the minimum. YEET keeps nothing (margin 0, no fee intent).
- Nonce: the contract's versioned nonce with the current salt, ending with the message.

The sign request (`kind: "near_intent"`) carries the exact text (`payload.message`, `message_base64`) and restates it
(`payload.gives`, `payload.receives`). `checkIntent` in `wallet-request.mjs` runs before the wallet is asked, in the
card and on the YEET page alike: one `token_diff` and nothing else, for this wallet's own ledger account, on
`intents.near`, giving exactly what the leg summaries list. A server that misstates the message is refused there.

### 1.3 Buy (one approval)

1. Tap on the card: `execute_trade`. Same checks as the chain route (confirm code, kill switch, `YEET_LIVE`,
   `YEET_LIVE_ACCOUNTS`, tier caps, 3 USDC per coin, daily cap, balance: here the person's **ledger** USDC). Then the
   solver's bounds and float, then one firm 1Click quote per coin with the ledger on both sides and the solver as the
   account. A firm quote commits nothing until it is paid. Requote rule and cost cap as before.
2. Commit: trade and legs `awaiting_signature` as on the chain route, plus the route's own row (`ledger_trade`). One
   sign request covers every leg.
3. The person approves (press and hold). `submit_trade_signature`: the signature is verified against the wallet's key
   over the exact bytes, then the message is simulated **alone** on the ledger. It must pass every check and stop only
   at the missing counterparty. Legs move to `signing`; the answer returns at once.
4. Run (in the background, one solver operation at a time): the solver pays the quotes (one `transfer` intent per coin,
   one NEAR call), waits until each coin has arrived in its account, signs the exact mirror plus a `transfer` of
   everything above the minimum to the person, simulates both payloads together, and sends one `execute_intents`.
5. Settled: legs `sent` with the NEAR transaction hash, status `SUCCESS`, the amounts received; trade `success`; the
   receipt and the XP event as for any trade.

### 1.4 Sell (one approval)

Steps 1 to 3 as above (the quote is asked for the amount the solver will hold: the amount given less the fee).
The solver then settles **at once** from its float: the person has the minimum USDC within seconds. After that the
solver pays the quotes with the coins, and the USDC that comes back above what it paid goes to the person in a second
call (their receipt then shows the higher amount). If that sale does not complete, the person keeps the minimum they
approved, the coins go to the leftover unload, and an alert names the surplus still owed.

### 1.5 Funding and withdrawal

**In: the person's permanent deposit addresses** (`ledger-route/deposits.mjs`; 1Click "reusable deposit addresses",
https://docs.near-intents.org/integration/distribution-channels/1click-api/reusable-deposit-addresses.md).

- One address set per account, made once at the account's first `yeet_fund` with the 1Click partner key
  (`ONECLICK_JWT`, header `X-API-Key`): an `ANY_INPUT` quote from `1cs_v1:any` to `1cs_v1:original`, `depositType`,
  `recipientType` and `refundType` all `INTENTS`, deadline `2038-01-01T00:00:00.000Z`. **Recipient and refund account
  are always the account's own ledger account** (`ledgerAccountOf` of its Solana wallet address), nothing else.
  Whatever is sent to an address of the set is credited to that ledger account as the coin it is.
- Stored in the core's SQLite, table `ledger_deposit_address`: account id (primary key), ledger account (unique), the
  recipient and refund account 1Click states, the whole `chainDepositAddresses` answer, 1Click's internal account of
  the set (never shown), the correlation id, `created` or `adopted`, the times. **Shown only when the row was made for
  exactly this account's ledger account**: `ledger_account`, `recipient` and `refund_to` are compared with the derived
  id on every read, and a row that differs shows nothing (`ledger_deposit_set_mismatch` in the log).
- **Never made twice.** One flight per account in the process. Before any create the partner key's own sets are
  listed (`GET /v0/quotes?filter[swapType]=ANY_INPUT`, all pages: read live on 2026-11-14, the key lists the sets it
  made, with no user session); a set that names this account is taken over after 1Click's own record of its request
  (`GET /v0/status`) is checked to be ours. A create answered HTTP 400 (two creates overlapped) is followed by one
  more listing and never by a second create. Any failure leaves the row `failed`; the next try comes 10 minutes later
  at the earliest and lists first, so a set that was made without an answer reaching us is found, not duplicated.
- The card (`_meta["yeet/deposit"]`, as for every account): the Solana address of the set, QR, Copy, the line "Send
  at least 5 USDC on Solana to this address. YEET trades from USDC." An entry with a memo, of another shape than its
  network's, or listed twice is never offered. Nothing about an end date: the address is permanent.
- **The minimum** (`YEET_MIN_DEPOSIT_USDC`, default `5`; `0`: none stated) is information only, given without a
  reason: `min_deposit_usdc` on the answer, the card's line above (the network is the tab chosen), the text the model
  reads ("Send at least 5 USDC on Solana to the address in the card.") and its guidance. Nothing refuses a smaller
  deposit: it is credited like any other, and no wording says otherwise.
- **Solana alone is offered by default** (`YEET_LEDGER_DEPOSIT_NETWORKS`, default `solana`). `solana,base` turns the
  Base tab on. USDC sent on Base is credited as Base's USDC (`nep141:base-0x8335….omft.near`), another token id than
  Solana's (`nep141:sol-5ce3….omft.near`). With Base offered, and only then:
  - **The one USDC number counts both** token ids (welcome card, portfolio, `yeet_fund`, the balance check of a buy:
    `ledgerBalances`), and the deposit watch reads a rise of either as USDC arriving.
  - **A buy is paid from one of them, never split** (one message gives one token; the card's own check of the message
    holds that): Solana's when it covers the whole buy, else Base's when that does (`payWith`). When neither covers it
    alone though together they would, the buy is refused before anything is asked (`BALANCE_LOW`) with "Your USDC
    arrived in two parts, and one trade spends from one of them: up to N USDC right now. Try that amount or less."
  - **The solver** sources with its own (Solana) USDC as always and is paid in the token the person gave. Base USDC
    it was paid is inventory like a coin: the leftover unload sells it back to its USDC (same tries per day, same
    bound; `ledger_unload` with symbol `USDC.base`), at the market's price for that swap (a few basis points, ours).
    Until it is sold the float is lower by that amount. A sell always pays Solana's USDC.
  - With the default, none of this is read: the token ids, the balance read, the message and the unload list are
    the ones they were, and Base USDC in an account is "another coin".
- **No card payment on this route.** The funding page pays into the person's Privy wallet (Base or Solana), not into
  their ledger account, so the answer carries `methods: ["crypto"]` and no `fund_url`, and the card has no "Pay by
  card". A bridge step from the wallet to the ledger is not built.
- **Without the key** (`ONECLICK_JWT` unset), or when the set cannot be made, the answer is `methods: []`: the card
  says "Adding funds isn’t available here yet." and the model says the same. The one-time address path below is not
  wired to a card, so there is nothing to fall back to.

**The deposit watch.** `yeet_fund` is called by the model once and by the card every 10 s (30 minutes, then "Still
waiting. This card will update when your USDC arrives; you can come back later."; it reads again when the person
comes back). Each call compares the account with a snapshot taken when the watch began (`ledger_deposit_watch`):

| stage | what it is read from | proven |
|---|---|---|
| `waiting` | nothing changed | |
| `found` | 1Click's status of the set (`GET /v0/status` of its internal account): a new deposit transaction or deposited amount, or the status moving to `KNOWN_DEPOSIT_TX` / `INCOMPLETE_DEPOSIT` | the endpoint answers for a set with the key (read live: `PENDING_DEPOSIT`, empty details); **what it shows after a deposit to a permanent address is not proven** |
| `preparing` | the same status: `PROCESSING`, a new NEAR transaction, or `SUCCESS` at a new time | as above |
| `ready` | the account's USDC inside `intents.near` rose (`mt_tokens_for_owner` + `mt_batch_balance_of`, the read the route already uses) | yes: it is the ledger itself |
| `other_coin` | another token of the account rose and USDC did not | the read is proven; the wording is "We received SOL. It is in your account, but YEET trades from USDC." |
| `detected` | `YEET_LEDGER_DEPOSIT_STAGES=rpc` only: the deposit's own network shows USDC arriving at the person's deposit address (below) | tests only: no deposit has been watched this way yet |

The two middle stages are never inferred: when 1Click reports nothing, the card goes from waiting to ready. The
operator proof (6.3) prints 1Click's status at every change, which settles what the middle stages are worth (read
live since: the status of a permanent address stays `PENDING_DEPOSIT`, so they never show);
`YEET_LEDGER_DEPOSIT_STAGES=balance` turns them off (the card then draws two stages and 1Click is not polled).

**Three stages: `YEET_LEDGER_DEPOSIT_STAGES=rpc`** (`deposit-rpc.mjs`; the logic is Folio's deposit watcher,
stock-app `apps/server/src/funding/watcher.ts` and `bridge/source-service.ts`). The card draws "Waiting for your
deposit", "Detected", "Ready", and says "Deposit detected. It will be ready to trade shortly." 1Click is not polled.

- **What is read.** Solana: the USDC token account of the deposit address (the associated one, derived locally). The
  baseline is its newest signature; a look lists only what is newer (one call), and reads the body of a new
  signature once to see what it brought in: `detected_usdc` and `detected_tx`. 1Click moving an earlier deposit on is
  an outflow and is not a deposit. Base: USDC `balanceOf` the deposit address (one call); a rise over the baseline is
  the deposit, and its Transfer log is asked for once for the transaction id (left out when the provider refuses
  the block range). Receive-only: nothing is built, signed or sent.
- **Never a condition.** `ready` is read from the ledger exactly as with `balance`. No endpoint for a network, every
  endpoint failing, or a deposit the network read missed: the card goes from waiting to ready. With no endpoint for
  any offered network the card draws two stages.
- **When it is read** (as Folio: reading starts when the person opens the funding screen, then backs off). From the
  card being opened: every 10 s for 2 minutes, every 20 s to 10 minutes, every 60 s to 30 minutes (about 56 calls
  for a card left open half an hour, against 180 looks of the card); then without the card, from the tracker's tick,
  every 5 minutes to 2 hours and every 30 minutes to 24 hours; then not at all. A card that asks again after a
  minute of silence restarts the fast phase. Once a deposit is seen the network is not asked again for that watch.
  A read that fails waits 30 s, doubling to 10 minutes (a wait in progress is kept when the person comes back).
- **Endpoints**, the first that answers; one that fails rests 30 s, doubling to 10 minutes, and is skipped
  meanwhile (a refusal of one request, such as a block range, does not rest it):
  `SOLANA_RPC_URL` (main; Folio's `L1_RPC_URL`, Helius), `SOLANA_BACKUP_RPC_URL` (second; Folio's
  `FOLIO_SOLANA_RPC_URL`), `BASE_RPC_URL` (Folio's `FOLIO_BASE_RPC_URL`, Alchemy). An Alchemy host in a Solana
  setting is left out and named in the log (`ledger_deposit_rpc_ignored`). Values are never logged.
- **The sweep** (`YEET_LEDGER_DEPOSIT_SWEEP_HOURS`, default 24; `0`: none; the time of the last one is stored, so a
  restart does not repeat it): every stored deposit address of the read networks, Solana 100 addresses a call
  (`getMultipleAccounts`), Base one `balanceOf` each. It moves nothing and changes no watch (the ledger credits a
  deposit by itself, whoever is looking); it writes to the log: `ledger_deposit_sweep_found` (USDC at an address
  nobody has a card open for), `ledger_deposit_sitting` (the same USDC was there at the last sweep too: 1Click has
  not moved it on; the operator's to look at) and one `ledger_deposit_sweep` line with the counts.
- Log events: `ledger_deposit_detected`, `ledger_deposit_rpc_look_failed`, `ledger_deposit_rpc_failed`,
  `ledger_deposit_rpc_refused`. State: tables `ledger_deposit_chain` (one row per account and network: baseline,
  schedule, what was seen, what the sweep found) and `ledger_deposit_sweep`.

A trade
of the account moves the same balances, so trade activity since the last look re-bases the snapshot instead of
counting as a deposit. "Ready" holds for two minutes, then a new watch starts from the new balance.

**In, the older way (what the spike used, proven live):** a 1Click same-asset quote, USDC on Solana in, the same USDC
credited to the person's own ledger account, with a one-time address. Still the operator step `--deposit-user` of
`ops/intents-direct-spike.mjs`; not on a card.

- **Out (proven live, 72 s):** one more message of the person, `ft_withdraw` through the Omni bridge to their own
  Solana address. Operator step `--withdraw-user` / `--withdraw-all user` of the same tool. Not on a card.
- The Omni bridge deposit without 1Click is built and simulated only (`docs/INTENTS-BALANCE-MODEL.md` section 7).

### 1.6 Failure and refund states

| what happens | the person's funds | legs | trade | daily cap |
|---|---|---|---|---|
| never approved within 10 min, or the quotes ended | untouched | `not_sent` | `failed` | returned at once |
| the approval arrives after its request ran out | untouched | stay `awaiting_signature`; a fresh request is answered | `signing` | held |
| the approval does not simulate (balance gone) | untouched | `not_sent` | `failed` | returned |
| kill switch or account gate before sourcing | untouched | `failed` | `failed` | returned |
| a coin is not delivered in time, or 1Click refunds | untouched: the message is never sent and expires | `failed` | `failed` | returned |
| the settlement fails on chain | untouched (the ledger confirms the nonce is unused) | `failed` | `failed` | returned |
| the settlement has no outcome yet, or the process restarts | unknown until read | `signing` | `signing` | held |
| sell: the solver's own sale fails after it paid | minimum received | `sent` | `success` | n/a |

A basket is all or nothing: one `execute_intents`, so there is no partial trade on this route. A stored settlement is
sent again unchanged after a restart; the intents carry their own nonces and cannot execute twice. Whether the
person's message was executed is decided by the ledger itself (`is_nonce_used`), not by our own bookkeeping.

### 1.7 The same cards: how it maps

| existing piece | on the ledger route |
|---|---|
| `yeet_propose` / `yeet_quote` / `skeet_propose` | unchanged; the dry quotes are asked with the ledger on both sides, so the basket card shows this route's amounts and minimums |
| `execute_trade` answer | same shape; `legs[].deposit_address` is the quote's account inside the ledger; one sign request |
| leg `awaiting_signature` → `signing` → `sent` / `failed` / `not_sent` | the same states and edges; `tx_hash` is the NEAR transaction; `explorer_url` is nearblocks |
| `trade_status` | unchanged: `signing` until settled, then `success` or `failed`; `amount_out` and `received` are what reached the person's ledger account |
| receipt | the router receipt; the settlement is folded as a `SUCCESS` status with the NEAR hash |
| welcome card, portfolio, limits, `BALANCE_LOW` | read the person's ledger account (USDC and every catalogue coin, one view call); USDC elsewhere is not spendable on this route |
| `yeet_fund`, the Add funds card | the permanent deposit address and the deposit's stages; no card payment (1.5) |
| caps | the same code: tiers, 3 USDC per coin, daily cap (`checkBasket`, `checkDaily`) |

Rows of a ledger trade carry `origin_chain = 'sol'` (the person's Solana key owns the account) and are told apart by
their `ledger_trade` row. No migration of the existing tables: the route makes its own eight tables when it is created
(`ledger_trade`, `ledger_attempt`, `ledger_solver_day`, `ledger_unload`, `ledger_deposit_address`,
`ledger_deposit_watch`, `ledger_deposit_chain`, `ledger_deposit_sweep`).

## 2. Settings

```
YEET_ROUTE=chain|ledger            default chain
YEET_LEDGER_ACCOUNTS=id1,id2       accounts on the ledger route while YEET_ROUTE is chain
YEET_SOLVER_ACCOUNT=<64 hex>       required when the route is on
YEET_SOLVER_KEY_FILE=<path>        required; mode 0600; the format ops/intents-direct-spike.mjs --setup writes
YEET_SOLVER_MAX_TRADE_USDC=<n>     required; the most the solver puts up for one trade
YEET_SOLVER_MAX_DAY_USDC=<n>       required; the most per UTC day
NEAR_RPC_URL=<https url>           optional; tried before the public endpoints
YEET_LEDGER_DEADLINE_S=180  YEET_LEDGER_MIN_RUN_S=60  YEET_LEDGER_MIN_LEFT_S=10  YEET_LEDGER_SOURCE_SLIPPAGE_BPS=100
YEET_SOLVER_UNLOAD_MAX_TRIES=3  YEET_SOLVER_UNLOAD_MAX_USDC=<per-trade bound>
ONECLICK_JWT=<1Click partner key>  secret, core.env only; without it funding on this route is "not available yet"
YEET_LEDGER_DEPOSIT_NETWORKS=solana     the deposit networks the card shows (solana, or solana,base; see 1.5)
YEET_LEDGER_DEPOSIT_STAGES=status       status (1Click may show the middle stages) | balance (waiting, ready only)
                                        | rpc (waiting, detected, ready: the deposit's own network is read too)
YEET_MIN_DEPOSIT_USDC=5                 the stated minimum of one deposit; information only; 0: none stated
YEET_LEDGER_DEPOSIT_SWEEP_HOURS=24      hours between two sweeps of every stored deposit address (rpc); 0: none
SOLANA_RPC_URL=<url>                    rpc: main Solana endpoint (already set for balance reads; Folio: L1_RPC_URL)
SOLANA_BACKUP_RPC_URL=<url>             rpc: second Solana endpoint, optional (Folio: FOLIO_SOLANA_RPC_URL); never Alchemy
BASE_RPC_URL=<url>                      rpc: Base endpoint, read when Base is offered (already set; Folio: FOLIO_BASE_RPC_URL)
```

With the route on, the core does not start when a required setting is missing or malformed, the key file is absent, its
mode is wider than 0600, or it holds another account's key (`core/core.mjs`, and again in `createPipeline`).

## 3. The solver

- Holds USDC only. A trade beyond the per-trade or the per-day bound, or beyond its float, is refused at the tap,
  before the person is asked for anything (`TEMPORARILY_UNAVAILABLE`). A float that does not cover the trade is said
  in plain words: "YEET cannot fill this right now. Nothing was traded." (the one sentence that code may carry in
  place of the catalogue text; the connector passes that sentence and no other). `ops/ledger-route-check.mjs` prints
  the float (`"step":"solver_float"`: USDC inside the ledger, NEAR for gas, whether it covers the basket) so the
  operator sees it before a trade. The amount is recorded when the solver pays.
- One operation at a time. Sourcing is recognised by the change of the solver's own balances, so trades queue behind
  each other. A trade that waits past its deadline is not executed (safe, and it costs the person a retry).
- Leftover inventory (a buy that was sourced and not settled, a sell whose sale was refunded): sold back to USDC while
  no trade runs, at most every minute, at most `YEET_SOLVER_UNLOAD_MAX_TRIES` per coin and UTC day, each try at most
  `YEET_SOLVER_UNLOAD_MAX_USDC` worth. At the cap an alert is raised (`trade_alerts`, kind `stuck`) and the coin stays.
  A paid sale with no outcome for 20 minutes is closed with an alert instead of being followed for ever.
- A read right after one of our own transactions can still show the state before it (seen live in the spike). The
  route waits for the settlement to be final before the next operation, and asks one stale refusal again.
- It needs NEAR for gas (each `execute_intents` attaches 300 Tgas, about 0.03 NEAR prepaid, about 0.002 burnt). A buy is
  two calls, a sell two or three.

## 4. The cards

yeet-win main lists the request kind `near_intent` in the contract (`$defs.sign_request`, `near_intent_payload`), the
card's signing module accepts it (`trade-signing.js` `KINDS`), and its `wallet-request.mjs` is this repository's copy
byte for byte (the vendoring test holds that). So the tool answer carries a ledger trade's request to the card;
`cutSignRequests` stays in place and cuts nothing while the contract lists the kind. **In-card approval of a ledger
trade has still not run against Privy** (section 7); the YEET page (`/sign?trade_id=…`, same press and hold, same
Privy wallet) reads its requests from core directly and remains the fallback.

The Add funds card of an account on this route (yeet-win c671cc5 on branch `feat/deposit-3-steps`, `tools-7`):
contract `yeet_fund` output `methods`, `watch` (`$defs.deposit_watch`, with the stage `detected`, `detected_usdc`,
`detected_tx`) and `min_deposit_usdc`, fixtures `fund-track` and `fund-track-ready`, yeet-win docs/CARDS.md "A deposit
the server follows". **The pinned commit is on a branch of yeet-win that is not merged or pushed**: merge it to
yeet-win main before a deploy of this branch (the pin's commit id then stays valid only with a fast-forward merge;
otherwise vendor again from main).

## 5. Tools

Read-only check (no key, nothing signed, stored or sent; NEAR view calls and keyless dry quotes):

```
node ops/ledger-route-check.mjs --address <solana wallet address> --solver <solver account> [--usdc 5] [--coins WIF,BOME,TRUMP]
```

Prints the ledger account id and its balances, **the solver's float** (`solver_float`: its USDC, its NEAR for gas,
and a warning when it does not cover the basket), the quote and the exact message that would be approved. Run against
mainnet on 2026-11-14 for the test wallet: answered in full (float 0 USDC, 0.49 NEAR: a trade would be refused). It
also states the service's own rule: **a 3-coin 5 USDC basket is refused by the 3 USDC minimum per coin**; 5 USDC buys
one coin, three coins need 9.

Deposit addresses and the deposit watch (needs `ONECLICK_JWT` in the environment; never prints it; moves no funds):

```
node ops/ledger-route-check.mjs --address <solana wallet address> --deposit-addresses [--account <yeet account id>] [--db <file>]
node ops/ledger-route-check.mjs --address <solana wallet address> --deposit-watch [--follow-s 900] [--account …] [--db <file>]
```

The first prints the set (every chain and address, which of them the card shows, `created` or `adopted`); it uses the
same code as the service, so it lists before it creates and never makes a second set. The second follows a deposit:
one line per change of the card's stage, the ledger USDC and 1Click's own status of the set. `--db` defaults to
`~/.local/state/yeet/ledger-deposits.sqlite`; which file holds the row does not matter for safety, because the
service takes over the existing set from 1Click's list the first time it is asked.

A plain USDC transfer on Solana from a wallet file (dry by default):

```
node ops/send-usdc.mjs --to <solana address> --usdc 1 --wallet <file> [--fee-payer self|privy]            # dry
YEET_SEND_USDC_CONFIRM=send-usdc node ops/send-usdc.mjs --to … --usdc 1 --wallet <file> --fee-payer privy --broadcast
```

At most 5 USDC unless `--max-usdc` raises it (never over 25). The signed transaction is saved (`<wallet
file>.send-usdc.json`, or `--state`) before it is broadcast; a second run follows the same transfer and cannot pay
twice; a transfer that already landed is refused unless `--again`. No other operator tool sends plain USDC to an
arbitrary address (`ops/intents-direct-spike.mjs` only pays 1Click quotes it asked for itself).

## 6. Operator steps

`K=~/.local/state/yeet/keys/near-solver.key` (the spike's solver key, account
`92d267dde43be0993edf88347b17ce7aeec183eef0a5f87a0d55a60ea58cc902`), `W=~/.secrets/yeet-test-wallet.json`, both as in
`ops-scripts/intents-live.sh`. Run from `~/code/yeet-ai-wt-ledger` with the same environment that script sets
(Privy and fee payer variables, `SOLANA_RPC_URL`).

### 6.1 One real 5 USDC proof trade from the test wallet

```
# 0. look, move nothing
node ops/ledger-route-check.mjs --address <test wallet solana address> --solver 92d267dde43be0993edf88347b17ce7aeec183eef0a5f87a0d55a60ea58cc902 --usdc 5 --coins WIF

# 1. the solver's float and the person's USDC, both into the ledger (the spike's proven steps; each is resumable)
export INTENTS_SPIKE_CONFIRM=send-spike
S="node ops/intents-direct-spike.mjs --live --near-key $K --wallet $W"
$S --status                       # the solver's NEAR balance: 0.1 or more
$S --solver-usdc 6
$S --deposit-user 5.5 --new-trade

# 2. the route's settings for this shell
export YEET_ROUTE=ledger YEET_SOLVER_ACCOUNT=92d267dde43be0993edf88347b17ce7aeec183eef0a5f87a0d55a60ea58cc902 YEET_SOLVER_KEY_FILE=$K
export YEET_SOLVER_MAX_TRADE_USDC=6 YEET_SOLVER_MAX_DAY_USDC=20

# 3. dry: firm quotes, the request, the test wallet approves, the approval is verified and simulated; nothing is sent
node ops/user-signed-trade.mjs --side buy --coin WIF --usdc 5

# 4. the trade
export YEET_LIVE=1 YEET_KILL_SWITCH=0 YEET_LIVE_ACCOUNTS=yeet-privy-operator-test-wallet
node ops/user-signed-trade.mjs --side buy --coin WIF --usdc 5 --broadcast --follow-s 300

# 5. and back
node ops/user-signed-trade.mjs --side sell --coin WIF --broadcast --follow-s 300
$S --status
$S --withdraw-all user ; $S --withdraw-all solver       # everything back to the wallet
```

Expect in step 3: `"step":"executed"` with one request of kind `near_intent` and its `message`; `"step":"submitted"`
with `dry_run_state":"pending"`. In step 4: `"step":"status"` going `signing` then `success` with one `origin_tx`
(the NEAR settlement), and `"step":"ledger","state":"settled"` with `result.received`. In step 5 the last line has
`"unload":{"state":"done","surplus":"…"}`. The trades are recorded in `~/.local/state/yeet/user-signed-trade.sqlite`.
If step 4 ends `failed`, the person's USDC did not move. Every `--broadcast` run ends with one pass that sells what
the solver was left holding (`"step":"ledger_unload"`); `$S --status` shows what it holds and `$S --unload` sells it too.

### 6.2 One account on the ledger route in production

1. Mount the solver key file under the core's `/secrets` (mode 0600, readable by the container's user).
2. Fund the solver's float (6.1 step 1; `ledger-route-check.mjs` shows it as `solver_float`).
3. Settings. In `ops/.env` (compose): `YEET_LEDGER_ACCOUNTS=<the YEET account id>` (leave `YEET_ROUTE` unset: every
   other account stays on the chain route), `YEET_SOLVER_ACCOUNT=<64 hex>`, `YEET_SOLVER_KEY_FILE=/secrets/<file>`,
   `YEET_SOLVER_MAX_TRADE_USDC=<n>`, `YEET_SOLVER_MAX_DAY_USDC=<n>`; optional `NEAR_RPC_URL`,
   `YEET_LEDGER_DEPOSIT_STAGES` (`rpc` for three stages; then `SOLANA_BACKUP_RPC_URL` too), `YEET_MIN_DEPOSIT_USDC`.
   In `/var/lib/yeet-connector/config/core.env` (secret, core only):
   `ONECLICK_JWT=<the partner key>` (it is also the key the trade quotes already use). Restart the core; it refuses
   to start if a route setting is wrong.
4. The account funds itself: it asks to add funds, the Add funds card shows its permanent deposit address (made at
   that moment), it sends USDC on Solana, the card follows the deposit. Its welcome card and portfolio show its
   ledger balance. It proposes a basket as usual and approves it in the card, or on `/sign?trade_id=<id>` (section 4).
   This deploy carries `tools-7`: everyone refreshes YEET once (docs/DEPLOY-V2.md "Tools version").
5. Back to the chain route: remove the account from `YEET_LEDGER_ACCOUNTS` and restart. Its ledger balance stays in
   its ledger account until withdrawn (`--withdraw-user`, with its own key).

### 6.3 Proof: 1 USDC to the test wallet's permanent deposit address

Same shell as 6.1 (`W`, the Privy and fee payer variables, `SOLANA_RPC_URL`), plus the partner key, which is never
echoed: `set -a; . ~/.secrets/yeet-1click.env; set +a`. `A` is the test wallet's Solana address
(`3pdbUF2a37ANMsnvCHK4PdtvHCnxobF81ULE3rht8mVq` is the wallet whose ledger account
`29eb0c97…d940` already has a set, made 2026-11-14 14:08 UTC; the tool takes that set over).

```
A=<test wallet solana address>
D=~/.local/state/yeet/ledger-deposits.sqlite

# (a) the set: chain + address for every chain, which ones the card shows. Creates nothing when a set exists.
node ops/ledger-route-check.mjs --address $A --deposit-addresses --account yeet-privy-operator-test-wallet --db $D
#     -> "step":"deposit_addresses","state":"ready","source":"adopted","card_shows":[{"network":"solana","address":"<DEPOSIT>"}, …]
DEPOSIT=<the solana address from card_shows>

# (b) 1 USDC on Solana from the test wallet to it. First dry, then the real transfer.
node ops/send-usdc.mjs --to $DEPOSIT --usdc 1 --wallet $W --fee-payer privy
YEET_SEND_USDC_CONFIRM=send-usdc node ops/send-usdc.mjs --to $DEPOSIT --usdc 1 --wallet $W --fee-payer privy --broadcast
#     -> "step":"done","ok":true,"solana_tx":"…"

# (c) watch it credit the ledger account (start it before (b) in a second shell to see every stage)
node ops/ledger-route-check.mjs --address $A --deposit-watch --follow-s 900 --account yeet-privy-operator-test-wallet --db $D
#     -> "step":"deposit_watch" lines: "stage" (waiting, found, preparing, ready), "ledger_usdc", and "oneclick":{status,…}
#     -> "step":"done","ok":true,"credited_usdc":"1"
node ops/ledger-route-check.mjs --address $A --solver 92d267dde43be0993edf88347b17ce7aeec183eef0a5f87a0d55a60ea58cc902 --usdc 5 --coins WIF
#     -> "step":"account","usdc_spendable":"1"
```

What to read off (c): whether `oneclick.status` (and `origins`, `deposited`, `near`) change between the transfer and
the credit. If they do, the middle stages are real and stay; if the only change is `ledger_usdc`, set
`YEET_LEDGER_DEPOSIT_STAGES=balance`. Also note `credited_usdc` against the 1 USDC sent (a fee would show here) and
the seconds it took. Start (c) BEFORE (b): the watch counts what arrives after it began.

## 7. Not built, not proven

- **No deposit has been sent to a permanent address yet.** Proven live, read-only: the partner key lists and reads
  the set of the test wallet's ledger account, the service takes it over with GET requests only, the check of its
  request passes, and the watch reads the ledger and 1Click's status. Not proven: the credit itself, its fee if any,
  how long it takes, and what 1Click's status shows on the way (so the two middle stages; 6.3 settles it).
- **Listing every set before a create** grows with the number of accounts (500 a page). It runs once per account.
  `GET /v0/quotes` is marked provisional by 1Click; if it stops answering, no new set is made (funding then says
  "not available yet" for accounts without one) and stored sets keep working.
- **A sell's proceeds can read as a deposit** when the USDC arrives after the trade's last update (the surplus of a
  sell): the watch re-bases on trade activity, not on the ledger's own history. The card then says USDC arrived,
  which is true, with the wrong reason.
- **Another coin than USDC** stays in the ledger account. Nothing swaps it and no card withdraws it.
- **Base USDC** sent to the set's EVM address is such a coin while Base is not offered (the default).
- **Base offered (`solana,base`)** is proven by tests only (in-memory ledger, fake 1Click, fake RPC). Needs a
  real-money check before it is turned on: that 1Click credits Base USDC to the ledger account under the token id
  the catalogue names; a buy whose message gives that token, approved in the card and settled; that 1Click quotes
  Base USDC to Solana USDC inside the ledger for the solver's unload, and what that costs. The loss bound of a buy
  (`MAX_LOSS_BPS`) treats both USDC as equal: the swap's cost is on top of it.
- **The `detected` stage** is proven by tests only. Not seen live: how long USDC stays at a deposit address before
  1Click moves it on (a deposit that comes and goes between two reads is caught on Solana, by its signature, and
  missed on Base, where the balance is read), and whether a Base provider serves the Transfer log for the range asked.
- **A buy from USDC in two parts** is not split: the larger part bounds it (1.5).
- **Card payments** do not reach the ledger account (1.5).
- **In-card approval of a ledger trade** has the contract and the card code, and no run against Privy.
- **Privy producing the signature.** The spike and every test sign with local keys. Privy's Solana `signMessage` is
  documented to sign the given bytes; if it signed anything else the server refuses the approval (nothing moves),
  but then no Privy account can trade on this route until that is solved.
- **Withdrawal on a card.** An operator step with the wallet's key file.
- **No real trade has run through this code.** The spike's trades prove the mechanics; this route is proven on an
  in-memory ledger that verifies the real signatures and applies the contract's fee and zero-sum rule, and by
  read-only runs against mainnet. **The sell path was never run live: the solver's float was empty** (it is 0 USDC
  today; `ledger-route-check.mjs` says so).
- **One trade at a time** through the solver. Concurrent ledger trades queue; a queue longer than about two trades
  makes the later ones miss their deadline and fail safely.
- **Sell surplus when the solver's sale fails**: the person has their approved minimum; the surplus is an alert for
  the operator, not paid automatically.
- **Preview and firm quote differ**: the card shows a dry quote, the tap takes a firm one; the requote rule covers a
  worse price as on the chain route.
- **The welcome card's readiness** still looks at the Solana driver being configured (fee payer), which this route
  does not use. In production it is configured, so nothing shows.
- **Keyless 1Click** sourcing has no guaranteed rate limit; a refusal makes the tap fail before anything is committed.
- **Solver NEAR balance** is not monitored: when it runs out, sourcing fails and trades are not executed (the check
  tool prints it).

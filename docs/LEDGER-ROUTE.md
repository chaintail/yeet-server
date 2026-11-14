# The ledger route: trades that settle inside the NEAR Intents ledger

Status 2026-11-14, branch `int/ledger` (from `int/auth` f3557c9). A second trade route behind the same cards, **off by
default**. With `YEET_ROUTE` unset or `chain` and `YEET_LEDGER_ACCOUNTS` empty, nothing of this route is created, read
or written, and the 1Click chain-to-chain route runs as before (all 692 earlier tests pass unchanged).

The route is the proven spike made part of the pipeline: `docs/INTENTS-BALANCE-MODEL.md`, `ops/intents-direct-spike.mjs`,
real trades in `receipts/intents-live/` (3-coin buy with one approval in 28.6 s, sell paid in 4 s).

- Code: `connector/core/ledger-route/` (`config.mjs`, `route.mjs`, `solver.mjs`, `check.mjs`), on the spike's modules in
  `connector/core/intents/`.
- Hooks: `connector/core/pipeline/pipeline.mjs` (every use is behind `ledgerRoute`, which is `null` while the route is off),
  `core/trade/proposals.mjs` (`clientFor`), `core/pipeline/wallet-request.mjs` (request kind `near_intent`),
  `mcp/tool-registration.mjs` (`cutSignRequests`), `core/core.mjs` (start check), `ops/compose.yml` (settings passed through).
- Tests: `connector/core/ledger-route/ledger-route.test.mjs` (25), `connector/core/intents/*.test.mjs` (63, from the spike).
- Read-only tool: `ops/ledger-route-check.mjs`.

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

- **In (what the spike used, proven live):** a 1Click same-asset quote, USDC on Solana in, the same USDC credited to
  the **person's own ledger account** (`recipientType: INTENTS`, recipient = their account id, refund to their own
  Solana wallet). `amountOut == amountIn`, no fee entry. It is an ordinary USDC transfer signed by the person's Solana
  wallet: the request kind the cards already handle. It is **not wired to a card yet** (section 6); today it is the
  operator step `--deposit-user` of `ops/intents-direct-spike.mjs`.
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
| caps | the same code: tiers, 3 USDC per coin, daily cap (`checkBasket`, `checkDaily`) |

Rows of a ledger trade carry `origin_chain = 'sol'` (the person's Solana key owns the account) and are told apart by
their `ledger_trade` row. No migration of the existing tables: the route makes its own four tables when it is created
(`ledger_trade`, `ledger_attempt`, `ledger_solver_day`, `ledger_unload`).

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
```

With the route on, the core does not start when a required setting is missing or malformed, the key file is absent, its
mode is wider than 0600, or it holds another account's key (`core/core.mjs`, and again in `createPipeline`).

## 3. The solver

- Holds USDC only. A trade beyond the per-trade or the per-day bound, or beyond its float, is refused at the tap,
  before the person is asked for anything (`TEMPORARILY_UNAVAILABLE`). The amount is recorded when the solver pays.
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

## 4. The cards: what needs yeet-win

**In-card approval of a ledger trade needs a yeet-win change.** It was not made here. Exactly:

1. `contracts/yeet-tools.json`, `$defs/sign_request`: add `"near_intent"` to `kind.enum`, and to `payload.anyOf` a
   `near_intent_payload`: object, no additional properties, required `standard` (`"raw_ed25519"`), `message` (string,
   1..4000), `message_base64` (string), `signer_id` (64 hex), `verifying_contract` (`"intents.near"`), `deadline`
   (time), `gives` (array 1..5 of `{token_id: string, amount_raw: string}`), `receives` (array 1..5 of
   `{token_id: string, min_raw: string}`). `submit_trade_signature.signed`: the description gains "base64 of the
   64-byte signature (near_intent)".
2. `packages/widget/src/vendor/wallet-request.mjs`: copy this branch's `connector/core/pipeline/wallet-request.mjs`.
3. `packages/widget/src/trade-signing.js`: `KINDS` gains `'near_intent'`. `sign()` needs no other change:
   `privyRpcBodies` checks the message and answers the one `signMessage` body; a `BATCH_REFUSED` already marks the
   legs not sent. No card text changes.
4. Rebuild the cards and vendor them here (`scripts/vendor-yeet-win.sh`).

Why it cannot be avoided: the wallet calls the deployed card can make are a Solana transaction signature, an EVM
transaction signature, an EIP-7702 authorization and EIP-712 typed data restricted to a Calibur batch. None of them
yields a signature the ledger accepts for an intent, and the card drops requests of a kind it does not know.

**Until then** a ledger trade is approved on the YEET page (`/sign?trade_id=…`, same press and hold, same Privy
wallet): the page loads `wallet-request.mjs` from this server and reads its requests from core directly, so it handles
`near_intent` as built. The tool answer to the card leaves the unknown request out (`cutSignRequests`), so the card
shows the trade waiting; it does not open the page by itself for this kind of trade.

## 5. Tools

Read-only check (no key, nothing signed, stored or sent; NEAR view calls and keyless dry quotes):

```
node ops/ledger-route-check.mjs --address <solana wallet address> --solver <solver account> [--usdc 5] [--coins WIF,BOME,TRUMP]
```

Prints the ledger account id, its balances, the solver's float, the quote and the exact message that would be
approved. Run against mainnet on 2026-11-14 for the test wallet: answered in full. It also states the service's own
rule: **a 3-coin 5 USDC basket is refused by the 3 USDC minimum per coin**; 5 USDC buys one coin, three coins need 9.

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
2. Fund the solver's float (6.1 step 1) and the account's ledger account. The account id is the hex of its Solana
   address (`ledger-route-check.mjs` prints it). Until funding is on a card, USDC reaches it by a deposit that names
   that account as recipient; `--deposit-user` deposits into the account of the wallet it is run with, so for another
   person's account this needs a small tool change or a deposit from their own wallet (section 7).
3. Environment of the core: `YEET_LEDGER_ACCOUNTS=<account id>` (leave `YEET_ROUTE` unset), `YEET_SOLVER_ACCOUNT`,
   `YEET_SOLVER_KEY_FILE=/secrets/<file>`, `YEET_SOLVER_MAX_TRADE_USDC`, `YEET_SOLVER_MAX_DAY_USDC`. Restart the core;
   it refuses to start if any of them is wrong.
4. That account's welcome card and portfolio now show its ledger balance. It proposes a basket as usual; after the tap
   the trade waits; the person opens `/sign?trade_id=<id>` and presses and holds (section 4).
5. Back to the chain route: remove the account from `YEET_LEDGER_ACCOUNTS` and restart. Its ledger balance stays in
   its ledger account until withdrawn (`--withdraw-user`, with its own key).

## 7. Not built, not proven

- **In-card approval** (section 4). The server side is built and tested with the card's own contract module; the
  card and the contract are not changed.
- **Privy producing the signature.** The spike and every test sign with local keys. Privy's Solana `signMessage` is
  documented to sign the given bytes; if it signed anything else the server refuses the approval (nothing moves),
  but then no Privy account can trade on this route until that is solved.
- **Funding and withdrawal on a card.** Both are operator steps with the wallet's key file. For a real account the
  deposit has to come from the person's own wallet as an approved transfer; the design is in 1.5.
- **Depositing into another person's ledger account** with the operator tool (6.2 step 2).
- **No real trade has run through this code.** The spike's trades prove the mechanics; this route is proven on an
  in-memory ledger that verifies the real signatures and applies the contract's fee and zero-sum rule, and by one
  read-only run against mainnet.
- **One trade at a time** through the solver. Concurrent ledger trades queue; a queue longer than about two trades
  makes the later ones miss their deadline and fail safely.
- **Sell surplus when the solver's sale fails**: the person has their approved minimum; the surplus is an alert for
  the operator, not paid automatically.
- **Preview and firm quote differ**: the card shows a dry quote, the tap takes a firm one; the requote rule covers a
  worse price as on the chain route.
- **The welcome card's readiness** still looks at the Solana driver being configured (fee payer), which this route
  does not use. In production it is configured, so nothing shows.
- **Base USDC** in the person's wallet cannot pay a ledger trade and reads as 0 on this route.
- **Keyless 1Click** sourcing has no guaranteed rate limit; a refusal makes the tap fail before anything is committed.
- **Solver NEAR balance** is not monitored: when it runs out, sourcing fails and trades are not executed.

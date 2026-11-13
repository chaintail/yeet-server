# folio-ai (private)

folio-ai: Folio's AI connector, configured for YEET. It is published as `chaintail/folio-ai`; the product, its
hosts, directories and environment variables keep the YEET names.

Private side of YEET: the ChatGPT connector (sign-in server, core, connector), its Privy sign-in bundle, the trade
engine and the deployment files. The public side (router, landing page, tool contract, card widget) is
`chaintail/yeet-win`; the pieces used here are vendored from a pinned commit.

Port of the Folio connector from `stock-app` `origin/dev` (0e4002821) `research/folio-mcp/current`, following
`YEET-PORT-PLAN.md` Lanes A and B. The first commit is the verbatim import; the following commits are the YEET edits.

## Layout

```
connector/
  as/          sign-in server: OAuth 2.1 / OIDC (oidc-provider), consent, /me, sign-in pages
  core/        identity store (account on first verified sign-in), per-route scopes, YEET routes
  core/trade/  trade engine (Lane B): proposals, confirm codes, limits, executor, tracker, wallets, signers
  core/xp/     XP (Lane E, P2): ledger, streak, daily spin, leaderboards
  mcp/         protocol endpoint at /, metadata, tool registration, card templates
  shared/      modules two roles load: common settings, introspection, Privy token check
  contracts/   error catalogue loader (reads the vendored contract's x-yeet-errors)
  login/       Privy sign-in bundle source (React, esbuild)
  vendor/      pinned yeet-win build: contract, card templates, router dist, router fixtures (vendor/README.md)
  test/        in-process acceptance test
ops/           compose, Dockerfile, Caddy snippet, env names (not started)
scripts/       vendor-yeet-win.sh, text-gate.sh, live-one-leg.mjs (B-2)
```

Endpoints on `https://chatgpt.yeet.win`: `POST /` (protocol, connector), `GET /.well-known/oauth-protected-resource`
and `GET /health` (connector); everything else (`/.well-known/oauth-authorization-server`, `/auth`, `/token`, `/me`,
`/interaction/*`, `/account/*`) is the sign-in server. There is no `/mcp` path.

## Run the tests

Node 24.

```
cd connector
npm ci
npm test                         # engine + adapters (core/trade/*.test.mjs), XP (core/xp/*.test.mjs), contract, registration, in-process acceptance
node --test core/xp/*.test.mjs     # XP alone, including the YEET_P2=1 run through the connector
node --test core/trade/*.test.mjs  # acceptance B-1 alone
npm run build:login              # npm ci in login/ and esbuild -> login/dist/login.js
npm run text-gate                # same as ../scripts/text-gate.sh
```

Update the vendored yeet-win pieces (never writes into the yeet-win checkout; builds under the ignored `.build/`):

```
scripts/vendor-yeet-win.sh ~/code/yeet-win main
```

## Tools

Schemas, titles, descriptions, annotations, scopes, cards, visibility and widget access all come from the vendored
`contracts/yeet-tools.json` (yeet-win commit in `connector/vendor/yeet-win/PINNED`).

| Tool | P | Scope | Card | Model sees it | Against fakes | Needs real keys for |
|---|---|---|---|---|---|---|
| `yeet_home` | P0 | yeet:read | home | yes | wallets, USDC balance, `ready / needs_signer / needs_funds / paused`; `xp` null unless `YEET_P2=1`, `recent_wins` always empty (see XP) | Privy (wallet lookup), `BASE_RPC_URL` |
| `yeet_coins` | P0 | yeet:read | none | yes | catalogue from the vendored router, prices null | none |
| `yeet_propose` | P0 | yeet:write | basket | yes | dry router plan, limits, warnings, saved proposal, confirm code in `_meta` only | 1Click (dry quotes, no key needed) |
| `yeet_quote` | P0 | yeet:write | basket | yes | new revision, fresh dry quote and code | 1Click |
| `execute_trade` | P0 | yeet:trade | receipt | no (`openai/visibility: private`, `ui.visibility: ["app"]`) | full tap path with a fake signer | 1Click live quotes, Privy signer, `BASE_RPC_URL`, `YEET_LIVE=1` |
| `trade_status` | P0 | yeet:read | receipt | yes | 1Click `/status` folded by the router's `applyStatus` | 1Click |
| `yeet_portfolio` | P1 | yeet:read | portfolio | yes | Solana holdings of catalogue coins, prices from 1Click `/tokens` | `SOLANA_RPC_URL` |
| `skeet_propose` | P1 | yeet:write | basket | yes | percent of holdings, dry SKEET plan | `SOLANA_RPC_URL`, then a Solana fee payer to execute |
| `yeet_leaderboard` | P2 | yeet:read | leaderboard | yes (only with `YEET_P2=1`) | all-time and 7-day XP boards, shared ranks for ties | none |
| `daily_spin` | P2 | yeet:write | home | no (card only; only with `YEET_P2=1`) | one spin per UTC day | `YEET_XP_SECRET` |

The one-time confirm code (32 random bytes, base64url) is returned only in result `_meta["yeet/confirm"]`; the
connector strips it from `structuredContent` and `content`, and a test checks both. Core stores only its SHA-256,
bound to account, client, proposal, revision and a hash of the quoted legs, for 120 s; it is single use and a used
code replays the trade it started.

## Trade engine (Lane B)

- `execute_trade` at the tap: code check, kill switch, `YEET_LIVE` (unset: TRADING_PAUSED, code stays unused),
  signer state, balance, per-trade and daily caps, live router plan (`dry:false`), the requote rule (any live leg
  under the preview `min_out`, or the preview over 60 s old and a live leg under its estimate: REQUOTE with a new
  revision and a new code in `_meta`), cost ceiling, then one exact USDC `transfer` per leg through the signer and
  1Click `submitDeposit`. A failed leg leaves the trade `partial`; unsent amounts go back to the daily allowance.
- The tracker (`core/trade/tracker.mjs`) polls `/status` every 5 s, keeps a router `ReceiptSchema` receipt per trade
  (so `yeet-router replay` can re-check it) and calls `onSettled` once per trade; XP subscribes to it (below).
- Signers (`YEET_SIGNER`): `delegated` (default; the YEET key quorum on the person's embedded wallets, added at
  sign-in) or `custodial` (one Privy server wallet per account owned by the YEET key). Same interface; both use
  Privy wallet RPC with Folio's authorization-signature scheme. Base: `eth_sendTransaction` on `eip155:8453`,
  `sponsor: true` unless `YEET_GAS_WALLET_ID` is set (then a 0.00003 ETH top-up from that wallet when needed).
  Solana (SKEET) answers WALLET_NOT_READY until `YEET_SOL_FEE_PAYER_ID` is set.
- Without Privy credentials the connector still runs: `yeet_home`, proposals and taps answer WALLET_NOT_READY.
- Policies: `node core/trade/policy-create.mjs aggregation|base|solana` prints the Privy request bodies (Base: USDC
  `transfer` on Base only, per-transaction cap in hex, aggregation referenced by id; Solana: TransferChecked of the
  catalogue's mints only), owned by `YEET_POLICY_ADMIN_QUORUM_ID`; it never sends them. The daily cap is the
  server's (`ops/README.md`, "Trade limits and the Privy signer").
- State: `$STATE_DIR/trade.sqlite` (tables of plan 4.2, migrated at start).

## XP (Lane E, P2)

On only when core and connector both have `YEET_P2=1`; without it `yeet_home.xp` is null, `trade_status.xp_award` is
null and the two P2 tools are not registered. It is just XP: no money, no prizes. State: `$STATE_DIR/xp.sqlite`.

| Event | XP | Cap |
|---|---|---|
| `sign_in` (verified sign-in) | 5 | 1 a UTC day |
| `first_yeet` (first YEET with a delivered leg) | 50 | once ever |
| `yeet_settled` (YEET with at least one delivered leg) | 20 | 5 a UTC day |
| `skeet_settled` (SKEET with at least one delivered leg) | 10 | 5 a UTC day |
| `daily_spin` | 5 + draw (0 to 40, mean 7.52) + 25 when the streak reaches 3 days or a multiple of 7 | 1 a UTC day |

- Ledger (`core/xp/ledger.mjs`): rules in `xp_rule` (seeded on first open, editable), awards in `xp_event`; caps and
  dedupe are checked in the same transaction as the insert.
- Trades: paid exactly once per trade from the tracker's `onSettled`; `xp_trade` (trade id primary key) is written
  in the same transaction. If the hook is lost (crash), the next `trade_status` of the final trade pays it; repeats
  add nothing. Refunded or failed trades show `xp_award {points: 0}`.
- Streak: consecutive UTC days with any XP event. Spin: HMAC-SHA256(`YEET_XP_SECRET`, `account|day`) over the
  weighted table; a repeat the same day returns the same spin. Without `YEET_XP_SECRET` (16+ characters) there is no
  spin (`spin_available` false, `daily_spin` TEMPORARILY_UNAVAILABLE).
- Leaderboards: all time and the last 7 days, top 50, equal XP shares a rank. Names are handles like
  "Lucky Otter 42" from a SHA-256 of the account id: no email, wallet address or sign-in id.
- `recent_wins` is always `[]`: the contract wants `{symbol, pct}`, and stored data has what each leg paid and
  received but no later price, so no gain can be stated truthfully.

## Environment variables (names only)

- Sign-in server: `ISSUER`, `RESOURCE`, `PUBLIC_BASE_URL`, `PUBLIC_MODE`, `COOKIE_SECURE`, `TRUST_PROXY`, `ACCESS_TTL`,
  `REFRESH_FAMILY_TTL`, `TEST_PROFILE`, `DEV_IDENTITY_STUB`, `MOCK_PASSWORD_LOGIN` (must be unset; password sign-in was
  removed), `PRIVY_LOGIN`, `REFRESH_CONSENT_COMPAT`, `REFRESH_DIAGNOSTICS`, `CIMD_TEST_FIXTURES`, `PRIVY_APP_ID`,
  `PRIVY_JWKS_URL`, `STATE_DIR`, `CORE_INTERNAL`, `YEET_SIGNER_ID`, `YEET_BASE_POLICY_ID`, `YEET_SOLANA_POLICY_ID`,
  `YEET_DAILY_CAP_USDC` (consent copy).
- Connector: `ISSUER`, `RESOURCE`, `PUBLIC_MODE`, `PRIVY_LOGIN`, `AS_INTERNAL`, `CORE_INTERNAL`, `YEET_P2` (`1` registers the P2 tools).
- Core: `ISSUER`, `RESOURCE`, `PRIVY_LOGIN`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_JWKS_URL`,
  `YEET_PRIVY_AUTHORIZATION_KEY`, `YEET_PRIVY_KEY_QUORUM_ID`, `YEET_BASE_POLICY_ID`, `YEET_SOLANA_POLICY_ID`,
  `YEET_SIGNER` (`delegated` | `custodial`), `YEET_GAS_WALLET_ID`, `YEET_SOL_FEE_PAYER_ID`, `BASE_RPC_URL`,
  `SOLANA_RPC_URL`, `ONECLICK_JWT`, `YEET_LIVE` (`1` to execute), `YEET_KILL_SWITCH`, `YEET_MAX_TRADE_USDC` (25),
  `YEET_DAILY_CAP_USDC` (50), `YEET_MIN_LEG_USDC` (3), `YEET_MAX_COST_BPS` (800), `YEET_MAX_ACCOUNTS` (200),
  `YEET_P2` (`1` turns XP on), `YEET_XP_SECRET` (spin draw key, 16+ characters), `YEET_REQUOTE_TOLERANCE_BPS` (50),
  `YEET_CODE_MINT_LIMIT` (20), `YEET_TRACK_MAX_HOURS` (24), `YEET_BALANCE_TOLERANCE_BPS` (100),
  `YEET_STUCK_AFTER_MINUTES` (30), `STATE_DIR`.
- Operator scripts: `YEET_POLICY_ADMIN_QUORUM_ID` (policy-create.mjs), `TRADE_DB` (trade-alerts.mjs).
- What each one means, and the compose defaults (`REFRESH_FAMILY_TTL=604800`, 7 days; `REFRESH_CONSENT_COMPAT=1`;
  `REFRESH_DIAGNOSTICS=1`): `ops/README.md`, "Variables".
- All roles, for local runs and tests: `AS_PORT`, `CONNECTOR_PORT`, `CORE_PORT`, `ADMIN_PORT`, `LISTEN_HOST`,
  `SECRETS_DIR` (defaults: 38312, 38313, 38316, 38317, `0.0.0.0`, `/secrets`).

Service-to-service secret files: `core-mcp`, `core-as`, `core-operator`, `introspection`, `core-introspection`,
`operator`, `csrf`.

## B-2: one live leg, once funded

Not run yet. Prerequisites: a Privy app with signers enabled, the YEET authorization key registered as a key quorum,
the Base policy created from `policy-create.mjs` and attached at sign-in, the owner signed in once through the
connector (account `yeet-privy-...`, signer attached), and at least the trade amount of USDC on the Base wallet.

```
cd /path/to/yeet-ai
export YEET_LIVE=1 STATE_DIR=... PRIVY_APP_ID=... PRIVY_APP_SECRET=... YEET_PRIVY_AUTHORIZATION_KEY=... \
       YEET_PRIVY_KEY_QUORUM_ID=... BASE_RPC_URL=... SOLANA_RPC_URL=... ONECLICK_JWT=...   # values from the secret store
node scripts/live-one-leg.mjs --account yeet-privy-XXXX --usdc 3 --coin WIF --i-accept-real-funds
```

It prints home, the proposal, the submitted leg and each status change, writes `receipts/<trade>.json`, and prints
`node connector/vendor/yeet-win/router/dist/src/cli.js replay receipts/<trade>.json`; B-2 passes when the leg reaches
SUCCESS and replay matches. Without `YEET_LIVE=1` or any flag it refuses and moves nothing.

## Still stubbed or missing

- `yeet_coins` prices are null; `recent_wins` stays empty (no price history).
- SKEET execution needs the Solana fee payer (`YEET_SOL_FEE_PAYER_ID`) and a live check of the sponsored send.
- Never exercised against live Privy: the `eth_sendTransaction` body and answer (modelled on docs.privy.io: empty
  hash plus `transaction_id` when sponsored), `GET /v1/transactions`, `reference_id`, the exact 400 text for a reused
  idempotency key, `GET /v1/users/{did}`, gas sponsorship on the app's plan (see the comments in `core/trade/signer-privy.mjs` and
  `policy-create.mjs`).
- Deploy: image not built, compose not started, Caddy and tunnel not changed (see `ops/README.md`).

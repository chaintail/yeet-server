# yeet-ai (private)

Private side of YEET: the ChatGPT connector (sign-in server, core, connector), its Privy sign-in bundle and the deployment
files. The public side (router, landing page, tool contract, card widget) is `chaintail/yeet-win`.

Port of the Folio connector from `stock-app` `origin/dev` (0e4002821) `research/folio-mcp/current`, following
`YEET-PORT-PLAN.md` Lane A. The first commit is the verbatim import; the following commits are the YEET edits.

## Layout

```
connector/
  as/          sign-in server: OAuth 2.1 / OIDC (oidc-provider), consent, /me, sign-in pages
  core/        identity store (account on first verified sign-in), per-route scopes, YEET routes
  mcp/         protocol endpoint at /, metadata, tool registration, card templates
  shared/      modules two roles load: common settings, introspection, Privy token check
  contracts/   yeet-tools.json (local P0 contract) and the error catalogue loader
  login/       Privy sign-in bundle source (React, esbuild)
  vendor/      pinned files from yeet-win (see vendor/README.md)
  test/        in-process acceptance test
ops/           compose, Dockerfile, Caddy snippet, env names (not started)
scripts/       text-gate.sh
```

Endpoints on `https://chatgpt.yeet.win`: `POST /` (protocol, connector), `GET /.well-known/oauth-protected-resource`
and `GET /health` (connector); everything else (`/.well-known/oauth-authorization-server`, `/auth`, `/token`, `/me`,
`/interaction/*`, `/demo/*`) is the sign-in server. There is no `/mcp` path.

## Run the tests

Node 24.

```
cd connector
npm ci
npm test              # unit tests + in-process acceptance (127.0.0.1:38860-38863, temp state)
npm run build:login   # npm ci in login/ and esbuild -> login/dist/login.js
npm run text-gate     # same as ../scripts/text-gate.sh
```

## Tools (P0)

| Tool | Scope | Card | Model sees it | State |
|---|---|---|---|---|
| `yeet_home` | yeet:read | home-v1 | yes | stub: TEMPORARILY_UNAVAILABLE |
| `yeet_coins` | yeet:read | none | yes | live: curated catalogue from vendored yeet-win `catalog.json`, prices null |
| `yeet_propose` | yeet:write | basket-v1 | yes | stub |
| `yeet_quote` | yeet:write | basket-v1 | yes | stub |
| `execute_trade` | yeet:trade | receipt-v1 | no (`openai/visibility: private`, `ui.visibility: ["app"]`) | stub |
| `trade_status` | yeet:read | receipt-v1 | yes | stub |

## Environment variables (names only)

- Sign-in server: `ISSUER`, `RESOURCE`, `PUBLIC_BASE_URL`, `PUBLIC_MODE`, `COOKIE_SECURE`, `TRUST_PROXY`, `ACCESS_TTL`,
  `REFRESH_FAMILY_TTL`, `TEST_PROFILE`, `DEV_IDENTITY_STUB`, `MOCK_PASSWORD_LOGIN` (must be unset; password sign-in was
  removed), `PRIVY_LOGIN`, `REFRESH_CONSENT_COMPAT`, `REFRESH_DIAGNOSTICS`, `CIMD_TEST_FIXTURES`, `PRIVY_APP_ID`,
  `PRIVY_JWKS_URL`, `STATE_DIR`, `CORE_INTERNAL`, `YEET_SIGNER_ID`, `YEET_BASE_POLICY_ID`, `YEET_SOLANA_POLICY_ID`,
  `YEET_DAILY_CAP_USDC` (consent copy).
- Connector: `ISSUER`, `RESOURCE`, `PUBLIC_MODE`, `PRIVY_LOGIN`, `AS_INTERNAL`, `CORE_INTERNAL`.
- Core: `ISSUER`, `RESOURCE`, `PRIVY_LOGIN`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_JWKS_URL`,
  `YEET_PRIVY_AUTHORIZATION_KEY`, `YEET_PRIVY_KEY_QUORUM_ID`, `YEET_BASE_POLICY_ID`, `YEET_SOLANA_POLICY_ID`,
  `YEET_SIGNER`, `YEET_GAS_WALLET_ID`, `YEET_SOL_FEE_PAYER_ID`, `BASE_RPC_URL`, `SOLANA_RPC_URL`, `ONECLICK_JWT`,
  `YEET_LIVE`, `YEET_KILL_SWITCH`, `YEET_MAX_TRADE_USDC`, `YEET_DAILY_CAP_USDC`, `YEET_MIN_LEG_USDC`, `YEET_MAX_COST_BPS`,
  `YEET_MAX_ACCOUNTS` (default 200), `YEET_XP_SECRET`, `STATE_DIR`.
- All roles, for local runs and tests: `AS_PORT`, `CONNECTOR_PORT`, `CORE_PORT`, `ADMIN_PORT`, `LISTEN_HOST`,
  `SECRETS_DIR` (defaults: 38312, 38313, 38316, 38317, `0.0.0.0`, `/secrets`).

Service-to-service secret files: `core-mcp`, `core-as`, `core-operator`, `introspection`, `core-introspection`,
`operator`, `csrf`.

## Still stubbed or missing

- Trade engine (Lane B): proposals, confirm codes, quotes, execution, status; every route except `/coins` answers
  `TEMPORARILY_UNAVAILABLE`. `yeet_coins` prices are null until the 1Click price feed is wired in.
- XP, streak, spin, leaderboard (Lane E); P1/P2 tools (`yeet_portfolio`, `skeet_propose`, `yeet_leaderboard`,
  `daily_spin`) are not registered.
- Tool contract: local `connector/contracts/yeet-tools.json` until yeet-win publishes `contracts/yeet-tools.json`.
- Cards: built-in plain-text card until the yeet-win widget package is vendored under `connector/vendor/yeet-win/widget/`.
- `@yeet/router` dist is not vendored yet (Lane B needs it).
- Deploy: image not built, compose not started, Caddy and tunnel not changed (see `ops/README.md`).

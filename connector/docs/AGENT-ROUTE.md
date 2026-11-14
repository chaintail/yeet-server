# Agent route

A second MCP endpoint for coding agents (Claude Code, Codex, any MCP client) on its own host, `mcp.yeet.win`. It uses the same YEET account as the ChatGPT route. It has no cards, no widget metadata and no conversation guidance: every result is plain JSON. The agent trades by itself with its own key, from a budget the person gives it.

The switch is `YEET_AGENT_ROUTE=on`. It is off by default. While it is off:

- the agent host answers 404 on every path,
- no new client class exists,
- registration accepts ChatGPT's redirect URIs only,
- every token is class `chatgpt`,
- the full suite passes unchanged.

## Key model

- The agent generates an ed25519 key pair on its own machine and keeps the private key there. The server never sees it.
- The key's implicit account inside the NEAR Intents ledger (`intents.near`) is the agent's own balance: 64 hex characters, the 32 public key bytes.
- The person funds that balance by signing ONE ledger `transfer` from their own ledger account (the one their Privy Solana key owns) to the agent's account. They sign it on the YEET signing page (`/sign?trade_id=a_...`, the same page and the same wallet check as trades).
- The agent can spend only that balance. A trade is the ledger route's `token_diff` message for the agent's own account (`raw_ed25519`). The agent signs it locally, and our solver settles it in one `execute_intents` call, or nothing moves.
- A return sends the agent's balance to the owner's ledger account. The server builds that message with the owner as the only receiver, and the agent signs it.
- The server holds no key of the person or of the agent. The solver only relays transfers: they are the signer's own messages, and it pays the NEAR gas. YEET charges no fee.

In the pipeline, an agent is an account of its own, `yeet-agent-<40 hex>`, whose wallet is the agent key. It gets the pipeline's proposals, confirm codes, tier caps, trade rows, receipts and the ledger route unchanged. The confirm code never leaves the server. The agent's account trades on the ledger route whatever `YEET_ROUTE` says. Its place in `YEET_LIVE_ACCOUNTS` is its owner's. Agent trades earn no XP, do not spin the lucky wheel and rank on no leaderboard.

## Owner account mode

The switch is `YEET_AGENT_OWNER_ACCOUNT=on` (core). It is off by default and needs `YEET_AGENT_ROUTE=on`: `on` without it, or any value other than `on`, `off` or empty, stops core. While it is off, `account: "owner"` is refused with `OWNER_ACCOUNT_OFF` (403, `retryable: false`), the owner tables are not created, and every call without `account` (or with `account: "agent"`) answers exactly as before.

In this mode the agent trades the person's OWN ledger account, the one their Privy Solana wallet owns. The agent does not need a key of its own or a budget:

- The person approves the agent once in the browser through Privy's device authorization flow (the `/agent/approve` page, a separate branch). After that the agent obtains each signature from the person's Privy Solana wallet itself (Solana `signMessage` over the message's UTF-8 bytes). That happens between the agent and Privy only: YEET is not on the signing path and sees nothing but the resulting signature.
- One wallet and one portfolio for ChatGPT and the agent.

The path is the ChatGPT card's own path, under the person's account id: the pipeline's proposal, quote, floors, confirm code, execute, nonce, deadline, the ledger route's unsigned `token_diff`, its `raw_ed25519` check against the person's wallet key, simulate, then settle. The person's own caps and gate apply as on the card (tier caps, daily cap, `YEET_LIVE_ACCOUNTS`, the kill switch), plus the agent caps: `YEET_AGENT_MAX_TRADE_USDC` per buy, and `YEET_AGENT_MAX_DAY_USDC` per UTC day per agent connection. The day counts this connection's owner-mode buys (legs not given back as not sent) together with its own key's spend when it has one. The person's ChatGPT trades do not count against the agent.

Owner-mode trades are the person's own trades: the trade row, the proposal and the receipt belong to the person's account (not to a `yeet-agent-...` account). So the tracker's settle event carries the person's account id, core pays XP exactly as for a card trade (`onTradeSettled`, P2), the trade ranks on the boards, and it shows in `yeet_portfolio` and `trade_status` on the ChatGPT route. The lucky wheel is not involved: an owner-mode proposal is never linked to a wheel.

The person's account must be on the ledger route (`YEET_ROUTE=ledger`, or listed in `YEET_LEDGER_ACCOUNTS`). Otherwise owner mode is refused with `OWNER_NOT_ON_LEDGER`.

## Interface (MCP tools on the agent host)

| Tool | What it does |
|---|---|
| `agent_overview` | Status: the registered key, the state (`not_registered`, `awaiting_budget`, `active`), the balance, the limits, the next step and `budget_url` while one is open. |
| `agent_how_it_works` | Text about keys, the budget, signing and the limits. Reads no account data. |
| `agent_register_key` | `{public_key, budget_usdc}`: registers the key for this OAuth client (one key per connection) and returns `budget_url` for the person (open for 24 h). |
| `agent_balance` | The agent's ledger balance: USDC and the listed coins. |
| `agent_quote` | `{side: buy\|sell, coins[], amount_usdc \| percent}`: a firm quote through the pipeline. Returns `quote_id`. |
| `agent_prepare_trade` | `{quote_id}`: applies the agent caps, then returns `request` with `message` (the unsigned `token_diff`), `request_id`, `gives`, `receives` and `sign_before`. |
| `agent_submit_signature` | `{request_id, signature}`: a base64 (or hex) 64-byte signature over the message's UTF-8 bytes, for a trade or a return. |
| `agent_trade_status` | `{trade_id}`: the trade's status and what it received. |
| `agent_positions` | USDC, the held coins with their USD value, the last 5 trades and what is left of today's limit. |
| `agent_return_budget` | The unsigned transfer of one token (USDC first) of the balance to the owner's ledger account. `remaining_tokens` says whether to call it again. |

`account` selector (owner account mode). `agent_quote`, `agent_prepare_trade`, `agent_submit_signature`, `agent_trade_status`, `agent_balance` and `agent_positions` take an optional `account: "agent" | "owner"`. The default `"agent"` is the route as described above. `agent_return_budget` takes it only to refuse `"owner"`. No tool takes an account id: the account is always the token's subject. Any other value fails the tool's schema, and core refuses it with `INVALID_ARGUMENT`.

| Tool with `account: "owner"` | Input | Answer (fields added or changed) |
|---|---|---|
| `agent_quote` | `{side, coins[], amount_usdc \| percent, account:"owner"}` | `{account:"owner", quote_id, revision, side, amount_usdc, legs[], cost_pct, quoted_at, warnings, next}` |
| `agent_prepare_trade` | `{quote_id, revision?, account:"owner"}` | `{account:"owner", trade_id, status, request:{request_id, standard:"raw_ed25519", message, message_base64, public_key:"ed25519:<person's wallet>", signer_id:<person's ledger account>, deadline, sign_before, gives, receives, how}}` |
| `agent_submit_signature` | `{request_id, signature, account:"owner"}`, the 64-byte signature by the person's wallet, base64 or hex | `{account:"owner", request_id, kind:"trade", trade_id, status, trade?, renewed?}` |
| `agent_trade_status` | `{trade_id, account:"owner"}` | `{account:"owner", trade_id, status, direction, received[], legs[], updated_at}`: any trade of the person |
| `agent_balance` | `{account:"owner"}` | `{account:"owner", ledger_account, usdc, coins[]}` |
| `agent_positions` | `{account:"owner"}` | `{account:"owner", ledger_account, usdc, holdings[], total_usd, recent_trades[] (the person's last 5, each with via_agent), limits}` |
| `agent_overview` | (none) | With the mode on, it also returns `owner_account:{available, ledger_account, limits, how}`. With it off, the answer is unchanged. |

Core takes `account` in the POST bodies, plus new `POST /agent/balance` and `POST /agent/positions` (core refuses query strings). The connector sends a GET as before when `account` is not given.

Every refusal is `{error, message, retryable}`, where `message` is a sentence a model can relay. Codes the route adds:

- `WRONG_ROUTE`
- `AGENT_NOT_REGISTERED`
- `AGENT_NOT_FUNDED`
- `AGENT_KEY_INVALID`
- `AGENT_KEY_TAKEN`
- `AGENT_KEY_LINKED`
- `QUOTE_NOT_FOUND`
- `REQUOTE_REQUIRED`
- `REQUEST_EXPIRED`
- `REQUEST_CLOSED`
- `SIGNATURE_INVALID`
- `NOTHING_TO_RETURN`
- `OWNER_ACCOUNT_OFF` (owner mode is switched off)
- `OWNER_NOT_ON_LEDGER` (the person's account is not on the ledger route)
- `OWNER_TRADES_ONLY` (a transfer, return or non-trade message on the person's account)
- `REQUEST_USED` (an owner-mode request was already submitted)

These tools and their texts live in this private repo only (`mcp/agent.mjs`). The public contract, the ChatGPT tool list, its lock and `x-yeet-tools-version` are unchanged, so no tools-version bump is needed.

Core routes (connector credential and the agent's delegated bearer): `GET /agent/{overview,balance,positions}` and `POST /agent/{status,register,quote,prepare,submit,return}`. The signing page reaches `POST /sign/trades/a_.../{requests,signature}` with the owner's page session.

## Route guards (both directions)

- **Client class.** Each OAuth client has a class, decided by its redirect URIs alone and never by User-Agent or IP. A client is `chatgpt` when every URI is one of ChatGPT's connector redirects (`as/security-policy.mjs chatgptRedirect`). It is `agent` when every URI is a loopback http callback (127.0.0.1, localhost, [::1]). A mixed list is refused at `/reg`, and so are https callbacks (a web site could pose as an agent and collect a code from a link), custom schemes and plain http off loopback.
- **OAuth step.** `getResourceServerInfo` refuses an agent client that asks for the ChatGPT resource, and a ChatGPT client that asks for the agent resource. The refusal is `invalid_target` with `error_description` = `WRONG_ROUTE: <sentence with the right URL>`. A client that names no resource gets the resource of its class.
- **Token.** Every access token carries `yeet_route` (`extraTokenClaims`, returned by introspection) and `aud`, the resource it was issued for.
- **MCP call.**
  - The ChatGPT endpoint answers an agent token with 403 and a JSON-RPC error: `data.error = WRONG_ROUTE`, `data.correct_url`.
  - The agent endpoint answers a ChatGPT token the same way.
  - The agent endpoint also requires `aud` = the agent resource.
  - Core refuses an agent token on every non-agent route, and a ChatGPT token on `/agent/*`, with 403 WRONG_ROUTE.
- **Host.** A request whose Host is the agent host reaches only the agent endpoint (PRM, `POST /`) and never the ChatGPT one. `/version` there is 404.

## Environment

| Name | Services | Default | Meaning |
|---|---|---|---|
| `YEET_AGENT_ROUTE` | as, core, mcp | off | `on` turns the route on. Any other value stops the service. |
| `AGENT_RESOURCE` | as, core, mcp | `https://mcp.yeet.win` | The agent endpoint's resource URL. It must be on its own host, and https in public mode. |
| `YEET_AGENT_MAX_TRADE_USDC` | core | 10 | The most one agent buy spends. Checked at quote and again at prepare. |
| `YEET_AGENT_MAX_DAY_USDC` | core | 50 | The most an agent buys per UTC day (the pipeline's own daily spend of the agent account). |
| `YEET_AGENT_MAX_BUDGET_USDC` | core | 100 | The largest budget one link asks for. |
| `YEET_AGENT_OWNER_ACCOUNT` | core | off | `on` allows `account: "owner"` (owner account mode). It needs `YEET_AGENT_ROUTE=on`. Any other value stops core. |

With the switch on, core needs the ledger route (`YEET_ROUTE=ledger` or `YEET_LEDGER_ACCOUNTS`, plus its solver settings), or it does not start. The allowed coins are the catalogue's Solana coins that the ledger holds. Sells are not capped and not counted, as on the ChatGPT route: they turn coins back into USDC inside the agent's own account.

## Deploy steps

1. **DNS.** In Cloudflare, add `mcp.yeet.win` to the same tunnel or origin as `chatgpt.yeet.win`, proxied.
2. **Caddy.** Add a host block next to `@yeet_conn` in `ops/Caddyfile.snippet`, with the same headers and without `form-action https://chatgpt.com`:
   ```
   @yeet_agent host mcp.yeet.win
   handle @yeet_agent {
   	@yeet_agent_protocol {
   		method POST
   		path /
   	}
   	handle @yeet_agent_protocol {
   		reverse_proxy 127.0.0.1:38861 { import cf_https_proto }
   	}
   	@yeet_agent_prm {
   		method GET HEAD
   		path /.well-known/oauth-protected-resource
   	}
   	handle @yeet_agent_prm {
   		reverse_proxy 127.0.0.1:38861 { import cf_https_proto }
   	}
   	respond 404
   }
   ```
   The connector reads the Host header, so Caddy must pass it through unchanged (the default). OAuth itself stays on the sign-in server's host: the agent PRM names `authorization_servers: [ISSUER]`.
3. **Env.** Set `YEET_AGENT_ROUTE=on` (and the caps, if they differ from the defaults) for the as, core and mcp services. `ops/compose.yml` passes them through. Restart all three.
4. **Smoke test.**
   - `curl https://mcp.yeet.win/.well-known/oauth-protected-resource` names `resource: https://mcp.yeet.win`.
   - `POST /` with no token returns 401 with `resource_metadata` on mcp.yeet.win.
   - Connect a local MCP client (for example `claude mcp add --transport http yeet https://mcp.yeet.win`), sign in, and call `agent_overview`.
5. **Roll back.** Unset `YEET_AGENT_ROUTE` and restart. Registered agent keys and their ledger balances stay where they are: the balances are the agents' own accounts, and an agent can still return its budget directly on the ledger with its key.

## Threat notes

- **The agent holds its key.** It can sign any intent for its own account and send it to `intents.near` itself, with its own NEAR account for gas. The server only limits what it relays: its caps and the return receiver bind the agent route, not the ledger. The real bound on what an agent can lose is the budget the person approved, which is why `YEET_AGENT_MAX_BUDGET_USDC` exists and the page shows the amount.
- **Phishing a budget.** Only the owner's own page session (Privy sign-in mapped to the same YEET account) sees a budget link (`pageRequests` checks the owner). The page shows the amount and "agent budget", and the wallet check (`wallet-request.mjs checkTransfer`) refuses any message that is not exactly one transfer of the stated token and amount to the stated receiver.
- **Token confusion.** The class comes from the redirect URIs, and the resource binding is enforced at authorization, token, introspection, connector and core. A token minted for one endpoint is refused by the other. A ChatGPT look-alike redirect host is class agent, never chatgpt.
- **One key per connection.** A key already linked to another connection is refused (`AGENT_KEY_TAKEN`). An active key cannot be swapped (`AGENT_KEY_LINKED`): the agent returns the budget first or connects as a new agent. The owner's own wallet key and the solver's key are refused as agent keys.
- **Replay.** Every message carries a fresh versioned nonce that ends with it. Trades keep the ledger route's attempt rules. A budget or return message is valid for 5 minutes and is simulated alone before it is sent.
- **Owner mode: Privy's grant is not scoped.** The device-flow approval gives the agent a Privy session that can sign ANY message with the person's Solana wallet. Privy does not limit it to YEET trades, so the agent could sign other things directly with Privy: for example a ledger `transfer` it sends to `intents.near` itself, or a Solana transaction. Our caps and checks bind only the trades sent through this route. They are no bound on what an agent with that grant can do elsewhere. The real bound is the person's trust in the agent and revoking the Privy grant. The approval page (branch feat/agent-verify) should say so to the person.
- **Owner mode: what this route enforces.**
  - The signature must verify (`raw_ed25519`, over the exact message bytes) against the token subject's own wallet key, read from the wallet directory at submit time. An agent key, another person's wallet, or other bytes are `SIGNATURE_INVALID`.
  - The account is always the token's subject: there is no parameter to name another one.
  - Quotes, trades and request ids are stored per person AND per agent connection (`agent_owner_quote`, `agent_owner_trade`), so another connection, another person or agent mode cannot use them.
  - The confirm code is minted for the client id `agent-owner:<client>`, so the ChatGPT route cannot execute an agent quote, and back.
  - The ChatGPT connector's `/trades/:id/signature` refuses an owner-mode trade (`INVALID_ARGUMENT`). The YEET signing page is not guarded: it is the person's own session, so the person can still approve the trade there.
  - A request id is single use: the first submission claims it (`agent_owner_request`). A replay, later or concurrent, is `REQUEST_USED`. A claim is given back only when the ledger attempt is still waiting (a refused signature), so a corrected signature can go through once.
  - Trades only: `agent_return_budget` and `a_` request ids are `OWNER_TRADES_ONLY`. At prepare and again at submit, the message must be exactly one `token_diff` with the person's ledger account as `signer_id`. A transfer, a withdrawal or an extra intent is refused even when the person signed it.
- **Disconnect.** The operator's per-client disconnect (`/policy`) cuts the agent's token. Its balance stays in its own account.

## Not done yet

- Owner mode: the Privy device-flow approval page and the agent's own Privy signing client are not in this branch. The tests use a locally generated key in place of the person's Privy wallet on the fake ledger. No live Privy `signMessage` signature over a ledger message has been checked against this route.
- Owner mode: the agent caps are checked in one process (a per-connection lock around check and execute). Two core processes would not share that lock.

- A budget paid with Base-credited USDC: a budget link asks for Solana USDC only.
- Live proof on mainnet, the Caddy and DNS change, and the deploy itself.

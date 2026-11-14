# YEET journeys: what the person says, which tool answers, which card shows

Owner direction (voice 39611, 2026-11-14): journeys first, few cards of our own, ChatGPT's own messages and
follow-ups carry the rest. The platform facts this relies on are in [APPS-SDK-FACTS.md](APPS-SDK-FACTS.md); the cards,
their views and states are in yeet-win `docs/CARDS.md`.

## Journey 0: connect, terms, win code, first trade on a device (rulings of 2026-11-13)

1. (This passage quotes ChatGPT-facing wording that is not part of this repository.)

Details and the reasons: docs/TERMS-IN-CHAT.md.

## The journeys

(This passage quotes ChatGPT-facing wording that is not part of this repository.)

Rules the model gets (server instructions and each result's `guidance`, `connector/mcp/instructions.mjs`,
`connector/mcp/guidance.mjs`):

- (This passage quotes ChatGPT-facing wording that is not part of this repository.)

## Adding money (ruling of 2026-11-14)

1. (This passage quotes ChatGPT-facing wording that is not part of this repository.)

No device step, no emailed code and nothing about trusted devices is part of adding money.

**Where the address comes from.** `GET /fund` in the core answers for the token's own account. It adds
`card_deposit`: that account's addresses from the engine's wallet directory (the record `/account/wallets` answers
the funding page's `/fund/api/check` from). The connector checks the block (`depositMeta`: one address per known
network, each fitting its network) and moves it to card-only `_meta["yeet/deposit"]`; a block that is not exactly
right is dropped whole. It is never in `structuredContent` or `content`.

**Which networks, and which first** (`funding.deposits()` in `connector/core/pipeline/funding.mjs`): only a network
whose USDC can pay a YEET. With `YEET_BUY_CHAIN` set, that network alone. Otherwise every network that is not paused
and whose driver is ready, Solana first: when both hold enough, the larger balance pays and a tie pays from Solana, so
USDC sent to the default address is what a new account's first buy spends. With nothing open, both, Solana first.

**No address where the model reads.** `yeet_home` answers `usdc` (one number) instead of `wallets`;
`yeet_portfolio` has no `address`. Tests: the contract walk and the fixture scan in yeet-win, the scan of every
model-visible result in `connector/core/xp/connector.test.mjs`, and `mcp/scripts/signing-meta-test.mjs` (a core
answer that still carried an address does not get past the connector).

## `yeet_overview`

`connector/core/overview.mjs`. Structured result: `username`; `usdc` (every network added up, one number; null when
nothing could be read); `xp`, `tier`, `streak_days`; `checkin_open`; `holdings_count`; `top_winner` (the held coin that
is up the most against the person's own average YEET price, `since: "buy"`, or null); `trading` (`live` | `paused`);
no device or sign-in state at all (nothing before a trade mentions it); `suggestions`
(`id`, `label`, `say`); `app_refresh` when the app is stale. No wallet and no network. The text block is one line with
the same facts and the follow-ups.

Suggestion order (`suggestionsFor`): no USDC puts "Fund my account" first; an open check-in comes next (first when
there is USDC); "Review your meme holdings" precedes "Discover a new coin to yeet" only when a coin is held; "See what
other people are yeeting" is last. A check-in already done today is left out. Without `YEET_P2=1` the check-in and the
board are left out.

## What the cards report to the chat

Each report is one chat message from the card (`window.openai.sendFollowUpMessage`, else `ui/message`) and a model
context update (`ui/update-model-context`; widget state `modelContent`), once per event:

| Event | Message | Example |
|---|---|---|
| Daily spin landed | yes | `YEET card: Daily check-in done. The wheel landed on PENGU: 37 XP and a PENGU stamp, 6 of 7 on their PENGU card. Streak: 7 days; 1 extra spin earned and waiting (streak milestone); 1,277 XP in all.` |
| Trade refused or stopped | yes | `YEET card: The trade was stopped before anything was sent, because the swap cost had risen above the YEET limit. Nothing left their wallet.` |
| Trade finished | yes | `YEET card: The YEET landed: they got 4.4 WIF and 2,681 BOME. They earned 20 XP.` |
| USDC arrived (Add funds card, either view) | yes | `YEET card: $25.00 of USDC arrived in their YEET account. They now have $28.20 to YEET with.` |
| Device sign-in, lucky wheel landed, stale card | context only | |

(This passage quotes ChatGPT-facing wording that is not part of this repository.)

The card keeps its own short message for every refusal. Not enough USDC for a basket: the YEET button is shut and the
reason stands under it.

## Leaderboards

`connector/core/xp/boards.mjs` over `connector/core/trade/pnl.mjs`.

| Board | Ranks by | Windows |
|---|---|---|
| `xp` (`week` = `xp` over `7d`) | XP earned | `all`, `7d`, `today` |
| `winners` | USDC made on SKEETs | `today`, `7d` |
| `best_trade` | Biggest percent win on one SKEET (with its coin) | `today`, `7d` |
| `losers` | USDC lost on SKEETs | `today`, `7d` |
| `coins` | USDC yeeted into each coin, and how many people | `today`, `7d` |

How a win or loss is measured, stated in every answer (`measure`) and printed on the card: **realised on SKEETs
against the average YEET cost of the coins sold**. Only settled legs count (1Click status SUCCESS). A settled YEET
adds coins at its USDC cost; a settled SKEET's result is the USDC received minus the average cost of the coins sold.
Coins that did not come from a YEET on the account have no known cost and are left out of a sale. Coins still held are
not counted: no price history is stored, so a mark-to-market board would have to invent a starting price. `today` is
the UTC day (the day the daily spin uses); `7d` is the last 7 x 24 hours. Equal results share a rank.

## A stale YEET app in ChatGPT

(This passage quotes ChatGPT-facing wording that is not part of this repository.)

| Seen where | How | What happens |
|---|---|---|
| Server (`connector/mcp/refresh.mjs`) | A card's tool call carries `card_build` other than the vendored pin | The conversation (account + `_meta["openai/session"]`) is marked; the next result the model reads leads with the refresh guidance, once; `yeet_overview` also carries `app_refresh`. |
| Server | A card-only tool is called with no `card_build` (a card from before build ids) | The same. |
| Card | A result's `_meta["yeet/build"]` differs from the card's own build | The card shows "YEET was updated. Refresh YEET in ChatGPT" (the link opens through the host) and reports it to the model context once. |
| Card | The host answers that a tool the card calls is unknown (a stale tool list) | The same. |

Not detectable from the server: the tool list ChatGPT holds. A call for a tool or an argument the server no longer has
is refused by the protocol layer before any YEET code runs. `tools-4` removed result fields (`yeet_home.wallets`, the `address` fields of `yeet_portfolio`) and added an optional argument (`yeet_fund.method`); the tools version check below is what tells an older list to refresh. A new tool that
the client side does not have yet cannot be seen at all; the cards' own checks cover the cases where a card is on
screen.

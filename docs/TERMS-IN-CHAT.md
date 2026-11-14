# Terms in the chat, one-screen connect, the win code and the device check

Owner rulings of 2026-11-13, in the order they landed. Later ones replace earlier ones where they differ.

## 1. Connecting is one screen

The web part of connecting YEET to ChatGPT is the sign-in and nothing else: "Sign in to connect YEET to ChatGPT",
Continue with Google, Continue with Apple, then email with a code (in that order; each button appears only when the
method is on for the Privy app, so Apple shows up by itself once it is switched on), and one small line with the links
to the Terms and the Privacy Policy. After the sign-in the browser goes straight back to ChatGPT.

What made that possible, and what guards it (`connector/as/consent-selection.mjs`, `connector/as/as.mjs`):

- The separate connect page is skipped only when the client is ChatGPT (its redirect URI is one of ChatGPT's connector
  redirects, `security-policy.mjs chatgptRedirect`) AND the person signed in on our page inside this very authorization.
  That sign-in is recorded per authorization request (client id and PKCE challenge), kept for 10 minutes and used once.
- A browser that is already signed in, a restart in between, or any other client gets the connect page: who is
  connecting, one sentence, the session length, the two links, Connect and Cancel. One deliberate press exists on our
  page for every authorization; a token is never issued with no interaction.
- PKCE, state, redirect checks and the granted scopes are unchanged. Only advertised or still-accepted scope names
  are granted.
- ChatGPT stays connected for the refresh window (`REFRESH_FAMILY_TTL`, up to 7 days). This used to be a checkbox; it
  is now always on for ChatGPT's client and the connect page says it in one line.

What each removed screen did, and where that lives now:

| Removed from the connect path | Where it is now |
|---|---|
| "ChatGPT will be able to" list, the 50 USDC a day box, "only when you tap YEET" | Gone. They described a server-held signer that no longer exists. The connect page says one true sentence. |
| Details (account id, client URL, server, raw scope names) | Gone from every page. |
| Checkbox: a YEET wallet created and secured by Privy | Terms statement `wallet` |
| Checkbox: I allow ChatGPT to use YEET for me | The sign-in (or the Connect press) is that permission; ChatGPT's own connect step asks too |
| Checkbox: trades are routed through NEAR Intents | Terms statement `interface` (since 2026-11-15; `near_intents` before) |
| Checkbox: Terms of Service / Privacy Policy | Terms statements `terms` and `privacy` |
| Checkbox: product emails (optional) | Terms statement `product_email` (optional, never ticked for the person) |
| Checkbox: stay connected for up to 7 days | Always on for ChatGPT; one line on the connect page |
| Referral code screen (WIN prefilled, Let's win, Skip) | The win code card: `yeet_referral` and the card-only `apply_referral` |
| Wallet set-up progress screen, "You are signed in… Continue to YEET" | One status line while the server creates the wallets, then the redirect. A browser that is already signed in shows one button, "Continue as <email>". |
| Username | Was never on the connect path: the account page and `yeet_set_username` keep it. |

## 2. The terms are accepted in the chat

`connector/core/terms.mjs` holds the version (`TERMS_VERSION`, now `2026-11-15`) and the statements. Edit them there.
The structure is Folio's consent flow (chaintail/stock-app `origin/main`: `apps/server/src/consent.ts`,
`apps/android/app/src/main/java/io/tryfolio/android/ui/consent/ConsentText.kt` and `ConsentScreen.kt`,
`apps/android/app/src/main/java/io/tryfolio/android/data/ConsentGate.kt`): one version constant, a list of lines each
with the link to the document it refers to, the ids enforced by the server, the first acceptance of a version stands,
a new version is a new acceptance, the money routes answer a typed refusal until then, one optional product-email line.

| id | Statement | Link | Required |
|---|---|---|---|
| `risk` | You understand meme coin trading is extremely risky, meme coins can go to zero, and you will never trade more than you are willing to lose. | https://yeet.win/terms#section-7 | yes |
| `eligibility` | I am at least 18. I am legally allowed to use these protocols where I live and I am not in a sanctioned region. | https://yeet.win/terms#section-2a | yes |
| `wallet` | You agree to a YEET wallet created and secured by Privy, which you control, together with any agent you authorize. | https://privy.io/user-terms-of-service | yes |
| `interface` | I understand YEET is an interface. My trades run on third-party protocols and services (NEAR Intents, 1Click, the PoA bridge, Privy, Solana, Base, NEAR) that YEET does not control. | https://yeet.win/terms#section-1a | yes |
| `no_advice` | You understand nothing in YEET or from ChatGPT is financial advice. | https://yeet.win/terms#section-4 | yes |
| `xp` | I understand XP has no monetary value. | https://yeet.win/terms#section-10a | yes |
| `terms` | You agree to the YEET Terms and Conditions. | https://yeet.win/terms | yes |
| `privacy` | You agree to the YEET Privacy Policy. | https://yeet.win/privacy | yes |
| `product_email` | Send me YEET product emails. | https://yeet.win/privacy#section-3 | no |

Every anchor exists in the landing pages (`apps/landing/terms/index.html` and `privacy/index.html` carry `id="section-N"`
on every heading); `core/terms.test.mjs` checks them when the yeet-win checkout is next to this repository.

The flow:

1. (This passage quotes ChatGPT-facing wording that is not part of this repository.)

(This passage quotes ChatGPT-facing wording that is not part of this repository.)

`TERMS_REQUIRED` is sent as an error result (the tools' output schemas are closed objects, and an error result is the
only shape every tool can return without loosening them): `isError`, the JSON text (error, message, terms, missing
ids, guidance) and no `structuredContent`, which an MCP client checks against the tool's success-only output schema.
A card reads the text; where the host hands it only `window.openai.toolOutput`, it reads the card-only
`_meta["yeet/failure"]` (error, message, `terms.mode`, `terms.page_url`). The cards draw their one line for it, never
an error card.

### The fallback page and the one switch

`/account/terms` on the sign-in server (`connector/as/terms-page.mjs`) shows the same statements as checkboxes, each
with its link, the required ones gating one Accept button, and records the same acceptance (source `page`).
`YEET_TERMS_MODE=page` (core setting, default `chat`) switches the guidance and the cards from "accept in the chat" to
"open this page": the `terms` object then says `mode: "page"`, the model gives the person `page_url`, and the cards
open it through the host. The page works in either mode.

### What is recorded, and the honest limit

Table `terms_acceptances` in `identities.sqlite` (`connector/core/terms-store.mjs`), one row per account and version,
first acceptance stands: account id, version, the statement ids the person confirmed, the time, the source (`chat` or
`page`), the OAuth client the call came through, and ChatGPT's anonymized conversation id (`_meta["openai/session"]`)
when ChatGPT sent one. The core also logs `terms_accepted` (and `terms_refused`) with the same fields.

An acceptance from the chat is recorded from a model tool call: the person agreed in the conversation, ChatGPT asked
them to approve the action (see docs/APPS-SDK-FACTS.md section 6), and the model then called the tool. YEET never sees
the person's own words or the approval. That is weaker evidence than a checkbox ticked on our own page, where the
browser posts the person's own input to our server. If that matters for a dispute, switch to `YEET_TERMS_MODE=page`.

Accounts that passed the old connect-page checkboxes are not mapped to the current version (their old record held a
product-email choice and a referral code, not which statements they saw): they are asked like everyone else.

Not gated: the sign-in server's own pages (account, funding, the trade page of a trade that already exists) and the
operator's trade tools. A trade already in flight when the version changes meets the gate on its next card call.

## 3. The scope is named for what it does

`yeet:trade` read as if ChatGPT could trade for the person. The scope is now `yeet:prepare` ("Prepare trades for you
to confirm yourself"). Places the name appears: discovery (`scopes_supported` of the sign-in server), the
protected-resource metadata, every tool's `securitySchemes`, the re-authorization challenge, the contract
(`x-yeet-scopes`, the two tools that need it) in both repositories, and `scope-catalog.mjs`. None of them names the old
scope any more. A token, grant or refresh token that carries `yeet:trade` keeps working and counts as `yeet:prepare`
wherever a scope is checked; a client that still asks for `yeet:trade` is granted it under that name. Nobody is forced
to connect again by the server. OpenAI's auth page does not say whether ChatGPT shows scope names or descriptions to
the person ("helps ChatGPT explain the permissions"), so the name itself is now true.

## 4. The win code is a card

`yeet_referral` shows a small card: one input that starts with `WIN`, Apply and Skip. The overview offers it once, as
its first suggestion ("Got a win code?"), after the terms are accepted. The card applies the code through the
card-only `apply_referral` and reports to the model. The rule for a code is the old screen's (1 to 16 letters or
digits, case folded; the card's field takes 6). One code per account, and it stands; a skip is remembered and never
asked again, but the person can still type a code later. Table `referrals` in `identities.sqlite`. There is still no
referral programme behind the code: it is stored.

## 5 to 7. The device check and the sign-in methods

These sections are not part of this repository.

## Version 2026-11-14 (owner asks of 2026-11-14)

- The risk statement comes first, as the risk line now opens the terms page (yeet-win `apps/landing/terms`).
- A new required statement, `xp`, in the owner's words: "I understand XP has no monetary value.", linked to terms
  section 10A (XP has no current value, it only tracks long-term experience, limits rise with XP to protect new users).
- New terms sections: 5A (YEET does not control your funds; Privy embedded non-custodial wallet; do not deposit large
  sums; key export at https://home.privy.io/), 7A (beta, code not audited, zero guarantees), 10A (XP).
- "*winning is not guaranteed." under the statements on `/account/terms`, on every card about winning, on the landing
  pages and in the server instructions.
- Raising the version asks every account again through the normal flow (`TERMS_REQUIRED`); there is no code for
  accounts that accepted `2026-11-13`.
- `core/terms.test.mjs` checks the anchors against `YEET_WIN_DIR` (default the sibling `yeet-win-wt-int`); a checkout
  whose terms page carries another `data-terms-version` is skipped.

## Version 2026-11-15 (owner asks of 2026-11-15)

- Terms (yeet-win `apps/landing/terms`): 1A "YEET is an interface" (what YEET provides: the interface, routing,
  submission, access limits, network fees it may pay, one solver; everything else is run by others); 2A "Your
  responsibility and eligibility" (legally allowed where you live, sanctions, taxes); 5A gains the custody caveat for
  funds in `intents.near` or the PoA bridge and drops "has no way into it"; 5B "AI agents"; 6 and 6A: external solvers
  are independent, Chaintail Labs Inc. operates one solver (counterparty for ledger trades, no margin today, a potential
  conflict of interest); 9 "Third-party services and protocols" lists each service the code uses (OpenAI ChatGPT,
  Privy, `intents.near`, the 1Click API, the PoA bridge, the Omni Bridge, solvers, the Solana, Base and NEAR networks and
  their RPC providers, Jupiter and GeckoTerminal, Stripe and Coinbase Onramp for card funding, Cloudflare); 9A "No
  affiliation"; 10A one factual sentence on wheel prizes. Privacy: the waitlist line, the country used for the regional
  restrictions.
- Statements: `interface` replaces `near_intents`; `eligibility` replaces `age` (it keeps the age). Still eight
  required lines and the optional product emails.
- Raising the version asks every account again through the normal flow (`TERMS_REQUIRED`); no code for accounts that
  accepted `2026-11-14`. No tool schema changed, so the tools version stays `tools-8`.
- Vendoring: the yeet-win change (branch `feat/terms-interface`, 2efddd9) touches only `apps/landing/terms` and
  `apps/landing/privacy`, which `scripts/vendor-yeet-win.sh` does not archive. Re-vendoring would only move the card
  build stamp off e2225ad and send every ChatGPT client a refresh notice for identical cards, so `vendor/yeet-win`
  stays at e2225ad. The yeet-win commit must reach yeet-win `main` before this deploy, so yeet.win serves the
  2026-11-15 page that the statements link to (`#section-1a`, `#section-2a`).

## The sanctions geoblock (`YEET_GEOBLOCK`)

`connector/shared/region.mjs`, ported from Folio's region gate (chaintail/stock-app `apps/server/src/region.ts`,
`regionVersion` 2026-10-07): its `app_blocked` list (`CU`, `IR`, `KP`, `SY`), its reading of Cloudflare's
`CF-IPCountry` (two letters; `XX`, `T1` and anything else is no country; no country is never blocked) and its answer
(HTTP 451, `REGION_BLOCKED`).

- `YEET_GEOBLOCK=on` turns it on (as and mcp); unset, empty or `off` is off (the default); any other value stops the
  service. `YEET_GEOBLOCK_COUNTRIES` replaces the list (comma list of two-letter codes; a bad entry stops the service).
- The header is read only with `TRUST_PROXY=1`, the same switch that makes the sign-in server trust the proxy. `on`
  without it stops the service. `ops/compose.yml` now passes `TRUST_PROXY` to mcp as well.
- Sign-in server (`as/region-page.mjs`): `/account/login`, `/account/email-step`, `/account/wallets`, `/interaction/*`,
  `/approve` (and `/agent/approve`), `/sign`, `/sign/api/*`, `/fund`, `/fund/api/*` answer 451: the page "Not available
  in your region", or `{error: "REGION_BLOCKED", country}` for the JSON calls. `/account/terms`, sign-out, static
  files and the OAuth endpoints stay open.
- MCP, both hosts (`mcp/mcp.mjs`): before core is asked, `yeet_propose`, `skeet_propose`, `yeet_quote`,
  `execute_trade`, `submit_trade_signature`, `agent_register_key`, `agent_quote`, `agent_prepare_trade` and
  `agent_submit_signature` (not a budget return, `a_...`) answer the private code `REGION_BLOCKED`
  (`contracts/errors.mjs` `PRIVATE_ERRORS`, guidance in `mcp/guidance.mjs`). Reads answer as before. tools/list is
  the same from any country.
- Each refusal logs `region_blocked` with the country and the path or route.
- Tests: `test/region.test.mjs` (ports 38940 to 38943).

## yeet_how_it_works

Read-only, `yeet:read`, no card, no parameters; open before the terms are accepted (core `GET /how-it-works`, in
`TERMS_OPEN`). Registered only with `YEET_HOW_IT_WORKS=1` (default off, `mcp/tool-registration.mjs` `OPT_IN`). The
shape is the public contract's `$defs.how_it_works`; the words are `connector/core/how-it-works.mjs` only.

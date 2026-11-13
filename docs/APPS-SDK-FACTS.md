# Apps SDK facts YEET relies on

Read from OpenAI's Apps SDK documentation on 2026-11-13 (pages fetched that day; each fact names its page). The
Apps SDK pages point to the MCP Apps specification for the bridge methods; where a payload shape comes from that
specification it is marked "spec". Anything the pages do not state is in the last section and is not relied on.

Pages:

- [R] https://developers.openai.com/apps-sdk/reference
- [UI] https://developers.openai.com/apps-sdk/build/chatgpt-ui (the same text is served at /build/custom-ux)
- [ST] https://developers.openai.com/apps-sdk/build/state-management
- [AU] https://developers.openai.com/apps-sdk/build/auth
- [MA] https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt
- [UG] https://developers.openai.com/apps-sdk/concepts/ui-guidelines
- [MS] https://developers.openai.com/apps-sdk/build/mcp-server
- [OM] https://developers.openai.com/apps-sdk/guides/optimize-metadata
- [CC] https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- [spec] https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx

## 1. A card sends a message into the conversation

- `ui/message` (bridge) and `window.openai.sendFollowUpMessage` (ChatGPT alias) are the same capability [MA], [UI].
- `sendFollowUpMessage({ prompt, scrollToBottom })`: "Posts a component-authored message to the chat";
  `scrollToBottom` defaults to `true` [R].
- spec: `ui/message` params are `role: "user"` and `content: { type: "text", text }`; the host "SHOULD add the message
  to the conversation context, preserving the specified role", "MAY request user consent", and a follow-up by the model
  is the described path.
- Used for: the card's reports that ChatGPT should answer right away (a trade refused or failed, a trade finished,
  the daily spin result, USDC arrived). One message per event, prefixed `YEET card:`.

## 2. A card updates what the model knows without a message

- `ui/update-model-context` is "the portable MCP Apps mechanism for updating model-visible context"; use it when the
  model needs to know about a selection or a staged edit [UI], [ST], [MA]. No `window.openai` alias is listed [R].
- spec: params `content?: ContentBlock[]`, `structuredContent?`; "Each request overwrites the previous context sent by
  the View"; the host "SHOULD provide the context to the model in future turns" and "MAY defer sending the context to
  the model until the next user message (including `ui/message`)".
- `window.openai.setWidgetState(state)` is synchronous and scoped to one rendered card ("Widget state belongs to one
  rendered UI instance", not durable storage). Its structured shape has `modelContent` ("Text or JSON the model should
  see"), `privateContent` ("UI-only state the model should not see") and `imageIds` [UI], [ST].
- Used for: every card report also lands in the model context (the last six events, because a request overwrites the
  previous one), and `modelContent` carries the same text for hosts that read widget state. Sign-in on the device is
  reported this way only (no message).

## 3. A card calls a tool itself; card-only tools

- `tools/call` (bridge) and `window.openai.callTool(name, args)` [R], [MA], [UI].
- `_meta.ui.visibility` (default `["model", "app"]`) "Controls whether the model, the UI, or both can call the tool";
  `_meta["openai/widgetAccessible"]` (default `false`) and `_meta["openai/visibility"]` (`public` | `private`) are the
  compatibility fields [R]. spec: the host "MUST reject `tools/call` requests from apps for tools that don't include
  `"app"` in visibility".
- Used for: `execute_trade`, `submit_trade_signature`, `daily_spin`, `lucky_spin` are card-only
  (`ui.visibility: ["app"]`, `openai/visibility: private`, `openai/widgetAccessible: true`); every tool a card calls
  has `"app"` in its visibility.

## 4. Display modes

- Inline card, inline carousel, fullscreen, picture-in-picture [UG], [UI]. `window.openai.requestDisplayMode` "Requests
  picture-in-picture or fullscreen presentation" (example `{ mode: "fullscreen" }`) [R]; resources declare
  `_meta["openai/ui"].availableDisplayModes` [R].
- Fullscreen: "The ChatGPT composer remains overlaid, allowing users to continue 'talking to the app' through natural
  conversation"; "Design your UX to work with the system composer" [UG], [UI].
- Inline card rules: "Support up to two actions maximum, with one primary CTA and one optional secondary CTA", "No deep
  navigation or multiple views within a card", "No nested scrolling", "No duplicate inputs" [UG].
- Used for: every YEET card stays inline (`availableDisplayModes: ["inline"]`). A fullscreen basket with the composer
  over it is possible by the documentation and is not built.

## 5. Suggested follow-ups

- The follow-up after a card is a "model-generated response shown after the widget to suggest edits, next steps, or
  related actions"; "Avoid content that is redundant with the card" [UG]. No tool or resource metadata that produces or
  shapes suggestion buttons is documented [R], [OM], [MS].
- Used for: `yeet_overview` returns `suggestions` (label and the sentence the person would say) in `structuredContent`
  and its `guidance` tells the model to offer them in order. Whether ChatGPT renders them as buttons is the model's
  and the host's choice.

## 6. Tool annotations and `_meta`

- Annotations: `readOnlyHint`, `destructiveHint`, `openWorldHint` (required), `idempotentHint` (optional). They "help
  ChatGPT and Codex choose appropriate confirmation and safety behavior"; `destructiveHint: true` makes the host ask
  for approval first; servers still enforce their own authorization [R], [MS], [OM].
- `_meta["openai/outputTemplate"]` is the ChatGPT alias of `_meta.ui.resourceUri` [R].
- `_meta["openai/toolInvocation/invoking"]` and `.../invoked`: status text while the tool runs and after, at most 64
  characters each [R]. Not set by YEET yet.
- `_meta["securitySchemes"]` on a tool is the back-compat mirror; each tool declares `noauth` and/or `oauth2` with
  scopes [R], [AU]. YEET declares `oauth2` with one scope on every tool.
- Descriptions decide when a tool is called: "Use this when…", state the disallowed cases; server `instructions` can
  set sequencing [OM], [MS]. `yeet_overview`'s description names "How do I win?", "@yeet" and a returning person.
- Result: `structuredContent` and `content` reach the model and the card; `_meta` reaches the card only [R], [MS].
  The confirm code, the signer location and the server's card build ride in `_meta`.
- Client `_meta` on tool calls: `openai/locale`, `openai/userAgent`, `openai/userLocation`, `openai/subject`
  (anonymized user id), `openai/session` (anonymized conversation id) [R]. YEET keys "tell the person once per
  conversation" on `openai/session`.

### 6a. When ChatGPT asks the person to approve a tool call (read again 2026-11-13)

- [R] https://developers.openai.com/apps-sdk/reference: `readOnlyHint`: "Signal that the tool only retrieves or computes
  information"; `destructiveHint`: "Declare that the tool may delete or overwrite user data so the host knows to elicit
  explicit approval first."; "These hints only influence how ChatGPT or Codex frames the tool call to the user";
  "ChatGPT does not load approval-gated arguments into widget values before approval".
- [MS] https://developers.openai.com/apps-sdk/build/mcp-server: "`destructiveHint`: `true` when a tool can cause
  irreversible or difficult to reverse outcomes."; "Annotations help ChatGPT and Codex choose appropriate confirmation
  and safety behavior."; "Require confirmation for consequential write actions."
- The only trigger for the host's own approval step that the pages name is `destructiveHint: true`. A tool that is
  merely not read-only is not said to be approval-gated.
- Used for: `yeet_accept_terms` is `readOnlyHint: false, destructiveHint: true, idempotentHint: true,
  openWorldHint: false`. The record it writes stands once written (first acceptance of a version), which is the
  "difficult to reverse" case. What the approval looks like, and whether it appears on every call, is the host's
  choice and only shows in ChatGPT.
- A tool's card template is part of the tool's descriptor (`_meta["openai/outputTemplate"]`), so a tool cannot
  return a result without its card conditionally. Used for: `yeet_overview` has no template at all, and the device
  step has its own tool (`yeet_unlock`) and otherwise lives inside the trade card.
- Scopes [AU] https://developers.openai.com/apps-sdk/build/auth: `scopes_supported` "helps ChatGPT explain the
  permissions it is going to ask the user for"; the page does not say whether the person sees scope names or
  descriptions, nor what ChatGPT does when a stored token lacks a scope a tool now names in `securitySchemes` beyond
  "rely on the `WWW-Authenticate` challenge to prompt ChatGPT to re-authorize". Used for: the scope is named
  `yeet:prepare`, and the server accepts the old `yeet:trade` so it never sends that challenge to an existing
  connection.
- ChatGPT's client [AU]: the stable client id `https://chatgpt.com/oauth/client.json` and redirect
  `https://chatgpt.com/connector_platform_oauth_redirect`, or `https://chatgpt.com/connector/oauth/{callback_id}`.
  Used for: the one-screen connect applies only to a client whose redirect is one of these.

## 7. Identity; browser storage

- After OAuth linking ChatGPT sends `Authorization: Bearer <token>` on every MCP request; the server verifies issuer,
  audience, expiry and scopes on each call. The flow launches "When the user first invokes a tool"; an error result with
  `_meta["mcp/www_authenticate"]` triggers (re)linking [AU], [R]. YEET identifies the person by that token only.
- Browser storage in a card: "Avoid `localStorage` for core state"; "UI runs in an isolated iframe, and browser storage
  does not provide a reliable cross-device or cross-session data layer" [UI], [ST].
- Used for: the device sign-in (the Privy session the card's signer keeps in the card origin's `localStorage`) is
  never assumed. Every card that needs it checks, the overview card shows the sign-in when it is missing, and the
  server answers `needs_card_sign_in: "unknown"`.

## 8. Refreshing the app after a deploy

- [CC]: "Deploy or restart the MCP server." "Open the connection at ChatGPT Plugins" (https://chatgpt.com/plugins).
  "Select **Refresh**." "Confirm that the advertised metadata changed." "Start a new conversation and rerun the affected
  tests." "This refresh flow applies to custom MCP servers connected directly in ChatGPT."
- Adding: "Select the plus button, then **Add custom MCP server**", then "**Create as a plugin**" [CC].
- Used for: the one constant `x-yeet-app.manage_url` in the contract and the steps "open YEET there, select Refresh,
  start a new chat".

## Not stated by the pages (not relied on)

- Whether a message sent with `sendFollowUpMessage` is shown as the person's own message bubble.
- Whether a tool result fetched by a card (`callTool`) is added to what the model reads, or draws a second card. YEET
  assumes neither: card-fetched results are reported to the model through sections 1 and 2.
- When exactly ChatGPT hands `ui/update-model-context` content or `modelContent` to the model.
- Behaviour of fullscreen and picture-in-picture on mobile.
- Whether a card's `localStorage` is shared between cards of one app and kept between sessions on a device (the pages
  only say it is not reliable).
- How long ChatGPT keeps a tool list or a card template, and whether a stale client can be told from the server. The
  server never sees the client's cached tool list.
- A deep link to one app's own settings page: only https://chatgpt.com/plugins is documented.

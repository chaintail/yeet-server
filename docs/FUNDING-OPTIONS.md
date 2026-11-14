# Funding options on the Add funds page

What the page does now, what Apple Pay and Google Pay need, and what a white-label card flow would take.

## Where a person starts

In ChatGPT the Add funds card comes first (docs/JOURNEYS.md "Adding money"). Sending USDC is done from the card itself:
it shows the person's YEET deposit address with Copy and a QR code. The card's "Pay by card" button opens the page
described here.

## What the page offers

1. **Send USDC** to the person's own YEET wallet on Base or Solana (address, QR code, wallet links, live balance). Unchanged, and first.
2. **Pay with card or Apple Pay.** Opens Privy's deposit modal on our page. Stripe is the preferred provider. USDC arrives on the network selected on the page (Base or Solana).
3. **Pay with Coinbase.** The earlier flow: Privy opens Coinbase in its own window. USDC arrives on Base.

Both card buttons use the dollar amount typed on the page.

## Apple Pay and Google Pay

- They come from **Stripe**, inside Privy's deposit modal. Privy's docs: "Supported payment methods include credit, debit, Apple Pay, Google Pay, and ACH (US only)... Available in the US (excluding New York) and the EU."
  Source: https://docs.privy.io/wallets/funding/use-deposit-funds.md (section "Stripe Embedded Components onramp").
- The person also needs a device and browser that support the wallet: Apple Pay in Safari on an iPhone with a card in Wallet, Google Pay in Chrome on Android. Stripe shows each button only "when the device supports it".
  Source: https://docs.stripe.com/crypto/onramp/embedded-components-integration-guide.md?platform=web
- The person signs in to Stripe's Link with a phone number and passes Stripe's identity check on the first purchase. Privy's test notes ask for "a US or EU phone number".
- **A person outside the US and the EU gets no Stripe option.** Privy then shows another provider's quote, or none. From Vietnam, expect no Apple Pay button. The Coinbase button stays as the second route.

### What to switch on in the Privy dashboard

Funding page: https://dashboard.privy.io/apps?page=funding

- **Card onramps: on.** This is the one switch Apple Pay and Google Pay need. With it on, Privy enables Stripe (USD, EUR) and MoonPay (AUD, BRL) by default.
- Meld (more currencies) needs a business check with Meld. Not needed for Apple Pay.
- Bank transfer, Exchange and Crypto deposits are separate switches. The page does not use them.

Source: https://docs.privy.io/financial-flows/deposits/configuration.md

### What changed in the code

- The page calls `useDepositFunds().depositFunds()` with `fiat.preferredProvider: 'stripe'`. The earlier call, `useFundWallet`, never shows Stripe (Privy's own note in the 3.51.4 package).
- `@privy-io/react-auth` went from 3.47.0 to 3.51.4, because `preferredProvider` on this call starts there. `@stripe/crypto` was already installed as part of the Privy package.
- The page's security policy now lets Stripe's scripts and frames load. Before, the browser blocked them, so the Stripe flow could not start on our page at all.

## Why card payment does not run inside the inline ChatGPT card

The inline card is a small frame that ChatGPT owns, on ChatGPT's own sandbox address. Card payment needs three things that frame does not give us:

1. **The Privy session.** The person is signed in on our address (the sign-in pages), not inside ChatGPT's frame.
2. **Stripe's and Coinbase's own scripts, frames and windows.** ChatGPT decides what a card may load and whether it may open windows.
3. **Permission for wallet payments.** A browser shows Apple Pay or Google Pay inside a frame only when every page around that frame allows it. ChatGPT is the page around the card; we cannot grant that from our side. Both wallets also need a real tap on their own button; code cannot start them.
   Source: https://docs.cdp.coinbase.com/onramp/headless-onramp/overview.md ("require that a payment session be created by a user gesture")

The opened page (the sheet ChatGPT shows when the person taps Add funds) is a normal page on our address, so all three hold. That is where Apple Pay can appear.

## Can the card flow be white label?

- **With Privy on the web: no.** The web kit only offers the Privy modal. Privy's fully embedded Stripe recipe says: "This integration is only available in the React Native SDK. For React support, use the deposit modal."
  Source: https://docs.privy.io/recipes/stripe-embedded-onramp.md
  We can set the modal's logo, theme and accent colour. We already do.
- **Stripe directly: yes, with our own Stripe account.** Stripe's Embedded Components onramp lets our page own the whole screen; Stripe only draws the card form and the wallet buttons. It needs a Stripe account, an approved onramp application, and server code for sessions. Same regions: US (not New York) and EU.
  Source: https://docs.stripe.com/crypto/onramp/embedded-components-overview.md
- **Coinbase Headless Onramp: yes, US only.** Coinbase gives a payment link that we show in our own frame; it draws only an Apple Pay or Google Pay button. It needs:
  - a Coinbase Developer Platform account and an approved Onramp application;
  - our domain on the Onramp allowlist, plus a verification file hosted on the domain;
  - a domain that is not registered with any other Apple merchant;
  - US people with a US phone number.
  Source: https://docs.cdp.coinbase.com/onramp/headless-onramp/overview.md

## Not verified

- **Apple Pay on a real iPhone.** Checked here: Stripe's kit loads and starts on our page under the new security policy in desktop Chromium, with no blocked request. The payment step needs a signed-in Stripe Link person, so the Apple Pay button itself was not seen.
- **Apple Pay in ChatGPT's in-app browser sheet.** It depends on which browser view ChatGPT uses on iPhone. Needs a tap test on the phone. If the button is missing there and present in Safari, the page needs an "Open in Safari" link.
- **Whether Stripe decides the region by phone number, location or both.**
- **The black background on iPhone.** Privy's modal backdrop only blurs the page; it has no colour. Desktop Chromium shows the page blurred behind it. The page now gives that backdrop a plain dark see-through colour and no blur. The cause on iPhone is a best reading, not reproduced; the fix needs one look on the phone.
- **Small images inside Privy's modal** (provider and coin icons). Their addresses come from Privy at run time. If one shows as a blank square, the page's image policy needs that address added.
- **Coinbase as a choice inside the new modal.** `preferredProvider: 'coinbase'` exists, but Privy lists only Stripe and MoonPay as on by default, so the page keeps the earlier Coinbase window for that button.

## For the demo video

Privy's deposit call has a test mode (`fiat.environment: 'sandbox'`): no real money, test card 4242 4242 4242 4242, phone code 000000, amounts under $200. The page runs in production mode. A test-mode recording needs a one-line change on a preview build.
Source: https://docs.privy.io/wallets/funding/use-deposit-funds.md (section "Test in sandbox mode")

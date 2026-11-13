// Shared by the sign-in page (src.jsx) and the fund page (fund.jsx): one Privy configuration for both.
import React from "react";
import { LOGIN_METHODS } from "./login-methods.js";
import { words } from "./brand-words.jsx";

// Every way to sign in (email, Google, Apple, X, Telegram), as PrivyClientConfig.loginMethods names them (3.47.0
// types). The sign-in page shows only the ones the Privy app has on; see login-methods.js. No wallet sign-in.

/** The person's YEET embedded wallets, one per chain (created at login, or by the sign-in page; wallet-setup.js). */
export { embeddedWallets } from "./wallet-setup.js";

/** PrivyProvider config; the CSP nonce comes from the page's csp-nonce meta tag. */
export function privyConfig() {
  return {
    scriptNonce: document.querySelector('meta[property="csp-nonce"]')?.content,
    appearance: {
      logo: <strong>{words("YEET")}</strong>,
      theme: "dark",
      accentColor: "#FFE03A",
      walletList: [],
    },
    loginMethods: [...LOGIN_METHODS],
    // PrivyClientConfig.embeddedWallets (3.47.0): the browser never creates wallets; the YEET server creates the Base
    // and Solana wallets with the YEET signer attached (POST /account/wallets), so a login-time create cannot race it.
    embeddedWallets: {
      disableAutomaticMigration: true,
      ethereum: { createOnLogin: "off" },
      solana: { createOnLogin: "off" },
    },
    externalWallets: { walletConnect: { enabled: false } },
  };
}

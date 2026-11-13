// Shared by the sign-in page (src.jsx) and the fund page (fund.jsx): one Privy configuration for both.
import React from "react";

export const PROVIDERS = [
  ["google", "Google"],
  ["apple", "Apple"],
  ["telegram", "Telegram"],
  ["twitter", "X"],
];

/** The person's YEET embedded wallets (created on login), one per chain. */
export function embeddedWallets(user) {
  const wallets = (user?.linkedAccounts || []).filter(
    (a) =>
      a.type === "wallet" &&
      (a.walletClientType === "privy" || a.walletClientType === "privy-v2") &&
      !a.imported,
  );
  return {
    base: wallets.find((w) => w.chainType === "ethereum"),
    solana: wallets.find((w) => w.chainType === "solana"),
  };
}

/** PrivyProvider config; the CSP nonce comes from the page's csp-nonce meta tag. */
export function privyConfig() {
  return {
    scriptNonce: document.querySelector('meta[property="csp-nonce"]')?.content,
    appearance: {
      logo: <strong>YEET</strong>,
      theme: "dark",
      accentColor: "#ffe14d",
      walletList: [],
    },
    loginMethods: PROVIDERS.map(([provider]) => provider),
    embeddedWallets: {
      disableAutomaticMigration: true,
      ethereum: { createOnLogin: "all-users" },
      solana: { createOnLogin: "all-users" },
    },
    externalWallets: { walletConnect: { enabled: false } },
  };
}

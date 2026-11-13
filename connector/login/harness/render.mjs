// Render harness for the sign-in pages: builds the page bundles against privy-fake.jsx and writes every screen as a
// static page, with the served files at their real paths, into one folder. Serve it with --serve to look at it.
//
//   node login/harness/render.mjs [--out <dir>] [--serve <port>]
//
// Pages: <out>/<screen>.html. Screens that need a person's step (typing an email) are reached in the browser.
import { build } from "esbuild";
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = arg("--out", here("./out"));
const serve = arg("--serve", null);

const { document, providerErrorPage, expiredAuthorizationBody, renewableConsentCopy } = await import("../../as/auth-pages.mjs");
const { consentForm, referralForm, REFERRAL_TITLE } = await import("../../as/consent-selection.mjs");
const { ACCOUNT_TITLE, accountBody, usernameMessage } = await import("../../as/account-page.mjs");
const { FUND_TITLE } = await import("../../as/fund-page.mjs");

// 1. The bundles, with Privy swapped for the harness hooks.
const fakePrivy = {
  name: "harness-privy",
  setup(b) {
    b.onResolve({ filter: /^@privy-io\/react-auth$/ }, () => ({ path: here("./privy-fake.jsx") }));
  },
};
mkdirSync(join(out, "account/privy-login"), { recursive: true });
await build({
  entryPoints: { login: here("../src.jsx"), fund: here("../fund.jsx") },
  bundle: true, format: "esm", target: "es2022", outdir: join(out, "account/privy-login"), entryNames: "[name]",
  splitting: true, minify: true, define: { "process.env.NODE_ENV": '"production"' }, plugins: [fakePrivy],
  nodePaths: [here("../node_modules")], logLevel: "warning",
});
cpSync(here("../../as/viewer"), join(out, "account"), { recursive: true });

// 2. The pages. A page script sets the harness state and answers the page's own requests.
const base = { linkedAccounts: [] };
const wallet = (chainType, address) => ({ type: "wallet", walletClientType: "privy", chainType, address });
const withWallets = { linkedAccounts: [wallet("ethereum", "0x5a1C0ffee0D15ea5e0000000000000000000B45E"), wallet("solana", "7YeetSo1anaWa11etAddre55xxxxxxxxxxxxxxxxx")] };
const appConfig = { email_auth: true, google_oauth: true, apple_oauth: true, twitter_oauth: true, telegram_auth: false };
function harness(state) {
  return `<script>window.__YEET_HARNESS__=${JSON.stringify(state)};(function(){var real=window.fetch.bind(window),h=window.__YEET_HARNESS__;
window.fetch=function(url,init){var u=String(url);
if(u.indexOf("/account/identity-config")>=0)return Promise.resolve(new Response(JSON.stringify({appId:"harness-app",signerId:"s",policyIds:{}}),{status:200,headers:{"content-type":"application/json"}}));
if(u.indexOf("/account/wallets")>=0){if(h.wallets==="fail")return Promise.resolve(new Response(JSON.stringify({code:"WALLET_SETUP_FAILED",message:"YEET could not set up your wallets. Nothing was charged. Tap Try again."}),{status:409,headers:{"content-type":"application/json"}}));return new Promise(function(){});}
if(u.indexOf("mainnet.base.org")>=0){h.baseReads=(h.baseReads||0)+1;var units=h.rise&&h.baseReads>1?67500000:42500000;return Promise.resolve(new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:"0x"+units.toString(16).padStart(64,"0")}),{status:200,headers:{"content-type":"application/json"}}));}
if(u.indexOf("api.mainnet-beta.solana.com")>=0){var owner=JSON.parse(init.body).params[0];return Promise.resolve(new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{context:{slot:1},value:[{pubkey:"x",account:{data:{program:"spl-token",parsed:{type:"account",info:{mint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",owner:owner,tokenAmount:{amount:"12000000",decimals:6,uiAmountString:"12"}}}}}}]}}),{status:200,headers:{"content-type":"application/json"}}));}
return real(url,init)};})();</script>`;
}
const page = (title, body, state) => document(title, body).replace("</head>", `${state ? harness(state) : ""}</head>`);
const loginForm = (mode = "") =>
  `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="x"><div id="privy-login"${mode ? ` data-mode="${mode}"` : ""}><p role="status">Loading secure sign in…</p></div><script type="module" src="/account/privy-login/login.js"></script></form>`;
const requested = ["openid", "offline_access", "yeet:read", "yeet:write", "yeet:trade"];
const PAGES = {
  signin: page("Sign in to YEET", loginForm(), { authenticated: false, appConfig }),
  setup: page("Sign in to YEET", loginForm(), { authenticated: true, user: base, appConfig }),
  "setup-failed": page("Sign in to YEET", loginForm(), { authenticated: true, user: base, appConfig, wallets: "fail" }),
  continue: page("Sign in to YEET", loginForm(), { authenticated: true, user: withWallets, appConfig }),
  consent: page("Connect YEET to ChatGPT", consentForm({ csrf: "x", accountId: "yeet-privy-a1b2c3", clientId: "https://chatgpt.com/oauth/client.json", resource: "https://chatgpt.yeet.win", requested, renewal: renewableConsentCopy(86400 * 30) })),
  referral: page(REFERRAL_TITLE, referralForm({ csrf: "x" })),
  account: page(ACCOUNT_TITLE, accountBody({ csrf: "x", username: "moonboi", name: "moonboi", saved: true })),
  "account-new": page(ACCOUNT_TITLE, accountBody({ csrf: "x", username: null, name: "Lucky Otter 42" })),
  "account-taken": page(ACCOUNT_TITLE, accountBody({ csrf: "x", username: null, name: "Lucky Otter 42", value: "satoshi", error: usernameMessage("USERNAME_TAKEN") })),
  fund: page(FUND_TITLE, '<div id="yeet-fund"><p role="status">Loading your YEET wallet…</p></div><script type="module" src="/account/privy-login/fund.js"></script>', { authenticated: true, user: withWallets }),
  // The Base balance rises from 42.50 to 67.50 USDC on the second read (Refresh balance, or the next poll).
  "fund-arrived": page(FUND_TITLE, '<div id="yeet-fund"><p role="status">Loading your YEET wallet…</p></div><script type="module" src="/account/privy-login/fund.js"></script>', { authenticated: true, user: withWallets, rise: true }),
  refused: providerErrorPage("access_denied"),
  expired: page("Authorization page expired or unavailable", expiredAuthorizationBody),
  signout: page("Sign out", loginForm("logout"), { authenticated: true, user: withWallets }),
};
for (const [name, html] of Object.entries(PAGES)) writeFileSync(join(out, `${name}.html`), html);
console.log(`PASS harness: ${Object.keys(PAGES).length} pages in ${out}`);

// 3. Optional static server.
if (serve) {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
  createServer((q, r) => {
    const path = normalize(decodeURIComponent(new URL(q.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(out, path);
    if (path.endsWith("/")) file = join(file, "index.html");
    if (!file.startsWith(out) || !existsSync(file)) return r.writeHead(404).end();
    r.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
  }).listen(Number(serve), "127.0.0.1", () => console.log(`serving ${out} on http://127.0.0.1:${serve}/`));
}

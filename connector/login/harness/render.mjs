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

const { document, providerErrorPage, expiredAuthorizationBody } = await import("../../as/auth-pages.mjs");
const { consentForm, legalLine } = await import("../../as/consent-selection.mjs");
const { termsBody, TERMS_TITLE } = await import("../../as/terms-page.mjs");
const { termsObject } = await import("../../core/terms.mjs");
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
  entryPoints: { login: here("../src.jsx"), fund: here("../fund.jsx"), sign: here("../sign.jsx") },
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
  `<form method="POST" data-yeet-prompt="login"><input type="hidden" name="csrf" value="x"><div id="privy-login"${mode ? ` data-mode="${mode}"` : ""}><p role="status">Loading secure sign in…</p></div><script type="module" src="/account/privy-login/login.js"></script>${legalLine()}</form>`;
const CONNECT = "Sign in to connect YEET to ChatGPT";
const PAGES = {
  signin: page(CONNECT, loginForm(), { authenticated: false, appConfig }),
  setup: page(CONNECT, loginForm(), { authenticated: true, user: base, appConfig }),
  "setup-failed": page(CONNECT, loginForm(), { authenticated: true, user: base, appConfig, wallets: "fail" }),
  continue: page(CONNECT, loginForm(), { authenticated: true, user: withWallets, appConfig }),
  consent: page("Connect YEET to ChatGPT", consentForm({ csrf: "x", name: "Nimble Tapir 88", connectedSeconds: 86400 * 7 })),
  terms: page(TERMS_TITLE, termsBody({ csrf: "x", terms: termsObject(null, { mode: "page", pageUrl: "https://chatgpt.yeet.win/account/terms" }) })),
  "terms-accepted": page(TERMS_TITLE, termsBody({ csrf: "x", terms: termsObject({ accepted_at: Date.parse("2026-11-13T10:00:00Z") }) })),
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

// 2b. The trade page (/sign, as/sign-page.mjs) with a stand-in for the Privy client it runs (window.YeetSigner) and
// for its three routes. The page's own files sit at their real paths (/sign/sign.js, /sign/flow.mjs, ...); the
// sign-in step is the bundle built above. Each page is one state; the ones behind a press and hold or a typed code
// are reached in the browser (trade-shots.mjs does it for the pictures).
const { signPageHtml } = await import("../../as/sign-page.mjs");
mkdirSync(join(out, "sign"), { recursive: true });
mkdirSync(join(out, "harness"), { recursive: true });
for (const f of ["sign.js", "flow.mjs", "sign.css"]) cpSync(here(`../../as/viewer/sign/${f}`), join(out, "sign", f));
cpSync(here("../../core/pipeline/wallet-request.mjs"), join(out, "sign/wallet-request.mjs"));
writeFileSync(join(out, "harness/wallet.js"), `(function(){var h=window.__YEET_HARNESS__||{},user=h.user||null;
var later=function(ms,v){return new Promise(function(r){setTimeout(function(){r(v)},ms||0)})};
window.YeetSigner={version:1,create:function(){return{
session:function(){return Promise.resolve(user)},accessToken:function(){return Promise.resolve(user?"harness":null)},
wallets:function(){return Promise.resolve([{address:h.wallet,id:"w1",chain_type:"solana"}])},
rpc:function(){return later(h.walletMs,{data:{signed_transaction:"AQID",encoding:"base64"}})},
sendCode:function(){return later(200)},login:function(){user=h.after||null;return Promise.resolve(user)},
linkEmail:function(email){if(/^taken/.test(email))return Promise.reject(Object.assign(Error("linked"),{code:"linked_to_another_user"}));
user=Object.assign({},user,{linked_accounts:[{type:"email",address:email}].concat(user.linked_accounts)});return later(200,user)},
logout:function(){user=null;return Promise.resolve()}}}};})();`);
const TRADE_ID = "t_abcdefghij0123456789", TRADE_WALLET = "7x3qiZtcsqC2paa7p7XnfUffedPDNP7GvZVuMD7VXvDe";
const coins = [["WIF", "8000000"], ["BOME", "6000000"], ["PENGU", "6000000"]];
const tradeAnswer = {
  trade_id: TRADE_ID, direction: "yeet", status: "signing", legs: coins.map(([symbol], leg) => ({ leg, symbol, send_status: "awaiting_signature" })),
  sign_requests: [{ trade_id: TRADE_ID, leg: 0, attempt_id: "a".repeat(64), kind: "solana_tx", chain: "sol", wallet: TRADE_WALLET, legs: [0, 1, 2], expires_at: "2030-01-01T00:00:00Z",
    payload: { transaction_base64: "AQID", last_valid_block_height: "312000000" }, summary: { side: "buy", asset: "USDC", amount_raw: coins[0][1], decimals: 6, to: "dep0" },
    leg_summaries: coins.map(([, amount_raw], leg) => ({ leg, side: "buy", asset: "USDC", amount_raw, decimals: 6, to: `dep${leg}` })) }],
};
const person = (accounts) => ({ id: "did:privy:harness", linked_accounts: accounts });
const gina = person([{ type: "google_oauth", email: "gina@gmail.com", name: "Gina" }]);
const emil = person([{ type: "email", address: "eric@yeet.win" }]);
/** state.api: "trade" (the open trade), "sent" (nothing left), "mismatch" (another account's trade). state.submit: "wait" keeps the page sending. */
function tradeHarness(state) {
  return `<script>window.__YEET_HARNESS__=${JSON.stringify({ wallet: TRADE_WALLET, ...state })};(function(){var real=window.fetch.bind(window),h=window.__YEET_HARNESS__;
if(h.fresh){try{sessionStorage.setItem("yeet-trade-fresh","1")}catch(e){}}
var json=function(status,body){return Promise.resolve(new Response(JSON.stringify(body),{status:status,headers:{"content-type":"application/json"}}))};
var trade=${JSON.stringify(tradeAnswer)};
window.fetch=function(url,init){var u=String(url);
if(u.indexOf("/sign/api/requests")>=0){
 if(h.api==="mismatch")return json(404,{code:"TRADE_NOT_FOUND",message:"This trade belongs to a different YEET account than the one you’re using here. Use the Google, Apple or email account you connected to ChatGPT with."});
 if(h.api==="sent")return json(200,Object.assign({},trade,{status:"submitted",legs:trade.legs.map(function(l){return Object.assign({},l,{send_status:"sent"})}),sign_requests:[]}));
 return json(200,trade)}
if(u.indexOf("/sign/api/signature")>=0){if(h.submit==="wait")return new Promise(function(){});
 return json(200,{trade_id:trade.trade_id,status:"submitted",legs:trade.legs.map(function(l){return Object.assign({},l,{send_status:"signing"})})})}
if(u.indexOf("/sign/api/email-linked")>=0)return json(200,{ok:true});
return real(url,init)};})();</script>`;
}
const tradePage = (state) =>
  signPageHtml({ appId: "harnessappid0001", tradeId: TRADE_ID, asset: { path: "/harness/wallet.js" }, back: "https://chatgpt.com/", nonce: "harness" })
    .replace('<link rel="stylesheet" href="/sign/sign.css">', `<link rel="stylesheet" href="/sign/sign.css">${tradeHarness(state)}`);
Object.assign(PAGES, {
  // No session in this browser: the connect screen's methods. `fresh`: a sign-in that did not carry over.
  "trade-signin": tradePage({ user: null, authenticated: false, appConfig }),
  "trade-signin-google-only": tradePage({ user: null, authenticated: false, appConfig: { email_auth: true, google_oauth: true, apple_oauth: false } }),
  "trade-signin-again": tradePage({ user: null, authenticated: false, appConfig, fresh: true }),
  // A Google account already here (it connected in this browser): the trade and the press and hold.
  "trade-ready": tradePage({ user: gina, api: "trade" }),
  "trade-sending": tradePage({ user: gina, api: "trade", submit: "wait" }),
  // An account with an email login ends without the optional step.
  "trade-ready-email": tradePage({ user: emil, api: "trade" }),
  "trade-mismatch": tradePage({ user: gina, api: "mismatch" }),
  "trade-sent": tradePage({ user: gina, api: "sent" }),
});
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

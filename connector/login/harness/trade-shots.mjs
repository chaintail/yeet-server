// Pictures of the trade page's states at 390 px, from the render harness (render.mjs), in headless Chrome. The
// states behind a press and hold or a typed code are reached the way a person reaches them.
//
//   node login/harness/render.mjs --out <dir>
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core node login/harness/trade-shots.mjs <dir> <picturesDir>
//
// Needs playwright-core and a Chrome (CHROME, default /usr/bin/google-chrome). Prints one PASS or FAIL line; a page
// error or a missing state fails it.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";

const [from, to] = process.argv.slice(2).map((p) => resolve(p));
if (!from || !to) throw new Error("Usage: node login/harness/trade-shots.mjs <harness dir> <pictures dir>");
mkdirSync(to, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const WIDTH = Number(process.env.WIDTH) || 390;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer((q, r) => {
  const path = normalize(decodeURIComponent(new URL(q.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(from, path);
  if (!file.startsWith(from) || !existsSync(file)) return r.writeHead(404).end();
  r.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

/** Press and hold the page's button for `ms` (the hold runs 800 ms). */
async function hold(tab, ms = 950) {
  const box = await (await tab.waitForSelector("#sign-go")).boundingBox();
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await tab.mouse.down(); await tab.waitForTimeout(ms); await tab.mouse.up();
}
const type = async (tab, sel, text) => { await tab.fill(sel, text); };
/** The trade goes out (press and hold), and the email step is on the page. */
const out = async (tab) => { await hold(tab); await tab.waitForSelector("#sign-link"); };
const code = async (tab) => { await tab.click("#link-send"); await tab.waitForSelector("#link-code"); };
const confirm = async (tab, digits) => { await type(tab, "#link-code", digits); await tab.click("#link-confirm"); await tab.waitForTimeout(600); };
// [picture, harness page, what must be on it, the steps to get there]
const SHOTS = [
  ["connect-signin", "signin", "Continue with Google", null],
  ["trade-signin", "trade-signin", "Confirm it’s you to finish this trade.", null],
  ["trade-signin-google-only", "trade-signin-google-only", "Continue with Google", null],
  ["trade-signin-code", "trade-signin", "We sent a 6-digit code to", async (tab) => { await type(tab, "#yeet-email", "gina@gmail.com"); await tab.click("text=Email me a code"); await tab.waitForTimeout(900); }],
  ["trade-signin-again", "trade-signin-again", "That didn’t carry over in this browser.", null],
  ["trade-ready", "trade-ready", "Press and hold to YEET", null],
  ["trade-holding", "trade-ready", "Press and hold to YEET", async (tab) => { const box = await (await tab.waitForSelector("#sign-go")).boundingBox(); await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await tab.mouse.down(); await tab.waitForTimeout(450); }],
  ["trade-sending", "trade-sending", "Sending…", async (tab) => { await hold(tab); await tab.waitForTimeout(300); }],
  // The email step, once the trade is out (an account with no email login): the step is the page, in this order.
  ["trade-link-offer", "trade-ready", ["Your trade is on its way.", "Trust this device?", "Confirm your email once and your next trades finish right inside ChatGPT, without opening this window.", "We’ll email a code to g•••@g•••.com.", "Trust this device", "Not now"], async (tab) => { await out(tab); }],
  ["trade-link-code", "trade-ready", ["Trust this device?", "We emailed a 6-digit code to g•••@g•••.com.", "Send again", "Not now"], async (tab) => { await out(tab); await code(tab); }],
  ["trade-link-wrong-code", "trade-ready", ["Trust this device?", "That code didn’t work or has expired. Check the latest email from YEET, or press Send again."], async (tab) => { await out(tab); await code(tab); await confirm(tab, "000000"); }],
  ["trade-link-too-many", "trade-ready", ["Trust this device?", "Too many tries just now. Wait a minute, then try again."], async (tab) => { await out(tab); await code(tab); await confirm(tab, "429429"); }],
  ["trade-link-done", "trade-ready", ["This device is trusted. Your next trades finish inside ChatGPT. Go back to ChatGPT.", "Your next trade asks once for a code we email to g•••@g•••.com.", "Finish your trade", "Back to ChatGPT"], async (tab) => { await out(tab); await code(tab); await confirm(tab, "123456"); }],
  ["trade-link-not-now", "trade-ready", ["Done. Go back to ChatGPT.", "Finish your trade"], async (tab) => { await out(tab); await tab.click("#link-skip"); await tab.waitForSelector("#sign-done"); }],
  ["trade-link-other-account", "trade-ready-taken", ["Trust this device?", "This email belongs to a different YEET account, so it can’t be added to this one. Your trade is not affected. Try another email, or choose Not now."], async (tab) => { await out(tab); await code(tab); await confirm(tab, "123456"); await tab.waitForSelector("#link-email"); }],
  ["trade-link-apple-no-email", "trade-ready-apple", ["Trust this device?", "Your account didn’t share an email with YEET. Type the one you want to use."], async (tab) => { await out(tab); await tab.waitForSelector("#link-email"); }],
  ["trade-link-apple-relay", "trade-ready-relay", ["Trust this device?", "Apple keeps your own address private and gave YEET this relay address. The code goes through Apple to your inbox. If it doesn’t arrive, type another email you use."], async (tab) => { await out(tab); await tab.waitForSelector("#link-email"); }],
  ["trade-link-next-visit", "trade-sent-google", ["Your trade is already out.", "Trust this device?", "Trust this device"], null],
  ["trade-done-email-account", "trade-ready-email", "Done. Go back to ChatGPT.", async (tab) => { await hold(tab); await tab.waitForSelector("#sign-done"); }],
  ["trade-mismatch", "trade-mismatch", "You’re here as g•••@g•••.com.", null],
  ["trade-sent", "trade-sent", "Nothing left to do here.", null],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome" });
const problems = [];
try {
  for (const [name, pageName, expect, steps] of SHOTS) {
    const tab = await browser.newPage({ viewport: { width: WIDTH, height: 844 }, deviceScaleFactor: 1 });
    tab.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
    await tab.goto(`${base}/${pageName}.html`);
    await tab.waitForTimeout(1300);
    try { if (steps) await steps(tab); } catch (e) { problems.push(`${name}: ${String(e.message).split("\n")[0]}`); }
    const text = await tab.evaluate(() => document.body.innerText);
    for (const want of [].concat(expect)) if (!text.includes(want)) problems.push(`${name}: "${want}" is not on the page`);
    // Nothing on the page says sign, signing, signed or signature (the connect screen keeps its own "Sign in").
    if (name.startsWith("trade-") && /\bsign\w*|signature|log ?in/i.test(text)) problems.push(`${name}: a banned word is on the page`);
    await tab.screenshot({ path: join(to, `${name}.png`), fullPage: true });
    await tab.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`${problems.length ? "FAIL" : "PASS"} ${SHOTS.length} pictures of the trade page at ${WIDTH} px in ${to}${problems.length ? `: ${problems.join(" | ")}` : ""}`);
process.exitCode = problems.length ? 1 : 0;

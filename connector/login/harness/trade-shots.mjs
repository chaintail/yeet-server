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
  ["trade-done", "trade-ready", "Done. Go back to ChatGPT.", async (tab) => { await hold(tab); await tab.waitForSelector("#sign-done"); }],
  ["trade-done-code", "trade-ready", "We emailed a 6-digit code to g•••@g•••.com.", async (tab) => { await hold(tab); await tab.click("#link-send"); await tab.waitForSelector("#link-code"); }],
  ["trade-done-linked", "trade-ready", "Future trades finish inside ChatGPT.", async (tab) => { await hold(tab); await tab.click("#link-send"); await type(tab, "#link-code", "123456"); await tab.click("#link-confirm"); await tab.waitForTimeout(500); }],
  ["trade-done-other-account-email", "trade-ready", "That email already belongs to another YEET account.", async (tab) => { await hold(tab); await type(tab, "#link-email", "taken@gmail.com"); await tab.click("#link-send"); await type(tab, "#link-code", "123456"); await tab.click("#link-confirm"); await tab.waitForTimeout(500); }],
  ["trade-done-not-now", "trade-ready", "Done. Go back to ChatGPT.", async (tab) => { await hold(tab); await tab.click("#link-skip"); await tab.waitForTimeout(200); }],
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
    if (!text.includes(expect)) problems.push(`${name}: "${expect}" is not on the page`);
    // Nothing on the page says sign, signing, signed or signature (the connect screen keeps its own "Sign in").
    if (name.startsWith("trade-") && /\bsign\w*|signature|log ?in/i.test(text)) problems.push(`${name}: a banned word is on the page`);
    await tab.screenshot({ path: join(to, `${name}.png`), fullPage: true });
    await tab.close();
  }
} finally { await browser.close(); server.close(); }
console.log(`${problems.length ? "FAIL" : "PASS"} ${SHOTS.length} pictures of the trade page at ${WIDTH} px in ${to}${problems.length ? `: ${problems.join(" | ")}` : ""}`);
process.exitCode = problems.length ? 1 : 0;

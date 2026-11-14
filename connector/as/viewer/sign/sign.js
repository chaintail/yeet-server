// The first-party trade page (as/sign-page.mjs). The trade card opens it when the trade cannot be finished inside
// ChatGPT: the account connected with Google or Apple (no emailed code for the card), or the wallet could not answer
// in the card's frame. This file draws the page; the flow is as/viewer/sign/flow.mjs (no DOM), the wallet is the
// vendored Privy client (window.YeetSigner), and the sign-in step is the connect screen's own component, loaded only
// when this browser has no YEET session (/account/privy-login/sign.js, login/sign.jsx).
//
//   already here (the usual case: the person connected in this browser)  ->  the trade, press and hold, done
//   no session                                                           ->  Continue with Google / Apple / email,
//                                                                            back on this page, the same trade
// Google and Apple send the person back to the bare /sign address (Privy matches redirect addresses exactly, with no
// query), so the trade id and the way back to ChatGPT are kept in this tab for the round trip.
import {privyRpcBodies, signedFromWallets} from '/sign/wallet-request.mjs';
import {createSignFlow, summariesOf, summaryFor, maskEmail} from '/sign/flow.mjs';

const root = document.getElementById('yeet-sign');
const body = document.getElementById('sign-body');
const SIGN_IN_BUNDLE = '/account/privy-login/sign.js';
const TRADE_ID = /^t_[a-z0-9]{20}$/;
const RETURN_KEY = 'yeet-trade-return', FRESH_KEY = 'yeet-trade-fresh', RETURN_FOR_MS = 30 * 60_000;
const STATE = {
  awaiting_signature: ['Waiting to send', ''], signing_now: ['Sending…', 'run'], signing: ['Sending', 'run'],
  awaiting_gas: ['Network fee on its way', 'run'], sent: ['Sent', 'ok'], not_sent: ['Not sent', 'bad'], failed: ['Not sent', 'bad'],
};
const LEAD = 'Confirm it’s you to finish this trade.';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
const line = (text, kind = '') => { const p = el('p', `line ${kind}`.trim(), text); p.setAttribute('role', 'status'); return p; };
const stores = () => { const out = []; for (const name of ['sessionStorage', 'localStorage']) { try { const s = window[name]; s.getItem('x'); out.push(s); } catch { /* storage is off here */ } } return out; };
/** Only ChatGPT is ever offered as the way back (the server applies the same rule to ?redirectUrl=). */
const chatgpt = (v) => { try { const u = new URL(String(v)); return u.protocol === 'https:' && u.hostname === 'chatgpt.com' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };

// ---- Which trade: the address, or (back from Google or Apple) what this tab kept before it left ----------------
function kept() {
  for (const s of stores()) {
    try {
      const v = JSON.parse(s.getItem(RETURN_KEY) ?? 'null');
      if (v && TRADE_ID.test(v.trade_id ?? '') && Date.now() - Number(v.at) < RETURN_FOR_MS) return {tradeId: v.trade_id, back: chatgpt(v.back), hint: HINT.test(v.hint ?? '') ? v.hint : '', methods: v.methods};
    } catch { /* not ours */ }
  }
  return null;
}
const METHOD_IDS = ['google', 'apple', 'email'];
/** The sign-in methods the server offers on this page (data-methods); with none named, Google and Apple. */
const methodsOf = (text) => { const given = String(text ?? '').split(','); const ids = METHOD_IDS.filter((m) => given.includes(m)); return ids.length ? ids : ['google', 'apple']; };
/** The shape of the signed hint a card's link carries (?h=). The server checks it; the page only carries it along. */
const HINT = /^v1\.[A-Za-z0-9_-]{8,300}\.[A-Za-z0-9_-]{43}$/;
const cfg = {appId: root.dataset.appId || '', tradeId: root.dataset.tradeId || '', back: root.dataset.back || '', methods: methodsOf(root.dataset.methods), hint: HINT.test(root.dataset.hint || '') ? root.dataset.hint : ''};
const query = new URLSearchParams(location.search);
const fromProvider = query.has('privy_oauth_code') || query.has('privy_oauth_state');
// Back from Google or Apple on the bare address: the trade, the way back, the hint and its methods as this tab kept them.
if (!cfg.tradeId) { const k = kept(); if (k) { cfg.tradeId = k.tradeId; cfg.back = cfg.back || k.back; if (k.hint) { cfg.hint = k.hint; cfg.methods = methodsOf(String(k.methods ?? '')); } } }
const keep = () => { for (const s of stores()) { try { s.setItem(RETURN_KEY, JSON.stringify({trade_id: cfg.tradeId, back: cfg.back, hint: cfg.hint, methods: cfg.methods.join(','), at: Date.now()})); } catch { /* the address still names the trade */ } } };
const forget = () => { for (const s of stores()) { try { s.removeItem(RETURN_KEY); } catch { /* nothing kept */ } } };
const tradeUrl = () => `/sign?trade_id=${encodeURIComponent(cfg.tradeId)}${cfg.hint ? `&h=${encodeURIComponent(cfg.hint)}` : ''}${cfg.back ? `&redirectUrl=${encodeURIComponent(cfg.back)}` : ''}`;

function show(...nodes) { body.replaceChildren(...nodes.filter(Boolean), ...(cfg.back ? [backLink()] : [])); }
function backLink() { const a = el('a', 'back', 'Back to ChatGPT'); a.href = cfg.back; a.rel = 'noopener'; return a; }

function units(raw, decimals, places) {
  let v = BigInt(raw); const d = BigInt(decimals); const base = 10n ** d;
  const whole = v / base, frac = (v % base).toString().padStart(Number(d), '0');
  const shown = places == null ? frac.replace(/0+$/, '').slice(0, 6) : frac.slice(0, places).padEnd(places, '0');
  return shown ? `${whole}.${shown}` : `${whole}`;
}
const amountOf = (s) => { if (!s) return ''; const usdc = s.asset === 'USDC'; return `${units(s.amount_raw, s.decimals, usdc ? 2 : null)} ${s.asset}`; };

// ---- Press and hold: nothing that moves funds runs on a single tap (the card's rule, the card's timing) ----------
// The fill runs HOLD_MS; letting go early, leaving the button or a scroll cancels. Space or Enter held down works the
// same. An activation with no pointer and no key behind it (a screen reader) arms the button; a second one runs it.
const HOLD_MS = 800, HOLD_MOVE = 12, ARM_MS = 6000;
function holdable(b, run, what) {
  const fill = el('span', 'hold-fill'); fill.setAttribute('aria-hidden', 'true'); b.prepend(fill); b.classList.add('hold'); b.style.setProperty('--hold', `${HOLD_MS}ms`);
  const label = `Press and hold to ${what}`;
  const hint = el('p', 'hold-hint', label); b.setAttribute('aria-label', label);
  let timer = null, at = null, armed = 0, fired = 0;
  const stop = () => { clearTimeout(timer); timer = null; at = null; b.classList.remove('holding'); };
  const fire = () => { stop(); fired = Date.now(); armed = 0; run(); };
  const start = (p) => { if (b.disabled || timer !== null) return; at = p; hint.classList.remove('nudge'); b.classList.add('holding'); timer = setTimeout(fire, HOLD_MS); };
  b.addEventListener('pointerdown', (e) => { if (e.button > 0) return; start({x: e.clientX || 0, y: e.clientY || 0}); });
  b.addEventListener('pointermove', (e) => { if (at && Math.hypot((e.clientX || 0) - at.x, (e.clientY || 0) - at.y) > HOLD_MOVE) stop(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'blur']) b.addEventListener(ev, stop);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  b.addEventListener('keydown', (e) => { if (e.key !== ' ' && e.key !== 'Enter') return; e.preventDefault(); if (!e.repeat) start(null); });
  b.addEventListener('keyup', (e) => { if (e.key !== ' ' && e.key !== 'Enter') return; e.preventDefault(); stop(); });
  b.onclick = (e) => {
    e.preventDefault(); if (b.disabled || Date.now() - fired < 1000) return;
    if (e.detail > 0) { hint.classList.remove('nudge'); void hint.offsetWidth; hint.classList.add('nudge'); return; }
    if (Date.now() - armed < ARM_MS) { fire(); return; }
    armed = Date.now(); hint.textContent = `Activate again to ${what}`; b.setAttribute('aria-label', `Activate again to ${what}`); hint.setAttribute('role', 'status');
    setTimeout(() => { if (Date.now() - armed >= ARM_MS) { hint.textContent = label; b.setAttribute('aria-label', label); } }, ARM_MS);
  };
  return hint;
}

// ---- The trade: the total, one row per coin ----------------------------------------------------------------------
function tradeRows(s) {
  const trade = s.trade, reqs = trade.sign_requests ?? [];
  const side = trade.direction === 'skeet' ? 'skeet' : 'yeet';
  const all = reqs.flatMap(summariesOf), usdc = all.filter((x) => x.asset === 'USDC');
  const total = el('div', 'total');
  total.append(el('span', `side ${side}`, side === 'skeet' ? 'SKEET' : 'YEET'),
    el('span', 'amt', usdc.length === all.length && all.length ? `${units(usdc.reduce((a, x) => a + BigInt(x.amount_raw), 0n), usdc[0].decimals, 2)} USDC` : `${trade.legs.length} coin${trade.legs.length === 1 ? '' : 's'}`));
  const ul = el('ul', 'rows');
  for (const l of trade.legs) {
    const st = STATE[s.local[l.leg] ?? l.send_status] ?? ['', ''];
    const li = el('li'); li.dataset.leg = String(l.leg);
    const left = el('span'); left.append(el('span', 'sym', l.symbol), document.createTextNode(' '), el('span', 'amt', amountOf(summaryFor(reqs, l.leg))));
    li.append(left, el('span', `state ${st[1]}`.trim(), st[0]));
    ul.append(li);
  }
  return [total, ul];
}

// ---- The sign-in step: the connect screen's methods, nothing created here -----------------------------------------
let unmount = null, flow = null, signer = null;
function signedIn() {
  // The session is in this origin's storage now. One reload hands it to the page's own wallet client.
  for (const s of stores()) { try { s.setItem(FRESH_KEY, '1'); } catch { /* the page asks once more */ } }
  location.replace(tradeUrl());
}
async function showSignIn(why) {
  const host = el('div', 'signin'); host.id = 'sign-in';
  host.append(line('One moment…'));
  show(why === 'stuck' ? line('That didn’t carry over in this browser. Try once more, or open this page in Safari or Chrome.', 'bad') : null, host);
  const intro = why === 'expired' ? 'Your session here ended. Confirm it’s you again to finish this trade.' : LEAD;
  let mod;
  // The bundle did not load: the emailed code alone, and only where email is offered. Otherwise say so plainly.
  try { mod = await import(SIGN_IN_BUNDLE); }
  catch { return cfg.methods.includes('email') ? emailOnly(host, intro) : host.replaceChildren(line('This step didn’t load. Reload the page to try again.', 'bad')); }
  host.replaceChildren();
  unmount = mod.mountSignIn(host, {appId: cfg.appId, redirectUrl: `${location.origin}/sign`, intro, methods: cfg.methods, onStart: keep, onDone: signedIn});
}
/** The sign-in bundle did not load: the emailed code alone, through the page's own client (existing accounts only). */
function emailOnly(host, intro) {
  const email = el('input'); email.type = 'email'; email.id = 'sign-email'; email.autocomplete = 'email'; email.inputMode = 'email'; email.autocapitalize = 'none';
  const eLabel = el('label', '', 'Email'); eLabel.htmlFor = 'sign-email';
  const code = el('input'); code.id = 'sign-code'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 6;
  const cLabel = el('label', '', '6-digit code'); cLabel.htmlFor = 'sign-code';
  const status = line('');
  const send = el('button', '', 'Email me a code'); send.id = 'sign-send';
  const go = el('button', '', 'Confirm'); go.id = 'sign-login';
  const codeBox = el('div'); codeBox.hidden = true; codeBox.append(cLabel, code, go);
  send.onclick = async () => {
    const v = email.value.trim(); if (!v) { email.focus(); return; }
    send.disabled = true; status.className = 'line'; status.textContent = 'Sending your code…';
    try { await signer.sendCode(v); status.textContent = `We sent a 6-digit code to ${v}.`; codeBox.hidden = false; send.textContent = 'Send a new code'; code.focus(); }
    catch { status.className = 'line bad'; status.textContent = 'The code didn’t go out. Check the email and try again.'; }
    send.disabled = false;
  };
  go.onclick = async () => {
    go.disabled = true; status.className = 'line'; status.textContent = 'One moment…';
    try { await signer.login(email.value.trim(), code.value.trim()); flow.begin(); }
    catch (e) {
      status.className = 'line bad';
      status.textContent = /not exist|no user|sign ?up|not found/i.test(String(e?.message)) ? 'No YEET account uses this email. Use the email of your YEET account.' : 'That code didn’t work. Check it and try again.';
      go.disabled = false;
    }
  };
  host.replaceChildren(line(intro), eLabel, email, send, status, codeBox);
}

// ---- The email step, once the trade is out: an account that came in with Google or Apple is offered an upgrade ----
// (flow.mjs state.link). The trade never waits for it: press and hold works on this page with no email at all. The
// step reads as a gift, in very simple words and short lines (owner, 2026-11-14): add your email once and trade right
// in the chat, on devices you trust. One field (or the address Google or Apple gave, shown masked), one button, one
// code; one small line for people whose address is a hidden or relay one; and a small "Not now".
const heading = document.querySelector('.top h1'), HEADING = heading?.textContent ?? '';
const LINK_TITLE = 'Want even better trading?';
const LINK_LINES = ['Add your email to trade right in the chat.', 'It turns on trusted devices. You do it once.', 'Or skip it. Trading on this page always works.'];
// The owner's own line, word for word (2026-11-14). It is the one place this page says "Signed".
const RELAY_LINE = 'Signed up with a hidden or relay email? Use that exact same address.';
const draft = {email: null, code: ''};
const linking = (s) => !!s.link && (s.link.stage === 'offer' || s.link.stage === 'code');
const title = (text) => { if (heading && heading.textContent !== text) heading.textContent = text; };
function linkStep(s) {
  const k = s.link;
  const box = el('section', 'step'); box.id = 'sign-link'; box.setAttribute('aria-label', LINK_TITLE);
  box.append(el('p', 'lead', LINK_LINES[0]), el('p', 'line', LINK_LINES[1]), el('p', 'fine', LINK_LINES[2]));
  const relayLine = () => { const p = el('p', 'fine', RELAY_LINE); p.id = 'link-relay'; return p; };
  const small = (text, fn, id, cls) => { const b = el('button', cls, text); b.id = id; b.type = 'button'; b.disabled = k.wait; b.onclick = fn; return b; };
  if (k.stage === 'offer') {
    if (draft.email === null) draft.email = k.email ?? '';
    const go = el('button', '', k.wait ? 'Sending…' : 'Turn it on'); go.id = 'link-send'; go.disabled = k.wait;
    if (k.fixed) {
      const shownAt = line(`We’ll email a code to ${maskEmail(k.email) ?? k.email}.`); shownAt.id = 'link-address';
      go.onclick = () => flow.linkSend(k.email);
      box.append(shownAt, go, relayLine());
    } else {
      const f = el('input'); f.type = 'email'; f.id = 'link-email'; f.autocomplete = 'email'; f.inputMode = 'email'; f.autocapitalize = 'none'; f.value = draft.email; f.oninput = () => { draft.email = f.value; };
      const lab = el('label', '', 'Your email'); lab.htmlFor = f.id;
      go.onclick = () => flow.linkSend(draft.email);
      f.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
      // One field (holding the address Apple gave when there is one), one button, the one small line.
      box.append(lab, f, go, relayLine());
    }
  } else {
    const sent = line(`We emailed a 6-digit code to ${k.fixed ? maskEmail(k.email) ?? k.email : k.email}.`); sent.id = 'link-sent';
    const f = el('input'); f.id = 'link-code'; f.inputMode = 'numeric'; f.autocomplete = 'one-time-code'; f.maxLength = 6; f.value = draft.code; f.oninput = () => { draft.code = f.value; };
    const lab = el('label', '', '6-digit code'); lab.htmlFor = f.id;
    const go = el('button', '', k.wait ? 'Checking…' : 'Confirm'); go.id = 'link-confirm'; go.disabled = k.wait; go.onclick = () => flow.linkConfirm(draft.code);
    f.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    box.append(sent, lab, f, go, small('Send again', () => flow.linkSend(k.email), 'link-again', 'quiet'));
  }
  if (k.error) { const e = line(k.error, 'bad'); e.id = 'link-error'; e.setAttribute('role', 'alert'); box.append(e); }
  box.append(small('Not now', () => flow.linkSkip(), 'link-skip', 'skip'));
  return box;
}
/** The trade is out and the email step is open: one line for the trade, then the step. */
function showLinkStep(s) {
  title(LINK_TITLE);
  const out = line(s.view === 'nothing' ? 'Your trade is already out.' : 'Your trade is on its way.', 'ok'); out.id = 'sign-out';
  show(out, linkStep(s));
  if (s.link.stage === 'code' && !s.link.wait) document.getElementById('link-code')?.focus();
}
/** After the step: what a later first trade on another device asks for. */
const linkedLine = (s) => (s.link?.stage === 'done' ? line(`Your next trade asks once for a code we email to ${s.link.masked ?? 'you'}.`) : null);

// ---- One state, one screen -----------------------------------------------------------------------------------------
let shown = null;
function draw(s) {
  if (s.view !== 'signin' && unmount) { try { unmount(); } catch { /* already gone */ } unmount = null; }
  if (s.view === 'signin') { if (shown !== 'signin') showSignIn(s.why); shown = 'signin'; return; }
  shown = s.view;
  if ((s.view === 'done' || s.view === 'nothing') && linking(s)) return showLinkStep(s);
  title(HEADING);
  if (s.view === 'starting') return show(line('Starting your wallet…'));
  if (s.view === 'loading') return show(line('Getting your trade…'));
  if (s.view === 'unavailable') return show(line(s.message, 'bad'));
  if (s.view === 'mismatch') {
    // `bound`: the link was made for one account and this is another. The right method is named; one button to retry.
    const other = el('button', s.bound ? '' : 'quiet', s.bound ? 'Try again' : 'Use another account'); other.id = 'sign-other'; other.onclick = () => flow.useAnother();
    const use = s.use ? line(s.use) : null; if (use) use.id = 'sign-use';
    return show(line(s.message, 'bad'), use, s.who ? line(`You’re here as ${s.who}.`) : null, other);
  }
  if (s.view === 'nothing') return show(...tradeRows(s), line(s.message, s.kind), linkedLine(s));
  if (s.view === 'ready' || s.view === 'sending') {
    const side = s.trade.direction === 'skeet' ? 'skeet' : 'yeet', word = side === 'skeet' ? 'SKEET' : 'YEET';
    const btn = el('button', side, s.view === 'sending' ? 'Sending…' : word); btn.id = 'sign-go';
    btn.disabled = s.view === 'sending' || !s.canRetry;
    const hint = holdable(btn, () => flow.approve(), word);
    return show(...tradeRows(s), btn, s.view === 'sending' || !s.canRetry ? null : hint, s.message ? line(s.message, s.kind) : null,
      el('p', 'fine', 'It goes out from your own wallet. YEET never holds your keys and only adds the network fee.'));
  }
  if (s.view === 'done') {
    const end = line(s.message, s.kind); end.classList.add('end'); end.id = 'sign-done';
    // The end: "Done." (also after "Not now"), or "This device is trusted." once the email is confirmed. The way back is under it.
    return show(...tradeRows(s), end, linkedLine(s));
  }
}

async function main() {
  if (!cfg.tradeId) return show(line('Open this page from the YEET card in ChatGPT.'));
  if (!cfg.appId || !window.YeetSigner) return show(line('This page isn’t available right now. Try again in a minute.', 'bad'));
  try { signer = window.YeetSigner.create({appId: cfg.appId}); } catch { return show(line('This page isn’t available right now. Try again in a minute.', 'bad')); }
  const post = async (path, payload) => {
    const r = await fetch(`/sign/api/${path}`, {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
    let j = null; try { j = await r.json(); } catch { /* no body */ }
    return {ok: r.ok, status: r.status, body: j};
  };
  flow = createSignFlow({signer, post, wr: {privyRpcBodies, signedFromWallets}, tradeId: cfg.tradeId, hint: cfg.hint, onChange: draw});
  // Back from Google or Apple: the sign-in step finishes what it started (it reads the answer in the address), then
  // the page reloads on the trade's own address.
  if (fromProvider) { shown = 'signin'; return showSignIn(null); }
  let fresh = false;
  for (const s of stores()) { try { if (s.getItem(FRESH_KEY) === '1') fresh = true; s.removeItem(FRESH_KEY); } catch { /* no flag */ } }
  forget();
  await flow.begin({fresh});
}
main();

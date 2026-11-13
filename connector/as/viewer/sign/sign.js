// The first-party signing page (as/sign-page.mjs). The trade card opens it when it cannot sign inside ChatGPT. Same
// contract as the card (yeet-win src/trade-signing.js): the server's sign requests for this trade, each signed by the
// embedded wallet whose address equals the request's `wallet`, through the same Privy signer (window.YeetSigner, the
// vendored yeet-signer.js), then submit_trade_signature. Sign only: the wallet never sends; YEET adds the network fee
// and sends. The card polls trade_status meanwhile.
import {privyRpcBodies, signedFromWallets} from '/sign/wallet-request.mjs';

/** What the page submits when the wallet refuses eth_sign7702Authorization (plan 3.2). */
const UNSUPPORTED_7702 = 'unsupported';

const root = document.getElementById('yeet-sign');
const body = document.getElementById('sign-body');
const cfg = {appId: root.dataset.appId || '', tradeId: root.dataset.tradeId || '', back: root.dataset.back || ''};
const STATE = {
  awaiting_signature: ['Waiting for signature', ''], signing_now: ['Signing…', 'run'], signing: ['Sending', 'run'],
  awaiting_gas: ['Network fee on its way', 'run'], sent: ['Sent', 'ok'], not_sent: ['Not sent', 'bad'], failed: ['Not sent', 'bad'],
};
const SENT = new Set(['signing', 'awaiting_gas', 'sent']);
const START_MS = 20000;
let signer = null, trade = null, busy = false;
const local = new Map(); // leg -> send_status as this page last saw it

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
const line = (text, kind = '') => { const p = el('p', `line ${kind}`.trim(), text); p.setAttribute('role', 'status'); return p; };
function show(...nodes) { body.replaceChildren(...nodes.filter(Boolean), ...(cfg.back ? [backLink()] : [])); }
function backLink() { const a = el('a', 'back', 'Back to ChatGPT'); a.href = cfg.back; a.rel = 'noopener'; return a; }
const sameWallet = (req, w) => req.chain === 'base' || req.kind === 'evm_tx' ? String(w.address).toLowerCase() === String(req.wallet).toLowerCase() : w.address === req.wallet;

function units(raw, decimals, places) {
  let v = BigInt(raw); const d = BigInt(decimals); const base = 10n ** d;
  const whole = v / base, frac = (v % base).toString().padStart(Number(d), '0');
  const shown = places == null ? frac.replace(/0+$/, '').slice(0, 6) : frac.slice(0, places).padEnd(places, '0');
  return shown ? `${whole}.${shown}` : `${whole}`;
}
const amountOf = (s) => { if (!s) return ''; const usdc = s.asset === 'USDC'; return `${units(s.amount_raw, s.decimals, usdc ? 2 : null)} ${s.asset}`; };
// One Solana request may pay several legs (one transaction, one signature): `legs` / `leg_summaries`; older and Base
// requests name one leg.
const legsOf = (r) => Array.isArray(r?.legs) ? r.legs : [r?.leg];
const summariesOf = (r) => Array.isArray(r?.leg_summaries) ? r.leg_summaries : [{leg: r?.leg, ...(r?.summary ?? {})}];
const requestFor = (reqs, leg) => reqs.find((r) => legsOf(r).includes(leg));
const summaryFor = (reqs, leg) => summariesOf(requestFor(reqs, leg)).find((s) => s.leg === leg);

async function api(path, extra) {
  const token = await signer.accessToken();
  if (!token) { const e = Error('signed out'); e.status = 401; throw e; }
  const r = await fetch(`/sign/api/${path}`, {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json'}, body: JSON.stringify({trade_id: cfg.tradeId, privy_access_token: token, ...extra})});
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  if (!r.ok) { const e = Error(j?.message || 'refused'); e.status = r.status; e.code = j?.code; throw e; }
  return j;
}

// ---- Sign-in (email code; existing YEET users only) --------------------------------------------------------------
function signIn() {
  return new Promise((resolve) => {
    const email = el('input'); email.type = 'email'; email.id = 'sign-email'; email.autocomplete = 'email'; email.inputMode = 'email'; email.autocapitalize = 'none';
    const eLabel = el('label', '', 'Email'); eLabel.htmlFor = 'sign-email';
    const code = el('input'); code.id = 'sign-code'; code.inputMode = 'numeric'; code.autocomplete = 'one-time-code'; code.maxLength = 6;
    const cLabel = el('label', '', '6-digit code'); cLabel.htmlFor = 'sign-code';
    const status = line('');
    const send = el('button', '', 'Send code'); send.id = 'sign-send';
    const go = el('button', '', 'Sign in'); go.id = 'sign-login';
    const codeBox = el('div'); codeBox.hidden = true; codeBox.append(cLabel, code, go);
    send.onclick = async () => {
      const v = email.value.trim(); if (!v) { email.focus(); return; }
      send.disabled = true; status.className = 'line'; status.textContent = 'Sending your code…';
      try { await signer.sendCode(v); status.textContent = `We sent a 6-digit code to ${v}.`; codeBox.hidden = false; send.textContent = 'Send a new code'; code.focus(); }
      catch { status.className = 'line bad'; status.textContent = 'The code didn’t go out. Check the email and try again.'; }
      send.disabled = false;
    };
    go.onclick = async () => {
      go.disabled = true; status.className = 'line'; status.textContent = 'Signing in…';
      try { await signer.login(email.value.trim(), code.value.trim()); resolve(); }
      catch (e) {
        status.className = 'line bad';
        status.textContent = /not exist|no user|sign ?up|not found/i.test(String(e?.message)) ? 'No YEET account uses this email. Use the email you signed up with.' : 'That code didn’t work. Check it and try again.';
        go.disabled = false;
      }
    };
    show(line('Sign in with the email you use for YEET. Your wallet signs this trade, nobody else.'), eLabel, email, send, status, codeBox);
  });
}

// ---- The trade -----------------------------------------------------------------------------------------------------
function render(note) {
  const reqs = trade.sign_requests ?? [];
  const side = trade.direction === 'skeet' ? 'skeet' : 'yeet';
  const nodes = [];
  const all = reqs.flatMap(summariesOf), usdc = all.filter((s) => s.asset === 'USDC');
  const total = el('div', 'total');
  total.append(el('span', `side ${side}`, side === 'skeet' ? 'SKEET' : 'YEET'),
    el('span', 'amt', usdc.length === all.length && all.length ? `${units(usdc.reduce((a, s) => a + BigInt(s.amount_raw), 0n), usdc[0].decimals, 2)} USDC` : `${trade.legs.length} coin${trade.legs.length === 1 ? '' : 's'}`));
  nodes.push(total);
  const ul = el('ul', 'rows');
  for (const l of trade.legs) {
    const st = STATE[local.get(l.leg) ?? l.send_status] ?? ['', ''];
    const li = el('li'); li.dataset.leg = String(l.leg);
    const left = el('span'); left.append(el('span', 'sym', l.symbol), document.createTextNode(' '), el('span', 'amt', amountOf(summaryFor(reqs, l.leg))));
    li.append(left, el('span', `state ${st[1]}`.trim(), st[0]));
    ul.append(li);
  }
  nodes.push(ul);
  if (note) nodes.push(note);
  return nodes;
}

async function load() {
  try { trade = await api('requests'); }
  catch (e) {
    if (e.status === 401) { await signer.logout().catch(() => {}); await signIn(); return load(); }
    if (e.status === 404) return show(line(e.message, 'bad'), signOutButton());
    return show(line(e.status === 403 ? e.message : 'YEET couldn’t reach your trade. Reload to try again.', 'bad'));
  }
  for (const l of trade.legs) local.set(l.leg, l.send_status);
  const reqs = trade.sign_requests ?? [];
  if (!reqs.length) {
    const anySent = trade.legs.some((l) => SENT.has(l.send_status));
    return show(...render(line(anySent ? 'Nothing left to sign. Head back to ChatGPT: your card shows each coin as it lands.' : 'Nothing was sent for this trade. Your funds are still in your wallet. Ask in ChatGPT for a new quote.', anySent ? 'ok' : 'bad')));
  }
  const side = trade.direction === 'skeet' ? 'skeet' : 'yeet';
  const btn = el('button', side, 'Sign with your wallet'); btn.id = 'sign-go';
  const status = line('');
  btn.onclick = () => signAll(btn, status);
  show(...render(), btn, status, el('p', 'fine', 'Your own wallet signs. YEET never holds your keys and only adds the network fee.'));
}

function signOutButton() {
  const b = el('button', 'quiet', 'Sign out'); b.onclick = async () => { await signer.logout().catch(() => {}); await signIn(); load(); };
  return b;
}

async function signAll(btn, status) {
  if (busy) return; busy = true; btn.disabled = true;
  const set = (text, kind = '') => { status.className = `line ${kind}`.trim(); status.textContent = text; };
  try {
    const wallets = await signer.wallets();
    let queue = [...(trade.sign_requests ?? [])];
    const retried = new Set();
    // One wallet signature and one submit per REQUEST; every leg it pays moves together.
    while (queue.length) {
      const req = queue.shift(), covered = legsOf(req);
      if (covered.every((leg) => SENT.has(local.get(leg)))) continue; // signed on an earlier tap
      const w = wallets.find((x) => sameWallet(req, x));
      if (!w) { set('This sign-in has a different wallet than your YEET account. Nothing was sent.', 'bad'); body.append(signOutButton()); return; }
      const mark = (s) => { for (const leg of covered) local.set(leg, s); refresh(); };
      mark('signing_now');
      // One or two wallet calls (a Base basket's first trade: the one-time authorization, then the batch), one submit.
      // A wallet that refuses the authorization method answers `unsupported`; the answer carries per-coin requests.
      let signed;
      try {
        const answers = [];
        for (const b of privyRpcBodies(req)) {
          try { answers.push(await signer.rpc(w.id, b)); }
          catch (e) {
            if (b.method === 'eth_sign7702Authorization' && !/TIMEOUT|FRAME/i.test(String(e?.code ?? e?.message ?? ''))) { signed = UNSUPPORTED_7702; break; }
            throw e;
          }
        }
        signed ??= signedFromWallets(req, answers);
      }
      catch { mark('awaiting_signature'); set('Your wallet didn’t answer. Tap to try again.', 'bad'); btn.disabled = false; return; }
      let out;
      try { out = await api('signature', {leg: req.leg, attempt_id: req.attempt_id, signed}); }
      catch (e) {
        mark('awaiting_signature');
        set(e.code === 'SIGN_EXPIRED' ? 'The signing window closed. Nothing was sent. Ask in ChatGPT for a new quote.' : e.message || 'Your signature didn’t go through. Tap to try again.', 'bad');
        btn.disabled = e.code === 'SIGN_EXPIRED'; return;
      }
      for (const l of out.legs ?? []) local.set(l.leg, l.send_status);
      // Expired: the fresh request covering this request's anchor leg (it may cover fewer legs, or come per leg).
      const fresh = out.sign_requests ?? [];
      const again = requestFor(fresh, req.leg) ?? fresh.find((r) => legsOf(r).some((leg) => covered.includes(leg)));
      if (again && signed === UNSUPPORTED_7702) {
        // Per-coin requests for the same legs: sign each, the way the page always has.
        const mine = fresh.filter((r) => legsOf(r).some((leg) => covered.includes(leg)));
        trade.sign_requests = [...trade.sign_requests.filter((r) => r !== req), ...mine];
        queue.unshift(...mine);
      } else if (again) {
        if (retried.has(req.leg)) { set('The signing window closed. Nothing was sent. Ask in ChatGPT for a new quote.', 'bad'); refresh(); return; }
        retried.add(req.leg);
        const others = fresh.filter((r) => r !== again && legsOf(r).some((leg) => covered.includes(leg)));
        trade.sign_requests = [...trade.sign_requests.filter((r) => r !== req), again, ...others];
        queue.unshift(again, ...others);
      }
      refresh();
    }
    btn.hidden = true;
    const failed = [...local.values()].some((s) => s === 'not_sent' || s === 'failed');
    set(failed ? 'Some coins were not sent. Head back to ChatGPT for the details.' : 'Signed. Head back to ChatGPT: your card shows each coin as it lands.', failed ? 'bad' : 'ok');
  } finally { busy = false; }
}
function refresh() {
  for (const l of trade.legs) {
    const li = body.querySelector(`li[data-leg="${l.leg}"] .state`); if (!li) continue;
    const st = STATE[local.get(l.leg) ?? l.send_status] ?? ['', ''];
    li.className = `state ${st[1]}`.trim(); li.textContent = st[0];
  }
}

async function main() {
  if (!cfg.tradeId) return show(line('Open this page from the YEET card in ChatGPT.'));
  if (!cfg.appId || !window.YeetSigner) return show(line('Signing isn’t available right now. Try again in a minute.', 'bad'));
  try { signer = window.YeetSigner.create({appId: cfg.appId}); } catch { return show(line('Signing isn’t available right now. Try again in a minute.', 'bad')); }
  let user = null;
  show(line('Starting your wallet…'));
  // Privy unreachable or refusing this page: say so instead of waiting forever.
  const deadline = new Promise((_, reject) => setTimeout(() => reject(Error('timeout')), START_MS));
  try { user = await Promise.race([signer.session(), deadline]); } catch { return show(line('Your wallet couldn’t start in this browser. Reload to try again.', 'bad')); }
  if (!user) await signIn();
  show(line('Getting your trade…'));
  await load();
}
main();

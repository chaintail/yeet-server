// Account-bound pages (as/account-bound.mjs): a funding or trade page link minted for ONE account carries a signed
// hint. The pages show only that account's sign-in methods, and after the sign-in the server compares who is there
// with the hint's account. The real routes (sign-page.mjs, fund-page.mjs, terms-page.mjs) on a loopback port, the
// real tokens (shared/link-token.mjs), stand-ins for the identity lookup and the core.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {signRoutes} from '../sign-page.mjs';
import {fundRoutes} from '../fund-page.mjs';
import {termsRoutes} from '../terms-page.mjs';
import {BOUND_RETURN_PATH, BOUND_COOKIE, BOUND_COOKIE_AGE, boundCookieValue, readBoundCookie, hintReader, mismatchBody, expiredBody, switchBody, MISMATCH_LINE, MISMATCH_CODE, EXPIRED_LINK_LINE, EXPIRED_CODE, SWITCH_LABEL} from '../account-bound.mjs';
import {createSignFlow} from '../viewer/sign/flow.mjs';
import * as wr from '../../core/pipeline/wallet-request.mjs';
import {deriveLinkKey, mintLinkToken, verifyLinkToken, HINT_LINK_TTL_S} from '#shared/link-token.mjs';
import {hintFor, loginFacts} from '../../core/account-login.mjs';
import {fundUrlWithHint} from '../../core/fund-link.mjs';

const key = deriveLinkKey('h'.repeat(40));
const GINA = 'yeet-privy-ginaAAAAAAAAAAAAAAAAA', EMIL = 'yeet-privy-emilAAAAAAAAAAAAAAAAA', BOB = 'yeet-privy-bobAAAAAAAAAAAAAAAAAA';
const ORIGIN = 'https://chatgpt.yeet.win', APP = 'cmzyxwvutsrqponmlkjihgfed', TRADE = 't_abcdefghij0123456789';
const USERS = {
  [GINA]: {id: 'did:privy:gina', linked_accounts: [{type: 'google_oauth', email: 'gina@gmail.example'}]},
  [EMIL]: {id: 'did:privy:emil', linked_accounts: [{type: 'email', address: 'eric@chaintail.example'}]},
  [BOB]: {id: 'did:privy:bob', linked_accounts: [{type: 'google_oauth', email: 'bob@gmail.example'}, {type: 'email', address: 'bob@work.example'}]},
};
const hint = (account, extra = {}) => hintFor(account, loginFacts(USERS[account]), {key, ...extra});
const readHint = hintReader((t) => verifyLinkToken(key, t, {purpose: 'hint'}));
// The core as the sign-in server calls it: the trade of its owner. Nothing here answers about another account.
const calls = [];
const core = async (route, account, body) => {
  calls.push({route, account, body});
  if (route === `/sign/trades/${TRADE}/requests`) return account === GINA ? {status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs: [], sign_requests: []}} : {status: 409, body: {error: 'INVALID_ARGUMENT'}};
  if (route === '/terms') return {status: 200, body: {terms: {accepted: false, version: '2026-11-13', statements: []}}};
  return {status: 404, body: null};
};
// The core's record of each account's Privy user and wallets (core /account/wallets).
const WALLETS = {
  [GINA]: {user: 'did:privy:gina', addresses: {base: '0x1111111111111111111111111111111111111111', solana: 'GinaSo1anaAddress11111111111111111111111111'}},
  [EMIL]: {user: 'did:privy:emil', addresses: {base: '0x2222222222222222222222222222222222222222', solana: 'Emi1So1anaAddress11111111111111111111111111'}},
};
let walletsDown = false;
const wallets = async (account) => (walletsDown ? null : WALLETS[account] ?? null);
const TOKENS = {'tok:gina': GINA, 'tok:emil': EMIL, 'tok:bob': BOB, 'tok:stranger': null};
const lookup = async ({privy_access_token: t}) => { if (!Object.hasOwn(TOKENS, t)) throw Error('invalid'); return TOKENS[t]; };
const sessions = {'yeet_session=gina': {id: GINA, csrf: 'c'}, 'yeet_session=emil': {id: EMIL, csrf: 'c'}};
const session = (q) => sessions[q.headers.cookie] ?? null;
const originOK = (q) => q.headers.origin === ORIGIN;

const app = express();
signRoutes(app, {enabled: () => true, appId: () => APP, lookup, core, originOK, asset: null, methods: () => ['google', 'apple'], hint: readHint});
fundRoutes(app, {enabled: () => true, session, hint: readHint, lookup, wallets, originOK});
termsRoutes(app, {session, originOK, formBody: express.urlencoded({extended: false}), core, document: (_r, t, b) => `<title>${t}</title>${b}`, hint: readHint});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
const api = async (path, payload, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN, ...headers}, body: JSON.stringify(payload)});
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return {ok: r.ok, status: r.status, body: j};
};
const pageData = (html, name) => new RegExp(` data-${name}="([^"]*)"`).exec(html)?.[1];

test('the hint: purpose hint, the account id and the methods its Privy user has, signed; no methods or no key, no hint', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const t = hint(GINA, {now});
  assert.deepEqual(verifyLinkToken(key, t, {purpose: 'hint', now}), {m: ['google'], p: 'hint', a: GINA, e: now / 1000 + HINT_LINK_TTL_S});
  const emil = hint(EMIL, {now}); // minted once: two mints a second apart differ in their expiry
  assert.deepEqual(hintReader((x) => verifyLinkToken(key, x, {purpose: 'hint', now}))(emil), {token: emil, account: EMIL, methods: ['email']});
  assert.deepEqual(readHint(hint(BOB)).methods, ['google', 'email'], 'an account with both gets both');
  assert.equal(hintFor(GINA, loginFacts({id: 'did:privy:x', linked_accounts: []}), {key}), null, 'no method known: no hint');
  assert.equal(hintFor(GINA, null, {key}), null, 'Privy did not answer: no hint');
  assert.equal(hintFor(GINA, loginFacts(USERS[GINA]), {key: null}), null);
  assert.equal(verifyLinkToken(key, t, {purpose: 'terms', now}), null, 'a hint is never a terms token');
  assert.equal(fundUrlWithHint(t, 'https://chatgpt.yeet.win/fund'), `https://chatgpt.yeet.win/fund?h=${t}`);
  assert.match(fundUrlWithHint(hint(BOB), 'https://chatgpt.yeet.win/fund'), /^https:\/\/[^\s]{1,500}$/, 'fits the contract https_url');
  assert.equal(fundUrlWithHint(null, 'https://chatgpt.yeet.win/fund'), null);
  assert.equal(fundUrlWithHint(undefined, 'https://chatgpt.yeet.win/fund'), null);
  // No hint, no link: a funding link that names no account is never handed out.
});

test('a hint that is expired, altered, of another purpose or with no known method is no hint', () => {
  const good = hint(GINA), [v, body, sig] = good.split('.');
  const forEmil = Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body, 'base64url')), a: EMIL})).toString('base64url');
  const widened = Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body, 'base64url')), m: ['google', 'email']})).toString('base64url');
  for (const bad of [undefined, '', 'x', hint(GINA, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000}), `${v}.${forEmil}.${sig}`, `${v}.${widened}.${sig}`,
    mintLinkToken(key, {purpose: 'terms', account: GINA, ttl: 600, claims: {v: '2026-11-13', m: ['google']}}),
    mintLinkToken(deriveLinkKey('o'.repeat(40)), {purpose: 'hint', account: GINA, ttl: 600, claims: {m: ['google']}}),
    mintLinkToken(key, {purpose: 'hint', account: GINA, ttl: 600, claims: {m: ['telegram']}}),
    mintLinkToken(key, {purpose: 'hint', account: GINA, ttl: 600, claims: {}})])
    assert.equal(readHint(bad), null, String(bad).slice(0, 30));
  assert.equal(hintReader(() => { throw Error('no key'); })(good), null, 'no key here: no hint, never an error');
});

test('supplied or not: only a parameter that is absent counts as "no hint"; anything else that does not verify is to be refused', () => {
  assert.deepEqual(readHint.state(undefined), {supplied: false, hint: null});
  for (const v of ['', 'junk', ['a', 'b'], 0, {}, hint(GINA).slice(0, -3) + 'AAA']) assert.deepEqual(readHint.state(v), {supplied: true, hint: null}, String(v));
  const good = hint(GINA);
  assert.deepEqual(readHint.state(good), {supplied: true, hint: {token: good, account: GINA, methods: ['google']}});
});

test('the refusal says one line and offers Try again: nothing about the right account, its methods or its address', () => {
  assert.equal(MISMATCH_LINE, 'This is a different YEET account than the one in your ChatGPT.');
  assert.equal(EXPIRED_LINK_LINE, 'This link has expired. Go back to ChatGPT and ask for a new one.');
  const body = mismatchBody({retry: '/account/login?next=fund&h=v1.a.b'});
  assert.ok(body.includes(MISMATCH_LINE)); assert.match(body, /<a class="button" href="\/account\/login\?next=fund&amp;h=v1\.a\.b">Try again<\/a>/);
  assert.doesNotMatch(body, /Google|Apple|email|•|@|again=1/i);
  // Whatever a caller hands in, no account detail can be put on the page.
  assert.equal(mismatchBody({retry: '/x', use: 'Use Google (g•••@g•••.example).'}), mismatchBody({retry: '/x'}));
  for (const evil of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/x"><script>']) assert.doesNotMatch(mismatchBody({retry: evil}), /href=/, evil);
  assert.ok(expiredBody().includes(EXPIRED_LINK_LINE)); assert.doesNotMatch(expiredBody(), /<a |<button|<form/);
  const sw = switchBody({fields: [['csrf', 'c1'], ['next', 'fund'], ['hint', 'v1.a.b'], ['privy_access_token', 'tok"><x'], ['identity_token', undefined]]});
  assert.match(sw, new RegExp(`<button type="submit">${SWITCH_LABEL}</button>`)); assert.equal(SWITCH_LABEL, 'Switch to the account in your ChatGPT');
  assert.match(sw, /name="switch" value="yes"/); assert.match(sw, /name="privy_access_token" value="tok&quot;&gt;&lt;x"/); assert.doesNotMatch(sw, /identity_token/);
});

test('the trade page: only the methods of the link\'s account; with no hint on the link, the default ones; a hint that does not verify is refused', async () => {
  const page = async (h) => (await fetch(`${BASE}/sign?trade_id=${TRADE}${h === undefined ? '' : `&h=${encodeURIComponent(h)}`}`)).text();
  const gina = hint(GINA);
  let html = await page(gina);
  assert.equal(pageData(html, 'methods'), 'google'); assert.equal(pageData(html, 'hint'), gina); assert.equal(pageData(html, 'link'), '');
  html = await page(hint(EMIL));
  assert.equal(pageData(html, 'methods'), 'email', 'an email account sees only email, although email is off by default');
  assert.equal(pageData(await page(hint(BOB)), 'methods'), 'google,email');
  html = await page(undefined);
  assert.equal(pageData(html, 'methods'), 'google,apple'); assert.equal(pageData(html, 'hint'), ''); assert.equal(pageData(html, 'link'), '');
  for (const bad of ['', 'junk', gina.slice(0, -3) + 'AAA', hint(GINA, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000}), '"><script>alert(1)</script>']) {
    html = await page(bad);
    assert.equal(pageData(html, 'link'), 'expired', String(bad).slice(0, 20));
    assert.equal(pageData(html, 'methods'), '', 'no sign-in method is offered on an expired link'); assert.equal(pageData(html, 'hint'), '');
    assert.doesNotMatch(html, /<script>alert|yeet-signer/);
  }
  // The page script stops on that state before anything else.
  const js = await (await fetch(`${BASE}/sign/sign.js`)).text();
  assert.match(js, /async function main\(\) \{\n[^\n]*\n  if \(root\.dataset\.link === 'expired'\) return show\(line\('This link has expired\. Go back to ChatGPT and ask for a new one\.', 'bad'\)\);/);
});

test('the trade page: the server compares who came in with the link\'s account and refuses anyone else, creating nothing and saying nothing about the account', async () => {
  const h = hint(GINA);
  const ok = await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:gina', hint: h});
  assert.equal(ok.status, 200); assert.equal(ok.body.trade_id, TRADE);
  for (const token of ['tok:emil', 'tok:bob', 'tok:stranger']) {
    calls.length = 0;
    for (const path of ['requests', 'signature', 'email-linked']) {
      const r = await api(`/sign/api/${path}`, {trade_id: TRADE, privy_access_token: token, hint: h, leg: 0, attempt_id: 'a'.repeat(64), signed: 'x'});
      assert.equal(r.status, 409, `${token} ${path}`);
      assert.deepEqual(r.body, {code: MISMATCH_CODE, message: MISMATCH_LINE}, 'one line: no method, no address');
    }
    assert.deepEqual(calls, [], 'the core is not asked anything: no trade route, nothing that creates or links, nothing about the account');
  }
  // A token that does not verify is still a 401, hint or not.
  assert.equal((await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'forged', hint: h})).status, 401);
  // F1: a hint that was sent and no longer verifies is REFUSED on every call, for the trade's own owner too. It is
  // never dropped in favour of whoever is here.
  for (const bad of ['', 'junk', h.slice(0, -3) + 'AAA', hint(GINA, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000})])
    for (const token of ['tok:gina', 'tok:emil'])
      for (const path of ['requests', 'signature', 'email-linked']) {
        calls.length = 0;
        const r = await api(`/sign/api/${path}`, {trade_id: TRADE, privy_access_token: token, hint: bad, leg: 0, attempt_id: 'a'.repeat(64), signed: 'x'});
        assert.equal(r.status, 410, `${token} ${path}`); assert.deepEqual(r.body, {code: EXPIRED_CODE, message: EXPIRED_LINK_LINE});
        assert.deepEqual(calls, []);
      }
  // No hint at all: the trade's own owner check decides, as before.
  assert.equal((await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:gina'})).status, 200);
  assert.equal((await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:emil'})).body.code, 'TRADE_NOT_FOUND');
  // Emil cannot bring his own valid hint to Gina's trade either: the hint matches him, the trade does not.
  const own = await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:emil', hint: hint(EMIL)});
  assert.equal(own.status, 404); assert.equal(own.body.code, 'TRADE_NOT_FOUND');
});

test('the trade page flow: another account reads the one line and Try again (a button press ends the session there); an expired link reads its line', async () => {
  let user = {id: 'did:privy:emil', linked_accounts: [{type: 'email', address: 'eric@chaintail.example'}]}, out = 0;
  const signer = {session: async () => user, accessToken: async () => (user ? 'tok:emil' : null), wallets: async () => [], rpc: async () => ({}), logout: async () => { out++; user = null; }};
  const post = (path, payload) => api(`/sign/api/${path}`, payload);
  const flow = createSignFlow({signer, post, wr, tradeId: TRADE, hint: hint(GINA)});
  await flow.begin();
  let s = flow.state();
  assert.equal(s.view, 'mismatch'); assert.equal(s.bound, true);
  assert.equal(s.message, MISMATCH_LINE); assert.equal(s.use, undefined, 'nothing about the right account');
  assert.equal(out, 0, 'nobody is logged out by the refusal itself');
  await flow.useAnother();
  s = flow.state();
  assert.equal(out, 1); assert.equal(s.view, 'signin'); assert.equal(s.bound, false);
  // The right account on the same link goes straight to its trade.
  const ginaSigner = {...signer, session: async () => USERS[GINA], accessToken: async () => 'tok:gina'};
  const gina = createSignFlow({signer: ginaSigner, post, wr, tradeId: TRADE, hint: hint(GINA)});
  await gina.begin();
  assert.notEqual(gina.state().view, 'mismatch'); assert.equal(gina.state().bound, false);
  // The hint ran out while the tab was open: the owner too reads the expired line, never her trade.
  const stale = createSignFlow({signer: ginaSigner, post, wr, tradeId: TRADE, hint: hint(GINA, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000})});
  await stale.begin();
  assert.equal(stale.state().view, 'unavailable'); assert.equal(stale.state().message, EXPIRED_LINK_LINE); assert.equal(stale.state().trade, null);
});

test('the funding page: the hint rides to the sign-in page; another account\'s session is refused; an expired hint is refused whoever is signed in', async () => {
  const get = (h, cookie) => fetch(`${BASE}/fund${h === undefined ? '' : `?h=${encodeURIComponent(h)}`}`, {redirect: 'manual', headers: cookie ? {cookie} : {}});
  const h = hint(EMIL);
  let r = await get(h);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/account/login?next=fund&h=${encodeURIComponent(h)}`);
  r = await get(h, 'yeet_session=emil');
  assert.equal(r.status, 200); assert.equal(pageData(await r.text(), 'hint'), h);
  r = await get(undefined, 'yeet_session=emil');
  assert.equal(r.status, 200); assert.equal(pageData(await r.text(), 'hint'), undefined);
  r = await get(undefined);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/account/login?next=fund', 'no hint at all: the plain sign-in');
  r = await get(h, 'yeet_session=gina');
  assert.equal(r.status, 403);
  let html = await r.text();
  assert.ok(html.includes(MISMATCH_LINE));
  assert.ok(html.includes(`href="/account/login?next=fund&amp;h=${encodeURIComponent(h)}">Try again</a>`));
  assert.doesNotMatch(html, /yeet-fund|fund\.js|emil|•|Use |again=1/, 'no wallet page, nothing about the right account, no logout flag');
  // F1: account A's link, its hint expired or altered, in a browser signed in as B (or as A, or as nobody): the
  // expired state. Never B's funding page.
  for (const bad of ['', 'junk', h.slice(0, -3) + 'AAA', hint(EMIL, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000})])
    for (const cookie of [undefined, 'yeet_session=gina', 'yeet_session=emil']) {
      r = await get(bad, cookie);
      assert.equal(r.status, 410, `${String(bad).slice(0, 12)} ${cookie}`);
      html = await r.text();
      assert.ok(html.includes(EXPIRED_LINK_LINE)); assert.doesNotMatch(html, /yeet-fund|fund\.js|0x|<a class="button"/);
      assert.equal(r.headers.get('location'), null);
    }
});

test('the funding page check: the Privy user in the browser must be the account the page is for; the answer carries that account\'s own addresses', async () => {
  const check = (payload, cookie, headers = {}) => api('/fund/api/check', payload, {...(cookie ? {cookie} : {}), ...headers});
  const emil = {ok: true, user: 'did:privy:emil', addresses: WALLETS[EMIL].addresses};
  assert.deepEqual((await check({privy_access_token: 'tok:emil', hint: hint(EMIL)}, 'yeet_session=emil')).body, emil);
  assert.deepEqual((await check({privy_access_token: 'tok:emil'}, 'yeet_session=emil')).body, emil, 'no hint at all: the session\'s own account');
  // Another Privy user in the browser than the page's account (with the hint, and without: the session's account).
  for (const payload of [{privy_access_token: 'tok:gina', hint: hint(EMIL)}, {privy_access_token: 'tok:gina'}, {privy_access_token: 'tok:stranger', hint: hint(EMIL)}]) {
    const r = await check(payload, 'yeet_session=emil');
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {code: MISMATCH_CODE, message: MISMATCH_LINE}, 'no address, no method, nobody\'s wallets');
  }
  // The link is for Emil, the YEET session is Gina's: refused even when the Privy user is Emil.
  assert.equal((await check({privy_access_token: 'tok:emil', hint: hint(EMIL)}, 'yeet_session=gina')).status, 409);
  // F1: Emil's link with an expired or altered hint, in a browser that is Gina through and through. It used to be
  // approved for Gina and show Gina's address. It is refused, for Gina and for Emil alike.
  for (const bad of ['', 'junk', hint(EMIL).slice(0, -3) + 'AAA', hint(EMIL, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000})])
    for (const [token, cookie] of [['tok:gina', 'yeet_session=gina'], ['tok:emil', 'yeet_session=emil']]) {
      const r = await check({privy_access_token: token, hint: bad}, cookie);
      assert.equal(r.status, 410); assert.deepEqual(r.body, {code: EXPIRED_CODE, message: EXPIRED_LINK_LINE});
    }
  assert.equal((await check({privy_access_token: 'forged', hint: hint(EMIL)}, 'yeet_session=emil')).status, 401);
  assert.equal((await check({privy_access_token: 'tok:emil'}, undefined)).status, 401, 'no YEET session');
  assert.equal((await check({privy_access_token: 'tok:emil'}, 'yeet_session=emil', {origin: 'https://evil.example'})).status, 403);
  // The core cannot say which wallets are the account's: no approval, so the page shows no address.
  walletsDown = true;
  try { const r = await check({privy_access_token: 'tok:emil', hint: hint(EMIL)}, 'yeet_session=emil'); assert.equal(r.status, 503); assert.equal(r.body.ok, undefined); assert.equal(r.body.addresses, undefined); }
  finally { walletsDown = false; }
});

test('the server\'s approval drives what the page shows: A approved, then the browser\'s user becomes B', async () => {
  const {approvalKey, approvalOf, approvedAddresses, currentApproval, readCheck} = await import('../../login/fund-approval.js');
  const r = await api('/fund/api/check', {privy_access_token: 'tok:emil', hint: hint(EMIL)}, {cookie: 'yeet_session=emil'});
  const emilWallets = {base: {address: WALLETS[EMIL].addresses.base}, solana: {address: WALLETS[EMIL].addresses.solana}};
  const ginaWallets = {base: {address: WALLETS[GINA].addresses.base}, solana: {address: WALLETS[GINA].addresses.solana}};
  const kept = approvalOf(approvalKey('did:privy:emil', emilWallets), readCheck(r.status, r.body));
  assert.deepEqual(approvedAddresses({userId: 'did:privy:emil', wallets: emilWallets, approval: currentApproval(kept, approvalKey('did:privy:emil', emilWallets))}), WALLETS[EMIL].addresses);
  // Privy's user changes to Gina under Emil's old "ok": nothing of Gina's is shown, and the next check refuses her.
  const now = currentApproval(kept, approvalKey('did:privy:gina', ginaWallets));
  assert.equal(now.status, 'checking');
  assert.equal(approvedAddresses({userId: 'did:privy:gina', wallets: ginaWallets, approval: now}), null);
  const next = await api('/fund/api/check', {privy_access_token: 'tok:gina', hint: hint(EMIL)}, {cookie: 'yeet_session=emil'});
  assert.deepEqual(readCheck(next.status, next.body), {status: 'mismatch', message: MISMATCH_LINE});
});

test('N1: what a provider return is bound to comes from the server\'s cookie; a missing, stale or altered one is nothing', () => {
  assert.equal(BOUND_RETURN_PATH, '/account/login/bound'); assert.equal(BOUND_COOKIE, 'yeet_bound'); assert.equal(BOUND_COOKIE_AGE, 900);
  const allowed = (n) => n === 'fund' || n === 'terms';
  const h = readHint(hint(EMIL));
  const value = boundCookieValue('fund', h);
  assert.equal(value, `fund.${h.token}`);
  assert.deepEqual(readBoundCookie(`a=1; ${BOUND_COOKIE}=${value}; yeet_login=x`, readHint, allowed), {next: 'fund', hint: h});
  assert.deepEqual(readBoundCookie(`${BOUND_COOKIE}=${boundCookieValue('terms', h)}`, readHint, allowed).next, 'terms');
  const stale = hint(EMIL, {now: Date.now() - (HINT_LINK_TTL_S + 1) * 1000});
  for (const header of [undefined, '', 'yeet_login=x', `${BOUND_COOKIE}=`, `${BOUND_COOKIE}=fund`, `${BOUND_COOKIE}=fund.junk`, `${BOUND_COOKIE}=fund.${stale}`,
    `${BOUND_COOKIE}=fund.${h.token.slice(0, -3)}AAA`, `${BOUND_COOKIE}=account.${h.token}`, `${BOUND_COOKIE}=.${h.token}`, `${BOUND_COOKIE}=${h.token}`, `${BOUND_COOKIE}=fund.${'A'.repeat(700)}`,
    `x${BOUND_COOKIE}=${value}`])
    assert.equal(readBoundCookie(header, readHint, allowed), null, String(header).slice(0, 40));
});

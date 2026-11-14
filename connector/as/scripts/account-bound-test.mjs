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
import {hintReader, expectedReader, useLine, mismatchBody, MISMATCH_LINE, MISMATCH_CODE} from '../account-bound.mjs';
import {createSignFlow} from '../viewer/sign/flow.mjs';
import * as wr from '../../core/pipeline/wallet-request.mjs';
import {deriveLinkKey, mintLinkToken, verifyLinkToken, HINT_LINK_TTL_S} from '#shared/link-token.mjs';
import {hintFor, loginFacts, signInLabels, methodsOf} from '../../core/account-login.mjs';
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
// The core as the sign-in server calls it: the facts of the hinted account, and the trade of its owner.
let privyDown = false;
const calls = [];
const core = async (route, account, body) => {
  calls.push({route, account, body});
  if (route === '/account/sign-in') return privyDown ? {status: 200, body: {known: false, methods: [], labels: {}}} : {status: 200, body: {known: true, methods: methodsOf(loginFacts(USERS[account])), labels: signInLabels(USERS[account])}};
  if (route === `/sign/trades/${TRADE}/requests`) return account === GINA ? {status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs: [], sign_requests: []}} : {status: 409, body: {error: 'INVALID_ARGUMENT'}};
  if (route === '/terms') return {status: 200, body: {terms: {accepted: false, version: '2026-11-13', statements: []}}};
  return {status: 404, body: null};
};
const expected = expectedReader(core);
const TOKENS = {'tok:gina': GINA, 'tok:emil': EMIL, 'tok:bob': BOB, 'tok:stranger': null};
const lookup = async ({privy_access_token: t}) => { if (!Object.hasOwn(TOKENS, t)) throw Error('invalid'); return TOKENS[t]; };
const sessions = {'yeet_session=gina': {id: GINA, csrf: 'c'}, 'yeet_session=emil': {id: EMIL, csrf: 'c'}};
const session = (q) => sessions[q.headers.cookie] ?? null;
const originOK = (q) => q.headers.origin === ORIGIN;

const app = express();
signRoutes(app, {enabled: () => true, appId: () => APP, lookup, core, originOK, asset: null, methods: () => ['google', 'apple'], hint: readHint, expected});
fundRoutes(app, {enabled: () => true, session, hint: readHint, expected, lookup, originOK});
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
  assert.deepEqual(readHint(hint(EMIL)), {token: hint(EMIL), account: EMIL, methods: ['email']});
  assert.deepEqual(readHint(hint(BOB)).methods, ['google', 'email'], 'an account with both gets both');
  assert.equal(hintFor(GINA, loginFacts({id: 'did:privy:x', linked_accounts: []}), {key}), null, 'no method known: no hint');
  assert.equal(hintFor(GINA, null, {key}), null, 'Privy did not answer: no hint');
  assert.equal(hintFor(GINA, loginFacts(USERS[GINA]), {key: null}), null);
  assert.equal(verifyLinkToken(key, t, {purpose: 'terms', now}), null, 'a hint is never a terms token');
  assert.equal(fundUrlWithHint(t, 'https://chatgpt.yeet.win/fund'), `https://chatgpt.yeet.win/fund?h=${t}`);
  assert.match(fundUrlWithHint(hint(BOB), 'https://chatgpt.yeet.win/fund'), /^https:\/\/[^\s]{1,500}$/, 'fits the contract https_url');
  assert.equal(fundUrlWithHint(null, 'https://chatgpt.yeet.win/fund'), 'https://chatgpt.yeet.win/fund');
  assert.deepEqual(signInLabels(USERS[BOB]), {google: 'b•••@g•••.example', apple: null, email: 'b•••@w•••.example'});
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

test('the refusal names the right method with the address masked, and never a full address', async () => {
  assert.equal(MISMATCH_LINE, 'This is a different YEET account than the one in your ChatGPT.');
  assert.deepEqual(await expected(readHint(hint(GINA))), {message: MISMATCH_LINE, use: 'Use Google (g•••@g•••.example).'});
  assert.deepEqual(await expected(readHint(hint(EMIL))), {message: MISMATCH_LINE, use: 'Use the email e•••@c•••.example.'});
  assert.equal((await expected(readHint(hint(BOB)))).use, 'Use Google (b•••@g•••.example) or the email b•••@w•••.example.');
  // Privy does not answer: the methods of the hint itself, with no address.
  privyDown = true;
  try { assert.equal((await expected(readHint(hint(GINA)))).use, 'Use Google.'); assert.equal((await expected(readHint(hint(EMIL)))).use, 'Use the email you joined YEET with.'); }
  finally { privyDown = false; }
  assert.equal(useLine({methods: ['apple'], labels: {apple: 'x•••@p•••.com'}}), 'Use Apple (x•••@p•••.com).');
  // Only a masked form is ever shown: a full address handed in by mistake is dropped.
  assert.equal(useLine({methods: ['google'], labels: {google: 'gina@gmail.example'}}), 'Use Google.');
  assert.equal(useLine({methods: ['google'], labels: {google: '<b>•••@x•••.com'}}), 'Use Google.');
  assert.equal(useLine({methods: []}), null);
  const body = mismatchBody({use: 'Use Google (g•••@g•••.example).', retry: '/account/login?next=fund&h=v1.a.b&again=1'});
  assert.ok(body.includes(MISMATCH_LINE)); assert.match(body, /<a class="button" href="\/account\/login\?next=fund&amp;h=v1\.a\.b&amp;again=1">Try again<\/a>/);
  for (const evil of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/x"><script>']) assert.doesNotMatch(mismatchBody({use: null, retry: evil}), /href=/, evil);
});

test('the trade page: only the methods of the link\'s account; with no valid hint, the default ones', async () => {
  const page = async (h) => (await fetch(`${BASE}/sign?trade_id=${TRADE}${h === undefined ? '' : `&h=${encodeURIComponent(h)}`}`)).text();
  let html = await page(hint(GINA));
  assert.equal(pageData(html, 'methods'), 'google'); assert.equal(pageData(html, 'hint'), hint(GINA));
  html = await page(hint(EMIL));
  assert.equal(pageData(html, 'methods'), 'email', 'an email account sees only email, although email is off by default');
  assert.equal(pageData(await page(hint(BOB)), 'methods'), 'google,email');
  for (const bad of [undefined, 'junk', hint(GINA).slice(0, -3) + 'AAA', '"><script>alert(1)</script>']) {
    html = await page(bad);
    assert.equal(pageData(html, 'methods'), 'google,apple', String(bad)); assert.equal(pageData(html, 'hint'), '', String(bad));
    assert.doesNotMatch(html, /<script>alert/);
  }
});

test('the trade page: the server compares who came in with the link\'s account and refuses anyone else, creating nothing', async () => {
  const h = hint(GINA);
  const ok = await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:gina', hint: h});
  assert.equal(ok.status, 200); assert.equal(ok.body.trade_id, TRADE);
  for (const token of ['tok:emil', 'tok:bob', 'tok:stranger']) {
    calls.length = 0;
    for (const path of ['requests', 'signature', 'email-linked']) {
      const r = await api(`/sign/api/${path}`, {trade_id: TRADE, privy_access_token: token, hint: h, leg: 0, attempt_id: 'a'.repeat(64), signed: 'x'});
      assert.equal(r.status, 409, `${token} ${path}`);
      assert.deepEqual(r.body, {code: MISMATCH_CODE, message: MISMATCH_LINE, use: 'Use Google (g•••@g•••.example).'});
    }
    assert.deepEqual([...new Set(calls.map((c) => c.route))], ['/account/sign-in'], 'no trade route is reached, and nothing that creates or links');
    assert.ok(calls.every((c) => c.account === GINA), 'the core is only asked about the link\'s own account');
  }
  // A token that does not verify is still a 401, hint or not.
  assert.equal((await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'forged', hint: h})).status, 401);
  // A hint that no longer verifies is no hint: the trade's own owner check still refuses another account.
  const stale = await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:emil', hint: h.slice(0, -3) + 'AAA'});
  assert.equal(stale.status, 404); assert.equal(stale.body.code, 'TRADE_NOT_FOUND');
  // Emil cannot bring his own valid hint to Gina's trade either: the hint matches him, the trade does not.
  const own = await api('/sign/api/requests', {trade_id: TRADE, privy_access_token: 'tok:emil', hint: hint(EMIL)});
  assert.equal(own.status, 404); assert.equal(own.body.code, 'TRADE_NOT_FOUND');
});

test('the trade page flow: another account reads the plain line, the right method and Try again; the session there is ended', async () => {
  let user = {id: 'did:privy:emil', linked_accounts: [{type: 'email', address: 'eric@chaintail.example'}]}, out = 0;
  const signer = {session: async () => user, accessToken: async () => (user ? 'tok:emil' : null), wallets: async () => [], rpc: async () => ({}), logout: async () => { out++; user = null; }};
  const post = (path, payload) => api(`/sign/api/${path}`, payload);
  const flow = createSignFlow({signer, post, wr, tradeId: TRADE, hint: hint(GINA)});
  await flow.begin();
  let s = flow.state();
  assert.equal(s.view, 'mismatch'); assert.equal(s.bound, true);
  assert.equal(s.message, MISMATCH_LINE); assert.equal(s.use, 'Use Google (g•••@g•••.example).'); assert.equal(s.who, 'e•••@c•••.example');
  await flow.useAnother();
  s = flow.state();
  assert.equal(out, 1); assert.equal(s.view, 'signin'); assert.equal(s.bound, false); assert.equal(s.use, null);
  // The right account on the same link goes straight to its trade.
  const gina = createSignFlow({signer: {...signer, session: async () => USERS[GINA], accessToken: async () => 'tok:gina'}, post, wr, tradeId: TRADE, hint: hint(GINA)});
  await gina.begin();
  assert.notEqual(gina.state().view, 'mismatch'); assert.equal(gina.state().bound, false);
});

test('the funding page: the hint rides to the sign-in page; a browser signed in as another account is refused', async () => {
  const get = (h, cookie) => fetch(`${BASE}/fund${h ? `?h=${encodeURIComponent(h)}` : ''}`, {redirect: 'manual', headers: cookie ? {cookie} : {}});
  const h = hint(EMIL);
  let r = await get(h);
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/account/login?next=fund&h=${encodeURIComponent(h)}`);
  r = await get('junk');
  assert.equal(r.headers.get('location'), '/account/login?next=fund', 'no valid hint: the plain sign-in, default methods');
  r = await get(h, 'yeet_session=emil');
  assert.equal(r.status, 200); assert.equal(pageData(await r.text(), 'hint'), h);
  r = await get(undefined, 'yeet_session=emil');
  assert.equal(r.status, 200); assert.equal(pageData(await r.text(), 'hint'), undefined);
  r = await get(h, 'yeet_session=gina');
  assert.equal(r.status, 403);
  const html = await r.text();
  assert.ok(html.includes(MISMATCH_LINE)); assert.ok(html.includes('Use the email e•••@c•••.example.'));
  assert.ok(html.includes(`href="/account/login?next=fund&amp;h=${encodeURIComponent(h)}&amp;again=1">Try again</a>`));
  assert.doesNotMatch(html, /yeet-fund|fund\.js|eric@/, 'no wallet page, no full address');
});

test('the funding page check: the Privy user in the browser must be the account the page is for', async () => {
  const check = (payload, cookie, headers = {}) => api('/fund/api/check', payload, {...(cookie ? {cookie} : {}), ...headers});
  assert.deepEqual((await check({privy_access_token: 'tok:emil', hint: hint(EMIL)}, 'yeet_session=emil')).body, {ok: true});
  assert.deepEqual((await check({privy_access_token: 'tok:emil'}, 'yeet_session=emil')).body, {ok: true}, 'no hint: the session\'s own account');
  // Another Privy user in the browser than the page's account (with the hint, and without: the session's account).
  for (const payload of [{privy_access_token: 'tok:gina', hint: hint(EMIL)}, {privy_access_token: 'tok:gina'}, {privy_access_token: 'tok:stranger', hint: hint(EMIL)}]) {
    const r = await check(payload, 'yeet_session=emil');
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {code: MISMATCH_CODE, message: MISMATCH_LINE, use: 'Use the email e•••@c•••.example.'});
  }
  // The link is for Emil, the YEET session is Gina's: refused even when the Privy user is Emil.
  assert.equal((await check({privy_access_token: 'tok:emil', hint: hint(EMIL)}, 'yeet_session=gina')).status, 409);
  // A bad hint is no hint: the session's account decides.
  assert.equal((await check({privy_access_token: 'tok:gina', hint: 'junk'}, 'yeet_session=emil')).status, 409);
  assert.equal((await check({privy_access_token: 'tok:emil', hint: 'junk'}, 'yeet_session=emil')).status, 200);
  assert.equal((await check({privy_access_token: 'forged', hint: hint(EMIL)}, 'yeet_session=emil')).status, 401);
  assert.equal((await check({privy_access_token: 'tok:emil'}, undefined)).status, 401, 'no YEET session');
  assert.equal((await check({privy_access_token: 'tok:emil'}, 'yeet_session=emil', {origin: 'https://evil.example'})).status, 403);
});

test('the terms page with no valid token: the hint rides to the sign-in page', async () => {
  const h = hint(EMIL);
  let r = await fetch(`${BASE}/account/terms?t=expired&h=${encodeURIComponent(h)}`, {redirect: 'manual'});
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), `/account/login?next=terms&h=${encodeURIComponent(h)}`);
  r = await fetch(`${BASE}/account/terms?h=junk`, {redirect: 'manual'});
  assert.equal(r.headers.get('location'), '/account/login?next=terms');
});

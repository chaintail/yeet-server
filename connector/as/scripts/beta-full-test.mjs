// The "beta is full" page and its waitlist form (as/beta-full.mjs): the copy, the back link, and the real routes on a
// loopback port (port 0) with stand-ins for the core and the rate limit. The end-to-end run with the real core, the
// sign-in flows and the store is in test/acceptance.test.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {document} from '../auth-pages.mjs';
import {betaFullRoutes, betaFullBody, waitlistDoneBody, betaFullHref, backPath, BETA_FULL_TITLE, BETA_FULL_LINE, WAITLIST_BUTTON, WAITLIST_DONE, WAITLIST_PATH, WAITLIST_COOKIE} from '../beta-full.mjs';

const ORIGIN = 'https://chatgpt.yeet.win';

test('the copy: heading, line, email field, button, the line back to the sign-in; after the form, the one answer', () => {
  assert.equal(BETA_FULL_TITLE, 'The beta is full');
  assert.equal(BETA_FULL_LINE, 'YEET is in a limited beta and every spot is taken right now. Leave your email and we will tell you when new spots open.');
  assert.equal(WAITLIST_BUTTON, 'Join the waitlist');
  assert.equal(WAITLIST_DONE, 'You are on the list. We will email you when a spot opens.');
  const page = document(BETA_FULL_TITLE, betaFullBody({csrf: 'c'.repeat(48), source: 'chatgpt', back: '/interaction/abc_DEF-1'}));
  assert.match(page, /<h1 id="page-title" class="display">The beta is full<\/h1>/);
  assert.ok(page.includes(`<p class="lead">${BETA_FULL_LINE}</p>`));
  assert.match(page, /<label for="waitlist-email">Email<\/label><input id="waitlist-email" name="email" type="email"/);
  assert.match(page, /<button type="submit">Join the waitlist<\/button>/);
  assert.ok(page.includes('<p class="hint">Already have an account? <a href="/interaction/abc_DEF-1">Sign in</a></p>'));
  const done = waitlistDoneBody('/account/login');
  assert.ok(done.includes(WAITLIST_DONE));assert.ok(done.includes('<a href="/account/login">Sign in</a>'));
  for (const text of [page, done]) assert.doesNotMatch(text, /\b(demo|mock|sample|placeholder|mcp|folio)\b/i);
});

test('the back link and the page address: only the sign-in pages, nothing else', () => {
  assert.equal(backPath('/interaction/abc'), '/interaction/abc');
  for (const bad of [undefined, '', 'https://evil.example/', '//evil.example', '/interaction/../x', '/interaction/a b', '/account/login?next=https://evil.example', '/interaction/' + 'a'.repeat(129)]) assert.equal(backPath(bad), '/account/login', String(bad));
  assert.equal(betaFullHref({source: 'web'}), '/account/waitlist?from=web');
  assert.equal(betaFullHref({source: 'chatgpt', back: '/interaction/u1'}), '/account/waitlist?from=chatgpt&back=%2Finteraction%2Fu1');
  assert.equal(betaFullHref({source: 'other', back: 'https://evil.example'}), '/account/waitlist?from=web');
  assert.ok(betaFullBody({csrf: 'x', email: '"><script>'}).includes('value="&quot;&gt;&lt;script&gt;"'), 'the email is escaped');
});

// ---- the routes ----
let allow = true, coreAnswer = {status: 200, body: {ok: true}}, coreCalls = [];
const app = express();
const formBody = express.urlencoded({extended: false, limit: '32kb'});
const cookie = (r, name, value, age) => r.append('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`);
const send = betaFullRoutes(app, {
  document: (_r, title, body) => document(title, body), cookie, equal: (a, b) => typeof a === 'string' && a === b,
  originOK: (q) => q.headers.origin === ORIGIN, formBody,
  core: async (body) => { coreCalls.push(body); if (coreAnswer === 'down') throw Error('core'); return coreAnswer; },
  limit: () => allow,
});
app.post('/refused', (_q, r) => send(r, {source: 'chatgpt', back: '/interaction/u9'}));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
async function open() {
  const x = await fetch(`${BASE}${WAITLIST_PATH}?from=web`);
  const c = x.headers.getSetCookie().find((s) => s.startsWith(`${WAITLIST_COOKIE}=`)).split(';')[0];
  return {cookie: c, csrf: (await x.text()).match(/name="csrf" value="([0-9a-f]+)"/)[1]};
}
const post = (fields, {cookie: c, origin = ORIGIN} = {}) => fetch(`${BASE}${WAITLIST_PATH}`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded', origin, ...(c ? {cookie: c} : {})}, body: new URLSearchParams(fields)});

test('a refused sign-in answers with the page itself: 403, its own form cookie, no caching', async () => {
  const r = await fetch(`${BASE}/refused`, {method: 'POST'});
  assert.equal(r.status, 403);assert.equal(r.headers.get('cache-control'), 'no-store');assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.getSetCookie().join(';'), new RegExp(`^${WAITLIST_COOKIE}=[0-9a-f]{48}; HttpOnly; SameSite=Lax`));
  const html = await r.text();
  assert.match(html, /name="source" value="chatgpt"/);assert.ok(html.includes('<a href="/interaction/u9">Sign in</a>'));
});

test('the form: refused without the cookie, with another field value, from another origin; nothing reaches the core', async () => {
  coreCalls = [];
  const {cookie: c, csrf} = await open();
  assert.equal((await post({csrf, email: 'a@example.com'})).status, 403, 'no cookie');
  assert.equal((await post({csrf: 'f'.repeat(48), email: 'a@example.com'}, {cookie: c})).status, 403, 'another value');
  assert.equal((await post({email: 'a@example.com'}, {cookie: c})).status, 403, 'no field');
  assert.equal((await post({csrf, email: 'a@example.com'}, {cookie: c, origin: 'https://evil.example'})).status, 403, 'another origin');
  assert.deepEqual(coreCalls, []);
});

test('the form: the core stores it; an invalid address, a core that is down and the rate limit each answer plainly', async () => {
  coreCalls = [];
  let {cookie: c, csrf} = await open();
  let r = await post({csrf, email: 'Ada@Example.com', source: 'chatgpt', back: '/interaction/u1'}, {cookie: c});
  assert.equal(r.status, 200);let html = await r.text();
  assert.ok(html.includes(WAITLIST_DONE));assert.ok(html.includes('<a href="/interaction/u1">Sign in</a>'));
  assert.deepEqual(coreCalls, [{email: 'Ada@Example.com', source: 'chatgpt'}], 'the core validates and lowercases');
  // A source that is not one of the two is the web one.
  ({cookie: c, csrf} = await open());
  await post({csrf, email: 'b@example.com', source: 'elsewhere'}, {cookie: c});
  assert.equal(coreCalls.at(-1).source, 'web');
  coreAnswer = {status: 400, body: {error: 'INVALID_EMAIL'}};
  ({cookie: c, csrf} = await open());
  r = await post({csrf, email: 'nope'}, {cookie: c});
  assert.equal(r.status, 400);html = await r.text();
  assert.ok(html.includes('Enter your email address, like name@example.com.'));assert.match(html, /value="nope"/);
  coreAnswer = 'down';
  ({cookie: c, csrf} = await open());
  r = await post({csrf, email: 'c@example.com'}, {cookie: c});
  assert.equal(r.status, 503);assert.ok((await r.text()).includes('That could not be saved just now.'));
  coreAnswer = {status: 200, body: {ok: true}};
  allow = false;
  const before = coreCalls.length;
  r = await post({csrf, email: 'd@example.com'}, {cookie: c});
  assert.equal(r.status, 429);assert.equal(r.headers.get('retry-after'), '60');
  assert.equal(coreCalls.length, before, 'nothing reaches the core over the limit');
  allow = true;
});

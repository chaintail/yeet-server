// The signer script and the first-party signing page (as/sign-page.mjs) with fake identity and core: headers, cache,
// CORS, the page's policy and copy, and who may read or submit what. The real core path is in test/acceptance.test.mjs.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {signRoutes, signCsp, returnUrl, IMMUTABLE, SHORT_CACHE} from '../sign-page.mjs';
import {signerAsset} from '#shared/signing.mjs';

const ORIGIN = 'https://chatgpt.yeet.win', APP = 'cmzyxwvutsrqponmlkjihgfed', TRADE = 't_abcdefghij0123456789';
const asset = signerAsset();
const calls = [];
let on = true, appId = APP;
// Tokens: 'tok-alice' -> alice's account, 'tok-new' verifies but has no account, anything else does not verify.
const lookup = async ({privy_access_token}) => {
  if (privy_access_token === 'tok-alice') return 'yeet-privy-alice';
  if (privy_access_token === 'tok-new') return null;
  throw Error('invalid');
};
let coreAnswer = null;
const core = async (route, account, body, ms) => { calls.push({route, account, body, ms}); return coreAnswer(route, account, body); };
const app = express();
signRoutes(app, {enabled: () => on, appId: () => appId, lookup, core, originOK: (q) => q.headers.origin === ORIGIN, asset});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
const post = (path, body, origin = ORIGIN) => fetch(BASE + path, {method: 'POST', headers: {'content-type': 'application/json', ...(origin ? {origin} : {})}, body: JSON.stringify(body)});
const BANNED = /\b(demo|mock|sample|placeholder|lorem|todo|fake|test)\b/i;

test('signer script: hashed URL immutable for a year, stable URL 5 minutes, JavaScript, loadable from any card origin', async () => {
  assert.ok(asset, 'vendored signer');
  for (const [path, cache] of [[asset.path, IMMUTABLE], ['/cards/yeet-signer.js', SHORT_CACHE]]) {
    const r = await fetch(BASE + path, {headers: {origin: 'https://card.example'}});
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), cache);
    assert.equal(r.headers.get('etag'), `"${asset.hash}"`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(asset.bytes), `${path}: the vendored bytes`);
  }
  // Another hash never gets bytes under its immutable URL: it is sent to the stable name (a deploy in progress).
  const other = await fetch(`${BASE}/cards/yeet-signer-000000000000.js`, {redirect: 'manual'});
  assert.equal(other.status, 302); assert.equal(other.headers.get('location'), '/cards/yeet-signer.js');
  assert.equal(other.headers.get('cache-control'), 'no-store'); assert.equal((await other.arrayBuffer()).byteLength < 200, true);
  assert.equal((await fetch(`${BASE}/cards/yeet-signer-${asset.hash}.js.map`)).status, 404);
  // Not vendored: nothing to serve.
  const bare = express(); signRoutes(bare, {enabled: () => true, appId: () => APP, lookup, core, originOK: () => true, asset: null});
  const s2 = bare.listen(0, '127.0.0.1'); await new Promise((r) => s2.once('listening', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${s2.address().port}/cards/yeet-signer.js`)).status, 404); }
  finally { await new Promise((r) => s2.close(r)); }
});

test('GET /sign: the page with its own policy, the hashed signer, the trade id; product copy only', async () => {
  const r = await fetch(`${BASE}/sign?trade_id=${TRADE}&redirectUrl=${encodeURIComponent('https://chatgpt.com/c/abc')}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const csp = r.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.equal(csp, signCsp(nonce));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/auth\.privy\.io [^;]*https:\/\/api\.privy\.io/);
  assert.match(csp, /frame-src https:\/\/auth\.privy\.io/);
  const page = await r.text();
  assert.match(page, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, (c) => '\\' + c)}" src="${asset.path}"></script>`));
  assert.match(page, /<script nonce="[^"]+" type="module" src="\/sign\/sign\.js"><\/script>/);
  assert.match(page, new RegExp(`data-app-id="${APP}" data-trade-id="${TRADE}" data-back="https://chatgpt.com/c/abc"`));
  assert.match(page, /<title>Finish your trade · YEET<\/title>/);
  assert.doesNotMatch(page, /<script>(?!<\/script>)/, 'no inline script');
  assert.doesNotMatch(page.replace(/<[^>]+>/g, ' '), BANNED);
  // A bad trade id and a foreign return URL are dropped, never echoed.
  const bad = await (await fetch(`${BASE}/sign?trade_id=%22%3E%3Cscript%3E&redirectUrl=https%3A%2F%2Fevil.example%2F`)).text();
  assert.match(bad, /data-trade-id="" data-back=""/); assert.doesNotMatch(bad, /evil\.example|<script>/);
  // Signing off (no Privy sign-in): the page still answers, without the signer or an app id.
  on = false;
  try { const off = await (await fetch(`${BASE}/sign?trade_id=${TRADE}`)).text(); assert.match(off, /data-app-id=""/); assert.doesNotMatch(off, /yeet-signer/); }
  finally { on = true; }
  assert.equal(returnUrl('https://chatgpt.com/'), 'https://chatgpt.com/');
  for (const v of ['http://chatgpt.com/', 'https://chatgpt.com.evil.example/', 'javascript:alert(1)', '', undefined]) assert.equal(returnUrl(v), null, String(v));
});

test('page assets: script, styles and the wallet-request contract module, same-origin', async () => {
  for (const [path, type] of [['/sign/sign.js', /text\/javascript/], ['/sign/sign.css', /text\/css/], ['/sign/wallet-request.mjs', /text\/javascript/]]) {
    const r = await fetch(BASE + path);
    assert.equal(r.status, 200, path); assert.match(r.headers.get('content-type'), type, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const text = await r.text();
    if (path === '/sign/sign.js') {
      assert.match(text, /from '\/sign\/wallet-request\.mjs'/);
      // Every sentence the page can show is product copy.
      const copy = [...text.matchAll(/'([^'\n]*[a-z][^'\n]*\.)'/g)].map((m) => m[1]);
      assert.ok(copy.length > 10);
      for (const s of copy) assert.doesNotMatch(s, BANNED, s);
    }
    if (path === '/sign/wallet-request.mjs') assert.match(text, /export function privyRpcBody/);
  }
});

test('API: only from this origin, only with a verified Privy token, only for the account linked to it', async () => {
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs: [{leg: 0, symbol: 'WIF', send_status: 'awaiting_signature', extra: 1}], sign_requests: [{trade_id: TRADE, leg: 0}], internal: 'x'}});
  calls.length = 0;
  const ok = {trade_id: TRADE, privy_access_token: 'tok-alice'};
  assert.equal((await post('/sign/api/requests', ok, null)).status, 403, 'no Origin');
  assert.equal((await post('/sign/api/requests', ok, 'https://evil.example')).status, 403, 'foreign Origin');
  const badId = await post('/sign/api/requests', {...ok, trade_id: 't_x'});
  assert.equal(badId.status, 400); assert.equal((await badId.json()).code, 'INVALID_ARGUMENT');
  const noToken = await post('/sign/api/requests', {trade_id: TRADE});
  assert.equal(noToken.status, 401); assert.equal((await noToken.json()).code, 'SIGN_IN_REQUIRED');
  assert.equal((await post('/sign/api/requests', {...ok, privy_access_token: 'forged'})).status, 401);
  const stranger = await post('/sign/api/requests', {...ok, privy_access_token: 'tok-new'});
  assert.equal(stranger.status, 404); assert.equal((await stranger.json()).code, 'TRADE_NOT_FOUND');
  assert.equal(calls.length, 0, 'core is never asked for a caller that did not verify or has no account');
  // The account comes from the token, never from the body.
  const r = await post('/sign/api/requests', {...ok, account: 'yeet-privy-bob', x_yeet_subject: 'yeet-privy-bob'});
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), {trade_id: TRADE, direction: 'yeet', status: 'signing', legs: [{leg: 0, symbol: 'WIF', send_status: 'awaiting_signature'}], sign_requests: [{trade_id: TRADE, leg: 0}]});
  assert.deepEqual(calls, [{route: `/sign/trades/${TRADE}/requests`, account: 'yeet-privy-alice', body: {}, ms: 15000}]);
  // Another account's trade and an unknown trade answer the same (core: INVALID_ARGUMENT, or the subject is unknown).
  for (const [status, body] of [[409, {error: 'INVALID_ARGUMENT'}], [400, null]]) {
    coreAnswer = () => ({status, body});
    const x = await post('/sign/api/requests', ok); assert.equal(x.status, 404); assert.equal((await x.json()).code, 'TRADE_NOT_FOUND');
  }
  coreAnswer = () => ({status: 403, body: null});
  assert.equal((await post('/sign/api/requests', ok)).status, 403);
  coreAnswer = () => { throw Error('core down'); };
  const down = await post('/sign/api/requests', ok); assert.equal(down.status, 502); assert.equal((await down.json()).code, 'TEMPORARILY_UNAVAILABLE');
  on = false;
  try { assert.equal((await post('/sign/api/requests', ok)).status, 404, 'off without the Privy sign-in'); }
  finally { on = true; }
});

test('API: signature goes to core as submit_trade_signature for the token account; refusals keep their code', async () => {
  calls.length = 0;
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, status: 'submitted', legs: [{leg: 0, symbol: 'WIF', send_status: 'signing', tx_hash: 'h'}]}});
  const sig = {trade_id: TRADE, leg: 0, attempt_id: 'a'.repeat(64), signed: 'AQID', privy_access_token: 'tok-alice'};
  const r = await post('/sign/api/signature', sig);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {trade_id: TRADE, status: 'submitted', legs: [{leg: 0, symbol: 'WIF', send_status: 'signing'}]});
  assert.deepEqual(calls, [{route: `/sign/trades/${TRADE}/signature`, account: 'yeet-privy-alice', body: {leg: 0, attempt_id: 'a'.repeat(64), signed: 'AQID'}, ms: 20000}]);
  // An expired attempt answers fresh requests, passed on for one re-sign.
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, status: 'signing', legs: [{leg: 0, symbol: 'WIF', send_status: 'awaiting_signature'}], sign_requests: [{leg: 0, attempt_id: 'b'.repeat(64)}]}});
  assert.deepEqual((await (await post('/sign/api/signature', sig)).json()).sign_requests, [{leg: 0, attempt_id: 'b'.repeat(64)}]);
  coreAnswer = () => ({status: 409, body: {error: 'SIGN_EXPIRED', message: 'The signing window closed.'}});
  const exp = await post('/sign/api/signature', sig);
  assert.equal(exp.status, 409); assert.deepEqual(await exp.json(), {code: 'SIGN_EXPIRED', message: 'The signing window closed.'});
  assert.equal((await post('/sign/api/signature', {...sig, privy_access_token: 'tok-new'})).status, 404);
  assert.equal((await post('/sign/api/signature', sig, 'https://evil.example')).status, 403);
});

test('a 3-leg Solana request (one transaction, one signature): legs and leg_summaries reach the page intact; one submit with the anchor leg', async () => {
  const summary = (leg, to) => ({leg, side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to});
  const req = {trade_id: TRADE, leg: 0, attempt_id: 'c'.repeat(64), kind: 'solana_tx', chain: 'sol', legs: [0, 1, 2],
    summary: {side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to: 'dep0'}, leg_summaries: [summary(0, 'dep0'), summary(1, 'dep1'), summary(2, 'dep2')]};
  const legs = ['WIF', 'BOME', 'TRUMP'].map((symbol, leg) => ({leg, symbol, send_status: 'awaiting_signature'}));
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs, sign_requests: [req]}});
  const ok = {trade_id: TRADE, privy_access_token: 'tok-alice'};
  const page = await (await post('/sign/api/requests', ok)).json();
  assert.equal(page.sign_requests.length, 1);
  assert.deepEqual(page.sign_requests[0].legs, [0, 1, 2]);
  assert.deepEqual(page.sign_requests[0].leg_summaries.map((s) => s.to), ['dep0', 'dep1', 'dep2']);
  calls.length = 0;
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, status: 'submitted', legs: legs.map((l) => ({...l, send_status: 'signing', tx_hash: 'h'}))}});
  const out = await (await post('/sign/api/signature', {...ok, leg: 0, attempt_id: req.attempt_id, signed: 'AQID'})).json();
  assert.deepEqual(out.legs.map((l) => l.send_status), ['signing', 'signing', 'signing'], 'every covered row advances from one submit');
  assert.deepEqual(calls.map((c) => c.body), [{leg: 0, attempt_id: req.attempt_id, signed: 'AQID'}]);
  // The page script signs per request (legs ?? [leg]) and finds a row's request by its covered legs.
  const js = await (await fetch(BASE + '/sign/sign.js')).text();
  assert.match(js, /const legsOf = \(r\) => Array\.isArray\(r\?\.legs\) \? r\.legs : \[r\?\.leg\]/);
  assert.match(js, /legsOf\(r\)\.includes\(leg\)/);
  assert.match(js, /api\('signature', \{leg: req\.leg, attempt_id: req\.attempt_id, signed\}\)/);
});

test('a 2-leg Base evm_7702 request (one batch): reaches the page intact; one 262-character submit moves both rows; the page loops the wallet calls', async () => {
  const summary = (leg, to) => ({leg, side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to});
  const d0 = '0x' + '2'.repeat(40), d1 = '0x' + '3'.repeat(40), wallet = '0x' + 'a'.repeat(40);
  const call = (to) => ({to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', value: '0', data: '0xa9059cbb' + to.slice(2).padStart(64, '0') + (3000000).toString(16).padStart(64, '0')});
  const f = (...pairs) => pairs.map(([name, type]) => ({name, type}));
  const types = {EIP712Domain: f(['name', 'string'], ['version', 'string'], ['chainId', 'uint256'], ['verifyingContract', 'address'], ['salt', 'bytes32']),
    SignedBatchedCall: f(['batchedCall', 'BatchedCall'], ['nonce', 'uint256'], ['keyHash', 'bytes32'], ['executor', 'address'], ['deadline', 'uint256']),
    BatchedCall: f(['calls', 'Call[]'], ['revertOnFailure', 'bool']), Call: f(['to', 'address'], ['value', 'uint256'], ['data', 'bytes'])};
  const req = {trade_id: TRADE, leg: 0, attempt_id: 'd'.repeat(64), kind: 'evm_7702', chain: 'base', wallet, legs: [0, 1], expires_at: '2026-11-13T10:10:00.000Z',
    payload: {type: 'calibur_batch', authorization: {contract: '0x000000005c84F8Fd50b21CAC312528A64437030e', chain_id: 8453, nonce: 0},
      typed_data: {domain: {name: 'Calibur', version: '1.0.0', chainId: 8453, verifyingContract: wallet, salt: '0x' + '0'.repeat(32) + '000000005c84f8fd50b21cac312528a64437030e'},
        types, primary_type: 'SignedBatchedCall', message: {batchedCall: {calls: [call(d0), call(d1)], revertOnFailure: true}, nonce: '1', keyHash: '0x' + '0'.repeat(64), executor: '0x' + 'b'.repeat(40), deadline: '1800000000'}}},
    summary: {side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to: d0}, leg_summaries: [summary(0, d0), summary(1, d1)]};
  const legs = ['WIF', 'BOME'].map((symbol, leg) => ({leg, symbol, send_status: 'awaiting_signature'}));
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs, sign_requests: [req]}});
  const ok = {trade_id: TRADE, privy_access_token: 'tok-alice'};
  const page = await (await post('/sign/api/requests', ok)).json();
  assert.deepEqual(page.sign_requests[0], req);
  const {privyRpcBodies} = await import('../../core/pipeline/wallet-request.mjs');
  assert.deepEqual(privyRpcBodies(page.sign_requests[0]).map((b) => b.method), ['eth_sign7702Authorization', 'eth_signTypedData_v4']);
  calls.length = 0;
  const signed = '0x' + 'ab'.repeat(130);
  coreAnswer = () => ({status: 200, body: {trade_id: TRADE, status: 'submitted', legs: legs.map((l) => ({...l, send_status: 'signing', tx_hash: '0x' + 'c'.repeat(64)}))}});
  const out = await (await post('/sign/api/signature', {...ok, leg: 0, attempt_id: req.attempt_id, signed})).json();
  assert.deepEqual(out.legs.map((l) => l.send_status), ['signing', 'signing'], 'both rows advance together');
  assert.deepEqual(calls.map((c) => c.body), [{leg: 0, attempt_id: req.attempt_id, signed}]);
  const js = await (await fetch(BASE + '/sign/sign.js')).text();
  assert.match(js, /for \(const b of privyRpcBodies\(req\)\)/);
  assert.match(js, /signedFromWallets\(req, answers\)/);
  assert.match(js, /UNSUPPORTED_7702/);
});

// The trade page's flow (as/viewer/sign/flow.mjs) for an account that connected with Google or Apple: the page's own
// routes (as/sign-page.mjs, mounted for real, with a stand-in identity and core) and a stand-in for the Privy client
// the page runs (window.YeetSigner: session, accessToken, wallets, rpc, sendCode, linkEmail, logout). The contract
// module is the real one (core/pipeline/wallet-request.mjs). What it covers:
//   - a session that is already in the browser is recognised: no question, straight to the trade;
//   - no session: the sign-in step, then the same trade; a sign-in that did not carry over is said once;
//   - the session must be the trade's account (the server's check): the mismatch message, who is here, another account;
//   - the press and hold answers every open request of the trade (one for a Solana basket, several on Base), then
//     "Done. Go back to ChatGPT.";
//   - the email step, the normal end of the first trade for an account with no email login: the trade first, then
//     the step (the address Google gave is shown, a typed one only when there is none), the code links an email login
//     to the same Privy user, the server is told and its next basket answer carries the email; "Not now" ends with
//     "Done." and the next visit offers it again; an address of another account, a wrong or expired code and a rate
//     limit each read in plain words and leave the trade alone.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {signRoutes} from '../sign-page.mjs';
import {createSignFlow, personOf, maskEmail, linkProblem, COPY} from '../viewer/sign/flow.mjs';
import {createAccountLogin, withCardAccount} from '../../core/account-login.mjs';
import * as wr from '../../core/pipeline/wallet-request.mjs';

const ORIGIN = 'https://chatgpt.yeet.win', APP = 'cmzyxwvutsrqponmlkjihgfed', TRADE = 't_abcdefghij0123456789';
const SOL_WALLET = '7x3qiZtcsqC2paa7p7XnfUffedPDNP7GvZVuMD7VXvDe', EVM_WALLET = '0x8dC686928241E69D693A7a7A7a7270429e3c6c50';
// Privy users as the page's client returns them (linked_accounts). Gina connected with Google: no email login.
const WALLETS = [{type: 'wallet', wallet_client_type: 'privy', chain_type: 'solana', address: SOL_WALLET, id: 'w-sol'}, {type: 'wallet', wallet_client_type: 'privy', chain_type: 'ethereum', address: EVM_WALLET.toLowerCase(), id: 'w-evm'}];
const GINA = {id: 'did:privy:gina', linked_accounts: [{type: 'google_oauth', email: 'gina@gmail.example', name: 'Gina'}, ...WALLETS]};
const ADA = {id: 'did:privy:ada', linked_accounts: [{type: 'apple_oauth', email: null}, ...WALLETS]};
// Rae chose "Hide My Email" at Apple: Privy holds Apple's relay address for her.
const RAE = {id: 'did:privy:rae', linked_accounts: [{type: 'apple_oauth', email: 'x7k2m9q4rt@privaterelay.appleid.com'}, ...WALLETS]};
// Tess connected with Google; the same address is already the email login of another YEET account of hers.
const TESS = {id: 'did:privy:tess', linked_accounts: [{type: 'google_oauth', email: 'taken@gmail.example', name: 'Tess'}, ...WALLETS]};
const EMIL = {id: 'did:privy:emil', linked_accounts: [{type: 'email', address: 'eric@chaintail.example'}, {type: 'google_oauth', email: 'eric@gmail.example'}, ...WALLETS]};
const BOB = {id: 'did:privy:bob', linked_accounts: [{type: 'google_oauth', email: 'bob@gmail.example'}, {type: 'wallet', wallet_client_type: 'privy', chain_type: 'solana', address: 'BobsOwnWa11et1111111111111111111111111111111', id: 'w-bob'}]};
// The trade is Gina's (and, where a test says so, Ada's or Emil's). Tokens name the Privy user; the server maps them.
const ACCOUNTS = {'tok:did:privy:gina': 'yeet-privy-gina', 'tok:did:privy:ada': 'yeet-privy-ada', 'tok:did:privy:rae': 'yeet-privy-rae', 'tok:did:privy:tess': 'yeet-privy-tess', 'tok:did:privy:emil': 'yeet-privy-emil', 'tok:did:privy:bob': 'yeet-privy-bob'};
const lookup = async ({privy_access_token: t}) => {
  if (t === 'tok:did:privy:nobody') return null;
  if (!Object.hasOwn(ACCOUNTS, t)) throw Error('invalid');
  return ACCOUNTS[t];
};
let owners = new Set(['yeet-privy-gina']), book = null, onRefresh = null;
const calls = [];
const core = async (route, account, body) => {
  calls.push({route, account, body});
  // core.mjs POST /sign/account/login-refresh: forget the cached facts of that account's Privy user.
  if (route === '/sign/account/login-refresh') { onRefresh?.(account); return {status: 200, body: {ok: true}}; }
  if (!owners.has(account)) return {status: 409, body: {error: 'INVALID_ARGUMENT'}};
  return book(route, body);
};
const app = express();
signRoutes(app, {enabled: () => true, appId: () => APP, lookup, core, originOK: (q) => q.headers.origin === ORIGIN, asset: null});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
/** The page's own fetch: same origin, JSON. */
const post = async (path, payload) => {
  const r = await fetch(`${BASE}/sign/api/${path}`, {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN}, body: JSON.stringify(payload)});
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return {ok: r.ok, status: r.status, body: j};
};

const attempt = (n) => String(n).repeat(64).slice(0, 64);
const summary = (leg, to) => ({leg, side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to});
/** A Solana basket: one transaction, one request, three coins. */
function solanaBasket(n = 'a') {
  const sums = [summary(0, 'dep0'), summary(1, 'dep1'), summary(2, 'dep2')];
  return {trade_id: TRADE, leg: 0, attempt_id: attempt(n), kind: 'solana_tx', chain: 'sol', wallet: SOL_WALLET, legs: [0, 1, 2], expires_at: '2026-11-13T12:10:00Z',
    payload: {transaction_base64: Buffer.from(`unsigned basket ${n}`).toString('base64'), last_valid_block_height: '312000000'},
    summary: {side: 'buy', asset: 'USDC', amount_raw: '3000000', decimals: 6, to: 'dep0'}, leg_summaries: sums};
}
/** The same for one coin. */
const one = (n = 'a') => ({...solanaBasket(n), legs: [0], leg_summaries: [summary(0, 'dep0')]});
/** Base, the older way: one request per coin. */
const baseLeg = (leg, n) => ({trade_id: TRADE, leg, attempt_id: attempt(n), kind: 'evm_tx', chain: 'base', wallet: EVM_WALLET, expires_at: '2026-11-13T12:10:00Z',
  payload: {type: 'eip1559', chainId: 8453, to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', value: '0', data: '0xa9059cbb' + '0'.repeat(128), nonce: 7 + leg, gas: '65000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000'},
  summary: {side: 'buy', asset: 'USDC', amount_raw: '8000000', decimals: 6, to: '0x4c1e8a92d6b3f5071e2c9d8a7b6f5e4d3c2b1a09'}});
/** A core that holds one trade: its legs, its open requests, and what a submit answers. */
function trade(symbols, requests, {onSubmit} = {}) {
  const legs = symbols.map((symbol, leg) => ({leg, symbol, send_status: 'awaiting_signature'}));
  let open = requests;
  const submits = [];
  book = (route, body) => {
    if (route.endsWith('/requests')) return {status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'signing', legs, sign_requests: open}};
    submits.push(body);
    const custom = onSubmit?.(body, submits.length, legs);
    if (custom) return custom;
    const req = open.find((r) => r.attempt_id === body.attempt_id);
    if (!req) return {status: 409, body: {error: 'SIGN_EXPIRED', message: 'Time ran out before the trade went out. Nothing was sent.'}};
    for (const l of req.legs ?? [req.leg]) legs[l].send_status = 'signing';
    open = open.filter((r) => r !== req);
    return {status: 200, body: {trade_id: TRADE, status: open.length ? 'signing' : 'submitted', legs}};
  };
  return {legs, submits};
}

/** The stand-in Privy client of the page. `user`: who is in this browser (null: nobody). */
function privy(user, {silent = 0, sessionAfterLogin = null} = {}) {
  const s = {
    user, log: [], rpcs: [],
    async session() { return s.user; },
    async accessToken() { return s.user ? `tok:${s.user.id}` : null; },
    async wallets() { return (s.user?.linked_accounts ?? []).filter((a) => a.type === 'wallet').map((a) => ({address: a.address, id: a.id, chain_type: a.chain_type})); },
    async rpc(walletId, body) {
      s.rpcs.push({walletId, method: body.method});
      if (silent > 0) { silent -= 1; throw Object.assign(Error('Signing timed out'), {code: 'TIMEOUT'}); }
      return body.method === 'signTransaction' ? {data: {signed_transaction: Buffer.from(`by ${walletId} #${s.rpcs.length}`).toString('base64'), encoding: 'base64'}} : {data: {signed_transaction: `0x02f8${String(s.rpcs.length).padStart(4, '0')}ab`}};
    },
    // Refusals in the shape of the Privy client's PrivyApiError: {code, status, message}.
    async sendCode(email) {
      s.log.push(['sendCode', email]);
      if (email.startsWith('bounce')) throw Error('bounced');
      if (email.startsWith('often')) throw Object.assign(Error('Too many requests. Please wait to try again.'), {code: 'too_many_requests', status: 429});
      if (email.startsWith('claimed')) throw Object.assign(Error('User already exists for this address'), {code: 'linked_to_another_user', status: 400});
    },
    async login() { s.user = sessionAfterLogin; return s.user; },
    async linkEmail(email, code) {
      s.log.push(['linkEmail', email, code]);
      if (email.startsWith('taken')) throw Object.assign(Error('User already exists for this address'), {code: 'linked_to_another_user', status: 400});
      // Linked a moment ago from another tab: Privy allows one email per user.
      if (code === '111111') { s.user = {...s.user, linked_accounts: [{type: 'email', address: email}, ...s.user.linked_accounts]}; throw Object.assign(Error('Cannot link more accounts of this type'), {code: 'cannot_link_more_of_type', status: 400}); }
      if (code === '429429') throw Object.assign(Error('Too many requests. Please wait to try again.'), {code: 'too_many_requests', status: 429});
      if (code === '999999') throw Object.assign(Error('Code has expired'), {code: 'invalid_credentials', status: 401});
      if (code !== '123456') throw Object.assign(Error('Invalid email and code combination'), {code: 'invalid_credentials', status: 401});
      s.user = {...s.user, linked_accounts: [{type: 'email', address: email}, ...s.user.linked_accounts]};
      return s.user;
    },
    async logout() { s.log.push(['logout']); s.user = null; },
  };
  return s;
}
function page(signer) {
  const views = [];
  const flow = createSignFlow({signer, post, wr, tradeId: TRADE, onChange: (s) => views.push(s), wait: () => new Promise(() => {})});
  return {flow, views, seen: () => views.map((v) => v.view).filter((v, i, a) => v !== a[i - 1])};
}
const WORDS = /\bsign(?!-in| in\b)\w*|signature|log ?in/i;   // sign, signing, signed, signature: never in front of the person

test('who is here: an email login, or only what Google or Apple gave; the masked form the page shows', () => {
  assert.deepEqual(personOf(GINA), {id: 'did:privy:gina', email: null, google: true, apple: false, oauthEmail: 'gina@gmail.example', label: 'g•••@g•••.example'});
  assert.deepEqual(personOf(ADA), {id: 'did:privy:ada', email: null, google: false, apple: true, oauthEmail: null, label: null});
  assert.equal(personOf(EMIL).email, 'eric@chaintail.example'); assert.equal(personOf(EMIL).label, 'e•••@c•••.example');
  assert.deepEqual(personOf(null), {id: null, email: null, google: false, apple: false, oauthEmail: null, label: null});
  assert.equal(maskEmail('luke@chaintail.xyz'), 'l•••@c•••.xyz'); assert.equal(maskEmail('nope'), null);
  for (const text of Object.values(COPY)) assert.doesNotMatch(text, WORDS, text);
});

test('Google account, already in this browser (it connected here): no question, the trade, one press and hold, done', async () => {
  owners = new Set(['yeet-privy-gina']); calls.length = 0;
  const t = trade(['WIF', 'BOME', 'TRUMP'], [solanaBasket()]);
  const signer = privy(GINA), p = page(signer);
  await p.flow.begin();
  assert.deepEqual(p.seen(), ['starting', 'loading', 'ready'], 'an existing session is never asked again');
  assert.deepEqual(calls.map((c) => [c.route, c.account]), [[`/sign/trades/${TRADE}/requests`, 'yeet-privy-gina']]);
  const ready = p.flow.state();
  assert.equal(ready.trade.sign_requests.length, 1); assert.deepEqual(ready.trade.legs.map((l) => l.symbol), ['WIF', 'BOME', 'TRUMP']);
  assert.equal(signer.rpcs.length, 0, 'nothing reaches the wallet before the press and hold');
  await p.flow.approve();
  assert.deepEqual(signer.rpcs, [{walletId: 'w-sol', method: 'signTransaction'}], 'a Solana basket is one request: one wallet answer');
  assert.equal(t.submits.length, 1); assert.equal(t.submits[0].leg, 0); assert.equal(t.submits[0].attempt_id, attempt('a'));
  const done = p.flow.state();
  assert.equal(done.view, 'done'); assert.equal(done.failed, false);
  assert.equal(done.message, 'Done. Go back to ChatGPT.'); assert.equal(done.kind, 'ok');
  assert.deepEqual(done.local, {0: 'signing', 1: 'signing', 2: 'signing'}, 'every coin of the basket went out together');
  assert.deepEqual(done.link, {stage: 'offer', email: 'gina@gmail.example', fixed: true, relay: false, error: null, wait: false}, 'the email step, with the address Google gave (shown, not typed)');
  assert.ok(p.views.filter((v) => v.view !== 'done').every((v) => v.link === null), 'the step never shows before the trade is out');
  assert.deepEqual(signer.log, [], 'no code, no sign-out');
  // A second hold does nothing: the trade is out.
  await p.flow.approve(); assert.equal(t.submits.length, 1);
});

test('Base, one request per coin: the one press and hold answers each of them, in order', async () => {
  owners = new Set(['yeet-privy-gina']);
  const t = trade(['WIF', 'BOME'], [baseLeg(0, 'b'), baseLeg(1, 'c')]);
  const signer = privy(GINA), p = page(signer);
  await p.flow.begin(); await p.flow.approve();
  assert.deepEqual(signer.rpcs, [{walletId: 'w-evm', method: 'eth_signTransaction'}, {walletId: 'w-evm', method: 'eth_signTransaction'}]);
  assert.deepEqual(t.submits.map((s) => [s.leg, s.attempt_id]), [[0, attempt('b')], [1, attempt('c')]]);
  assert.match(t.submits[0].signed, /^0x02/);
  assert.equal(p.flow.state().view, 'done'); assert.equal(p.flow.state().message, 'Done. Go back to ChatGPT.');
  assert.ok(p.views.some((v) => v.view === 'sending' && v.local[0] === 'signing' && v.local[1] === 'signing_now'), 'the rows move one by one');
});

test('no session in this browser: the sign-in step, then the same trade; a sign-in that did not carry over is said once', async () => {
  owners = new Set(['yeet-privy-gina']); calls.length = 0;
  trade(['WIF'], [one()]);
  const signer = privy(null), p = page(signer);
  await p.flow.begin();
  assert.deepEqual(p.seen(), ['starting', 'signin']); assert.equal(p.flow.state().why, null);
  assert.equal(calls.length, 0, 'the server is not asked before somebody is here');
  // The person came back from Google signed in (the page reloads; the session is in the browser now).
  signer.user = GINA;
  await p.flow.begin({fresh: true});
  assert.equal(p.flow.state().view, 'ready');
  // Came back, and the session is not there (storage did not carry it): the step again, with the reason.
  const lost = page(privy(null));
  await lost.flow.begin({fresh: true});
  assert.equal(lost.flow.state().view, 'signin'); assert.equal(lost.flow.state().why, 'stuck');
});

test('mismatch: another YEET account is here than the trade’s; the page says so, names who is here, and offers another account', async () => {
  owners = new Set(['yeet-privy-gina']); calls.length = 0;
  const t = trade(['WIF'], [one()]);
  const signer = privy(BOB), p = page(signer);
  await p.flow.begin();
  const s = p.flow.state();
  assert.equal(s.view, 'mismatch'); assert.equal(s.kind, 'bad');
  assert.equal(s.message, 'This trade belongs to a different YEET account than the one you’re using here. Use the Google, Apple or email account you connected to ChatGPT with.');
  assert.equal(s.who, 'b•••@g•••.example');
  assert.equal(s.trade, null, 'nothing of the trade is shown to another account');
  assert.doesNotMatch(s.message, WORDS);
  await p.flow.approve();
  assert.equal(signer.rpcs.length, 0); assert.equal(t.submits.length, 0, 'nothing can be approved from a mismatch');
  await p.flow.useAnother();
  assert.deepEqual(signer.log, [['logout']]); assert.equal(p.flow.state().view, 'signin'); assert.equal(p.flow.state().who, null);
  // The right account comes in: the trade.
  signer.user = GINA; await p.flow.begin({fresh: true});
  assert.equal(p.flow.state().view, 'ready');
  // A Google account that is no YEET account at all answers the same way.
  const nobody = page(privy({id: 'did:privy:nobody', linked_accounts: [{type: 'google_oauth', email: 'new@gmail.example'}]}));
  await nobody.flow.begin();
  assert.equal(nobody.flow.state().view, 'mismatch'); assert.equal(nobody.flow.state().who, 'n•••@g•••.example');
  // The right user with another wallet than the request names: refused on the page, before any wallet call.
  trade(['WIF'], [{...one(), wallet: 'SomeOtherWa11et11111111111111111111111111111'}]);
  const odd = privy(GINA), o = page(odd);
  await o.flow.begin(); await o.flow.approve();
  assert.equal(o.flow.state().view, 'mismatch'); assert.equal(o.flow.state().message, COPY.wallet_other); assert.equal(odd.rpcs.length, 0);
});

test('a session the server no longer accepts: ended here, the sign-in step again with the reason', async () => {
  owners = new Set(['yeet-privy-gina']);
  trade(['WIF'], [one()]);
  const signer = privy({id: 'did:privy:stale', linked_accounts: []}), p = page(signer);
  await p.flow.begin();
  assert.equal(p.flow.state().view, 'signin'); assert.equal(p.flow.state().why, 'expired');
  assert.deepEqual(signer.log, [['logout']]);
});

test('the wallet does not answer: nothing is submitted, the hold works again; time running out twice ends it with nothing sent', async () => {
  owners = new Set(['yeet-privy-gina']);
  const t = trade(['WIF', 'BOME', 'TRUMP'], [solanaBasket()]);
  const signer = privy(GINA, {silent: 1}), p = page(signer);
  await p.flow.begin(); await p.flow.approve();
  let s = p.flow.state();
  assert.equal(s.view, 'ready'); assert.equal(s.message, 'Your wallet didn’t answer. Press and hold to try again.'); assert.equal(s.canRetry, true);
  assert.equal(t.submits.length, 0); assert.deepEqual(s.local, {0: 'awaiting_signature', 1: 'awaiting_signature', 2: 'awaiting_signature'});
  await p.flow.approve();
  assert.equal(p.flow.state().view, 'done'); assert.equal(t.submits.length, 1);
  // Expired at the submit, a fresh request comes back, and that one expires too.
  const legs = [{leg: 0, symbol: 'WIF', send_status: 'awaiting_signature'}];
  trade(['WIF'], [one('d')], {onSubmit: (_b, n) => ({status: 200, body: {trade_id: TRADE, status: 'signing', legs, sign_requests: [one(n === 1 ? 'e' : 'f')]}})});
  const again = privy(GINA), q = page(again);
  await q.flow.begin(); await q.flow.approve();
  s = q.flow.state();
  assert.equal(again.rpcs.length, 2, 'answered once more, never a third time');
  assert.equal(s.view, 'ready'); assert.equal(s.canRetry, false);
  assert.equal(s.message, 'Time ran out before the trade went out. Nothing was sent. Ask in ChatGPT for a new quote.');
  await q.flow.approve(); assert.equal(again.rpcs.length, 2);
});

test('nothing open: already out (back to ChatGPT), or closed with nothing sent', async () => {
  owners = new Set(['yeet-privy-gina']);
  const t = trade(['WIF'], []);
  t.legs[0].send_status = 'sent';
  const out = page(privy(GINA)); await out.flow.begin();
  assert.equal(out.flow.state().view, 'nothing'); assert.equal(out.flow.state().sent, true);
  assert.equal(out.flow.state().message, 'Nothing left to do here. Go back to ChatGPT: your card shows each coin as it lands.');
  const c = trade(['WIF'], []);
  c.legs[0].send_status = 'not_sent';
  const closed = page(privy(GINA)); await closed.flow.begin();
  assert.equal(closed.flow.state().sent, false);
  assert.equal(closed.flow.state().message, 'Nothing was sent for this trade. Your funds are still in your wallet. Ask in ChatGPT for a new quote.');
});

const LINKED = 'This device is trusted. Your next trades finish inside ChatGPT. Go back to ChatGPT.';
const TAKEN = 'This email belongs to a different YEET account, so it can’t be added to this one. Your trade is not affected. Try another email, or choose Not now.';
const offerFor = (email, more = {}) => ({stage: 'offer', email, fixed: !!email, relay: false, error: null, wait: false, ...more});

test('approve, then the email step: the trade goes out first; a code to the address Google gave links an email login to the same Privy user; the server is told and its very next basket answer carries the email', async () => {
  owners = new Set(['yeet-privy-gina']);
  const t = trade(['WIF'], [one()]);
  const signer = privy(GINA), p = page(signer);
  // Core's side, the real module (core/account-login.mjs): what a basket answer says about the account, cached as in
  // production, read from the same Privy user the page links the email to. The clock stands still: no minute passes.
  const DIDS = {'yeet-privy-gina': 'did:privy:gina'};
  const facts = createAccountLogin({api: {app: async () => signer.user}, now: () => 0});
  const propose = withCardAccount({lookup: () => facts, didOf: (ctx) => DIDS[ctx.accountId]})(async () => ({proposal_id: 'p_abcdefghij0123456789'}));
  onRefresh = (account) => facts.forget(DIDS[account]);
  try {
    assert.equal((await propose(null, {accountId: 'yeet-privy-gina'})).card_account.email, null, 'before: no email login, so the card hands the trade to the page');
    await p.flow.begin();
    assert.equal(p.flow.state().view, 'ready'); assert.equal(p.flow.state().link, null, 'nothing about the email stands before the press and hold');
    await p.flow.approve();
    assert.equal(t.submits.length, 1, 'the trade is out');
    assert.equal(p.flow.state().view, 'done'); assert.deepEqual(p.flow.state().link, offerFor('gina@gmail.example'));
    assert.deepEqual(signer.log, [], 'no code is sent until the person asks for one');
    await p.flow.linkSend(p.flow.state().link.email);
    assert.deepEqual(signer.log, [['sendCode', 'gina@gmail.example']]);
    assert.deepEqual(p.flow.state().link, offerFor('gina@gmail.example', {stage: 'code'}));
    // "Send again": another code to the same address, the code field stays.
    await p.flow.linkSend('gina@gmail.example');
    assert.equal(signer.log.filter(([what]) => what === 'sendCode').length, 2); assert.equal(p.flow.state().link.stage, 'code');
    assert.equal((await propose(null, {accountId: 'yeet-privy-gina'})).card_account.email, null, 'a code that was only sent changes nothing');
    calls.length = 0;
    await p.flow.linkConfirm(' 123456 ');
    assert.deepEqual(signer.log.at(-1), ['linkEmail', 'gina@gmail.example', '123456']);
    const s = p.flow.state();
    assert.deepEqual(s.link, offerFor('gina@gmail.example', {stage: 'done', masked: 'g•••@g•••.example'}));
    assert.equal(s.view, 'done', 'the trade’s end state stays'); assert.equal(s.message, LINKED); assert.equal(s.kind, 'ok');
    assert.equal(s.person.email, 'gina@gmail.example', 'the same Privy user now has an email login');
    assert.deepEqual(calls, [{route: '/sign/account/login-refresh', account: 'yeet-privy-gina', body: {}}], 'the page tells the server, which drops what it cached about this account');
    assert.deepEqual((await propose(null, {accountId: 'yeet-privy-gina'})).card_account, {user: 'did:privy:gina', email: 'gina@gmail.example', masked: 'g•••@g•••.example', google: true, apple: false, wallets: []},
      'the very next basket answer says so: the card emails the code and the trade finishes inside ChatGPT');
    p.flow.linkSkip(); await p.flow.linkSend('gina@gmail.example');
    assert.equal(p.flow.state().link.stage, 'done', 'nothing reopens a finished step'); assert.equal(signer.log.filter(([what]) => what === 'sendCode').length, 2);
    // The page once more with this account (the card's frame refused the wallet, say): no step, the plain end.
    trade(['WIF'], [one()]);
    const later = page(signer); await later.flow.begin(); await later.flow.approve();
    assert.equal(later.flow.state().link, null); assert.equal(later.flow.state().message, 'Done. Go back to ChatGPT.');
  } finally { onRefresh = null; }
});

test('Not now: "Done. Go back to ChatGPT.", nothing is linked and the server is not told; the next visit of the page offers the step again', async () => {
  owners = new Set(['yeet-privy-gina']);
  const t = trade(['WIF'], [one()]);
  const signer = privy(GINA), p = page(signer);
  await p.flow.begin(); await p.flow.approve();
  await p.flow.linkSend('gina@gmail.example');
  calls.length = 0;
  p.flow.linkSkip();
  let s = p.flow.state();
  assert.equal(s.view, 'done'); assert.equal(s.message, 'Done. Go back to ChatGPT.'); assert.equal(s.kind, 'ok'); assert.equal(s.link.stage, 'skipped');
  await p.flow.linkSend('gina@gmail.example'); await p.flow.linkConfirm('123456');
  assert.equal(p.flow.state().link.stage, 'skipped', 'a skipped step takes nothing more');
  assert.ok(!signer.log.some(([what]) => what === 'linkEmail')); assert.deepEqual(calls, []);
  assert.equal(signer.user, GINA, 'the account is as it was');
  // The same page opened again (the trade is out already): the step is there again, and works from there.
  t.legs[0].send_status = 'sent';
  book = (route) => ({status: 200, body: {trade_id: TRADE, direction: 'yeet', status: 'submitted', legs: t.legs, sign_requests: []}});
  const again = page(signer); await again.flow.begin();
  s = again.flow.state();
  assert.equal(s.view, 'nothing'); assert.equal(s.sent, true); assert.deepEqual(s.link, offerFor('gina@gmail.example'));
  // The next trade on the page: the trade first, then the step again.
  trade(['BOME'], [one('g')]);
  const next = page(signer); await next.flow.begin();
  assert.equal(next.flow.state().view, 'ready'); assert.equal(next.flow.state().link, null);
  await next.flow.approve();
  assert.deepEqual(next.flow.state().link, offerFor('gina@gmail.example'));
  await next.flow.linkSend('gina@gmail.example'); await next.flow.linkConfirm('123456');
  assert.equal(next.flow.state().message, LINKED);
  // A trade that closed with nothing sent offers nothing.
  const c = trade(['WIF'], []); c.legs[0].send_status = 'not_sent';
  const closed = page(privy(GINA)); await closed.flow.begin();
  assert.equal(closed.flow.state().view, 'nothing'); assert.equal(closed.flow.state().link, null);
});

test('the address is a login of ANOTHER YEET account (Privy: linked_to_another_user): said in plain words, the trade is untouched, another address can be typed', async () => {
  owners = new Set(['yeet-privy-tess']);
  const t = trade(['WIF', 'BOME', 'TRUMP'], [solanaBasket()]);
  const signer = privy(TESS), p = page(signer);
  await p.flow.begin(); await p.flow.approve();
  const out = p.flow.state();
  assert.deepEqual(out.link, offerFor('taken@gmail.example'), 'the address Google gave, shown');
  calls.length = 0;
  await p.flow.linkSend(out.link.email); await p.flow.linkConfirm('123456');
  let s = p.flow.state();
  assert.equal(s.link.error, TAKEN);
  assert.equal(s.link.stage, 'offer', 'back to the address'); assert.equal(s.link.fixed, false, 'which can be typed over now');
  assert.equal(s.view, 'done'); assert.equal(s.message, 'Done. Go back to ChatGPT.'); assert.equal(s.failed, false);
  assert.deepEqual(s.local, out.local, 'every coin is where it was'); assert.equal(t.submits.length, 1);
  assert.deepEqual(calls, [], 'the server is told nothing'); assert.ok(!signer.log.some(([what]) => what === 'logout'), 'the session here stays');
  assert.equal(signer.user, TESS);
  // Another address of theirs: the step finishes.
  await p.flow.linkSend('tess@work.example');
  assert.equal(p.flow.state().link.error, null); assert.equal(p.flow.state().link.stage, 'code');
  await p.flow.linkConfirm('123456');
  s = p.flow.state();
  assert.equal(s.link.stage, 'done'); assert.equal(s.link.masked, 't•••@w•••.example'); assert.equal(s.message, LINKED);
  // Privy refusing already when the code is asked for reads the same.
  trade(['WIF'], [one()]);
  const early = page(privy(TESS)); await early.flow.begin(); await early.flow.approve();
  await early.flow.linkSend('claimed@gmail.example');
  assert.equal(early.flow.state().link.error, TAKEN); assert.equal(early.flow.state().link.stage, 'offer'); assert.equal(early.flow.state().link.fixed, false);
  early.flow.linkSkip(); assert.equal(early.flow.state().message, 'Done. Go back to ChatGPT.');
  // How Privy's refusals are told apart.
  assert.equal(linkProblem({code: 'linked_to_another_user', status: 400}), 'taken');
  assert.equal(linkProblem(Error('This email is already linked to another user')), 'taken');
  assert.equal(linkProblem({code: 'cannot_link_more_of_type'}), 'has_one');
  assert.equal(linkProblem({code: 'too_many_requests', status: 429}), 'rate'); assert.equal(linkProblem({status: 429}), 'rate');
  assert.equal(linkProblem({code: 'invalid_credentials', status: 401}), null); assert.equal(linkProblem(undefined), null);
});

test('code errors: a wrong code, an expired code, too many tries, a code that did not go out; each in plain words, the step stays, and the right code still works', async () => {
  owners = new Set(['yeet-privy-ada']);
  const t = trade(['WIF'], [one()]);
  const signer = privy(ADA), p = page(signer);
  await p.flow.begin(); await p.flow.approve();
  const at = () => p.flow.state().link;
  const said = [];
  const says = (text, stage) => { assert.equal(at().error, text); assert.equal(at().stage, stage); assert.equal(at().wait, false); said.push(at().error); };
  await p.flow.linkConfirm('123456'); assert.equal(at().stage, 'offer', 'no code is taken before one was sent');
  await p.flow.linkSend('not an email'); says('Enter your email address, like name@example.com.', 'offer');
  assert.deepEqual(signer.log, []);
  await p.flow.linkSend('bounce@icloud.example'); says('The code didn’t go out. Check the email and try again.', 'offer');
  await p.flow.linkSend('often@icloud.example'); says('Too many tries just now. Wait a minute, then try again.', 'offer');
  await p.flow.linkSend(' ada@icloud.example ');
  assert.deepEqual(at(), offerFor('ada@icloud.example', {stage: 'code', fixed: false}));
  await p.flow.linkConfirm('12'); says('Enter the 6-digit code from the email.', 'code');
  assert.ok(!signer.log.some(([what]) => what === 'linkEmail'), 'a malformed code never reaches Privy');
  await p.flow.linkConfirm('000000'); says('That code didn’t work or has expired. Check the latest email from YEET, or press Send again.', 'code');
  await p.flow.linkConfirm('999999'); says('That code didn’t work or has expired. Check the latest email from YEET, or press Send again.', 'code');
  await p.flow.linkConfirm('429429'); says('Too many tries just now. Wait a minute, then try again.', 'code');
  for (const text of [...said, TAKEN, LINKED]) assert.doesNotMatch(text, WORDS, text);
  assert.equal(p.flow.state().view, 'done'); assert.equal(p.flow.state().message, 'Done. Go back to ChatGPT.'); assert.equal(t.submits.length, 1);
  assert.ok(!signer.log.some(([what]) => what === 'logout'), 'no error ends the session here');
  calls.length = 0;
  await p.flow.linkConfirm('123456');
  assert.equal(at().stage, 'done'); assert.equal(at().error, null); assert.equal(p.flow.state().message, LINKED);
  assert.deepEqual(calls.map((c) => [c.route, c.account]), [['/sign/account/login-refresh', 'yeet-privy-ada']]);
  // The email was linked meanwhile somewhere else (Privy: one email per user): that is the end this step is for.
  trade(['WIF'], [one()]);
  const twice = privy(ADA), q = page(twice);
  await q.flow.begin(); await q.flow.approve(); await q.flow.linkSend('ada@icloud.example'); await q.flow.linkConfirm('111111');
  assert.equal(q.flow.state().link.stage, 'done'); assert.equal(q.flow.state().message, LINKED);
});

test('who meets the step: Google or Apple accounts with no email login; Apple with no address types one, an Apple relay address is shown and can be changed; nobody else', async () => {
  owners = new Set(['yeet-privy-gina', 'yeet-privy-ada', 'yeet-privy-rae', 'yeet-privy-emil']);
  // Apple gave no address: the field is empty and typed.
  trade(['WIF'], [one()]);
  const ada = page(privy(ADA)); await ada.flow.begin(); await ada.flow.approve();
  assert.deepEqual(ada.flow.state().link, {stage: 'offer', email: '', fixed: false, relay: false, error: null, wait: false});
  // Apple's "Hide My Email": the relay address Privy has, shown in the field, and it can be changed.
  trade(['WIF'], [one()]);
  const raeSigner = privy(RAE), rae = page(raeSigner); await rae.flow.begin(); await rae.flow.approve();
  assert.deepEqual(rae.flow.state().link, {stage: 'offer', email: 'x7k2m9q4rt@privaterelay.appleid.com', fixed: false, relay: true, error: null, wait: false});
  await rae.flow.linkSend('rae@icloud.example'); await rae.flow.linkConfirm('123456');
  assert.equal(rae.flow.state().person.email, 'rae@icloud.example'); assert.equal(rae.flow.state().message, LINKED);
  // An account that already has an email login: no step.
  trade(['WIF'], [one()]);
  const emil = page(privy(EMIL)); await emil.flow.begin(); await emil.flow.approve();
  assert.equal(emil.flow.state().view, 'done'); assert.equal(emil.flow.state().link, null); assert.equal(emil.flow.state().message, 'Done. Go back to ChatGPT.');
  // Some coins not sent: the person reads that, and no step.
  const legs = [{leg: 0, symbol: 'WIF', send_status: 'not_sent'}];
  trade(['WIF'], [one()], {onSubmit: () => ({status: 200, body: {trade_id: TRADE, status: 'failed', legs}})});
  const part = page(privy(GINA)); await part.flow.begin(); await part.flow.approve();
  assert.equal(part.flow.state().failed, true); assert.equal(part.flow.state().link, null);
  assert.equal(part.flow.state().message, 'Some coins were not sent. Go back to ChatGPT for the details.');
  // A page whose Privy client cannot link (an older wallet script still cached): the plain end.
  trade(['WIF'], [one()]);
  const old = privy(GINA); delete old.linkEmail;
  const o = page(old); await o.flow.begin(); await o.flow.approve();
  assert.equal(o.flow.state().link, null); assert.equal(o.flow.state().message, 'Done. Go back to ChatGPT.');
});

test('the email-linked route: this origin only, a verified caller only; core is asked to forget, and its outage is not the person’s problem', async () => {
  calls.length = 0;
  const ok = {trade_id: TRADE, privy_access_token: 'tok:did:privy:gina'};
  const foreign = await fetch(`${BASE}/sign/api/email-linked`, {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example'}, body: JSON.stringify(ok)});
  assert.equal(foreign.status, 403);
  assert.equal((await post('email-linked', {trade_id: TRADE, privy_access_token: 'forged'})).status, 401);
  assert.equal((await post('email-linked', {trade_id: TRADE, privy_access_token: 'tok:did:privy:nobody'})).status, 404);
  assert.equal(calls.length, 0);
  assert.deepEqual(await post('email-linked', ok), {ok: true, status: 200, body: {ok: true}});
  assert.deepEqual(calls, [{route: '/sign/account/login-refresh', account: 'yeet-privy-gina', body: {}}]);
  const down = express();
  signRoutes(down, {enabled: () => true, appId: () => APP, lookup, core: async () => { throw Error('core down'); }, originOK: () => true, asset: null});
  const s2 = down.listen(0, '127.0.0.1'); await new Promise((r) => s2.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/sign/api/email-linked`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(ok)});
    assert.equal(r.status, 200);
  } finally { await new Promise((r) => s2.close(r)); }
});

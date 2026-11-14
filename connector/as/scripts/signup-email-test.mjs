// The email step of the connect screen, server side (as/signup-email.mjs): the setting, the signed note of who
// started the step, the checks the sign-in makes with it, and the real route on a loopback port with stand-ins for
// the identity check and the core's lookup.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {signupEmailStep, signupEmailRoutes, mintStepToken, verifyStepToken, stepReader, stepGuard, stepAccount, StepChanged, changedBody, CHANGED_LINE, STEP_PATH, STEP_FIELD, STEP_TTL_S} from '../signup-email.mjs';
import {deriveLinkKey, mintLinkToken, verifyLinkToken} from '#shared/link-token.mjs';

const key = deriveLinkKey('s'.repeat(40)), otherKey = deriveLinkKey('o'.repeat(40));
const GINA = 'yeet-privy-ginaAAAAAAAAAAAAAAAAA', EMIL = 'yeet-privy-emilAAAAAAAAAAAAAAAAA';
const ORIGIN = 'https://chatgpt.yeet.win';
// Privy tokens as the stand-in verifies them: the Privy user, and the YEET account it already has (or none).
const TOKENS = {'tok:gina': {did: 'did:privy:gina', account: GINA}, 'tok:emil': {did: 'did:privy:emil', account: EMIL}, 'tok:new': {did: 'did:privy:new', account: null}};
const identity = async ({privy_access_token: t}) => { if (!Object.hasOwn(TOKENS, t)) throw Error('invalid'); return {provider: 'privy.io', app_id: 'app', did: TOKENS[t].did}; };
let lookups = 0, coreDown = false;
const lookup = async ({privy_access_token: t}) => { lookups++; if (coreDown) throw Error('core'); return TOKENS[t]?.account ?? null; };
const read = stepReader(key);

test('YEET_SIGNUP_EMAIL_STEP: on by default, off with 0, off, false or no; anything else stops the server', () => {
  for (const on of [undefined, null, '', '1', 'on', 'true', 'yes', ' ON ']) assert.equal(signupEmailStep(on), true, String(on));
  for (const off of ['0', 'off', 'false', 'no', ' Off ']) assert.equal(signupEmailStep(off), false, off);
  for (const bad of ['of', 'disabled', '2', 'google']) assert.throws(() => signupEmailStep(bad), /Invalid YEET_SIGNUP_EMAIL_STEP/);
});

test('the note: the Privy user and the account it already has, 15 minutes, its own key', () => {
  const now = 1_800_000_000_000;
  const t = mintStepToken(key, {did: 'did:privy:gina', account: GINA, now});
  assert.deepEqual(verifyStepToken(key, t, {now}), {d: 'did:privy:gina', a: GINA, e: now / 1000 + STEP_TTL_S});
  assert.deepEqual(verifyStepToken(key, mintStepToken(key, {did: 'did:privy:new', now}), {now}).a, null, 'a new person has no account yet');
  assert.equal(verifyStepToken(key, t, {now: now + STEP_TTL_S * 1000}), null, 'expired');
  assert.ok(verifyStepToken(key, t, {now: now + STEP_TTL_S * 1000 - 1}));
  assert.equal(verifyStepToken(otherKey, t, {now}), null, 'another key');
  const [v, body, mac] = t.split('.');
  const forged = Buffer.from(JSON.stringify({d: 'did:privy:emil', a: EMIL, e: now / 1000 + STEP_TTL_S})).toString('base64url');
  assert.equal(verifyStepToken(key, `${v}.${forged}.${mac}`, {now}), null, 'altered claims');
  assert.equal(verifyStepToken(key, `${v}.${body}.${'A'.repeat(43)}`, {now}), null, 'altered mac');
  for (const bad of [undefined, null, '', 'x', 42, [t], {}, `${t}x`, 'e1..', 'v1.' + body + '.' + mac]) assert.equal(verifyStepToken(key, bad, {now}), null);
  assert.throws(() => mintStepToken(key, {did: 'gina', account: GINA}), /Invalid step user/);
  assert.throws(() => mintStepToken(key, {did: 'did:privy:gina', account: 'someone'}), /Invalid step account/);
  assert.throws(() => mintStepToken(Buffer.alloc(8), {did: 'did:privy:gina'}), /Invalid step key/);
});

test('a link token never verifies as a note, and a note never as a link token', () => {
  const hint = mintLinkToken(key, {purpose: 'hint', account: GINA, ttl: 600, claims: {m: ['google']}});
  assert.equal(verifyStepToken(key, hint), null);
  const note = mintStepToken(key, {did: 'did:privy:gina', account: GINA});
  for (const purpose of ['hint', 'terms']) assert.equal(verifyLinkToken(key, note, {purpose}), null);
  assert.equal(verifyLinkToken(key, note.replace(/^e1\./, 'v1.'), {purpose: 'hint'}), null);
});

test('the sign-in with no note is the sign-in as it always was: nobody is verified twice', async () => {
  let asked = 0;
  assert.equal(await stepGuard({privy_access_token: 'tok:gina'}, {read, identity: async (b) => { asked++; return identity(b); }}), null);
  assert.equal(asked, 0);
  assert.doesNotThrow(() => stepAccount(null, GINA));
});

test('same user: the person who signs in is the person the step was started by', async () => {
  const note = mintStepToken(key, {did: 'did:privy:gina', account: GINA});
  const step = await stepGuard({privy_access_token: 'tok:gina', [STEP_FIELD]: note}, {read, identity});
  assert.equal(step.d, 'did:privy:gina');
  assert.doesNotThrow(() => stepAccount(step, GINA));
  // A new person: the note names no account; the sign-in may then create theirs.
  const fresh = await stepGuard({privy_access_token: 'tok:new', [STEP_FIELD]: mintStepToken(key, {did: 'did:privy:new'})}, {read, identity});
  assert.doesNotThrow(() => stepAccount(fresh, 'yeet-privy-newAAAAAAAAAAAAAAAAAA'));
});

test('mismatch: another Privy user, or another account, is refused before anything is resolved', async () => {
  const note = mintStepToken(key, {did: 'did:privy:gina', account: GINA});
  await assert.rejects(stepGuard({privy_access_token: 'tok:emil', [STEP_FIELD]: note}, {read, identity}), (e) => e instanceof StepChanged && e.why === 'user');
  await assert.rejects(stepGuard({privy_access_token: 'tok:new', [STEP_FIELD]: note}, {read, identity}), StepChanged);
  const step = await stepGuard({privy_access_token: 'tok:gina', [STEP_FIELD]: note}, {read, identity});
  assert.throws(() => stepAccount(step, EMIL), (e) => e instanceof StepChanged && e.why === 'account');
  assert.throws(() => stepAccount(step, null), StepChanged);
  // An identity check that answers nothing usable is a refusal, never a pass.
  await assert.rejects(stepGuard({[STEP_FIELD]: note}, {read, identity: async () => ({})}), StepChanged);
  // A credential that does not verify stays what it was: the sign-in's own failure.
  await assert.rejects(stepGuard({privy_access_token: 'tok:nobody', [STEP_FIELD]: note}, {read, identity}), /invalid/);
});

test('a note that was supplied but does not verify is refused, never dropped', async () => {
  const stale = mintStepToken(key, {did: 'did:privy:gina', account: GINA, now: Date.now() - (STEP_TTL_S + 1) * 1000});
  const foreign = mintStepToken(otherKey, {did: 'did:privy:gina', account: GINA});
  const note = mintStepToken(key, {did: 'did:privy:gina', account: GINA});
  for (const bad of [stale, foreign, '', 'nonsense', [note, note], `${note}x`]) {
    let asked = 0;
    await assert.rejects(stepGuard({privy_access_token: 'tok:gina', [STEP_FIELD]: bad}, {read, identity: async (b) => { asked++; return identity(b); }}), (e) => e instanceof StepChanged && e.why === 'expired');
    assert.equal(asked, 0);
  }
  assert.deepEqual(read.state(undefined), {supplied: false, step: null});
  assert.equal(read.state('').supplied, true);
});

test('the refusal page: one plain line, nothing about any account', () => {
  const body = changedBody();
  assert.ok(body.includes(CHANGED_LINE));
  assert.match(body, /Go back to ChatGPT and connect YEET again\./);
  assert.doesNotMatch(body, /did:privy|yeet-privy|@|\bsign(ing|ature)?\b|wallet|device|unlock/i);
});

// ---- the route ----
let enabled = true, on = true;
const app = express();
signupEmailRoutes(app, {enabled: () => enabled, on: () => on, key, identity, lookup, originOK: (q) => q.headers.origin === ORIGIN});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
const post = async (payload, headers = {}) => {
  const r = await fetch(`${BASE}${STEP_PATH}`, {method: 'POST', headers: {'content-type': 'application/json', origin: ORIGIN, ...headers}, body: JSON.stringify(payload)});
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return {status: r.status, body: j, headers: r.headers};
};

test('POST /account/email-step: a note for the caller, with the account looked up and never created', async () => {
  lookups = 0;
  const gina = await post({privy_access_token: 'tok:gina'});
  assert.equal(gina.status, 200);
  assert.equal(gina.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(gina.body), ['step'], 'nothing but the note: no account id, no user id in the clear fields');
  const claims = verifyStepToken(key, gina.body.step);
  assert.equal(claims.d, 'did:privy:gina');
  assert.equal(claims.a, GINA);
  const fresh = await post({privy_access_token: 'tok:new'});
  assert.equal(verifyStepToken(key, fresh.body.step).a, null, 'a person with no account gets a note with none; none was made');
  assert.equal(lookups, 2);
  // The core does not answer: the note binds the Privy user alone.
  coreDown = true;
  const down = await post({privy_access_token: 'tok:gina'});
  coreDown = false;
  assert.equal(down.status, 200);
  assert.deepEqual(verifyStepToken(key, down.body.step), {d: 'did:privy:gina', a: null, e: verifyStepToken(key, down.body.step).e});
});

test('POST /account/email-step: refused without a valid session, from another origin, and when the page is not on Privy', async () => {
  assert.equal((await post({privy_access_token: 'tok:nobody'})).status, 401);
  assert.equal((await post({})).status, 401);
  assert.equal((await post({privy_access_token: 'tok:gina'}, {origin: 'https://evil.example'})).status, 403);
  enabled = false;
  assert.equal((await post({privy_access_token: 'tok:gina'})).status, 404);
  enabled = true;
});

test('the setting off: the route is gone, and a sign-in without a note goes on as before', async () => {
  on = false;
  const r = await post({privy_access_token: 'tok:gina'});
  on = true;
  assert.equal(r.status, 404);
  assert.equal(r.body, null);
  assert.equal(await stepGuard({privy_access_token: 'tok:gina'}, {read, identity}), null);
});

test('the whole trip: start, then the sign-in of the same person passes and of another is refused', async () => {
  const {body: {step}} = await post({privy_access_token: 'tok:gina'});
  const claims = await stepGuard({privy_access_token: 'tok:gina', [STEP_FIELD]: step}, {read, identity});
  assert.doesNotThrow(() => stepAccount(claims, TOKENS['tok:gina'].account));
  await assert.rejects(stepGuard({privy_access_token: 'tok:emil', [STEP_FIELD]: step}, {read, identity}), StepChanged);
});

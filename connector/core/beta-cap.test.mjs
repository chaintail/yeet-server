// The limited beta in the core store: YEET_BETA_USER_CAP (identity-store.mjs betaCap, betaFull, resolveSignUp), the
// waitlist table (waitlist.mjs) and the export script (ops/waitlist-export.mjs). Its own throwaway STATE_DIR; no port.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, statSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'yeet-beta-cap-'));
process.env.STATE_DIR = root;
delete process.env.YEET_BETA_USER_CAP;
delete process.env.YEET_MAX_ACCOUNTS;
after(() => rmSync(root, {recursive: true, force: true}));
const store = await import('./identity-store.mjs');
const {joinWaitlist, waitlistCount, waitlistRows, waitlistEmail, WaitlistError, waitlistUrlFor} = await import('./waitlist.mjs');
const APP = 'beta-cap-test-app';
store.initializeIdentityStore({app: APP});
const who = (n) => ({provider: 'privy.io', app_id: APP, did: `did:privy:beta-${n}`});
const withCap = (value, fn) => {
  const before = process.env.YEET_BETA_USER_CAP;
  if (value === undefined) delete process.env.YEET_BETA_USER_CAP; else process.env.YEET_BETA_USER_CAP = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.YEET_BETA_USER_CAP; else process.env.YEET_BETA_USER_CAP = before; }
};

test('YEET_BETA_USER_CAP: unset or empty is no cap; a whole number up to 1,000,000; anything else stops the core', () => {
  assert.equal(store.betaCap(undefined), null);
  assert.equal(store.betaCap(''), null);
  for (const [v, n] of [['0', 0], ['145', 145], ['1000000', 1000000]]) assert.equal(store.betaCap(v), n, v);
  for (const bad of ['-1', '1.5', 'abc', '1e3', '1000001', ' ', '0x10', '12 users'])
    assert.throws(() => store.betaCap(bad), /Invalid YEET_BETA_USER_CAP/, bad);
  withCap('nope', () => assert.throws(() => store.initializeIdentityStore({app: APP}), /Invalid YEET_BETA_USER_CAP/));
});

test('unset: accounts are created as before (only YEET_MAX_ACCOUNTS applies) and betaFull is false', () => {
  withCap(undefined, () => {
    assert.equal(store.betaFull(), false);
    const a = store.resolveIdentity(who('a'));
    assert.match(a, /^yeet-privy-/);
    assert.deepEqual(store.resolveSignUp(who('a')), {id: a}, 'stable');
    assert.equal(store.accountCount(), 1);
    assert.deepEqual(store.resolveSignUp({...who('x'), app_id: 'other-app'}), {refused: 'INVALID'});
  });
});

test('under the cap a new person gets an account; at the cap a new person is BETA_FULL with no row; existing accounts pass', () => {
  withCap('2', () => {
    assert.equal(store.betaFull(), false);
    const b = store.resolveSignUp(who('b')).id;
    assert.match(b, /^yeet-privy-/);
    assert.equal(store.accountCount(), 2);
    assert.equal(store.betaFull(), true);
    assert.deepEqual(store.resolveSignUp(who('c')), {refused: 'BETA_FULL'});
    assert.equal(store.resolveIdentity(who('c')), undefined);
    assert.equal(store.accountCount(), 2, 'no account row for the refused person');
    assert.equal(store.lookupIdentity(who('c')), undefined);
    // Existing accounts: the same ids, whatever the cap.
    assert.equal(store.resolveIdentity(who('b')), b);
    assert.ok(store.resolveIdentity(who('a')));
  });
  // A cap of 0 admits nobody new; a cap below the count admits nobody new; existing accounts still pass.
  for (const cap of ['0', '1']) withCap(cap, () => {
    assert.deepEqual(store.resolveSignUp(who('d')), {refused: 'BETA_FULL'});
    assert.ok(store.resolveIdentity(who('a')));
  });
  // Raised: the same new person gets in.
  withCap('3', () => assert.match(store.resolveIdentity(who('c')), /^yeet-privy-/));
  // The older hard cap still answers as it did (no beta cap: never BETA_FULL).
  process.env.YEET_MAX_ACCOUNTS = '3';
  try { withCap(undefined, () => assert.deepEqual(store.resolveSignUp(who('e')), {refused: 'MAX_ACCOUNTS'})); }
  finally { delete process.env.YEET_MAX_ACCOUNTS; }
});

test('the waitlist: validated, trimmed, lowercased, kept once with its first time and source', () => {
  assert.equal(waitlistEmail('  Ada.Lovelace+yeet@Example.CO.uk '), 'ada.lovelace+yeet@example.co.uk');
  for (const bad of [undefined, null, 42, '', 'ada', 'ada@', '@example.com', 'ada@example', 'ada@example.c', 'a b@example.com', 'ada@exa mple.com', '"ada"@example.com', 'ada@example.com,bob@example.com', 'ada;@example.com', '<ada@example.com>', 'ada..x@example.com', '.ada@example.com', 'ada.@example.com', 'ada@-example.com', `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(250)}.com`])
    assert.equal(waitlistEmail(bad), null, String(bad));
  assert.deepEqual(joinWaitlist({email: 'Ada@Example.com', source: 'chatgpt'}, {now: 1000}), {email: 'ada@example.com', fresh: true});
  assert.deepEqual(joinWaitlist({email: ' ADA@example.COM ', source: 'web'}, {now: 2000}), {email: 'ada@example.com', fresh: false});
  assert.deepEqual(joinWaitlist({email: 'grace@example.com', source: 'web'}, {now: 3000}), {email: 'grace@example.com', fresh: true});
  assert.throws(() => joinWaitlist({email: 'nope', source: 'web'}), (e) => e instanceof WaitlistError && e.code === 'INVALID_EMAIL');
  assert.throws(() => joinWaitlist({email: 'x@example.com', source: 'mail'}), (e) => e instanceof WaitlistError && e.code === 'INVALID_SOURCE');
  assert.equal(waitlistCount(), 2);
  assert.deepEqual(waitlistRows(), [{email: 'ada@example.com', created_at: 1000, source: 'chatgpt'}, {email: 'grace@example.com', created_at: 3000, source: 'web'}]);
  assert.equal(waitlistUrlFor('https://chatgpt.yeet.win'), 'https://chatgpt.yeet.win/account/waitlist?from=chatgpt');
  assert.equal(waitlistUrlFor('http://127.0.0.1:38312'), null, 'never a link that is not https');
});

test('ops/waitlist-export.mjs: prints the count, writes the CSV (0600), never overwrites, never writes the store', () => {
  joinWaitlist({email: '=cmd@example.com', source: 'web'}, {now: 4000});
  const script = fileURLToPath(new URL('../../ops/waitlist-export.mjs', import.meta.url));
  const out = join(root, 'waitlist.csv');
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {env: {...process.env, STATE_DIR: root}, encoding: 'utf8'});
  let r = run(out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `waitlist 3\nwrote 3 rows to ${out}\n`);
  assert.equal(readFileSync(out, 'utf8'), 'email,created_at,source\n"ada@example.com","1970-01-01T00:00:01.000Z","chatgpt"\n"grace@example.com","1970-01-01T00:00:03.000Z","web"\n"\'=cmd@example.com","1970-01-01T00:00:04.000Z","web"\n');
  assert.equal(statSync(out).mode & 0o777, 0o600);
  r = run(out);
  assert.equal(r.status, 1);assert.match(r.stderr, /exists; choose a new path/);
  r = run();
  assert.equal(r.status, 2);assert.match(r.stderr, /usage/);
  r = spawnSync(process.execPath, [script, join(root, 'none.csv')], {env: {...process.env, STATE_DIR: join(root, 'missing')}, encoding: 'utf8'});
  assert.equal(r.status, 1);assert.match(r.stderr, /no store/);
  assert.equal(existsSync(join(root, 'none.csv')), false);
  assert.equal(waitlistCount(), 3);
});

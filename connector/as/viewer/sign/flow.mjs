// The trade page's flow, with no DOM (as/viewer/sign/sign.js draws it; as/scripts/sign-flow-test.mjs runs it against
// the real routes with a stand-in wallet). The trade card opens the page when the trade cannot be finished inside
// ChatGPT: an account that connected with Google or Apple has no emailed code for the card, or the wallet could not
// answer in the card's frame. Same contract as the card (yeet-win src/trade-signing.js): the server's requests for
// this trade, each answered by the embedded wallet whose address equals the request's `wallet`, through the same
// Privy client (window.YeetSigner, the vendored yeet-signer.js), then submit_trade_signature. The wallet never sends;
// YEET adds the network fee and sends. The card follows trade_status meanwhile.
//
// createSignFlow({signer, post, wr, tradeId, hint, onChange, startMs, wait}) -> {begin, approve, useAnother, linkSend,
//   linkConfirm, linkSkip, state}
//   signer   window.YeetSigner.create(...): session, accessToken, wallets, rpc, logout, sendCode, linkEmail
//   post     (path, body) -> {ok, status, body}: POST /sign/api/<path> on this origin
//   wr       {privyRpcBodies, signedFromWallets} from /sign/wallet-request.mjs
//   hint     the signed hint of the link the page was opened from ('' when none); sent back with every call
//   onChange (state) after every change
//
// state.view:
//   starting     the wallet is loading
//   signin       no session in this browser (`why`: null | expired | stuck). The page shows the sign-in methods.
//   loading      asking for the trade
//   ready        the trade and its open requests: the person presses and holds
//   sending      the wallet is answering / YEET is taking the answers
//   done         every request went out (`failed`: some coins were not sent). `link`: the email step (below)
//   nothing      no open request: already sent (`sent`, with `link` as in done), or the trade closed with nothing sent
//
// state.link (only for an account with no email login, once its trade is out; null otherwise). The trade always comes
// first; this step never stands between the person and the press and hold:
//   stage    offer (the address and "Email me a code") | code (the 6-digit code) | done (linked) | skipped ("Not now":
//            nothing is remembered, so the next visit of the page offers it again)
//   email    the address the code goes to; `fixed`: it is the one Google or Apple gave and is shown, not typed;
//            `relay`: it is an Apple private relay address (shown, editable, with a line saying what happens)
//   mismatch     the session here is another account than the trade's (`who`: masked), or the trade does not exist.
//                `bound`: the page's link was made for one account and this is another
//   unavailable  a refusal or an outage, with its `message`
export const UNSUPPORTED_7702 = 'unsupported';
export const SENT = new Set(['signing', 'awaiting_gas', 'sent']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One Solana request may pay several legs (one transaction, one wallet answer): `legs` / `leg_summaries`; older and
// Base requests name one leg.
export const legsOf = (r) => Array.isArray(r?.legs) ? r.legs : [r?.leg];
export const summariesOf = (r) => Array.isArray(r?.leg_summaries) ? r.leg_summaries : [{leg: r?.leg, ...(r?.summary ?? {})}];
export const requestFor = (reqs, leg) => reqs.find((r) => legsOf(r).includes(leg));
export const summaryFor = (reqs, leg) => summariesOf(requestFor(reqs, leg)).find((s) => s.leg === leg);
const sameWallet = (req, w) => req.chain === 'base' || req.kind === 'evm_tx' ? String(w.address).toLowerCase() === String(req.wallet).toLowerCase() : w.address === req.wallet;

/** l•••@c•••.xyz (the same form the card shows; core/account-login.mjs maskEmail). */
export function maskEmail(email) {
  const m = typeof email === 'string' ? /^([^\s@])[^\s@]*@([^\s@.])[^\s@]*\.([^\s@.]+)$/.exec(email) : null;
  return m ? `${m[1]}•••@${m[2]}•••.${m[3]}` : null;
}
/**
 * Who is here, from the Privy user of the page's session (linked_accounts): `email` is a linked email LOGIN (the
 * card can email a code to it), `oauthEmail` is the address Google or Apple gave (no login by itself).
 */
export function personOf(user) {
  const accounts = Array.isArray(user?.linked_accounts) ? user.linked_accounts : [];
  const mail = (v) => (typeof v === 'string' && EMAIL.test(v) ? v : null);
  const email = mail(accounts.find((a) => a?.type === 'email')?.address);
  const google = accounts.find((a) => a?.type === 'google_oauth'), apple = accounts.find((a) => a?.type === 'apple_oauth');
  const oauthEmail = mail(google?.email) ?? mail(apple?.email);
  return {id: typeof user?.id === 'string' ? user.id : null, email, google: !!google, apple: !!apple, oauthEmail, label: maskEmail(email ?? oauthEmail)};
}

export const COPY = {
  start_failed: 'Your wallet couldn’t start in this browser. Reload to try again.',
  unreachable: 'YEET couldn’t reach your trade. Reload to try again.',
  wallet_silent: 'Your wallet didn’t answer. Press and hold to try again.',
  wallet_other: 'This account has a different wallet than the trade. Nothing was sent.',
  expired: 'Time ran out before the trade went out. Nothing was sent. Ask in ChatGPT for a new quote.',
  retry: 'That didn’t go through. Press and hold to try again.',
  done: 'Done. Go back to ChatGPT.',
  done_partly: 'Some coins were not sent. Go back to ChatGPT for the details.',
  nothing_left: 'Nothing left to do here. Go back to ChatGPT: your card shows each coin as it lands.',
  nothing_sent: 'Nothing was sent for this trade. Your funds are still in your wallet. Ask in ChatGPT for a new quote.',
  link_bad_email: 'Enter your email address, like name@example.com.',
  link_send_failed: 'The code didn’t go out. Check the email and try again.',
  link_bad_code: 'Enter the 6-digit code from the email.',
  link_refused: 'That code didn’t work or has expired. Check the latest email from YEET, or press Send again.',
  link_rate: 'Too many tries just now. Wait a minute, then try again.',
  link_taken: 'This email belongs to a different YEET account, so it can’t be added to this one. Your trade is not affected. Try another email, or choose Not now.',
  linked: 'This device is trusted. Your next trades finish inside ChatGPT. Go back to ChatGPT.',
};
const RELAY = /@privaterelay\.appleid\.com$/i;
/**
 * Why Privy refused a step of the email link (PrivyApiError: `code`, `status`, `message`): `taken` (the address is a
 * login of ANOTHER Privy user: linked_to_another_user), `has_one` (this user already has an email login:
 * cannot_link_more_of_type), `rate` (too_many_requests, 429), else null (a wrong or expired code, or an outage).
 */
export function linkProblem(e) {
  const text = `${e?.code ?? ''} ${e?.privyErrorCode ?? ''} ${e?.status ?? ''} ${e?.message ?? ''}`;
  if (/linked_to_another_user|another user|already (linked|exists|in use)|account_transfer_required/i.test(text)) return 'taken';
  if (/cannot_link_more/i.test(text)) return 'has_one';
  if (/too_many_requests|too many|rate.?limit|\b429\b/i.test(text)) return 'rate';
  return null;
}

export function createSignFlow({signer, post, wr, tradeId, hint = '', onChange = () => {}, startMs = 20000, wait = (ms) => new Promise((r) => setTimeout(r, ms))}) {
  const {privyRpcBodies, signedFromWallets} = wr;
  const st = {view: 'starting', why: null, message: null, kind: '', who: null, bound: false, trade: null, local: {}, failed: false, sent: false, canRetry: true, link: null};
  let person = null, trade = null, busy = false;
  const local = new Map(); // leg -> send_status as this page last saw it
  const snapshot = () => ({...st, trade, local: Object.fromEntries(local), person, link: st.link ? {...st.link} : null});
  const set = (patch) => { Object.assign(st, patch); onChange(snapshot()); };
  const say = (message, kind = '') => set({message, kind});

  async function api(path, extra) {
    const token = await signer.accessToken();
    if (!token) { const e = Error('signed out'); e.status = 401; throw e; }
    const r = await post(path, {trade_id: tradeId, privy_access_token: token, ...(hint ? {hint} : {}), ...extra});
    if (!r.ok) { const e = Error(r.body?.message || 'refused'); e.status = r.status; e.code = r.body?.code; throw e; }
    return r.body;
  }

  /** The session of this browser, then the trade. `fresh`: the page just came back from a sign-in. */
  async function begin({fresh = false} = {}) {
    set({view: 'starting', message: null, kind: '', why: null});
    let user = null;
    // Privy unreachable or refusing this page: say so instead of waiting forever.
    const deadline = wait(startMs).then(() => { throw Error('timeout'); });
    try { user = await Promise.race([signer.session(), deadline]); }
    catch { return set({view: 'unavailable', message: COPY.start_failed, kind: 'bad'}); }
    // A sign-in that did not reach this page's wallet client is said once, never looped silently.
    if (!user) return set({view: 'signin', why: fresh ? 'stuck' : null});
    person = personOf(user);
    return load();
  }

  async function load() {
    set({view: 'loading', message: null, kind: ''});
    try { trade = await api('requests'); }
    catch (e) {
      if (e.status === 401) { await signer.logout().catch(() => {}); person = null; return set({view: 'signin', why: 'expired'}); }
      // The link's hint no longer verifies: one plain line, nothing else. Never the trade of whoever is here.
      if (e.code === 'LINK_EXPIRED') return set({view: 'unavailable', message: e.message, kind: 'bad'});
      // The link was made for another account than the one here: the server's one line, and Try again.
      if (e.code === 'ACCOUNT_MISMATCH') return set({view: 'mismatch', message: e.message, kind: 'bad', who: person?.label ?? null, bound: true});
      if (e.status === 404) return set({view: 'mismatch', message: e.message, kind: 'bad', who: person?.label ?? null});
      return set({view: 'unavailable', message: e.status === 403 ? e.message : COPY.unreachable, kind: 'bad'});
    }
    local.clear();
    for (const l of trade.legs) local.set(l.leg, l.send_status);
    const reqs = trade.sign_requests ?? [];
    if (!reqs.length) {
      const anySent = trade.legs.some((l) => SENT.has(l.send_status));
      // A trade that is already out (the person came back to the page, or said "Not now" before): the email step again.
      return set({view: 'nothing', sent: anySent, message: anySent ? COPY.nothing_left : COPY.nothing_sent, kind: anySent ? 'ok' : 'bad', link: anySent ? offer() : null});
    }
    set({view: 'ready', canRetry: true});
  }

  /** The press and hold: every open request of the trade, one wallet answer and one submit per REQUEST. */
  async function approve() {
    if (busy || !trade || (st.view !== 'ready' && st.view !== 'sending') || !st.canRetry) return;
    busy = true;
    set({view: 'sending', message: null, kind: ''});
    const again = (message, canRetry = true) => set({view: 'ready', message, kind: 'bad', canRetry});
    try {
      const wallets = await signer.wallets();
      let queue = [...(trade.sign_requests ?? [])];
      const retried = new Set();
      while (queue.length) {
        const req = queue.shift(), covered = legsOf(req);
        if (covered.every((leg) => SENT.has(local.get(leg)))) continue; // answered on an earlier hold
        const w = wallets.find((x) => sameWallet(req, x));
        if (!w) return set({view: 'mismatch', message: COPY.wallet_other, kind: 'bad', who: person?.label ?? null});
        const mark = (s) => { for (const leg of covered) local.set(leg, s); set({}); };
        mark('signing_now');
        // One or two wallet calls (a Base basket's first trade: the one-time authorization, then the batch), one submit.
        // A wallet that refuses the authorization method answers `unsupported`; the answer carries per-coin requests.
        let signed;
        try {
          const answers = [];
          for (const b of privyRpcBodies(req, {tradeId})) {
            try { answers.push(await signer.rpc(w.id, b)); }
            catch (e) {
              if (b.method === 'eth_sign7702Authorization' && !/TIMEOUT|FRAME/i.test(String(e?.code ?? e?.message ?? ''))) { signed = UNSUPPORTED_7702; break; }
              throw e;
            }
          }
          signed ??= signedFromWallets(req, answers);
        }
        catch { mark('awaiting_signature'); return again(COPY.wallet_silent); }
        let out;
        try { out = await api('signature', {leg: req.leg, attempt_id: req.attempt_id, signed}); }
        catch (e) {
          mark('awaiting_signature');
          return again(e.code === 'SIGN_EXPIRED' ? COPY.expired : e.message && e.message !== 'refused' ? e.message : COPY.retry, e.code !== 'SIGN_EXPIRED');
        }
        for (const l of out.legs ?? []) local.set(l.leg, l.send_status);
        // Expired: the fresh request covering this request's anchor leg (it may cover fewer legs, or come per leg).
        const fresh = out.sign_requests ?? [];
        const next = requestFor(fresh, req.leg) ?? fresh.find((r) => legsOf(r).some((leg) => covered.includes(leg)));
        if (next && signed === UNSUPPORTED_7702) {
          // Per-coin requests for the same legs: answer each, the way the page always has.
          const mine = fresh.filter((r) => legsOf(r).some((leg) => covered.includes(leg)));
          trade.sign_requests = [...trade.sign_requests.filter((r) => r !== req), ...mine];
          queue.unshift(...mine);
        } else if (next) {
          if (retried.has(req.leg)) return again(COPY.expired, false);
          retried.add(req.leg);
          const others = fresh.filter((r) => r !== next && legsOf(r).some((leg) => covered.includes(leg)));
          trade.sign_requests = [...trade.sign_requests.filter((r) => r !== req), next, ...others];
          queue.unshift(next, ...others);
        }
        set({});
      }
      const failed = [...local.values()].some((s) => s === 'not_sent' || s === 'failed');
      // Once the trade is out, and never before: an account with no email login (Google or Apple) confirms its email
      // here, and the card's emailed code works for it from then on.
      set({view: 'done', failed, message: failed ? COPY.done_partly : COPY.done, kind: failed ? 'bad' : 'ok', link: failed ? null : offer()});
    } finally { busy = false; }
  }
  /** The email step for who is here, or null (an account that has an email login, or is not Google or Apple). */
  function offer() {
    if (!person || person.email || !(person.google || person.apple) || typeof signer.linkEmail !== 'function') return null;
    const given = person.oauthEmail ?? '', relay = RELAY.test(given);
    return {stage: 'offer', email: given, fixed: !!given && !relay, relay, error: null, wait: false};
  }

  /** Another account is here than the trade's: end this session, the page shows the sign-in methods again. */
  async function useAnother() {
    await signer.logout().catch(() => {});
    person = null; trade = null; local.clear();
    set({view: 'signin', why: null, message: null, kind: '', who: null, bound: false});
  }

  // ---- The optional email step (Privy: an email can be linked to the signed-in user with a code; one per user) ----
  const link = (patch) => set({link: {...st.link, ...patch}});
  async function linkSend(email) {
    if (!st.link || st.link.wait || (st.link.stage !== 'offer' && st.link.stage !== 'code')) return;
    const address = String(email ?? '').trim();
    if (!EMAIL.test(address)) return link({error: COPY.link_bad_email});
    link({wait: true, error: null, email: address});
    try { await signer.sendCode(address); link({stage: 'code', wait: false}); }
    catch (e) {
      const why = linkProblem(e);
      // An address of another account can be typed over, also when it was the one Google or Apple gave.
      link({wait: false, error: why === 'taken' ? COPY.link_taken : why === 'rate' ? COPY.link_rate : COPY.link_send_failed, ...(why === 'taken' ? {stage: 'offer', fixed: false} : {})});
    }
  }
  async function linkConfirm(code) {
    if (!st.link || st.link.wait || st.link.stage !== 'code') return;
    const value = String(code ?? '').trim();
    if (!/^[0-9]{6}$/.test(value)) return link({error: COPY.link_bad_code});
    link({wait: true, error: null});
    let user;
    try { user = await signer.linkEmail(st.link.email, value); }
    catch (e) {
      const why = linkProblem(e);
      // The trade is out either way: nothing here touches it.
      if (why === 'taken') return link({wait: false, error: COPY.link_taken, stage: 'offer', fixed: false});
      // This user already has an email login (linked in another tab): that is the end this step is for.
      if (why === 'has_one') { try { user = await signer.session(); } catch { user = null; } }
      if (!personOf(user).email) return link({wait: false, error: why === 'rate' ? COPY.link_rate : COPY.link_refused});
    }
    const now = personOf(user);
    if (now.id && now.email) person = now;
    // Tell the server at once (it drops its cached answer about this account). Best effort: it reads Privy again
    // within a minute either way.
    try { await api('email-linked', {}); } catch { /* the next basket still finds the email, a minute later at most */ }
    set({message: COPY.linked, kind: 'ok', link: {...st.link, stage: 'done', wait: false, error: null, masked: maskEmail(now.email ?? st.link.email)}});
  }
  const linkSkip = () => { if (st.link && st.link.stage !== 'done') link({stage: 'skipped', error: null}); };

  return {begin, approve, useAnother, linkSend, linkConfirm, linkSkip, state: snapshot};
}

// Self-contained presentation for the YEET sign-in pages.
export function html(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
// Every page: the ground (gradient and stars), the wordmark, one card. Styles and scripts are same-origin files
// (viewer/), so the page needs no inline code under any of the sign-in server's content policies.
export function document(title,body,nonce){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#06071C">${nonce?`<meta property="csp-nonce" content="${html(nonce)}">`:""}<title>${html(title)}</title><link rel="icon" type="image/svg+xml" href="/account/icon.svg"><link rel="stylesheet" href="/account/brand/tokens.css"><link rel="stylesheet" href="/account/auth-pages.css"><script defer src="/account/brand/type-data.js"></script><script defer src="/account/page.js"></script></head><body><div class="ground" aria-hidden="true"><div class="aura"></div><div class="scrim"></div><div class="stars" data-stars="18"></div></div><header class="top"><img class="logo" src="/account/brand/logo.svg" alt="yeet.win" width="147" height="28"></header><main><section class="card" aria-labelledby="page-title"><h1 id="page-title" class="display">${html(title)}</h1>${body}</section></main></body></html>`}
// Product titles for interaction prompts; the local development-identity build is marked in the title only.
export function promptTitle(name,agent=false){const to=agent?'your agent':'ChatGPT';const base=name==='login'?'Sign in to YEET':name==='connect-login'?`Sign in to connect YEET to ${to}`:`Connect YEET to ${to}`;return process.env.PRIVY_LOGIN==='1'?base:`${base} (local)`}
// The agent case (an OAuth client of class agent): who is asking, said before anything else on the page. The client's own
// name (client_name from its registration) is escaped; the loopback address is its redirect's host:port.
export function agentAsk(name,redirect){let at='';try{at=new URL(String(redirect)).host}catch{}const n=String(name??'').trim();return `<p class="lead">A coding agent on this computer is asking to connect to your YEET account${n?`: <strong>${html(n)}</strong>`:''}${at?` (${html(at)})`:''}.</p><p>Only continue if you started this yourself.</p>`}
// Development identity field (TEST_PROFILE=1 and DEV_IDENTITY_STUB=1 only); production uses the Privy bundle.
export function credentials(){return '<label for="identity_token">Development identity</label><input id="identity_token" name="identity_token" autocomplete="off" autocapitalize="none" spellcheck="false">'}

// Browser-facing OAuth errors from the provider (renderError): the same page as a refused connection, plus the code.
/** The refusal for a link that is not a valid authorization (an unknown client, a foreign redirect): either class may land here. */
export const UNKNOWN_CLIENT_LINE='This sign-in link is not valid. Start again from ChatGPT or from your agent.';
export function providerErrorPage(code){const c=/^[a-z_]{1,64}$/.test(String(code))?String(code):'invalid_request';return document('Connection refused',`<p>${UNKNOWN_CLIENT_LINE}</p><p class="details">Error code: ${html(c)}</p>`)}
export const expiredAuthorizationBody = '<p>This authorization page expired or its sign-in session changed. Go back to ChatGPT and connect YEET again.</p>';

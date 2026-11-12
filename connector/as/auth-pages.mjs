// Self-contained presentation for the Folio identity pages.
export function html(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
export function document(title,body,nonce){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${nonce?`<meta property="csp-nonce" content="${html(nonce)}">`:""}<title>${html(title)}</title><link rel="stylesheet" href="/demo/auth-pages.css"></head><body><main><section class="card" aria-labelledby="page-title"><h1 id="page-title">${html(title)}</h1>${body}</section></main></body></html>`}
// Product titles for interaction prompts; the local mock-identity build is marked in the title only.
export function promptTitle(name){const base=name==='login'?'Log in to Folio':'Connect Folio to ChatGPT';return process.env.PRIVY_LOGIN==='1'?base:`${base} (local)`}
export function credentials(){return '<label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"><label for="password">Passcode</label><input id="password" name="password" type="password" autocomplete="current-password">'}

export const expiredAuthorizationBody = '<p>This authorization page expired or its sign-in session changed. Return to ChatGPT and connect Folio again.</p>';
export function renewableConsentCopy(window) {
  const duration = (seconds) => seconds % 3600 === 0 ? `${seconds / 3600} hours` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  return `<label><input type="checkbox" name="renewable_consent" value="yes"> Allow ChatGPT to renew access for ${duration(window)} from first issuance.</label>`;
}

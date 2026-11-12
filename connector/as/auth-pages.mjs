// Self-contained presentation for the YEET sign-in pages.
export function html(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
export function document(title,body,nonce){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${nonce?`<meta property="csp-nonce" content="${html(nonce)}">`:""}<title>${html(title)}</title><link rel="stylesheet" href="/demo/auth-pages.css"></head><body><main><section class="card" aria-labelledby="page-title"><h1 id="page-title">${html(title)}</h1>${body}</section></main></body></html>`}
// Product titles for interaction prompts; the local development-identity build is marked in the title only.
export function promptTitle(name){const base=name==='login'?'Sign in to YEET':'Connect YEET to ChatGPT';return process.env.PRIVY_LOGIN==='1'?base:`${base} (local)`}
// Development identity field (TEST_PROFILE=1 and DEV_IDENTITY_STUB=1 only); production uses the Privy bundle.
export function credentials(){return '<label for="identity_token">Development identity</label><input id="identity_token" name="identity_token" autocomplete="off" autocapitalize="none" spellcheck="false">'}

export const expiredAuthorizationBody = '<p>This authorization page expired or its sign-in session changed. Go back to ChatGPT and connect YEET again.</p>';
export function renewableConsentCopy(window) {
  const duration = (seconds) => seconds % 3600 === 0 ? `${seconds / 3600} hours` : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  return `<label><input type="checkbox" name="renewable_consent" value="yes"> Allow ChatGPT to renew access for ${duration(window)} from first issuance.</label>`;
}

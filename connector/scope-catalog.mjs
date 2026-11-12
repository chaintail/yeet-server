/** The sole catalog used by AS, core, MCP, renewable grants and introspection. */
export const baseScopes = Object.freeze(['folio:profile:read','folio:portfolio:read','folio:research:write']);
export const realScope = 'folio:real:read';
export const allScopes = Object.freeze([...baseScopes, realScope]);
export const consentScopes = Object.freeze(['openid','offline_access',...allScopes]);
// Real is advertised only when FOLIO_ADVERTISE_REAL=1; it is off by default.
export function realAdvertised(env = process.env) {
 return env.FOLIO_ADVERTISE_REAL === '1';
}
export const advertisedScopes = () => ['openid','offline_access',...(realAdvertised() ? allScopes : baseScopes)];
export const grantedSubset = (requested, realConsent) => [...new Set(requested)].filter(s => consentScopes.includes(s) && (s !== realScope || realConsent));
// Refresh can only repeat the immutable consent. Requested extras never widen it.
export const refreshScopes = stored => [...new Set(stored)].filter(s => consentScopes.includes(s));

/** The sole catalog used by AS, core, connector, renewable grants and introspection. */
// yeet:read  home, coins, trade status, portfolio, leaderboard
// yeet:write proposals, quotes, daily spin
// yeet:trade money movement (execute_trade)
export const baseScopes = Object.freeze(['yeet:read','yeet:write','yeet:trade']);
export const allScopes = baseScopes;
export const consentScopes = Object.freeze(['openid','offline_access',...allScopes]);
export const advertisedScopes = () => ['openid','offline_access',...allScopes];
export const grantedSubset = requested => [...new Set(requested)].filter(s => consentScopes.includes(s));
// Refresh can only repeat the immutable consent. Requested extras never widen it.
export const refreshScopes = stored => [...new Set(stored)].filter(s => consentScopes.includes(s));

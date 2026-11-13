/** The sole catalog used by AS, core, connector, renewable grants and introspection. */
// yeet:read    overview, home, coins, trade status, portfolio, leaderboard, the terms
// yeet:write   proposals, quotes, daily spin, what the person confirms in the chat (terms, win code)
// yeet:prepare preparing a trade the person confirms themselves in the card (execute_trade, submit_trade_signature)
//
// yeet:trade is the OLD NAME of yeet:prepare (renamed 2026-11-13: the old name read as if ChatGPT could trade for the
// person). It is never advertised any more, but a token, grant or refresh token that carries it keeps working and
// counts as yeet:prepare everywhere a scope is checked (hasScope / expandScopes). A client that still asks for
// yeet:trade (cached metadata) is granted it under the old name.
export const baseScopes = Object.freeze(['yeet:read','yeet:write','yeet:prepare']);
export const SCOPE_ALIASES = Object.freeze({'yeet:trade':'yeet:prepare'});
export const legacyScopes = Object.freeze(Object.keys(SCOPE_ALIASES));
/** Every scope name the servers accept: the advertised ones and the old names. */
export const allScopes = Object.freeze([...baseScopes,...legacyScopes]);
export const consentScopes = Object.freeze(['openid','offline_access',...allScopes]);
/** What discovery, the protected-resource metadata and the re-authorization challenge name: never an old name. */
export const advertisedScopes = () => ['openid','offline_access',...baseScopes];
export const canonicalScope = s => SCOPE_ALIASES[s] ?? s;
/** The scopes a token carries, with each old name also counted under its current name. */
export const expandScopes = list => new Set([...list].flatMap(s => [s,canonicalScope(s)]));
/** True when the granted list holds `needed` under its current or its old name. */
export const hasScope = (granted,needed) => expandScopes(granted).has(canonicalScope(needed));
export const grantedSubset = requested => [...new Set(requested)].filter(s => consentScopes.includes(s));
// Refresh can only repeat the immutable consent. Requested extras never widen it.
export const refreshScopes = stored => [...new Set(stored)].filter(s => consentScopes.includes(s));

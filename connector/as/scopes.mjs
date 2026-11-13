import {allScopes,advertisedScopes} from '#scope-catalog';
// Scopes the AS registers and issues: the advertised catalog minus the OIDC scopes.
// The old name yeet:trade stays issuable (never advertised): a client that still asks for it, and every grant and
// refresh token that carries it, keeps working (scope-catalog.mjs).
export const issuableScopes = Object.freeze([...advertisedScopes().filter(s => allScopes.includes(s)), ...allScopes.filter(s => !advertisedScopes().includes(s))]);

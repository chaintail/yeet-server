import {allScopes,advertisedScopes} from '#scope-catalog';
// Scopes the AS registers and issues: the advertised catalog minus the OIDC scopes.
export const issuableScopes = Object.freeze(advertisedScopes().filter(s => allScopes.includes(s)));

import {allScopes,advertisedScopes} from '#scope-catalog';
// Scopes the AS registers and issues. Real is never registered or issued until FOLIO_ADVERTISE_REAL=1.
export const issuableScopes = Object.freeze(advertisedScopes().filter(s => allScopes.includes(s)));

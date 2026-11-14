// Connector error catalogue: reads `x-yeet-errors` from the vendored yeet-win contract
// (vendor/yeet-win/contracts/yeet-tools.json, commit in vendor/yeet-win/PINNED) and refuses to load a catalogue
// that disagrees with the failure enum. node:fs only.
import {readFileSync} from 'node:fs';

export const CONTRACT_URL=new URL('../vendor/yeet-win/contracts/yeet-tools.json',import.meta.url);
const contract=JSON.parse(readFileSync(CONTRACT_URL,'utf8'));
const catalog=contract['x-yeet-errors'];
const enumCodes=contract.$defs?.failure?.properties?.error?.enum;
const invalid=reason=>{throw new Error(`yeet-tools.json x-yeet-errors: ${reason}`)};
if(!catalog||typeof catalog!=='object')invalid('missing');
if(!Array.isArray(enumCodes))invalid('$defs.failure error enum missing');
const codes=Object.keys(catalog);
if(codes.length!==enumCodes.length||enumCodes.some(code=>!codes.includes(code)))invalid('keys must equal the failure enum');
for(const [code,entry] of Object.entries(catalog)){
 if(typeof entry.retryable!=='boolean')invalid(`${code}: retryable required`);
 for(const k of ['title','message'])if(typeof entry[k]!=='string'||!entry[k])invalid(`${code}: ${k} required`);
}
/** Anything that is not a catalogue code becomes this one (an outage: the result is not known). */
export const UNKNOWN='TEMPORARILY_UNAVAILABLE';
/** The one sentence a TEMPORARILY_UNAVAILABLE refusal may carry in place of the catalogue text: the ledger route's
 * solver cannot put up the USDC for this trade (checked at the tap, before the person is asked for anything). */
export const CANNOT_FILL_MESSAGE='YEET cannot fill this right now. Nothing was traded.';
if(!codes.includes(UNKNOWN))invalid(`${UNKNOWN} missing`);

const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value)}return value};
export const TOOL_ERRORS=deepFreeze(structuredClone(catalog));
export const FAILURE_CODES=Object.freeze([...enumCodes]);
/** Codes this server adds to the public catalogue, in the same shape (title, message, retryable). They are not in the
 * pinned contract's failure enum: an error result carries no structuredContent, so no output schema checks them. A card
 * built from the public contract does not list them (what it draws for one is the card's own fallback). The model's guidance for them is in
 * the connector's guidance.mjs COPY.errors with the other refusals.
 * BETA_FULL: a ChatGPT person with no YEET account while the limited beta is full (core/identity-store.mjs betaFull);
 * the result's JSON carries waitlist_url, the "beta is full" page with the waitlist form (as/beta-full.mjs). */
export const PRIVATE_ERRORS=deepFreeze({
 BETA_FULL:{title:'The beta is full',message:'YEET is in a limited beta and every spot is taken right now. Join the waitlist and we will email you when a spot opens.',retryable:false},
});
for(const code of Object.keys(PRIVATE_ERRORS))if(Object.hasOwn(TOOL_ERRORS,code))invalid(`${code}: private code shadows a contract code`);
const ALL_ERRORS=Object.freeze({...TOOL_ERRORS,...PRIVATE_ERRORS});
/** A catalogue code (the contract's or a private one) is returned unchanged; anything else is the unknown code. */
export const normalize=code=>typeof code==='string'&&Object.hasOwn(ALL_ERRORS,code)?code:UNKNOWN;
export const isRetryable=code=>ALL_ERRORS[normalize(code)].retryable;
export const toolMessage=code=>ALL_ERRORS[normalize(code)].message;
/** Card copy per code: [title, message]. */
export const cards=()=>Object.fromEntries(Object.entries(TOOL_ERRORS).map(([code,e])=>[code,[e.title,e.message]]));

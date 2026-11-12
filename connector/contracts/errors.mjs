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
/** Anything that is not a catalogue code becomes this one (an outage: nothing was traded). */
export const UNKNOWN='TEMPORARILY_UNAVAILABLE';
if(!codes.includes(UNKNOWN))invalid(`${UNKNOWN} missing`);

const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value)}return value};
export const TOOL_ERRORS=deepFreeze(structuredClone(catalog));
export const FAILURE_CODES=Object.freeze([...enumCodes]);
/** A catalogue code is returned unchanged; anything else is the catalogue's unknown code. */
export const normalize=code=>typeof code==='string'&&Object.hasOwn(TOOL_ERRORS,code)?code:UNKNOWN;
export const isRetryable=code=>TOOL_ERRORS[normalize(code)].retryable;
export const toolMessage=code=>TOOL_ERRORS[normalize(code)].message;
/** Card copy per code: [title, message]. */
export const cards=()=>Object.fromEntries(Object.entries(TOOL_ERRORS).map(([code,e])=>[code,[e.title,e.message]]));

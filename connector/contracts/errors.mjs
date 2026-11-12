// Connector error catalog: reads x-folio-errors from dual-account.json and refuses to load a catalog that
// disagrees with the failure enum. Shipped in every image through `COPY contracts/`; node:fs only.
import {readFileSync} from 'node:fs';

const contract=JSON.parse(readFileSync(new URL('./dual-account.json',import.meta.url),'utf8'));
const catalog=contract['x-folio-errors'];
const enumCodes=contract.$defs?.failure?.properties?.error?.enum;
const invalid=reason=>{throw new Error(`dual-account.json x-folio-errors: ${reason}`)};
if(!catalog||typeof catalog!=='object')invalid('missing');
if(!Array.isArray(enumCodes))invalid('$defs.failure error enum missing');
const toolCodes=Object.keys(catalog.tool??{});
if(toolCodes.length!==enumCodes.length||enumCodes.some(code=>!toolCodes.includes(code)))invalid('tool keys must equal the failure enum');
for(const [code,entry] of Object.entries(catalog.tool)){
 if(typeof entry.retryable!=='boolean'||typeof entry.message!=='string'||!entry.message)invalid(`${code}: retryable and message required`);
 if(entry.card!==null&&!(Array.isArray(entry.card)&&entry.card.length===2&&entry.card.every(s=>typeof s==='string'&&s)))invalid(`${code}: card must be null or [title, body]`);
}
if(!toolCodes.includes(catalog.unknown))invalid('unknown must be a tool code');
for(const [code,{cases}={}] of Object.entries(catalog.wire??{})){
 if(!Array.isArray(cases)||!cases.length)invalid(`wire ${code}: cases required`);
 for(const c of cases){
  if(!Number.isInteger(c.status))invalid(`wire ${code}: status required`);
  if(c.outcome?.tool!==undefined?!toolCodes.includes(c.outcome.tool):!['not_opened','unavailable',null].includes(c.outcome?.value))invalid(`wire ${code}: outcome must be a tool code or a value`);
 }
}
if(!Array.isArray(catalog.passThrough)||catalog.passThrough.some(code=>!toolCodes.includes(code)))invalid('passThrough must be tool codes');

const deepFreeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(deepFreeze);Object.freeze(value)}return value};
export const TOOL_ERRORS=deepFreeze(structuredClone(catalog.tool));
export const WIRE=deepFreeze(structuredClone(catalog.wire));
export const PASS_THROUGH=deepFreeze([...catalog.passThrough]);
export const ADMISSION=deepFreeze(structuredClone(catalog.admission??{}));
export const UNKNOWN=catalog.unknown;
/** The hashed inputs of the generated server module (scripts/chatgpt-dual/generate-error-catalog.mjs). */
export const SOURCE=deepFreeze({errors:structuredClone(catalog),failureEnum:[...enumCodes]});
/** A catalog code is returned unchanged; anything else is the catalog's unknown code. */
export const normalize=code=>typeof code==='string'&&Object.hasOwn(TOOL_ERRORS,code)?code:UNKNOWN;
export const isRetryable=code=>TOOL_ERRORS[normalize(code)].retryable;
export const toolMessage=code=>TOOL_ERRORS[normalize(code)].message;
/** Widget card copy, only for codes that have a card; others use the widget's generic card. */
export const cards=()=>Object.fromEntries(Object.entries(TOOL_ERRORS).filter(([,e])=>e.card).map(([code,e])=>[code,[...e.card]]));

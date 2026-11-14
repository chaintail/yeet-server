// Tool schemas from the vendored yeet-win contract (vendor/yeet-win/contracts/yeet-tools.json; commit in PINNED).
import {readFileSync} from 'node:fs';
import {CONTRACT_URL} from '#contracts/errors';
/** The private descriptions (descriptions.private.json "contract"): the public contract carries one neutral sentence
 * where ChatGPT reads ours. At each JSON pointer the vendored text must be the recorded neutral one (or already the
 * original); anything else means a re-vendor changed that text, and loading stops until the overlay is re-recorded. */
export const DESCRIPTIONS_URL=new URL('./descriptions.private.json',import.meta.url);
export function applyDescriptions(target,overlay){
 for(const [pointer,{neutral,original}] of Object.entries(overlay)){
  const keys=pointer.split('/').slice(1).map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~'));const last=keys.pop();
  let o=target;for(const k of keys){o=o?.[k];if(!o||typeof o!=='object')throw Error(`descriptions.private.json: ${pointer} is not in the vendored contract`)}
  if(o[last]!==neutral&&o[last]!==original)throw Error(`descriptions.private.json: ${pointer} reads ${JSON.stringify(o[last])} in the vendored contract, not the recorded neutral text`);
  o[last]=original;
 }
 return target;
}
export const contract=applyDescriptions(JSON.parse(readFileSync(CONTRACT_URL,'utf8')),JSON.parse(readFileSync(DESCRIPTIONS_URL,'utf8')).contract);
export function resolveSchema(schema){
 if(Array.isArray(schema))return schema.map(resolveSchema);
 if(!schema||typeof schema!=='object')return schema;
 if(schema.$ref){
  if(!schema.$ref.startsWith('#/$defs/'))throw Error(`Unsupported $ref ${schema.$ref}`);
  const key=schema.$ref.slice('#/$defs/'.length);if(!contract.$defs[key])throw Error(`Unknown $ref ${schema.$ref}`);
  const {$ref,...rest}=schema;return {...resolveSchema(contract.$defs[key]),...resolveSchema(rest)};
 }
 return Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,resolveSchema(v)]));
}
/** Only the keywords in the pinned contract (contracts/README.md "Schema subset"). Fail loudly on an unknown type. */
export function zodSchema(z,schema){
 const s=resolveSchema(schema);let out;
 if(s.const!==undefined)out=z.literal(s.const);
 else if(s.enum)out=z.enum(s.enum);
 else if(s.oneOf||s.anyOf)out=z.union((s.oneOf??s.anyOf).map(v=>zodSchema(z,v)));
 else if(Array.isArray(s.type))out=z.union(s.type.map(type=>zodSchema(z,{...s,type})));
 else if(s.type==='object'){
  const required=new Set(s.required??[]),shape=Object.fromEntries(Object.entries(s.properties??{}).map(([key,value])=>[key,required.has(key)?zodSchema(z,value):zodSchema(z,value).optional()]));
  out=z.object(shape);if(s.additionalProperties===false)out=out.strict();
 }else if(s.type==='array'){
  out=z.array(zodSchema(z,s.items));if(s.minItems!==undefined)out=out.min(s.minItems);if(s.maxItems!==undefined)out=out.max(s.maxItems);
  if(s.uniqueItems)out=out.refine(items=>new Set(items.map(JSON.stringify)).size===items.length);
 }else if(s.type==='string'){
  out=z.string();if(s.minLength!==undefined)out=out.min(s.minLength);if(s.maxLength!==undefined)out=out.max(s.maxLength);if(s.pattern)out=out.regex(new RegExp(s.pattern));
  if(s.format==='uuid')out=out.uuid();
 }else if(s.type==='boolean')out=z.boolean();
 else if(s.type==='null')out=z.null();
 else if(['integer','number'].includes(s.type)){
  out=z.number();if(s.type==='integer')out=out.int();if(s.minimum!==undefined)out=out.min(s.minimum);if(s.maximum!==undefined)out=out.max(s.maximum);
 }else throw Error('Unsupported contract schema');
 return s.description?out.describe(s.description):out;
}
/** Input properties that are advertised strictly and read permissively. `app_version` (yeet_overview): tools/list
 * shows the contract's schema, one allowed value and required, so the model copies it; at run time the call must reach
 * the handler whatever it carries (a call from an older tool list has an older value or none, and the handler is
 * where that is answered: refresh.mjs classifyToolsVersion). The value never goes on to core. */
export const ADVERTISED_ONLY=Object.freeze(['app_version']);
const withoutAdvertisedOnly=s=>ADVERTISED_ONLY.some(k=>Object.hasOwn(s.properties??{},k))
 ?{...s,properties:Object.fromEntries(Object.entries(s.properties).filter(([k])=>!ADVERTISED_ONLY.includes(k))),required:(s.required??[]).filter(k=>!ADVERTISED_ONLY.includes(k))}:s;
/** Every contract tool, P0 to P2, with all references resolved: `input` is what a call is checked against at run time
 * (here and in core), `advertisedInput` what tools/list shows (the contract's own), `output` the result. They differ
 * only by the ADVERTISED_ONLY properties. */
export const toolSchemas=Object.fromEntries(Object.entries(contract.tools).map(([name,t])=>{const advertisedInput=resolveSchema(t.inputSchema);return [name,{input:withoutAdvertisedOnly(advertisedInput),advertisedInput,output:resolveSchema(t.outputSchema)}]}));
/** The input schema a tool is registered with: the run-time schema, plus each ADVERTISED_ONLY property accepted in any
 * form or absent, and listed in tools/list as the contract's schema (zod's own hook for a schema's JSON form). */
export function registrationInput(z,name){
 const s=toolSchemas[name],base=zodSchema(z,s.input);
 if(s.input===s.advertisedInput)return base;
 const loose=base.extend(Object.fromEntries(ADVERTISED_ONLY.filter(k=>Object.hasOwn(s.advertisedInput.properties,k)).map(k=>[k,z.unknown().optional()])));
 loose._zod.toJSONSchema=()=>structuredClone(s.advertisedInput);
 return loose;
}
/** The contract's per-tool metadata (priority, title, description, invocation status lines, annotations, scope, card, visible, widgetAccessible, resultMeta). */
export const toolSpecs=Object.freeze(Object.fromEntries(Object.entries(contract.tools).map(([name,t])=>[name,Object.freeze({name,priority:t.priority,title:t.title,description:t.description,invocation:t.invocation,annotations:t.annotations,scope:t.scope,card:t.card,visible:t.visible,widgetAccessible:t.widgetAccessible,confirm:!!t.resultMeta?.[contract['x-yeet-meta'].confirm],errors:t.errors})])));
export const CARDS=Object.freeze(contract['x-yeet-cards']);
export const META_KEYS=Object.freeze(contract['x-yeet-meta']);

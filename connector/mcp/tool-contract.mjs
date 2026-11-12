// Tool schemas from the vendored yeet-win contract (vendor/yeet-win/contracts/yeet-tools.json; commit in PINNED).
import {readFileSync} from 'node:fs';
import {CONTRACT_URL} from '#contracts/errors';
export const contract=JSON.parse(readFileSync(CONTRACT_URL,'utf8'));
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
/** Every contract tool, P0 to P2: {input, output} with all references resolved. */
export const toolSchemas=Object.fromEntries(Object.entries(contract.tools).map(([name,t])=>[name,{input:resolveSchema(t.inputSchema),output:resolveSchema(t.outputSchema)}]));
/** The contract's per-tool metadata (priority, title, description, annotations, scope, card, visible, widgetAccessible, resultMeta). */
export const toolSpecs=Object.freeze(Object.fromEntries(Object.entries(contract.tools).map(([name,t])=>[name,Object.freeze({name,priority:t.priority,title:t.title,description:t.description,annotations:t.annotations,scope:t.scope,card:t.card,visible:t.visible,widgetAccessible:t.widgetAccessible,confirm:!!t.resultMeta?.[contract['x-yeet-meta'].confirm],errors:t.errors})])));
export const CARDS=Object.freeze(contract['x-yeet-cards']);
export const META_KEYS=Object.freeze(contract['x-yeet-meta']);

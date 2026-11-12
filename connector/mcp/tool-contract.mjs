import {readFileSync} from 'node:fs';
export const contract=JSON.parse(readFileSync(new URL('../../contracts/dual-account.json',import.meta.url),'utf8'));
export function resolveSchema(schema){
 if(Array.isArray(schema))return schema.map(resolveSchema);
 if(!schema||typeof schema!=='object')return schema;
 if(schema.$ref){const key=schema.$ref.split('/').at(-1);const {$ref,...rest}=schema;return {...resolveSchema(contract.$defs[key]),...resolveSchema(rest)}}
 return Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,resolveSchema(v)]));
}
/** Only the keywords in the pinned contract. Fail loudly on an unknown type. */
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
export const toolSchemas=Object.fromEntries(Object.entries(contract.tools).map(([name,{input,output}])=>[name,{input:resolveSchema(contract.$defs[input]),output:resolveSchema(contract.$defs[output])}]));

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {toolError} from './errors.mjs';
import {toolSchemas,toolSpecs,zodSchema} from './tool-contract.mjs';
import {registerWidgets,toolMeta,CONFIRM_META_KEY} from './widgets.mjs';
import {instructions} from './instructions.mjs';

/** Core route per tool: route(args) -> [core route, body or undefined for GET]. Everything else about a tool (title,
 * description, schemas, annotations, scope, card, visibility, widget access, card-only confirm) is the contract's. */
const ROUTES={
 yeet_home:()=>['/home'],
 yeet_coins:()=>['/coins'],
 yeet_propose:args=>['/proposals',args],
 yeet_quote:({proposal_id,...rest})=>[`/proposals/${proposal_id}/quote`,rest],
 execute_trade:args=>['/trades',args],
 submit_trade_signature:({trade_id,...rest})=>[`/trades/${trade_id}/signature`,rest],
 trade_status:({trade_id})=>[`/trades/${trade_id}`],
 yeet_portfolio:()=>['/portfolio'],
 skeet_propose:args=>['/proposals/skeet',args],
 yeet_leaderboard:({board='xp'})=>[`/leaderboard/${board}`],
 daily_spin:()=>['/spin',{}],
 // Registered once the pinned contract lists the tool.
 yeet_set_username:({username})=>['/username',{username}],
};
/** daily_spin's text for the model: one plain sentence (the card reads structuredContent). */
export function spinText(r){
 const s=r?.stamp;
 if(!s)return `You won ${r.xp_won} XP.`;
 const set=s.set_completed?`, completing a ${s.coin} set${r.set_bonus_xp>0?` YEET spin.head.bonus: ${r.set_bonus_xp}.`:''}`:'';
 const more=r.spins_available>0?`, and you have ${r.spins_available} more spin${r.spins_available===1?'':'s'} today`:'';
 return `You won ${r.xp_won} XP and a ${s.coin} stamp (${s.filled} of ${s.slots})${set}${more}.`;
}
/** Tools whose core result may carry fields the pinned contract does not list yet (stamps): cut to the contract's
 * top-level properties so the closed output schema still passes; the fields flow through once the contract lists them. */
// yeet_home and the proposals carry `limits` (XP tier caps: tier, per_trade_usdc, daily_limit_usdc, left_today_usdc).
const CUT_TO_CONTRACT=new Set(['daily_spin','yeet_home','yeet_propose','yeet_quote','skeet_propose']);
const TEXT={daily_spin:spinText};
/** P0 and P1 are always registered; P2 (leaderboard, spin) only with YEET_P2=1. */
export const registeredTools=(env=process.env)=>Object.values(toolSpecs).filter(t=>t.priority!=='P2'||env.YEET_P2==='1');
export const TOOLS=Object.freeze(Object.values(toolSpecs).map(t=>Object.freeze({...t,route:ROUTES[t.name]})));
for(const t of TOOLS)if(!t.route)throw Error(`No core route for contract tool ${t.name}`);

export function createMcpServer({token,callCore,env=process.env}) {
 const server=new McpServer({name:'yeet',version:'0.2.0'},{instructions});
 registerWidgets(server);
 const meta=scope=>({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
 for(const tool of registeredTools(env)){
  const {name,scope}=tool,schemas=toolSchemas[name],route=ROUTES[name];
  const output=zodSchema(z,schemas.output);
  server.registerTool(name,{title:tool.title,description:tool.description,inputSchema:zodSchema(z,schemas.input),outputSchema:output,
   annotations:tool.annotations,_meta:{...meta(scope),...toolMeta(name)}},async args=>{
   const granted=token.scope?.split(' ')??[];
   if(!granted.includes(scope))return toolError({error:'REAUTH_REQUIRED'});
   try{
    const [path,body]=route(args);
    const result=await callCore(path,body);
    // The one-time confirm code goes to the card only (_meta). content repeats structuredContent, so neither may carry it.
    const isObject=result&&typeof result==='object'&&!Array.isArray(result);
    const confirm=tool.confirm&&isObject?result.confirm:undefined;
    const listed=CUT_TO_CONTRACT.has(name)&&schemas.output.properties?new Set(Object.keys(schemas.output.properties)):null;
    const data=isObject?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='confirm'&&(!listed||listed.has(k)))):result;
    const parsed=output.safeParse(data);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'});
    const text=TEXT[name]?TEXT[name](result):JSON.stringify(parsed.data);
    return {structuredContent:parsed.data,...(confirm?{_meta:{[CONFIRM_META_KEY]:confirm}}:{}),content:[{type:'text',text}]};
   }catch(e){return toolError(e)}
  });
 }
 return server;
}

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
 trade_status:({trade_id})=>[`/trades/${trade_id}`],
 yeet_portfolio:()=>['/portfolio'],
 skeet_propose:args=>['/proposals/skeet',args],
 yeet_leaderboard:({board='xp'})=>[`/leaderboard/${board}`],
 daily_spin:()=>['/spin',{}],
};
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
    const data=isObject?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='confirm')):result;
    const parsed=output.safeParse(data);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'});
    return {structuredContent:parsed.data,...(confirm?{_meta:{[CONFIRM_META_KEY]:confirm}}:{}),content:[{type:'text',text:JSON.stringify(parsed.data)}]};
   }catch(e){return toolError(e)}
  });
 }
 return server;
}

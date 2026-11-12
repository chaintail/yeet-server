import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {toolError} from './errors.mjs';
import {toolSchemas,zodSchema} from './tool-contract.mjs';
import {registerWidgets,toolMeta,CONFIRM_META_KEY} from './widgets.mjs';
import {instructions,titles,descriptions} from './instructions.mjs';

const readOnly={readOnlyHint:true,destructiveHint:false};
const proposing={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false};
/** P0 tools (port plan 2.2). route(args) -> [core route, body or undefined for GET]. */
export const TOOLS=Object.freeze([
 {name:'yeet_home',scope:'yeet:read',route:()=>['/home'],annotations:readOnly,card:'home',widgetAccessible:true},
 {name:'yeet_coins',scope:'yeet:read',route:()=>['/coins'],annotations:readOnly,card:null,widgetAccessible:false},
 {name:'yeet_propose',scope:'yeet:write',route:args=>['/proposals',args],annotations:proposing,card:'basket',widgetAccessible:true,confirm:true},
 {name:'yeet_quote',scope:'yeet:write',route:({proposal_id,...rest})=>[`/proposals/${proposal_id}/quote`,rest],annotations:proposing,card:'basket',widgetAccessible:true,confirm:true},
 {name:'execute_trade',scope:'yeet:trade',route:args=>['/trades',args],annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true},card:'receipt',widgetAccessible:true,hidden:true},
 {name:'trade_status',scope:'yeet:read',route:({trade_id})=>[`/trades/${trade_id}`],annotations:readOnly,card:'receipt',widgetAccessible:true},
]);

export function createMcpServer({token,callCore}) {
 const server=new McpServer({name:'yeet',version:'0.1.0'},{instructions});
 registerWidgets(server);
 const meta=scope=>({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
 for(const tool of TOOLS){
  const {name,scope}=tool,schemas=toolSchemas[name];
  server.registerTool(name,{title:titles[name],description:descriptions[name],inputSchema:zodSchema(z,schemas.input),outputSchema:zodSchema(z,schemas.output),
   annotations:tool.annotations,_meta:{...meta(scope),...(tool.card?toolMeta(tool.card,{widgetAccessible:tool.widgetAccessible,hidden:tool.hidden}):{})}},async args=>{
   const granted=token.scope?.split(' ')??[];
   if(!granted.includes(scope))return toolError({error:'REAUTH_REQUIRED'});
   try{
    const [route,body]=tool.route(args);
    const result=await callCore(route,body);
    // The one-time confirm code goes to the card only (_meta). content repeats structuredContent, so neither may carry it.
    const split=tool.confirm&&result&&typeof result==='object'&&!Array.isArray(result);
    const confirm=split?result.confirm:undefined;
    const data=split?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='confirm')):result;
    const parsed=zodSchema(z,schemas.output).safeParse(data);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'});
    return {structuredContent:parsed.data,...(tool.confirm&&confirm?{_meta:{[CONFIRM_META_KEY]:confirm}}:{}),content:[{type:'text',text:JSON.stringify(parsed.data)}]};
   }catch(e){return toolError(e)}
  });
 }
 return server;
}

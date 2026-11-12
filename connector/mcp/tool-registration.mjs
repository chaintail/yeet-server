import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {baseScopes,realScope,realAdvertised} from '#scope-catalog';
import {toolError} from './errors.mjs';
import {toolSchemas,zodSchema} from './tool-contract.mjs';
import {registerDualWidgets,dualToolMeta,REPORT_META_KEY} from './dual-widgets.mjs';
import {instructions,descriptions} from './instructions.mjs';

export function createMcpServer({token,callCore}) {
 const server=new McpServer({name:'folio',version:'0.3.0'},{instructions});
 registerDualWidgets(server);
 const views={get_portfolio:'portfolio',save_research:'report',get_profile:'choice'};
 // The report card reads the rich report from result _meta; the model reads structuredContent.
 const reportMeta=saved=>({[REPORT_META_KEY]:{...Object.fromEntries(['body','report','proposals'].filter(k=>saved[k]!==undefined).map(k=>[k,saved[k]])),quotes:saved.quote_snapshot?.quotes??[]}});
 const meta=scope=>({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
 const titles={get_profile:'Get Folio profile',get_portfolio:'Read Folio portfolios',save_research:'Save research to Folio',get_quote:'Get Folio reference prices'};
 for(const [name,scope,route] of [['get_profile',baseScopes[0],'/profile'],['get_portfolio',baseScopes[1],'/portfolio'],['save_research',baseScopes[2],'/research'],['get_quote',baseScopes[1],'/quote']]){
  server.registerTool(name,{title:titles[name],description:descriptions[name],inputSchema:zodSchema(z,toolSchemas[name].input),outputSchema:zodSchema(z,toolSchemas[name].output),
   annotations:{readOnlyHint:name!=='save_research',destructiveHint:false,...(name==='save_research'?{idempotentHint:true}:{})},_meta:{...meta(scope),...(views[name]?dualToolMeta(views[name]):{})}},async args=>{
   const granted=token.scope?.split(' ')??[];
   // While Real is not advertised, core answers account:"real" (ACCOUNT_REQUIRED / real_disabled); a reauth could never add Real.
   if(!granted.includes(scope)||(args.account==='real'&&realAdvertised()&&!granted.includes(realScope)))return toolError({error:'REAUTH_REQUIRED'});
   try{
    const target=route==='/portfolio'&&args.account?route+'?account='+args.account:route;
    const result=await callCore(target,['/research','/quote'].includes(route)?args:undefined);
    const parsed=zodSchema(z,toolSchemas[name].output).safeParse(result);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'});
    return {structuredContent:parsed.data,...(name==='save_research'?{_meta:reportMeta(parsed.data)}:{}),content:[{type:'text',text:JSON.stringify(parsed.data)}]};
   }catch(e){return toolError(e)}
  });
 }
 return server;
}

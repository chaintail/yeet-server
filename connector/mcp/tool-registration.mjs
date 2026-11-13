import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {toolError} from './errors.mjs';
import {toolSchemas,toolSpecs,zodSchema} from './tool-contract.mjs';
import {registerWidgets,toolMeta,CONFIRM_META_KEY} from './widgets.mjs';
import {instructions} from './instructions.mjs';
import {guidanceFor} from './guidance.mjs';
import {SIGNER_META_KEY,signerMetaFromEnv} from '#shared/signing.mjs';

/** Core route per tool: route(args) -> [core route, body or undefined for GET]. Everything else about a tool (title,
 * description, schemas, annotations, scope, card, visibility, widget access, card-only confirm) is the contract's. */
const ROUTES={
 yeet_overview:()=>['/overview'],
 yeet_home:()=>['/home'],
 yeet_coins:()=>['/coins'],
 yeet_propose:args=>['/proposals',args],
 yeet_quote:({proposal_id,...rest})=>[`/proposals/${proposal_id}/quote`,rest],
 execute_trade:args=>['/trades',args],
 submit_trade_signature:({trade_id,...rest})=>[`/trades/${trade_id}/signature`,rest],
 trade_status:({trade_id})=>[`/trades/${trade_id}`],
 yeet_portfolio:()=>['/portfolio'],
 yeet_fund:()=>['/fund'],
 skeet_propose:args=>['/proposals/skeet',args],
 yeet_leaderboard:({board='xp',window})=>[`/leaderboard/${board}${window?`/${window}`:''}`],
 yeet_checkin:()=>['/checkin'],
 daily_spin:()=>['/spin',{}],
 lucky_wheel:()=>['/lucky'],
 lucky_spin:({lucky_id})=>['/lucky/spin',{lucky_id}],
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
const CUT_TO_CONTRACT=new Set(['yeet_overview','daily_spin','yeet_home','yeet_propose','yeet_quote','skeet_propose']);
/** lucky_wheel and lucky_spin: one plain sentence for the model (the card reads structuredContent). */
export function luckyText(r){
 const l=r?.lucky;
 if(!l)return "YEET luckyText.";
 const coins=l.wheel.map(w=>w.coin).join(', ');
 if(l.claimed)return `Lucky wheel claimed: your bonus spin is ready in the card.`;
 if(l.slice===null)return `Today's lucky wheel: ${coins}. Spin it in the card.`;
 return `The lucky wheel landed on ${l.wheel[l.slice].coin}: YEET ${l.amount_usdc} USDC into ${l.wheel[l.slice].coin} for a bonus spin and a ${l.wheel[l.slice].coin} stamp.`;
}
/** yeet_overview's text for the model: the person in one line (one USDC number, no wallet, no chain), then the
 * follow-ups to offer. */
export function overviewText(r){
 const bits=[r.usdc===null?null:`${r.usdc} USDC`,r.xp===null?null:`${r.xp} XP (${r.tier})`,r.streak_days===null?null:`${r.streak_days}-day streak`,
  r.holdings_count===null?null:`${r.holdings_count} coin${r.holdings_count===1?'':'s'} held`].filter(Boolean);
 const win=r.top_winner?` Biggest winner: ${r.top_winner.symbol}, up ${r.top_winner.pct}% on their average YEET price.`:'';
 const open=r.checkin_open===true?' Today\'s daily check-in is still open.':'';
 const paused=r.trading==='paused'?' Trading is paused right now.':'';
 return `${r.username}: ${bits.join(', ')}.${open}${win}${paused} Offer next: ${r.suggestions.map(s=>`${s.label} ("${s.say}")`).join('; ')}.`;
}
/** yeet_checkin's text for the model: the streak, the XP and whether a spin is waiting. */
export function checkinText(r){
 const c=r?.checkin;if(!c)return 'The daily check-in is not available right now.';
 const left=Number.isInteger(c.spins_available)?c.spins_available:c.spin_available?1:0;
 return `Daily check-in: ${c.streak_days}-day streak, ${c.total} XP. ${left>0?`${left} spin${left===1?' is':'s are'} waiting in the card.`:'Today\'s spin is done.'}`;
}
/** yeet_fund's text for the model: the one USDC number. */
export const fundText=r=>`${r.usdc===null?"YEET fundText.":`They have ${r.usdc} USDC`}. The funding card is up.`;
const TEXT={yeet_overview:overviewText,yeet_fund:fundText,yeet_checkin:checkinText,daily_spin:spinText,lucky_wheel:luckyText,lucky_spin:luckyText};
/** P0 and P1 are always registered; P2 (leaderboard, spin) only with YEET_P2=1. */
export const registeredTools=(env=process.env)=>Object.values(toolSpecs).filter(t=>t.priority!=='P2'||env.YEET_P2==='1');
export const TOOLS=Object.freeze(Object.values(toolSpecs).map(t=>Object.freeze({...t,route:ROUTES[t.name]})));
for(const t of TOOLS)if(!t.route)throw Error(`No core route for contract tool ${t.name}`);

/** Results that carry `_meta['yeet/signer']` (CARD-SIGNING.md section 2.3a): the overview (its card checks the device
 * sign-in and shows the sign-in when needed), the proposals the card trades from and the trade answers it follows. Card-only, like the confirm code; never in structuredContent or content. */
export const SIGNER_TOOLS=new Set(['yeet_overview','yeet_propose','yeet_quote','skeet_propose','execute_trade','submit_trade_signature','trade_status']);
export function createMcpServer({token,callCore,env=process.env}) {
 const server=new McpServer({name:'yeet',version:'0.2.0'},{instructions});
 // Signing set up here (https RESOURCE, PRIVY_APP_ID, vendored signer): the signing cards declare the signing domains
 // and the trade results tell the card where the signer and the signing page are. Otherwise both stay off.
 const signer=signerMetaFromEnv(env);
 registerWidgets(server,{signOrigin:signer?new URL(signer.sign_page_url).origin:null});
 const meta=scope=>({securitySchemes:[{type:'oauth2',scopes:[scope]}]});
 // Guidance offers the wheel and the leaderboard only when they are registered (P2).
 const ctx={tools:new Set(registeredTools(env).map(t=>t.name))};
 for(const tool of registeredTools(env)){
  const {name,scope}=tool,schemas=toolSchemas[name],route=ROUTES[name];
  const output=zodSchema(z,schemas.output);
  server.registerTool(name,{title:tool.title,description:tool.description,inputSchema:zodSchema(z,schemas.input),outputSchema:output,
   annotations:tool.annotations,_meta:{...meta(scope),...toolMeta(name)}},async args=>{
   const granted=token.scope?.split(' ')??[];
   if(!granted.includes(scope))return toolError({error:'REAUTH_REQUIRED'},ctx);
   try{
    const [path,body]=route(args);
    const result=await callCore(path,body);
    // The one-time confirm code goes to the card only (_meta). content repeats structuredContent, so neither may carry it.
    const isObject=result&&typeof result==='object'&&!Array.isArray(result);
    const confirm=tool.confirm&&isObject?result.confirm:undefined;
    const listed=CUT_TO_CONTRACT.has(name)&&schemas.output.properties?new Set(Object.keys(schemas.output.properties)):null;
    const data=isObject?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='confirm'&&k!=='guidance'&&(!listed||listed.has(k)))):result;
    // Agent guidance (guidance.mjs): for the model, in structuredContent (the card ignores it) and in the text it reads.
    const guidance=isObject?guidanceFor(name,data,ctx):undefined;
    const parsed=output.safeParse(guidance?{...data,guidance}:data);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'},ctx);
    const text=TEXT[name]?TEXT[name](result):JSON.stringify(parsed.data);
    const cardMeta={...(confirm?{[CONFIRM_META_KEY]:confirm}:{}),...(signer&&SIGNER_TOOLS.has(name)?{[SIGNER_META_KEY]:signer}:{})};
    // The one-sentence tools (spin, lucky wheel) carry the guidance as a second text block; JSON text already has it.
    const content=[{type:'text',text},...(TEXT[name]&&parsed.data.guidance?[{type:'text',text:parsed.data.guidance}]:[])];
    return {structuredContent:parsed.data,...(Object.keys(cardMeta).length?{_meta:cardMeta}:{}),content};
   }catch(e){return toolError(e,ctx)}
  });
 }
 return server;
}

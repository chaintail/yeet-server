import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {toolError} from './errors.mjs';
import {toolSchemas,toolSpecs,zodSchema,META_KEYS} from './tool-contract.mjs';
import {registerWidgets,toolMeta,CONFIRM_META_KEY} from './widgets.mjs';
import {instructions} from './instructions.mjs';
import {guidanceFor} from './guidance.mjs';
import {SIGNER_META_KEY,signerMetaFromEnv} from '#shared/signing.mjs';
import {staleness as processStaleness,staleKey,appRefresh,withRefresh,BUILD_META_KEY} from './refresh.mjs';
import {refreshGuidance} from './guidance.mjs';
import {hasScope} from '#scope-catalog';
import {withLinkToken} from '#shared/link-token.mjs';
/**
 * The card's signer for one result. The trade page address is handed out only bound to the account (the core's
 * signed hint on it); with no hint the card gets the signer without a page address, never an unbound one.
 */
export function boundSigner(signer,hint){
 const {sign_page_url:page,...rest}=signer;
 return hint?{...rest,sign_page_url:withLinkToken(page,'h',hint)}:rest;
}
/** The shape of a signed link token (shared/link-token.mjs); the connector only passes it on, it holds no key. */
const LINK_TOKEN=/^v1\.[A-Za-z0-9_-]{8,300}\.[A-Za-z0-9_-]{43}$/;
/** Card-only `_meta` key for the connected account (contract x-yeet-meta.account): the device check in the trade card. */
export const ACCOUNT_META_KEY='yeet/account';

/** Card-only `_meta` key for the coin card's chart (contract x-yeet-meta.chart): the 24 hourly prices, never read by the model. */
export const CHART_META_KEY=META_KEYS.chart;
export function coinSymbol(value){
 if(typeof value!=='string')return null;
 const s=value.trim().replace(/^\$/,'').toUpperCase();
 return /^[A-Z0-9]{2,12}$/.test(s)?s:null;
}
/** The core's `card_chart` as the card may read it: 2 to 48 positive numbers, or nothing. */
export function chartMeta(value){
 const p=value?.points;
 return Array.isArray(p)&&p.length>=2&&p.length<=48&&p.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)?{points:p.slice()}:undefined;
}
/** Core route per tool: route(args) -> [core route, body or undefined for GET]. Everything else about a tool (title,
 * description, schemas, annotations, scope, card, visibility, widget access, card-only confirm) is the contract's. */
const ROUTES={
 yeet_overview:()=>['/overview'],
 // The device step on its own card, on request: the same answer as the overview.
 yeet_profile:()=>['/overview'],
 yeet_terms:()=>['/terms'],
 // `session`: ChatGPT's anonymized conversation id, recorded with the acceptance (never an argument of the tool).
 yeet_accept_terms:(args,session)=>['/terms/accept',{...args,source:'chat',...(session?{session}:{})}],
 yeet_referral:()=>['/referral'],
 apply_referral:args=>['/referral',args],
 yeet_home:()=>['/home'],
 yeet_coins:()=>['/coins'],
 // One coin by its symbol as a person may write it ("wif", "$WIF"); anything that cannot be a symbol is the coin refusal.
 yeet_coin:({symbol})=>{const s=coinSymbol(symbol);if(!s)throw {error:'COIN_NOT_SUPPORTED'};return [`/coins/${s}`]},
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
const CUT_TO_CONTRACT=new Set(['yeet_overview','yeet_profile','daily_spin','yeet_home','yeet_propose','yeet_quote','skeet_propose']);
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
/** yeet_terms and yeet_accept_terms: what the model reads first, in one line; the JSON follows in structuredContent. */
/** yeet_profile's text for the model: the name, XP, tier and streak. Nothing else of the overview is in it. */
export const profileText=r=>`Profile: ${r.username}${r.xp===null?'':`, ${r.xp} XP`} (${r.tier})${r.streak_days===null?'':`, ${r.streak_days}-day streak`}.`;
export const termsText=r=>r.terms.accepted?`The person accepted the YEET terms.`:`The person has not accepted the YEET terms. For your yeet_accept_terms call only, never shown to the person: version ${r.terms.version} and the id in brackets before each statement. Statements: ${r.terms.statements.map(s=>`[${s.id}${s.required?'':', optional'}] ${s.text} ${s.url}`).join(' | ')}`;
export const acceptText=r=>`Recorded: the person accepted the YEET terms. They are in.${r.overview?` ${overviewText(r.overview)}`:''}`;
export const referralText=r=>r.status==='applied'?`YEET referralText: ${r.code}.`:r.status==='skipped'?'They skipped the win code. The card is up if they want to type one.':"YEET referralText.";
const TEXT={yeet_terms:termsText,yeet_accept_terms:acceptText,yeet_referral:referralText,apply_referral:referralText,yeet_overview:overviewText,yeet_profile:profileText,yeet_fund:fundText,yeet_checkin:checkinText,daily_spin:spinText,lucky_wheel:luckyText,lucky_spin:luckyText};
/** P0 and P1 are always registered; P2 (leaderboard, spin) only with YEET_P2=1. */
export const registeredTools=(env=process.env)=>Object.values(toolSpecs).filter(t=>t.priority!=='P2'||env.YEET_P2==='1');
export const TOOLS=Object.freeze(Object.values(toolSpecs).map(t=>Object.freeze({...t,route:ROUTES[t.name]})));
for(const t of TOOLS)if(!t.route)throw Error(`No core route for contract tool ${t.name}`);

/** Results that carry `_meta['yeet/signer']` (CARD-SIGNING.md section 2.3a): the overview (its card checks the device
 * sign-in and shows the sign-in when needed), the proposals the card trades from and the trade answers it follows. Card-only, like the confirm code; never in structuredContent or content. */
export const SIGNER_TOOLS=new Set(['yeet_propose','yeet_quote','skeet_propose','execute_trade','submit_trade_signature','trade_status']);
export function createMcpServer({token,callCore,env=process.env,staleness=processStaleness}) {
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
   annotations:tool.annotations,_meta:{...meta(scope),...toolMeta(name)}},async(input,extra)=>{
   const granted=token.scope?.split(' ')??[];
   // An old scope name counts as its current one (yeet:trade is yeet:prepare).
   if(!hasScope(granted,scope))return toolError({error:'REAUTH_REQUIRED'},ctx,{tool:name});
   // card_build (refresh.mjs): which card build made this call. Never sent on to core. A call without it on a tool the
   // model can see is the model's own call: its result is where the model is told about a stale app, once.
   const {card_build:cardBuild,...args}=input??{};
   const key=staleKey(token,extra?._meta);
   staleness.note(key,{cardBuild,cardOnly:!tool.visible});
   const tellRefresh=tool.visible&&cardBuild===undefined&&staleness.take(key);
   try{
    const session=typeof extra?._meta?.['openai/session']==='string'?extra._meta['openai/session'].slice(0,200):undefined;
    const [path,body]=route(args,session);
    const result=await callCore(path,body);
    // The one-time confirm code goes to the card only (_meta). content repeats structuredContent, so neither may carry it.
    const isObject=result&&typeof result==='object'&&!Array.isArray(result);
    const confirm=tool.confirm&&isObject?result.confirm:undefined;
    const listed=CUT_TO_CONTRACT.has(name)&&schemas.output.properties?new Set(Object.keys(schemas.output.properties)):null;
    // The connected account (user id, email for the device code, wallets) goes to the card only, like the confirm code.
    const account=isObject&&result.card_account&&typeof result.card_account==='object'?result.card_account:undefined;
    // The signed hint for the trade page link (core account-login.mjs hintFor): card only, on the signer's page address.
    const hint=isObject&&typeof result.card_hint==='string'&&LINK_TOKEN.test(result.card_hint)?result.card_hint:undefined;
    // The coin card's chart points: card only (they would only make the model's result longer).
    const chart=CHART_META_KEY&&isObject?chartMeta(result.card_chart):undefined;
    const data=isObject?Object.fromEntries(Object.entries(result).filter(([k])=>k!=='confirm'&&k!=='guidance'&&k!=='card_account'&&k!=='card_hint'&&k!=='card_chart'&&(!listed||listed.has(k)))):result;
    // Agent guidance (guidance.mjs): for the model, in structuredContent (the card ignores it) and in the text it reads.
    const own=isObject?guidanceFor(name,data,ctx):undefined;
    const guidance=tellRefresh&&isObject?withRefresh(refreshGuidance(),own):own;
    const refresh=tellRefresh&&name==='yeet_overview'&&isObject?{app_refresh:appRefresh()}:{};
    const parsed=output.safeParse(guidance?{...data,...refresh,guidance}:data);
    if(!parsed.success)return toolError({error:'TEMPORARILY_UNAVAILABLE'},ctx,{tool:name});
    const text=TEXT[name]?TEXT[name](result):JSON.stringify(parsed.data);
    // Card only: the server's card build, so a card built from another commit can tell it is stale.
    const cardMeta={[BUILD_META_KEY]:staleness.build,...(confirm?{[CONFIRM_META_KEY]:confirm}:{}),...(account?{[ACCOUNT_META_KEY]:account}:{}),...(chart?{[CHART_META_KEY]:chart}:{}),...(signer&&SIGNER_TOOLS.has(name)?{[SIGNER_META_KEY]:boundSigner(signer,hint)}:{})};
    // The one-sentence tools (spin, lucky wheel) carry the guidance as a second text block; JSON text already has it.
    const content=[{type:'text',text},...(TEXT[name]&&parsed.data.guidance?[{type:'text',text:parsed.data.guidance}]:[])];
    return {structuredContent:parsed.data,...(Object.keys(cardMeta).length?{_meta:cardMeta}:{}),content};
   }catch(e){return toolError(e,ctx,{tool:name})}
  });
 }
 return server;
}

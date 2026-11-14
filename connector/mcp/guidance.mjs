// Agent guidance: one short field on every tool result, for the model (the card does not show it), keyed by tool or
// refusal code and state. This repository carries neutral text in every string; the wording YEET deploys is not part
// of it.
import {contract} from './tool-contract.mjs';
const APP=contract['x-yeet-app'];

export const COPY=Object.freeze({

 terms:{
  due_chat:"YEET terms.due_chat: {url}.",
  due_page:"YEET terms.due_page.",
  missing:"YEET terms.missing.",
  version:"YEET terms.version.",
  accepted:"YEET terms.accepted.",
  recorded:"YEET terms.recorded.",
 },

 how_it_works:{
  answer:"YEET how_it_works.answer.",
 },
 referral:{
  open:"YEET referral.open.",
  applied:"YEET referral.applied: {code}.",
  skipped:"YEET referral.skipped.",
 },

 yeet_overview:{
  base:"YEET yeet_overview.base: {username} {lead}.",

  terms_chat:"YEET yeet_overview.terms_chat: {username} {url}.",
  terms_page:"YEET yeet_overview.terms_page: {username}.",
  lead_referral:", YEET yeet_overview.lead_referral.",
  lead_none:" YEET yeet_overview.lead_none.",
  lead_fund:", YEET yeet_overview.lead_fund.",
  lead_checkin:", YEET yeet_overview.lead_checkin.",
  lead_paused:", YEET yeet_overview.lead_paused.",
 },

 yeet_home:{
  paused:"YEET yeet_home.paused.",
  paused_no_wheel:"YEET yeet_home.paused_no_wheel.",
  needs_signer:"YEET yeet_home.needs_signer.",
  needs_funds_spin:"YEET yeet_home.needs_funds_spin.",
  needs_funds:"YEET yeet_home.needs_funds.",
  needs_funds_no_wheel:"YEET yeet_home.needs_funds_no_wheel.",
  ready_spin:"YEET yeet_home.ready_spin.",
  ready_usdc:"YEET yeet_home.ready_usdc: {usdc}.",

  ready_funding:"YEET yeet_home.ready_funding: {base} {solana} {network}.",
  ready_funding_unread:"YEET yeet_home.ready_funding_unread: {usdc} {network} {other}.",
  ready:"YEET yeet_home.ready.",
 },

 yeet_coins:{
  list:"YEET yeet_coins.list.",
  unpriced:"YEET yeet_coins.unpriced.",
 },

 yeet_coin:{
  head:"YEET yeet_coin.head: {symbol}.",
  head_held:"YEET yeet_coin.head_held: {symbol}.",
  head_unpriced:"YEET yeet_coin.head_unpriced: {symbol}.",
  about:"YEET yeet_coin.about.",
  tail:"YEET yeet_coin.tail.",
 },

 propose_yeet:{
  base:"YEET propose_yeet.base.",

  base_funded:"YEET propose_yeet.base_funded: {network}.",
  base_funded_unread:"YEET propose_yeet.base_funded_unread: {network} {other}.",
  signer_missing:"YEET propose_yeet.signer_missing.",
  balance_low:"YEET propose_yeet.balance_low.",

  balance_low_funding:"YEET propose_yeet.balance_low_funding: {base} {solana}.",
  cost_high:"YEET propose_yeet.cost_high: {cost_pct}.",

  first_buy:", YEET propose_yeet.first_buy: {per_trade} {daily} {min}.",
  risk:"YEET propose_yeet.risk.",
 },

 propose_skeet:{
  base:"YEET propose_skeet.base.",
  cost_high:"YEET propose_skeet.cost_high: {cost_pct}.",

  small:"YEET propose_skeet.small.",
 },
 execute_trade:{
  awaiting_signature:"YEET execute_trade.awaiting_signature.",
  awaiting_signature_yeet:"YEET execute_trade.awaiting_signature_yeet: {network}.",
  submitted:"YEET execute_trade.submitted.",
  requote_required:"YEET execute_trade.requote_required.",
 },

 trade:{
  signing_more:"YEET trade.signing_more: {left} {s}.",
  settling_yeet:"YEET execute_trade.submitted.",
  settling_skeet:"YEET trade.settling_skeet.",
  success_yeet_xp:"YEET trade.success_yeet_xp: {points}.",
  success_yeet:"YEET trade.success_yeet.",
  success_yeet_no_wheel:"YEET trade.success_yeet_no_wheel.",
  success_skeet_xp:"YEET trade.success_skeet_xp: {points}.",
  success_skeet:"YEET trade.success_skeet.",

  success_skeet_xp_on:"YEET trade.success_skeet_xp_on: {network} {points}.",
  success_skeet_on:"YEET trade.success_skeet_on: {network}.",
  refunded_yeet_on:"YEET trade.refunded_yeet_on: {network}.",
  partial:"YEET trade.partial.",
  refunded_yeet:"YEET trade.refunded_yeet.",
  refunded_skeet:"YEET trade.refunded_skeet.",
  failed:"YEET trade.failed.",
 },
 yeet_portfolio:{
  empty:"YEET yeet_portfolio.empty.",
  usdc_unread:"YEET yeet_portfolio.usdc_unread.",
  usdc_only:"YEET yeet_portfolio.usdc_only: {usdc}.",
  holdings_total:"YEET yeet_portfolio.holdings_total: {total}.",
  holdings:"YEET yeet_portfolio.holdings.",
 },
 yeet_leaderboard:{
  ranked:"YEET yeet_leaderboard.ranked: {rank} {xp}.",
  unranked:"YEET yeet_leaderboard.unranked.",

  result_ranked:"YEET yeet_leaderboard.result_ranked: {rank}.",
  result_unranked:"YEET yeet_leaderboard.result_unranked.",
  result_empty:"YEET yeet_leaderboard.result_empty.",
  coins:"YEET yeet_leaderboard.coins.",
  coins_empty:"YEET yeet_leaderboard.coins_empty.",
 },

 yeet_fund:{
  choose:"YEET yeet_fund.choose.",
  crypto:"YEET yeet_fund.crypto.",
  card:"YEET yeet_fund.card.",
 },

 yeet_fund_own:{
  crypto:"YEET yeet_fund_own.crypto.",
  no_card:"YEET yeet_fund_own.no_card.",
  ready:"YEET yeet_fund_own.ready.",
  detected:"YEET yeet_fund_own.detected.",

  minimum:"YEET yeet_fund_own.minimum: {min}.",
  other_coin:"YEET yeet_fund_own.other_coin: {coin}.",
  unavailable:"YEET yeet_fund_own.unavailable.",
 },

 yeet_checkin:{
  open:"YEET yeet_checkin.open.",
  done:"YEET yeet_checkin.done: {days} {s}.",
 },

 streak:{
  reminder:"YEET streak.reminder: {streak_days}.",
 },
 daily_spin:{
  set:"YEET daily_spin.set: {xp_won} {coin} {bonus}.",
  stamp:"YEET daily_spin.stamp: {coin} {filled} {slots} {xp_won}.",
  xp_only:"YEET daily_spin.xp_only: {xp_won}.",
  more_spins:"YEET daily_spin.more_spins: {left} {s}.",
  lucky:"YEET daily_spin.lucky.",
  done:"YEET daily_spin.done.",
 },
 yeet_set_username:{
  set:"YEET yeet_set_username.set: {username}.",
  profile:"YEET yeet_set_username.profile.",
 },

 lucky:{
  none:"YEET lucky.none.",
  ready:"YEET lucky.ready.",
  landed:"YEET lucky.landed: {coin} {amount} {lucky_id}.",
  claimed:"YEET lucky.claimed.",
 },

 refresh:{
  stale:"YEET refresh.stale: {url} {steps}.",
 },

 style:{
  reminder:"YEET style.reminder.",
 },

 errors:{

  LIMIT_EXCEEDED_trade:"YEET errors.LIMIT_EXCEEDED_trade: {tier}.",
  LIMIT_EXCEEDED_daily:"YEET errors.LIMIT_EXCEEDED_daily: {tier} {hours} {s}.",
  LIMIT_EXCEEDED_Noob:"YEET errors.LIMIT_EXCEEDED_Noob: {winner_xp} {vip_over_xp}.",
  LIMIT_EXCEEDED_Winner:"YEET errors.LIMIT_EXCEEDED_Winner: {vip_over_xp}.",
  LIMIT_EXCEEDED_VIP:"YEET errors.LIMIT_EXCEEDED_VIP.",
  LIMIT_EXCEEDED:"YEET errors.LIMIT_EXCEEDED.",
  TRADING_PAUSED:"YEET errors.TRADING_PAUSED.",
  TRADING_PAUSED_no_wheel:"YEET errors.TRADING_PAUSED_no_wheel.",
  BALANCE_LOW:"YEET errors.BALANCE_LOW.",

  BALANCE_LOW_usdc:"YEET errors.BALANCE_LOW_usdc.",

  TEMPORARILY_UNAVAILABLE:"YEET errors.TEMPORARILY_UNAVAILABLE.",

  TEMPORARILY_UNAVAILABLE_no_send:"YEET errors.TEMPORARILY_UNAVAILABLE_no_send.",
  COST_TOO_HIGH:"YEET errors.COST_TOO_HIGH.",
  AMOUNT_TOO_SMALL:"YEET errors.AMOUNT_TOO_SMALL.",

  AMOUNT_TOO_SMALL_sell:"YEET errors.AMOUNT_TOO_SMALL_sell.",
  CONFIRMATION_REQUIRED:"YEET errors.CONFIRMATION_REQUIRED.",
  REQUOTE_REQUIRED:"YEET errors.REQUOTE_REQUIRED.",
  COIN_NOT_SUPPORTED:"YEET errors.COIN_NOT_SUPPORTED.",
  INVALID_ARGUMENT:"YEET errors.INVALID_ARGUMENT.",
  PARTS_EMPTY:"YEET errors.PARTS_EMPTY.",
  WALLET_NOT_READY:"YEET errors.WALLET_NOT_READY.",
  REAUTH_REQUIRED:"YEET errors.REAUTH_REQUIRED.",

  APP_OUTDATED:"YEET errors.APP_OUTDATED: {url} {steps}.",
  USERNAME_TAKEN:"YEET errors.USERNAME_TAKEN.",
  USERNAME_NOT_ALLOWED:"YEET errors.USERNAME_NOT_ALLOWED.",

  BETA_FULL:"YEET errors.BETA_FULL.",

  REGION_BLOCKED:"YEET errors.REGION_BLOCKED.",
 },
});

export function refreshGuidance(app=APP){return fill(COPY.refresh.stale,{url:app.manage_url,steps:app.refresh_steps})}

export const TIER_XP=Object.freeze({winner_xp:'69',vip_over_xp:'1,000'});

export function fill(template,vars={}){
 return template.replace(/\{([a-z_]+)\}/g,(_m,k)=>{if(vars[k]===undefined||vars[k]===null)throw Error(`guidance slot ${k}`);return String(vars[k])});
}
const plural=n=>n===1?'':'s';

const MAX_LENGTH=500;

export const hoursToReset=(ms=Date.now())=>Math.max(1,Math.ceil((86_400_000-(ms%86_400_000))/3_600_000));
const join=(...parts)=>parts.filter(Boolean).join(' ');
const hasWheel=ctx=>!ctx||!ctx.tools||ctx.tools.has('daily_spin');
const hasLucky=ctx=>!ctx||!ctx.tools||ctx.tools.has('lucky_wheel');
const positive=v=>typeof v==='string'&&Number(v)>0;

const NET={base:'Base',solana:'Solana'};
const netName=v=>Object.hasOwn(NET,v)?NET[v]:null;
const fundingOf=r=>r?.funding&&typeof r.funding==='object'&&netName(r.funding.chosen)?r.funding:null;
const otherOf=n=>n==='base'?'Solana':'Base';
const usdcOf=(f,n)=>n==='base'?f.base_usdc:f.solana_usdc;

function home(r,ctx){
 const c=COPY.yeet_home,spin=r.xp?.spin_available===true||(r.xp?.spins_available??0)>0;
 if(r.ready==='paused')return hasWheel(ctx)?c.paused:c.paused_no_wheel;
 if(r.ready==='needs_signer')return c.needs_signer;
 if(r.ready==='needs_funds')return !hasWheel(ctx)||!r.xp?c.needs_funds_no_wheel:spin?c.needs_funds_spin:c.needs_funds;
 if(spin&&hasWheel(ctx))return c.ready_spin;
 const f=fundingOf(r);
 if(f){
  if(typeof f.base_usdc==='string'&&typeof f.solana_usdc==='string')return fill(c.ready_funding,{base:f.base_usdc,solana:f.solana_usdc,network:netName(f.chosen)});
  if(positive(usdcOf(f,f.chosen)))return fill(c.ready_funding_unread,{usdc:usdcOf(f,f.chosen),network:netName(f.chosen),other:otherOf(f.chosen)});
 }
 const usdc=r.usdc;
 return positive(usdc)?fill(c.ready_usdc,{usdc}):c.ready;
}
const amount=v=>typeof v==='string'&&/^\d+(\.\d+)?$/.test(v);

export function firstBuy(r){
 const l=r?.limits;
 if(r?.direction!=='yeet'||!l||!amount(l.per_trade_usdc)||!amount(l.daily_limit_usdc)||!amount(l.left_today_usdc)||!amount(r.min_leg_usdc))return null;
 return Number(l.left_today_usdc)===Number(l.daily_limit_usdc)?{per_trade:l.per_trade_usdc,daily:l.daily_limit_usdc,min:r.min_leg_usdc}:null;
}
function proposal(r){
 const w=new Set(r.warnings??[]);
 if(r.direction==='skeet'){
  const c=COPY.propose_skeet;

  return join(c.base,w.has('LEG_SMALL')?c.small:w.has('COST_HIGH')?fill(c.cost_high,{cost_pct:r.totals?.cost_pct}):'');
 }
 const c=COPY.propose_yeet;
 const f=fundingOf(r),both=r.funding&&typeof r.funding.base_usdc==='string'&&typeof r.funding.solana_usdc==='string';
 const low=both?fill(c.balance_low_funding,{base:r.funding.base_usdc,solana:r.funding.solana_usdc}):c.balance_low;
 const note=w.has('SIGNER_MISSING')?c.signer_missing:w.has('BALANCE_LOW')?low:w.has('COST_HIGH')?fill(c.cost_high,{cost_pct:r.totals?.cost_pct}):'';
 const head=!f?c.base:usdcOf(f,otherOf(f.chosen).toLowerCase())===null?fill(c.base_funded_unread,{network:netName(f.chosen),other:otherOf(f.chosen)}):fill(c.base_funded,{network:netName(f.chosen)});

 const first=w.has('SIGNER_MISSING')||w.has('BALANCE_LOW')?null:firstBuy(r);
 const intro=first?join(`${head.slice(0,-1)}${fill(c.first_buy,first)}.`,note,c.risk):'';
 return intro&&intro.length<=MAX_LENGTH?intro:join(head,note,c.risk);
}
function trade(r,ctx){
 const c=COPY.trade,skeet=r.direction==='skeet',left=(r.sign_requests??[]).length;
 const points=r.xp_award?.points>0?r.xp_award.points:null;
 switch(r.status){
  case 'signing':return left>0?fill(c.signing_more,{left,s:plural(left)}):skeet?c.settling_skeet:c.settling_yeet;
  case 'submitted':case 'settling':return skeet?c.settling_skeet:c.settling_yeet;
  case 'success':
   if(skeet){const network=netName(r.lands_on);return network?(points?fill(c.success_skeet_xp_on,{network,points}):fill(c.success_skeet_on,{network})):points?fill(c.success_skeet_xp,{points}):c.success_skeet}
   if(!hasWheel(ctx))return c.success_yeet_no_wheel;
   return points?fill(c.success_yeet_xp,{points}):c.success_yeet;
  case 'partial':return c.partial;
  case 'refunded':return skeet?c.refunded_skeet:netName(r.funded_from)?fill(c.refunded_yeet_on,{network:netName(r.funded_from)}):c.refunded_yeet;
  default:return c.failed;
 }
}
function execute(r,ctx){
 const c=COPY.execute_trade;
 if(r.status==='requote_required')return c.requote_required;
 if(r.status==='submitted')return c.submitted;
 return r.direction==='yeet'&&netName(r.funded_from)?fill(c.awaiting_signature_yeet,{network:netName(r.funded_from)}):c.awaiting_signature;
}
function portfolio(r){
 const c=COPY.yeet_portfolio,held=(r.solana?.holdings??[]).filter(h=>positive(h.amount));
 if(held.length)return positive(r.total_usd)?fill(c.holdings_total,{total:r.total_usd}):c.holdings;
 if(r.base?.usdc===null)return c.usdc_unread;
 return positive(r.base?.usdc)?fill(c.usdc_only,{usdc:r.base.usdc}):c.empty;
}

const reminder=days=>Number.isInteger(days)&&days>=2?fill(COPY.streak.reminder,{streak_days:days}):'';
function spin(r,ctx){
 const c=COPY.daily_spin,s=r.stamp;
 const head=!s?fill(c.xp_only,r)
  :s.set_completed?fill(c.set,{xp_won:r.xp_won,coin:s.coin,bonus:r.set_bonus_xp>0?` YEET spin.head.bonus: ${r.set_bonus_xp}.`:''})
  :fill(c.stamp,{coin:s.coin,filled:s.filled,slots:s.slots,xp_won:r.xp_won});
 const left=r.spins_available??0;

 return join(head,left>0?fill(c.more_spins,{left,s:plural(left)}):hasLucky(ctx)&&r.spin_reason!=='trade_bonus'?c.lucky:c.done,left>0?'':reminder(r.streak_days));
}
function lucky(r){
 const c=COPY.lucky,l=r?.lucky;
 if(!l)return c.none;
 if(l.claimed)return c.claimed;
 if(l.slice===null||l.slice===undefined||!l.wheel?.[l.slice])return c.ready;
 return fill(c.landed,{coin:l.wheel[l.slice].coin,amount:l.amount_usdc,lucky_id:l.lucky_id});
}
function overviewGuidance(r){
 const c=COPY.yeet_overview,first=r.suggestions?.[0]?.id;
 if(r.terms&&r.terms.accepted===false)return fill(r.terms.mode==='page'?c.terms_page:c.terms_chat,{username:r.username,url:APP.manage_url});
 const lead=r.trading==='paused'?c.lead_paused:first==='referral'?c.lead_referral:first==='fund'?c.lead_fund:first==='checkin'?c.lead_checkin:c.lead_none;
 return fill(c.base,{username:r.username,lead});
}

export function termsGuidance(terms,reason){
 const c=COPY.terms;
 if(reason==='missing')return c.missing;
 if(reason==='version')return terms?.mode==='page'?c.due_page:c.version;
 return terms?.mode==='page'?c.due_page:fill(c.due_chat,{url:APP.manage_url});
}

function coinGuidance(r){
 const c=COPY.yeet_coin,symbol=/^[A-Z0-9]{2,12}$/.test(r.symbol??'')?r.symbol:'the coin';
 const head=r.price_usd===null||r.price_usd===undefined?c.head_unpriced:r.holding?c.head_held:c.head;
 return join(fill(head,{symbol}),r.description||r.website?c.about:null,c.tail);
}
const BY_TOOL={
 yeet_overview:overviewGuidance,
 yeet_terms:r=>r.terms?.accepted?COPY.terms.accepted:termsGuidance(r.terms),
 yeet_accept_terms:()=>COPY.terms.recorded,
 yeet_how_it_works:()=>COPY.how_it_works.answer,
 yeet_referral:r=>r.status==='applied'?fill(COPY.referral.applied,{code:r.code}):r.status==='skipped'?COPY.referral.skipped:COPY.referral.open,
 apply_referral:r=>r.status==='applied'?fill(COPY.referral.applied,{code:r.code}):COPY.referral.skipped,
 yeet_home:home,
 yeet_coins:r=>(r.coins??[]).some(c=>c.price_usd!==null&&c.price_usd!==undefined)?COPY.yeet_coins.list:COPY.yeet_coins.unpriced,
 yeet_coin:coinGuidance,
 yeet_propose:proposal,yeet_quote:proposal,skeet_propose:proposal,
 execute_trade:execute,
 submit_trade_signature:trade,trade_status:trade,
 yeet_portfolio:portfolio,
 yeet_leaderboard:r=>{
  const c=COPY.yeet_leaderboard,empty=!(r.rows?.length>0);
  if(r.board==='coins')return empty?c.coins_empty:c.coins;
  if(r.board&&r.board!=='xp')return empty?c.result_empty:Number.isInteger(r.me?.rank)?fill(c.result_ranked,{rank:r.me.rank}):c.result_unranked;
  return Number.isInteger(r.me?.rank)?fill(c.ranked,{rank:r.me.rank,xp:r.me.xp}):c.unranked;
 },
 yeet_fund:r=>{

  if(Array.isArray(r.methods)&&!r.methods.includes('card')){
   const c=COPY.yeet_fund_own;
   if(!r.methods.includes('crypto'))return c.unavailable;
   if(r.watch?.stage==='ready')return c.ready;
   if(r.watch?.stage==='other_coin')return fill(c.other_coin,{coin:typeof r.watch.coin==='string'&&/^[A-Za-z0-9$.]{1,16}$/.test(r.watch.coin)?r.watch.coin:'another coin'});
   if(r.watch?.stage==='detected')return c.detected;
   const min=typeof r.min_deposit_usdc==='string'&&/^\d{1,6}(\.\d{1,2})?$/.test(r.min_deposit_usdc)?r.min_deposit_usdc:null;
   return join(r.method==='card'?c.no_card:c.crypto,min?fill(c.minimum,{min}):null);
  }
  return r.method==='crypto'?COPY.yeet_fund.crypto:r.method==='card'?COPY.yeet_fund.card:COPY.yeet_fund.choose;
 },
 yeet_checkin:r=>{const c=r.checkin??{},left=Number.isInteger(c.spins_available)?c.spins_available:c.spin_available?1:0;return left>0?COPY.yeet_checkin.open:join(fill(COPY.yeet_checkin.done,{days:c.streak_days,s:plural(c.streak_days)}),reminder(c.streak_days))},
 daily_spin:spin,
 yeet_set_username:r=>fill(COPY.yeet_set_username.set,{username:r.username}),
 yeet_profile:()=>COPY.yeet_set_username.profile,
 lucky_wheel:lucky,lucky_spin:lucky,
};
export const GUIDED_TOOLS=Object.freeze(Object.keys(BY_TOOL));

const STYLED={
 yeet_overview:r=>r.terms?.accepted!==false,
 yeet_home:r=>r.ready==='ready',
 yeet_coins:()=>true,yeet_coin:()=>true,
 yeet_propose:()=>true,yeet_quote:()=>true,skeet_propose:()=>true,
 trade_status:r=>r.status==='success',
 yeet_portfolio:r=>(r.solana?.holdings??[]).some(h=>positive(h.amount))||positive(r.base?.usdc),
 yeet_leaderboard:()=>true,
 yeet_checkin:()=>true,daily_spin:()=>true,yeet_profile:()=>true,
 lucky_wheel:r=>!!r?.lucky,lucky_spin:r=>!!r?.lucky,
};
export const STYLED_TOOLS=Object.freeze(Object.keys(STYLED));

export function styleFor(name,result){
 const f=STYLED[name];
 if(!f||!result||typeof result!=='object')return undefined;
 try{return f(result)?COPY.style.reminder:undefined}catch{return undefined}
}

export function guidanceFor(name,result,ctx){
 const f=BY_TOOL[name];
 if(!f||!result||typeof result!=='object')return undefined;
 try{return f(result,ctx)}catch{return undefined}
}

export const MAY_SEND=new Set(['execute_trade','submit_trade_signature','trade_status']);

export function refusalGuidance(code,message,ctx,{terms,reason,tool,now=Date.now}={}){
 const e=COPY.errors;
 if(code==='TEMPORARILY_UNAVAILABLE')return typeof tool==='string'&&!MAY_SEND.has(tool)?e.TEMPORARILY_UNAVAILABLE_no_send:e.TEMPORARILY_UNAVAILABLE;
 if(code==='TERMS_REQUIRED')return termsGuidance(terms,reason);
 if(code==='APP_OUTDATED')return fill(e.APP_OUTDATED,{url:APP.manage_url,steps:APP.refresh_steps});
 if(code==='LIMIT_EXCEEDED'){
  const tier=typeof message==='string'?message.match(/\bas a (Noob|Winner|VIP)\b/)?.[1]:undefined;
  const kind=typeof message!=='string'?undefined:/\bper-trade limit\b/.test(message)?'trade':/\bdaily limit\b/.test(message)?'daily':undefined;
  if(!tier||!kind)return e.LIMIT_EXCEEDED;
  const hours=hoursToReset(now());
  return join(fill(e[`LIMIT_EXCEEDED_${kind}`],{tier,hours,s:plural(hours)}),fill(e[`LIMIT_EXCEEDED_${tier}`],TIER_XP));
 }
 if(code==='TRADING_PAUSED'&&!hasWheel(ctx))return e.TRADING_PAUSED_no_wheel;
 if(code==='BALANCE_LOW'&&typeof message==='string'&&/you can trade up to/.test(message))return e.BALANCE_LOW_usdc;
 if(code==='AMOUNT_TOO_SMALL'&&typeof message==='string'&&/too small to sell right now/.test(message))return e.AMOUNT_TOO_SMALL_sell;
 return e[code];
}

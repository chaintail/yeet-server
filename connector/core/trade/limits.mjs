// Server-side trade limits (port plan 2.3 item 4 and risk 3). Every refusal is one catalogue code.
//   YEET_MIN_LEG_USDC    minimum USDC per coin of a BUY (default 3) -> AMOUNT_TOO_SMALL
//   YEET_MIN_SKEET_USDC  minimum USDC a SELL brings in per coin (default 0.5) -> AMOUNT_TOO_SMALL with its own
//                        sentence. Separate from the buy minimum on purpose: a coin bought at the 3 USDC minimum is
//                        worth less than 3 after costs, and must still be sellable. Used by skeetPlan only.
//   YEET_SKEET_WARN_USDC a SELL that is allowed but brings in less than this per coin (default 1) carries the
//                        warning LEG_SMALL: swap fees take a big part of so small a sale (proposals.mjs view).
//   BUY caps by XP tier (TIER_DEFAULTS below; per trade and per UTC day)  -> LIMIT_EXCEEDED
//   YEET_MAX_TRADE_USDC / YEET_DAILY_CAP_USDC  optional global ceilings over every tier (default: the VIP caps).
//                        Set to the old 25 / 50 they would clamp Winner and VIP: leave them unset in production.
//   YEET_MAX_COST_BPS    swap cost ceiling in bps (default 800)    -> COST_TOO_HIGH
//   YEET_KILL_SWITCH     1/true: no new proposals or trades        -> TRADING_PAUSED
//   YEET_LIVE_ACCOUNTS   comma list of account ids (yeet-privy-...). When set, only these accounts may execute while
//                        live; every other account is TRADING_PAUSED (its queued legs are not sent). Unset or empty:
//                        every account. Operator trades (core.mjs /operator/trades) need the account listed here.
//   YEET_REQUOTE_TOLERANCE_BPS  live output may be this far under the previewed estimate at the tap (default 50)
//   YEET_CODE_MINT_LIMIT confirm codes per account per 10 minutes (default 20) -> TEMPORARILY_UNAVAILABLE
//   YEET_TRACK_MAX_HOURS hours a trade is tracked past its 1Click deposit deadline before it is stale (default 24)
//   YEET_BASE_POLICY_ID / YEET_SOLANA_POLICY_ID  the Privy policy the delegated signer must carry on each chain; a
//                        wallet whose signer entry has any other policy set is refused     -> WALLET_NOT_READY
// The daily cap is enforced here only: Privy's aggregation does not count eth_sendTransaction (PRIVY-SETUP-REVIEW).
//   at most 5 legs                                                 -> INVALID_ARGUMENT
import {parseUnits} from './router.mjs';
import {refuse,utcDay,TradeError} from './util.mjs';

export const MAX_LEGS=5;
export const COST_WARN_BPS=300;
const USDC_RE=/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;

function usdcEnv(env,name,fallback){
 const v=String(env[name]??'').trim()===''?fallback:String(env[name]).trim();
 if(!USDC_RE.test(v))throw Error(`Invalid ${name}`);
 return parseUnits(v,6);
}
function intEnv(env,name,fallback,max){
 const v=String(env[name]??'').trim()===''?fallback:Number(env[name]);
 if(!Number.isSafeInteger(v)||v<0||v>max)throw Error(`Invalid ${name}`);
 return v;
}
const ACCOUNT_RE=/^yeet-privy-[A-Za-z0-9_-]{1,80}$/;
/** YEET_LIVE_ACCOUNTS as a frozen list, or null when unset or empty (no allowlist). */
export function liveAccountsFromEnv(env=process.env){
 const raw=String(env.YEET_LIVE_ACCOUNTS??'').trim();
 if(!raw)return null;
 const ids=[...new Set(raw.split(',').map(s=>s.trim()).filter(Boolean))];
 if(!ids.length||ids.some(id=>!ACCOUNT_RE.test(id)))throw Error('Invalid YEET_LIVE_ACCOUNTS');
 return Object.freeze(ids);
}
/** True when the account may execute under the allowlist (always true without one). Does not look at YEET_LIVE. */
export const accountLive=(limits,accountId)=>!limits.liveAccounts||limits.liveAccounts.includes(accountId);
/** BUY caps by XP tier (owner ruling 2026-11-13): Noob under 69 XP, Winner 69 to 1000 XP inclusive, VIP over 1000 XP.
 * A basket is one trade: the per-trade cap applies to its total. SELLs are never capped and never counted.
 * Env overrides: YEET_TIER_{NOOB,WINNER,VIP}_{TRADE,DAILY}_USDC. */
export const TIER_DEFAULTS=Object.freeze([
 Object.freeze({name:'Noob',minXp:0,trade:'25',daily:'100'}),
 Object.freeze({name:'Winner',minXp:69,trade:'100',daily:'420'}),
 Object.freeze({name:'VIP',minXp:1001,trade:'500',daily:'6767'}),
]);
function tiersFromEnv(env){
 return Object.freeze(TIER_DEFAULTS.map(t=>{const k=t.name.toUpperCase();
  return Object.freeze({name:t.name,minXp:t.minXp,maxTradeRaw:usdcEnv(env,`YEET_TIER_${k}_TRADE_USDC`,t.trade),dailyCapRaw:usdcEnv(env,`YEET_TIER_${k}_DAILY_USDC`,t.daily)})}));
}
/** The tier for an XP total (anything that is not a finite number counts as 0 XP: the lowest caps). */
export function tierFor(limits,xp){
 const n=Number.isFinite(Number(xp))?Number(xp):0;
 return [...limits.tiers].reverse().find(t=>n>=t.minXp)??limits.tiers[0];
}
const big=a=>a.reduce((m,x)=>x>m?x:m,0n);
/** Reads and validates the limits; throws at startup on a malformed value. maxTradeRaw and dailyCapRaw are the highest
 * tier's caps: the account-blind ceiling the drivers re-check (the tiered check is checkBasket/checkDaily with caps). */
export function limitsFromEnv(env=process.env){
 const tiers=tiersFromEnv(env);
 return Object.freeze({
  minLegRaw:usdcEnv(env,'YEET_MIN_LEG_USDC','3'),
  minSkeetRaw:usdcEnv(env,'YEET_MIN_SKEET_USDC','0.5'),
  skeetWarnRaw:usdcEnv(env,'YEET_SKEET_WARN_USDC','1'),
  tiers,
  // Optional global ceilings (the old flat caps): when set they also clamp every tier (capsFor).
  maxTradeRaw:usdcEnv(env,'YEET_MAX_TRADE_USDC',fmt(big(tiers.map(t=>t.maxTradeRaw)))),
  dailyCapRaw:usdcEnv(env,'YEET_DAILY_CAP_USDC',fmt(big(tiers.map(t=>t.dailyCapRaw)))),
  maxCostBps:intEnv(env,'YEET_MAX_COST_BPS',800,10_000),
  requoteToleranceBps:intEnv(env,'YEET_REQUOTE_TOLERANCE_BPS',50,1000),
  codeMintLimit:intEnv(env,'YEET_CODE_MINT_LIMIT',20,10_000),
  trackMaxHours:intEnv(env,'YEET_TRACK_MAX_HOURS',24,24*30),
  killSwitch:['1','true','on','yes'].includes(String(env.YEET_KILL_SWITCH??'').toLowerCase()),
  live:env.YEET_LIVE==='1',
  liveAccounts:liveAccountsFromEnv(env),
  basePolicyId:env.YEET_BASE_POLICY_ID?.trim()||null,
  solanaPolicyId:env.YEET_SOLANA_POLICY_ID?.trim()||null,
  maxLegs:MAX_LEGS,
 });
}

export function checkKillSwitch(limits){if(limits.killSwitch)refuse('TRADING_PAUSED','kill switch')}
export function checkLegCount(limits,n){if(!Number.isInteger(n)||n<1||n>limits.maxLegs)refuse('INVALID_ARGUMENT','leg count')}
const fmt=raw=>{const s=(raw/1_000_000n).toString(),f=(raw%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${s}.${f}`:s};
/** One account's BUY caps today: {tier, xp, maxTradeRaw, dailyCapRaw, spentRaw, leftRaw}. */
export function capsFor(db,limits,accountId,ms,xp){
 const t=tierFor(limits,xp),spentRaw=spentToday(db,accountId,ms);
 const min=(a,b)=>a<b?a:b,maxTradeRaw=min(t.maxTradeRaw,limits.maxTradeRaw),dailyCapRaw=min(t.dailyCapRaw,limits.dailyCapRaw);
 return {tier:t.name,xp:Number.isFinite(Number(xp))?Number(xp):0,maxTradeRaw,dailyCapRaw,spentRaw,leftRaw:spentRaw>=dailyCapRaw?0n:dailyCapRaw-spentRaw};
}
/** The card's view of capsFor (yeet_home.limits, proposal.limits). */
export const capsView=c=>({tier:c.tier,per_trade_usdc:fmt(c.maxTradeRaw),daily_limit_usdc:fmt(c.dailyCapRaw),left_today_usdc:fmt(c.leftRaw)});
const nextTier=(limits,c)=>limits.tiers.find(t=>t.dailyCapRaw>c.dailyCapRaw||t.maxTradeRaw>c.maxTradeRaw);
const upsell=(limits,c,what)=>{const n=nextTier(limits,c);return n?` Earn XP to reach ${n.name} at ${n.minXp} XP for ${fmt(what==='trade'?n.maxTradeRaw:n.dailyCapRaw)} USDC ${what==='trade'?'per trade':'a day'}.`:''};
/** LIMIT_EXCEEDED in product voice, with the tier and the numbers (contract failure.message, max 500 characters). */
function overCap(limits,c,what){
 const msg=what==='trade'
  ?`That's over your ${fmt(c.maxTradeRaw)} USDC per-trade limit as a ${c.tier} (${c.xp} XP), so lower the amount.${upsell(limits,c,'trade')}`
  :`That would go over your ${fmt(c.dailyCapRaw)} USDC daily limit as a ${c.tier} (${c.xp} XP): you have ${fmt(c.leftRaw)} USDC left today, so lower the amount or come back tomorrow.${upsell(limits,c,'daily')}`;
 const e=new TradeError('LIMIT_EXCEEDED',what==='trade'?'over per-trade cap':'over daily cap');
 e.userMessage=msg.slice(0,500);e.caps=capsView(c);throw e;
}
/** YEET: every leg at least the minimum, the total (the whole basket) at most the per-trade cap: the account's tier
 * cap when `caps` (capsFor) is given, else the account-blind ceiling. */
export function checkBasket(limits,legRaws,caps){
 checkLegCount(limits,legRaws.length);
 if(legRaws.some(raw=>raw<limits.minLegRaw))refuse('AMOUNT_TOO_SMALL','leg under minimum');
 const total=legRaws.reduce((a,b)=>a+b,0n);
 if(caps){if(total>caps.maxTradeRaw)overCap(limits,caps,'trade')}
 else if(total>limits.maxTradeRaw)refuse('LIMIT_EXCEEDED','over per-trade cap');
 return total;
}
/** cost_bps = (in - out) / in, both in USD fixed point. */
export function costBps(inUsdRaw,outUsdRaw){
 if(inUsdRaw<=0n)return 0;
 const bps=Number(((inUsdRaw-outUsdRaw)*10_000n)/inUsdRaw);
 return Math.max(0,bps);
}
export function checkCost(limits,bps){if(bps>limits.maxCostBps)refuse('COST_TOO_HIGH',`cost ${bps} bps`)}

export function spentToday(db,accountId,ms){
 const row=db.prepare('SELECT usdc_raw FROM daily_spend WHERE account_id=? AND day=?').get(accountId,utcDay(ms));
 return row?BigInt(row.usdc_raw):0n;
}
/** Today's BUY spend plus `addRaw` must stay within the daily cap: the tier's when `xp` is given (a number), else the
 * account-blind ceiling. Re-reads today's spend, so it is safe inside the commit transaction. */
export function checkDaily(db,limits,accountId,ms,addRaw,xp){
 if(xp!==undefined){const c=capsFor(db,limits,accountId,ms,xp);if(c.spentRaw+addRaw>c.dailyCapRaw)overCap(limits,c,'daily');return}
 if(spentToday(db,accountId,ms)+addRaw>limits.dailyCapRaw)refuse('LIMIT_EXCEEDED','over daily cap');
}
/** Adds to today's spend; call inside the transaction that commits the trade. */
export function recordSpend(db,accountId,ms,addRaw){
 const day=utcDay(ms),prior=spentToday(db,accountId,ms);
 db.prepare('INSERT INTO daily_spend(account_id,day,usdc_raw) VALUES(?,?,?) ON CONFLICT(account_id,day) DO UPDATE SET usdc_raw=excluded.usdc_raw').run(accountId,day,(prior+addRaw).toString());
}

/** AMOUNT_TOO_SMALL for a SELL, in product voice (contract failure.message; a card prints it as it is, so it names
 * no network): the sale is too small, the minimum in force, and why (owner, 2026-11-14: a sale under the minimum does
 * not cover the swap fees, and those are not YEET's). What works instead is the guidance's part (mcp/guidance.mjs). */
export function skeetTooSmall(limits){
 return `This is too small to sell right now. A sale under ${fmt(limits.minSkeetRaw)} USDC would not cover the swap fees. These are network fees, not YEET fees.`;
}

// Server-side trade limits (port plan 2.3 item 4 and risk 3). Every refusal is one catalogue code.
//   YEET_MIN_LEG_USDC    minimum USDC per coin (default 3)         -> AMOUNT_TOO_SMALL
//   YEET_MAX_TRADE_USDC  maximum USDC per trade (default 25)       -> LIMIT_EXCEEDED
//   YEET_DAILY_CAP_USDC  USDC per account per UTC day (default 50) -> LIMIT_EXCEEDED
//   YEET_MAX_COST_BPS    swap cost ceiling in bps (default 800)    -> COST_TOO_HIGH
//   YEET_KILL_SWITCH     1/true: no new proposals or trades        -> TRADING_PAUSED
//   YEET_REQUOTE_TOLERANCE_BPS  live output may be this far under the previewed estimate at the tap (default 50)
//   YEET_CODE_MINT_LIMIT confirm codes per account per 10 minutes (default 20) -> TEMPORARILY_UNAVAILABLE
//   YEET_TRACK_MAX_HOURS hours a trade is tracked past its 1Click deposit deadline before it is stale (default 24)
//   YEET_BASE_POLICY_ID / YEET_SOLANA_POLICY_ID  the Privy policy the delegated signer must carry on each chain; a
//                        wallet whose signer entry has any other policy set is refused     -> WALLET_NOT_READY
// The daily cap is enforced here only: Privy's aggregation does not count eth_sendTransaction (PRIVY-SETUP-REVIEW).
//   at most 5 legs                                                 -> INVALID_ARGUMENT
import {parseUnits} from './router.mjs';
import {refuse,utcDay} from './util.mjs';

export const MAX_LEGS=5;
export const COST_WARN_BPS=300;
const USDC_RE=/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;

function usdcEnv(env,name,fallback){
 const v=env[name]===undefined||env[name]===''?fallback:env[name];
 if(!USDC_RE.test(v))throw Error(`Invalid ${name}`);
 return parseUnits(v,6);
}
function intEnv(env,name,fallback,max){
 const v=env[name]===undefined||env[name]===''?fallback:Number(env[name]);
 if(!Number.isSafeInteger(v)||v<0||v>max)throw Error(`Invalid ${name}`);
 return v;
}
/** Reads and validates the limits; throws at startup on a malformed value. */
export function limitsFromEnv(env=process.env){
 return Object.freeze({
  minLegRaw:usdcEnv(env,'YEET_MIN_LEG_USDC','3'),
  maxTradeRaw:usdcEnv(env,'YEET_MAX_TRADE_USDC','25'),
  dailyCapRaw:usdcEnv(env,'YEET_DAILY_CAP_USDC','50'),
  maxCostBps:intEnv(env,'YEET_MAX_COST_BPS',800,10_000),
  requoteToleranceBps:intEnv(env,'YEET_REQUOTE_TOLERANCE_BPS',50,1000),
  codeMintLimit:intEnv(env,'YEET_CODE_MINT_LIMIT',20,10_000),
  trackMaxHours:intEnv(env,'YEET_TRACK_MAX_HOURS',24,24*30),
  killSwitch:['1','true','on','yes'].includes(String(env.YEET_KILL_SWITCH??'').toLowerCase()),
  live:env.YEET_LIVE==='1',
  basePolicyId:env.YEET_BASE_POLICY_ID?.trim()||null,
  solanaPolicyId:env.YEET_SOLANA_POLICY_ID?.trim()||null,
  maxLegs:MAX_LEGS,
 });
}

export function checkKillSwitch(limits){if(limits.killSwitch)refuse('TRADING_PAUSED','kill switch')}
export function checkLegCount(limits,n){if(!Number.isInteger(n)||n<1||n>limits.maxLegs)refuse('INVALID_ARGUMENT','leg count')}
/** YEET: every leg at least the minimum, the total at most the per-trade cap. */
export function checkBasket(limits,legRaws){
 checkLegCount(limits,legRaws.length);
 if(legRaws.some(raw=>raw<limits.minLegRaw))refuse('AMOUNT_TOO_SMALL','leg under minimum');
 const total=legRaws.reduce((a,b)=>a+b,0n);
 if(total>limits.maxTradeRaw)refuse('LIMIT_EXCEEDED','over per-trade cap');
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
/** Today's spend plus `addRaw` must stay within the daily cap. */
export function checkDaily(db,limits,accountId,ms,addRaw){
 if(spentToday(db,accountId,ms)+addRaw>limits.dailyCapRaw)refuse('LIMIT_EXCEEDED','over daily cap');
}
/** Adds to today's spend; call inside the transaction that commits the trade. */
export function recordSpend(db,accountId,ms,addRaw){
 const day=utcDay(ms),prior=spentToday(db,accountId,ms);
 db.prepare('INSERT INTO daily_spend(account_id,day,usdc_raw) VALUES(?,?,?) ON CONFLICT(account_id,day) DO UPDATE SET usdc_raw=excluded.usdc_raw').run(accountId,day,(prior+addRaw).toString());
}

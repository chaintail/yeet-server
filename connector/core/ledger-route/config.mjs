// The route switch and the ledger route's settings (docs/LEDGER-ROUTE.md).
//   YEET_ROUTE            chain (default: today's 1Click chain-to-chain route for everyone) | ledger (everyone trades
//                         on the NEAR Intents ledger)
//   YEET_LEDGER_ACCOUNTS  comma-separated account ids that trade on the ledger while YEET_ROUTE is chain
// The ledger route is ON when YEET_ROUTE=ledger or YEET_LEDGER_ACCOUNTS names an account. It then needs, or the
// pipeline refuses to start:
//   YEET_SOLVER_ACCOUNT          our solver's account inside intents.near (64 hex: the solver key's implicit account)
//   YEET_SOLVER_KEY_FILE         its key file (mode 0600; ops/intents-direct-spike.mjs --setup writes this format)
//   YEET_SOLVER_MAX_TRADE_USDC   the most USDC the solver puts up for one trade
//   YEET_SOLVER_MAX_DAY_USDC     the most USDC the solver puts up per UTC day, all trades together
// Optional:
//   NEAR_RPC_URL                       first NEAR RPC endpoint (the public ones follow)
//   YEET_LEDGER_DEADLINE_S             how long the person's approval is valid (default 180, 90..600)
//   YEET_LEDGER_MIN_RUN_S              time that must be left when the approval arrives (default 60)
//   YEET_LEDGER_MIN_LEFT_S             nothing is settled closer to the deadline than this (default 10)
//   YEET_LEDGER_SOURCE_SLIPPAGE_BPS    slippage of the solver's sourcing quotes (default 100, 1..1000)
//   YEET_SOLVER_UNLOAD_MAX_TRIES       tries per coin and UTC day to sell leftover inventory (default 3, 0..20)
//   YEET_SOLVER_UNLOAD_MAX_USDC        the most USDC worth of one coin a single unload sells (default: the per-trade cap)
import {parseUnits} from '../trade/router.mjs';

export const ROUTES=Object.freeze(['chain','ledger']);
const ACCOUNT_ID=/^[A-Za-z0-9_-]{1,120}$/;
const USDC=/^\d{1,7}(\.\d{1,6})?$/;

function int(env,name,fallback,min,max){
 const v=env[name]?.trim();
 if(!v)return fallback;
 if(!/^\d{1,6}$/.test(v)||Number(v)<min||Number(v)>max)throw Error(`Invalid ${name} (${min}..${max})`);
 return Number(v);
}
function usdc(env,name,{required,fallback=null}){
 const v=env[name]?.trim();
 if(!v){if(required)throw Error(`The ledger route needs ${name}`);return fallback}
 if(!USDC.test(v)||!(Number(v)>0))throw Error(`Invalid ${name} (a positive USDC amount like 25)`);
 return parseUnits(v,6);
}

/** YEET_ROUTE and YEET_LEDGER_ACCOUNTS alone: {route, accounts (Set), enabled}. Throws on a value it does not know. */
export function routeFromEnv(env=process.env){
 const route=env.YEET_ROUTE?.trim().toLowerCase()||'chain';
 if(!ROUTES.includes(route))throw Error('Invalid YEET_ROUTE (chain or ledger)');
 const list=(env.YEET_LEDGER_ACCOUNTS??'').split(',').map(s=>s.trim()).filter(Boolean);
 for(const a of list)if(!ACCOUNT_ID.test(a))throw Error('Invalid YEET_LEDGER_ACCOUNTS');
 const accounts=new Set(list);
 return {route,accounts,enabled:route==='ledger'||accounts.size>0};
}
/** Whether `accountId` trades on the ledger route. */
export const onLedger=(cfg,accountId)=>!!cfg?.enabled&&(cfg.route==='ledger'||cfg.accounts.has(accountId));

/** The whole configuration. With the route off: {enabled:false} and nothing else is read. With it on, every required
 * setting must be present and well formed, else this throws (the pipeline does not start). */
export function ledgerConfig(env=process.env){
 const r=routeFromEnv(env);
 if(!r.enabled)return Object.freeze({...r});
 const solverAccount=env.YEET_SOLVER_ACCOUNT?.trim();
 if(!solverAccount)throw Error('The ledger route needs YEET_SOLVER_ACCOUNT');
 if(!/^[0-9a-f]{64}$/.test(solverAccount))throw Error('Invalid YEET_SOLVER_ACCOUNT (64 hex characters)');
 const solverKeyFile=env.YEET_SOLVER_KEY_FILE?.trim();
 if(!solverKeyFile)throw Error('The ledger route needs YEET_SOLVER_KEY_FILE');
 const maxTradeRaw=usdc(env,'YEET_SOLVER_MAX_TRADE_USDC',{required:true}),maxDayRaw=usdc(env,'YEET_SOLVER_MAX_DAY_USDC',{required:true});
 if(maxDayRaw<maxTradeRaw)throw Error('YEET_SOLVER_MAX_DAY_USDC is below YEET_SOLVER_MAX_TRADE_USDC');
 const deadlineS=int(env,'YEET_LEDGER_DEADLINE_S',180,90,600),minRunS=int(env,'YEET_LEDGER_MIN_RUN_S',60,20,300),minLeftS=int(env,'YEET_LEDGER_MIN_LEFT_S',10,5,60);
 if(minRunS+15>deadlineS)throw Error('YEET_LEDGER_MIN_RUN_S leaves no time to approve inside YEET_LEDGER_DEADLINE_S');
 if(minLeftS>=minRunS)throw Error('YEET_LEDGER_MIN_LEFT_S must be below YEET_LEDGER_MIN_RUN_S');
 const nearRpc=env.NEAR_RPC_URL?.trim()||null;
 if(nearRpc&&!/^https:\/\//.test(nearRpc))throw Error('Invalid NEAR_RPC_URL');
 return Object.freeze({...r,solverAccount,solverKeyFile,maxTradeRaw,maxDayRaw,deadlineS,minRunS,minLeftS,nearRpc,
  sourceSlippageBps:int(env,'YEET_LEDGER_SOURCE_SLIPPAGE_BPS',100,1,1000),
  unloadMaxTries:int(env,'YEET_SOLVER_UNLOAD_MAX_TRIES',3,0,20),
  unloadMaxRaw:usdc(env,'YEET_SOLVER_UNLOAD_MAX_USDC',{required:false,fallback:maxTradeRaw})});
}

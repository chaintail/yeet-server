// The core's one trade pipeline (pipeline/pipeline.mjs: the person's own wallet signs, YEET adds only the network fee),
// created on first use from the environment ($STATE_DIR/trade.sqlite, ONECLICK_JWT, SOLANA_RPC_URL, BASE_RPC_URL, the
// fee payer and the limits). In-process tests (TEST_PROFILE=1 only) swap in fakes for 1Click, the wallets and the
// drivers with configureTradeEngine.
import {openTradeDb} from './db.mjs';
import {createPipeline} from '../pipeline/pipeline.mjs';
import {didFor} from '../identity-store.mjs';
import {TEST,AS} from '#shared/common.mjs';
import {agentRouteOn} from '#shared/agent-route.mjs';
import {agentAccounts,createAgents,agentLimitsFromEnv} from '../agent/agents.mjs';

let pending,overrides={};
const listeners=new Set();
/** Subscribes to the tracker's onSettled event (XP, lane E). Returns the undo. A listener's failure is contained. */
export function onTradeSettled(fn){listeners.add(fn);return()=>listeners.delete(fn)}
const settled=e=>{
 console.log(JSON.stringify({event:'trade_settled',trade:e.tradeId,direction:e.direction,status:e.status}));
 for(const fn of listeners)try{fn(e)}catch{}
};

export function configureTradeEngine(o={}){
 if(!TEST)throw Error('configureTradeEngine is for in-process tests only');
 pending?.then(e=>e.tracker.stop(),()=>{});
 overrides=o;pending=undefined;
}
export function tradeEngine(){
 return pending??=(async()=>{
  const db=overrides.db??openTradeDb();
  // The agent route (core/agent/agents.mjs, YEET_AGENT_ROUTE=on): agent accounts trade on the ledger with their own key.
  // Off: the pipeline is created exactly as before.
  const agents=agentRouteOn()?agentAccounts(db):undefined;
  const e=createPipeline({db,didFor,onSettled:settled,...(agents?{agents}:{}),...overrides});
  if(agents)e.agentService=createAgents({db,engine:e,limits:agentLimitsFromEnv(),pageUrl:id=>`${AS}/sign?trade_id=${id}`,...(overrides.now?{now:overrides.now}:{}),log:l=>console.log(JSON.stringify(l))});
  e.tracker.start();
  return e;
 })();
}
/** The agent service (only with YEET_AGENT_ROUTE=on). */
export const agentService=async()=>{const e=await tradeEngine();if(!e.agentService)throw Error('agent route off');return e.agentService};

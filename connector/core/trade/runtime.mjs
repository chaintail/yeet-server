// The core's one trade engine, created on first use from the environment ($STATE_DIR/trade.sqlite, YEET_SIGNER,
// ONECLICK_JWT, BASE_RPC_URL, SOLANA_RPC_URL, limits). In-process tests (TEST_PROFILE=1 only) swap in fakes for
// 1Click, the signer and the balances with configureTradeEngine.
import {openTradeDb} from './db.mjs';
import {createEngine} from './engine.mjs';
import {didFor} from '../identity-store.mjs';
import {TEST} from '#shared/common.mjs';

let pending,overrides={};
const settled=({tradeId,status,direction})=>console.log(JSON.stringify({event:'trade_settled',trade:tradeId,direction,status}));

export function configureTradeEngine(o={}){
 if(!TEST)throw Error('configureTradeEngine is for in-process tests only');
 pending?.then(e=>e.tracker.stop(),()=>{});
 overrides=o;pending=undefined;
}
export function tradeEngine(){
 return pending??=(async()=>{
  const e=await createEngine({db:overrides.db??openTradeDb(),didFor,onSettled:settled,...overrides});
  e.tracker.start();
  return e;
 })();
}

// The read-only check behind ops/ledger-route-check.mjs: for one wallet address, the ledger account its key owns, what
// that account holds, a quote for a basket and the exact message the person would approve for it. Uses view calls and
// DRY quotes only: no key is loaded, nothing is signed, stored or sent, and no quote that could be paid is asked for.
import {openTradeDb} from '../trade/db.mjs';
import {CATALOG,formatUnits,parseUnits,splitByParts,findToken} from '../trade/router.mjs';
import {limitsFromEnv} from '../trade/limits.mjs';
import {USDC_SOL_TOKEN_ID} from '../intents/constants.mjs';
import {createLedgerRoute,ledgerAccountOf} from './route.mjs';

const TOKEN_ID=/^nep141:[a-z0-9._-]{2,64}$/;

/** `address` = the person's Solana wallet address (public). `solverAccount` = our solver's ledger account (64 hex).
 * `verifier` = core/intents/verifier.mjs createVerifier, `client` = a 1Click client. Returns the report object. */
export async function ledgerCheck({address,solverAccount,usdc='5',coins='WIF,BOME,TRUMP',slippageBps=100,env={},verifier,client,catalog=CATALOG,now=Date.now,deadlineS=180,minRunS=60}){
 if(!/^[0-9a-f]{64}$/.test(solverAccount??''))throw Error('the solver account is 64 hex characters');
 const account=ledgerAccountOf(address);
 const symbols=String(coins).split(',').map(s=>s.trim()).filter(Boolean);
 if(!symbols.length||symbols.length>5)throw Error('1 to 5 coins, comma separated');
 const entries=symbols.map(s=>{const e=findToken(s,'solana',catalog);if(!e||e.assetId===USDC_SOL_TOKEN_ID||!TOKEN_ID.test(e.assetId))throw Error(`unknown coin ${s}`);return e});
 if(new Set(entries.map(e=>e.assetId)).size!==entries.length)throw Error('a coin is listed twice');
 const total=parseUnits(String(usdc),6);
 if(total<=0n)throw Error('the amount must be positive');
 const listed=catalog.filter(e=>e.chain==='solana'&&TOKEN_ID.test(e.assetId));
 const [bal,[float]]=await Promise.all([verifier.balances(account,listed.map(e=>e.assetId)),verifier.balances(solverAccount,[USDC_SOL_TOKEN_ID])]);
 const have=bal[listed.findIndex(e=>e.assetId===USDC_SOL_TOKEN_ID)]??0n;
 const shares=splitByParts(total,entries.map(()=>1));
 // The route itself builds the plan and the message, over a database in memory and a solver that is only an account
 // id here: its bounds are not applied (they are settings of the running service) and its float is reported below.
 const route=createLedgerRoute({db:openTradeDb(':memory:'),cfg:{enabled:true,route:'ledger',accounts:new Set(),deadlineS,minRunS,minLeftS:10,sourceSlippageBps:slippageBps},verifier,client,catalog,now,hooks:{},
  solver:{accountId:solverAccount,checkExposure(){},float:async()=>total}});
 const d=await route.draft({direction:'yeet',slippageBps,w:{solana:{address}},legs:entries.map((e,i)=>({symbol:e.symbol,asset_id:e.assetId,amount_in_raw:shares[i].toString(),parts:1}))});
 const minLeg=limitsFromEnv(env).minLegRaw,small=shares.some(s=>s<minLeg);
 return {
  moves:'nothing: view calls and dry quotes only',
  wallet_address:address,ledger_account:account,
  balances:listed.map((e,i)=>({symbol:e.symbol,token_id:e.assetId,raw:bal[i].toString(),amount:formatUnits(bal[i],e.decimals)})).filter(b=>b.raw!=='0'),
  usdc_spendable:formatUnits(have,6),covers_basket:have>=total,
  solver:{account:solverAccount,usdc_float:formatUnits(float,6),covers_basket:float>=total},
  basket:{usdc:formatUnits(total,6),slippage_bps:slippageBps,fee_pips:d.live.ledger.feePips,
   legs:d.live.legs.map(l=>({symbol:l.symbol,usdc_in:l.amountInFormatted,est_out:l.amountOutFormatted,min_out:l.minAmountOutFormatted,time_estimate_s:l.timeEstimate}))},
  product_limits:{min_per_coin_usdc:formatUnits(minLeg,6),basket_passes:!small,
   ...(small?{note:`the service refuses this basket: ${formatUnits(shares.reduce((a,b)=>a<b?a:b),6)} USDC per coin is under the ${formatUnits(minLeg,6)} USDC minimum per coin`}:{})},
  would_approve:{standard:'raw_ed25519',signer_id:account,deadline:d.deadline,approve_before:d.approve_before,gives:d.gives,receives:d.receives,message:d.message,
   note:'the nonce and the deadline are made new for every request; everything else is what a request for this basket states right now'},
 };
}

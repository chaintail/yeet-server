#!/usr/bin/env node
// Read-only check of the ledger route for one wallet (docs/LEDGER-ROUTE.md). Prints, as JSON lines: the ledger account
// the wallet's key owns, what it holds, the solver's float, a quote for a basket and the exact message the person
// would approve for it. It loads no key, signs nothing, stores nothing and sends nothing: NEAR view calls and 1Click
// DRY quotes without an API key only.
//   node ops/ledger-route-check.mjs --address <solana wallet address> [--solver <64 hex>] [--usdc 5] [--coins WIF,BOME,TRUMP]
//        [--slippage-bps 100] [--near-rpc <https url>]
// --solver defaults to YEET_SOLVER_ACCOUNT. Env read: YEET_SOLVER_ACCOUNT, NEAR_RPC_URL, YEET_MIN_LEG_USDC (optional).
import {OneClickClient} from '../connector/core/trade/router.mjs';
import {statusTolerantFetch} from '../connector/core/pipeline/oneclick-status.mjs';
import {createNearRpc,createVerifier} from '../connector/core/intents/verifier.mjs';
import {NEAR_RPC_URLS} from '../connector/core/intents/constants.mjs';
import {ledgerCheck} from '../connector/core/ledger-route/check.mjs';

const VALUE=new Set(['--address','--solver','--usdc','--coins','--slippage-bps','--near-rpc']);
export function parseArgs(argv,env=process.env){
 const o={address:null,solver:env.YEET_SOLVER_ACCOUNT?.trim()||null,usdc:'5',coins:'WIF,BOME,TRUMP',slippageBps:100,nearRpc:env.NEAR_RPC_URL?.trim()||null};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(!VALUE.has(a))throw Error(`unknown argument ${a}`);
  const v=argv[++i];
  if(v===undefined||v.startsWith('--'))throw Error(`${a} needs a value`);
  if(a==='--slippage-bps')o.slippageBps=Number(v);else if(a==='--near-rpc')o.nearRpc=v;else o[a.slice(2)]=v;
 }
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.address??''))throw Error('--address is the Solana wallet address');
 if(!/^[0-9a-f]{64}$/.test(o.solver??''))throw Error('--solver (or YEET_SOLVER_ACCOUNT) is the solver account, 64 hex characters');
 if(!/^\d{1,4}(\.\d{1,6})?$/.test(o.usdc)||!(Number(o.usdc)>0))throw Error('--usdc is a positive amount like 5');
 if(!Number.isInteger(o.slippageBps)||o.slippageBps<1||o.slippageBps>1000)throw Error('--slippage-bps is 1..1000');
 if(o.nearRpc&&!/^https:\/\//.test(o.nearRpc))throw Error('--near-rpc is an https url');
 return o;
}
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
async function main(){
 let o;
 try{o=parseArgs(process.argv.slice(2))}catch(e){process.stderr.write(`usage: ${e.message}\n`);return 2}
 const rpc=createNearRpc({urls:o.nearRpc?[o.nearRpc,...NEAR_RPC_URLS]:NEAR_RPC_URLS});
 // keyless on purpose, whatever ONECLICK_JWT holds: the check must not depend on a secret
 const client=new OneClickClient({jwt:undefined,fetch:statusTolerantFetch()});
 const r=await ledgerCheck({address:o.address,solverAccount:o.solver,usdc:o.usdc,coins:o.coins,slippageBps:o.slippageBps,env:process.env,verifier:createVerifier({rpc}),client});
 emit({step:'account',moves:r.moves,wallet_address:r.wallet_address,ledger_account:r.ledger_account,usdc_spendable:r.usdc_spendable,covers_basket:r.covers_basket,balances:r.balances});
 emit({step:'solver',...r.solver});
 emit({step:'quote',...r.basket,product_limits:r.product_limits});
 emit({step:'would_approve',...r.would_approve});
 emit({step:'done',ok:true,sent:'nothing'});
 return 0;
}
if(import.meta.url===`file://${process.argv[1]}`){
 main().then(code=>{process.exitCode=code},e=>{emit({step:'failed',message:String(e?.detail??e?.message??e).slice(0,300)});process.exitCode=1});
}

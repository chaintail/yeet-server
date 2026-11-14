#!/usr/bin/env node
// Checks of the ledger route for one wallet (docs/LEDGER-ROUTE.md). JSON lines.
//
// 1. The read-only check (default). Prints the ledger account the wallet's key owns, what it holds, the SOLVER'S FLOAT
//    (its USDC inside the ledger and its NEAR for gas: look at it before a trade; a float below the basket means the
//    trade is refused), a quote for a basket and the exact message the person would approve for it. It loads no key,
//    signs nothing, stores nothing and sends nothing: NEAR view calls and 1Click DRY quotes without an API key only.
//      node ops/ledger-route-check.mjs --address <solana wallet address> [--solver <64 hex>] [--usdc 5] [--coins WIF,BOME,TRUMP]
//           [--slippage-bps 100] [--near-rpc <https url>]
//    --solver defaults to YEET_SOLVER_ACCOUNT. Env read: YEET_SOLVER_ACCOUNT, NEAR_RPC_URL, YEET_MIN_LEG_USDC (optional).
//
// 2. The wallet's permanent deposit addresses (docs/LEDGER-ROUTE.md 1.5 and 6.3). Needs the 1Click partner key in env
//    ONECLICK_JWT; the key is never printed. No funds move.
//      node ops/ledger-route-check.mjs --address <solana wallet address> --deposit-addresses [--account <yeet account id>] [--db <file>]
//    Reads the set stored in --db; when there is none, takes over the set 1Click already holds for this wallet's
//    ledger account, and only when none exists creates it (once: recipient and refund account are the wallet's own
//    ledger account). Prints every chain and address of the set and which of them the card shows.
//      node ops/ledger-route-check.mjs --address <solana wallet address> --deposit-watch [--follow-s 900] [--account …] [--db <file>]
//    The same, then follows a deposit: every 10 s the watch the card uses (its stage, the ledger USDC) and 1Click's
//    own status of the set, one line per change, until the USDC is there or --follow-s is over.
//    --db defaults to ~/.local/state/yeet/ledger-deposits.sqlite (created 0600 in a 0700 directory).
import {mkdirSync,chmodSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {OneClickClient,CATALOG,formatUnits} from '../connector/core/trade/router.mjs';
import {statusTolerantFetch} from '../connector/core/pipeline/oneclick-status.mjs';
import {createNearRpc,createVerifier} from '../connector/core/intents/verifier.mjs';
import {NEAR_RPC_URLS} from '../connector/core/intents/constants.mjs';
import {ledgerCheck} from '../connector/core/ledger-route/check.mjs';

const VALUE=new Set(['--address','--solver','--usdc','--coins','--slippage-bps','--near-rpc','--db','--account','--follow-s']);
const FLAG=new Set(['--deposit-addresses','--deposit-watch']);
export function parseArgs(argv,env=process.env){
 const o={address:null,solver:env.YEET_SOLVER_ACCOUNT?.trim()||null,usdc:'5',coins:'WIF,BOME,TRUMP',slippageBps:100,nearRpc:env.NEAR_RPC_URL?.trim()||null,
  depositAddresses:false,depositWatch:false,db:null,account:null,followS:900};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(FLAG.has(a)){o[a==='--deposit-watch'?'depositWatch':'depositAddresses']=true;continue}
  if(!VALUE.has(a))throw Error(`unknown argument ${a}`);
  const v=argv[++i];
  if(v===undefined||v.startsWith('--'))throw Error(`${a} needs a value`);
  if(a==='--slippage-bps')o.slippageBps=Number(v);else if(a==='--near-rpc')o.nearRpc=v;else if(a==='--follow-s')o.followS=Number(v);else o[a.slice(2)]=v;
 }
 if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.address??''))throw Error('--address is the Solana wallet address');
 const deposits=o.depositAddresses||o.depositWatch;
 if(!deposits&&!/^[0-9a-f]{64}$/.test(o.solver??''))throw Error('--solver (or YEET_SOLVER_ACCOUNT) is the solver account, 64 hex characters');
 if(!/^\d{1,4}(\.\d{1,6})?$/.test(o.usdc)||!(Number(o.usdc)>0))throw Error('--usdc is a positive amount like 5');
 if(!Number.isInteger(o.slippageBps)||o.slippageBps<1||o.slippageBps>1000)throw Error('--slippage-bps is 1..1000');
 if(o.nearRpc&&!/^https:\/\//.test(o.nearRpc))throw Error('--near-rpc is an https url');
 if(!Number.isInteger(o.followS)||o.followS<10||o.followS>3600)throw Error('--follow-s is 10..3600');
 if(o.account!==null&&!/^[A-Za-z0-9_-]{1,120}$/.test(o.account))throw Error('--account is a YEET account id');
 if(!deposits&&(o.db||o.account))throw Error('--db and --account go with --deposit-addresses or --deposit-watch');
 return o;
}
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');

/** --deposit-addresses / --deposit-watch. `deps` are injected by the tests: {deposits, sleep, now}. Returns the exit code. */
export async function depositRun(o,{deposits,accountId,ledgerAccount,emit:out=emit,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 const set=await deposits.ensure(accountId,o.address);
 const d=deposits.describe(accountId);
 out({step:'deposit_addresses',moves:'no funds; the set is made at 1Click once and stored',account_id:accountId,wallet_address:o.address,ledger_account:ledgerAccount,
  state:d?.state??'none',source:d?.source??null,correlation_id:d?.correlation_id??null,card_shows:set.deposit?.networks??[],...(set.deposit?{}:{why:set.why??null}),chains:d?.chains??[]});
 if(!set.deposit)return 1;
 if(!o.depositWatch){out({step:'done',ok:true,sent:'nothing'});return 0}
 let last='';
 for(const t0=now();;){
  const w=await deposits.watch(accountId,ledgerAccount,set.row),oneclick=await deposits.status(accountId).catch(()=>null);
  const line={stage:w.stage,...(w.coin?{coin:w.coin}:{}),...(w.arrived_usdc?{arrived_usdc:w.arrived_usdc}:{}),ledger_usdc:formatUnits(w.usdc_raw,6),oneclick};
  // one line per change of anything the card or the operator can see
  if(JSON.stringify(line)!==last){last=JSON.stringify(line);out({step:'deposit_watch',at:new Date(now()).toISOString(),after_s:Math.round((now()-t0)/1000),...line})}
  if(w.stage==='ready'){out({step:'done',ok:true,credited_usdc:w.arrived_usdc,ledger_usdc:formatUnits(w.usdc_raw,6)});return 0}
  if(now()-t0>=o.followS*1000){out({step:'done',ok:false,reason:`no USDC arrived in ${o.followS} s; run again to keep watching`});return 3}
  await sleep(10_000);
 }
}
async function main(){
 let o;
 try{o=parseArgs(process.argv.slice(2))}catch(e){process.stderr.write(`usage: ${e.message}\n`);return 2}
 const rpc=createNearRpc({urls:o.nearRpc?[o.nearRpc,...NEAR_RPC_URLS]:NEAR_RPC_URLS});
 const verifier=createVerifier({rpc});
 if(o.depositAddresses||o.depositWatch){
  const key=process.env.ONECLICK_JWT?.trim();
  if(!key){emit({step:'failed',message:'ONECLICK_JWT is not set: the 1Click partner key is needed for deposit addresses'});return 1}
  const {createDeposits,operatorAccountId}=await import('../connector/core/ledger-route/deposits.mjs');
  const {ledgerAccountOf}=await import('../connector/core/ledger-route/route.mjs');
  const {openTradeDb}=await import('../connector/core/trade/db.mjs');
  const file=o.db??join(homedir(),'.local','state','yeet','ledger-deposits.sqlite');
  if(file!==':memory:'){mkdirSync(dirname(file),{recursive:true,mode:0o700})}
  const db=openTradeDb(file);
  if(file!==':memory:'&&existsSync(file))chmodSync(file,0o600);
  const deposits=createDeposits({db,key,verifier,accountOf:ledgerAccountOf,catalog:CATALOG,networks:['solana','base'],stages:'status',log:l=>emit({step:'log',...l})});
  return depositRun(o,{deposits,accountId:o.account??operatorAccountId(o.address),ledgerAccount:ledgerAccountOf(o.address)});
 }
 // keyless on purpose, whatever ONECLICK_JWT holds: the check must not depend on a secret
 const client=new OneClickClient({jwt:undefined,fetch:statusTolerantFetch()});
 const r=await ledgerCheck({address:o.address,solverAccount:o.solver,usdc:o.usdc,coins:o.coins,slippageBps:o.slippageBps,env:process.env,verifier,client});
 emit({step:'account',moves:r.moves,wallet_address:r.wallet_address,ledger_account:r.ledger_account,usdc_spendable:r.usdc_spendable,covers_basket:r.covers_basket,balances:r.balances});
 // The solver's float, before anything else about the trade: its USDC inside the ledger and its NEAR for gas.
 let near=null;
 try{const a=await rpc.call('query',{request_type:'view_account',finality:'final',account_id:o.solver});near=formatUnits(BigInt(a.amount),24).replace(/(\.\d{4})\d+$/,'$1')}catch{near=null}
 emit({step:'solver_float',account:r.solver.account,usdc_float:r.solver.usdc_float,near_for_gas:near,basket_usdc:r.basket.usdc,covers_basket:r.solver.covers_basket,
  ...(r.solver.covers_basket?{}:{warning:`the float does not cover this ${r.basket.usdc} USDC basket: the trade would be refused at the tap ("YEET cannot fill this right now. Nothing was traded.")`}),
  ...(near===null||Number(near)<0.05?{near_warning:'the solver account holds under 0.05 NEAR (or could not be read): it may not be able to send a settlement'}:{})});
 emit({step:'quote',...r.basket,product_limits:r.product_limits});
 emit({step:'would_approve',...r.would_approve});
 emit({step:'done',ok:true,sent:'nothing'});
 return 0;
}
if(import.meta.url===`file://${process.argv[1]}`){
 main().then(code=>{process.exitCode=code},e=>{emit({step:'failed',message:String(e?.detail??e?.message??e).slice(0,300)});process.exitCode=1});
}

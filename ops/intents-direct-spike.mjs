#!/usr/bin/env node
// Spike: trading on NEAR Intents directly, with our own solver and our own NEAR account calling `execute_intents`.
// Two models share this tool:
//   1. docs/INTENTS-DIRECT-SPIKE.md   one user signature swaps USDC into several coins AND withdraws each to Solana;
//      the solver fills from coin inventory (--stock, --trade).
//   2. docs/INTENTS-BALANCE-MODEL.md  the user's USDC and coins STAY inside intents.near under the user's own key; the
//      solver holds USDC only and sources each coin just in time (--solver-usdc, --jit-buy, --jit-sell, --unload,
//      --withdraw-user, --refill).
//
//   node ops/intents-direct-spike.mjs [--plan] [--standard raw_ed25519|erc191|both] [--usdc 4.5] [--coins WIF,BOME,TRUMP]
//        [--bridge-fee signer|intent] [--margin-bps 0] [--sizes 5,10,15,25] [--no-survey] [--near-rpc <url>]
//     PLAN (default): throwaway keys, live prices, every payload of both models signed and run through
//     `simulate_intents` on mainnet, the negative checks, the dry-quote survey without an API key (verifier on both
//     sides, both directions, next to the chain-to-chain route) and the all-in cost table. Needs no secret, sends
//     nothing, costs nothing. Exit 0 when every check came out as expected.
//   node ops/intents-direct-spike.mjs --deposit-user --via omni [--usdc 4.5] [--omni-from <solana address>]
//     PLAN only: the deposit WITHOUT 1Click. Builds the user's own Solana transaction (Omni bridge `init_transfer`,
//     recipient near:intents.near, message = the owner account) and, with --omni-from naming an address that holds the
//     USDC and a little SOL (the test wallet's public address), simulates it on mainnet. Sends nothing.
//
//   INTENTS_SPIKE_CONFIRM=send-spike node ops/intents-direct-spike.mjs --live <one step> --near-key <file> --wallet <file> [options]
//     steps (one per run, each resumable; nothing is ever paid twice):
//       --setup [--fund-near-from-1click [--fund-usdc 2]]   NEAR key file (created 0600 when missing), account id, what it needs
//       --register-omni                                      storage balance on omni.bridge.near (needed by every withdrawal)
//       --solver-usdc <amount>                               USDC into the SOLVER's verifier account (its working float)
//       --deposit-user [<amount>]                            USDC into the USER's verifier account (default --usdc)
//       --jit-buy [--usdc 3] [--coins …] [--source inside|outside]
//                                                            the user signs one token_diff; the solver sources the coins
//                                                            (inside: its verifier USDC through 1Click with the verifier on
//                                                            both sides; outside: the wallet's Solana USDC through 1Click,
//                                                            delivered to the solver's verifier account), then executes
//       --jit-sell --coin WIF [--percent 100]                the reverse; the solver pays at once and unloads afterwards
//       --unload                                             the solver sells every coin it holds back to USDC
//       --withdraw-user --coin WIF                           the user's balance of one token to Solana (Omni bridge), timed
//       --refill [--refill-usdc <amount>]                    the solver's USDC from the verifier back to the wallet, timed
//       --status                                             balances everywhere, both portfolios, the state of every step
//       --withdraw-all user|solver                           every listed verifier balance back out to Solana
//       --stock, --trade                                     model 1 (inventory and withdrawal inside the trade)
//     options: --user-evm (the user signs ERC-191 with the wallet's EVM key; default raw_ed25519 with its Solana key),
//       --new-trade (file a finished buy, sell or deposit away and start another), --recipient <solana address>,
//       --margin-bps 0, --source-slippage-bps 100, --deadline-s (default 120; 300 for --source outside and model 1),
//       --min-left-s 10, --max-loss-bps 10, --state <file> (default <near-key>.state.json), --fee-payer self|privy,
//       --follow-s 600, --bridge-fee, --wnear-usdc 1.
// Env read: ONECLICK_JWT (optional), SOLANA_RPC_URL (optional), NEAR_RPC_URL (optional), and for --fee-payer privy the
// YEET fee payer variables. Output: one JSON object per line; never a key, a seed or an env value.
import {OneClickClient} from '../connector/core/trade/router.mjs';
import {statusTolerantFetch} from '../connector/core/pipeline/oneclick-status.mjs';
import {createNearRpc,createVerifier} from '../connector/core/intents/verifier.mjs';
import {createOmni} from '../connector/core/intents/omni.mjs';
import {runPlan} from '../connector/core/intents/plan.mjs';
import {NEAR_RPC_URLS} from '../connector/core/intents/constants.mjs';

const STEPS=['setup','register-omni','stock','deposit-user','trade','status','withdraw-all','solver-usdc','jit-buy','jit-sell','unload','withdraw-user','refill'];
const VALUE=new Set(['--standard','--usdc','--coins','--bridge-fee','--margin-bps','--near-rpc','--near-key','--wallet','--fund-usdc','--stock-usdc','--recipient','--state','--fee-payer','--follow-s','--deadline-s','--wnear-usdc','--withdraw-all',
 '--solver-usdc','--coin','--percent','--source','--source-slippage-bps','--min-left-s','--max-loss-bps','--sizes','--refill-usdc','--via','--omni-from']);
const FLAG=new Set(['--plan','--live','--setup','--register-omni','--stock','--deposit-user','--trade','--status','--fund-near-from-1click','--user-evm','--new-trade','--jit-buy','--jit-sell','--unload','--withdraw-user','--refill','--no-survey']);
const AMOUNT=/^\d{1,4}(\.\d{1,6})?$/;
const NAMES={'--bridge-fee':'feeMode','--margin-bps':'marginBps','--near-rpc':'nearRpc','--near-key':'nearKey','--fund-usdc':'fundUsdc','--stock-usdc':'stockUsdc','--fee-payer':'feePayer','--follow-s':'followS','--deadline-s':'deadlineS','--wnear-usdc':'wnearUsdc',
 '--source-slippage-bps':'sourceSlippageBps','--min-left-s':'minLeftS','--max-loss-bps':'maxLossBps','--refill-usdc':'refillUsdc','--omni-from':'omniFrom'};
const NUMERIC=['--margin-bps','--follow-s','--deadline-s','--percent','--source-slippage-bps','--min-left-s','--max-loss-bps'];

export function parseArgs(argv){
 const o={mode:'plan',step:null,standard:'both',usdc:'4.5',coins:'WIF,BOME,TRUMP',feeMode:'signer',marginBps:0,nearRpc:null,nearKey:null,wallet:null,fundNear:false,fundUsdc:'2',stockUsdc:'2',wnearUsdc:'1',
  recipient:null,state:null,feePayer:'self',followS:600,deadlineS:null,userEvm:false,newTrade:false,who:null,
  solverUsdc:null,coin:null,percent:100,source:'inside',sourceSlippageBps:100,minLeftS:10,maxLossBps:10,sizes:'5,10,15,25',survey:true,refillUsdc:null,via:'1click',omniFrom:null};
 const step=s=>{if(o.step)throw Error('one step per run');o.step=s};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(FLAG.has(a)){
   if(a==='--plan')o.mode='plan';else if(a==='--live')o.mode='live';
   else if(a==='--fund-near-from-1click')o.fundNear=true;else if(a==='--user-evm')o.userEvm=true;else if(a==='--new-trade')o.newTrade=true;else if(a==='--no-survey')o.survey=false;
   else{
    step(a.slice(2));
    // `--deposit-user 6` is the same as `--deposit-user --usdc 6`
    if(a==='--deposit-user'&&AMOUNT.test(argv[i+1]??''))o.usdc=argv[++i];
   }
   continue;
  }
  if(!VALUE.has(a))throw Error(`unknown argument ${a}`);
  const v=argv[++i];
  if(v===undefined||v.startsWith('--'))throw Error(`${a} needs a value`);
  if(a==='--withdraw-all'){step('withdraw-all');o.who=v}
  else if(a==='--solver-usdc'){step('solver-usdc');o.solverUsdc=v}
  else o[NAMES[a]??a.slice(2)]=NUMERIC.includes(a)?Number(v):v;
 }
 if(!['raw_ed25519','erc191','both'].includes(o.standard))throw Error('--standard is raw_ed25519, erc191 or both');
 if(!['signer','intent'].includes(o.feeMode))throw Error('--bridge-fee is signer or intent');
 if(!['self','privy'].includes(o.feePayer))throw Error('--fee-payer is self or privy');
 if(!['inside','outside'].includes(o.source))throw Error('--source is inside or outside');
 for(const k of ['usdc','fundUsdc','stockUsdc','wnearUsdc','solverUsdc','refillUsdc'])if(o[k]!==null&&(!AMOUNT.test(o[k])||Number(o[k])<=0))throw Error(`${k} must be a positive amount like 4.5`);
 if(!Number.isInteger(o.marginBps)||o.marginBps<0||o.marginBps>2000)throw Error('--margin-bps is 0..2000');
 if(!Number.isInteger(o.followS)||o.followS<0||o.followS>3600)throw Error('--follow-s is 0..3600');
 // the user's intent lives this long: short when the solver sources inside the verifier, longer when a chain deposit is part of it
 o.deadlineS??=o.step==='jit-sell'||(o.step==='jit-buy'&&o.source==='inside')?120:300;
 if(!Number.isInteger(o.deadlineS)||o.deadlineS<60||o.deadlineS>3600)throw Error('--deadline-s is 60..3600');
 if(!Number.isInteger(o.percent)||o.percent<1||o.percent>100)throw Error('--percent is 1..100');
 if(!Number.isInteger(o.sourceSlippageBps)||o.sourceSlippageBps<1||o.sourceSlippageBps>1000)throw Error('--source-slippage-bps is 1..1000');
 if(!Number.isInteger(o.minLeftS)||o.minLeftS<5||o.minLeftS>=o.deadlineS)throw Error('--min-left-s is 5 or more and below --deadline-s');
 if(!Number.isInteger(o.maxLossBps)||o.maxLossBps<0||o.maxLossBps>1000)throw Error('--max-loss-bps is 0..1000');
 o.sizeList=String(o.sizes).split(',').map(Number);
 if(!o.sizeList.length||o.sizeList.length>6||o.sizeList.some(s=>!(s>0)||s>1000))throw Error('--sizes is up to 6 positive USDC amounts, comma separated');
 if(!['1click','omni'].includes(o.via))throw Error('--via is 1click or omni');
 if(o.omniFrom!==null&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.omniFrom))throw Error('--omni-from is a Solana address');
 // the one step --plan accepts: the 1Click-free deposit, built and simulated but never sent
 o.omniDepositPlan=o.mode==='plan'&&o.step==='deposit-user'&&o.via==='omni';
 if(o.mode==='plan'){if(o.step&&!o.omniDepositPlan)throw Error(`--${o.step} is a --live step`)}
 else{
  if(!STEPS.includes(o.step??''))throw Error(`--live needs one step: ${STEPS.map(s=>'--'+s).join(', ')}`);
  if(!o.nearKey)throw Error('--live needs --near-key <file>');
  if(!o.wallet&&!(o.step==='setup'&&!o.fundNear))throw Error('--live needs --wallet <file>');
  if(o.step==='withdraw-all'&&!['user','solver'].includes(o.who))throw Error('--withdraw-all is user or solver');
  if(o.fundNear&&o.step!=='setup')throw Error('--fund-near-from-1click belongs to --setup');
  if(['jit-sell','withdraw-user'].includes(o.step)&&!o.coin)throw Error(`--${o.step} needs --coin <symbol>`);
 }
 return o;
}

const emit=o=>process.stdout.write(JSON.stringify(o,(k,v)=>typeof v==='bigint'?v.toString():v)+'\n');

async function main(){
 let o;
 try{o=parseArgs(process.argv.slice(2))}catch(e){process.stderr.write(`usage: ${e.message}\n`);return 2}
 const urls=o.nearRpc?[o.nearRpc]:process.env.NEAR_RPC_URL?[process.env.NEAR_RPC_URL,...NEAR_RPC_URLS]:NEAR_RPC_URLS;
 const rpc=createNearRpc({urls}),verifier=createVerifier({rpc}),omni=createOmni({rpc}),client=new OneClickClient({fetch:statusTolerantFetch()});

 if(o.mode==='plan'){
  emit({step:'plan',mode:'plan',sends:'nothing',usdc:o.usdc,coins:o.coins,fee_mode:o.feeMode,margin_bps:o.marginBps,near_rpc:o.nearRpc?'custom':'public'});
  const {usdcRaw}=await import('../connector/core/intents/live.mjs');
  const bal=await import('../connector/core/intents/balance-plan.mjs');
  const {basketCoins,splitEven}=await import('../connector/core/intents/basket.mjs');
  const standards=o.standard==='both'?['raw_ed25519','erc191']:[o.standard];
  let ok=true;
  // the deposit without 1Click: the user's own Omni bridge transaction on Solana, built and (with --omni-from) simulated
  const omniDeposit=async()=>{
   const {createRelayRpc}=await import('../connector/core/pipeline/solana/relay-rpc.mjs');
   const {SOLANA_RPC_DEFAULT}=await import('../connector/core/intents/constants.mjs');
   const {ed25519AccountId}=await import('../connector/core/intents/sign.mjs');
   const sol=createRelayRpc({readUrl:process.env.SOLANA_RPC_URL?.trim()||SOLANA_RPC_DEFAULT});
   return bal.probeOmniDeposit({rpc,sol,amount:usdcRaw(o.usdc),from:o.omniFrom,ownerAccount:o.omniFrom?ed25519AccountId(o.omniFrom):null,emit});
  };
  if(o.omniDepositPlan){
   const r=await omniDeposit();
   emit({step:'done',mode:'plan',only:'deposit-user --via omni',ok:r.ok});
   return r.ok?0:1;
  }
  // model 1: the trade that withdraws inside the same signature
  for(const standard of standards){
   const r=await runPlan({standard,usdc:usdcRaw(o.usdc),coins:o.coins,feeMode:o.feeMode,marginBps:o.marginBps,deps:{verifier,omni,client},emit});
   ok&&=r.ok;
  }
  // model 2: balances stay inside the verifier. Everything about 1Click here is asked WITHOUT an API key.
  const keyless=new OneClickClient({jwt:undefined,fetch:statusTolerantFetch()}),coins=basketCoins(o.coins);
  emit({step:'balance_plan',oneclick_api_key:false,note:'every quote below is asked without an API key, whatever ONECLICK_JWT holds'});
  const feePips=await verifier.fee();
  if(o.survey){
   const s=await bal.surveyQuotes({client:keyless,coins,sizes:o.sizeList,feePips,emit});
   const p=await bal.probeSourcing({client:keyless,coin:coins[0],amount:splitEven(usdcRaw(o.usdc),coins.length)[0],emit});
   // the account 1Click names as its own fee recipient holds many tokens: a real portfolio to read
   // (the `appFees` recipient 1Click itself adds to every quote it echoes, seen 2026-11-13)
   const h=await bal.probeHoldings({verifier,account:'5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',emit});
   emit({step:'survey_result',ok:s.ok&&p.ok&&h.ok,failed:[...s.checks,...p.checks,...h.checks].filter(c=>!c.pass).map(c=>c.name)});
   ok&&=s.ok&&p.ok&&h.ok;
  }
  for(const standard of standards){
   const r=await bal.runBalancePlan({standard,usdc:usdcRaw(o.usdc),coins:o.coins,marginBps:o.marginBps,sourceSlippageBps:o.sourceSlippageBps,deps:{verifier,omni,client:keyless},emit});
   ok&&=r.ok;
  }
  {
   const r=await omniDeposit();
   emit({step:'omni_deposit_result',ok:r.ok,failed:r.checks.filter(c=>!c.pass).map(c=>c.name)});
   ok&&=r.ok;
  }
  emit({step:'done',mode:'plan',ok});
  return ok?0:1;
 }
 if(o.step==='deposit-user'&&o.via==='omni'){
  emit({step:'refused',reason:'--deposit-user --via omni exists in plan form only (node ops/intents-direct-spike.mjs --deposit-user --via omni --omni-from <wallet address>): it builds and simulates the transaction and sends nothing. docs/INTENTS-BALANCE-MODEL.md describes the live step.'});
  return 1;
 }

 if(process.env.INTENTS_SPIKE_CONFIRM!=='send-spike'){emit({step:'refused',reason:'--live moves real funds: set INTENTS_SPIKE_CONFIRM=send-spike in the environment to run it'});return 1}
 const live=await import('../connector/core/intents/live.mjs');
 const ctx=await live.createLiveContext({opts:o,env:process.env,deps:{rpc,verifier,omni,client},emit});
 return live.runStep(ctx);
}

if(import.meta.url===`file://${process.argv[1]}`){
 main().then(code=>{process.exitCode=code},e=>{emit({step:'failed',message:String(e?.message??e).slice(0,400)});process.exitCode=1});
}

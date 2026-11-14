// `--live`: the real run, one step per invocation, each resumable from the state file. The operator (not this code's
// author) runs it; ops/intents-direct-spike.mjs refuses it unless INTENTS_SPIKE_CONFIRM=send-spike.
// Every step emits JSON lines through `emit`: account ids, addresses, amounts, hashes, timestamps; never a key.
//   ctx = {near, wallet, user, recipient, rpc, verifier, omni, client, sol, signatureStatus, feePayer, state, save,
//          emit, now, sleep, opts}
import {basketCoins,splitEven,quoteLegs,buildBasketTrade} from './basket.mjs';
import {fundVia1Click} from './funding.mjs';
import {accountState,accessKey,buildFunctionCall,sendTransaction,transactionStatus,loadOrCreateNearKey} from './near-tx.mjs';
import {signerStorageNeeded,reservedTgas,maxWithdrawals} from './omni.mjs';
import {signIntents,omniWithdrawToSolana} from './intents.mjs';
import {nep413Signer,rawEd25519Signer,erc191Signer,intentHash} from './sign.mjs';
import {VERIFIER,OMNI_BRIDGE,EXECUTE_GAS,USDC_SOL_TOKEN_ID,WNEAR_TOKEN_ID,SOLANA_RPC_DEFAULT} from './constants.mjs';
import {associatedTokenAddress,isAddress,USDC_SOLANA,TOKEN_PROGRAM} from '../pipeline/solana/message.mjs';
import {createRelayRpc} from '../pipeline/solana/relay-rpc.mjs';
import {createRpcSignatureStatus} from '../pipeline/solana/signature-status.mjs';
import {feePayerFromEnv} from '../pipeline/solana/fee-payer.mjs';
import {loadTestWallet} from '../pipeline/test-wallet.mjs';
import {parseUnits} from '../trade/router.mjs';
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';

/**
 * Everything a live step needs, from the parsed arguments: the NEAR key file (created 0600 when missing), the test
 * wallet (ops/test-wallet-init.mjs format), the user signer (the wallet's Solana key signing raw_ed25519, or its EVM
 * key signing ERC-191 with --user-evm), the Solana RPC, the optional fee payer, and the state file
 * (default `<near-key>.state.json`, mode 0600). `deps` = {rpc, verifier, omni, client}. Emits one `live` line.
 */
export async function createLiveContext({opts,env,deps,emit,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const n=loadOrCreateNearKey(opts.nearKey);
 const wallet=opts.wallet?loadTestWallet(opts.wallet):null;
 const user=wallet?(opts.userEvm?erc191Signer({address:wallet.base.address,privateKey:wallet.base.privateKey}):rawEd25519Signer(wallet.solana)):null;
 const recipient=opts.recipient??wallet?.solana.address??null;
 if(recipient&&!isAddress(recipient))throw Error('--recipient is not a Solana address');
 const solUrl=env.SOLANA_RPC_URL?.trim()||SOLANA_RPC_DEFAULT;
 const sol=createRelayRpc({readUrl:solUrl,broadcastUrl:env.SOLANA_BROADCAST_RPC_URL?.trim()||solUrl});
 let feePayer=null;
 if(opts.feePayer==='privy'){
  feePayer=feePayerFromEnv(env);
  if(!feePayer)throw Error('--fee-payer privy needs the YEET fee payer variables in the environment');
 }
 const statePath=opts.state??`${opts.nearKey}.state.json`;
 const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{version:1,near_account:n.accountId,steps:{}};
 if(state.version!==1||state.near_account!==n.accountId)throw Error('the state file belongs to another NEAR key');
 state.steps??={};
 const save=()=>{const tmp=`${statePath}.tmp`;writeFileSync(tmp,JSON.stringify(state,null,1)+'\n',{mode:0o600});renameSync(tmp,statePath)};
 emit({step:'live',run:opts.step,near_account:n.accountId,user_account:user?.accountId??null,user_standard:user?.standard??null,recipient,fee_mode:opts.feeMode,coins:opts.coins,
  solana_wallet:wallet?.solana.address??null,solana_rpc:env.SOLANA_RPC_URL?'from env':'public',oneclick_authenticated:Boolean(deps.client.authenticated),fee_payer:feePayer?'privy':'self',state_file:statePath});
 return {near:n,wallet,user,recipient,...deps,sol,signatureStatus:createRpcSignatureStatus({endpoint:solUrl}),feePayer,state,save,emit,now,sleep,opts};
}
const JIT_STEPS={'solver-usdc':'stepSolverUsdc','jit-buy':'stepJitBuy','jit-sell':'stepJitSell','unload':'stepUnload','withdraw-user':'stepWithdrawUser','refill':'stepRefill'};
/** Runs the step named in `ctx.opts.step`; returns the process exit code. */
export async function runStep(ctx){
 const step=ctx.opts.step;
 if(step==='setup')await stepSetup(ctx);
 else if(step==='register-omni')await stepRegisterOmni(ctx);
 else if(step==='stock')await stepStock(ctx);
 else if(step==='deposit-user')await stepDepositUser(ctx);
 else if(step==='trade')return (await stepTrade(ctx))?.ok?0:1;
 else if(step==='status'){await stepStatus(ctx);if(typeof ctx.verifier.holdings==='function')await (await import('./live-jit.mjs')).statusHoldings(ctx)}
 else if(step==='withdraw-all')await stepWithdrawAll(ctx,ctx.opts.who);
 else if(JIT_STEPS[step]){
  // the balance-model steps (live-jit.mjs): the exit code is 0 only when the step's result line says ok
  const jit=await import('./live-jit.mjs');
  return (await jit[JIT_STEPS[step]](ctx))?.ok===false?1:0;
 }
 else throw Error(`unknown step ${step}`);
 return 0;
}

const iso=ms=>new Date(ms).toISOString();
export const near=y=>{const s=BigInt(y).toString().padStart(25,'0');return `${s.slice(0,-24)}.${s.slice(-24,-18)}`};
const str=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='bigint'?v.toString():v]));
export const usdcRaw=v=>parseUnits(String(v),6);
export const USDC_COIN={symbol:'USDC',tokenId:USDC_SOL_TOKEN_ID,mint:USDC_SOLANA,decimals:6};

/** Raw balance of `owner`'s token account for each coin on Solana (0n when the account does not exist). */
export async function solanaBalances(ctx,owner,coins){
 return Promise.all(coins.map(async c=>{
  const program=(await ctx.sol.accountInfo(c.mint))?.owner??TOKEN_PROGRAM;
  return (await ctx.sol.tokenBalance(associatedTokenAddress(owner,c.mint,program)))??0n;
 }));
}
/** One 1Click funding leg paid from the test wallet's Solana USDC (funding.mjs), with this run's dependencies. */
/** How a funding leg's credit is read from the chain when the 1Click status cannot be read: the verifier balance (INTENTS) or the NEAR account balance. */
export const creditWatch=(ctx,request)=>request.recipientType==='INTENTS'&&ctx.verifier?{read:async()=>(await ctx.verifier.balances(request.recipient,[request.destinationAsset]))[0]}:
 request.recipientType==='DESTINATION_CHAIN'&&ctx.rpc?{read:async()=>(await accountState(ctx.rpc,request.recipient)).yocto}:null;
export const fund=(ctx,label,slot,request)=>fundVia1Click({label,state:slot,save:ctx.save,client:ctx.client,rpc:ctx.sol,signatureStatus:ctx.signatureStatus,wallet:ctx.wallet.solana,feePayer:ctx.feePayer,
 request,emit:ctx.emit,now:ctx.now,sleep:ctx.sleep,waitMs:ctx.opts.followS*1000,watch:creditWatch(ctx,request)});
/** Relayer fee of each coin's withdrawal to `recipient` right now. */
export const bridgeFees=(ctx,coins,recipient,amounts)=>Promise.all(coins.map((c,i)=>ctx.omni.fee({tokenId:c.tokenId,recipient,amount:amounts?.[i]??1_000_000n})));

/**
 * Sends one NEAR transaction at most once. `slot` keeps {tx_hash, signed_base64}; they are saved before the send, so
 * a rerun finds the same transaction instead of signing a second one. Returns transactionStatus() once every receipt
 * has executed (or the last status seen when `waitMs` runs out).
 */
export async function sendNearOnce(ctx,slot,label,build,{waitMs=180_000}={}){
 const {rpc,near:n,emit,now,sleep,save}=ctx;
 slot.at??={};
 if(!slot.tx_hash){
  const b=await build();
  Object.assign(slot,{tx_hash:b.hash,signed_base64:b.base64});slot.at.signed=iso(now());save();
 }
 let st=await transactionStatus(rpc,slot.tx_hash,n.accountId);
 if(!st.found){
  slot.at.submitted??=iso(now());save();
  try{await sendTransaction(rpc,slot.signed_base64,'INCLUDED')}
  catch(e){
   const text=JSON.stringify(e?.data??e?.message??String(e)).slice(0,400);
   if(/InvalidNonce|Expired|NotEnoughBalance|SignerDoesNotExist|InvalidAccessKey|INVALID_TRANSACTION/i.test(text)){
    // the node rejected it for good: this transaction can never run, so the next run signs a new one
    const dead=slot.tx_hash;delete slot.tx_hash;delete slot.signed_base64;slot.rejected=text;save();
    throw Error(`NEAR refused transaction ${dead}: ${text}`);
   }
   emit({step:label,stage:'send_uncertain',tx_hash:slot.tx_hash,message:text});
  }
  slot.at.included??=iso(now());save();
  emit({step:label,stage:'near_tx_sent',tx_hash:slot.tx_hash,at:slot.at.included});
 }
 for(const t0=now();;){
  st=await transactionStatus(rpc,slot.tx_hash,n.accountId);
  if(st.found&&st.ok!==null)break;
  if(now()-t0>=waitMs)break;
  await sleep(1500);
 }
 if(st.ok!==null){slot.at.executed??=iso(now());slot.ok=st.ok;if(st.failure)slot.failure=st.failure;save()}
 emit({step:label,stage:'near_tx_outcome',tx_hash:slot.tx_hash,found:st.found,finality:st.finality,ok:st.ok,failure:st.failure,gas_burnt:st.gasBurnt??null,at:slot.at.executed??null});
 return st;
}

// ---- (1) setup ----
export async function stepSetup(ctx){
 const {near:n,rpc,omni,emit,opts,state,save}=ctx;
 const [acct,ak,req,sb]=await Promise.all([accountState(rpc,n.accountId),accessKey(rpc,n.accountId,n.publicKey),omni.storageRequirements(),omni.storageBalance(n.accountId)]);
 emit({step:'setup',near_account:n.accountId,near_public_key:n.publicKey,key_file_created:n.created,account_exists:acct.exists,access_key_ready:Boolean(ak),near_balance:near(acct.yocto),
  solver_verifier_account:n.accountId,omni_storage:sb?{total:near(sb.total),available:near(sb.available)}:null,
  needs:{send_near_to:n.accountId,recommended_near:'0.6',why:'gas for execute_intents (up to 0.03 NEAR prepaid per call, mostly refunded), one storage_deposit on omni.bridge.near that also pays the bridge relayer (about 0.06 NEAR per coin when the recipient has no token account yet), and the account\'s own storage',
   omni_registration_near:near(req.account),omni_per_transfer_storage_near:near(req.transfer),
   how:'send NEAR from any NEAR wallet or exchange withdrawal to the account id above (an implicit account: it comes into existence when it first receives NEAR), or run --setup --fund-near-from-1click'}});
 if(!opts.fundNear)return;
 const slot=(state.steps.fund_near??={});
 const r=await fund(ctx,'fund_near',slot,{destinationAsset:WNEAR_TOKEN_ID,amount:usdcRaw(opts.fundUsdc),recipient:n.accountId,recipientType:'DESTINATION_CHAIN'});
 const after=await accountState(rpc,n.accountId);
 emit({step:'fund_near',stage:'result',status:r.status??null,near_account:n.accountId,account_exists:after.exists,near_balance:near(after.yocto),
  note:after.exists?null:'the account does not exist yet: 1Click has not delivered native NEAR (or delivered wNEAR, which cannot pay gas). Check --status; if it was refunded, fund the account with NEAR directly.'});
}

// ---- (1b) the bridge's storage balance for the account that signs execute_intents ----
export async function stepRegisterOmni(ctx){
 const {near:n,rpc,omni,emit,opts,state,recipient}=ctx;
 const coins=basketCoins(opts.coins);
 const [req,sb,fees]=await Promise.all([omni.storageRequirements(),omni.storageBalance(n.accountId),bridgeFees(ctx,coins,recipient)]);
 const needed=signerStorageNeeded({nativeFees:fees.map(f=>f.nativeFee),transferStorage:req.transfer,feeMode:opts.feeMode});
 const target=needed*13n/10n,have=sb?.available??0n;
 const slot=(state.steps.register_omni??={});
 if(have>=target&&!slot.tx_hash){emit({step:'register_omni',stage:'already_enough',near_account:n.accountId,available:near(have),needed_for_one_trade:near(needed)});return}
 const deposit=(have>=target?0n:target-have)+(sb?0n:req.account);
 if(slot.tx_hash&&slot.ok===true&&have<target){delete slot.tx_hash;delete slot.signed_base64;delete slot.ok;slot.at={}}
 const st=await sendNearOnce(ctx,slot,'register_omni',()=>buildFunctionCall({rpc,near:n,receiverId:OMNI_BRIDGE,method:'storage_deposit',args:{account_id:n.accountId},gas:30_000_000_000_000n,deposit}));
 const now2=await omni.storageBalance(n.accountId);
 emit({step:'register_omni',stage:'result',ok:st.ok,tx_hash:slot.tx_hash,fee_mode:opts.feeMode,bridge_fees_usd:fees.map(f=>f.usd),needed_for_one_trade:near(needed),
  omni_storage:now2?{total:near(now2.total),available:near(now2.available)}:null,enough:Boolean(now2&&now2.available>=needed)});
}

// ---- (2) stock: the solver's inventory, bought straight into its verifier account ----
export async function stepStock(ctx){
 const {near:n,verifier,emit,opts,state}=ctx;
 const coins=basketCoins(opts.coins);
 const targets=[...coins,...(opts.feeMode==='intent'?[{symbol:'WNEAR',tokenId:WNEAR_TOKEN_ID}]:[])];
 state.steps.stock??={};
 for(const c of targets){
  const slot=(state.steps.stock[c.symbol]??={});
  await fund(ctx,`stock_${c.symbol}`,slot,{destinationAsset:c.tokenId,amount:usdcRaw(c.symbol==='WNEAR'?opts.wnearUsdc:opts.stockUsdc),recipient:n.accountId,recipientType:'INTENTS'});
 }
 const bal=await verifier.balances(n.accountId,targets.map(c=>c.tokenId));
 emit({step:'stock',stage:'result',solver_verifier_account:n.accountId,
  balances:Object.fromEntries(targets.map((c,i)=>[c.symbol,bal[i].toString()])),statuses:Object.fromEntries(targets.map(c=>[c.symbol,state.steps.stock[c.symbol].status??null])),status_source:Object.fromEntries(targets.map(c=>[c.symbol,state.steps.stock[c.symbol].status_source??'oneclick'])),
  ok:targets.every((c,i)=>bal[i]>0n)});
}

// ---- (3) deposit-user: USDC into the USER's verifier account (same-asset 1Click deposit quote) ----
export async function stepDepositUser(ctx){
 const {user,verifier,emit,opts,state}=ctx;
 const all=(state.steps.deposit_user??={});
 // --new-trade: a finished deposit is filed away so that a second one can be made
 if(opts.newTrade&&['SUCCESS','REFUNDED','FAILED'].includes(all[user.accountId]?.status)){(state.steps.deposit_user_done??=[]).push(all[user.accountId]);delete all[user.accountId]}
 const slot=(all[user.accountId]??={});
 const [before]=await verifier.balances(user.accountId,[USDC_SOL_TOKEN_ID]);
 await fund(ctx,'deposit_user',slot,{destinationAsset:USDC_SOL_TOKEN_ID,amount:usdcRaw(opts.usdc),recipient:user.accountId,recipientType:'INTENTS'});
 const [after]=await verifier.balances(user.accountId,[USDC_SOL_TOKEN_ID]);
 const sent=Date.parse(slot.at?.transfer_sent??''),done=Date.parse(slot.at?.oneclick_success??'');
 emit({step:'deposit_user',stage:'result',user_verifier_account:user.accountId,user_standard:user.standard,status:slot.status??null,status_source:slot.status_source??'oneclick',usdc_balance_before_this_run:before.toString(),usdc_balance:after.toString(),
  seconds:{solana_send_to_credited:Number.isFinite(sent)&&Number.isFinite(done)?Math.round((done-sent)/100)/10:null},ok:after>=usdcRaw(opts.usdc)});
}

// ---- (4) trade ----
export async function stepTrade(ctx){
 const {near:n,user,recipient,rpc,verifier,omni,client,emit,opts,state,save,now,sleep}=ctx;
 // --new-trade: a finished trade is filed away so that a second one (e.g. the other signing standard) can run
 if(opts.newTrade&&state.steps.trade?.tx_hash){
  if(typeof state.steps.trade.ok!=='boolean'){emit({step:'trade',stage:'refused',reason:'the previous trade has no outcome yet; run --trade or --status first',tx_hash:state.steps.trade.tx_hash});return {ok:false}}
  (state.steps.trades_done??=[]).push(state.steps.trade);delete state.steps.trade;save();
 }
 const slot=(state.steps.trade??={});
 slot.at??={};
 const at={};
 // a signed trade that was never sent and whose deadline has passed can no longer execute: start over
 if(slot.tx_hash&&!slot.at.submitted&&Date.parse(slot.deadline)<=now()){for(const k of Object.keys(slot))delete slot[k];slot.at={}}
 const coins=basketCoins(slot.coins??opts.coins);
 if(!slot.tx_hash){
  const usdc=usdcRaw(opts.usdc),solver=nep413Signer(n.key);
  if(user.accountId===n.accountId){emit({step:'trade',stage:'refused',reason:'the user and the solver are the same account'});return {ok:false}}
  if(coins.length>maxWithdrawals(opts.feeMode)){emit({step:'trade',stage:'refused',reason:'too many withdrawals for one 300 Tgas transaction',max:maxWithdrawals(opts.feeMode),reserved_tgas:reservedTgas(coins.length,opts.feeMode)});return {ok:false}}
  const routes=await Promise.all(coins.map(c=>omni.route(c)));
  if(routes.some(r=>!r.ok)){emit({step:'trade',stage:'refused',reason:'the Omni route is not open for a coin',routes:routes.map((r,i)=>({symbol:coins[i].symbol,...r}))});return {ok:false}}
  const [saltHex,feePips,userBal,solverBal,sb,req]=await Promise.all([verifier.currentSalt(),verifier.fee(),verifier.balances(user.accountId,[USDC_SOL_TOKEN_ID]),
   verifier.balances(n.accountId,[...coins.map(c=>c.tokenId),WNEAR_TOKEN_ID]),omni.storageBalance(n.accountId),omni.storageRequirements()]);
  if(userBal[0]<usdc){emit({step:'trade',stage:'refused',reason:'the user verifier account holds less USDC than the trade spends',have:userBal[0].toString(),need:usdc.toString(),fix:'--deposit-user'});return {ok:false}}
  const legs=await quoteLegs({client,coins,usdcIns:splitEven(usdc,coins.length),recipient:n.accountId,refundTo:ctx.wallet.solana.address,now});
  const fees=await bridgeFees(ctx,coins,recipient,legs.map(l=>l.quotedOut));
  const deadlineMs=now()+opts.deadlineS*1000;
  const trade=await buildBasketTrade({user,solver,legs,recipient,bridgeFees:fees.map(f=>f.nativeFee),feePips,saltHex,deadlineMs,marginBps:opts.marginBps,feeMode:opts.feeMode});
  at.signed=iso(now());
  const short=trade.diffs.legs.map((l,i)=>({symbol:l.symbol,have:solverBal[i],need:l.solverGives})).filter(x=>x.have<x.need);
  const wnearNeed=-(trade.diffs.solverDiff[WNEAR_TOKEN_ID]??0n);
  if(wnearNeed>solverBal[coins.length])short.push({symbol:'WNEAR',have:solverBal[coins.length],need:wnearNeed});
  if(short.length){emit({step:'trade',stage:'refused',reason:'the solver inventory is short',short:short.map(str),fix:'--stock (or a smaller --usdc)'});return {ok:false}}
  const storageNeed=signerStorageNeeded({nativeFees:fees.map(f=>f.nativeFee),transferStorage:req.transfer,feeMode:opts.feeMode});
  if(!sb||sb.available<storageNeed){emit({step:'trade',stage:'refused',reason:'the NEAR account has too little storage balance on omni.bridge.near: the withdrawals would be returned to the verifier',available:near(sb?.available??0n),need:near(storageNeed),fix:'--register-omni'});return {ok:false}}
  const sim=await verifier.simulate(trade.signed);
  at.simulated=iso(now());
  emit({step:'trade',stage:'simulated',ok:sim.ok,outcome:sim.ok?'PASSED':sim.code,contract_says:sim.message??null,
   intents_executed:(sim.output?.intents_executed??[]).map(e=>({account_id:e.account_id,intent_hash:e.intent_hash})),
   legs:trade.diffs.legs.map((l,i)=>({symbol:l.symbol,price_source:l.priceSource,usdc_in:l.usdcIn.toString(),quoted_out:l.quotedOut.toString(),solver_gives:l.solverGives.toString(),user_receives:l.userReceives.toString(),bridge_fee_yocto:fees[i].nativeFee.toString(),bridge_fee_usd:fees[i].usd}))});
  if(!sim.ok)return {ok:false};
  const tokens=[USDC_SOL_TOKEN_ID,...coins.map(c=>c.tokenId)];
  const [ub,sbal,solBefore]=await Promise.all([verifier.balances(user.accountId,tokens),verifier.balances(n.accountId,tokens),solanaBalances(ctx,recipient,coins)]);
  const tx=await buildFunctionCall({rpc,near:n,receiverId:VERIFIER,method:'execute_intents',args:{signed:trade.signed},gas:EXECUTE_GAS});
  Object.assign(slot,{tx_hash:tx.hash,signed_base64:tx.base64,coins:coins.map(c=>c.symbol).join(','),deadline:trade.user.deadline,user_account:user.accountId,user_standard:user.standard,recipient,fee_mode:opts.feeMode,
   intent_hashes:{solver:intentHash(trade.signed[0]),user:intentHash(trade.signed[1])},signed:trade.signed,
   legs:trade.diffs.legs.map((l,i)=>({symbol:l.symbol,user_receives:l.userReceives.toString(),solver_gives:l.solverGives.toString(),bridge_fee_yocto:fees[i].nativeFee.toString()})),
   usdc_in:usdc.toString(),solver_usdc_received:trade.diffs.usdc.solverReceives.toString(),
   before:{user:ub.map(String),solver:sbal.map(String),solana:solBefore.map(String)},at});
  save();
 }
 const st=await sendNearOnce(ctx,slot,'trade',async()=>{throw Error('unreachable: the trade transaction is built before it is saved')});
 // the swap is settled when execute_intents itself ran (it logs `intents_executed`); a later receipt failing means
 // a withdrawal came back, which followTrade reports coin by coin
 const settled=st.logs.some(l=>l.includes('"event":"intents_executed"'));
 if(!settled){emit({step:'trade',stage:'result',ok:false,tx_hash:slot.tx_hash,reason:st.ok===false?'execute_intents failed: nothing was swapped and no balance changed':'the NEAR transaction has no outcome yet; run --trade again',failure:st.failure});return {ok:false}}
 if(st.ok===false)emit({step:'trade',stage:'receipt_failed_after_swap',tx_hash:slot.tx_hash,failure:st.failure});
 return followTrade(ctx,{waitMs:opts.followS*1000});
}

/** After execute_intents: verifier balances, the bridge's record of each transfer, and the coins landing on Solana. */
export async function followTrade(ctx,{waitMs}){
 const {near:n,verifier,omni,emit,state,save,now,sleep}=ctx;
 const slot=state.steps.trade;
 if(!slot?.tx_hash){emit({step:'trade',stage:'none'});return {ok:false}}
 const coins=basketCoins(slot.coins),tokens=[USDC_SOL_TOKEN_ID,...coins.map(c=>c.tokenId)];
 const [ua,sa]=await Promise.all([verifier.balances(slot.user_account,tokens),verifier.balances(n.accountId,tokens)]);
 const delta=(a,b)=>a.map((v,i)=>(v-BigInt(b[i])).toString());
 const userDelta=delta(ua,slot.before.user),solverDelta=delta(sa,slot.before.solver);
 // a coin that is still in the user's verifier balance was credited by the diff and its withdrawal came back
 const returned=coins.filter((c,i)=>BigInt(userDelta[i+1])>0n).map(c=>c.symbol);
 emit({step:'trade',stage:'verifier_balances',tx_hash:slot.tx_hash,tokens:['USDC',...coins.map(c=>c.symbol)],user_delta:userDelta,solver_delta:solverDelta,
  expected_user_usdc_delta:`-${slot.usdc_in}`,expected_solver_usdc_delta:slot.solver_usdc_received,withdrawals_returned_to_verifier:returned});
 slot.arrived??={};
 let transfers=[];
 for(const t0=now();;){
  try{transfers=await omni.transfers(slot.tx_hash)}catch{}
  const sol=await solanaBalances(ctx,slot.recipient,coins);
  coins.forEach((c,i)=>{
   const got=sol[i]-BigInt(slot.before.solana[i]);
   if(!slot.arrived[c.symbol]&&got>=BigInt(slot.legs[i].user_receives)){
    slot.arrived[c.symbol]={at:iso(now()),received:got.toString()};save();
    emit({step:'trade',stage:'arrived_on_solana',symbol:c.symbol,received:got.toString(),expected:slot.legs[i].user_receives,at:slot.arrived[c.symbol].at,
     seconds_after_submit:slot.at.submitted?Math.round((now()-Date.parse(slot.at.submitted))/1000):null});
   }
  });
  if(coins.every(c=>slot.arrived[c.symbol]||returned.includes(c.symbol)))break;
  if(now()-t0>=waitMs)break;
  await sleep(3000);
 }
 const s=t=>t?Date.parse(t):null,since=(a,b)=>a&&b?Math.round((a-b)/100)/10:null;
 const submitted=s(slot.at.submitted),arrivals=coins.map(c=>s(slot.arrived[c.symbol]?.at));
 const ok=coins.every(c=>slot.arrived[c.symbol]);
 const result={step:'trade',stage:'result',ok,tx_hash:slot.tx_hash,user_standard:slot.user_standard,fee_mode:slot.fee_mode,recipient:slot.recipient,
  timestamps:{...slot.at,arrived:Object.fromEntries(coins.map(c=>[c.symbol,slot.arrived[c.symbol]?.at??null]))},
  seconds:{sign_to_submit:since(submitted,s(slot.at.signed)),submit_to_included:since(s(slot.at.included),submitted),submit_to_executed:since(s(slot.at.executed),submitted),
   submit_to_arrival:Object.fromEntries(coins.map((c,i)=>[c.symbol,since(arrivals[i],submitted)])),submit_to_last_arrival:ok?since(Math.max(...arrivals),submitted):null},
  bridge:transfers.map(t=>({status:t.status,token:t.token,amount:t.amount,solana_tx:t.solanaTx,bridge_seconds:t.initialisedAt&&t.finalisedAt?t.finalisedAt-t.initialisedAt:null})),
  withdrawals_returned_to_verifier:returned,missing:coins.filter(c=>!slot.arrived[c.symbol]).map(c=>c.symbol)};
 emit(result);
 return result;
}

// ---- (5) status ----
export async function stepStatus(ctx){
 const {near:n,user,recipient,rpc,verifier,omni,emit,opts,state}=ctx;
 const coins=basketCoins(state.steps.trade?.coins??opts.coins);
 const tokens=[USDC_SOL_TOKEN_ID,...coins.map(c=>c.tokenId),WNEAR_TOKEN_ID],names=['USDC',...coins.map(c=>c.symbol),'WNEAR'];
 const [acct,sb,ub,sbal,sol,salt,fee]=await Promise.all([accountState(rpc,n.accountId),omni.storageBalance(n.accountId),verifier.balances(user.accountId,tokens),verifier.balances(n.accountId,tokens),
  solanaBalances(ctx,recipient,[USDC_COIN,...coins]),verifier.currentSalt(),verifier.fee()]);
 const row=b=>Object.fromEntries(names.map((s,i)=>[s,b[i].toString()]));
 emit({step:'status',near_account:n.accountId,account_exists:acct.exists,near_balance:near(acct.yocto),omni_storage:sb?{total:near(sb.total),available:near(sb.available)}:null,
  contract:{current_salt:salt,fee_pips:fee},user_verifier_account:user.accountId,user_standard:user.standard,user_verifier_balances:row(ub),solver_verifier_balances:row(sbal),
  recipient,recipient_solana_balances:Object.fromEntries(['USDC',...coins.map(c=>c.symbol)].map((s,i)=>[s,sol[i].toString()])),
  steps:{fund_near:state.steps.fund_near?.status??null,stock:Object.fromEntries(Object.entries(state.steps.stock??{}).map(([k,v])=>[k,v.status??null])),
   deposit_user:Object.fromEntries(Object.entries(state.steps.deposit_user??{}).map(([k,v])=>[k,v.status??null])),register_omni:state.steps.register_omni?.tx_hash??null,trade:state.steps.trade?.tx_hash??null}});
 if(state.steps.trade?.tx_hash){
  const st=await transactionStatus(rpc,state.steps.trade.tx_hash,n.accountId);
  emit({step:'status',stage:'trade_tx',tx_hash:state.steps.trade.tx_hash,found:st.found,finality:st.finality,ok:st.ok,failure:st.failure});
  if(st.ok===true)await followTrade(ctx,{waitMs:0});
 }
}

// ---- withdraw again / take the funds back out ----
/**
 * One signed payload of `ft_withdraw` intents sending the WHOLE verifier balance of each listed token of `who`
 * ('user' or 'solver') to the Solana recipient through the Omni bridge; the bridge fee comes from the NEAR account's
 * storage balance ('signer' mode). This is the retry for a withdrawal that came back, and the way to empty the
 * solver. Each call signs a fresh payload (new nonce) and sends one NEAR transaction.
 */
export async function stepWithdrawAll(ctx,who){
 const {near:n,user,recipient,rpc,verifier,omni,emit,opts,state,now}=ctx;
 const signer=who==='solver'?nep413Signer(n.key):user;
 const all=[USDC_COIN,...basketCoins(opts.coins)];
 const bal=await verifier.balances(signer.accountId,all.map(c=>c.tokenId));
 const held=all.map((c,i)=>({...c,amount:bal[i]})).filter(c=>c.amount>0n);
 if(!held.length){emit({step:'withdraw_all',who,stage:'nothing_to_withdraw',account:signer.accountId});return}
 const [fees,sb,req,saltHex]=await Promise.all([bridgeFees(ctx,held,recipient,held.map(c=>c.amount)),omni.storageBalance(n.accountId),omni.storageRequirements(),verifier.currentSalt()]);
 const need=signerStorageNeeded({nativeFees:fees.map(f=>f.nativeFee),transferStorage:req.transfer,feeMode:'signer'});
 if(!sb||sb.available<need){emit({step:'withdraw_all',who,stage:'refused',reason:'too little storage balance on omni.bridge.near',available:near(sb?.available??0n),need:near(need),fix:'--register-omni'});return}
 const intents=held.flatMap((c,i)=>omniWithdrawToSolana({tokenId:c.tokenId,amount:c.amount,recipient,nativeFee:fees[i].nativeFee,feeMode:'signer'}).intents);
 const {signed}=await signIntents(signer,{intents,deadlineMs:now()+opts.deadlineS*1000,saltHex});
 const sim=await verifier.simulate([signed]);
 emit({step:'withdraw_all',who,stage:'simulated',ok:sim.ok,outcome:sim.ok?'PASSED':sim.code,contract_says:sim.message??null,account:signer.accountId,recipient,
  withdrawals:held.map((c,i)=>({symbol:c.symbol,amount:c.amount.toString(),bridge_fee_usd:fees[i].usd}))});
 if(!sim.ok)return;
 const slot={};(state.steps.withdrawals??=[]).push(slot);
 const st=await sendNearOnce(ctx,slot,'withdraw_all',()=>buildFunctionCall({rpc,near:n,receiverId:VERIFIER,method:'execute_intents',args:{signed:[signed]},gas:EXECUTE_GAS}));
 emit({step:'withdraw_all',who,stage:'result',ok:st.ok,tx_hash:slot.tx_hash,note:'the coins arrive on Solana about a minute later; --status shows the recipient balances'});
}

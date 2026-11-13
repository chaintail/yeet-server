// Base basket in ONE EIP-7702 transaction (BASE-7702-PRODUCTION-PLAN.md section 2). The person's wallet signs one
// Uniswap Calibur SignedBatchedCall (EIP-712) of N USDC.transfer(deposit_i, amount_i) calls naming OUR gas wallet as
// executor, plus a 7702 authorization for Calibur v1.1.0 on its first trade only; our gas wallet sends ONE transaction
// (type 4 with the authorization, else type 2) to the person's address and pays for it. No ETH top-up.
//
//   prepare({trade, legs, wallet, attemptId, attemptNo, now}) -> sign request parts, or throws BatchFallback (2.7: the
//            caller then uses the per-leg path) or a TradeError legacy shares (gate, PRINCIPAL_SHORT, WALLET_HAS_CODE)
//   submit({trade, legs, wallet, attemptId, signed, dryRun, now}) -> 2.2 steps 1-9 in order; a refusal changes nothing
//   advance(id) / recover({now}) -> 2.3 send, 2.4 confirmation from the USDC Transfer logs (never receipt status alone),
//            2.6 recovery
// One gas-wallet transaction in flight (guard 12, for batches too): a signed batch waits as `signed` with the person's
// signatures and no outer transaction until no top-up or other batch is in flight; only then does it get a nonce,
// with the wallet's code, the simulation, the cost and the floor read again. So a batch that ends unsent never leaves
// a nonce gap under another one. A batch already out is re-sent only after the same re-checks; if the wallet changed,
// or the batch is still in a pool past its deadline, a 0-value transaction to our own gas wallet takes its nonce
// (a cancel). A failed ending needs a second reading: a receipt without its transaction is read again, and a taken
// nonce with no lookup showing our hashes ends the row only after NONCE_CONSUMED_CONFIRM_MS and if the trade's
// Calibur nonce has not moved.
// Every row lives in base_batch (store.mjs); the pipeline ledger follows it through leg-driver.mjs.
import {recoverTypedDataAddress,serializeTransaction} from 'viem';
import {limitsFromEnv,accountLive,spentToday} from '../../trade/limits.mjs';
import {refuse,TradeError,sha256,canonical,utcDay} from '../../trade/util.mjs';
import {readBaseConfig,BASE_CHAIN_ID,SIGN_WINDOW_MS,DEADLINE_MARGIN_MS,MAX_TOPUPS_PER_ACCOUNT_DAY,REBROADCAST_INTERVAL_MS,
 BATCH_GAS_BASE,BATCH_GAS_PER_LEG,MAX_BATCH_LEGS} from './config.mjs';
import {safeError} from './safe-error.mjs';
import {readFees,replacementFees} from './fees.mjs';
import {loadGasWallet} from './gas-wallet.mjs';
import {txJson,txFromJson} from './source-executor.mjs';
import {createBaseStore} from './store.mjs';
import {CALIBUR,delegationCode,delegatedTo,batchNonce,buildBatch,batchTypedData,privyTypedData,wrapSignature,executeCalldata,
 fromPrivyAuthorization,assertAuthorization,assertBatchMatches,buildType4,buildType2,assertType4Bytes,assertType2Bytes,legEvidence,
 revertName,tradeNonceKey,getSeqCalldata,decodeSeq,EIP712_DOMAIN_CALLDATA,decodeDomain,typedDataForSigning} from './calibur-7702.mjs';

/** Why a basket goes to the per-leg path instead (plan 2.7). Not a refusal: nothing was reserved. */
export class BatchFallback extends TradeError{constructor(reason,detail){super('BATCH_FALLBACK',detail??reason);this.reason=reason}}
const fallback=(reason,detail)=>{throw new BatchFallback(reason,detail)};

export const gasCapFor=n=>BATCH_GAS_BASE+BATCH_GAS_PER_LEG*BigInt(n);
/** No broadcast closer than this to the batch's on-chain deadline (plan 2.3). */
export const SEND_STOP_MS=30_000;
/** No sign request when a leg's deposit deadline is closer than this (pipeline SEND_MARGIN_MS). */
export const SEND_MARGIN_MS=120_000;
export const MAX_BATCH_DEADLINE_S=15*60;
/** A gas-wallet nonce taken while no lookup shows any of our hashes ends the row only after it has been seen this long
 * (a load-balanced RPC can serve the nonce from a node that is ahead of the one serving receipts). */
export const NONCE_CONSUMED_CONFIRM_MS=60_000;
/** The 0-value transaction to our own gas wallet that replaces a stuck batch at its nonce. */
export const CANCEL_GAS=21_000n;
/** Refusals that end a signed batch waiting to be sent; any other refusal at send time waits for the next pass. */
const SEND_FINAL=new Set(['WALLET_HAS_CODE','AUTH_NONCE_STALE','SIGNED_SOURCE_MISMATCH','SIMULATION_FAILED']);
const soft=(code,detail)=>{const e=new TradeError(code,detail);e.transient=true;throw e};
const maxBig=(a,b)=>a>b?a:b;
export const AUTO_LEGACY_FLAG='base_mode_auto_legacy';
export const unsupportedFlag=wallet=>`7702_unsupported:${String(wallet).toLowerCase()}`;
export const WALLET_HAS_CODE_STEPS='This wallet runs smart-account code from another app. Remove it in that app (or sign an EIP-7702 authorization to address 0) and try again.';
const LIVE=['signed','submitted','uncertain'];
const OPEN=['prepared',...LIVE];
const ADDR=/^0x[0-9a-f]{40}$/;
const SIGNED=/^0x([0-9a-f]{130}|[0-9a-f]{260})$/;
const CALIBUR_CODE=delegationCode(CALIBUR);
const lc=a=>String(a??'').toLowerCase();
const s12=v=>v==null?undefined:String(v).slice(0,12);
const success=rc=>rc.status==='success'||rc.status===1||rc.status==='0x1';
const sumOf=legs=>legs.reduce((s,l)=>s+BigInt(l.amountRaw??l.amount_raw),0n);

function addr(v){const a=lc(v);if(!ADDR.test(a))refuse('SOURCE_IDENTITY_MISMATCH','address');return a}
/** One trade_legs row as the batch needs it. */
function legInfo(trade,leg){
 const tradeId=String(trade?.id??leg?.trade_id??''),idx=Number(leg?.idx),amount=String(leg?.amount_in_raw??'');
 let deadline;try{deadline=Date.parse(JSON.parse(leg.live_quote_json).deadline)}catch{deadline=NaN}
 if(!tradeId||!Number.isInteger(idx)||idx<0||!/^[1-9][0-9]{0,30}$/.test(amount)||!Number.isFinite(deadline))refuse('SOURCE_IDENTITY_MISMATCH','leg shape');
 return {idx,to:addr(leg.deposit_address),amountRaw:BigInt(amount),deadline,memo:leg.deposit_memo??null};
}
const storedLegs=row=>JSON.parse(row.legs_json).map(l=>({idx:l.idx,to:l.to,amountRaw:BigInt(l.amount_raw),deadline:l.deadline}));

export function createBaseBatchDriver({db,rpc,env=process.env,now=Date.now,alert=()=>{},log=()=>{},loadWallet=loadGasWallet,store}={}){
 if(!db||!rpc)throw Error('createBaseBatchDriver needs db and rpc');
 store??=createBaseStore(db,()=>now());
 const cfg=()=>{try{return readBaseConfig(env)}catch(e){refuse('GAS_WALLET_NOT_CONFIGURED',e.message)}};
 const limits=()=>limitsFromEnv(env);
 function gateRefusal(accountId){
  let l;try{l=limits()}catch{return 'TRADING_PAUSED'}
  if(l.killSwitch||!l.live||!accountLive(l,accountId))return 'TRADING_PAUSED';
  let c;try{c=readBaseConfig(env)}catch{return 'SOURCE_PAUSED'}
  return c.paused?'SOURCE_PAUSED':null;
 }
 const transition=(row,to,extra={})=>log('base_batch_transition',{trade_id:s12(row.trade_id),attempt_id:s12(row.id),account_id:row.account_id,
  wallet:s12(row.wallet),legs:JSON.parse(row.legs_json).length,state_from:row.state,state_to:to,tx_ref:s12(extra.tx_hash??row.tx_hash),code:extra.code});
 function capCheck(l,amount){
  if(amount<l.minLegRaw)refuse('AMOUNT_TOO_SMALL','leg under minimum');
  if(amount>l.maxTradeRaw)refuse('LIMIT_EXCEEDED','over per-trade cap');
 }
 function lowAlert(balance,c){
  if(store.flag('gas_wallet_low')!=='1'){store.setFlag('gas_wallet_low','1');alert({kind:'gas_wallet_low',chain:'base',wallet:c.gasWallet,balance_raw:String(balance),floor_raw:String(c.floorRaw)})}
 }
 const evidence=row=>JSON.parse(row.evidence_json||'{}');
 const sendsOf=row=>evidence(row).sends??(row.tx_hash?[{hash:row.tx_hash}]:[]);
 function resultOf(row){
  const r={txHash:row.tx_hash??undefined};
  if(row.state==='cancelled')return {...r,state:!row.batch_sig&&['SIGN_EXPIRED','AUTH_NONCE_STALE'].includes(row.code)?'expired':'not_sent',code:row.code};
  if(row.state==='failed')return {...r,state:'failed',code:row.code};
  if(['submitted','uncertain','confirmed'].includes(row.state))return {...r,state:'sent'};
  return {...r,state:'pending'};
 }
 /** Ends an open row. A signed reservation that was never broadcast goes back to the day (count and wei); a broadcast
  * one that never landed gives its wei back. */
 function cancelBatch(row,code){
  const out=store.atomic(()=>{
   const cur=store.batch(row.id);
   if(!OPEN.includes(cur.state))return cur;
   const ev=evidence(cur);
   if(cur.max_cost_raw&&ev.quota_day){
    const broadcast=cur.state!=='signed';
    store.bumpDay(ev.quota_day,cur.account_id,broadcast?0:-1,-BigInt(cur.max_cost_raw));
   }
   return store.updateBatch(cur.id,{state:'cancelled',code,never_send:1,evidence_json:JSON.stringify({...ev,ended_at:now()})},OPEN);
  });
  transition(row,'cancelled',{code});
  return resultOf(out);
 }

 /** Plan 2.1 step 1: null when the basket may go in one batch, else the fallback reason. */
 function ineligible(c,legs,wallet,t){
  if(c.mode!=='7702')return 'mode_legacy';
  if(store.flag(AUTO_LEGACY_FLAG)==='1')return 'auto_legacy';
  if(store.flag(unsupportedFlag(wallet))==='1')return 'wallet_unsupported';
  if(legs.length<1||legs.length>MAX_BATCH_LEGS)return 'leg_count';
  if(legs.some(l=>l.memo))return 'deposit_memo';
  if(legs.some(l=>!(t+SEND_MARGIN_MS<l.deadline)))return 'deadline';
  if(!c.gasWallet)return 'gas_wallet_unset';
  return null;
 }
 /** The exact outer call, simulated with eth_simulateV1. RPC errors throw. */
 async function simulateExact({sender,wallet,data,authorization,legs}){
  const [r]=await rpc.simulateCalls({calls:[{from:sender,to:wallet,data,...(authorization?{authorizationList:[authorization]}:{})}]});
  const ev=legEvidence(r.logs,{user:wallet,legs});
  return {ok:r.ok&&ev.every(x=>x.ok),status:r.ok,gasUsed:r.gasUsed,legs:ev,revert:r.ok?null:revertName(r.revertData)};
 }
 const l1For=async tx=>BigInt(await rpc.l1FeeUpperBound(BigInt((serializeTransaction(tx).length-2)/2+67)));

 async function prepare({trade,legs,wallet,attemptId,attemptNo,now:at}={}){
  const t=at??now(),w=addr(wallet),c=cfg();
  if(c.paused)refuse('SOURCE_PAUSED');
  const tradeId=String(trade?.id??''),accountId=String(trade?.account_id??'');
  if(!tradeId||!accountId)refuse('SOURCE_IDENTITY_MISMATCH','trade');
  const views=[...legs].map(l=>legInfo(trade,l)).sort((a,b)=>a.idx-b.idx);
  const why=ineligible(c,views,w,t);
  if(why)fallback(why);
  if(!/^[0-9a-f]{64}$/.test(String(attemptId)))refuse('SOURCE_IDENTITY_MISMATCH','attempt id');
  if(attemptNo!==undefined&&sha256(`yeet-attempt:${tradeId}:${views[0].idx}:${attemptNo}`)!==attemptId)refuse('SOURCE_IDENTITY_MISMATCH','attempt number');
  const existing=store.batch(attemptId);
  if(existing){
   if(existing.state==='prepared'&&existing.trade_id===tradeId&&existing.wallet===w&&t<=existing.expires_at
    &&JSON.stringify(storedLegs(existing).map(l=>l.idx))===JSON.stringify(views.map(v=>v.idx)))return requestOf(existing);
   refuse('SOURCE_ATTEMPT_BLOCKED','attempt id used');
  }
  for(const v of views)if(store.legBatches(tradeId,v.idx).some(b=>LIVE.includes(b.state)||b.state==='confirmed'))refuse('SOURCE_ATTEMPT_BLOCKED','a batch for this leg is signed');
  for(const v of views)if(store.legTransfers(tradeId,v.idx).some(a=>!['prepared','cancelled','failed'].includes(a.state)))refuse('SOURCE_ATTEMPT_BLOCKED','leg already signed');
  if(store.walletBatches(w,LIVE).length)fallback('wallet_busy');
  const l=limits();
  for(const v of views)capCheck(l,v.amountRaw);
  // Step 2: the wallet's code.
  const code=lc(await rpc.code(w)||'0x'),del=delegatedTo(code);
  if(del===null||(del!==''&&lc(del)!==lc(CALIBUR)))refuse('WALLET_HAS_CODE',`delegated_elsewhere: ${WALLET_HAS_CODE_STEPS}`);
  const needsAuth=del==='';
  // The authorization nonce must not move under a legacy transfer this wallet already signed.
  if(needsAuth&&store.walletTransfers(w,['signed','awaiting_gas','submitted','uncertain']).length)fallback('wallet_nonce_busy');
  // Step 3: salt. Step 4: the trade's batch nonce.
  let saltPrefix=0n,seq=0n;
  const key=tradeNonceKey(tradeId);
  if(!needsAuth){
   let d;try{d=decodeDomain(await rpc.call({to:w,data:EIP712_DOMAIN_CALLDATA}))}catch(e){fallback('domain_unreadable',safeError(e))}
   if(lc(d.verifyingContract)!==w||d.chainId!==BASE_CHAIN_ID||d.name!=='Calibur'||d.version!=='1.0.0')fallback('domain_mismatch');
   saltPrefix=d.saltPrefix;
   try{seq=decodeSeq(await rpc.call({to:w,data:getSeqCalldata(key)}))}catch(e){fallback('seq_unreadable',safeError(e))}
  }
  const nonce=batchNonce(key,seq);
  // Step 5: the authorization nonce.
  const authNonce=needsAuth?Number(await rpc.nonce(w,'pending')):null;
  // Expiry (1.1): before every leg and the batch.
  const lmin=Math.min(...views.map(v=>v.deadline));
  const deadline=Math.min(Math.floor((lmin-DEADLINE_MARGIN_MS)/1000),Math.floor(t/1000)+MAX_BATCH_DEADLINE_S);
  const expiresAt=Math.min(t+SIGN_WINDOW_MS,deadline*1000-60_000);
  if(!(expiresAt>t))fallback('deadline');
  const calls=views.map(v=>({to:v.to,amountRaw:v.amountRaw}));
  const batch=buildBatch({legs:calls,nonce,executor:c.gasWallet,deadline:BigInt(deadline)});
  if(BigInt(await rpc.tokenBalance(w))<sumOf(calls))refuse('PRINCIPAL_SHORT');
  // Step 6: preflight of the unsigned calls from the wallet, its code overridden to the designator.
  let pre;
  try{pre=await rpc.simulateCalls({stateOverrides:{[w]:{code:CALIBUR_CODE}},calls:batch.batchedCall.calls.map(x=>({from:w,to:x.to,data:x.data}))})}
  catch(e){fallback('simulate_unavailable',safeError(e))}
  const ev=legEvidence(pre.flatMap(r=>r.logs),{user:w,legs:calls});
  if(!pre.every(r=>r.ok)||!ev.every(x=>x.ok))fallback('preflight',revertName(pre.find(r=>!r.ok)?.revertData));
  // Cost and quota (2.8) with the worst-case gas, so a basket that cannot pass submit goes legacy now.
  const fees=await readFees(rpc,c.maxFeeWei);
  const probe=buildType4({user:w,authorization:{chainId:BASE_CHAIN_ID,address:CALIBUR,nonce:authNonce??0,r:'0x'+'11'.repeat(32),s:'0x'+'22'.repeat(32),yParity:0},
   data:executeCalldata(batch,wrapSignature('0x'+'33'.repeat(65))),nonce:0,gas:gasCapFor(calls.length),...fees});
  const planned=gasCapFor(calls.length)*fees.maxFeePerGas+await l1For(probe);
  if(planned>c.batchMaxCostWei)fallback('cost_cap',`max cost ${planned}`);
  const day=utcDay(t);
  if(store.day(day,accountId).count>=MAX_TOPUPS_PER_ACCOUNT_DAY||store.dayTotal(day)+planned>c.globalDailyRaw)fallback('quota');
  // Step 7: store.
  const payload={type:'calibur_batch',typed_data:privyTypedData(w,batch,{saltPrefix}),
   authorization:needsAuth?{contract:CALIBUR,chain_id:BASE_CHAIN_ID,nonce:authNonce}:null};
  const typed=canonical(payload);
  const row=store.atomic(()=>{
   for(const v of views)for(const o of store.legBatches(tradeId,v.idx).filter(b=>b.state==='prepared'))store.updateBatch(o.id,{state:'cancelled',code:'SUPERSEDED',never_send:1},['prepared']);
   return store.insertBatch({id:attemptId,trade_id:tradeId,attempt_no:Number(attemptNo??0),account_id:accountId,wallet:w,sender:c.gasWallet,
    legs_json:JSON.stringify(views.map(v=>({idx:v.idx,to:v.to,amount_raw:String(v.amountRaw),deadline:v.deadline}))),
    nonce_key:String(key),nonce_seq:String(seq),deadline,expires_at:expiresAt,auth_json:payload.authorization?JSON.stringify(payload.authorization):null,
    typed_json:typed,payload_sha256:sha256(typed),state:'prepared',
    evidence_json:JSON.stringify({salt_prefix:String(saltPrefix),code_at_prepare:code,preflight_gas:String(pre.reduce((s,r)=>s+r.gasUsed,0n)),planned_max_cost_wei:String(planned)}),created_at:t,updated_at:t});
  });
  transition({...row,state:null},'prepared');
  return requestOf(row);
 }
 const requestOf=row=>({attemptId:row.id,kind:'evm_7702',chain:'base',wallet:row.wallet,payload:JSON.parse(row.typed_json),payloadSha256:row.payload_sha256,
  expiresAt:row.expires_at,legs:storedLegs(row).map(l=>l.idx)});

 /** Plan 2.2 step 3: the batch rebuilt from our own legs; its signer must be the wallet. */
 async function checkedBatch(row,executor,batchSig){
  const w=row.wallet,stored=storedLegs(row),ev=evidence(row),saltPrefix=BigInt(ev.salt_prefix??'0'),payload=JSON.parse(row.typed_json);
  const expected={legs:stored.map(l=>({to:l.to,amountRaw:l.amountRaw})),nonce:batchNonce(BigInt(row.nonce_key),BigInt(row.nonce_seq)),executor,deadline:BigInt(row.deadline)};
  let batch;
  try{
   const td=typedDataForSigning(payload.typed_data);
   if(lc(td.domain.verifyingContract)!==w||td.domain.chainId!==BASE_CHAIN_ID)throw Error('domain');
   batch=assertBatchMatches(td.message,expected);
  }catch(e){refuse('SIGNED_SOURCE_MISMATCH',`batch: ${e.message}`)}
  let signer;try{signer=await recoverTypedDataAddress({...batchTypedData(w,batch,{saltPrefix}),signature:batchSig})}catch{signer=null}
  if(lc(signer)!==w)refuse('SIGNED_SOURCE_MISMATCH','batch signer is not the wallet');
  return {batch,legs:expected.legs};
 }
 /** Plan 2.2 steps 4-8 for the outer transaction, at submit (`dry`/`submit`) and again when a waiting batch is sent
  * (`send`: the person's caps were checked at submit; the quota was reserved then). Throws a TradeError; one marked
  * `transient` (an RPC error, the wallet's own transaction in flight) never ends a waiting batch. */
 async function planOuter(row,{gw,c,t,batchSig,authSig,mode}){
  const w=row.wallet,auth=row.auth_json?JSON.parse(row.auth_json):null,send=mode==='send';
  const {batch,legs}=await checkedBatch(row,gw.address,batchSig);
  // Step 4: the wallet's code, then the authorization.
  const code=lc(await rpc.code(w)||'0x'),del=delegatedTo(code);
  if(del===null||(del!==''&&lc(del)!==lc(CALIBUR)))refuse('WALLET_HAS_CODE',`delegated_elsewhere: ${WALLET_HAS_CODE_STEPS}`);
  let authorization=null;
  if(auth){
   const y=authSig.slice(128,130);
   if(y!=='00'&&y!=='01')refuse('SIGNED_SOURCE_MISMATCH','authorization y_parity');
   const a=fromPrivyAuthorization({contract:auth.contract,chain_id:auth.chain_id,nonce:auth.nonce,r:'0x'+authSig.slice(0,64),s:'0x'+authSig.slice(64,128),y_parity:parseInt(y,16)});
   try{await assertAuthorization(a,{user:w,nonce:auth.nonce})}catch(e){refuse('SIGNED_SOURCE_MISMATCH',`authorization: ${e.message}`)}
   if(del===''){
    const latest=Number(await rpc.nonce(w,'latest')),pending=Number(await rpc.nonce(w,'pending'));
    // Waiting to be sent, the wallet's own transaction may still land or drop; at submit any change is stale (deviation 4).
    if(send&&pending!==latest&&latest<=auth.nonce)soft('AUTH_NONCE_STALE','the wallet has a transaction of its own in flight');
    if(latest!==auth.nonce||pending!==auth.nonce)refuse('AUTH_NONCE_STALE','authorization nonce');
    authorization=a;
   }// else: the wallet is already Calibur (someone included our authorization first): type 2 without it
  }
  // Step 5: limits.
  const blocked=[];
  if(!send){
   const l=limits();
   for(const v of storedLegs(row))capCheck(l,v.amountRaw);
   if(spentToday(db,row.account_id,t)>l.dailyCapRaw)refuse('LIMIT_EXCEEDED','over daily cap');
  }
  const gateCode=gateRefusal(row.account_id);
  if(gateCode){if(mode!=='dry')refuse(gateCode,'live gate');blocked.push(gateCode)}
  if(BigInt(await rpc.tokenBalance(w))<sumOf(legs))(send?soft:refuse)('PRINCIPAL_SHORT');
  // Step 6: the exact call.
  const data=executeCalldata(batch,wrapSignature(batchSig));
  let sim;
  try{sim=await simulateExact({sender:gw.address,wallet:w,data,authorization,legs})}catch(e){soft('SIMULATION_FAILED',`eth_simulateV1: ${safeError(e)}`)}
  if(!sim.ok)refuse('SIMULATION_FAILED',`batch: ${sim.revert??`${sim.legs.filter(x=>x.ok).length}/${sim.legs.length} legs transferred`}`);
  // Step 7: gas, fees, cost.
  let est;try{est=BigInt(await rpc.estimateGasAuth({from:gw.address,to:w,data,authorizationList:authorization?[authorization]:undefined}))}
  catch(e){soft('SIMULATION_FAILED',`estimateGas: ${safeError(e)}`)}
  const gas=est+(est+3n)/4n,cap=gasCapFor(legs.length);
  if(est<=0n||gas>cap)refuse('INVALID_TRANSACTION_BUDGET',`gas ${gas} over ${cap}`);
  const fees=await readFees(rpc,c.maxFeeWei);
  const build=nonce=>authorization?buildType4({user:w,authorization,data,nonce,gas,...fees}):buildType2({user:w,data,nonce,gas,...fees});
  const l1=await l1For(build(0)),maxCost=gas*fees.maxFeePerGas+l1;
  if(maxCost>c.batchMaxCostWei)refuse('INVALID_TRANSACTION_BUDGET',`max cost ${maxCost} over YEET_BASE_BATCH_MAX_COST_WEI`);
  // Step 8: floor and quota. The floor is read when the batch is sent too, with no other gas-wallet transaction in
  // flight then (send), so the latest balance is what this one transaction can take.
  const balance=BigInt(await rpc.balance(gw.address,'latest'));
  if(balance-maxCost<c.floorRaw){lowAlert(balance,c);refuse('TOPUP_UNAVAILABLE','gas wallet floor')}
  const day=utcDay(t);
  if(send){
   const ev=evidence(row);
   if(store.dayTotal(ev.quota_day)-BigInt(row.max_cost_raw??'0')+maxCost>c.globalDailyRaw)refuse('TOPUP_CAP_EXCEEDED','global daily cap');
  }else{
   if(store.day(day,row.account_id).count>=MAX_TOPUPS_PER_ACCOUNT_DAY)refuse('TOPUP_CAP_EXCEEDED','account daily count');
   if(store.dayTotal(day)+maxCost>c.globalDailyRaw)refuse('TOPUP_CAP_EXCEEDED','global daily cap');
  }
  return {authorization,authDropped:!!auth&&!authorization,data,gas,est,fees,l1,maxCost,build,sim,code,blocked,day};
 }

 /** Plan 2.2 steps 1-9. */
 async function submit({trade,legs,wallet,attemptId,signed,dryRun,now:at}={}){
  const t=at??now(),dry=dryRun!==false,w=addr(wallet);
  const row=store.batch(String(attemptId));
  if(!row)refuse('ATTEMPT_NOT_FOUND');
  // Step 1: identity.
  const views=[...legs].map(l=>legInfo(trade,l)).sort((a,b)=>a.idx-b.idx),stored=storedLegs(row);
  if(row.trade_id!==String(trade?.id)||row.account_id!==String(trade?.account_id)||row.wallet!==w||stored.length!==views.length
   ||stored.some((s,i)=>s.idx!==views[i].idx||s.to!==views[i].to||s.amountRaw!==views[i].amountRaw||s.deadline!==views[i].deadline))refuse('SOURCE_IDENTITY_MISMATCH','batch legs');
  const s=typeof signed==='string'?signed.trim().toLowerCase():'';
  if(s==='unsupported')return {state:'unsupported'};
  const auth=row.auth_json?JSON.parse(row.auth_json):null;
  if(!SIGNED.test(s)||s.length!==(auth?262:132))refuse('SIGNED_SOURCE_MISMATCH','signed: 0x + 65-byte batch signature'+(auth?' + 65-byte authorization signature':''));
  if(row.batch_sig){if('0x'+row.batch_sig+(row.auth_sig??'')===s)return resultOf(row);refuse('SOURCE_ATTEMPT_BLOCKED','different bytes for a signed attempt')}
  if(row.state==='cancelled')return resultOf(row);
  if(row.state!=='prepared')refuse('SOURCE_ATTEMPT_BLOCKED');
  // Step 2: window.
  if(t>row.expires_at){if(dry)return {state:'expired',code:'SIGN_EXPIRED'};cancelBatch(row,'SIGN_EXPIRED');return {state:'expired',code:'SIGN_EXPIRED'}}
  const batchSig='0x'+s.slice(2,132),authSig=auth?s.slice(132):null;
  // A dry run needs only the gas wallet's address (plan 2.10); a live submit loads the key and it must match.
  const c=cfg(),gw=dry?{address:c.gasWallet}:loadWallet(c);
  if(!gw.address||gw.address!==c.gasWallet||row.sender!==gw.address)refuse('GAS_WALLET_NOT_CONFIGURED','executor is not the configured gas wallet');
  // Steps 3-8.
  let plan;
  try{plan=await planOuter(row,{gw,c,t,batchSig,authSig,mode:dry?'dry':'submit'})}
  catch(e){
   if(e?.code!=='AUTH_NONCE_STALE')throw e;
   if(!dry)cancelBatch(row,'AUTH_NONCE_STALE');
   return {state:'expired',code:'AUTH_NONCE_STALE'};
  }
  const simulation={legs_transferred:plan.sim.legs.filter(x=>x.ok).length,gas_used:String(plan.sim.gasUsed),gas_limit:String(plan.gas),
   max_cost_wei:String(plan.maxCost),revert:null,type:plan.authorization?4:2,legs:plan.sim.legs};
  if(dry){
   log('base_batch_transition',{trade_id:s12(row.trade_id),attempt_id:s12(row.id),stage:'dry_run',legs:stored.length,gas_limit:String(plan.gas)});
   return {state:'pending',dryRun:true,broadcast:false,simulation,blocked:plan.blocked};
  }
  // Step 9: the person's signatures are stored and the quota reserved; the outer transaction follows in send().
  const day=plan.day,ev0=evidence(row);
  const saved=store.atomic(()=>{
   if(store.walletBatches(w,LIVE).length)refuse('SOURCE_ATTEMPT_BLOCKED','another batch of this wallet is in flight');
   if(store.day(day,row.account_id).count>=MAX_TOPUPS_PER_ACCOUNT_DAY||store.dayTotal(day)+plan.maxCost>c.globalDailyRaw)refuse('TOPUP_CAP_EXCEEDED','daily');
   store.bumpDay(day,row.account_id,1,plan.maxCost);
   return store.updateBatch(row.id,{state:'signed',batch_sig:s.slice(2,132),auth_sig:authSig,max_cost_raw:String(plan.maxCost),
    evidence_json:JSON.stringify({...ev0,quota_day:day,auth_dropped:plan.authDropped,code_at_submit:plan.code,gas_estimate:String(plan.est),l1_fee_bound:String(plan.l1)})},['prepared']);
  });
  transition(row,'signed');
  let r;
  try{r=await send(saved.id,t,{plan,gw})}
  catch(e){log('base_batch_transition',{attempt_id:s12(row.id),stage:'send',error:safeError(e)});r=resultOf(store.batch(saved.id))}
  return {...r,txHash:store.batch(saved.id).tx_hash??undefined};
 }

 /** Plan 2.3: a signed batch gets its outer transaction only while no other gas-wallet transaction (a top-up or a
  * batch) is in flight (guard 12), so its nonce is the next one the chain takes and a batch that ends unsent never
  * leaves a gap under a later one. The gate, the deadline, the wallet's code and nonce, the simulation, the cost and
  * the floor are read again unless `plan` is the one submit just made. */
 async function send(id,t=now(),{plan,gw}={}){
  let row=store.batch(id);
  if(!row||row.state!=='signed'||row.never_send)return row?resultOf(row):{state:'pending'};
  if(t>row.deadline*1000-SEND_STOP_MS)return cancelBatch(row,'DEADLINE_PASSED_UNSENT');
  if(gateRefusal(row.account_id))return resultOf(row);
  // A row an earlier build signed but never broadcast: its outer transaction is dropped and made again here.
  if(row.signed_raw){row=store.updateBatch(row.id,{tx_json:null,signed_raw:null,tx_hash:null,sender_nonce:null},['signed']);plan=null}
  if(store.gasInFlight()>0)return resultOf(row);
  const c=cfg();
  if(!gw)try{gw=loadWallet(c)}catch(e){log('base_batch_transition',{attempt_id:s12(row.id),stage:'send_wait',error:safeError(e)});return resultOf(row)}
  if(gw.address!==row.sender)return resultOf(row);
  if(!plan){
   try{plan=await planOuter(row,{gw,c,t,batchSig:'0x'+row.batch_sig,authSig:row.auth_sig,mode:'send'})}
   catch(e){
    if(e instanceof TradeError&&!e.transient&&SEND_FINAL.has(e.code))return cancelBatch(row,e.code);
    log('base_batch_transition',{attempt_id:s12(row.id),stage:'send_wait',code:e?.code,error:safeError(e)});
    return resultOf(row);
   }
  }
  const pending=Number(await rpc.nonce(gw.address,'pending'));
  const senderNonce=store.senderNonce(gw.address,pending),tx=plan.build(senderNonce);
  const out=await gw.sign(tx);
  const hash=plan.authorization?await assertType4Bytes(out.bytes,tx,gw.address):await assertType2Bytes(out.bytes,tx,gw.address);
  if(gateRefusal(row.account_id))return resultOf(row);// these bytes are dropped, never broadcast
  // Stored before the broadcast, under the same checks: still waiting, nothing else in flight, the same nonce.
  const cur=store.atomic(()=>{
   const r=store.batch(row.id);
   if(r.state!=='signed'||r.signed_raw||store.gasInFlight()>0||store.senderNonce(gw.address,pending)!==senderNonce)return null;
   const ev=evidence(r);
   if(ev.quota_day)store.bumpDay(ev.quota_day,r.account_id,0,plan.maxCost-BigInt(r.max_cost_raw??'0'));
   return store.updateBatch(r.id,{state:'submitted',tx_json:txJson(tx),signed_raw:out.bytes,tx_hash:hash,sender_nonce:senderNonce,max_cost_raw:String(plan.maxCost),broadcast_at:t,
    evidence_json:JSON.stringify({...ev,auth_dropped:plan.authDropped,code_at_send:plan.code,gas_estimate:String(plan.est),l1_fee_bound:String(plan.l1),
     sends:[{hash,at:t,max_fee_per_gas:String(tx.maxFeePerGas)}]})},['signed']);
  });
  if(!cur)return resultOf(store.batch(row.id));
  transition(row,'submitted',{tx_hash:hash});
  await broadcastRow(cur);
  return {state:'sent',txHash:hash};
 }
 async function broadcastRow(cur){
  try{if(lc(await rpc.broadcast(cur.signed_raw))!==cur.tx_hash)throw Error('SUBMISSION_HASH_MISMATCH')}
  catch(e){log('base_batch_transition',{attempt_id:s12(cur.id),state_to:'uncertain',tx_ref:s12(cur.tx_hash),error:safeError(e)});
   store.updateBatch(cur.id,{state:'uncertain'},['submitted','uncertain'])}
 }
 /** Kept for callers: a signed row goes through send(). */
 const advance=(id,t=now())=>send(id,t);

 /** Before any re-send of a batch already out (plan 2.3): the wallet's code is read again and the exact call
  * simulated again. Returns null (send), a code (replace it with a cancel instead) or 'unknown' (an RPC error: wait). */
 async function resendBlocker(row){
  try{
   const tx=txFromJson(row.tx_json),del=delegatedTo(lc(await rpc.code(row.wallet)||'0x'));
   if(del===null||(del!==''&&lc(del)!==lc(CALIBUR)))return 'WALLET_HAS_CODE';
   const sim=await simulateExact({sender:row.sender,wallet:row.wallet,data:tx.data,authorization:tx.type==='eip7702'?tx.authorizationList[0]:null,legs:storedLegs(row)});
   return sim.ok?null:'SIMULATION_FAILED';
  }catch(e){log('base_batch_transition',{attempt_id:s12(row.id),stage:'resend_check',error:safeError(e)});return 'unknown'}
 }
 /** Stuck outer transaction: we alone signed it, so it is replaced at the same nonce with fees +12.5%. With `cancel`
  * (the batch must not run any more) the replacement is a 0-value transaction from the gas wallet to itself, so the
  * nonce is used and the gas wallet moves on; a cancel once sent is only ever replaced by a higher-fee cancel. */
 async function replaceBatch(row,t,{cancel}={}){
  const c=cfg();
  if(gateRefusal(row.account_id))return false;
  let gw;try{gw=loadWallet(c)}catch{return false}
  const prior=txFromJson(row.tx_json),ev=evidence(row),isCancel=!!cancel||!!ev.cancel;
  let fresh;try{fresh=await readFees(rpc,c.replaceMaxFeeWei)}catch{return false}
  const fees=replacementFees(prior,fresh);
  const tx=cancel&&!ev.cancel?buildType2({user:row.sender,data:'0x',nonce:prior.nonce,gas:CANCEL_GAS,...fees}):{...prior,...fees};
  if(tx.maxFeePerGas>c.replaceMaxFeeWei)return false;
  // The reservation never shrinks: until one hash mines, any earlier one still can.
  const cost=tx.gas*tx.maxFeePerGas+BigInt(ev.l1_fee_bound??'0'),reserved=BigInt(row.max_cost_raw??'0'),maxCost=maxBig(cost,reserved),delta=maxCost-reserved;
  if(cost>c.batchMaxCostWei||store.dayTotal(ev.quota_day)+delta>c.globalDailyRaw){
   if(store.flag(`batch_replace_capped:${row.id}`)!=='1'){store.setFlag(`batch_replace_capped:${row.id}`,'1');alert({kind:'base_batch_stuck',chain:'base',attempt_id:row.id})}
   return false;
  }
  let out,hash;
  try{out=await gw.sign(tx);hash=tx.type==='eip7702'?await assertType4Bytes(out.bytes,tx,gw.address):await assertType2Bytes(out.bytes,tx,gw.address)}catch{return false}
  const cur=store.atomic(()=>{
   store.bumpDay(ev.quota_day,row.account_id,0,delta);
   return store.updateBatch(row.id,{state:'submitted',tx_json:txJson(tx),signed_raw:out.bytes,tx_hash:hash,max_cost_raw:String(maxCost),broadcast_at:t,
    evidence_json:JSON.stringify({...ev,...(cancel&&!ev.cancel?{cancel:{code:cancel,at:t}}:{}),
     sends:[...sendsOf(row),{hash,at:t,max_fee_per_gas:String(tx.maxFeePerGas),replaces:row.tx_hash,...(isCancel?{kind:'cancel'}:{})}]})},['submitted','uncertain']);
  });
  log('base_batch_transition',{attempt_id:s12(row.id),stage:isCancel?'cancel':'replaced',replaces:s12(row.tx_hash),tx_ref:s12(hash),max_fee_per_gas:String(tx.maxFeePerGas),code:cancel});
  await broadcastRow(cur);
  return true;
 }
 function settle(row,patch,paid){
  return store.atomic(()=>{
   const cur=store.batch(row.id);if(!['submitted','uncertain'].includes(cur.state))return cur;
   const ev=evidence(cur);
   if(ev.quota_day&&cur.max_cost_raw)store.bumpDay(ev.quota_day,cur.account_id,0,paid-BigInt(cur.max_cost_raw));// reserved -> real cost
   return store.updateBatch(cur.id,{...patch,gas_paid_raw:String(paid),evidence_json:JSON.stringify({...ev,...(patch.evidence??{}),ended_at:now()})},['submitted','uncertain']);
  });
 }
 /** The trade's Calibur nonce moved past this batch's: the batch ran, whatever the lookups say. Unknown -> true. */
 async function seqMoved(row){
  try{
   if(lc(await rpc.code(row.wallet))!==CALIBUR_CODE)return false;
   return decodeSeq(await rpc.call({to:row.wallet,data:getSeqCalldata(BigInt(row.nonce_key))}))>BigInt(row.nonce_seq);
  }catch{return true}
 }
 /** Plan 2.4: the receipt of any hash sent, judged by the USDC Transfer logs. A row ends failed only on a reading
  * that a second lookup agrees with (a load-balanced RPC can answer one call from a node that lags another). */
 async function reconcileBatch(row,t){
  const sends=sendsOf(row),legs=storedLegs(row),ev0=evidence(row);
  for(const s of sends){
   const rc=await rpc.receipt(s.hash);
   if(!rc)continue;
   const info=await rpc.transaction(s.hash);
   if(!info)return null;// the receipt came from a node the transaction lookup has not caught up with: read again
   const paid=BigInt(rc.gasUsed)*BigInt(rc.effectiveGasPrice)+BigInt(rc.l1Fee??0n);
   const isCancel=s.kind==='cancel';
   if(lc(info.from)!==row.sender||lc(info.to)!==(isCancel?row.sender:row.wallet)||Number(info.nonce)!==row.sender_nonce){
    alert({kind:'base_batch_receipt_mismatch',chain:'base',attempt_id:row.id,tx_hash:s.hash});
    const out=settle(row,{state:'failed',code:'RECEIPT_MISMATCH',never_send:1},paid);transition(row,out.state,{code:out.code});return resultOf(out);
   }
   if(isCancel){
    // Our cancel took the nonce: the batch can no longer run.
    const code=ev0.cancel?.code??'CANCELLED';
    const out=settle(row,{state:'cancelled',code,never_send:1,tx_hash:s.hash,evidence:{cancel_mined:true,confirmed_at:t,block:String(rc.blockNumber??'')}},paid);
    transition(row,out.state,{code,tx_hash:s.hash});return resultOf(out);
   }
   const ev=legEvidence(rc.logs,{user:row.wallet,legs}),okLegs=ev.map((x,i)=>x.ok?legs[i].idx:null).filter(x=>x!==null);
   const base={tx_hash:s.hash,evidence:{legs:ev,legs_ok:okLegs,receipt_status:success(rc)?'success':'reverted',confirmed_at:t,block:String(rc.blockNumber??'')}};
   let out;
   if(success(rc)&&okLegs.length===legs.length){
    let check={};
    try{
     const code=lc(await rpc.code(row.wallet)),seq=decodeSeq(await rpc.call({to:row.wallet,data:getSeqCalldata(BigInt(row.nonce_key))}));
     check={code_after:code,seq_after:String(seq),delegated:code===CALIBUR_CODE,seq_advanced:seq===BigInt(row.nonce_seq)+1n};
     if(!check.delegated||!check.seq_advanced)alert({kind:'base_batch_check',chain:'base',attempt_id:row.id,...check});
    }catch(e){check={check_error:safeError(e)}}
    out=settle(row,{state:'confirmed',code:null,tx_hash:s.hash,evidence:{...base.evidence,...check}},paid);
   }else if(success(rc)&&okLegs.length===0){
    out=settle(row,{state:'failed',code:'NOTHING_MOVED',never_send:1,tx_hash:s.hash,evidence:base.evidence},paid);
   }else if(!success(rc)){
    out=settle(row,{state:'failed',code:'REVERTED',never_send:1,tx_hash:s.hash,evidence:base.evidence},paid);
   }else{
    alert({kind:'base_batch_partial_logs',chain:'base',attempt_id:row.id,legs_ok:okLegs});
    out=settle(row,{state:'confirmed',code:'PARTIAL_LOGS',tx_hash:s.hash,evidence:base.evidence},paid);
   }
   log('base_batch_transition',{attempt_id:s12(row.id),state_from:row.state,state_to:out.state,code:out.code,tx_ref:s12(s.hash),payer_cost_raw:String(paid),legs_ok:okLegs.length});
   return resultOf(out);
  }
  if(Number(await rpc.nonce(row.sender,'latest'))>row.sender_nonce){
   for(const s of sends)if((await rpc.transaction(s.hash))?.blockNumber!=null)return null;// mined, receipt not indexed yet
   // Seen once is not enough: the row ends only when the nonce has read as taken for NONCE_CONSUMED_CONFIRM_MS
   // with no receipt, and the trade's batch nonce has not moved (if it has, the batch ran: wait for its receipt).
   const first=Number(ev0.nonce_consumed_at??0);
   if(!first){store.updateBatch(row.id,{evidence_json:JSON.stringify({...ev0,nonce_consumed_at:t})},['submitted','uncertain']);return null}
   if(t-first<NONCE_CONSUMED_CONFIRM_MS)return null;
   if(await seqMoved(row)){
    if(store.flag(`batch_stuck:${row.id}`)!=='1'){store.setFlag(`batch_stuck:${row.id}`,'1');alert({kind:'base_batch_stuck',chain:'base',attempt_id:row.id,why:'receipt_missing'})}
    return null;
   }
   alert({kind:'base_batch_nonce_consumed',chain:'base',attempt_id:row.id,nonce:row.sender_nonce});
   const out=settle(row,{state:'failed',code:'NONCE_CONSUMED',never_send:1},0n);
   transition(row,'failed',{code:'NONCE_CONSUMED'});
   return resultOf(out);
  }
  if(t>row.deadline*1000){
   // Past the on-chain deadline: a copy still out there can only revert (SignatureExpired).
   let seen=false;for(const s of sends)if(await rpc.transaction(s.hash)){seen=true;break}
   if(!seen){
    const out=store.atomic(()=>{
     const cur=store.batch(row.id),ev=evidence(cur);
     if(ev.quota_day&&cur.max_cost_raw)store.bumpDay(ev.quota_day,cur.account_id,0,-BigInt(cur.max_cost_raw));
     return store.updateBatch(cur.id,{state:'cancelled',code:'DEADLINE_PASSED_UNSENT',never_send:1,evidence_json:JSON.stringify({...ev,ended_at:t})},['submitted','uncertain']);
    });
    transition(row,'cancelled',{code:'DEADLINE_PASSED_UNSENT'});
    return resultOf(out);
   }
   if(store.flag(`batch_stuck:${row.id}`)!=='1'){store.setFlag(`batch_stuck:${row.id}`,'1');alert({kind:'base_batch_stuck',chain:'base',attempt_id:row.id})}
   // Still in a pool, it holds the gas wallet's nonce: a cancel takes that nonce so the gas wallet moves on.
   if(!ev0.cancel){await replaceBatch(row,t,{cancel:'DEADLINE_PASSED_UNSENT'});return null}
  }
  if(cfg().paused||row.never_send)return null;
  const cancelling=!!ev0.cancel;
  if(!cancelling&&t>row.deadline*1000-SEND_STOP_MS)return null;// no new batch bytes go out this close to the deadline
  const due=t-(row.broadcast_at??0)>=REBROADCAST_INTERVAL_MS;
  if(!due&&row.state!=='uncertain')return null;
  if(!cancelling){
   const why=await resendBlocker(row);
   if(why==='unknown')return null;
   if(why){await replaceBatch(row,t,{cancel:why});return null}
  }
  if(due&&await replaceBatch(row,t))return null;
  const cur=store.updateBatch(row.id,{state:'submitted',broadcast_at:t},['submitted','uncertain']);
  await broadcastRow(cur);
  return null;
 }

 /** Plan 2.6. */
 async function recover({now:at}={}){
  const t=at??now();
  const safe=async(row,fn)=>{try{return await fn()}catch(e){log('base_recover_error',{attempt_id:s12(row.id),code:e?.code,error:safeError(e)});return null}};
  for(const row of store.batchesIn(['submitted','uncertain']))await safe(row,()=>reconcileBatch(row,t));
  for(const row of store.batchesIn(['prepared']))if(t>row.expires_at)cancelBatch(row,'SIGN_EXPIRED');
  for(const row of store.batchesIn(['signed']))await safe(row,()=>advance(row.id,t));
 }
 const row=id=>store.batch(String(id))??null;
 function abandonPrepared(id,code='SUPERSEDED'){const r=store.batch(String(id));if(r&&r.state==='prepared')cancelBatch(r,code)}
 /** The highest attempt number of batches anchored at leg `idx` (the ledger numbers attempts per anchor leg). */
 const maxAttemptNo=(tradeId,idx)=>store.legBatches(String(tradeId),Number(idx)).filter(b=>storedLegs(b)[0].idx===Number(idx)).reduce((m,b)=>Math.max(m,b.attempt_no),0);
 const preparedFor=wallet=>store.walletBatches(lc(wallet),['prepared']);
 const flagUnsupported=wallet=>store.setFlag(unsupportedFlag(wallet),'1');
 const confirmedUnchecked=()=>store.batchesIn(['confirmed']).filter(b=>!evidence(b).deposit_checked);
 function markDepositChecked(id,extra={}){const b=store.batch(id);store.updateBatch(id,{evidence_json:JSON.stringify({...evidence(b),deposit_checked:true,...extra})})}
 function autoLegacy(detail){
  if(store.flag(AUTO_LEGACY_FLAG)==='1')return false;
  store.setFlag(AUTO_LEGACY_FLAG,'1');
  alert({kind:'base_7702_deposit_unseen',chain:'base',...detail});
  log('base_7702_auto_legacy',{attempt_id:s12(detail.attempt_id),why:detail.why});
  return true;
 }
 return Object.freeze({prepare,submit,advance,recover,reconcileBatch,row,abandonPrepared,maxAttemptNo,preparedFor,flagUnsupported,
  confirmedUnchecked,markDepositChecked,autoLegacy,legsOf:storedLegs,store});
}

// Base driver (GAS-SPONSORSHIP-DESIGN.md section 1, package B): BUY with USDC on Base. The user's own wallet signs a
// plain EIP-1559 USDC.transfer(depositAddress, amount) to the 1Click deposit address; our gas wallet's only transaction
// is a just-in-time native ETH top-up to that same user wallet. Lifted from Folio @70848f097
// apps/server/src/bridge/source-service.ts ensureGas (504-552), replaceTopup (326-374), reconcile (375-503), with
// source-executor.ts (prepare/submit/reconcile) and source-gas.ts. Deliberate deviation (design decision 3): the top-up
// is sent after the user's signature validates, not before prepare, so the gas wallet spends only for a valid,
// pinned transfer. Other YEET changes are marked "YEET:".
//
// Interface (pipeline/driver-interface.mjs):
//   readiness()                                     -> {ok, reasons[]}          (sync)
//   prepare({trade, leg, wallet, attemptId, attemptNo?, now?})
//                                                   -> {payload, payloadSha256, expiresAt, kind, chain, wallet, attemptId, summary}
//   submit({trade, leg, wallet, attemptId, signed, dryRun, now?})
//                                                   -> {state: sent|pending|expired|not_sent|failed, txHash?, code?, topupTxHash?}
//   recover({now?})                                 -> [{tradeId, legIdx, attemptId, state: sent|confirmed|failed|not_sent|expired, txHash?, code?}]
// `dryRun` defaults to true (Folio source-executor.ts:68): bytes validated, top-up planned, nothing signed or sent.
// `confirmed` from recover = receipt status 1 with Transfer(wallet, depositAddress, amount) from pinned USDC: the
// point to POST /v0/deposit/submit. Refusals throw TradeError(code) and change nothing.
import {limitsFromEnv,accountLive,spentToday} from '../../trade/limits.mjs';
import {refuse,TradeError,sha256,utcDay} from '../../trade/util.mjs';
import {readBaseConfig,BASE_CHAIN_ID,USDC_BASE,TOPUP_GAS,MAX_USER_GAS,SIGN_WINDOW_MS,DEADLINE_MARGIN_MS,MAX_FAILED_TOPUPS,
 MAX_TOPUPS_PER_ACCOUNT_DAY,REBROADCAST_INTERVAL_MS} from './config.mjs';
import {quoteTransfer,quoteTopup,replacementFees} from './fees.mjs';
import {prepareTopup} from './gas-ledger.mjs';
import {loadGasWallet,assertTopupBytes} from './gas-wallet.mjs';
import {buildTransfer,transferData,payloadOf,txJson,txFromJson,assertTransferPinned,validateSigned,transferLogMatches} from './source-executor.mjs';
import {createBaseStore,OPEN} from './store.mjs';

const ADDR=/^0x[0-9a-f]{40}$/;
const UNBROADCAST=['prepared','signed','awaiting_gas'];
const SOFT=new Set(['TOPUP_PENDING','TRADING_PAUSED','SOURCE_PAUSED']);
const s12=v=>v==null?undefined:String(v).slice(0,12);
const success=rc=>rc.status==='success'||rc.status===1||rc.status==='0x1';
const maxBig=(a,b)=>a>b?a:b;

/** attempt_id = sha256("yeet-attempt:" + trade_id + ":" + leg + ":" + n), design 1.2. */
export const attemptIdFor=(tradeId,legIdx,attemptNo)=>sha256(`yeet-attempt:${tradeId}:${legIdx}:${attemptNo}`);

function addr(v){const a=String(v??'').toLowerCase();if(!ADDR.test(a))refuse('SOURCE_IDENTITY_MISMATCH','address');return a}
/** The leg as trade/db.mjs stores it (idx, amount_in_raw, deposit_address, live_quote_json.deadline). */
function legView(trade,leg){
 const tradeId=String(trade?.id??leg?.trade_id??''),accountId=String(trade?.account_id??'');
 const legIdx=Number(leg?.idx??leg?.leg_idx),amount=String(leg?.amount_in_raw??leg?.amount_raw??'');
 let deadline=leg?.deadline;
 if(deadline===undefined)try{deadline=JSON.parse(leg.live_quote_json).deadline}catch{deadline=undefined}
 deadline=typeof deadline==='number'?deadline:Date.parse(deadline);
 if(!tradeId||!accountId||!Number.isInteger(legIdx)||legIdx<0||!/^[1-9][0-9]{0,30}$/.test(amount)||!Number.isFinite(deadline))
  refuse('SOURCE_IDENTITY_MISMATCH','leg shape');
 return {tradeId,accountId,legIdx,amountRaw:BigInt(amount),depositAddress:addr(leg.deposit_address),deadline};
}

export function createBaseDriver({db,rpc,env=process.env,now=Date.now,alert=()=>{},log=(event,fields)=>console.error(JSON.stringify({event,...fields})),
 loadWallet=loadGasWallet}={}){
 if(!db||!rpc)throw Error('createBaseDriver needs db and rpc');
 const store=createBaseStore(db,()=>now());
 const cfg=()=>{try{return readBaseConfig(env)}catch(e){refuse('GAS_WALLET_NOT_CONFIGURED',e.message)}};
 const limits=()=>limitsFromEnv(env);

 /** Guard 1, read from env at the moment of the call. */
 function gateRefusal(accountId){
  let l;try{l=limits()}catch{return 'TRADING_PAUSED'}
  if(l.killSwitch||!l.live||!accountLive(l,accountId))return 'TRADING_PAUSED';
  let c;try{c=readBaseConfig(env)}catch{return 'SOURCE_PAUSED'}
  return c.paused?'SOURCE_PAUSED':null;
 }
 const gate=accountId=>{const c=gateRefusal(accountId);/*G1*/if(c)refuse(c,'live gate')};

 function signRequest(a){
  const payload=payloadOf(txFromJson(a.tx_json));
  return {kind:'evm_tx',chain:'base',attemptId:a.id,wallet:a.wallet,payload,payloadSha256:a.payload_sha256,expiresAt:a.expires_at,
   summary:{asset:'USDC',amount_raw:a.amount_raw,decimals:6,to:a.deposit_address}};
 }
 function resultOf(a){
  const r={txHash:a.tx_hash??undefined};
  if(a.state==='cancelled')return {...r,state:a.code==='SIGN_EXPIRED'&&!a.signed_raw?'expired':'not_sent',code:a.code};
  if(a.state==='failed')return {...r,state:'failed',code:a.code};
  if(['submitted','uncertain','confirmed'].includes(a.state))return {...r,state:'sent'};
  return {...r,state:'pending'};
 }
 function transition(a,to,extra={}){
  log('base_source_transition',{trade_id:s12(a.trade_id),attempt_id:s12(a.id),account_id:a.account_id,wallet:s12(a.wallet),nonce:a.nonce,
   state_from:a.state,state_to:to,tx_ref:s12(extra.tx_hash??a.tx_hash),code:extra.code});
 }
 function cancel(a,code){
  const out=store.atomic(()=>{
   const cur=store.attempt(a.id);
   if(!OPEN.includes(cur.state))return cur;
   const l=store.ledger(cur.wallet);l.release(cur.id);store.saveLedger(cur.wallet,l);
   return store.update(cur.id,{state:'cancelled',code},OPEN);
  });
  transition(a,'cancelled',{code});
  return resultOf(out);
 }
 function capCheck(l,amount){
  /*G4*/if(amount<l.minLegRaw)refuse('AMOUNT_TOO_SMALL','leg under minimum');
  /*G4*/if(amount>l.maxTradeRaw)refuse('LIMIT_EXCEEDED','over per-trade cap');
 }
 /** Our own gas-wallet spend counted against YEET_BASE_TOPUP_CAP_RAW for one wallet (Folio topupSpent), in-flight included. */
 function walletTopupSpent(wallet,exclude){
  let sum=0n;
  for(const r of store.walletTopups(wallet)){
   if(r.id===exclude)continue;
   const tx=txFromJson(r.tx_json),paid=BigInt(r.gas_paid_raw??'0');
   if(r.state==='confirmed')sum+=tx.value+paid;
   else if(r.state==='failed'||r.state==='cancelled')sum+=paid;
   else if(!r.replaced_by)sum+=tx.value+tx.gas*tx.maxFeePerGas+BigInt(JSON.parse(r.evidence_json).l1_fee_raw??'0');
  }
  return sum;
 }
 /** ETH the wallet needs for every transfer of ours that must land up to and including `a` (YEET: multi-leg baskets). */
 function outstandingFor(a){
  const rows=store.walletTransfers(a.wallet,['signed','awaiting_gas','submitted','uncertain']).filter(x=>x.id!==a.id&&x.nonce<=a.nonce);
  return rows.reduce((s,x)=>s+BigInt(x.needed_raw),BigInt(a.needed_raw));
 }
 function lowAlert(balance,c){
  if(store.flag('gas_wallet_low')!=='1'){store.setFlag('gas_wallet_low','1');alert({kind:'gas_wallet_low',chain:'base',wallet:c.gasWallet,balance_raw:String(balance),floor_raw:String(c.floorRaw)})}
  log('base_gas_wallet_low',{wallet:s12(c.gasWallet),balance_raw:String(balance),floor_raw:String(c.floorRaw)});
 }
 function recoveredAlert(balance,c){
  if(store.flag('gas_wallet_low')==='1'){store.setFlag('gas_wallet_low','0');alert({kind:'gas_wallet_recovered',chain:'base',wallet:c.gasWallet,balance_raw:String(balance)})}
 }

 /** Guards 8-12 without signing: the top-up the wallet needs for `a`, or a refusal. Folio ensureGas, reads only. */
 async function planTopup(a,outstanding,balance,t){
  const shortfall=outstanding-balance,decision=(outcome,extra={})=>log('base_topup_decision',{trade_id:s12(a.trade_id),attempt_id:s12(a.id),
   account_id:a.account_id,wallet:s12(a.wallet),needed_raw:String(outstanding),shortfall_raw:String(shortfall),outcome,...extra});
  if(shortfall<=0n){decision('not_needed');return {needed:outstanding,shortfall:0n,amount:0n}}
  const c=cfg(),legTopups=store.legTopups(a.trade_id,a.leg_idx);
  /*G12*/if(legTopups.filter(x=>x.state==='failed'&&x.code!=='SUPERSEDED_SIBLING').length>=MAX_FAILED_TOPUPS){decision('exhausted');refuse('TOPUP_ATTEMPTS_EXHAUSTED')}
  /*G12*/if(store.liveTopups().length){decision('pending');refuse('TOPUP_PENDING')}
  /*G8*/const call=prepareTopup(a.wallet,c.gasWallet??undefined,shortfall);
  /*G8*/if(loadWallet(c).address!==call.from)refuse('GAS_WALLET_NOT_CONFIGURED','gas wallet address');
  const q=await quoteTopup(rpc,{capWei:c.maxFeeWei});// G7 for the top-up: readFees refuses a price above the cap
  const margin=maxBig((outstanding+3n)/4n,2n*q.gas*q.maxFeePerGas);
  const remaining=c.topupCapRaw-walletTopupSpent(a.wallet)-q.fee;
  /*G9*/if(remaining<shortfall){decision('cap_exceeded',{cap:'wallet'});refuse('TOPUP_CAP_EXCEEDED','per-wallet cap')}
  const desired=shortfall+margin,amount=desired<remaining?desired:remaining,day=utcDay(t);
  /*G10*/if(store.day(day,a.account_id).count>=MAX_TOPUPS_PER_ACCOUNT_DAY){decision('cap_exceeded',{cap:'account_day'});refuse('TOPUP_CAP_EXCEEDED','account daily count')}
  /*G10*/if(store.dayTotal(day)+amount+q.fee>c.globalDailyRaw){decision('cap_exceeded',{cap:'global_day'});refuse('TOPUP_CAP_EXCEEDED','global daily cap')}
  const gb=BigInt(await rpc.balance(call.from,'latest'));
  /*G11*/if(gb-amount-q.fee<c.floorRaw){decision('wallet_low',{amount_raw:String(amount)});lowAlert(gb,c);refuse('TOPUP_UNAVAILABLE','gas wallet floor')}
  recoveredAlert(gb,c);
  return {needed:outstanding,shortfall,amount,fee:q.fee,quote:q,gasWallet:call.from,capRemaining:remaining-amount,day};
 }

 /** Folio ensureGas: sign, store before broadcast, broadcast. Returns the top-up hash. */
 async function ensureGas(a,plan,t){
  gate(a.account_id);
  const nonce=Number(await rpc.nonce(plan.gasWallet,'pending'));
  const tx={type:'eip1559',chainId:BASE_CHAIN_ID,to:a.wallet,value:plan.amount,data:'0x',nonce,gas:TOPUP_GAS,
   maxFeePerGas:plan.quote.maxFeePerGas,maxPriorityFeePerGas:plan.quote.maxPriorityFeePerGas};
  const wallet=loadWallet(cfg());
  /*G8*/if(wallet.address!==plan.gasWallet||tx.to===wallet.address)refuse('GAS_WALLET_NOT_CONFIGURED','gas wallet changed');
  gate(a.account_id);// read again immediately before the signature exists (Folio audit M1)
  const signed=await wallet.sign(tx);
  /*G8*/await assertTopupBytes(signed.bytes,tx,wallet.address);
  const seq=store.legTopups(a.trade_id,a.leg_idx).length,id=`topup:${a.trade_id}:${a.leg_idx}:${seq}`;
  const c=cfg();
  store.atomic(()=>{
   /*G12*/if(store.liveTopups().length)refuse('TOPUP_PENDING');
   /*G9*/if(walletTopupSpent(a.wallet)+plan.amount+plan.fee>c.topupCapRaw)refuse('TOPUP_CAP_EXCEEDED','per-wallet cap');
   /*G10*/if(store.day(plan.day,a.account_id).count>=MAX_TOPUPS_PER_ACCOUNT_DAY||store.dayTotal(plan.day)+plan.amount+plan.fee>c.globalDailyRaw)refuse('TOPUP_CAP_EXCEEDED','daily');
   store.insert({id,kind:'gas_topup',trade_id:a.trade_id,leg_idx:a.leg_idx,seq,account_id:a.account_id,wallet:a.wallet,sender:wallet.address,
    nonce,tx_json:txJson(tx),state:'prepared',signed_raw:signed.bytes,tx_hash:signed.hash,sent_at:t,broadcast_at:t,
    evidence_json:JSON.stringify({needed_raw:String(plan.needed),shortfall_raw:String(plan.shortfall),l1_fee_raw:String(plan.quote.l1Fee),for_attempt:a.id})});
   store.bumpDay(plan.day,a.account_id,1,plan.amount+plan.fee);
   if(a.state!=='awaiting_gas')store.update(a.id,{state:'awaiting_gas'},['signed','awaiting_gas']);
  });
  log('base_gas_topup',{trade_id:s12(a.trade_id),attempt_id:s12(id),account_id:a.account_id,wallet:s12(a.wallet),nonce,stage:'reserved',
   amount_raw:String(plan.amount),cap_remaining_raw:String(plan.capRemaining),tx_ref:s12(signed.hash)});
  await sendTopup(store.update(id,{state:'submitted'},['prepared']));
  return signed.hash;
 }
 async function sendTopup(row){
  try{if(String(await rpc.broadcast(row.signed_raw)).toLowerCase()!==row.tx_hash)throw Error('SUBMISSION_HASH_MISMATCH')}
  catch(e){log('base_gas_topup',{attempt_id:s12(row.id),stage:'uncertain',tx_ref:s12(row.tx_hash),error:String(e?.message??e).slice(0,120)});
   store.update(row.id,{state:'uncertain'},['prepared','submitted','uncertain'])}
 }
 async function sendTransfer(a,t){
  if(gateRefusal(a.account_id))return resultOf(a);
  const row=store.update(a.id,{state:'submitted',sent_at:t,broadcast_at:t},['signed','awaiting_gas']);
  transition(a,'submitted');
  try{if(String(await rpc.broadcast(row.signed_raw)).toLowerCase()!==row.tx_hash)throw Error('SUBMISSION_HASH_MISMATCH')}
  catch(e){log('base_source_transition',{attempt_id:s12(a.id),state_to:'uncertain',tx_ref:s12(a.tx_hash),error:String(e?.message??e).slice(0,120)});
   store.update(a.id,{state:'uncertain'},['submitted','uncertain'])}
  return {state:'sent',txHash:row.tx_hash};
 }

 /** A signed transfer: wait for lower nonces, top up when short, broadcast the stored bytes. */
 async function advance(id,t){
  let a=store.attempt(id);
  if(!['signed','awaiting_gas'].includes(a.state))return resultOf(a);
  if(t>a.deadline-DEADLINE_MARGIN_MS)return cancel(a,'SIGN_EXPIRED');
  if(gateRefusal(a.account_id)){if(a.state==='signed')store.update(a.id,{state:'awaiting_gas'},['signed']);return resultOf(store.attempt(id))}
  const latest=Number(await rpc.nonce(a.wallet,'latest'));
  if(latest>a.nonce)return cancel(a,'NONCE_CHANGED');
  const lower=store.walletTransfers(a.wallet,OPEN).filter(x=>x.id!==a.id&&x.nonce>=latest&&x.nonce<a.nonce);
  if(new Set(lower.map(x=>x.nonce)).size<a.nonce-latest)return cancel(a,'NONCE_CHANGED');// a nonce below ours will never be used
  if(lower.some(x=>UNBROADCAST.includes(x.state))){if(a.state==='signed')store.update(a.id,{state:'awaiting_gas'},['signed']);return resultOf(store.attempt(id))}
  const outstanding=outstandingFor(a),balance=BigInt(await rpc.balance(a.wallet,'latest'));
  if(outstanding>balance){
   try{
    const plan=await planTopup(a,outstanding,balance,t);
    const topupTxHash=await ensureGas(store.attempt(id),plan,t);
    return {...resultOf(store.attempt(id)),topupTxHash};
   }catch(e){
    a=store.attempt(id);
    if(!(e instanceof TradeError)||SOFT.has(e.code)){
     if(a.state==='signed')store.update(a.id,{state:'awaiting_gas'},['signed']);
     if(!(e instanceof TradeError))log('base_topup_decision',{attempt_id:s12(id),outcome:'error',error:String(e?.message??e).slice(0,120)});
     return resultOf(store.attempt(id));
    }
    return cancel(a,e.code);
   }
  }
  return sendTransfer(a,t);
 }

 function readiness(){
  const reasons=[];let c;
  try{c=readBaseConfig(env)}catch{return {ok:false,reasons:['GAS_WALLET_NOT_CONFIGURED']}}
  try{loadWallet(c)}catch{reasons.push('GAS_WALLET_NOT_CONFIGURED')}
  if(c.paused)reasons.push('SOURCE_PAUSED');
  return {ok:reasons.length===0,reasons};
 }

 async function prepare({trade,leg,wallet,attemptId,attemptNo,now:at}={}){
  const t=at??now(),v=legView(trade,leg),w=addr(wallet);
  if(!/^[0-9a-f]{64}$/.test(String(attemptId)))refuse('SOURCE_IDENTITY_MISMATCH','attempt id');
  if(attemptNo!==undefined&&attemptIdFor(v.tradeId,v.legIdx,attemptNo)!==attemptId)refuse('SOURCE_IDENTITY_MISMATCH','attempt number');
  const c=cfg();
  if(c.paused)refuse('SOURCE_PAUSED');
  const existing=store.attempt(attemptId);
  if(existing){
   if(existing.kind==='transfer'&&existing.trade_id===v.tradeId&&existing.leg_idx===v.legIdx&&existing.wallet===w
    &&existing.state==='prepared'&&t<=existing.expires_at)return signRequest(existing);
   refuse('SOURCE_ATTEMPT_BLOCKED','attempt id used');
  }
  if(store.legTransfers(v.tradeId,v.legIdx).some(a=>a.state!=='prepared'&&a.state!=='cancelled'&&a.state!=='failed'))refuse('SOURCE_ATTEMPT_BLOCKED','leg already signed');
  const expiresAt=Math.min(t+SIGN_WINDOW_MS,v.deadline-DEADLINE_MARGIN_MS);
  /*G4*/if(!(expiresAt>t))refuse('SIGN_EXPIRED','deposit deadline too close');
  capCheck(limits(),v.amountRaw);
  /*G5*/if(String(await rpc.code(w)??'0x')!=='0x')refuse('WALLET_HAS_CODE');
  const q=await quoteTransfer(rpc,{wallet:w,data:transferData(v.depositAddress,v.amountRaw),capWei:c.maxFeeWei,maxGas:MAX_USER_GAS});
  const pending=Number(await rpc.nonce(w,'pending'));
  const row=store.atomic(()=>{
   for(const o of store.legTransfers(v.tradeId,v.legIdx).filter(a=>a.state==='prepared'))store.update(o.id,{state:'cancelled',code:'SUPERSEDED'},['prepared']);
   // YEET: the smallest nonce at or above the chain's pending nonce that no open attempt of this wallet holds.
   const used=new Set(store.walletTransfers(w,OPEN).map(a=>a.nonce));
   let nonce=pending;while(used.has(nonce))nonce++;
   const tx=buildTransfer({depositAddress:v.depositAddress,amountRaw:v.amountRaw,nonce,gas:q.gas,maxFeePerGas:q.maxFeePerGas,maxPriorityFeePerGas:q.maxPriorityFeePerGas});
   return store.insert({id:attemptId,kind:'transfer',trade_id:v.tradeId,leg_idx:v.legIdx,seq:Number(attemptNo??0),account_id:v.accountId,wallet:w,sender:w,
    nonce,tx_json:txJson(tx),payload_sha256:sha256(payloadOf(tx)),deposit_address:v.depositAddress,amount_raw:String(v.amountRaw),
    needed_raw:String(q.needed),expires_at:expiresAt,deadline:v.deadline,state:'prepared',evidence_json:JSON.stringify({l1_fee_raw:String(q.l1Fee)}),created_at:t,updated_at:t});
  });
  transition({...row,state:null},'prepared');
  return signRequest(row);
 }

 async function submit({trade,leg,wallet,attemptId,signed,dryRun,now:at}={}){
  const t=at??now(),dry=dryRun!==false,v=legView(trade,leg),w=addr(wallet);
  const a=store.attempt(String(attemptId));
  if(!a||a.kind!=='transfer')refuse('ATTEMPT_NOT_FOUND');
  if(a.trade_id!==v.tradeId||a.leg_idx!==v.legIdx||a.account_id!==v.accountId||a.wallet!==w||a.deposit_address!==v.depositAddress
   /*G2*/||a.amount_raw!==String(v.amountRaw)||a.deadline!==v.deadline)refuse('SOURCE_IDENTITY_MISMATCH','leg');
  const bytes=typeof signed==='string'?signed.trim().toLowerCase():'';
  if(a.signed_raw){if(a.signed_raw===bytes)return resultOf(a);refuse('SOURCE_ATTEMPT_BLOCKED','different bytes for a signed attempt')}
  if(a.state==='cancelled')return resultOf(a);
  if(a.state!=='prepared')refuse('SOURCE_ATTEMPT_BLOCKED');
  /*G4*/if(t>a.expires_at){if(dry)return {state:'expired',code:'SIGN_EXPIRED'};return cancel(a,'SIGN_EXPIRED')}
  const tx=txFromJson(a.tx_json);
  /*G3*/assertTransferPinned(tx,{depositAddress:v.depositAddress,amountRaw:v.amountRaw});
  /*G3*/const hash=await validateSigned({wallet:a.wallet,unsignedTransactions:[tx]},bytes);
  const l=limits(),c=cfg();
  capCheck(l,v.amountRaw);
  /*G4*/if(spentToday(db,a.account_id,t)>l.dailyCapRaw)refuse('LIMIT_EXCEEDED','over daily cap');
  /*G7*/if(tx.gas>MAX_USER_GAS||tx.maxFeePerGas>c.maxFeeWei)refuse('INVALID_TRANSACTION_BUDGET','transfer budget');
  const blocked=[],gateCode=gateRefusal(a.account_id);
  if(gateCode){if(!dry)gate(a.account_id);blocked.push(gateCode)}
  /*G5*/if(String(await rpc.code(a.wallet)??'0x')!=='0x')refuse('WALLET_HAS_CODE');
  const ahead=store.walletTransfers(a.wallet,OPEN).filter(x=>x.id!==a.id&&x.nonce<a.nonce&&['signed','awaiting_gas','submitted','uncertain'].includes(x.state));
  /*G5*/if(BigInt(await rpc.tokenBalance(a.wallet))<ahead.reduce((s,x)=>s+BigInt(x.amount_raw),v.amountRaw))refuse('PRINCIPAL_SHORT');
  /*G5*/if(Number(await rpc.nonce(a.wallet,'latest'))>a.nonce){if(dry)return {state:'not_sent',code:'NONCE_CHANGED',dryRun:true};return cancel(a,'NONCE_CHANGED')}
  let sim;try{sim=String(await rpc.call({from:a.wallet,to:USDC_BASE,data:tx.data}))}catch{sim=''}
  /*G6*/if(!/^0x0{63}1$/.test(sim))refuse('SIMULATION_FAILED','transfer eth_call');
  // Hard top-up refusals surface here, before the signature is stored; TOPUP_PENDING only means waiting.
  const probe={...a,needed_raw:a.needed_raw},outstanding=outstandingFor(probe),balance=BigInt(await rpc.balance(a.wallet,'latest'));
  let plan=null;
  try{plan=await planTopup(probe,outstanding,balance,t)}
  catch(e){if(!(e instanceof TradeError)||(e.code!=='TOPUP_PENDING'&&!dry))throw e;blocked.push(e.code)}
  if(dry){
   log('base_source_transition',{trade_id:s12(a.trade_id),attempt_id:s12(a.id),stage:'dry_run',tx_ref:s12(hash)});
   return {state:'pending',dryRun:true,broadcast:false,txHash:hash,topup:plan,blocked};
  }
  const saved=store.atomic(()=>{
   const led=store.ledger(a.wallet);led.beforeSigning(a.id,BigInt(a.needed_raw));store.saveLedger(a.wallet,led);
   return store.update(a.id,{state:'signed',signed_raw:bytes,tx_hash:hash},['prepared']);
  });
  transition(a,'signed',{tx_hash:hash});
  const r=await advance(saved.id,t);
  return {...r,txHash:hash};
 }

 /** Folio replaceTopup: same nonce, fees +12.5%; false = replay the stored bytes instead. */
 async function replaceTopup(row,t){
  const c=cfg();
  if(gateRefusal(row.account_id))return false;
  let wallet;try{wallet=loadWallet(c)}catch{return false}
  const prior=txFromJson(row.tx_json);
  let fresh;try{fresh=await quoteTopup(rpc,{capWei:c.maxFeeWei})}catch{return false}
  const tx={...prior,...replacementFees(prior,fresh)},fields={attempt_id:s12(row.id),nonce:row.nonce,max_fee_per_gas:String(tx.maxFeePerGas)};
  /*G7*/if(tx.maxFeePerGas>c.maxFeeWei){log('base_topup_decision',{...fields,stage:'replace',outcome:'fee_cap'});return false}
  const cost=tx.value+tx.gas*tx.maxFeePerGas+fresh.l1Fee,delta=tx.gas*(tx.maxFeePerGas-prior.maxFeePerGas),day=utcDay(t);
  /*G9*/if(walletTopupSpent(row.wallet,row.id)+cost>c.topupCapRaw){
   log('base_topup_decision',{...fields,stage:'replace',outcome:'cap_exceeded'});
   if(store.flag(`replace_capped:${row.id}`)!=='1'){store.setFlag(`replace_capped:${row.id}`,'1');alert({kind:'gas_topup_replace_capped',chain:'base',attempt_id:row.id})}
   return false;
  }
  /*G10*/if(store.dayTotal(day)+delta>c.globalDailyRaw)return false;
  if(gateRefusal(row.account_id))return false;
  let signed;try{signed=await wallet.sign(tx);await assertTopupBytes(signed.bytes,tx,wallet.address)}catch{return false}
  const seq=store.legTopups(row.trade_id,row.leg_idx).length,id=`topup:${row.trade_id}:${row.leg_idx}:${seq}`;
  store.atomic(()=>{
   store.update(row.id,{replaced_by:id});
   store.insert({id,kind:'gas_topup',trade_id:row.trade_id,leg_idx:row.leg_idx,seq,account_id:row.account_id,wallet:row.wallet,sender:row.sender,
    nonce:row.nonce,tx_json:txJson(tx),state:'prepared',signed_raw:signed.bytes,tx_hash:signed.hash,replaces:row.id,sent_at:t,broadcast_at:t,
    evidence_json:JSON.stringify({...JSON.parse(row.evidence_json),l1_fee_raw:String(fresh.l1Fee)})});
   store.bumpDay(day,row.account_id,0,delta);
  });
  log('base_gas_topup',{...fields,stage:'replaced',replaces:s12(row.tx_hash),tx_ref:s12(signed.hash)});
  await sendTopup(store.update(id,{state:'submitted'},['prepared']));
  return true;
 }
 async function reconcileTopup(row,t){
  const rc=await rpc.receipt(row.tx_hash);
  if(rc){
   const info=await rpc.transaction(row.tx_hash),tx=txFromJson(row.tx_json);
   if(!info||String(info.from).toLowerCase()!==row.sender||String(info.to).toLowerCase()!==row.wallet||BigInt(info.value)!==tx.value
    ||(info.input??'0x')!=='0x'||Number(info.nonce)!==row.nonce){
    log('base_gas_topup',{attempt_id:s12(row.id),stage:'receipt_mismatch',code:'TOPUP_RECEIPT_MISMATCH'});
    alert({kind:'gas_topup_receipt_mismatch',chain:'base',attempt_id:row.id});
    store.update(row.id,{state:'failed',code:'TOPUP_RECEIPT_MISMATCH'});return;
   }
   const ok=success(rc),paid=BigInt(rc.gasUsed)*BigInt(rc.effectiveGasPrice)+BigInt(rc.l1Fee??0n);
   store.atomic(()=>{
    if(ok){const l=store.ledger(row.wallet);l.confirmTopup({attemptId:row.id,txHash:row.tx_hash,contribution:tx.value});store.saveLedger(row.wallet,l)}
    store.update(row.id,{state:ok?'confirmed':'failed',code:ok?null:'REVERTED',gas_paid_raw:String(paid)});
    for(const s of store.legTopups(row.trade_id,row.leg_idx))
     if(s.id!==row.id&&s.nonce===row.nonce&&['prepared','submitted','uncertain'].includes(s.state))store.update(s.id,{state:'failed',code:'SUPERSEDED_SIBLING'});
   });
   log('base_gas_topup',{attempt_id:s12(row.id),stage:ok?'confirmed':'failed',payer_cost_raw:String(paid),tx_ref:s12(row.tx_hash)});
   return;
  }
  if(Number(await rpc.nonce(row.sender,'latest'))>row.nonce){
   if((await rpc.transaction(row.tx_hash))?.blockNumber!=null)return;// mined, receipt not indexed yet
   const sibling=store.legTopups(row.trade_id,row.leg_idx).some(s=>s.id!==row.id&&s.nonce===row.nonce);
   store.update(row.id,{state:'failed',code:sibling?'SUPERSEDED_SIBLING':'NONCE_CONSUMED'});return;
  }
  if(row.replaced_by||cfg().paused)return;// a replaced top-up is never sent again; only the operator pause stops replay
  if(t-row.sent_at>=REBROADCAST_INTERVAL_MS&&await replaceTopup(row,t))return;
  if(row.state==='uncertain'||row.state==='prepared'||t-(row.broadcast_at??row.sent_at)>=REBROADCAST_INTERVAL_MS){
   const cur=store.update(row.id,{state:'submitted',broadcast_at:t},['prepared','submitted','uncertain']);
   await sendTopup(cur);
  }
 }
 async function reconcileTransfer(a,t){
  const rc=await rpc.receipt(a.tx_hash);
  if(rc){
   const ok=success(rc)&&transferLogMatches(rc.logs,{wallet:a.wallet,depositAddress:a.deposit_address,amountRaw:a.amount_raw});
   const code=ok?null:success(rc)?'TRANSFER_LOG_MISSING':'REVERTED',paid=BigInt(rc.gasUsed)*BigInt(rc.effectiveGasPrice)+BigInt(rc.l1Fee??0n);
   let refused=null;
   const row=store.atomic(()=>{
    const l=store.ledger(a.wallet);
    try{l.reconcile({attemptId:a.id,txHash:a.tx_hash,paid,failed:!ok})}catch(e){refused=e.code??e.message;l.release(a.id)}
    store.saveLedger(a.wallet,l);
    const ev={...JSON.parse(a.evidence_json),...(refused?{ledger_refused:refused}:{})};
    return store.update(a.id,{state:ok?'confirmed':'failed',code,gas_paid_raw:String(paid),evidence_json:JSON.stringify(ev)},['submitted','uncertain']);
   });
   if(refused){log('base_source_transition',{attempt_id:s12(a.id),stage:'ledger',code:refused,payer_cost_raw:String(paid)});alert({kind:'gas_charge_over_reservation',chain:'base',attempt_id:a.id})}
   transition(a,row.state,{code});
   return {state:ok?'confirmed':'failed',txHash:a.tx_hash,code:code??undefined};
  }
  if(Number(await rpc.nonce(a.wallet,'latest'))>a.nonce){
   if((await rpc.transaction(a.tx_hash))?.blockNumber!=null)return null;
   return cancel(a,'NONCE_CHANGED');
  }
  if(cfg().paused||t>a.deadline-DEADLINE_MARGIN_MS)return null;// never broadcast after deadline - 120 s
  if(a.state==='uncertain'||t-(a.broadcast_at??a.sent_at)>=REBROADCAST_INTERVAL_MS){
   const cur=store.update(a.id,{state:'submitted',broadcast_at:t},['submitted','uncertain']);
   try{if(String(await rpc.broadcast(cur.signed_raw)).toLowerCase()!==cur.tx_hash)throw Error('SUBMISSION_HASH_MISMATCH')}
   catch{store.update(a.id,{state:'uncertain'},['submitted','uncertain'])}
  }
  return null;
 }

 async function recover({now:at}={}){
  const t=at??now(),out=[];
  const emit=(a,r)=>{if(r&&r.state!=='pending')out.push({tradeId:a.trade_id,legIdx:a.leg_idx,attemptId:a.id,state:r.state,txHash:r.txHash,code:r.code})};
  const safe=async(a,fn)=>{try{return await fn()}catch(e){log('base_recover_error',{attempt_id:s12(a.id),code:e?.code,error:String(e?.message??e).slice(0,120)});return null}};
  for(const row of store.unresolvedTopups())await safe(row,()=>reconcileTopup(row,t));
  for(const a of store.transfersIn(['submitted','uncertain']))emit(a,await safe(a,()=>reconcileTransfer(a,t)));
  for(const a of store.transfersIn(['prepared']))if(t>a.expires_at)emit(a,cancel(a,'SIGN_EXPIRED'));
  for(const a of store.transfersIn(['signed','awaiting_gas'])){
   const r=await safe(a,()=>advance(a.id,t));
   if(r&&r.state!=='pending')emit(a,r);
  }
  return out;
 }

 return Object.freeze({chain:'base',kind:'evm_tx',readiness,prepare,submit,recover});
}

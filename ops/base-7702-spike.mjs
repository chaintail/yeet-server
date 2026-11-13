#!/usr/bin/env node
// EIP-7702 spike on Base mainnet: N USDC transfers from the user's EOA in ONE type-4 transaction that OUR gas wallet
// sends and pays for. Delegate: Uniswap Calibur v1.1.0. Design: docs/BASE-7702-SPIKE.md.
//
//   node ops/base-7702-spike.mjs [--plan] [--legs 2] [--amount 0.01] [--to 0xA,0xB] [--gas-wallet 0x..] [--rpc URL]
//       Default. Reads no key and sends nothing. A throwaway in-process key plays the user; it signs the 7702
//       authorization and the batch, and the exact type-4 transaction is simulated with eth_simulateV1 and state
//       overrides (positive legs, and the negative cases: wrong executor, replay, altered batch, expired deadline,
//       stale authorization, revoke). --to recipients repeat to fill --legs; default: fresh random addresses.
//       --gas-wallet (or $YEET_BASE_GAS_WALLET) is simulated as the sender; default: a throwaway address.
//   BASE_7702_CONFIRM=send-spike YEET_LIVE=1 YEET_BASE_GAS_WALLET=0x.. [YEET_BASE_GAS_WALLET_KEY_FILE=..] \
//     node ops/base-7702-spike.mjs --live --wallet <test-wallet.json> [--legs 2] [--amount 0.01] [--to ..] [--rpc URL]
//       Sends exactly one type-4 transaction. Recipients default to the user's own address and the gas wallet.
//   BASE_7702_CONFIRM=send-spike YEET_LIVE=1 ... node ops/base-7702-spike.mjs --revoke --live --wallet <file>
//       Sends one type-4 transaction whose authorization delegates to address(0), clearing the code.
// RPC: --rpc, then $BASE_RPC_URL, then https://mainnet.base.org (needs eth_simulateV1 with state overrides).
// No key value is ever printed; progress lines go to stderr, the one JSON summary to stdout.
import {randomBytes} from 'node:crypto';
import {usdcBalanceOverride} from '../connector/core/pipeline/base/plan-support.mjs';
import {createBaseRpc,broadcastAllowed} from '../connector/core/pipeline/base/rpc.mjs';
import {readBaseConfig,BASE_CHAIN_ID,USDC_BASE} from '../connector/core/pipeline/base/config.mjs';
import {readFees} from '../connector/core/pipeline/base/fees.mjs';
import {loadGasWallet} from '../connector/core/pipeline/base/gas-wallet.mjs';
import {safeError} from '../connector/core/pipeline/base/safe-error.mjs';
import {loadTestWallet} from '../connector/core/pipeline/test-wallet.mjs';
import {CALIBUR,CALIBUR_ABI,ZERO_ADDRESS,EXECUTE_SIGNED_SELECTOR,MAX_LEGS_7702,delegationCode,delegatedTo,caliburDomain,
 batchNonce,buildBatch,batchTypedData,batchDigest,wrapSignature,executeCalldata,decodeExecuteCalldata,authorizationRequest,
 authorizationDigest,assertAuthorization,assertBatchMatches,buildType4,assertType4Bytes,legEvidence,revertName,privyTypedData}
 from '../connector/core/pipeline/base/calibur-7702.mjs';
import {privateKeyToAccount,generatePrivateKey,createPublicClient,http,recoverTypedDataAddress,toHex,encodeFunctionData,
 decodeFunctionResult,parseAbi,formatEther,serializeTransaction} from '../connector/core/pipeline/base/spike-7702-support.mjs';

const argv=process.argv.slice(2);
const flag=n=>argv.includes(`--${n}`);
const arg=n=>{const i=argv.indexOf(`--${n}`);return i>=0?argv[i+1]:undefined};
const ADDR=/^0x[0-9a-fA-F]{40}$/;
const lc=a=>String(a).toLowerCase();
const log=m=>process.stderr.write(`[7702] ${m}\n`);
const json=v=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x,1);
const die=(code,msg)=>{console.log(JSON.stringify({ok:false,error:msg}));process.exit(code)};

const live=flag('live'),revoke=flag('revoke');
if(revoke&&!live)die(2,'--revoke requires --live (the plan already simulates a revoke)');
const legsN=Number(arg('legs')??2);
if(!Number.isInteger(legsN)||legsN<1||legsN>MAX_LEGS_7702)die(2,`--legs must be 1..${MAX_LEGS_7702}`);
const amountStr=String(arg('amount')??'0.01');
if(!/^\d+(\.\d{1,6})?$/.test(amountStr))die(2,'--amount: USDC with at most 6 decimals');
const amountRaw=(([w,f=''])=>BigInt(w)*1_000_000n+BigInt(f.padEnd(6,'0')))(amountStr.split('.'));
if(amountRaw<=0n||amountRaw>1_000_000n)die(2,'--amount must be in (0, 1] USDC for the spike');
const toList=arg('to')?String(arg('to')).split(','):null;
if(toList&&!toList.every(a=>ADDR.test(a)))die(2,'--to: comma-separated 0x addresses');
const url=arg('rpc')||String(process.env.BASE_RPC_URL??'').trim()||'https://mainnet.base.org';

const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const client=createPublicClient({transport:http(url,{retryCount:0,timeout:20_000})});
const q=v=>toHex(BigInt(v));
const authJson=a=>({chainId:q(a.chainId),address:a.address,nonce:q(a.nonce),yParity:q(a.yParity),r:a.r,s:a.s});
const balCall=who=>({to:USDC_BASE,data:encodeFunctionData({abi:ERC20,functionName:'balanceOf',args:[who]})});
/** eth_simulateV1 over `latest`; one block per entry. */
const simulate=blocks=>client.request({method:'eth_simulateV1',params:[{blockStateCalls:blocks,validation:false},'latest']});
const SIM_GAS=q(3_000_000);
const callOut=c=>({status:c.status==='0x1'?'success':'reverted',gas_used:BigInt(c.gasUsed),
 revert:c.status==='0x1'?null:revertName(c.returnData&&c.returnData!=='0x'?c.returnData:c.error?.data),logs:c.logs??[]});
/** Simulation overrides: user funded with USDC (+1 ETH from the helper), sender with ETH, user code optional. */
function overrides({user,sender,usdcRaw,code}){
 const o=usdcBalanceOverride(user,usdcRaw);
 const u=lc(user);
 if(code)o[u]={...o[u],code};
 o[lc(sender)]={...(o[lc(sender)]??{}),balance:q(10n**18n)};
 return o;
}
const sum=legs=>legs.reduce((s,l)=>s+l.amountRaw,0n);

async function signBatch(user,legs,{executor,deadline,nonce}){
 const batch=buildBatch({legs,nonce,executor,deadline});
 const typed=batchTypedData(user.address,batch);
 const signature=await user.signTypedData(typed);
 const who=await recoverTypedDataAddress({...typed,signature});
 if(lc(who)!==lc(user.address))throw Error('batch signature does not recover to the user');
 assertBatchMatches(batch,{legs,nonce,executor,deadline});
 const data=executeCalldata(batch,wrapSignature(signature));
 const back=decodeExecuteCalldata(data);
 if(lc(back.signature)!==lc(signature)||back.hookData!=='0x'||back.batch.batchedCall.calls.length!==legs.length)throw Error('calldata round trip');
 return {batch,typed,signature,data,digest:batchDigest(user.address,batch)};
}
async function signAuth(user,nonce,contract=CALIBUR){
 const req=authorizationRequest({nonce,contract});
 const auth=await user.signAuthorization({chainId:req.chainId,contractAddress:req.address,nonce:req.nonce});
 await assertAuthorization(auth,{user:user.address,nonce,contract});
 return {req,auth,digest:authorizationDigest(req)};
}
/** Balance deltas across one simulated execute: user and each distinct recipient. */
function balanceDeltas(calls,who,i0){
 const n=who.length,before=calls.slice(i0,i0+n),after=calls.slice(i0+n+1,i0+2*n+1);
 return Object.fromEntries(who.map((a,i)=>[a,{before_raw:BigInt(before[i].returnData),after_raw:BigInt(after[i].returnData),
  delta_raw:BigInt(after[i].returnData)-BigInt(before[i].returnData)}]));
}

async function plan(){
 const cfg=readBaseConfig({...process.env,YEET_BASE_GAS_WALLET:arg('gas-wallet')??process.env.YEET_BASE_GAS_WALLET??''});
 const rpc=createBaseRpc({url,env:{}});// env {}: broadcast gate closed in this process
 const chainId=await rpc.chainId();
 if(chainId!==BASE_CHAIN_ID)throw Error(`chain ${chainId}`);
 const throwawayGas=privateKeyToAccount(generatePrivateKey());
 const sender=cfg.gasWallet??lc(throwawayGas.address);
 const user=privateKeyToAccount(generatePrivateKey());
 const stranger='0x'+randomBytes(20).toString('hex');
 const recipients=Array.from({length:legsN},(_,i)=>toList?lc(toList[i%toList.length]):'0x'+randomBytes(20).toString('hex'));
 const legs=recipients.map(to=>({to,amountRaw}));
 const block=await client.getBlock({blockTag:'latest'});
 const deadline=block.timestamp+600n;
 const nonce=batchNonce(BigInt('0x'+randomBytes(24).toString('hex')),0n);
 const userNonce=await rpc.nonce(user.address,'latest');
 const code=delegationCode(CALIBUR);
 log(`user (throwaway) ${user.address}, sender ${sender}, legs ${legsN} x ${amountRaw} raw, rpc ${url}`);

 const A=await signAuth(user,userNonce);
 const staleAuth=(await signAuth(user,userNonce+1)).auth;
 const revokeAuth=(await signAuth(user,userNonce,ZERO_ADDRESS)).auth;
 const S=await signBatch(user,legs,{executor:sender,deadline,nonce});
 const funded=sum(legs)+1_000_000n;
 const who=[lc(user.address),...new Set(recipients)];
 const exec=(from,data=S.data,extra={})=>({from,to:user.address,data,gas:SIM_GAS,...extra});
 const withBalances=c=>[...who.map(balCall),c,...who.map(balCall)];
 const ov=(withCode=true)=>overrides({user:user.address,sender,usdcRaw:funded,code:withCode?code:undefined});

 // Altered batches carrying the ORIGINAL signature.
 const alter=legsMut=>{const b=buildBatch({legs:legsMut,nonce,executor:sender,deadline});return executeCalldata(b,wrapSignature(S.signature))};
 const altTo=alter(legs.map((l,i)=>i===0?{...l,to:stranger}:l));
 const altAmt=alter(legs.map((l,i)=>i===0?{...l,amountRaw:l.amountRaw+1n}:l));
 const altExecutor=executeCalldata({...S.batch,executor:stranger},wrapSignature(S.signature));

 const out={mode:'plan',rpc:url,chain_id:chainId,block:block.number,delegate:CALIBUR,delegation_code:code,
  user_throwaway:lc(user.address),sender_gas_wallet:sender,sender_is_throwaway:!cfg.gasWallet,legs:legsN,amount_raw:amountRaw,
  recipients,execute_selector:EXECUTE_SIGNED_SELECTOR,domain:caliburDomain(user.address),
  authorization:{chain_id:A.req.chainId,contract:A.req.address,nonce:A.req.nonce,digest:A.digest},
  batch:{nonce:S.batch.nonce,key_hash:S.batch.keyHash,executor:S.batch.executor,deadline,revert_on_failure:true,digest:S.digest},
  cases:{}};
 const cases=out.cases;
 const expectRevert=(name,c,want)=>{const r=callOut(c);cases[name]={expected:want,got:r.revert??'success',gas_used:r.gas_used,
  legs_transferred:legEvidence(r.logs,{user:user.address,legs}).filter(x=>x.ok).length,pass:r.status==='reverted'&&r.revert===want}};

 // 1. Positive, code override (= an already delegated user: what every later trade sends, type 2 or type 4).
 {const r=await simulate([{stateOverrides:ov(true),calls:withBalances(exec(sender))}]);
  const calls=r[0].calls,c=callOut(calls[who.length]),ev=legEvidence(c.logs,{user:user.address,legs});
  const deltas=balanceDeltas(calls,who,0);
  const expDelta=Object.fromEntries(who.map(a=>[a,0n]));
  for(const l of legs){expDelta[lc(user.address)]-=l.amountRaw;expDelta[l.to]+=l.amountRaw}
  cases.positive_code_override={status:c.status,gas_used:c.gas_used,legs:ev,balances:deltas,
   pass:c.status==='success'&&ev.every(x=>x.ok)&&who.every(a=>deltas[a].delta_raw===expDelta[a])}}
 // 2. Positive, the real thing: no code override, the signed authorization in authorizationList.
 {let r;try{r=await simulate([{stateOverrides:ov(false),calls:withBalances(exec(sender,S.data,{authorizationList:[authJson(A.auth)]}))}])}
  catch(e){cases.positive_with_authorization={error:safeError(e),pass:false}}
  if(r){const c=callOut(r[0].calls[who.length]),ev=legEvidence(c.logs,{user:user.address,legs});
   cases.positive_with_authorization={status:c.status,gas_used:c.gas_used,legs_transferred:ev.filter(x=>x.ok).length,
    pass:c.status==='success'&&ev.every(x=>x.ok)}}}
 // 3. Stale authorization nonce: the transaction SUCCEEDS and moves nothing (why receipts are judged by logs).
 {const r=await simulate([{stateOverrides:ov(false),calls:[exec(sender,S.data,{authorizationList:[authJson(staleAuth)]})]}]);
  const c=callOut(r[0].calls[0]),ev=legEvidence(c.logs,{user:user.address,legs});
  cases.stale_authorization_nonce={status:c.status,legs_transferred:ev.filter(x=>x.ok).length,
   expected:'success with 0 transfers',pass:c.status==='success'&&ev.every(x=>!x.ok)}}
 // 4. Wrong executor: a stranger submits the same signed batch.
 {const r=await simulate([{stateOverrides:{...ov(true),[stranger]:{balance:q(10n**18n)}},calls:[exec(stranger)]}]);
  expectRevert('wrong_executor',r[0].calls[0],'Unauthorized')}
 // 4b. Executor field rewritten to the stranger (signature no longer matches).
 {const r=await simulate([{stateOverrides:{...ov(true),[stranger]:{balance:q(10n**18n)}},calls:[exec(stranger,altExecutor)]}]);
  expectRevert('executor_rewritten_by_stranger',r[0].calls[0],'InvalidSignature')}
 // 5. Replay of the same nonce in the next transaction.
 {const r=await simulate([{stateOverrides:ov(true),calls:[exec(sender),exec(sender)]}]);
  const first=callOut(r[0].calls[0]);
  expectRevert('replay_same_nonce',r[0].calls[1],'InvalidNonce');
  cases.replay_same_nonce.first_status=first.status;
  cases.replay_same_nonce.pass&&=first.status==='success'}
 // 6. Altered batch: recipient, then amount, original signature.
 {const r=await simulate([{stateOverrides:ov(true),calls:[exec(sender,altTo)]}]);expectRevert('altered_recipient',r[0].calls[0],'InvalidSignature')}
 {const r=await simulate([{stateOverrides:ov(true),calls:[exec(sender,altAmt)]}]);expectRevert('altered_amount',r[0].calls[0],'InvalidSignature')}
 // 7. Expired: the same signed batch in a block 1 s past its deadline.
 {const r=await simulate([{blockOverrides:{time:q(deadline+1n)},stateOverrides:ov(true),calls:[exec(sender)]}]);
  expectRevert('expired_deadline',r[0].calls[0],'SignatureExpired')}
 // 8. Revoke: authorization to address(0) clears the code; the same batch afterwards moves nothing.
 {const r=await simulate([{stateOverrides:ov(true),calls:[{from:sender,to:user.address,data:'0x',gas:SIM_GAS,authorizationList:[authJson(revokeAuth)]},exec(sender)]}]);
  const a=callOut(r[0].calls[0]),b=callOut(r[0].calls[1]),ev=legEvidence(b.logs,{user:user.address,legs});
  cases.revoke_then_execute={revoke_status:a.status,revoke_gas_used:a.gas_used,after_status:b.status,legs_transferred:ev.filter(x=>x.ok).length,
   expected:'revoke success, then 0 transfers',pass:a.status==='success'&&ev.every(x=>!x.ok)}}

 // Gas: eth_estimateGas of the exact type-4 call (authorizationList, no code override), fees, L1 upper bound.
 const estOv=overrides({user:user.address,sender,usdcRaw:funded});
 let estimate,estimateSource='eth_estimateGas with authorizationList';
 try{estimate=BigInt(await client.request({method:'eth_estimateGas',params:[{from:sender,to:user.address,data:S.data,authorizationList:[authJson(A.auth)]},'latest',estOv]}))}
 catch(e){estimate=cases.positive_code_override.gas_used+25_000n;estimateSource=`simulated + 25000 auth intrinsic (estimateGas failed: ${safeError(e)})`}
 const fees=await readFees(rpc,cfg.maxFeeWei);
 const gas=estimate+(estimate+3n)/4n;
 const tx=buildType4({user:user.address,authorization:A.auth,data:S.data,nonce:0,gas,...fees});
 const signed=await throwawayGas.signTransaction(tx);// size only: any sender's signature has the same length
 await assertType4Bytes(signed,tx,throwawayGas.address);
 const l1=BigInt(await rpc.l1FeeUpperBound((signed.length-2)/2));
 out.type4_tx={type:'eip7702',to:tx.to,value:'0',nonce:'<gas wallet pending nonce>',gas,max_fee_per_gas:fees.maxFeePerGas,
  max_priority_fee_per_gas:fees.maxPriorityFeePerGas,authorization_list_len:1,data_selector:S.data.slice(0,10)};
 out.sizes={execute_calldata_bytes:(S.data.length-2)/2,signed_type4_bytes:(signed.length-2)/2,
  privy_typed_data_json_bytes:JSON.stringify(privyTypedData(user.address,S.batch)).length};
 out.gas={estimate,estimate_source:estimateSource,simulated_already_delegated:cases.positive_code_override.gas_used,
  simulated_with_authorization:cases.positive_with_authorization.gas_used??null,gas_limit_planned:gas,
  l2_fee_max_wei:gas*fees.maxFeePerGas,l1_fee_upper_bound_wei:l1,total_max_wei:gas*fees.maxFeePerGas+l1,
  total_max_eth:formatEther(gas*fees.maxFeePerGas+l1)};
 out.pass=Object.values(cases).every(c=>c.pass===true);
 return out;
}

async function waitReceipt(rpc,hash){
 for(let i=0;i<90;i++){
  const r=await rpc.receipt(hash).catch(e=>{log(`receipt read: ${safeError(e)}`);return null});
  if(r)return r;
  await new Promise(res=>setTimeout(res,2000));
 }
 return null;
}
function loadUser(file){
 if(!file)die(2,'--live needs --wallet <test wallet file>');
 const w=loadTestWallet(file);
 const k=w.base.privateKey();
 const account=privateKeyToAccount(toHex(k));k.fill(0);
 if(lc(account.address)!==lc(w.base.address))die(1,'wallet file: key does not match address');
 return account;
}

async function liveRun(){
 if(process.env.BASE_7702_CONFIRM!=='send-spike')die(2,'refused: set BASE_7702_CONFIRM=send-spike to send');
 // The adapter's own gate (YEET_LIVE=1, kill switch off, YEET_BASE_PAUSE off), checked before anything is signed.
 if(!broadcastAllowed(process.env))die(2,'refused: broadcast gate closed (needs YEET_LIVE=1, YEET_KILL_SWITCH off, YEET_BASE_PAUSE off)');
 const cfg=readBaseConfig(process.env);
 const rpc=createBaseRpc({url,env:process.env});
 const chainId=await rpc.chainId();
 if(chainId!==BASE_CHAIN_ID)die(1,`chain ${chainId}`);
 const gw=loadGasWallet(cfg);// throws GAS_WALLET_NOT_CONFIGURED; the key never leaves the module
 const user=loadUser(arg('wallet'));
 const U=lc(user.address);
 if(U===gw.address)die(1,'user and gas wallet must differ (an authority sending its own type-4 needs nonce+1)');
 const out={mode:revoke?'revoke-live':'live',rpc:url,delegate:CALIBUR,user:U,gas_wallet:gw.address};
 const codeBefore=await rpc.code(U);
 out.code_before=codeBefore;
 const del=delegatedTo(codeBefore);
 const [uLatest,uPending,gLatest,gPending]=await Promise.all([rpc.nonce(U,'latest'),rpc.nonce(U,'pending'),rpc.nonce(gw.address,'latest'),rpc.nonce(gw.address,'pending')]);
 if(uLatest!==uPending)die(1,'user has a pending transaction: the authorization nonce would go stale');
 if(gLatest!==gPending)die(1,'gas wallet has a pending transaction');
 const ethGas=await rpc.balance(gw.address,'latest');
 out.gas_wallet_eth_before_wei=ethGas;
 const fees=await readFees(rpc,cfg.maxFeeWei);

 let tx,legs=[],key=null;
 if(revoke){
  if(del==='')die(1,'user has no code: nothing to revoke');
  if(del===null)die(1,'user address has non-designator code: refused');
  const {auth}=await signAuth(user,uPending,ZERO_ADDRESS);
  let est;
  try{est=BigInt(await client.request({method:'eth_estimateGas',params:[{from:gw.address,to:U,data:'0x',authorizationList:[authJson(auth)]},'latest']}))}
  catch(e){die(1,`estimateGas failed: ${safeError(e)}`)}
  const gas=est+(est+3n)/4n;
  if(gas>80_000n)die(1,`revoke gas ${gas} above 80000`);
  tx=buildType4({user:U,authorization:auth,data:'0x',nonce:gPending,gas,...fees});
 }else{
  if(del===null||(del!==''&&lc(del)!==lc(CALIBUR)))die(1,`user code is ${del===null?'a contract':'delegated to '+del}: refused`);
  const recipients=Array.from({length:legsN},(_,i)=>toList?lc(toList[i%toList.length]):[U,gw.address][i%2]);
  legs=recipients.map(to=>({to,amountRaw}));
  const usdc=await rpc.tokenBalance(U);
  out.user_usdc_before_raw=usdc;
  if(usdc<sum(legs))die(1,`user USDC ${usdc} raw < ${sum(legs)} needed`);
  const block=await client.getBlock({blockTag:'latest'});
  const deadline=block.timestamp+600n;
  key=BigInt('0x'+randomBytes(24).toString('hex'));
  let seq=0n;
  if(del!==''){seq=decodeFunctionResult({abi:CALIBUR_ABI,functionName:'getSeq',data:await rpc.call({to:U,data:encodeFunctionData({abi:CALIBUR_ABI,functionName:'getSeq',args:[key]})})})}
  const nonce=batchNonce(key,seq);
  const A=await signAuth(user,uPending);
  const S=await signBatch(user,legs,{executor:gw.address,deadline,nonce});
  out.batch={nonce,deadline,digest:S.digest,legs:legs.map(l=>({to:l.to,amount_raw:l.amountRaw}))};
  out.authorization={nonce:A.req.nonce,digest:A.digest};
  // Preflight: the exact call (real authorizationList, no code override) must show every leg's Transfer log.
  const sim=await simulate([{calls:[{from:gw.address,to:U,data:S.data,gas:SIM_GAS,authorizationList:[authJson(A.auth)]}]}]);
  const c=callOut(sim[0].calls[0]),ev=legEvidence(c.logs,{user:U,legs});
  out.preflight={status:c.status,gas_used:c.gas_used,revert:c.revert,legs_transferred:ev.filter(x=>x.ok).length};
  if(c.status!=='success'||!ev.every(x=>x.ok))die(1,`preflight simulation failed: ${json(out.preflight)}`);
  let est;
  try{est=BigInt(await client.request({method:'eth_estimateGas',params:[{from:gw.address,to:U,data:S.data,authorizationList:[authJson(A.auth)]},'latest']}))}
  catch(e){die(1,`estimateGas failed: ${safeError(e)}`)}
  const gas=est+(est+3n)/4n,cap=120_000n+45_000n*BigInt(legsN);
  if(gas>cap)die(1,`gas ${gas} above cap ${cap}`);
  tx=buildType4({user:U,authorization:A.auth,data:S.data,nonce:gPending,gas,...fees});
 }
 const size=BigInt((serializeTransaction(tx).length-2)/2+67);
 const l1=BigInt(await rpc.l1FeeUpperBound(size));
 const maxCost=tx.gas*tx.maxFeePerGas+l1;
 out.max_cost_wei=maxCost;
 if(ethGas<maxCost)die(1,`gas wallet ETH ${ethGas} < max cost ${maxCost}`);
 const {bytes}=await gw.sign(tx);
 const hash=await assertType4Bytes(bytes,tx,gw.address);
 out.tx_hash=hash;
 log(`sending type-4 ${hash} gas ${tx.gas} maxFee ${tx.maxFeePerGas}`);
 const sent=await rpc.broadcast(bytes);
 if(lc(sent)!==lc(hash))die(1,`node returned a different hash ${sent}`);
 const rc=await waitReceipt(rpc,hash);
 if(!rc){out.ok=false;out.error='no receipt after 180 s; check the hash';console.log(json(out));process.exit(1)}
 const l2Fee=rc.gasUsed*rc.effectiveGasPrice;
 Object.assign(out,{block:rc.blockNumber,status:rc.status,gas_used:rc.gasUsed,effective_gas_price_wei:rc.effectiveGasPrice,
  l2_fee_wei:l2Fee,l1_fee_wei:rc.l1Fee,total_fee_wei:l2Fee+rc.l1Fee,total_fee_eth:formatEther(l2Fee+rc.l1Fee)});
 const codeAfter=await rpc.code(U);
 out.code_after=codeAfter;
 if(revoke){
  out.ok=rc.status==='success'&&codeAfter==='0x';
 }else{
  out.legs=legEvidence(rc.logs,{user:U,legs});
  out.delegated_after=lc(codeAfter)===lc(delegationCode(CALIBUR));
  const seqAfter=decodeFunctionResult({abi:CALIBUR_ABI,functionName:'getSeq',data:await rpc.call({to:U,data:encodeFunctionData({abi:CALIBUR_ABI,functionName:'getSeq',args:[key]})})});
  out.batch_seq_after=seqAfter;
  out.user_usdc_after_raw=await rpc.tokenBalance(U);
  // Judged from the Transfer logs, never from status alone (a stale authorization succeeds and moves nothing).
  out.ok=rc.status==='success'&&out.legs.every(x=>x.ok)&&out.delegated_after&&seqAfter===out.batch.nonce%(1n<<64n)+1n;
 }
 console.log(json(out));
 process.exit(out.ok?0:1);
}

try{
 if(live)await liveRun();
 else{const out=await plan();console.log(json(out));process.exit(out.pass?0:1)}
}catch(e){die(1,e?.name==='TradeError'?`${e.code}${e.detail?': '+e.detail:''}`:safeError(e))}

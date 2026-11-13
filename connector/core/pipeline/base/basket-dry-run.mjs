// Operator dry run of a Base 7702 basket against a real Base RPC (BASE-7702-PRODUCTION-PLAN.md 2.10), with a throwaway
// key as the person and no funds anywhere: the production batch driver runs prepare and submit steps 1-8 (dry), and
// the only difference from production is that every read of the person's USDC (balanceOf, eth_simulateV1,
// eth_estimateGas) sees a state override funding the throwaway address, and the gas wallet's ETH balance reads as
// 1 ETH. Nothing is signed by a gas wallet key, nothing is sent: the RPC adapter's broadcast gate is closed (env {}).
// `delegated: true` also overrides the person's code to the Calibur designator (a later trade: type 2, no
// authorization). Used by ops/base-7702-basket-dry.mjs and batch-driver.network-test.mjs.
import {randomBytes} from 'node:crypto';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {encodeFunctionResult,toHex} from 'viem';
import {openTradeDb} from '../../trade/db.mjs';
import {createBaseRpc} from './rpc.mjs';
import {createBaseBatchDriver} from './batch-driver.mjs';
import {usdcBalanceOverride} from './plan-support.mjs';
import {CALIBUR,CALIBUR_ABI,delegationCode,caliburSalt,EIP712_DOMAIN_CALLDATA,getSeqCalldata} from './calibur-7702.mjs';
import {BASE_CHAIN_ID} from './config.mjs';
import {sign7702} from '../operator-trade.mjs';

const q=v=>'0x'+BigInt(v).toString(16);
const authJson=a=>({chainId:q(a.chainId),address:a.address,nonce:q(a.nonce),yParity:q(a.yParity),r:a.r,s:a.s});

/** Runs one dry basket. Returns {request, simulation, ...} with addresses, gas and per-leg Transfer evidence only. */
export async function dryRunBasket({url,legs:n=2,amountRaw=3_000_000n,delegated=false,gasWallet,fetchFn,now=Date.now}){
 const real=createBaseRpc({url,env:{},...(fetchFn?{fetchFn}:{})});
 if(await real.chainId()!==BASE_CHAIN_ID)throw Error('not Base mainnet');
 const user=privateKeyToAccount(generatePrivateKey()),w=user.address.toLowerCase();
 const sender=String(gasWallet??privateKeyToAccount(generatePrivateKey()).address).toLowerCase();
 const funded=amountRaw*BigInt(n)+1_000_000n,designator=delegationCode(CALIBUR);
 const overrides=(extra={})=>{
  const o=usdcBalanceOverride(w,funded);
  if(delegated)o[w]={...o[w],code:designator};
  for(const [a,v] of Object.entries(extra)){const k=a.toLowerCase();o[k]={...(o[k]??{}),...v}}
  o[sender]={...(o[sender]??{}),balance:q(10n**18n)};
  return o;
 };
 const json=async(method,params)=>{
  const r=await (fetchFn??fetch)(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const j=await r.json();if(j.error)throw Error(`${method}: ${j.error.message}`);return j.result;
 };
 const rpc={...real,
  tokenBalance:async a=>a.toLowerCase()===w?funded:real.tokenBalance(a),
  balance:async(a,tag)=>a.toLowerCase()===sender?10n**18n:real.balance(a,tag),
  code:async a=>a.toLowerCase()===w&&delegated?designator:real.code(a),
  async call({from,to,data}){
   if(delegated&&String(to).toLowerCase()===w){
    if(data===EIP712_DOMAIN_CALLDATA)return encodeFunctionResult({abi:CALIBUR_ABI,functionName:'eip712Domain',result:['0x0f','Calibur','1.0.0',8453n,to,caliburSalt(0n),[]]});
    if(data.startsWith(getSeqCalldata(0n).slice(0,10)))return toHex(0n,{size:32});
   }
   return real.call({from,to,data});
  },
  simulateCalls:({calls,stateOverrides,blockOverrides})=>real.simulateCalls({calls,blockOverrides,stateOverrides:overrides(stateOverrides)}),
  estimateGasAuth:async({from,to,data,authorizationList})=>BigInt(await json('eth_estimateGas',[{from,to,data,...(authorizationList?.length?{authorizationList:authorizationList.map(authJson)}:{})},'latest',overrides()])),
  broadcast:()=>{throw Error('dry run: no broadcast')},
 };
 const account='yeet-privy-operator-dry-run';
 const env={YEET_BASE_MODE:'7702',YEET_LIVE:'1',YEET_KILL_SWITCH:'0',YEET_LIVE_ACCOUNTS:account,YEET_BASE_GAS_WALLET:sender};
 const db=openTradeDb(':memory:'),logs=[];
 const batch=createBaseBatchDriver({db,rpc,env,now,log:(event,f)=>logs.push({event,...f}),loadWallet:()=>{throw Error('dry run: no gas wallet key')}});
 const tradeId='t_'+randomBytes(10).toString('hex');
 const deadline=new Date(now()+30*60_000).toISOString();
 const rows=Array.from({length:n},(_,idx)=>({trade_id:tradeId,idx,amount_in_raw:String(amountRaw),deposit_address:'0x'+randomBytes(20).toString('hex'),deposit_memo:null,live_quote_json:JSON.stringify({deadline})}));
 const trade={id:tradeId,account_id:account};
 const {createHash}=await import('node:crypto');
 const attemptId=createHash('sha256').update(`yeet-attempt:${tradeId}:0:1`).digest('hex');
 const req=await batch.prepare({trade,legs:rows,wallet:w,attemptId,attemptNo:1});
 const signReq={kind:'evm_7702',chain:'base',wallet:req.wallet,payload:req.payload,legs:req.legs,
  leg_summaries:rows.map(l=>({leg:l.idx,side:'buy',asset:'USDC',amount_raw:l.amount_in_raw,decimals:6,to:l.deposit_address}))};
 const signed=await sign7702(user,signReq);
 const r=await batch.submit({trade,legs:rows,wallet:w,attemptId,signed,dryRun:true});
 return {rpc:url,user_throwaway:w,gas_wallet:sender,legs:n,amount_raw:String(amountRaw),delegated,
  request:{kind:req.kind,legs:req.legs,authorization:req.payload.authorization,signed_chars:signed.length,payload_sha256:req.payloadSha256,
   executor:req.payload.typed_data.message.executor,deadline:req.payload.typed_data.message.deadline},
  state:r.state,blocked:r.blocked??[],simulation:r.simulation,
  preflight:logs.find(l=>l.state_to==='prepared')?{ok:true}:null};
}

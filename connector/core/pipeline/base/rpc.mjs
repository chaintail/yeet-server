// Base JSON-RPC adapter for the driver. Lifted from Folio apps/server/src/bridge/source-rpc.ts @70848f097
// (createSourceRpc: viem public client, retryCount 0, 15 s timeout; charge() reads l1Fee from the raw receipt; broadcast
// gated). Folio's CCTP, observer and log-paging reads are stripped. Constructing it reads no key and opens no
// connection. broadcast() re-reads the live gates from env on every call and refuses SOURCE_EXECUTION_DISABLED unless
// YEET_LIVE=1, YEET_KILL_SWITCH is off and YEET_BASE_PAUSE is off: a second lock behind the driver's own guards.
import {createPublicClient,http,parseAbi,TransactionReceiptNotFoundError,TransactionNotFoundError} from 'viem';
import {limitsFromEnv} from '../../trade/limits.mjs';
import {readBaseConfig,USDC_BASE,TRANSFER_TOPIC} from './config.mjs';
import {GAS_PRICE_ORACLE} from './fees.mjs';

const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const ORACLE=parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']);
const q=v=>'0x'+BigInt(v).toString(16);
/** viem SignedAuthorization -> the JSON-RPC authorizationList entry. */
const authJson=a=>({chainId:q(a.chainId),address:a.address,nonce:q(a.nonce),yParity:q(a.yParity),r:a.r,s:a.s});

export function broadcastAllowed(env){
 try{const l=limitsFromEnv(env);return l.live&&!l.killSwitch&&!readBaseConfig(env).paused}catch{return false}
}
export function createBaseRpc({url,env=process.env,fetchFn}={}){
 if(!url)throw Error('BASE_RPC_URL unset');
 const client=createPublicClient({transport:http(url,{retryCount:0,timeout:15_000,...(fetchFn?{fetchFn}:{})})});
 return {
  chainId:()=>client.getChainId(),
  nonce:(address,blockTag='pending')=>client.getTransactionCount({address,blockTag}),
  balance:(address,blockTag='latest')=>client.getBalance({address,blockTag}),
  code:async address=>(await client.getCode({address}))??'0x',
  tokenBalance:address=>client.readContract({address:USDC_BASE,abi:ERC20,functionName:'balanceOf',args:[address]}),
  call:async({from,to,data})=>(await client.call({account:from,to,data})).data??'0x',
  // Only the native balance is overridden, so a wallet holding no ETH yet can be estimated (Folio budget()).
  estimateGas:({from,to,data,value=0n})=>client.estimateGas({account:from,to,data,value,stateOverride:[{address:from,balance:10n**30n}]}),
  gasPrice:()=>client.getGasPrice(),
  l1FeeUpperBound:size=>client.readContract({address:GAS_PRICE_ORACLE,abi:ORACLE,functionName:'getL1FeeUpperBound',args:[BigInt(size)]}),
  async receipt(hash){
   let x;
   try{x=await client.getTransactionReceipt({hash})}
   catch(e){if(e instanceof TransactionReceiptNotFoundError)return null;throw e}
   const raw=await client.request({method:'eth_getTransactionReceipt',params:[hash]});
   if(raw?.l1Fee===undefined)throw Error('SOURCE_L1_FEE_MISSING');
   return {status:x.status,gasUsed:x.gasUsed,effectiveGasPrice:x.effectiveGasPrice,l1Fee:BigInt(raw.l1Fee),blockNumber:x.blockNumber,
    logs:x.logs.map(l=>({address:l.address,topics:l.topics,data:l.data}))};
  },
  async transaction(hash){
   let t;
   try{t=await client.getTransaction({hash})}
   catch(e){if(e instanceof TransactionNotFoundError)return null;throw e}
   return {from:t.from,to:t.to,value:t.value,input:t.input,nonce:t.nonce,blockNumber:t.blockNumber};
  },
  blockNumber:()=>client.getBlockNumber(),
  /** USDC Transfer(from, to) logs since `fromBlock` (review finding 1: a transfer the wallet sent outside our bytes). */
  async transferLogs({from,to,fromBlock}){
   const pad=a=>'0x'+String(a).toLowerCase().slice(2).padStart(64,'0');
   const logs=await client.request({method:'eth_getLogs',params:[{address:USDC_BASE,fromBlock:'0x'+BigInt(fromBlock).toString(16),toBlock:'latest',topics:[TRANSFER_TOPIC,pad(from),pad(to)]}]});
   return (logs??[]).map(l=>({address:l.address,topics:l.topics,data:l.data,transactionHash:String(l.transactionHash).toLowerCase(),blockNumber:BigInt(l.blockNumber)}));
  },
  /** eth_simulateV1 over `latest`, one block, validation off (batch-driver preflight and pre-send simulation). Each
   * call {from,to,data,gas?,authorizationList?}; answers [{ok, gasUsed, logs, revertData}]. An RPC without the method
   * throws (the batch path then falls back). */
  async simulateCalls({calls,stateOverrides,blockOverrides}){
   const block={calls:calls.map(c=>({from:c.from,to:c.to,data:c.data??'0x',gas:q(c.gas??3_000_000n),...(c.authorizationList?{authorizationList:c.authorizationList.map(authJson)}:{})}))};
   if(stateOverrides)block.stateOverrides=stateOverrides;
   if(blockOverrides)block.blockOverrides=blockOverrides;
   const r=await client.request({method:'eth_simulateV1',params:[{blockStateCalls:[block],validation:false},'latest']});
   const out=r?.[0]?.calls;
   if(!Array.isArray(out)||out.length!==calls.length)throw Error('eth_simulateV1: unexpected answer');
   return out.map(c=>({ok:c.status==='0x1',gasUsed:BigInt(c.gasUsed??0),logs:(c.logs??[]).map(l=>({address:l.address,topics:l.topics,data:l.data})),
    revertData:c.status==='0x1'?null:(c.returnData&&c.returnData!=='0x'?c.returnData:c.error?.data??null)}));
  },
  /** eth_estimateGas with an authorization list (type 4) or without (type 2); the sender's balance is overridden. */
  estimateGasAuth:async({from,to,data,authorizationList})=>BigInt(await client.request({method:'eth_estimateGas',
   params:[{from,to,data,...(authorizationList?.length?{authorizationList:authorizationList.map(authJson)}:{})},'latest',{[from]:{balance:q(10n**30n)}}]})),
  broadcast(serializedTransaction){
   if(!broadcastAllowed(env))throw Error('SOURCE_EXECUTION_DISABLED');
   return client.sendRawTransaction({serializedTransaction});
  },
 };
}

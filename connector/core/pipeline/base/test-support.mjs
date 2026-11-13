// Test fixtures for the Base driver: an in-memory JSON-RPC double, throwaway keys and a trade/leg shaped like the rows in
// trade/db.mjs. No network, no real funds: every key here is generated per test run and discarded.
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keccak256,parseTransaction,recoverTransactionAddress,toHex,toFunctionSelector,recoverTypedDataAddress,encodeFunctionResult} from 'viem';
import {recoverAuthorizationAddress} from 'viem/utils';
import {CALIBUR,CALIBUR_ABI,ZERO_ADDRESS,delegationCode,decodeExecuteCalldata,batchTypedData,getSeqCalldata,caliburSalt,EIP712_DOMAIN_CALLDATA} from './calibur-7702.mjs';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openTradeDb} from '../../trade/db.mjs';
import {USDC_BASE,TRANSFER_TOPIC} from './config.mjs';
import {createBaseDriver,attemptIdFor} from './driver.mjs';
import {txFromPayload} from './source-executor.mjs';
import {createBaseBatchDriver} from './batch-driver.mjs';
import {privyRpcBodies,signedFromWallets} from '../wallet-request.mjs';
import {typedDataForSigning} from './calibur-7702.mjs';

export const T0=Date.parse('2026-11-13T10:00:00Z');
export const ACCOUNT='yeet-privy-test1';
export const DEPOSIT='0x1111111111111111111111111111111111111111';
const pad=a=>'0x'+a.slice(2).toLowerCase().padStart(64,'0');

export function fakeRpc(o={}){
 const s={latest:{},pending:{},balance:{},token:{},code:{},gasPrice:5_000_000n,l1:50_000_000_000n,estimate:60_000n,
  call:'0x'+'0'.repeat(63)+'1',receipts:new Map(),txs:new Map(),broadcasts:[],broadcastError:null,hooks:{},...o};
 const k=a=>String(a).toLowerCase();
 return {s,
  async nonce(a,tag='pending'){s.hooks.nonce?.(k(a),tag);return tag==='latest'?(s.latest[k(a)]??0):(s.pending[k(a)]??s.latest[k(a)]??0)},
  async balance(a){s.hooks.balance?.(k(a));return s.balance[k(a)]??0n},
  async code(a){return s.code[k(a)]??'0x'},
  async tokenBalance(a){return s.token[k(a)]??0n},
  async call({to,data}={}){
   const t=k(to);
   if(k(s.code[t]??'0x')===k(delegationCode(CALIBUR))&&data){
    if(s.readError)throw Error(s.readError);
    if(data===EIP712_DOMAIN_CALLDATA)return encodeFunctionResult({abi:CALIBUR_ABI,functionName:'eip712Domain',
     result:['0x0f',s.domainName??'Calibur','1.0.0',BigInt(s.domainChainId??8453),to,caliburSalt(BigInt((s.saltPrefix??{})[t]??0n)),[]]});
    if(data.startsWith(getSeqCalldata(0n).slice(0,10)))return toHex((s.seq??new Map()).get(`${t}:${BigInt('0x'+data.slice(10))}`)??0n,{size:32});
   }
   if(s.callError)throw Error('execution reverted');return s.call},
  async estimateGas(){if(s.estimateError)throw Error('estimate failed');return s.estimate},
  async gasPrice(){return s.gasPrice},
  async l1FeeUpperBound(){return s.l1},
  async receipt(h){return s.receipts.get(h)??null},
  async transaction(h){return s.txs.get(h)??null},
  async broadcast(bytes){s.broadcasts.push(bytes);if(s.broadcastError)throw Error(s.broadcastError);return keccak256(bytes)},
  async blockNumber(){return s.block??100n},
  async transferLogs({from,to,fromBlock}){
   if(s.logsError)throw Error(s.logsError);
   return [...s.receipts.entries()].flatMap(([h,r])=>(r.logs??[]).map(l=>({...l,transactionHash:h,blockNumber:r.blockNumber??1n})))
    .filter(l=>l.blockNumber>=fromBlock&&l.topics?.[1]===pad(from)&&l.topics?.[2]===pad(to));
  },
  // EIP-7702 / Calibur model for the batch driver (calibur-7702.mjs facts): getSeq, eip712Domain, eth_simulateV1 and
  // eth_estimateGas of execute(), with authorizations processed first (a stale nonce is skipped, not an error).
  async simulateCalls({calls,stateOverrides={}}){
   s.hooks.simulate?.(calls);
   if(s.simulateError)throw Error(s.simulateError);
   const st=forkState(s,stateOverrides);
   const out=[];for(const c of calls)out.push(await plainCall(st,c));
   return out;
  },
  async estimateGasAuth(c){if(s.estimateError)throw Error('estimate failed');const r=await caliburCall(forkState(s,{}),c);return r.gasUsed+21_000n},
 };
}
const ROOT_SALT_PREFIX=0n,SEQ_MASK=(1n<<64n)-1n;
const USDC=USDC_BASE.toLowerCase();
/** A copy of the chain state a simulation may change (overrides applied), or the live state for `mine`. */
function forkState(s,overrides){
 const st={token:{...s.token},code:{...s.code},latest:{...s.latest},seq:new Map(s.seq??[]),saltPrefix:{...(s.saltPrefix??{})},time:s.now?Math.floor(s.now()/1000):Math.floor(T0/1000),live:false};
 for(const [a,o] of Object.entries(overrides)){if(o.code!==undefined)st.code[a.toLowerCase()]=o.code}
 return st;
}
function liveState(s){
 s.seq??=new Map();s.saltPrefix??={};
 return {token:s.token,code:s.code,latest:s.latest,seq:s.seq,saltPrefix:s.saltPrefix,time:s.now?Math.floor(s.now()/1000):Math.floor(T0/1000),live:true};
}
const revert=(name,gas=30_000n)=>({ok:false,gasUsed:gas,logs:[],revertData:toFunctionSelector(`${name}()`)});
/** One call against the model: authorizations, then the EOA's code (Calibur or none), then execute(). */
export async function caliburCall(st,{from,to,data='0x',authorizationList}){
 const k=a=>String(a).toLowerCase(),user=k(to);
 let gas=21_000n;
 for(const a of authorizationList??[]){
  gas+=25_000n;
  if(a.chainId!==8453&&a.chainId!==0)continue;
  let who;try{who=k(await recoverAuthorizationAddress({authorization:a}))}catch{continue}
  if((st.latest[who]??0)!==a.nonce)continue;// stale: skipped, the transaction still runs
  st.latest[who]=(st.latest[who]??0)+1;
  st.code[who]=k(a.address)===k(ZERO_ADDRESS)?'0x':delegationCode(a.address);
 }
 const code=k(st.code[user]??'0x');
 if(code!==k(delegationCode(CALIBUR)))return {ok:true,gasUsed:gas,logs:[],revertData:null};// a call to a plain EOA does nothing
 if(data==='0x')return {ok:true,gasUsed:gas,logs:[],revertData:null};
 // getSeq / eip712Domain reads.
 if(data.startsWith(getSeqCalldata(0n).slice(0,10)))return {ok:true,gasUsed:gas,logs:[],revertData:null,returnData:toHex(st.seq.get(`${user}:${BigInt('0x'+data.slice(10))}`)??0n,{size:32})};
 let x;try{x=decodeExecuteCalldata(data)}catch{return revert('InvalidSignatureLength')}
 const {batch,signature}=x;
 if(k(batch.executor)!==k(ZERO_ADDRESS)&&k(batch.executor)!==k(from))return revert('Unauthorized');
 if(batch.deadline!==0n&&batch.deadline<BigInt(st.time))return revert('SignatureExpired');
 const key=`${user}:${batch.nonce>>64n}`,seq=batch.nonce&SEQ_MASK;
 if((st.seq.get(key)??0n)!==seq)return revert('InvalidNonce');
 let signer;try{signer=k(await recoverTypedDataAddress({...batchTypedData(user,batch,{saltPrefix:st.saltPrefix[user]??ROOT_SALT_PREFIX}),signature}))}catch{signer=null}
 if(signer!==user)return revert('InvalidSignature');
 const token={...st.token},logs=[];
 for(const c of batch.batchedCall.calls){
  const d=/^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(k(c.data));
  if(k(c.to)!==USDC||!d)return revert('CallFailed');
  const amt=BigInt('0x'+d[2]),rec='0x'+d[1];
  if((token[user]??0n)<amt)return revert('CallFailed');
  token[user]-=amt;token[rec]=(token[rec]??0n)+amt;
  logs.push({address:USDC_BASE,topics:[TRANSFER_TOPIC,pad(user),pad(rec)],data:toHex(amt,{size:32})});
  gas+=30_000n;
 }
 Object.assign(st.token,token);st.seq.set(key,seq+1n);
 return {ok:true,gasUsed:gas+20_000n,logs,revertData:null};
}
/** USDC transfers from the wallet itself (the batch preflight), modelled with the same balances. */
async function plainCall(st,c){
 const d=/^0xa9059cbb0{24}([0-9a-f]{40})([0-9a-f]{64})$/.exec(String(c.data??'').toLowerCase());
 if(String(c.to).toLowerCase()!==USDC||!d)return caliburCall(st,c);
 const from=String(c.from).toLowerCase(),amt=BigInt('0x'+d[2]),rec='0x'+d[1];
 if((st.token[from]??0n)<amt)return {ok:false,gasUsed:30_000n,logs:[],revertData:'0x08c379a0'};
 st.token[from]-=amt;st.token[rec]=(st.token[rec]??0n)+amt;
 return {ok:true,gasUsed:35_000n,logs:[{address:USDC_BASE,topics:[TRANSFER_TOPIC,pad(from),pad(rec)],data:toHex(amt,{size:32})}],revertData:null};
}

/** Mines a broadcast transaction in the double: receipt, nonce, ETH value, and a USDC Transfer log for a transfer. */
export async function mine(rpc,bytes,{success=true,logs,gasUsed=50_000n,price=5_000_000n,l1Fee=1_000_000_000n}={}){
 const p=parseTransaction(bytes),from=(await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase(),h=keccak256(bytes),s=rpc.s;
 const to=p.to.toLowerCase();
 // A 7702 batch (type 4, or type 2 to a delegated wallet with calldata): the Calibur model decides logs and status.
 if(p.type==='eip7702'||(p.data&&p.data!=='0x'&&String(s.code[to]??'0x').toLowerCase()===delegationCode(CALIBUR))){
  s.latest[from]=Math.max(s.latest[from]??0,p.nonce+1);
  const r=await caliburCall(liveState(s),{from,to,data:p.data??'0x',authorizationList:p.authorizationList});
  const ok=success&&r.ok,block=s.block??100n;
  s.receipts.set(h,{status:ok?'success':'reverted',gasUsed:r.gasUsed,effectiveGasPrice:price,l1Fee,logs:logs??(ok?r.logs:[]),blockNumber:block});
  s.txs.set(h,{from,to,value:0n,input:p.data??'0x',nonce:p.nonce,blockNumber:block});
  return h;
 }
 s.latest[from]=Math.max(s.latest[from]??0,p.nonce+1);
 if(success&&p.value)s.balance[to]=(s.balance[to]??0n)+p.value;
 let out=logs;
 if(out===undefined&&success&&to===USDC_BASE.toLowerCase()){
  const rec='0x'+p.data.slice(34,74),amt=BigInt('0x'+p.data.slice(74));
  out=[{address:USDC_BASE,topics:[TRANSFER_TOPIC,pad(from),pad(rec)],data:'0x'+amt.toString(16).padStart(64,'0')}];
 }
 const block=s.block??100n;
 s.receipts.set(h,{status:success?'success':'reverted',gasUsed,effectiveGasPrice:price,l1Fee,logs:out??[],blockNumber:block});
 s.txs.set(h,{from,to,value:p.value??0n,input:p.data??'0x',nonce:p.nonce,blockNumber:block});
 return h;
}

export function keyFile(key=generatePrivateKey(),mode=0o600){
 const dir=mkdtempSync(path.join(os.tmpdir(),'yeet-base-test-')),file=path.join(dir,'gas.key');
 writeFileSync(file,key+'\n',{mode});chmodSync(file,mode);
 return {file,address:privateKeyToAccount(key).address.toLowerCase(),dir};
}

/** A ready world: driver, rpc double, user key, gas wallet key file, env with the live gates open. */
export function world({env:extra={},rpc:rpcOpts={},now=T0,user=generatePrivateKey(),db=openTradeDb(':memory:'),...opts}={}){
 const gas=keyFile(),userAccount=privateKeyToAccount(user),wallet=userAccount.address.toLowerCase();
 const env={YEET_LIVE:'1',YEET_KILL_SWITCH:'0',YEET_LIVE_ACCOUNTS:ACCOUNT,YEET_BASE_GAS_WALLET:gas.address,
  YEET_BASE_GAS_WALLET_KEY_FILE:gas.file,BASE_RPC_URL:'http://fake.invalid',...extra};
 const rpc=fakeRpc(rpcOpts);
 rpc.s.balance[gas.address]??=2_000_000_000_000_000n;
 rpc.s.now??=()=>clock.t;
 rpc.s.token[wallet]??=20_000_000n;
 const alerts=[],logs=[],clock={t:now};
 const driver=createBaseDriver({db,rpc,env,now:()=>clock.t,alert:a=>alerts.push(a),log:(event,fields)=>logs.push({event,...fields}),...opts});
 return {db,rpc,env,driver,gas,wallet,userAccount,alerts,logs,clock};
}

export function tradeLeg({tradeId='t_aaaaaaaaaaaaaaaaaaaa',account=ACCOUNT,idx=0,amount='5000000',deposit=DEPOSIT,deadline=T0+30*60_000}={}){
 return {trade:{id:tradeId,account_id:account},
  leg:{trade_id:tradeId,idx,amount_in_raw:amount,deposit_address:deposit,live_quote_json:JSON.stringify({deadline:new Date(deadline).toISOString()})}};
}

/** Prepares, signs with the user's key and returns everything a submit needs. */
export async function preparedAndSigned(w,o={}){
 const {trade,leg}=tradeLeg(o),attemptId=attemptIdFor(trade.id,leg.idx,o.n??0);
 const req=await w.driver.prepare({trade,leg,wallet:w.wallet,attemptId,attemptNo:o.n??0,now:w.clock.t});
 const signed=await w.userAccount.signTransaction(txFromPayload(req.payload));
 return {trade,leg,attemptId,req,signed,args:{trade,leg,wallet:w.wallet,attemptId,signed}};
}

// 7702 batch fixtures (batch-driver.test.mjs).
/** world() with YEET_BASE_MODE=7702 and the batch driver on the same database, rpc and clock. */
export function batchWorld(o={}){
 const w=world({...o,env:{YEET_BASE_MODE:'7702',...(o.env??{})}});
 const batch=createBaseBatchDriver({db:w.db,rpc:w.rpc,env:w.env,now:()=>w.clock.t,alert:a=>w.alerts.push(a),log:(event,fields)=>w.logs.push({event,...fields}),...(o.batchOpts??{})});
 return {...w,batch};
}
/** A basket of `n` legs as trade_legs rows, each with its own deposit address. */
export function basket({tradeId='t_bbbbbbbbbbbbbbbbbbbb',account=ACCOUNT,n=2,amount='5000000',deadline=T0+30*60_000,memo=null}={}){
 const legs=Array.from({length:n},(_,idx)=>({trade_id:tradeId,idx,amount_in_raw:amount,deposit_address:'0x'+String(idx+2).repeat(40).slice(0,40),deposit_memo:idx===0?memo:null,
  live_quote_json:JSON.stringify({deadline:new Date(deadline).toISOString()})}));
 return {trade:{id:tradeId,account_id:account},legs};
}
/** The contract-shaped sign request of a batch-driver prepare answer (leg_summaries for checkBatch). */
export const asSignRequest=(req,legs)=>({kind:'evm_7702',chain:'base',wallet:req.wallet,payload:req.payload,
 legs:req.legs,leg_summaries:legs.map(l=>({leg:l.idx,side:'buy',asset:'USDC',amount_raw:l.amount_in_raw,decimals:6,to:l.deposit_address}))});
/** What the card does with the person's key: the wallet calls in order, joined by signedFromWallets. `tamper` edits
 * the typed data or the authorization request before signing (negative tests). */
export async function signBatch(account,req,legs,{tamper}={}){
 const r=asSignRequest(req,legs),answers=[];
 for(const body of privyRpcBodies(r)){
  if(body.method==='eth_sign7702Authorization'){
   const p={...body.params,...(tamper?.authorization??{})};
   const a=await account.signAuthorization({chainId:p.chain_id,contractAddress:p.contract,nonce:p.nonce});
   answers.push({data:{authorization:{...body.params,r:a.r,s:a.s,y_parity:a.yParity}}});
  }else{
   const td=typedDataForSigning(body.params.typed_data);
   answers.push({data:{signature:await account.signTypedData(tamper?.typed?tamper.typed(td):td)}});
  }
 }
 return signedFromWallets(r,answers);
}
/** Prepares a basket with the batch driver and signs it as the card would. */
export async function batchPrepared(w,o={}){
 const {trade,legs}=basket(o),attemptNo=o.attemptNo??1,attemptId=attemptIdFor(trade.id,legs[0].idx,attemptNo);
 const req=await w.batch.prepare({trade,legs,wallet:w.wallet,attemptId,attemptNo,now:w.clock.t});
 const signed=await signBatch(w.userAccount,req,legs,o);
 return {trade,legs,attemptId,req,signed,args:{trade,legs,wallet:w.wallet,attemptId,signed}};
}
/** Marks the wallet Calibur-delegated in the double (what a landed first batch leaves). */
export const delegate=(rpc,wallet)=>{rpc.s.code[String(wallet).toLowerCase()]=delegationCode(CALIBUR)};

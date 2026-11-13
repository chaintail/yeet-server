// Test fixtures for the Base driver: an in-memory JSON-RPC double, throwaway keys and a trade/leg shaped like the rows in
// trade/db.mjs. No network, no real funds: every key here is generated per test run and discarded.
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keccak256,parseTransaction,recoverTransactionAddress} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openTradeDb} from '../../trade/db.mjs';
import {USDC_BASE,TRANSFER_TOPIC} from './config.mjs';
import {createBaseDriver,attemptIdFor} from './driver.mjs';
import {txFromPayload} from './source-executor.mjs';

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
  async call(){if(s.callError)throw Error('execution reverted');return s.call},
  async estimateGas(){if(s.estimateError)throw Error('estimate failed');return s.estimate},
  async gasPrice(){return s.gasPrice},
  async l1FeeUpperBound(){return s.l1},
  async receipt(h){return s.receipts.get(h)??null},
  async transaction(h){return s.txs.get(h)??null},
  async broadcast(bytes){s.broadcasts.push(bytes);if(s.broadcastError)throw Error(s.broadcastError);return keccak256(bytes)},
 };
}

/** Mines a broadcast transaction in the double: receipt, nonce, ETH value, and a USDC Transfer log for a transfer. */
export async function mine(rpc,bytes,{success=true,logs,gasUsed=50_000n,price=5_000_000n,l1Fee=1_000_000_000n}={}){
 const p=parseTransaction(bytes),from=(await recoverTransactionAddress({serializedTransaction:bytes})).toLowerCase(),h=keccak256(bytes),s=rpc.s;
 const to=p.to.toLowerCase();
 s.latest[from]=Math.max(s.latest[from]??0,p.nonce+1);
 if(success&&p.value)s.balance[to]=(s.balance[to]??0n)+p.value;
 let out=logs;
 if(out===undefined&&success&&to===USDC_BASE.toLowerCase()){
  const rec='0x'+p.data.slice(34,74),amt=BigInt('0x'+p.data.slice(74));
  out=[{address:USDC_BASE,topics:[TRANSFER_TOPIC,pad(from),pad(rec)],data:'0x'+amt.toString(16).padStart(64,'0')}];
 }
 s.receipts.set(h,{status:success?'success':'reverted',gasUsed,effectiveGasPrice:price,l1Fee,logs:out??[],blockNumber:1n});
 s.txs.set(h,{from,to,value:p.value??0n,input:p.data??'0x',nonce:p.nonce,blockNumber:1n});
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

#!/usr/bin/env node
// Read-only Base mainnet simulation of a user-signed BUY (GAS-SPONSORSHIP-DESIGN.md 5.2). No key is read, nothing is
// signed, nothing is broadcast: only eth_chainId, eth_call, eth_estimateGas, eth_gasPrice, eth_getBalance and
// eth_getCode, through the same fee code the driver uses.
//   node ops/base-sim.mjs --from <user wallet> [--to <deposit address>] [--usdc 5] [--gas-wallet <address>] [--rpc <url>]
// --to defaults to a random unused address (a fresh 1Click deposit address costs the same storage write).
// --rpc defaults to $BASE_RPC_URL, then https://mainnet.base.org.
import {randomBytes} from 'node:crypto';
import {createBaseRpc} from '../connector/core/pipeline/base/rpc.mjs';
import {quoteTransfer,quoteTopup} from '../connector/core/pipeline/base/fees.mjs';
import {transferData} from '../connector/core/pipeline/base/source-executor.mjs';
import {readBaseConfig,BASE_CHAIN_ID,USDC_BASE,MAX_USER_GAS,TOPUP_GAS} from '../connector/core/pipeline/base/config.mjs';

const arg=name=>{const i=process.argv.indexOf(`--${name}`);return i>0?process.argv[i+1]:undefined};
const ADDR=/^0x[0-9a-fA-F]{40}$/;
const from=String(arg('from')??'').toLowerCase(),to=String(arg('to')??'0x'+randomBytes(20).toString('hex')).toLowerCase();
const usdc=String(arg('usdc')??'5');
if(!ADDR.test(from)||!ADDR.test(to)||!/^\d+(\.\d{1,6})?$/.test(usdc)){console.error('usage: --from <0x..> [--to <0x..>] [--usdc 5] [--gas-wallet <0x..>] [--rpc <url>]');process.exit(2)}
const [w,f='']=usdc.split('.'),amount=BigInt(w)*1_000_000n+BigInt(f.padEnd(6,'0'));
const cfg=readBaseConfig({...process.env,YEET_BASE_GAS_WALLET:arg('gas-wallet')??process.env.YEET_BASE_GAS_WALLET??''});
const url=arg('rpc')||cfg.rpcUrl||'https://mainnet.base.org';
// env {} keeps the adapter's broadcast gate closed for this process whatever the shell exports.
const rpc=createBaseRpc({url,env:{}});
const out={chain_id:null,from,to,amount_raw:String(amount)};
const step=async(name,fn)=>{try{out[name]=await fn()}catch(e){out[name]={error:String(e?.shortMessage??e?.message??e).slice(0,160)}}};
await step('chain_id',async()=>{const id=await rpc.chainId();if(id!==BASE_CHAIN_ID)throw Error(`chain ${id}`);return id});
await step('usdc_balance_raw',async()=>String(await rpc.tokenBalance(from)));
await step('wallet_eth_raw',async()=>String(await rpc.balance(from,'latest')));
await step('wallet_has_code',async()=>(await rpc.code(from))!=='0x');
const data=transferData(to,amount);
await step('transfer_call_true',async()=>/^0x0{63}1$/.test(await rpc.call({from,to:USDC_BASE,data})));
await step('transfer_quote',async()=>{const q=await quoteTransfer(rpc,{wallet:from,data,capWei:cfg.maxFeeWei,maxGas:MAX_USER_GAS});
 return {gas:String(q.gas),max_fee_per_gas:String(q.maxFeePerGas),priority_fee:String(q.maxPriorityFeePerGas),l1_fee_upper_bound:String(q.l1Fee),needed_wei:String(q.needed)}});
await step('topup_gas_estimate',async()=>String(await rpc.estimateGas({from:cfg.gasWallet??from,to:from,data:'0x',value:1n})));
await step('topup_quote',async()=>{const q=await quoteTopup(rpc,{capWei:cfg.maxFeeWei});return {gas:String(q.gas),fee_wei:String(q.fee)}});
if(out.transfer_quote?.needed_wei&&out.topup_quote?.fee_wei&&typeof out.wallet_eth_raw==='string'){
 const needed=BigInt(out.transfer_quote.needed_wei),shortfall=needed-BigInt(out.wallet_eth_raw),fee=BigInt(out.topup_quote.fee_wei);
 const margin=(needed+3n)/4n>2n*TOPUP_GAS*BigInt(out.transfer_quote.max_fee_per_gas)?(needed+3n)/4n:2n*TOPUP_GAS*BigInt(out.transfer_quote.max_fee_per_gas);
 out.topup_plan=shortfall>0n?{shortfall_wei:String(shortfall),amount_wei:String(shortfall+margin),our_cost_wei:String(shortfall+margin+fee)}:{shortfall_wei:'0'};
}
if(cfg.gasWallet)await step('gas_wallet_eth_raw',async()=>String(await rpc.balance(cfg.gasWallet,'latest')));
console.log(JSON.stringify(out));

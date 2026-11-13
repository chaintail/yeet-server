// What one self-paid USDC transfer on Base costs right now (ops/first-trade.mjs --plan, YEET_BASE_GAS=self). In self-gas
// mode the engine sends eth_sendTransaction with sponsor:false and no gas fields (signer-privy.mjs); Privy fills gas
// limit, fee values, nonce and type (docs.privy.io eth_sendTransaction: the unsponsored answer's transaction_request is
// type 2 with max_fee_per_gas, max_priority_fee_per_gas and gas_limit). Base is an OP Stack chain: the fee is L2
// execution (gas used x gas price) plus the L1 data fee, read from the GasPriceOracle predeploy.
//   readBaseGasCost({rpcUrl, from, amountRaw})  three read-only JSON-RPC calls (eth_gasPrice, eth_estimateGas of the
//     transfer, GasPriceOracle.getL1FeeUpperBound) -> {gasLimit, gasPriceWei, l1FeeWei, estimated}
//   selfGasCheck({balanceWei, gasLimit, gasPriceWei, l1FeeWei, margin, ethUsd}) -> cost, needed (x margin), covered
import {USDC_BASE,erc20TransferData} from './signer.mjs';

export const GAS_PRICE_ORACLE='0x420000000000000000000000000000000000000F';
const L1_FEE_UPPER_BOUND='0xf1c7a58b';// getL1FeeUpperBound(uint256)
/** An EIP-1559 USDC transfer is ~110 bytes unsigned; the bound uses this size. */
export const TRANSFER_TX_BYTES=110;
/** Used when eth_estimateGas is refused: a USDC transfer to an address that holds no USDC yet uses about 62k gas. */
export const FALLBACK_TRANSFER_GAS=65_000n;
export const SELF_GAS_MARGIN=3n;
const QTY=/^0x[0-9a-fA-F]{1,64}$/;

export async function readBaseGasCost({rpcUrl,from,to,amountRaw,fetch=globalThis.fetch,timeoutMs=8000}){
 const call=[
  {jsonrpc:'2.0',id:1,method:'eth_gasPrice',params:[]},
  {jsonrpc:'2.0',id:2,method:'eth_estimateGas',params:[{from,to:USDC_BASE,data:erc20TransferData(to??from,amountRaw),value:'0x0'}]},
  {jsonrpc:'2.0',id:3,method:'eth_call',params:[{to:GAS_PRICE_ORACLE,data:L1_FEE_UPPER_BOUND+TRANSFER_TX_BYTES.toString(16).padStart(64,'0')},'latest']},
 ];
 const res=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(call),signal:AbortSignal.timeout(timeoutMs)});
 const list=await res.json();
 if(!Array.isArray(list))throw Error('Base RPC: no batch answer');
 const by=id=>list.find(r=>r?.id===id);
 const qty=r=>typeof r?.result==='string'&&QTY.test(r.result)?BigInt(r.result):null;
 const gasPriceWei=qty(by(1));
 if(gasPriceWei===null)throw Error('Base RPC: eth_gasPrice unreadable');
 const est=qty(by(2)),l1=by(3)?.result;
 const l1FeeWei=typeof l1==='string'&&/^0x[0-9a-fA-F]{1,64}$/.test(l1)?BigInt(l1):null;
 return {gasLimit:est??FALLBACK_TRANSFER_GAS,estimated:est!==null,gasPriceWei,l1FeeWei:l1FeeWei??0n,l1Known:l1FeeWei!==null};
}

const eth=wei=>{const s=wei.toString().padStart(19,'0');return `${s.slice(0,-18)}.${s.slice(-18)}`.replace(/\.?0+$/,'')||'0'};
const usdOf=(wei,ethUsd)=>typeof ethUsd==='number'&&Number.isFinite(ethUsd)?(Number(wei)/1e18*ethUsd):null;

/** cost = gasLimit x gasPrice + L1 fee; needed = cost x margin; covered when the balance is at least that. */
export function selfGasCheck({balanceWei,gasLimit,gasPriceWei,l1FeeWei=0n,margin=SELF_GAS_MARGIN,ethUsd}){
 const costWei=BigInt(gasLimit)*BigInt(gasPriceWei)+BigInt(l1FeeWei),neededWei=costWei*BigInt(margin);
 const u=usdOf(neededWei,ethUsd),c=usdOf(costWei,ethUsd);
 return {costWei,neededWei,balanceWei:BigInt(balanceWei),covered:BigInt(balanceWei)>=neededWei,margin:Number(margin),
  cost_eth:eth(costWei),needed_eth:eth(neededWei),balance_eth:eth(BigInt(balanceWei)),
  cost_usd:c===null?null:c.toFixed(6),needed_usd:u===null?null:u.toFixed(6)};
}

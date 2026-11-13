// Fee reads for the user's USDC transfer and our 21000-gas top-up on Base (an OP Stack chain: L2 execution plus the
// L1 data fee from the GasPriceOracle predeploy).
// From YEET trade/base-gas.mjs (getL1FeeUpperBound, TRANSFER_TX_BYTES) and Folio @70848f097
// apps/server/src/bridge/source-service.ts:94-115 (topupFees, replacementFees: F10) and source-rpc.ts budget() (2x gas
// price). YEET changes: both fee values are clamped to YEET_BASE_MAX_FEE_WEI (guard 7), and the user's transfer gets
// the same non-zero tip as a top-up because we cannot re-price a transaction the user signed.
import {refuse} from '../../trade/util.mjs';
import {USDC_BASE,TOPUP_GAS} from './config.mjs';

export const GAS_PRICE_ORACLE='0x420000000000000000000000000000000000000F';
/** An EIP-1559 USDC transfer is about 110 bytes unsigned; the upper bound is read for this size (a top-up is smaller). */
export const TRANSFER_TX_BYTES=110;
export const TOPUP_REPLACEMENT_BUMP=Object.freeze({num:1125n,den:1000n});
export const TOPUP_MIN_PRIORITY_FEE_WEI=1_000_000n;
const maxBig=(...v)=>v.reduce((m,x)=>x>m?x:m);

/** F10: a non-zero tip on a fee read, bounded by its maxFeePerGas (raised to the tip only when the read was 0). */
export function topupFees(b){
 const floor=TOPUP_MIN_PRIORITY_FEE_WEI<b.maxFeePerGas?TOPUP_MIN_PRIORITY_FEE_WEI:b.maxFeePerGas;
 const tip=maxBig(b.maxPriorityFeePerGas,floor,1n);
 return {...b,maxPriorityFeePerGas:tip,maxFeePerGas:maxBig(b.maxFeePerGas,tip)};
}
/** F10: each previous fee raised by TOPUP_REPLACEMENT_BUMP (rounded up), or the fresh read if higher. */
export function replacementFees(prior,fresh){
 const bump=v=>(v*TOPUP_REPLACEMENT_BUMP.num+TOPUP_REPLACEMENT_BUMP.den-1n)/TOPUP_REPLACEMENT_BUMP.den;
 const tip=maxBig(bump(prior.maxPriorityFeePerGas),fresh.maxPriorityFeePerGas,1n);
 return {maxPriorityFeePerGas:tip,maxFeePerGas:maxBig(bump(prior.maxFeePerGas),fresh.maxFeePerGas,tip)};
}
/** 2x the current gas price, clamped to the cap; refused when the price itself is above the cap. */
export async function readFees(rpc,capWei){
 const price=BigInt(await rpc.gasPrice());
 if(price<=0n||price>capWei)refuse('INVALID_TRANSACTION_BUDGET','gas price above YEET_BASE_MAX_FEE_WEI');
 return topupFees({maxFeePerGas:price*2n>capWei?capWei:price*2n,maxPriorityFeePerGas:0n});
}
/** The user's transfer: estimate +25% (unused gas is not charged), fees, L1 upper bound; needed = gas x maxFee + L1. */
export async function quoteTransfer(rpc,{wallet,data,capWei,maxGas}){
 let est;
 try{est=BigInt(await rpc.estimateGas({from:wallet,to:USDC_BASE,data,value:0n}))}
 catch(e){refuse('SIMULATION_FAILED',`estimateGas: ${String(e?.message??e).slice(0,120)}`)}
 const gas=est+(est+3n)/4n;
 if(est<=0n||gas>maxGas)refuse('INVALID_TRANSACTION_BUDGET',`gas ${gas}`);
 const fees=await readFees(rpc,capWei),l1Fee=BigInt(await rpc.l1FeeUpperBound(TRANSFER_TX_BYTES));
 return {gas,...fees,l1Fee,needed:gas*fees.maxFeePerGas+l1Fee};
}
/** The top-up: exactly 21000 gas (the user wallet has no code, guard 5), fees, L1 upper bound; fee = what it costs us. */
export async function quoteTopup(rpc,{capWei}){
 const fees=await readFees(rpc,capWei),l1Fee=BigInt(await rpc.l1FeeUpperBound(TRANSFER_TX_BYTES));
 return {gas:TOPUP_GAS,...fees,l1Fee,fee:TOPUP_GAS*fees.maxFeePerGas+l1Fee};
}

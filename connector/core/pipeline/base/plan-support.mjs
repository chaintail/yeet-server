// Read-only helpers for ops/gas-e2e.mjs --plan (ops/ resolves no bare packages, so viem is used from here).
import {keccak256,encodeAbiParameters} from 'viem';
import {USDC_BASE} from './config.mjs';

/** FiatToken v2.2 keeps balances in the mapping at slot 9. */
export const USDC_BALANCE_SLOT=9n;
/** An eth_call state override giving `address` `amountRaw` USDC and 1 ETH, for simulating an unfunded wallet. */
export function usdcBalanceOverride(address,amountRaw){
 const a=String(address).toLowerCase();
 const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[a,USDC_BALANCE_SLOT]));
 return {[USDC_BASE]:{stateDiff:{[slot]:'0x'+BigInt(amountRaw).toString(16).padStart(64,'0')}},[a]:{balance:'0x'+(10n**18n).toString(16)}};
}

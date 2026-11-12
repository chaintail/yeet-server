#!/usr/bin/env node
// Prints (never sends) the Privy policy for the YEET signer on a person's Base wallet: USDC `transfer` only, on Base
// only, no ETH value, at most --max-trade USDC per transaction and --daily USDC per rolling 24 h.
//
//   node core/trade/policy-create.mjs [--max-trade 25] [--daily 50] [--name yeet-usdc-transfer-base]
//
// Copied from Folio evm-sweep-policy.ts: {version:'1.0', name, chain_type:'ethereum', rules:[{name, method, action,
// conditions}]}, conditions {field_source:'ethereum_transaction'|'ethereum_calldata', field, operator, value, abi},
// string values for chain_id and value, the USDC address, and leaving out any catch-all DENY (Privy denies what no
// rule allows). From the plan and Privy's policy docs, not exercised by Folio: the `lte` amount condition, the
// eth_sendTransaction rule next to eth_signTransaction, and the stateful 24 h aggregation (field_source 'reference').
// Create it with the owner's tooling (POST /v1/policies), then put the id in YEET_BASE_POLICY_ID.
import {parseUnits} from './router.mjs';
import {USDC_BASE,BASE_CHAIN_ID} from './signer.mjs';
import {pathToFileURL} from 'node:url';

export const ERC20_TRANSFER_ABI=[{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]}];

export function basePolicy({maxTradeUsdc='25',dailyUsdc='50',name='yeet-usdc-transfer-base'}={}){
 const cap=parseUnits(maxTradeUsdc,6).toString(),daily=parseUnits(dailyUsdc,6).toString();
 if(name.length>=50)throw Error('rule and policy names must be under 50 characters');
 const tx=(field,operator,value)=>({field_source:'ethereum_transaction',field,operator,value});
 const data=(field,operator,value)=>({field_source:'ethereum_calldata',field,operator,value,abi:ERC20_TRANSFER_ABI});
 const conditions=[tx('chain_id','eq',String(BASE_CHAIN_ID)),tx('to','eq',USDC_BASE),tx('value','eq','0'),data('function_name','eq','transfer'),data('transfer.amount','lte',cap)];
 const aggregation={id:'usdc_24h',name:'yeet-usdc-24h',method:'eth_signTransaction',metric:{field_source:'ethereum_calldata',field:'transfer.amount',abi:ERC20_TRANSFER_ABI,function:'sum'},
  window:{type:'rolling',seconds:86_400},conditions:conditions.slice(0,4)};
 const withinDaily={field_source:'reference',field:`aggregation.${aggregation.id}`,operator:'lte',value:daily};
 return {
  version:'1.0',name,chain_type:'ethereum',
  rules:[
   {name:'usdc-transfer-base-sign',method:'eth_signTransaction',action:'ALLOW',conditions:[...conditions,withinDaily]},
   {name:'usdc-transfer-base-send',method:'eth_sendTransaction',action:'ALLOW',conditions:[...conditions,withinDaily]},
  ],
  aggregations:[aggregation],
 };
}

function arg(argv,flag,fallback){const i=argv.indexOf(flag);return i>=0?argv[i+1]:fallback}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const argv=process.argv.slice(2);
 const policy=basePolicy({maxTradeUsdc:arg(argv,'--max-trade',process.env.YEET_MAX_TRADE_USDC||'25'),dailyUsdc:arg(argv,'--daily',process.env.YEET_DAILY_CAP_USDC||'50'),name:arg(argv,'--name','yeet-usdc-transfer-base')});
 process.stdout.write(JSON.stringify(policy,null,2)+'\n');
}

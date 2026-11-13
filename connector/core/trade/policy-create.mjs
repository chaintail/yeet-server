#!/usr/bin/env node
// Prints (never sends) the Privy request bodies for the YEET signer's limits, in the form Privy accepted when the app
// was set up (PRIVY-SETUP-RECORD.md, PRIVY-SETUP-REVIEW.md):
//
//   node core/trade/policy-create.mjs aggregation                          body for POST /v1/aggregations
//   node core/trade/policy-create.mjs base [--aggregation-id ID] [--max-trade 25] [--daily 50]
//                                                                          body for POST /v1/policies (Base)
//   node core/trade/policy-create.mjs solana                               body for POST /v1/policies (Solana)
//
// Every body is owned by the policy-admin key quorum (--owner, default YEET_POLICY_ADMIN_QUORUM_ID), never by the
// signer quorum: the key that signs transfers cannot rewrite its own limits.
//
// Base: USDC `transfer` only, on chain 8453 only, no ETH value, amount at most --max-trade USDC (hex raw units), one
// ALLOW rule per method (eth_sendTransaction, eth_signTransaction). The rolling 24 h aggregation is created first, on
// its own (the policy schema has no inline aggregations), and referenced by the id Privy returned
// (`aggregation.<id>`); without --aggregation-id the reference is left out. Privy's aggregations count
// eth_signTransaction only, and YEET sends with eth_sendTransaction, so the daily cap that holds is the server's
// (limits.mjs YEET_DAILY_CAP_USDC); the reference only matters if the send path moves to eth_signTransaction.
// Solana: TransferChecked on the Token and Token-2022 programs, limited to the catalogue's Solana mints, plus the
// Associated Token Account program, for signAndSendTransaction and signTransaction. Privy denies what no rule allows.
import {parseUnits,CATALOG} from './router.mjs';
import {USDC_BASE,BASE_CHAIN_ID} from './signer.mjs';
import {TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana-tx.mjs';
import {pathToFileURL} from 'node:url';

export const ERC20_TRANSFER_ABI=[{type:'function',name:'transfer',stateMutability:'nonpayable',inputs:[{name:'to',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]}];
export const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PRIVY_ID=/^[A-Za-z0-9_-]{1,128}$/;

/** Raw units as Privy's EVM examples write them: 0x-prefixed upper-case hex (25 USDC -> 0x17D7840). */
export const hexAmount=usdc=>`0x${parseUnits(String(usdc),6).toString(16).toUpperCase()}`;
function ownerOf(owner){
 if(!PRIVY_ID.test(owner??''))throw Error('the policy owner (YEET_POLICY_ADMIN_QUORUM_ID or --owner) must be the policy-admin key quorum id');
 return owner;
}
const checkName=name=>{if(name.length>=50)throw Error('rule and policy names must be under 50 characters');return name};
const tx=(field,operator,value)=>({field_source:'ethereum_transaction',field,operator,value});
const calldata=(field,operator,value)=>({field_source:'ethereum_calldata',field,operator,value,abi:ERC20_TRANSFER_ABI});

/** POST /v1/aggregations: rolling 24 h sum of USDC transfer amounts on Base (counted for eth_signTransaction only). */
export function baseAggregation({owner,name='yeet-usdc-base-24h'}={}){
 return {name:checkName(name),method:'eth_signTransaction',
  metric:{field_source:'ethereum_calldata',field:'transfer.amount',function:'sum',abi:ERC20_TRANSFER_ABI},
  window:{type:'rolling',seconds:86_400},
  conditions:[tx('chain_id','eq',String(BASE_CHAIN_ID)),tx('to','eq',USDC_BASE)],
  owner_id:ownerOf(owner)};
}

/** POST /v1/policies for the Base signer. `aggregationId` is the id POST /v1/aggregations returned. */
export function basePolicy({owner,aggregationId,maxTradeUsdc='25',dailyUsdc='50',name='yeet-base-usdc'}={}){
 if(aggregationId!==undefined&&!PRIVY_ID.test(aggregationId))throw Error('invalid aggregation id');
 const conditions=[tx('chain_id','eq',String(BASE_CHAIN_ID)),tx('to','eq',USDC_BASE),tx('value','eq','0'),
  calldata('function_name','eq','transfer'),calldata('transfer.amount','lte',hexAmount(maxTradeUsdc))];
 if(aggregationId)conditions.push({field_source:'reference',field:`aggregation.${aggregationId}`,operator:'lte',value:hexAmount(dailyUsdc)});
 return {version:'1.0',name:checkName(name),chain_type:'ethereum',owner_id:ownerOf(owner),
  rules:[['usdc-transfer-base-send','eth_sendTransaction'],['usdc-transfer-base-sign','eth_signTransaction']]
   .map(([rule,method])=>({name:rule,method,action:'ALLOW',conditions}))};
}

/** The catalogue's Solana mints (the coins YEET buys and SKEET sells). */
export const catalogMints=(catalog=CATALOG)=>[...new Set(catalog.filter(c=>c.chain==='solana'&&typeof c.address==='string'&&c.address).map(c=>c.address))];

/** POST /v1/policies for the Solana signer: TransferChecked of catalogue mints only, plus ATA creation. */
export function solanaPolicy({owner,mints=catalogMints(),name='yeet-solana'}={}){
 if(!mints.length||mints.length>100)throw Error('the mint allowlist needs 1 to 100 mints');
 const program=id=>({field_source:'solana_program_instruction',field:'programId',operator:'eq',value:id});
 const transfer=[{field_source:'solana_token_program_instruction',field:'instructionName',operator:'eq',value:'TransferChecked'},
  {field_source:'solana_token_program_instruction',field:'TransferChecked.mint',operator:'in',value:mints}];
 const rules=[];
 for(const [suffix,method] of [['send','signAndSendTransaction'],['sign','signTransaction']]){
  rules.push({name:`spl-transfer-checked-${suffix}`,method,action:'ALLOW',conditions:[program(TOKEN_PROGRAM),...transfer]});
  rules.push({name:`t22-transfer-checked-${suffix}`,method,action:'ALLOW',conditions:[program(TOKEN_2022_PROGRAM),...transfer]});
  rules.push({name:`ata-create-${suffix}`,method,action:'ALLOW',conditions:[program(ATA_PROGRAM)]});
 }
 return {version:'1.0',name:checkName(name),chain_type:'solana',owner_id:ownerOf(owner),rules};
}

function arg(argv,flag,fallback){const i=argv.indexOf(flag);return i>=0?argv[i+1]:fallback}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const [what,...argv]=process.argv.slice(2);
 const owner=arg(argv,'--owner',process.env.YEET_POLICY_ADMIN_QUORUM_ID);
 const make={
  aggregation:()=>baseAggregation({owner}),
  base:()=>basePolicy({owner,aggregationId:arg(argv,'--aggregation-id',undefined),maxTradeUsdc:arg(argv,'--max-trade',process.env.YEET_MAX_TRADE_USDC||'25'),dailyUsdc:arg(argv,'--daily',process.env.YEET_DAILY_CAP_USDC||'50')}),
  solana:()=>solanaPolicy({owner}),
 }[what];
 if(!make){process.stderr.write('usage: policy-create.mjs aggregation|base|solana [--owner ID] [--aggregation-id ID] [--max-trade USDC] [--daily USDC]\n');process.exit(2)}
 process.stdout.write(JSON.stringify(make(),null,2)+'\n');
}

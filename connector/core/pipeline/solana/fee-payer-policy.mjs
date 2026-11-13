// The Privy policy on the fee payer wallet: the second wall behind sponsorship.mjs (Privy evaluates an ALLOW against
// every top-level instruction; an unmatched instruction is denied; a DENY match wins). Adapted from Folio (stock-app
// origin/main 70848f097) packages/wallet-privy/src/fee-payer-policy.ts: deny System Transfer; allow ComputeBudget and
// Associated Token; allow TransferChecked on SPL Token and Token-2022 only for the catalogue mints (Folio: USDC only;
// a YEET SELL transfers the coin). Folio's swap, KLend and CCTP programs are not allowed.
import {SYSTEM_PROGRAM,COMPUTE_BUDGET_PROGRAM,ATA_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC_SOLANA} from './message.mjs';
import {CATALOG} from '../../trade/router.mjs';

export const POLICY_NAME='yeet-fee-payer-sign-only-1';
/** USDC on Solana plus every catalogue coin on Solana, sorted. */
export const sponsoredMints=(catalog=CATALOG)=>[...new Set([USDC_SOLANA,...catalog.filter(c=>c.chain==='solana'&&c.address).map(c=>c.address)])].sort();

export function feePayerPolicy(ownerPublicKey,{mints=sponsoredMints()}={}){
 const transfer=program=>({name:`allow-transfer-checked-${program===TOKEN_PROGRAM?'token':'token-2022'}`,method:'signTransaction',action:'ALLOW',conditions:[
  {field_source:'solana_program_instruction',field:'programId',operator:'eq',value:program},
  {field_source:'solana_token_program_instruction',field:'instructionName',operator:'eq',value:'TransferChecked'},
  {field_source:'solana_token_program_instruction',field:'TransferChecked.mint',operator:'in',value:mints}]});
 return {version:'1.0',name:POLICY_NAME,chain_type:'solana',owner:{public_key:ownerPublicKey},rules:[
  {name:'deny-system-transfer',method:'signTransaction',action:'DENY',conditions:[
   {field_source:'solana_program_instruction',field:'programId',operator:'eq',value:SYSTEM_PROGRAM},
   {field_source:'solana_system_program_instruction',field:'instructionName',operator:'eq',value:'Transfer'}]},
  {name:'allow-compute-budget',method:'signTransaction',action:'ALLOW',conditions:[
   {field_source:'solana_program_instruction',field:'programId',operator:'eq',value:COMPUTE_BUDGET_PROGRAM}]},
  // Privy exposes no associated-token instruction name, mint or owner condition (Folio's note); sponsorship.mjs pins them.
  {name:'allow-associated-token-account',method:'signTransaction',action:'ALLOW',conditions:[
   {field_source:'solana_program_instruction',field:'programId',operator:'eq',value:ATA_PROGRAM}]},
  transfer(TOKEN_PROGRAM),transfer(TOKEN_2022_PROGRAM),
 ]};
}

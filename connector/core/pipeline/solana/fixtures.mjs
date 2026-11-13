// Test fixtures for the Solana leg: local keys (never funded), a well-formed blockhash, and the leg transaction built
// exactly as transfer-leg.mjs builds it, with hooks to mutate one thing at a time for the guard tests.
import {createHash} from 'node:crypto';
import {base58Encode} from '../../trade/router.mjs';
import {localSigner} from './verify.mjs';
import {buildMessage,associatedTokenAddress,createAssociatedTokenIdempotent,transferChecked,USDC_SOLANA,TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './message.mjs';

const seed=s=>Uint8Array.from(createHash('sha256').update(s).digest());
export const feePayer=localSigner(seed('yeet-test-fee-payer'));
export const user=localSigner(seed('yeet-test-user'));
export const other=localSigner(seed('yeet-test-other'));
export const DEPOSIT=base58Encode(createHash('sha256').update('yeet-test-deposit').digest());
export const BLOCKHASH=base58Encode(createHash('sha256').update('yeet-test-blockhash').digest());
export const pin=(o={})=>({feePayer:feePayer.address,wallet:user.address,depositOwner:DEPOSIT,mint:USDC_SOLANA,tokenProgram:TOKEN_PROGRAM,amount:5_000_000n,decimals:6,...o});

// ---- basket fixtures: one transaction paying 5 legs ----
const addr=s=>base58Encode(createHash('sha256').update(s).digest());
/** 5 local deposit owners (one per leg) and 5 local coin mints (leg 4's on Token-2022 in the Token-2022 variant). */
export const DEPOSITS=Array.from({length:5},(_,i)=>addr(`yeet-test-deposit-${i}`));
export const COIN_MINTS=Array.from({length:5},(_,i)=>addr(`yeet-test-coin-mint-${i}`));
/** BUY basket: USDC from the person to 5 deposit addresses, 5,000,000 raw each (+i so the amounts differ). */
export const buyPins=(o={})=>DEPOSITS.map((d,i)=>pin({depositOwner:d,amount:5_000_000n+BigInt(i),...o}));
/** SELL basket: 5 different coins to USDC; `token2022` puts leg 4's mint on Token-2022. */
export const sellPins=({token2022=false}={})=>DEPOSITS.map((d,i)=>pin({depositOwner:d,mint:COIN_MINTS[i],tokenProgram:token2022&&i===4?TOKEN_2022_PROGRAM:TOKEN_PROGRAM,amount:1_000_000_000n+BigInt(i),decimals:6}));
const legIxs=(p,create)=>{const ata=associatedTokenAddress(p.depositOwner,p.mint,p.tokenProgram);
 return [...(create?[createAssociatedTokenIdempotent({payer:p.feePayer,ata,owner:p.depositOwner,mint:p.mint,tokenProgram:p.tokenProgram})]:[]),
  transferChecked({source:associatedTokenAddress(p.wallet,p.mint,p.tokenProgram),mint:p.mint,destination:ata,authority:p.wallet,amount:p.amount,decimals:p.decimals,tokenProgram:p.tokenProgram})]};
/** The basket's unsigned transaction, compiled independently of transfer-leg.mjs. `edit(ixs)` may change the list. */
export function basketTx({pins=buyPins(),creates=pins.map(()=>true),edit,computeUnitLimit=80_000*pins.length,priorityMicroLamports=20_000n,feePayerAddress=pins[0].feePayer,owner=pins[0].wallet}={}){
 let ixs=pins.flatMap((p,i)=>legIxs(p,creates[i]));
 if(edit)ixs=edit(ixs);
 return buildMessage({feePayer:feePayerAddress,owner,blockhash:BLOCKHASH,computeUnitLimit,priorityMicroLamports,instructions:ixs}).bytes;
}

/** The leg's unsigned transaction. `edit(ixs)` may change the instruction list before compilation. */
export function legTx({p=pin(),create=true,edit,computeUnitLimit=80_000,priorityMicroLamports=20_000n,owner=p.wallet}={}){
 const ata=associatedTokenAddress(p.depositOwner,p.mint,p.tokenProgram);
 let ixs=[...(create?[createAssociatedTokenIdempotent({payer:p.feePayer,ata,owner:p.depositOwner,mint:p.mint,tokenProgram:p.tokenProgram})]:[]),
  transferChecked({source:associatedTokenAddress(p.wallet,p.mint,p.tokenProgram),mint:p.mint,destination:ata,authority:p.wallet,amount:p.amount,decimals:p.decimals,tokenProgram:p.tokenProgram})];
 if(edit)ixs=edit(ixs);
 return buildMessage({feePayer:p.feePayer,owner,blockhash:BLOCKHASH,computeUnitLimit,priorityMicroLamports,instructions:ixs}).bytes;
}

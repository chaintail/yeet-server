// Test fixtures for the Solana leg: local keys (never funded), a well-formed blockhash, and the leg transaction built
// exactly as transfer-leg.mjs builds it, with hooks to mutate one thing at a time for the guard tests.
import {createHash} from 'node:crypto';
import {base58Encode} from '../../trade/router.mjs';
import {localSigner} from './verify.mjs';
import {buildMessage,associatedTokenAddress,createAssociatedTokenIdempotent,transferChecked,USDC_SOLANA,TOKEN_PROGRAM} from './message.mjs';

const seed=s=>Uint8Array.from(createHash('sha256').update(s).digest());
export const feePayer=localSigner(seed('yeet-test-fee-payer'));
export const user=localSigner(seed('yeet-test-user'));
export const other=localSigner(seed('yeet-test-other'));
export const DEPOSIT=base58Encode(createHash('sha256').update('yeet-test-deposit').digest());
export const BLOCKHASH=base58Encode(createHash('sha256').update('yeet-test-blockhash').digest());
export const pin=(o={})=>({feePayer:feePayer.address,wallet:user.address,depositOwner:DEPOSIT,mint:USDC_SOLANA,tokenProgram:TOKEN_PROGRAM,amount:5_000_000n,decimals:6,...o});

/** The leg's unsigned transaction. `edit(ixs)` may change the instruction list before compilation. */
export function legTx({p=pin(),create=true,edit,computeUnitLimit=80_000,priorityMicroLamports=20_000n,owner=p.wallet}={}){
 const ata=associatedTokenAddress(p.depositOwner,p.mint,p.tokenProgram);
 let ixs=[...(create?[createAssociatedTokenIdempotent({payer:p.feePayer,ata,owner:p.depositOwner,mint:p.mint,tokenProgram:p.tokenProgram})]:[]),
  transferChecked({source:associatedTokenAddress(p.wallet,p.mint,p.tokenProgram),mint:p.mint,destination:ata,authority:p.wallet,amount:p.amount,decimals:p.decimals,tokenProgram:p.tokenProgram})];
 if(edit)ixs=edit(ixs);
 return buildMessage({feePayer:p.feePayer,owner,blockhash:BLOCKHASH,computeUnitLimit,priorityMicroLamports,instructions:ixs}).bytes;
}

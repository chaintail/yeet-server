// Where the fee payer (account 0) may appear in an instruction. Lifted from Folio (stock-app origin/main 70848f097)
// apps/server/src/assembly/rent-reference.ts `rentPayerPosition` / `rentReferenceAllowed` (Associated Token
// CreateIdempotent, data [1], payer at 0, owner at 2). The KLend initializers are Folio-only and dropped.
//
// NEW RULE (no Folio equivalent): Folio lets the fee payer pay rent only for a token account owned by the person.
// YEET pays rent only for the token account of the leg's 1Click DEPOSIT ADDRESS for the leg's mint: owner must be the
// deposit address, mint the leg's mint, and the fee payer may appear in no other position of the instruction.
import {ATA_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './message.mjs';

/** CreateIdempotent account positions: payer, ata, owner, mint, system program, token program. */
export const ATA_CREATE_POSITIONS=Object.freeze({payer:0,ata:1,owner:2,mint:3,system:4,tokenProgram:5});

/** True for the ATA program's CreateIdempotent (data exactly [1]). */
export const isCreateIdempotent=(program,data)=>program===ATA_PROGRAM&&data?.length===1&&data[0]===1;

/**
 * `accounts` are the instruction's resolved addresses. Allowed only when it is CreateIdempotent with 6 accounts, the fee
 * payer exactly at the payer position and nowhere else, owner == `depositOwner`, mint == `mint`, and the token program
 * one of the two SPL token programs.
 */
export function depositRentAllowed(program,data,accounts,{feePayer,depositOwner,mint}){
 if(!isCreateIdempotent(program,data)||accounts.length!==6)return false;
 const p=ATA_CREATE_POSITIONS;
 return accounts[p.payer]===feePayer&&accounts[p.owner]===depositOwner&&accounts[p.mint]===mint
  &&[TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(accounts[p.tokenProgram])
  &&accounts.every((a,i)=>a!==feePayer||i===p.payer);
}

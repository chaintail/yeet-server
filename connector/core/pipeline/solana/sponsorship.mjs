// What the YEET fee payer will co-sign. Lifted from Folio (stock-app origin/main 70848f097)
// apps/server/src/trade/sponsorship.ts `assertSponsorable` (strict decode and re-encode, static programs, account 0
// only at a verified rent position, refused token instructions), `estimateSponsoredFeeLamports`, `sponsoredSendKey`,
// the limit parsing (`positive`, `assertExitReserveOutlastsIdentity`, `sponsorshipCeilings`) and client-signing.ts
// `fee()` (exactly two compute-budget instructions, limit and price caps). Folio's router-specific allowances
// (RequestHeapFrame, KLend, swap programs) are dropped: a YEET leg is one transfer.
//
// Tightened for the YEET leg (design section 2.2): the program allowlist is ComputeBudget, Associated Token, Token and
// Token-2022 only; no System instruction; no lookup table; at most one CreateIdempotent and it must create the
// deposit address's token account (rent-reference.mjs, a new rule); exactly one TransferChecked pinned to source,
// destination, authority, mint, amount and decimals; no other token instruction.
import {createHash} from 'node:crypto';
import {decodeTransaction,resolvedInstructions,associatedTokenAddress,COMPUTE_BUDGET_PROGRAM,ATA_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,
 SYSTEM_PROGRAM,MAX_TRANSACTION_BYTES,TOKEN_ACCOUNT_RENT_LAMPORTS} from './message.mjs';
import {depositRentAllowed,isCreateIdempotent,ATA_CREATE_POSITIONS} from './rent-reference.mjs';

const MESSAGES={
 SPONSOR_TRANSACTION_UNREADABLE:'This transaction could not be read · nothing was signed',
 SPONSOR_INSTRUCTION_REFUSED:'This transaction asks the fee sponsor for more than a fee · nothing was signed',
 SPONSOR_CLOSE_ACCOUNT_REFUSED:'This transaction closes a token account · YEET does not sponsor that',
 SPONSOR_TRANSFER_MISMATCH:'This transaction is not the transfer this trade quoted · nothing was signed',
 SPONSOR_SIGNERS_MISMATCH:'This transaction is not signed by your wallet and the YEET fee payer',
 CLIENT_FEE_CAP_EXCEEDED:'This transaction exceeds the sponsored fee limit',
 SPONSOR_QUOTA_EXHAUSTED:'Sponsored fees exhausted for today · try again tomorrow',
};
export class SponsorshipRefusal extends Error{
 constructor(reason,scope){super(MESSAGES[reason]??reason);this.name='SponsorshipRefusal';this.reason=reason;this.code=reason;if(scope)this.scope=scope}
}
const refuse=(reason,scope)=>{throw new SponsorshipRefusal(reason,scope)};

export const LAMPORTS_PER_SIGNATURE=5000;
export const SPONSORED_MAX_COMPUTE_LIMIT=1_400_000;
export const SPONSORED_MAX_PRIORITY_MICRO_LAMPORTS=50_000n;
export const SPONSORED_MAX_FEE_LAMPORTS=80_000;
const CLOSE_ACCOUNT=9,TRANSFER_CHECKED=12;
const REFUSED_TOKEN_TAGS=new Set([4/* Approve */,6/* SetAuthority */,13/* ApproveChecked */]);
const ALLOWED_PROGRAMS=new Set([COMPUTE_BUDGET_PROGRAM,ATA_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
const TOKEN_PROGRAMS=new Set([TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);

/** Folio sponsorship.ts: base fee for both signatures plus compute_limit x price / 1e6, rounded up. */
export function estimateSponsoredFeeLamports({compute_limit,priority_micro_lamports},signatures=2){
 const priority=(BigInt(compute_limit)*BigInt(priority_micro_lamports)+999_999n)/1_000_000n;
 return signatures*LAMPORTS_PER_SIGNATURE+Number(priority);
}
/** SHA-256 of the exact bytes (hex): the same transaction retried is the same send. */
export const sponsoredSendKey=bytes=>createHash('sha256').update(bytes).digest('hex');

const u64le=d=>Buffer.from(d.subarray(1,9)).readBigUInt64LE(0);

/**
 * The compute budget (Folio client-signing.ts `fee`): instruction 0 SetComputeUnitLimit, instruction 1
 * SetComputeUnitPrice, no other compute-budget instruction, neither with accounts; limit in (0, 1.4M], price at most
 * 50,000 micro-lamports, total fee at most `maxFeeLamports`. Returns the fee in lamports.
 */
export function sponsoredFee(message,{maxFeeLamports=SPONSORED_MAX_FEE_LAMPORTS}={}){
 const ixs=resolvedInstructions(message);
 const cb=ixs.filter(ix=>ix.program===COMPUTE_BUDGET_PROGRAM).length;
 const [lim,price]=ixs;
 if(cb!==2||lim?.program!==COMPUTE_BUDGET_PROGRAM||price?.program!==COMPUTE_BUDGET_PROGRAM||lim.accounts.length||price.accounts.length
  ||lim.data.length!==5||lim.data[0]!==2||price.data.length!==9||price.data[0]!==3)refuse('CLIENT_FEE_CAP_EXCEEDED');
 const limit=Buffer.from(lim.data.subarray(1)).readUInt32LE(0),micro=u64le(price.data);
 if(limit<=0||limit>SPONSORED_MAX_COMPUTE_LIMIT||micro>SPONSORED_MAX_PRIORITY_MICRO_LAMPORTS)refuse('CLIENT_FEE_CAP_EXCEEDED');
 const lamports=estimateSponsoredFeeLamports({compute_limit:limit,priority_micro_lamports:micro});
 if(lamports>maxFeeLamports)refuse('CLIENT_FEE_CAP_EXCEEDED');
 return {lamports,computeLimit:limit,priorityMicroLamports:micro};
}

/**
 * Refuses a transaction the fee payer will not co-sign. `pin` is what the stored leg allows:
 * {feePayer, wallet, depositOwner, mint, tokenProgram, amount (bigint|string), decimals, maxFeeLamports?}.
 * Returns {feeLamports, createsDepositAccount, rentLamports, source, destination}.
 */
export function assertSponsorable(bytes,pin){
 let tx;
 try{tx=decodeTransaction(bytes)}catch{refuse('SPONSOR_TRANSACTION_UNREADABLE')}
 if(bytes.length>MAX_TRANSACTION_BYTES)refuse('SPONSOR_TRANSACTION_UNREADABLE');
 const m=tx.message;
 if(m.lookups.length)refuse('SPONSOR_INSTRUCTION_REFUSED');
 if(m.header.signers!==2||m.accounts[0]!==pin.feePayer||m.accounts[1]!==pin.wallet||pin.feePayer===pin.wallet)refuse('SPONSOR_SIGNERS_MISMATCH');
 const fee=sponsoredFee(m,{maxFeeLamports:pin.maxFeeLamports});
 const destination=associatedTokenAddress(pin.depositOwner,pin.mint,pin.tokenProgram);
 const source=associatedTokenAddress(pin.wallet,pin.mint,pin.tokenProgram);
 let creates=0,transfers=0;
 for(const ix of resolvedInstructions(m)){
  if(ix.program===null||!ALLOWED_PROGRAMS.has(ix.program)||ix.program===SYSTEM_PROGRAM)refuse('SPONSOR_INSTRUCTION_REFUSED');
  if(ix.program===COMPUTE_BUDGET_PROGRAM)continue;
  // Folio: no instruction may name account 0 as its program or reference it outside a verified rent position.
  if(ix.indices.includes(0)&&!depositRentAllowed(ix.program,ix.data,ix.accounts,{feePayer:pin.feePayer,depositOwner:pin.depositOwner,mint:pin.mint}))refuse('SPONSOR_INSTRUCTION_REFUSED');
  if(ix.program===ATA_PROGRAM){
   if(!isCreateIdempotent(ix.program,ix.data)||!ix.indices.includes(0))refuse('SPONSOR_INSTRUCTION_REFUSED');
   const P=ATA_CREATE_POSITIONS;
   if(ix.accounts[P.ata]!==destination||ix.accounts[P.tokenProgram]!==pin.tokenProgram)refuse('SPONSOR_TRANSFER_MISMATCH');
   creates++;continue;
  }
  // Token programs.
  const tag=ix.data[0];
  if(tag===CLOSE_ACCOUNT)refuse('SPONSOR_CLOSE_ACCOUNT_REFUSED');
  if(REFUSED_TOKEN_TAGS.has(tag)||tag!==TRANSFER_CHECKED)refuse('SPONSOR_INSTRUCTION_REFUSED');
  if(ix.program!==pin.tokenProgram||ix.data.length!==10||ix.accounts.length!==4)refuse('SPONSOR_TRANSFER_MISMATCH');
  const [src,mint,dst,authority]=ix.accounts;
  if(src!==source||mint!==pin.mint||dst!==destination||authority!==pin.wallet||u64le(ix.data)!==BigInt(pin.amount)||ix.data[9]!==pin.decimals)refuse('SPONSOR_TRANSFER_MISMATCH');
  transfers++;
 }
 if(transfers!==1||creates>1)refuse('SPONSOR_TRANSFER_MISMATCH');
 return {feeLamports:fee.lamports,createsDepositAccount:creates===1,rentLamports:creates?TOKEN_ACCOUNT_RENT_LAMPORTS:0,source,destination};
}

// ---- limits (Folio sponsorship.ts readSponsorshipLimits, YEET_ names) ----
export const DEFAULT_SPONSORSHIP_LIMITS=Object.freeze({daily_transactions:25,daily_lamports:2_000_000,global_daily_lamports:50_000_000,
 max_fee_lamports:SPONSORED_MAX_FEE_LAMPORTS,daily_rent_accounts:10,global_daily_rent_lamports:20*TOKEN_ACCOUNT_RENT_LAMPORTS});
export const SPONSORSHIP_LIMIT_ENV=Object.freeze({YEET_SPONSOR_DAILY_TX:'daily_transactions',YEET_SPONSOR_DAILY_LAMPORTS:'daily_lamports',
 YEET_SPONSOR_GLOBAL_DAILY_LAMPORTS:'global_daily_lamports',YEET_SPONSOR_MAX_FEE_LAMPORTS:'max_fee_lamports',
 YEET_SPONSOR_DAILY_RENT_ACCOUNTS:'daily_rent_accounts',YEET_SPONSOR_GLOBAL_DAILY_RENT_LAMPORTS:'global_daily_rent_lamports'});
/** Folio `positive`: unset or blank is the default; anything but plain digits for a positive safe integer refuses boot. */
function positive(name,value,fallback){
 const text=value?.trim();
 if(!text)return fallback;
 const n=/^\d+$/.test(text)?Number(text):NaN;
 if(!Number.isSafeInteger(n)||n<=0)throw Error(`${name} must be a positive whole number written as plain digits`);
 return n;
}
export const EXIT_IDENTITY_MULTIPLIER=2;
const EXIT_RESERVE_DIVISOR=5;// 20% of the global budget is for exits (SELL) only
const exitReserve=g=>(g-g%EXIT_RESERVE_DIVISOR)/EXIT_RESERVE_DIVISOR;
export function sponsorshipCeilings(l){
 return Object.freeze({entry_global_lamports:l.global_daily_lamports-exitReserve(l.global_daily_lamports),exit_global_lamports:l.global_daily_lamports,
  exit_identity_transactions:l.daily_transactions*EXIT_IDENTITY_MULTIPLIER,exit_identity_lamports:l.daily_lamports*EXIT_IDENTITY_MULTIPLIER});
}
export function readSponsorshipLimits(env=process.env){
 const out={};
 for(const [name,field] of Object.entries(SPONSORSHIP_LIMIT_ENV))out[field]=positive(name,env[name],DEFAULT_SPONSORSHIP_LIMITS[field]);
 if(out.max_fee_lamports>SPONSORED_MAX_FEE_LAMPORTS)throw Error(`YEET_SPONSOR_MAX_FEE_LAMPORTS must be at most ${SPONSORED_MAX_FEE_LAMPORTS}`);
 // Folio assertExitReserveOutlastsIdentity: one identity's exits must leave the reserve one maximum exit fee.
 if(BigInt(exitReserve(out.global_daily_lamports))-BigInt(out.daily_lamports*EXIT_IDENTITY_MULTIPLIER)<BigInt(out.max_fee_lamports))
  throw Error('YEET_SPONSOR_DAILY_LAMPORTS is too high for YEET_SPONSOR_GLOBAL_DAILY_LAMPORTS: one account could drain the exit reserve');
 return Object.freeze(out);
}

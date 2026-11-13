// The one transfer a Solana leg is: the person's tokens (USDC for a BUY, the coin for a SELL) to the 1Click deposit
// address of this leg's quote. Everything the transaction may contain is pinned from the stored leg (quote, deposit
// address, amount) and from the chain (the mint's token program), never from the request. A basket puts every leg's
// transfer in ONE transaction (buildBasketTransaction), so the person signs once; a leg alone is the basket of one.
// Instructions, in order (design 2.1): SetComputeUnitLimit, SetComputeUnitPrice, Associated Token CreateIdempotent
// (payer = fee payer, owner = deposit address; left out when that token account exists), TransferChecked.
import {buildMessage,associatedTokenAddress,createAssociatedTokenIdempotent,transferChecked,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC_SOLANA} from './message.mjs';
import {CATALOG} from '../../trade/router.mjs';
import {refuse} from '../../trade/util.mjs';

export const DEFAULT_COMPUTE_UNIT_LIMIT=80_000;
export const DEFAULT_PRIORITY_MICRO_LAMPORTS=20_000n;

/** SPL mint of a quote side ({assetId, chain}) from the catalogue; USDC on Solana included. */
export function mintOf(side,catalog=CATALOG){
 if(side?.chain!=='solana')refuse('TEMPORARILY_UNAVAILABLE','leg origin is not on Solana');
 const e=catalog.find(c=>c.assetId===side.assetId&&c.chain==='solana');
 const mint=e?.address??(side.assetId==='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near'?USDC_SOLANA:null);
 if(!mint)refuse('COIN_NOT_SUPPORTED',`no mint for ${side.assetId}`);
 return mint;
}

/** The pins of a stored leg: {feePayer, wallet, depositOwner, mint, tokenProgram, amount, decimals}. */
export async function legPin({leg,wallet,feePayer,rpc,catalog=CATALOG}){
 const q=JSON.parse(leg.live_quote_json);
 const mint=mintOf(q.origin,catalog);
 if(q.depositAddress!==leg.deposit_address||q.amountIn!==leg.amount_in_raw)refuse('TEMPORARILY_UNAVAILABLE','leg row and stored quote differ');
 const info=await rpc.accountInfo(mint);
 const tokenProgram=info?.owner;
 if(![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(tokenProgram))refuse('TEMPORARILY_UNAVAILABLE','mint is not an SPL token');
 if(!Number.isInteger(q.origin.decimals))refuse('TEMPORARILY_UNAVAILABLE','decimals unknown');
 return Object.freeze({feePayer,wallet,depositOwner:leg.deposit_address,mint,tokenProgram,amount:BigInt(leg.amount_in_raw),decimals:q.origin.decimals,depositMemo:leg.deposit_memo??null});
}

/** At most this many legs share one transaction (the contract's 5-leg basket). */
export const MAX_BASKET_LEGS=5;
/** Why a basket cannot be one transaction; the driver falls back to one request per leg. */
export class BatchRefusal extends Error{constructor(code,detail){super(detail??code);this.name='BatchRefusal';this.code=code;this.reason=code;this.detail=detail??code}}

/**
 * Unsigned wire bytes for one or more legs in ONE transaction (both signature slots zero). Instructions, in leg order:
 * SetComputeUnitLimit, SetComputeUnitPrice, then for each pin an optional CreateIdempotent of its deposit token
 * account (payer = fee payer, `creates[i]`) followed by its TransferChecked (authority = the person).
 * `computeUnitLimit` is the whole transaction's limit, default DEFAULT_COMPUTE_UNIT_LIMIT x legs.
 * Throws BatchRefusal BATCH_UNSUPPORTED (two legs share a deposit token account, a leg carries a deposit memo, legs
 * disagree on fee payer or wallet) or BATCH_TOO_LARGE (over 1232 bytes).
 */
export function buildBasketTransaction(pins,{blockhash,creates,computeUnitLimit,priorityMicroLamports=DEFAULT_PRIORITY_MICRO_LAMPORTS,maxLegs=MAX_BASKET_LEGS}){
 if(!Array.isArray(pins)||!pins.length||pins.length>maxLegs)throw new BatchRefusal('BATCH_UNSUPPORTED',`1 to ${maxLegs} legs per transaction`);
 if(!Array.isArray(creates)||creates.length!==pins.length)throw new BatchRefusal('BATCH_UNSUPPORTED','one create flag per leg');
 const [first]=pins;
 if(pins.some(p=>p.feePayer!==first.feePayer||p.wallet!==first.wallet))throw new BatchRefusal('BATCH_UNSUPPORTED','legs disagree on fee payer or wallet');
 const atas=pins.map(p=>associatedTokenAddress(p.depositOwner,p.mint,p.tokenProgram));
 if(pins.length>1){
  if(new Set(atas).size!==atas.length)throw new BatchRefusal('BATCH_UNSUPPORTED','two legs share a deposit token account');
  if(pins.some(p=>p.depositMemo))throw new BatchRefusal('BATCH_UNSUPPORTED','a leg carries a deposit memo');
 }
 const ixs=pins.flatMap((p,i)=>[
  ...(creates[i]?[createAssociatedTokenIdempotent({payer:p.feePayer,ata:atas[i],owner:p.depositOwner,mint:p.mint,tokenProgram:p.tokenProgram})]:[]),
  transferChecked({source:associatedTokenAddress(p.wallet,p.mint,p.tokenProgram),mint:p.mint,destination:atas[i],authority:p.wallet,amount:p.amount,decimals:p.decimals,tokenProgram:p.tokenProgram}),
 ]);
 try{
  return buildMessage({feePayer:first.feePayer,owner:first.wallet,blockhash,computeUnitLimit:computeUnitLimit??DEFAULT_COMPUTE_UNIT_LIMIT*pins.length,priorityMicroLamports,instructions:ixs}).bytes;
 }catch(e){
  if(e?.message==='TX_TOO_LARGE')throw new BatchRefusal('BATCH_TOO_LARGE',`${pins.length} legs do not fit in 1232 bytes`);
  throw e;
 }
}

/** Unsigned wire bytes for the leg (both signature slots zero): the basket of one. */
export function buildLegTransaction(pin,{blockhash,createDestination,computeUnitLimit=DEFAULT_COMPUTE_UNIT_LIMIT,priorityMicroLamports=DEFAULT_PRIORITY_MICRO_LAMPORTS}){
 return buildBasketTransaction([pin],{blockhash,creates:[!!createDestination],computeUnitLimit,priorityMicroLamports});
}

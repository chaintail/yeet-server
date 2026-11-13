// The one transfer a Solana leg is: the person's tokens (USDC for a BUY, the coin for a SELL) to the 1Click deposit
// address of this leg's quote. Everything the transaction may contain is pinned from the stored leg (quote, deposit
// address, amount) and from the chain (the mint's token program), never from the request.
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
 return Object.freeze({feePayer,wallet,depositOwner:leg.deposit_address,mint,tokenProgram,amount:BigInt(leg.amount_in_raw),decimals:q.origin.decimals});
}

/** Unsigned wire bytes for the leg (both signature slots zero). */
export function buildLegTransaction(pin,{blockhash,createDestination,computeUnitLimit=DEFAULT_COMPUTE_UNIT_LIMIT,priorityMicroLamports=DEFAULT_PRIORITY_MICRO_LAMPORTS}){
 const ata=associatedTokenAddress(pin.depositOwner,pin.mint,pin.tokenProgram);
 const ixs=[
  ...(createDestination?[createAssociatedTokenIdempotent({payer:pin.feePayer,ata,owner:pin.depositOwner,mint:pin.mint,tokenProgram:pin.tokenProgram})]:[]),
  transferChecked({source:associatedTokenAddress(pin.wallet,pin.mint,pin.tokenProgram),mint:pin.mint,destination:ata,authority:pin.wallet,amount:pin.amount,decimals:pin.decimals,tokenProgram:pin.tokenProgram}),
 ];
 return buildMessage({feePayer:pin.feePayer,owner:pin.wallet,blockhash,computeUnitLimit,priorityMicroLamports,instructions:ixs}).bytes;
}

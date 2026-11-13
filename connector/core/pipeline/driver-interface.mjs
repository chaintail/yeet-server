// The only contract between the trade pipeline (pipeline.mjs) and a chain driver (design GAS-SPONSORSHIP-DESIGN.md
// section 3). A driver turns one committed trade leg into something the person's own wallet signs, then takes the
// signed bytes back, checks them, adds our sponsorship (Solana: the fee payer co-signs; Base: a gas top-up) and sends.
// The input of every sponsorship step is "bytes signed by the person's wallet"; nothing here depends on where the
// signature was produced (ChatGPT card, sign page, operator tool).
//
// driver = {
//   chain: 'sol' | 'base',  kind: 'solana_tx' | 'evm_tx',
//   readiness()                                   -> {ok, reasons[]}
//   prepare({trade, leg, wallet, attemptId, now}) -> {payload, payloadSha256, expiresAt}
//   submit({trade, leg, wallet, attemptId, signed, dryRun, now})
//                                                 -> {state: 'sent'|'pending'|'expired'|'not_sent', txHash?, simulation?}
//   recover({now})                                -> [{tradeId, legIdx, state, txHash?}]
//   prepareLegs({trade, legs, wallet})            OPTIONAL (Solana): one request may pay several legs (one signature)
//                                                 -> [{attemptId, legs:[idx], ...} | {legs:[idx], error}]
// }
// `trade` and `leg` are the stored rows (trades, trade_legs); `wallet` is the person's address on the driver's chain.
// A driver writes its own attempt rows and the leg's send state through ledger.mjs; the pipeline never signs.
export const CHAINS=Object.freeze(['sol','base']);
export const KINDS=Object.freeze({sol:'solana_tx',base:'evm_tx'});
export const SUBMIT_STATES=Object.freeze(['sent','pending','expired','not_sent']);
/** trades.origin_chain per driver chain (the wallet table names the chains 'solana' and 'base'). */
export const WALLET_CHAIN=Object.freeze({sol:'solana',base:'base'});

/** Throws when `d` does not have the driver shape; returns it frozen. */
export function assertDriver(d){
 if(!d||typeof d!=='object')throw TypeError('driver must be an object');
 if(!CHAINS.includes(d.chain))throw TypeError(`driver.chain must be one of ${CHAINS.join(', ')}`);
 if(d.kind!==KINDS[d.chain])throw TypeError(`driver.kind for ${d.chain} must be ${KINDS[d.chain]}`);
 for(const m of ['readiness','prepare','submit','recover'])if(typeof d[m]!=='function')throw TypeError(`driver.${m} must be a function`);
 return Object.freeze(d);
}

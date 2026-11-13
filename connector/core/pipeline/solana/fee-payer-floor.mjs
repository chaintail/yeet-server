// Fee payer balance floor. Adapted from Folio (stock-app origin/main 70848f097) apps/server/src/setup-sponsorship.ts:
// FOLIO_FEE_PAYER_SOL_FLOOR (default 0.05 SOL), an edge-triggered founder alert fee_payer_low / fee_payer_recovered,
// spending refused below the floor. YEET: YEET_FEE_PAYER_SOL_FLOOR, default 0.01 SOL (the funded test float is
// 0.05 SOL and each sponsored leg can cost up to 2,039,280 lamports of deposit-account rent); the check is that the
// balance after this transaction's fee and rent stays at or above the floor.
const LAMPORTS_PER_SOL=1_000_000_000n;
export function solToLamports(text){
 const m=/^(\d{1,6})(?:\.(\d{1,9}))?$/.exec(String(text).trim());
 if(!m)throw Error('YEET_FEE_PAYER_SOL_FLOOR must be a SOL amount like 0.01');
 return Number(BigInt(m[1])*LAMPORTS_PER_SOL+BigInt((m[2]??'').padEnd(9,'0')));
}
export const floorFromEnv=(env=process.env)=>env.YEET_FEE_PAYER_SOL_FLOOR?.trim()?solToLamports(env.YEET_FEE_PAYER_SOL_FLOOR):10_000_000;

/** check(spendLamports) -> true when the fee payer can spend and stay at or above the floor; raises the alerts. */
export function createFeePayerFloor({rpc,address,floorLamports,ledger,now=Date.now}){
 let low=false;
 return {
  floorLamports,
  async check(spendLamports=0){
   const balance=await rpc.balance(address,'confirmed');
   const ok=balance-spendLamports>=floorLamports;
   if(!ok&&!low){low=true;ledger?.raiseAlert({key:`fee_payer_low:${now()}`,kind:'fee_payer_low',detail:{address,balance_lamports:balance,floor_lamports:floorLamports,spend_lamports:spendLamports}})}
   if(ok&&low){low=false;ledger?.raiseAlert({key:`fee_payer_recovered:${now()}`,kind:'fee_payer_recovered',detail:{address,balance_lamports:balance,floor_lamports:floorLamports}})}
   return ok;
  },
 };
}

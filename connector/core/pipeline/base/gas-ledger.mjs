// Gas accounting for one user wallet on Base: what our gas wallet contributed (top-ups), what the user's transfers
// were charged, and the reservation each signed transfer holds until its receipt.
// Lifted from Folio apps/server/src/bridge/source-gas.ts @70848f097 (GasLedger, prepareTopup), types stripped.
// Stripped: Folio's customer principal (sweep amounts) and the Arc 18-decimal scale; folio* names became sponsor*.
// Added (marked YEET): WalletGasLedger, because a YEET user may hold ETH of their own, so coverage is decided from the
// on-chain balance by the driver, not from our residual. Every charge is still bounded by its reservation.
const constraint=reason=>{const e=new Error(reason);e.code=reason;return e};

export class GasLedger{
 topups=new Map();
 charges=new Map();
 reservations=new Map();
 constructor(chain){this.chain=chain}
 get sponsorContribution(){return [...this.topups.values()].reduce((sum,t)=>sum+t.contribution,0n)}
 get gasCharged(){return [...this.charges.values()].reduce((sum,c)=>sum+c.paid,0n)}
 get sponsorResidual(){return this.sponsorContribution-this.gasCharged}
 get availableResidual(){return this.sponsorResidual-[...this.reservations.values()].reduce((a,b)=>a+b,0n)}
 snapshot(){
  return JSON.stringify({topups:[...this.topups],charges:[...this.charges],reservations:[...this.reservations]},
   (_k,v)=>typeof v==='bigint'?{integer:String(v)}:v);
 }
 restore(snapshot){
  const data=JSON.parse(snapshot,(_k,v)=>v&&typeof v==='object'&&'integer' in v?BigInt(v.integer):v);
  this.topups.clear();this.charges.clear();this.reservations.clear();
  for(const [k,v] of data.topups)this.topups.set(k,v);
  for(const [k,v] of data.charges)this.charges.set(k,v);
  for(const [k,v] of data.reservations)this.reservations.set(k,v);
 }
 confirmTopup(t){
  if(t.contribution<=0n)throw constraint('INVALID_TOPUP');
  const prior=this.topups.get(t.attemptId);
  if(prior&&(prior.txHash!==t.txHash||prior.contribution!==t.contribution))throw constraint('TOPUP_CHANGED');
  if([...this.topups.values()].some(x=>x.txHash===t.txHash&&x.attemptId!==t.attemptId))throw constraint('TOPUP_HASH_REUSED');
  this.topups.set(t.attemptId,Object.freeze({...t}));
 }
 topupRequired(maxGas){
  if(maxGas<=0n)throw constraint('INVALID_GAS_CAP');
  return this.availableResidual<maxGas?maxGas-this.availableResidual:0n;
 }
 beforeSigning(attemptId,maxGas){
  if(this.charges.has(attemptId)||this.reservations.has(attemptId))throw constraint('ATTEMPT_ALREADY_USED');
  if(this.topupRequired(maxGas)>0n)throw constraint('SPONSOR_TOPUP_REQUIRED');
  this.reservations.set(attemptId,maxGas);
 }
 reconcile(c){
  const previous=this.charges.get(c.attemptId);
  if(previous){
   if(previous.txHash!==c.txHash||previous.paid!==c.paid||previous.failed!==c.failed)throw constraint('CHARGE_CHANGED');
   return;
  }
  const cap=this.reservations.get(c.attemptId);
  if(cap===undefined||c.paid<0n||c.paid>cap||c.paid>this.sponsorResidual)throw constraint('GAS_PRINCIPAL_VIOLATION');
  this.charges.set(c.attemptId,Object.freeze({...c}));this.reservations.delete(c.attemptId);
 }
}

/** YEET: the reservation is taken when the user's signature validates, before (or without) a top-up. */
export class WalletGasLedger extends GasLedger{
 beforeSigning(attemptId,maxGas){
  if(maxGas<=0n)throw constraint('INVALID_GAS_CAP');
  if(this.charges.has(attemptId)||this.reservations.has(attemptId))throw constraint('ATTEMPT_ALREADY_USED');
  this.reservations.set(attemptId,maxGas);
 }
 release(attemptId){this.reservations.delete(attemptId)}
 reconcile(c){
  const previous=this.charges.get(c.attemptId);
  if(previous){
   if(previous.txHash!==c.txHash||previous.paid!==c.paid||previous.failed!==c.failed)throw constraint('CHARGE_CHANGED');
   return;
  }
  const cap=this.reservations.get(c.attemptId);
  if(cap===undefined||c.paid<0n||c.paid>cap)throw constraint('GAS_PRINCIPAL_VIOLATION');
  this.charges.set(c.attemptId,Object.freeze({...c}));this.reservations.delete(c.attemptId);
 }
}

/** The only call the gas wallet makes: native ETH to the user's own wallet, no data. */
export function prepareTopup(wallet,gasWallet,amount){
 if(!gasWallet||!/^0x[0-9a-fA-F]{40}$/.test(wallet)||!/^0x[0-9a-fA-F]{40}$/.test(gasWallet)
  ||amount<=0n||wallet.toLowerCase()===gasWallet.toLowerCase())throw constraint('GAS_WALLET_NOT_CONFIGURED');
 return {from:gasWallet,to:wallet,value:amount,data:'0x'};
}

// The driver table: one driver per origin chain (driver-interface.mjs). Package A registers Solana; the Base driver
// (package B, pipeline/base/driver.mjs) is registered by the integrator with the one marked line below.
import {createSolanaDriver} from './solana/driver.mjs';
import {createRelayRpc} from './solana/relay-rpc.mjs';
import {createRpcSignatureStatus} from './solana/signature-status.mjs';
import {feePayerFromEnv} from './solana/fee-payer.mjs';
import {createFeePayerFloor,floorFromEnv} from './solana/fee-payer-floor.mjs';
import {readSponsorshipLimits} from './solana/sponsorship.mjs';

/** `gateFor(chain)` returns the live gate for that chain (pipeline.mjs liveGate). `overrides` replace any built part
 * (tests, the operator tool): {rpc, signatureStatus, historySignatureStatus, feePayer, floor, sol}. */
export function createDrivers({env=process.env,db,ledger,fetch=globalThis.fetch,now=Date.now,log=()=>{},gateFor,liveBroadcast=true,overrides={}}){
 const sponsorLimits=readSponsorshipLimits(env);
 const read=env.SOLANA_RPC_URL?.trim(),history=env.SOLANA_HISTORY_RPC_URL?.trim()||read;
 const rpc=overrides.rpc??(read?createRelayRpc({readUrl:read,broadcastUrl:env.SOLANA_BROADCAST_RPC_URL?.trim()||read,fetch,log}):null);
 const feePayer=overrides.feePayer!==undefined?overrides.feePayer:feePayerFromEnv(env,{fetch});
 const signatureStatus=overrides.signatureStatus??(read?createRpcSignatureStatus({endpoint:read,fetch}):null);
 const historySignatureStatus=overrides.historySignatureStatus??(history?createRpcSignatureStatus({endpoint:history,fetch}):signatureStatus);
 const floor=overrides.floor!==undefined?overrides.floor:(feePayer&&rpc?createFeePayerFloor({rpc,address:feePayer.address,floorLamports:floorFromEnv(env),ledger,now}):null);
 const drivers={
  sol:overrides.sol??createSolanaDriver({ledger,rpc,signatureStatus,historySignatureStatus,feePayer:rpc?feePayer:null,floor,gate:gateFor('sol'),env,now,log,liveBroadcast,sponsorLimits}),
 };
 // Package B: drivers.base=createBaseDriver({env,ledger,db,fetch,now,log,gate:gateFor('base'),liveBroadcast});
 return drivers;
}

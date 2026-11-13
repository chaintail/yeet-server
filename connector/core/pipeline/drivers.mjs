// The driver table: one driver per origin chain (driver-interface.mjs). Solana (package A) and Base (package B,
// pipeline/base/driver.mjs behind pipeline/base/leg-driver.mjs).
import {createSolanaDriver} from './solana/driver.mjs';
import {createRelayRpc} from './solana/relay-rpc.mjs';
import {createRpcSignatureStatus} from './solana/signature-status.mjs';
import {feePayerFromEnv} from './solana/fee-payer.mjs';
import {createFeePayerFloor,floorFromEnv} from './solana/fee-payer-floor.mjs';
import {readSponsorshipLimits} from './solana/sponsorship.mjs';
import {createBaseLegDriver} from './base/leg-driver.mjs';

/** `gateFor(chain)` returns the live gate for that chain (pipeline.mjs liveGate). `overrides` replace any built part
 * (tests, the operator tool): {rpc, signatureStatus, historySignatureStatus, feePayer, floor, sol, base, baseRpc, baseLoadWallet}. */
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
 // Package B through the review-finding-8 adapter: only a confirmed transfer is answered as `sent`.
 drivers.base=overrides.base??createBaseLegDriver({db,ledger,env,now,log,gate:gateFor('base'),liveBroadcast,rpc:overrides.baseRpc,loadWallet:overrides.baseLoadWallet});
 return drivers;
}

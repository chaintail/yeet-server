// Base path configuration: the user's own wallet signs a plain USDC transfer to the 1Click deposit address and our gas
// wallet tops up the ETH for that transfer just in time.
// Lifted from Folio apps/server/src/bridge/config.ts @70848f097 (FOLIO_<CHAIN>_GAS_WALLET, FOLIO_<CHAIN>_GAS_WALLET_KEY,
// FOLIO_BRIDGE_PAUSE_<CHAIN>, FOLIO_BRIDGE_TOPUP_CAP_<CHAIN>_RAW), renamed to YEET_BASE_*. The key is a file path
// (mode 0600), never an env value. Everything Folio-specific (sweeps, principal caps, Arc, scan pages) is stripped.
//   BASE_RPC_URL                       Base JSON-RPC endpoint (shared with trade/wallets.mjs)
//   YEET_BASE_GAS_WALLET               gas wallet address; must equal the address derived from the key file
//   YEET_BASE_GAS_WALLET_KEY_FILE      key file (default ~/.local/state/yeet/keys/base-gas-wallet.key)
//   YEET_BASE_PAUSE                    1/true: no top-up, no broadcast, no replay           -> SOURCE_PAUSED
//   YEET_BASE_TOPUP_CAP_RAW            per user wallet, cumulative wei (default 0.0001 ETH)  -> TOPUP_CAP_EXCEEDED
//   YEET_BASE_TOPUP_GLOBAL_DAILY_RAW   all wallets, wei per UTC day (default 0.001 ETH)      -> TOPUP_CAP_EXCEEDED
//   YEET_BASE_GAS_FLOOR_RAW            gas wallet balance kept after a top-up (0.0005 ETH)   -> TOPUP_UNAVAILABLE
//   YEET_BASE_MAX_FEE_WEI              maxFeePerGas cap for both transactions (0.1 gwei)     -> INVALID_TRANSACTION_BUDGET
//   YEET_BASE_TOPUP_REPLACE_MAX_FEE_WEI  maxFeePerGas ceiling for replacing a stuck top-up (1 gwei)
//   YEET_BASE_MODE                     7702 | legacy (default legacy): 7702 = one Calibur batch per basket, sent and
//                                      paid by the gas wallet (BASE-7702-PRODUCTION-PLAN.md); legacy = per-leg transfers
//   YEET_BASE_BATCH_MAX_COST_WEI       max cost of one batch transaction, gas x maxFee + L1 bound (2e13 wei)
//   YEET_BASE_DEPOSIT_SEEN_MS          a 7702 leg still PENDING_DEPOSIT this long after landing -> auto legacy (300000)
export const STUCK_TOPUP_ALERT_AFTER=3;
import os from 'node:os';
import path from 'node:path';

export const BASE_CHAIN_ID=8453;
/** Base USDC (Circle), pinned. The only contract a user transfer may call. */
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const TRANSFER_SELECTOR='0xa9059cbb';// transfer(address,uint256)
export const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';// Transfer(address,address,uint256)
export const TOPUP_GAS=21_000n;
/** A top-up to a Calibur-delegated wallet runs Calibur's receive(): 21000 is too little (plan 2.7). */
export const TOPUP_GAS_DELEGATED=40_000n;
/** 7702 batch gas ceiling after the +25% margin: 150000 + 45000 per leg. The plan said 120000 + 45000N; a mainnet
 * eth_estimateGas of a first (type-4) trade to fresh deposit addresses gives 167859 for 1 leg and 207440 for 2, so the
 * base is 150000 (plan "Deviations"). */
export const BATCH_GAS_BASE=150_000n;
export const BATCH_GAS_PER_LEG=45_000n;
export const MAX_BATCH_LEGS=5;
export const BASE_MODES=Object.freeze(['7702','legacy']);
/** Guard 7: the user's transfer may carry at most this gas limit. */
export const MAX_USER_GAS=100_000n;
export const SIGN_WINDOW_MS=10*60_000;
/** Nothing is signed for, or broadcast, closer than this to the 1Click deposit deadline. */
export const DEADLINE_MARGIN_MS=120_000;
export const MAX_FAILED_TOPUPS=3;
/** Guard 10 (new, Folio has none): top-ups per account per UTC day. */
export const MAX_TOPUPS_PER_ACCOUNT_DAY=10;
/** Folio SOURCE_REBROADCAST_INTERVAL_MS: an unmined top-up older than this is replaced at its nonce (+12.5% fees). */
export const REBROADCAST_INTERVAL_MS=30_000;
export const DEFAULT_KEY_FILE=path.join(os.homedir(),'.local','state','yeet','keys','base-gas-wallet.key');

const ADDR=/^0x[0-9a-fA-F]{40}$/;
const on=v=>['1','true','on','yes'].includes(String(v??'').trim().toLowerCase());
function wei(env,name,fallback){
 const v=String(env[name]??'').trim()||fallback;
 if(!/^[1-9][0-9]{0,30}$/.test(v))throw Error(`Invalid ${name}`);
 return BigInt(v);
}
/** Reads the Base settings; throws on a malformed value (the driver turns that into GAS_WALLET_NOT_CONFIGURED). */
export function readBaseConfig(env=process.env){
 const gw=String(env.YEET_BASE_GAS_WALLET??'').trim();
 if(gw&&!ADDR.test(gw))throw Error('Invalid YEET_BASE_GAS_WALLET');
 // Unset = legacy: the 7702 batch path is switched on explicitly (deviation from the plan's code default, see plan).
 const mode=String(env.YEET_BASE_MODE??'').trim().toLowerCase()||'legacy';
 if(!BASE_MODES.includes(mode))throw Error('Invalid YEET_BASE_MODE (7702|legacy)');
 const seen=String(env.YEET_BASE_DEPOSIT_SEEN_MS??'').trim()||'300000';
 if(!/^[1-9][0-9]{3,8}$/.test(seen))throw Error('Invalid YEET_BASE_DEPOSIT_SEEN_MS');
 return Object.freeze({
  mode,
  batchMaxCostWei:wei(env,'YEET_BASE_BATCH_MAX_COST_WEI','20000000000000'),
  depositSeenMs:Number(seen),
  rpcUrl:String(env.BASE_RPC_URL??'').trim()||null,
  gasWallet:gw?gw.toLowerCase():null,
  keyFile:String(env.YEET_BASE_GAS_WALLET_KEY_FILE??'').trim()||DEFAULT_KEY_FILE,
  paused:on(env.YEET_BASE_PAUSE),
  topupCapRaw:wei(env,'YEET_BASE_TOPUP_CAP_RAW','100000000000000'),
  globalDailyRaw:wei(env,'YEET_BASE_TOPUP_GLOBAL_DAILY_RAW','1000000000000000'),
  floorRaw:wei(env,'YEET_BASE_GAS_FLOOR_RAW','500000000000000'),
  maxFeeWei:wei(env,'YEET_BASE_MAX_FEE_WEI','100000000'),
  // Review finding 4: a stuck top-up is replaced up to this higher ceiling (still inside guards 9 and 10), so one
  // top-up signed just before a fee spike cannot hold guard 12 for every wallet until fees fall.
  replaceMaxFeeWei:wei(env,'YEET_BASE_TOPUP_REPLACE_MAX_FEE_WEI','1000000000'),
 });
}

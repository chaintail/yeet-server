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
import os from 'node:os';
import path from 'node:path';

export const BASE_CHAIN_ID=8453;
/** Base USDC (Circle), pinned. The only contract a user transfer may call. */
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const TRANSFER_SELECTOR='0xa9059cbb';// transfer(address,uint256)
export const TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';// Transfer(address,address,uint256)
export const TOPUP_GAS=21_000n;
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
 return Object.freeze({
  rpcUrl:String(env.BASE_RPC_URL??'').trim()||null,
  gasWallet:gw?gw.toLowerCase():null,
  keyFile:String(env.YEET_BASE_GAS_WALLET_KEY_FILE??'').trim()||DEFAULT_KEY_FILE,
  paused:on(env.YEET_BASE_PAUSE),
  topupCapRaw:wei(env,'YEET_BASE_TOPUP_CAP_RAW','100000000000000'),
  globalDailyRaw:wei(env,'YEET_BASE_TOPUP_GLOBAL_DAILY_RAW','1000000000000000'),
  floorRaw:wei(env,'YEET_BASE_GAS_FLOOR_RAW','500000000000000'),
  maxFeeWei:wei(env,'YEET_BASE_MAX_FEE_WEI','100000000'),
 });
}

// GET /version: what this deployment runs, for anyone (no secret, no internal host name).
//   server_commit    YEET_SERVER_COMMIT, baked into the image at build time (ops/Dockerfile SERVER_COMMIT)
//   yeet_win_commit  the vendored yeet-win pin (vendor/yeet-win/PINNED)
//   trading          'live' only when YEET_LIVE=1 and the kill switch is off
//   limits           the same values limits.mjs enforces
//   catalog_coins    tradable coins in the vendored catalogue (coins.mjs)
import {readFileSync} from 'node:fs';
import {limitsFromEnv} from './trade/limits.mjs';
import {formatUnits} from './trade/router.mjs';
import {tradable} from './coins.mjs';

const SHA=/^[0-9a-f]{7,40}$/;
export function vendoredPin(text=readFileSync(new URL('../vendor/yeet-win/PINNED',import.meta.url),'utf8')){
 const sha=text.match(/^commit: ([0-9a-f]{40})$/m)?.[1];
 if(!sha)throw Error('vendor/yeet-win/PINNED has no commit');
 return sha;
}
export function versionInfo(env=process.env){
 const limits=limitsFromEnv(env);
 const commit=String(env.YEET_SERVER_COMMIT??'').trim();
 return {
  service:'yeet',
  server_commit:SHA.test(commit)?commit:null,
  yeet_win_commit:vendoredPin(),
  trading:limits.live&&!limits.killSwitch?'live':'paused',
  limits:{max_trade_usdc:formatUnits(limits.maxTradeRaw,6),daily_cap_usdc:formatUnits(limits.dailyCapRaw,6),min_leg_usdc:formatUnits(limits.minLegRaw,6),
   tiers:limits.tiers.map(t=>({name:t.name,min_xp:t.minXp,max_trade_usdc:formatUnits(t.maxTradeRaw,6),daily_cap_usdc:formatUnits(t.dailyCapRaw,6)}))},
  catalog_coins:tradable().length,
 };
}

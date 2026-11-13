#!/usr/bin/env node
// Dry run of a Base EIP-7702 basket through the production batch driver (BASE-7702-PRODUCTION-PLAN.md 2.10), against
// a real Base RPC, with a throwaway key as the person. Simulation only: no key file is read, nothing is signed by a
// gas wallet, nothing is sent (the RPC adapter's broadcast gate is closed and broadcast throws).
//   node ops/base-7702-basket-dry.mjs [--legs 2] [--usdc 3] [--delegated] [--gas-wallet 0x..] [--rpc URL]
// --legs 1..5; --usdc per leg (default 3, the minimum leg); --delegated simulates a later trade (the person's code is
// overridden to the Calibur designator: type 2, no authorization). --gas-wallet (or $YEET_BASE_GAS_WALLET) is the
// executor and simulated sender; default a throwaway address. RPC: --rpc, then $BASE_RPC_URL, then
// https://mainnet.base.org (needs eth_simulateV1 with state overrides). One JSON summary on stdout; never a key.
import {dryRunBasket} from '../connector/core/pipeline/base/basket-dry-run.mjs';
import {safeError} from '../connector/core/pipeline/base/safe-error.mjs';

const argv=process.argv.slice(2);
const arg=n=>{const i=argv.indexOf(`--${n}`);return i>=0?argv[i+1]:undefined};
const die=(code,msg)=>{console.log(JSON.stringify({ok:false,error:msg}));process.exit(code)};
const legs=Number(arg('legs')??2);
if(!Number.isInteger(legs)||legs<1||legs>5)die(2,'--legs must be 1..5');
const usdc=String(arg('usdc')??'3');
if(!/^\d{1,4}(\.\d{1,6})?$/.test(usdc))die(2,'--usdc: USDC per leg, at most 6 decimals');
const amountRaw=(([w,f=''])=>BigInt(w)*1_000_000n+BigInt(f.padEnd(6,'0')))(usdc.split('.'));
const gasWallet=arg('gas-wallet')??(String(process.env.YEET_BASE_GAS_WALLET??'').trim()||undefined);
if(gasWallet&&!/^0x[0-9a-fA-F]{40}$/.test(gasWallet))die(2,'--gas-wallet: an address');
const url=arg('rpc')||String(process.env.BASE_RPC_URL??'').trim()||'https://mainnet.base.org';
try{
 const out=await dryRunBasket({url:url,legs,amountRaw,delegated:argv.includes('--delegated'),gasWallet});
 const sim=out.simulation??{};
 out.ok=out.state==='pending'&&sim.legs_transferred===legs&&(sim.legs??[]).every(l=>l.ok);
 console.log(JSON.stringify({...out,rpc:url.replace(/\/\/([^/]+)\/.+$/,'//$1/…')},null,1));
 process.exit(out.ok?0:1);
}catch(e){die(1,e?.name==='TradeError'?`${e.code}${e.detail?': '+e.detail:''}`:safeError(e))}

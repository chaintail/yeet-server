#!/usr/bin/env node
// A user-signed YEET trade from the box, without the ChatGPT widget (design section 4). The pipeline the server runs is
// built in this process with the local test wallet (ops/test-wallet-init.mjs) as the person's wallet.
//   node ops/user-signed-trade.mjs --chain sol --side buy --coin '$WIF' --usdc 5 [--local-fee-payer]
//   node ops/user-signed-trade.mjs --chain sol --side sell --coin '$WIF' [--percent 100]
//      DRY (default): live 1Click quote, sign request, the test wallet signs, the server checks every guard and runs a
//      signature-free simulateTransaction. Nothing is co-signed, nothing is sent. --local-fee-payer uses a throwaway
//      fee payer key in process (dry only) when the Privy fee payer is not configured here.
//   --broadcast   the real thing: refused unless YEET_LIVE=1, YEET_KILL_SWITCH off and --account (default
//      yeet-privy-operator-test-wallet) is in YEET_LIVE_ACCOUNTS in this shell; the fee payer is the Privy wallet from
//      YEET_SOL_FEE_PAYER_ID / _ADDRESS; follows the trade up to --follow-s seconds. Records in --db (default
//      ~/.local/state/yeet/user-signed-trade.sqlite).
// Env read: ONECLICK_JWT, SOLANA_RPC_URL, BASE_RPC_URL, PRIVY_*, YEET_SOL_FEE_PAYER_*, YEET_SPONSOR_*, the caps. Output: one
// JSON line per step; never keys or env values. --chain base needs the Base driver (package B) and its evm_tx signer.
import {homedir} from 'node:os';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {parseArgs,runUserSignedTrade} from '../connector/core/pipeline/operator-trade.mjs';
import {loadTestWallet} from '../connector/core/pipeline/test-wallet.mjs';

let opts;
try{opts=parseArgs(process.argv.slice(2))}catch(e){process.stderr.write(`usage: ${e.message}\n`);process.exit(2)}
const walletPath=opts.wallet??join(homedir(),'.secrets','yeet-test-wallet.json');
if(opts.broadcast&&!opts.db){const dir=join(homedir(),'.local','state','yeet');mkdirSync(dir,{recursive:true,mode:0o700});opts.db=join(dir,'user-signed-trade.sqlite')}
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
try{
 const wallet=loadTestWallet(walletPath);
 const r=await runUserSignedTrade({opts,wallet,emit});
 emit({step:'done',...r});
 process.exitCode=opts.broadcast?(r.status==='success'?0:1):(r.results.length&&r.results.every(x=>x.state)?0:1);
}catch(e){
 emit({step:'refused',code:e?.code??null,message:String(e?.detail??e?.message??e).slice(0,200)});
 process.exitCode=1;
}

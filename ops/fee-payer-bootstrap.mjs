#!/usr/bin/env node
// Creates the YEET Solana fee payer (Privy server wallet + sign-only policy), Folio's fee-payer-bootstrap.ts ported
// (connector/core/pipeline/solana/fee-payer-bootstrap.mjs).
//   node ops/fee-payer-bootstrap.mjs --dry-run   print the policy body; calls nothing
//   node ops/fee-payer-bootstrap.mjs --create    create (idempotent per app + policy hash), read back, print the env lines
// Env: PRIVY_APP_ID, PRIVY_APP_SECRET, YEET_PRIVY_AUTHORIZATION_KEY. Provider answers, credentials and stacks never
// reach the terminal: a failure prints its code only.
import {privyConfig,createPrivyApi} from '../connector/core/trade/privy-api.mjs';
import {canonical} from '../connector/core/trade/util.mjs';
import {bootstrapBody,bootstrapFeePayer} from '../connector/core/pipeline/solana/fee-payer-bootstrap.mjs';

const args=process.argv.slice(2);
if(args.length!==1||!['--dry-run','--create'].includes(args[0])){process.stderr.write('usage: node ops/fee-payer-bootstrap.mjs --dry-run|--create\n');process.exit(2)}
try{
 const config=privyConfig(process.env);
 if(!config)throw Object.assign(Error('PRIVY_NOT_CONFIGURED'),{code:'PRIVY_NOT_CONFIGURED'});
 if(args[0]==='--dry-run')process.stdout.write(canonical(bootstrapBody(config))+'\n');
 else process.stdout.write((await bootstrapFeePayer(config,createPrivyApi({config,timeoutMs:15_000}))).env);
}catch(e){
 const code=/^[A-Z0-9_]+$/.test(e?.code??'')?e.code:'FEE_PAYER_BOOTSTRAP_FAILED';
 process.stderr.write(`${code}\n`);
 process.exitCode=1;
}

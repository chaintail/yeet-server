#!/usr/bin/env node
// Creates the local test wallet (design section 4): one Ed25519 key (Solana) and one secp256k1 key (Base) in
// ~/.secrets/yeet-test-wallet.json, mode 0600, directory 0700. Refuses to overwrite. Prints the two addresses only.
//   node ops/test-wallet-init.mjs [--path <file>]
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createTestWalletFile} from '../connector/core/pipeline/test-wallet.mjs';

const args=process.argv.slice(2);
const i=args.indexOf('--path');
const path=i>=0?args[i+1]:join(homedir(),'.secrets','yeet-test-wallet.json');
if(!path||args.length!==(i>=0?2:0)){process.stderr.write('usage: node ops/test-wallet-init.mjs [--path <file>]\n');process.exit(2)}
try{
 const {solana,base}=createTestWalletFile(path);
 process.stdout.write(`solana ${solana}\nbase ${base}\nfile ${path} (mode 600)\n`);
}catch(e){
 process.stderr.write(e?.code==='EEXIST'?`refused: ${path} exists (never overwritten)\n`:`failed: ${e?.code??'TEST_WALLET_INIT_FAILED'}\n`);
 process.exit(1);
}

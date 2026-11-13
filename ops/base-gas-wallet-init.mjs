#!/usr/bin/env node
// Creates the Base gas wallet key (GAS-SPONSORSHIP-DESIGN.md 1.3): 32 bytes from node:crypto, checked as a secp256k1
// scalar, written with flag wx and mode 0600 to ~/.local/state/yeet/keys/base-gas-wallet.key (directory 0700). It
// refuses to overwrite an existing key and prints the address only; the key is never printed or logged.
//   node ops/base-gas-wallet-init.mjs [--file <path>]     default: $YEET_BASE_GAS_WALLET_KEY_FILE or the path above
// Then set YEET_BASE_GAS_WALLET=<address> and YEET_BASE_GAS_WALLET_KEY_FILE=<path> for the core service, and fund the
// address with Base ETH (design 5.4: 0.002 ETH).
import {createGasWalletKey,gasWalletAddress} from '../connector/core/pipeline/base/gas-wallet.mjs';
import {DEFAULT_KEY_FILE} from '../connector/core/pipeline/base/config.mjs';

const i=process.argv.indexOf('--file');
const file=(i>0?process.argv[i+1]:'')||process.env.YEET_BASE_GAS_WALLET_KEY_FILE?.trim()||DEFAULT_KEY_FILE;
try{
 const {address}=createGasWalletKey(file);
 console.log(JSON.stringify({created:true,address,file,mode:'0600'}));
}catch(e){
 if(e?.code!=='EEXIST'){console.error(JSON.stringify({created:false,error:e?.code??String(e?.message??e).slice(0,120)}));process.exit(1)}
 let address=null;try{address=gasWalletAddress(file)}catch(err){address=`unreadable: ${err.code??'error'}`}
 console.error(JSON.stringify({created:false,error:'KEY_EXISTS',file,address}));
 process.exit(1);
}

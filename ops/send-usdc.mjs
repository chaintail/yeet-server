#!/usr/bin/env node
// Sends plain USDC on Solana from a local wallet file to one address: the operator's way to prove a deposit address
// (docs/LEDGER-ROUTE.md 6.3). One SPL transfer, nothing else. JSON lines; never a key, a seed or an env value.
//
//   node ops/send-usdc.mjs --to <solana address> --usdc 1 --wallet <file> [--fee-payer self|privy] [--state <file>]
//     DRY (default): reads the wallet's USDC and whether the receiving token account exists, builds and signs the
//     transfer, and prints what it would send. Nothing is broadcast.
//   YEET_SEND_USDC_CONFIRM=send-usdc node ops/send-usdc.mjs … --broadcast
//     The real transfer. Refused without that environment value. At most --max-usdc (default 5; never over 25).
//     The signed transaction is saved to --state BEFORE it is broadcast, so a second run follows the same transfer
//     instead of paying again; a transfer that already landed for the same address and amount is refused unless
//     --again is given.
//   --fee-payer privy: the YEET fee payer co-signs and pays the fee and the token account rent (its variables must be
//     in the environment, as for ops/intents-direct-spike.mjs). self: the wallet pays them in SOL.
//   --state defaults to <wallet file>.send-usdc.json next to the wallet (mode 0600).
// Env read: SOLANA_RPC_URL, SOLANA_BROADCAST_RPC_URL (optional), YEET_SEND_USDC_CONFIRM, the fee payer variables.
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {parseUnits,formatUnits} from '../connector/core/trade/router.mjs';
import {signedTokenTransfer} from '../connector/core/intents/funding.mjs';
import {isAddress} from '../connector/core/pipeline/solana/message.mjs';

export const CONFIRM='send-usdc',HARD_MAX_USDC=25;
const VALUE=new Set(['--to','--usdc','--wallet','--fee-payer','--state','--max-usdc']),FLAG=new Set(['--broadcast','--again']);
export function parseArgs(argv){
 const o={to:null,usdc:null,wallet:null,feePayer:'self',state:null,maxUsdc:'5',broadcast:false,again:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(FLAG.has(a)){o[a.slice(2)]=true;continue}
  if(!VALUE.has(a))throw Error(`unknown argument ${a}`);
  const v=argv[++i];
  if(v===undefined||v.startsWith('--'))throw Error(`${a} needs a value`);
  o[a==='--fee-payer'?'feePayer':a==='--max-usdc'?'maxUsdc':a.slice(2)]=v;
 }
 if(!o.to||!isAddress(o.to))throw Error('--to is the Solana address to send to');
 for(const k of ['usdc','maxUsdc'])if(!/^\d{1,4}(\.\d{1,6})?$/.test(o[k]??'')||!(Number(o[k])>0))throw Error(`--${k==='usdc'?'usdc':'max-usdc'} is a positive amount like 1`);
 if(Number(o.maxUsdc)>HARD_MAX_USDC)throw Error(`--max-usdc is at most ${HARD_MAX_USDC}`);
 if(Number(o.usdc)>Number(o.maxUsdc))throw Error(`--usdc ${o.usdc} is over --max-usdc ${o.maxUsdc}`);
 if(!o.wallet)throw Error('--wallet is the wallet file');
 if(!['self','privy'].includes(o.feePayer))throw Error('--fee-payer is self or privy');
 return o;
}
/**
 * The run. deps = {wallet: {address, signTransaction} (the Solana side of the wallet file), rpc (relay-rpc.mjs),
 * signatureStatus, feePayer (null: the wallet pays), state (object), save(), emit, sleep, now}. Returns the exit code.
 */
export async function runSend(o,{wallet,rpc,signatureStatus,feePayer=null,state,save,emit,confirm,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 const amount=parseUnits(o.usdc,6);
 if(o.to===wallet.address)throw Error('--to is the wallet itself');
 if(feePayer&&o.to===feePayer.address)throw Error('--to is the fee payer');
 const same=state.to===o.to&&state.amount===amount.toString()&&state.from===wallet.address;
 // ---- a transfer of an earlier run for the same address and amount: follow it, never pay again ----
 if(same&&state.solana_tx&&!state.failed){
  const s=await signatureStatus(state.solana_tx);
  if(['confirmed','finalized'].includes(s.status)){
   state.confirmed=true;save();
   if(!o.again){emit({step:'send',stage:'already_sent',solana_tx:state.solana_tx,to:o.to,usdc:o.usdc,note:'this transfer already landed; pass --again to send the same amount once more'});return 0}
  }else if(s.status==='failed'){state.failed=true;save()}
  else if(await rpc.blockhashValid(state.blockhash,state.lastValidBlockHeight)){
   if(!o.broadcast){emit({step:'send',stage:'pending',solana_tx:state.solana_tx,note:'an earlier transfer is still on its way; run with --broadcast to follow it'});return 0}
   return follow(o,{rpc,signatureStatus,state,save,emit,sleep,now});
  }
 }
 const {blockhash,lastValidBlockHeight}=await rpc.latestBlockhash();
 const t=await signedTokenTransfer({rpc,wallet,to:o.to,amount,feePayer,blockhash});
 if(!feePayer){
  const lamports=await rpc.balance(wallet.address);
  if(lamports<t.lamportsNeeded)throw Error(`the wallet needs ${t.lamportsNeeded} lamports for this transfer (fee${t.createsAccount?' and the receiving token account rent':''}) and has ${lamports}; fund it with SOL or pass --fee-payer privy`);
 }
 const plan={from:wallet.address,to:o.to,usdc:formatUnits(amount,6),amount_raw:amount.toString(),fee_payer:feePayer?'privy':'self',creates_token_account:t.createsAccount,solana_tx:t.signature};
 if(!o.broadcast){emit({step:'send',stage:'dry',...plan,sent:'nothing',note:`to send it: ${'YEET_SEND_USDC_CONFIRM'}=${CONFIRM} and --broadcast`});return 0}
 if(confirm!==CONFIRM){emit({step:'refused',reason:`--broadcast moves real funds: set YEET_SEND_USDC_CONFIRM=${CONFIRM} in the environment to run it`});return 1}
 // saved BEFORE anything is broadcast
 for(const k of Object.keys(state))delete state[k];
 Object.assign(state,{version:1,from:wallet.address,to:o.to,amount:amount.toString(),solana_tx:t.signature,signed_base64:Buffer.from(t.bytes).toString('base64'),blockhash,lastValidBlockHeight,signed_at:new Date(now()).toISOString()});
 save();
 emit({step:'send',stage:'signed',...plan});
 return follow(o,{rpc,signatureStatus,state,save,emit,sleep,now});
}
async function follow(o,{rpc,signatureStatus,state,save,emit,sleep,now}){
 try{await rpc.broadcast(Buffer.from(state.signed_base64,'base64'))}
 catch(e){
  const message=String(e?.rpcError?.message??e?.message??e).slice(0,300);
  if(e?.rpcError&&!/already been processed|AlreadyProcessed/i.test(message)){state.failed=true;save();throw Error(`Solana refused the transfer before sending: ${message}`)}
  emit({step:'send',stage:'broadcast_uncertain',message});
 }
 emit({step:'send',stage:'sent',solana_tx:state.solana_tx,to:state.to,usdc:formatUnits(BigInt(state.amount),6)});
 for(const t0=now();now()-t0<90_000;){
  const s=await signatureStatus(state.solana_tx);
  if(s.status==='failed'){state.failed=true;save();throw Error(`Solana transfer ${state.solana_tx} failed on chain`)}
  if(['confirmed','finalized'].includes(s.status)){state.confirmed=true;save();emit({step:'done',ok:true,solana_tx:state.solana_tx,explorer:`https://solscan.io/tx/${state.solana_tx}`});return 0}
  if(s.status==='not_found'&&!(await rpc.blockhashValid(state.blockhash,state.lastValidBlockHeight))){state.failed=true;save();throw Error('the transfer expired before it landed: nothing was sent; run again')}
  await sleep(2000);
 }
 emit({step:'done',ok:false,solana_tx:state.solana_tx,reason:'not confirmed yet; run the same command again to follow it (it will not pay twice)'});
 return 3;
}
const out=o=>process.stdout.write(JSON.stringify(o)+'\n');
async function main(){
 let o;
 try{o=parseArgs(process.argv.slice(2))}catch(e){process.stderr.write(`usage: ${e.message}\n`);return 2}
 const {loadTestWallet}=await import('../connector/core/pipeline/test-wallet.mjs');
 const {createRelayRpc}=await import('../connector/core/pipeline/solana/relay-rpc.mjs');
 const {createRpcSignatureStatus}=await import('../connector/core/pipeline/solana/signature-status.mjs');
 const {feePayerFromEnv}=await import('../connector/core/pipeline/solana/fee-payer.mjs');
 const {SOLANA_RPC_DEFAULT}=await import('../connector/core/intents/constants.mjs');
 const env=process.env,wallet=loadTestWallet(o.wallet).solana;
 const solUrl=env.SOLANA_RPC_URL?.trim()||SOLANA_RPC_DEFAULT;
 const rpc=createRelayRpc({readUrl:solUrl,broadcastUrl:env.SOLANA_BROADCAST_RPC_URL?.trim()||solUrl});
 let feePayer=null;
 if(o.feePayer==='privy'){feePayer=feePayerFromEnv(env);if(!feePayer)throw Error('--fee-payer privy needs the YEET fee payer variables in the environment')}
 const statePath=o.state??`${o.wallet}.send-usdc.json`;
 const state=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{};
 const save=()=>{const tmp=`${statePath}.tmp`;writeFileSync(tmp,JSON.stringify(state,null,1)+'\n',{mode:0o600});renameSync(tmp,statePath)};
 return runSend(o,{wallet,rpc,signatureStatus:createRpcSignatureStatus({endpoint:solUrl}),feePayer,state,save,emit:out,confirm:env.YEET_SEND_USDC_CONFIRM});
}
if(import.meta.url===`file://${process.argv[1]}`){
 main().then(code=>{process.exitCode=code},e=>{out({step:'failed',message:String(e?.message??e).slice(0,300)});process.exitCode=1});
}

// The user-signed trade, run by an operator without the widget (design section 4; ops/user-signed-trade.mjs is the CLI).
// It builds the same pipeline the server runs, in process, with the local test wallet injected as the wallet
// directory, then: propose (BUY) or skeet (SELL) -> execute -> sign every sign request with the test wallet's key ->
// submit_trade_signature. Dry by default (Folio's default, source-executor.ts:68): the bytes are validated and
// simulated, nothing is co-signed, nothing is sent. `broadcast` is refused unless YEET_LIVE=1, the kill switch is off
// and the account is listed in YEET_LIVE_ACCOUNTS in the operator's own environment.
// Output: one JSON object per step through `emit`; addresses, ids and amounts only, never keys or env values.
import {limitsFromEnv} from '../trade/limits.mjs';
import {openTradeDb} from '../trade/db.mjs';
import {CATALOG} from '../trade/router.mjs';
import {createPipeline} from './pipeline.mjs';
import {staticWalletDirectory} from './wallet-directory.mjs';
import {localSigner} from './solana/verify.mjs';
import {privateKeyToAccount} from 'viem/accounts';
import {txFromPayload} from './base/source-executor.mjs';

export const OPERATOR_ACCOUNT='yeet-privy-operator-test-wallet';
export const OPERATOR_CLIENT='yeet-operator-tool';
const CHAINS=['sol','base'],SIDES=['buy','sell'];
const TERMINAL=['success','partial','failed','refunded','expired'];

/** `--chain sol --side buy --coin '$WIF' --usdc 5 [--percent 100] [--broadcast] [--local-fee-payer] [--account id]`. */
export function parseArgs(argv){
 const o={chain:'sol',side:'buy',coin:null,usdc:null,percent:100,broadcast:false,localFeePayer:false,account:OPERATOR_ACCOUNT,wallet:null,db:null,followS:600};
 const take=(i,name)=>{const v=argv[i+1];if(v===undefined||v.startsWith('--'))throw Error(`${name} needs a value`);return v};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--broadcast')o.broadcast=true;
  else if(a==='--local-fee-payer')o.localFeePayer=true;
  else if(['--chain','--side','--coin','--usdc','--percent','--account','--wallet','--db','--follow-s'].includes(a)){
   const v=take(i,a);i++;
   const k={'--follow-s':'followS'}[a]??a.slice(2);
   o[k]=['--percent','--follow-s'].includes(a)?Number(v):v;
  }else throw Error(`unknown argument ${a}`);
 }
 if(!CHAINS.includes(o.chain))throw Error('--chain is sol or base');
 if(!SIDES.includes(o.side))throw Error('--side is buy or sell');
 if(!o.coin)throw Error('--coin is required');
 if(o.side==='buy'&&!/^\d{1,4}(\.\d{1,6})?$/.test(o.usdc??''))throw Error('--usdc is required for a buy (e.g. 5)');
 if(!Number.isInteger(o.percent)||o.percent<1||o.percent>100)throw Error('--percent is 1..100');
 if(!Number.isInteger(o.followS)||o.followS<0||o.followS>3600)throw Error('--follow-s is 0..3600');
 if(o.broadcast&&o.localFeePayer)throw Error('--local-fee-payer is for dry runs only');
 if(o.side==='sell'&&o.chain==='base')throw Error('a sell pays out on Solana in this tool (--chain sol)');
 return o;
}

/** The catalogue symbol for `WIF` or the 1Click listing `$WIF`. */
export function coinSymbol(input,catalog=CATALOG){
 const s=String(input).trim().toUpperCase();
 const e=catalog.find(c=>c.chain==='solana'&&c.kind!=='funding'&&(c.symbol.toUpperCase()===s||c.listedSymbol?.toUpperCase()===s));
 if(!e||e.symbol==='USDC')throw Error(`unknown coin ${input}`);
 return e.symbol;
}

/** Refuses a broadcast unless the operator's environment has trading on for this account (design section 4). */
export function assertBroadcastAllowed(env,accountId){
 const l=limitsFromEnv(env);
 if(!l.live)throw Error('--broadcast needs YEET_LIVE=1');
 if(l.killSwitch)throw Error('--broadcast needs the kill switch off');
 if(!l.liveAccounts?.includes(accountId))throw Error('--broadcast needs the account listed in YEET_LIVE_ACCOUNTS');
}

/**
 * Runs one trade. `wallet` = loadTestWallet() result. `signers` maps a sign-request kind to fn(wallet, request) -> signed
 * string; the Base driver's package registers `evm_tx`. `overrides` reach createPipeline (tests: client, balances,
 * driverOverrides). Returns the final summary.
 */
export async function runUserSignedTrade({opts,wallet,env=process.env,emit=()=>{},signers={},overrides={},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const accountId=opts.account,ctx={accountId,clientId:OPERATOR_CLIENT};
 if(opts.broadcast)assertBroadcastAllowed(env,accountId);
 if(!/^yeet-privy-[A-Za-z0-9_-]{1,80}$/.test(accountId))throw Error('account id is not a yeet-privy-* id');
 // Dry: an in-process gate with trading on for this one account; nothing can be co-signed or sent (dryRun +
 // liveBroadcast false). Broadcast: the operator's own environment, unchanged.
 const runEnv={...env,YEET_BUY_CHAIN:opts.chain,YEET_SELL_CHAIN:opts.chain,
  ...(opts.broadcast?{}:{YEET_LIVE:'1',YEET_KILL_SWITCH:'0',YEET_LIVE_ACCOUNTS:accountId})};
 const driverOverrides={...(overrides.driverOverrides??{})};
 if(opts.localFeePayer&&driverOverrides.feePayer===undefined){
  const fp=localSigner();driverOverrides.feePayer={address:fp.address,signTransaction:async b=>fp.signTransaction(b)};
  emit({step:'fee_payer',local:true,address:fp.address});
 }
 const db=overrides.db??openTradeDb(opts.broadcast?opts.db:':memory:');
 const directory=staticWalletDirectory({[accountId]:{base:{address:wallet.base.address},solana:{address:wallet.solana.address}}});
 const events=[];
 const p=createPipeline({db,env:runEnv,directory,now,trackerIntervalMs:0,liveBroadcast:opts.broadcast,log:l=>events.push(l),...overrides,driverOverrides});
 const sign={solana_tx:(w,r)=>Buffer.from(w.solana.signTransaction(Buffer.from(r.payload.transaction_base64,'base64'))).toString('base64'),
  // Base: the test wallet's secp256k1 key signs the payload exactly as given (sign only), like the card's Privy wallet.
  evm_tx:async(w,r)=>privateKeyToAccount(`0x${Buffer.from(w.base.privateKey()).toString('hex')}`).signTransaction(txFromPayload(r.payload)),...signers};
 emit({step:'start',mode:opts.broadcast?'broadcast':'dry_run',chain:opts.chain,side:opts.side,account:accountId,solana_wallet:wallet.solana.address,base_wallet:wallet.base.address,
  drivers:Object.fromEntries(Object.entries(p.drivers).map(([c,d])=>[c,d.readiness()]))});

 const symbol=coinSymbol(opts.coin),request_id=`ust-${now()}`;
 const prop=opts.side==='buy'?await p.propose(ctx,{request_id,amount_usdc:opts.usdc,legs:[{symbol,parts:1}]}):await p.skeet(ctx,{request_id,legs:[{symbol,percent:opts.percent}]});
 const l0=prop.legs?.[0];
 emit({step:'proposed',proposal_id:prop.proposal_id,revision:prop.revision,symbol,amount_in:l0?.amount_in??null,est_out:l0?.est_out??null,cost_pct:prop.totals?.cost_pct??null});
 const x=await p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
 emit({step:'executed',trade_id:x.trade_id,status:x.status,sign_requests:(x.sign_requests??[]).map(r=>({leg:r.leg,kind:r.kind,wallet:r.wallet,to:r.summary.to,amount_raw:r.summary.amount_raw,asset:r.summary.asset,expires_at:r.expires_at}))});
 const results=[];
 for(const r of x.sign_requests??[]){
  const fn=sign[r.kind];
  if(!fn){emit({step:'sign',leg:r.leg,kind:r.kind,error:`no local signer for ${r.kind}`});results.push({leg:r.leg,state:'unsigned'});continue}
  const signed=await fn(wallet,r);
  const s=await p.submit(ctx,{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed},{dryRun:!opts.broadcast});
  const leg=s.legs.find(l=>l.leg===r.leg);
  emit({step:'submitted',leg:r.leg,send_status:leg?.send_status??null,tx_hash:leg?.tx_hash??null,
   ...(s.dry_run?{dry_run_state:s.dry_run.state,simulation_err:s.dry_run.simulation?.err??null,simulation_units:s.dry_run.simulation?.unitsConsumed??null,fee_lamports:s.dry_run.fee_lamports,rent_lamports:s.dry_run.rent_lamports}:{})});
  results.push({leg:r.leg,state:leg?.send_status??null,tx_hash:leg?.tx_hash??null});
 }
 let status=null;
 if(opts.broadcast&&x.trade_id){
  for(const t0=now();now()-t0<=opts.followS*1000;){
   await p.tracker.pollOnce();
   const st=p.status(ctx,x.trade_id);status=st.status;
   emit({step:'status',status,legs:st.legs.map(l=>({symbol:l.symbol,status:l.status,origin_tx:l.origin_tx??null}))});
   if(TERMINAL.includes(status))break;
   await sleep(5000);
  }
 }
 for(const e of events.filter(e=>/refus|failed|expired|invalid/i.test(e)))emit({step:'event',line:e.slice(0,240)});
 p.tracker.stop?.();
 return {trade_id:x.trade_id,results,status};
}

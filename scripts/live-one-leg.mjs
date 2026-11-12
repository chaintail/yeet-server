#!/usr/bin/env node
// Acceptance B-2: one real YEET leg end to end, with real funds. Not part of `npm test`; run by hand once funded.
//
//   YEET_LIVE=1 STATE_DIR=... PRIVY_APP_ID=... (see README "B-2") \
//   node scripts/live-one-leg.mjs --account yeet-privy-XXXX --usdc 3 --coin WIF --i-accept-real-funds [--out DIR] [--timeout-min 20]
//
// What it does, through the same engine the connector uses (core/trade/engine.mjs, real 1Click, real Privy signer):
//   1. yeet_home for the account (must be `ready`: signer attached, USDC on Base)
//   2. yeet_propose with one coin at 10 parts (a dry quote)
//   3. execute_trade with the proposal's one-time code (live quote, one USDC transfer, submitDeposit)
//   4. polls 1Click /status until the leg is final, writes the receipt JSON, and prints the router replay command
// It refuses unless YEET_LIVE=1 and every flag above is given. Limits (YEET_MIN_LEG_USDC, YEET_MAX_TRADE_USDC,
// YEET_DAILY_CAP_USDC, YEET_MAX_COST_BPS, YEET_KILL_SWITCH) apply exactly as in the connector. Secrets are read from
// the environment by name and never printed.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const argv=process.argv.slice(2);
const flag=name=>argv.includes(name);
const value=name=>{const i=argv.indexOf(name);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:undefined};
const fail=(code,message)=>{console.error(`live-one-leg: ${message}`);process.exit(code)};

const account=value('--account'),usdc=value('--usdc'),coin=value('--coin');
const out=resolve(value('--out')??'receipts'),timeoutMin=Number(value('--timeout-min')??'20');
if(process.env.YEET_LIVE!=='1')fail(2,'refused: YEET_LIVE=1 is not set. This script moves real funds.');
if(!flag('--i-accept-real-funds'))fail(2,'refused: pass --i-accept-real-funds to confirm a real transfer.');
if(!account||!/^yeet-privy-[A-Za-z0-9_-]{1,80}$/.test(account))fail(2,'refused: --account yeet-privy-... is required (the owner\'s own signed-in account).');
if(!usdc||!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(usdc))fail(2,'refused: --usdc <amount> is required, e.g. --usdc 3');
if(!coin||!/^[A-Z0-9]{2,12}$/.test(coin))fail(2,'refused: --coin <SYMBOL> is required, e.g. --coin WIF');
if(!Number.isFinite(timeoutMin)||timeoutMin<1||timeoutMin>120)fail(2,'refused: --timeout-min must be 1-120');

const signer=process.env.YEET_SIGNER||'delegated';
const needed=['STATE_DIR','PRIVY_APP_ID','PRIVY_APP_SECRET','YEET_PRIVY_AUTHORIZATION_KEY','BASE_RPC_URL',...(signer==='delegated'?['YEET_PRIVY_KEY_QUORUM_ID']:[])];
const missing=needed.filter(n=>!process.env[n]?.trim());
if(missing.length)fail(2,`refused: set ${missing.join(', ')} (names only; values are never printed).`);

const connector=new URL('../connector/',import.meta.url);
const {initializeIdentityStore,account:findAccount,didFor}=await import(new URL('core/identity-store.mjs',connector));
const {openTradeDb}=await import(new URL('core/trade/db.mjs',connector));
const {createEngine}=await import(new URL('core/trade/engine.mjs',connector));
initializeIdentityStore({app:process.env.PRIVY_APP_ID});
if(!findAccount(account))fail(2,'refused: no such account for this Privy app (sign in once through the connector first).');

const engine=await createEngine({db:openTradeDb(),didFor,trackerIntervalMs:0});
const ctx={accountId:account,clientId:'yeet-live-one-leg'};
const step=(label,data)=>console.log(`${label}: ${JSON.stringify(data)}`);
try{
 const home=await engine.home(ctx);
 step('home',{ready:home.ready,base:home.wallets.base.address,usdc:home.wallets.base.usdc,solana:home.wallets.solana.address,signer});
 if(home.ready!=='ready')fail(3,`account is not ready (${home.ready})`);
 const {confirm,...proposal}=await engine.propose(ctx,{request_id:`live-one-leg-${Date.now()}`,amount_usdc:usdc,legs:[{symbol:coin,parts:10}]});
 step('proposal',{id:proposal.proposal_id,revision:proposal.revision,legs:proposal.legs,totals:proposal.totals,warnings:proposal.warnings});
 const result=await engine.execute(ctx,{proposal_id:proposal.proposal_id,revision:proposal.revision,confirm:confirm.code});
 if(result.status==='requote_required'){step('requote',result.requote);fail(4,'the price moved past the preview minimum; run again')}
 step('submitted',{trade:result.trade_id,legs:result.legs});
 const deadline=Date.now()+timeoutMin*60_000;let last;
 for(let delay=5_000;;delay=Math.min(30_000,Math.round(delay*1.5))){
  await engine.tracker.pollOnce();
  const s=engine.status(ctx,result.trade_id);
  if(s.status!==last){step('status',{status:s.status,legs:s.legs.map(l=>({symbol:l.symbol,status:l.status,out:l.amount_out,origin_tx:l.origin_tx,destination_tx:l.destination_tx}))});last=s.status}
  if(['success','partial','refunded','failed'].includes(s.status)&&!s.legs.some(l=>!['SUCCESS','REFUNDED','FAILED'].includes(l.status)))break;
  if(Date.now()>deadline){console.error('live-one-leg: timed out waiting for 1Click; the receipt so far is written below');break}
  await new Promise(r=>setTimeout(r,delay));
 }
 const row=engine.tracker.refresh(result.trade_id);
 mkdirSync(out,{recursive:true});
 const file=join(out,`${result.trade_id}.json`);
 writeFileSync(file,row.receipt_json+'\n');
 const cli=fileURLToPath(new URL('vendor/yeet-win/router/dist/src/cli.js',connector));
 console.log(`receipt: ${file}`);
 console.log(`check it against 1Click: node ${cli} replay ${file}`);
 process.exit(last==='success'?0:5);
}catch(e){
 fail(6,`stopped with ${e?.code??'an unexpected error'}${e?.detail?` (${e.detail})`:''}`);
}

#!/usr/bin/env node
// Operator tool for a supervised real YEET trade, started from the box without ChatGPT (runbook: ops/FIRST-TRADE.md).
//
//   node ops/first-trade.mjs [--plan] --did-suffix <privy did tail> | --account yeet-privy-... [--coin WIF] [--usdc 5]
//        [--slippage 100] [--self-gas] [--expect-base 0x...] [--container yeet-core-1]
//      Safe, changes nothing: resolves the account, Base USDC/ETH from public RPC, wallets, signer and policies from the
//      Privy API, the flags, a real DRY 1Click quote, whether core answers the operator routes. Prints a plan id.
//   YEET_OPERATOR_CONFIRM=<plan id> node ops/first-trade.mjs --live <same arguments> [--timeout-min 30]
//      Refuses unless the env equals the plan id of the latest --plan run (at most 15 minutes old, same arguments, no
//      failed blocking check, not used before) and the stack reports trading enabled for this account. Then, through
//      core's own executor: propose (request_id = plan id), execute with the minted one-time code, and one line per
//      state change until final. Receipt JSON under ~/.local/state/yeet/receipts/.
//   node ops/first-trade.mjs --watch <trade id> --account yeet-privy-...   follow a trade already started
//
// The container side (ops/first-trade-core.mjs) is piped into node inside the core container with one docker exec;
// the core-operator secret and every other secret stay inside the container and are never printed.
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';

const STATE=join(homedir(),'.local/state/yeet');
const PLANS=join(STATE,'first-trade'),RECEIPTS=join(STATE,'receipts');
const HELPER=new URL('./first-trade-core.mjs',import.meta.url);
const PLAN_TTL_MS=15*60_000,MAX_DRIFT_BPS=300;
const PUBLIC_VERSION='https://chatgpt.yeet.win/version';

const argv=process.argv.slice(2);
const has=f=>argv.includes(f);
const val=(f,d)=>{const i=argv.indexOf(f);return i>=0&&argv[i+1]&&!argv[i+1].startsWith('--')?argv[i+1]:d};
const die=(msg,code=2)=>{console.error(`first-trade: ${msg}`);process.exit(code)};
const et=d=>new Date(d).toLocaleString('en-US',{timeZone:'America/New_York',hour12:false})+' ET';

const mode=has('--live')?'live':has('--watch')?'watch':'plan';
const args={coin:(val('--coin','WIF')).toUpperCase(),usdc:val('--usdc','5'),slippage:Number(val('--slippage','100')),selfGas:has('--self-gas'),
 account:val('--account'),didSuffix:val('--did-suffix'),expectBase:val('--expect-base'),timeoutMin:Number(val('--timeout-min','30'))};
const container=val('--container','yeet-core-1');
if(!/^[A-Z0-9]{2,12}$/.test(args.coin))die('--coin must be a catalogue symbol, e.g. WIF');
if(!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/.test(args.usdc))die('--usdc must be a USDC amount, e.g. 5');
if(!Number.isInteger(args.slippage)||args.slippage<50||args.slippage>300)die('--slippage must be 50-300 bps');
if(!Number.isFinite(args.timeoutMin)||args.timeoutMin<1||args.timeoutMin>180)die('--timeout-min must be 1-180');
if(args.account&&!/^yeet-privy-[A-Za-z0-9_-]{1,80}$/.test(args.account))die('--account must be a yeet-privy-... id');
if(args.didSuffix&&!/^[A-Za-z0-9_-]{6,64}$/.test(args.didSuffix))die('--did-suffix must be 6-64 id characters');
if(args.expectBase&&!/^0x[0-9a-fA-F]{40}$/.test(args.expectBase))die('--expect-base must be a 0x address');
if(!args.account&&!args.didSuffix)die('name the account: --did-suffix <tail of the Privy DID> or --account yeet-privy-...');
if(!/^[A-Za-z0-9_.-]{1,64}$/.test(container))die('bad --container');

/** Runs the container side once; streams EVT lines through `onEvent`, returns the PLAN or RESULT object. */
function runCore(payload,onEvent=()=>{}){
 return new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-i','-e',`FT_ARGS=${JSON.stringify(payload)}`,container,'node','--input-type=module','-'],{stdio:['pipe','pipe','inherit']});
  let buf='',final=null;
  child.stdout.on('data',d=>{
   buf+=d;let i;
   while((i=buf.indexOf('\n'))>=0){
    const line=buf.slice(0,i);buf=buf.slice(i+1);
    const m=/^(PLAN|EVT|RESULT) (.*)$/.exec(line);
    if(!m){if(line.trim())console.log(line);continue}
    const obj=JSON.parse(m[2]);
    if(m[1]==='EVT')onEvent(obj);else final=obj;
   }
  });
  child.on('error',reject);
  child.on('close',code=>final?resolve(final):reject(Error(`container helper exited ${code} without a result`)));
  child.stdin.end(readFileSync(HELPER));
 });
}

function printPlan(p){
 const line=(k,v)=>console.log(`  ${k.padEnd(22)} ${v}`);
 console.log(`\nYEET first trade, PLAN (dry, nothing moves)   ${et(p.at)}`);
 if(p.account){line('account',p.account.id);line('privy did ends',p.account.did_suffix)}
 if(p.wallets){line('base wallet',`${p.wallets.base.address}  signer=${p.wallets.base.signer} policy_ok=${p.wallets.base.policy_matches}`);line('solana wallet',`${p.wallets.solana.address}  signer=${p.wallets.solana.signer} policy_ok=${p.wallets.solana.policy_matches}`)}
 if(p.balances)line('balances',`${p.balances.base_usdc} USDC, ${p.balances.base_eth} ETH on Base; ${p.balances[`solana_${args.coin}`]??'?'} ${args.coin} on Solana`);
 if(p.quote){const q=p.quote;
  line('dry quote',`${q.amount_in} USDC -> est ${q.est_out} ${q.symbol} (min ${q.min_out}) ~$${q.est_out_usd} of $${q.amount_in_usd}`);
  line('cost / slippage',`${q.cost_bps} bps cost, ${q.slippage_bps} bps slippage, ~${q.time_estimate_s}s, deposit address: ${q.deposit_address_present?'present':'none (dry)'}`);
  line('1click correlation',q.correlation_id);}
 if(p.gas)line('base gas',`wanted ${p.gas.wanted}, core env ${p.gas.core_env}${p.gas.spend_30d_usd!==undefined?`, gas credits charged 30d $${p.gas.spend_30d_usd}`:''}`);
 if(p.flags)line('flags',`trading=${p.flags.trading} YEET_LIVE=${p.flags.yeet_live?1:0} KILL=${p.flags.kill_switch?1:0} allowlist env=${p.flags.live_accounts_env} caps ${p.flags.min_leg_usdc}/${p.flags.max_trade_usdc}/${p.flags.daily_cap_usdc} cost<=${p.flags.max_cost_bps}bps`);
 if(p.operator_api)line('operator api',p.operator_api.present?`present (scope ${p.operator_api.scope}, allowed ${p.operator_api.account_allowed}, gas ${p.operator_api.base_gas})`:`absent (HTTP ${p.operator_api.status}): redeploy needed`);
 console.log('  checks:');
 for(const c of p.checks??[])console.log(`    ${c.kind==='info'?(c.ok?'info':'NOTE'):c.ok?'PASS':c.kind==='block'?'FAIL':'WAIT'} ${c.name}${c.detail?`  (${c.detail})`:''}`);
}

function latestPlan(){
 if(!existsSync(PLANS))return null;
 const files=readdirSync(PLANS).filter(f=>/^fp_[a-z0-9]{20}\.json$/.test(f));
 const plans=files.map(f=>JSON.parse(readFileSync(join(PLANS,f),'utf8'))).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 return plans[0]??null;
}
const sameArgs=(a,b)=>['coin','usdc','slippage','selfGas'].every(k=>a[k]===b[k]);

function receiptPath(planId){mkdirSync(RECEIPTS,{recursive:true,mode:0o700});return join(RECEIPTS,`first-trade-${planId}.json`)}
function writeReceipt(path,data){writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path)}

function describe(e){
 const at=et(Date.now());
 if(e.stage==='trading')return `${at}  stack: trading=${e.trading} scope=${e.scope} account_allowed=${e.account_allowed} gas=${e.base_gas}`;
 if(e.stage==='proposed'){const l=e.proposal.legs[0];return `${at}  proposed ${e.proposal.proposal_id} r${e.proposal.revision}: ${l.amount_in} USDC -> est ${l.est_out} ${l.symbol} (min ${l.min_out}), cost ${e.proposal.totals.cost_pct}%`}
 if(e.stage==='executed'){const x=e.execute;return `${at}  execute: ${x.status} ${x.trade_id??''} `+(x.legs??[]).map(l=>`${l.symbol} ${l.status} deposit ${l.deposit_address} tx ${l.tx_hash??'(hash pending)'}`).join('; ')}
 if(e.stage==='status')return `${at}  [+${e.elapsed_s}s] trade ${e.status}: `+e.legs.map(l=>`${l.symbol} ${l.status}${l.origin_tx?` base_tx ${l.origin_tx}`:''}${l.destination_tx?` sol_tx ${l.destination_tx}`:''}${l.amount_out?` out ${l.amount_out}`:''}${l.refund_reason?` (${l.refund_reason})`:''}`).join('; ')+(e.last_error?`  last_error: ${e.last_error}`:'');
 return `${at}  ${e.stage} ${JSON.stringify(e)}`;
}
function links(status){
 const legs=status?.record?.receipt?.legs??[];
 return (status?.legs??[]).map((l,i)=>({symbol:l.symbol,status:l.status,base_tx:l.origin_tx,basescan:l.origin_tx?`https://basescan.org/tx/${l.origin_tx}`:null,
  deposit_address:legs[i]?.depositAddress??null,near_intents:legs[i]?.depositAddress?`https://explorer.near-intents.org/transactions/${legs[i].depositAddress}`:null,
  solana_tx:l.destination_tx,solscan:l.destination_tx?`https://solscan.io/tx/${l.destination_tx}`:null,amount_out:l.amount_out,refund_reason:l.refund_reason}));
}
function printFinal(r){
 console.log(`\nRESULT ${r.ok?'OK':'NOT OK'} (stage ${r.stage})${r.reason?`: ${r.reason}`:''}${r.error?`: ${r.error}`:''}`);
 if(r.status){
  console.log(`  trade ${r.status.trade_id} status ${r.status.status}; received ${JSON.stringify(r.status.received)}; xp ${JSON.stringify(r.status.xp_award??null)}`);
  for(const l of links(r.status))console.log(`  ${l.symbol}: ${l.status}\n    base tx      ${l.basescan??'-'}\n    near intents ${l.near_intents??'-'}\n    solana tx    ${l.solscan??'-'}${l.refund_reason?`\n    refund       ${l.refund_reason}`:''}`);
 }
}

if(mode==='plan'){
 const p=await runCore({mode:'plan',...args}).catch(e=>die(e.message,1));
 printPlan(p);
 const blockers=(p.checks??[]).filter(c=>!c.ok&&c.kind==='block');
 const gates=(p.checks??[]).filter(c=>!c.ok&&c.kind==='gate');
 const id=`fp_${[...randomBytes(20)].map(b=>'abcdefghijklmnopqrstuvwxyz0123456789'[b%36]).join('')}`;
 mkdirSync(PLANS,{recursive:true,mode:0o700});
 writeFileSync(join(PLANS,`${id}.json`),JSON.stringify({id,created_at:new Date().toISOString(),args,account:p.account?.id??null,quote:p.quote??null,blockers:blockers.map(c=>c.name),gates:gates.map(c=>c.name),used_at:null,plan:p},null,2)+'\n',{mode:0o600});
 console.log(`\nPLAN ID ${id}  (valid 15 min for --live; blocking failures: ${blockers.length}, waiting on: ${gates.length})`);
 if(blockers.length)console.log('  not runnable: fix the FAIL lines and run --plan again');
 else console.log(`  live run: YEET_OPERATOR_CONFIRM=${id} node ops/first-trade.mjs --live ${argv.filter(a=>a!=='--plan').join(' ')}`);
 process.exit(blockers.length?1:0);
}

if(mode==='watch'){
 const tradeId=val('--watch');
 if(!/^t_[a-z0-9]{20}$/.test(tradeId??''))die('--watch needs a t_... trade id');
 if(!args.account)die('--watch needs --account');
 mkdirSync(RECEIPTS,{recursive:true,mode:0o700});
 const path=join(RECEIPTS,`watch-${tradeId}.json`);
 const r=await runCore({mode:'watch',account:args.account,tradeId,timeoutMin:args.timeoutMin},e=>console.log(describe(e))).catch(e=>die(e.message,1));
 printFinal(r);writeReceipt(path,{version:1,kind:'yeet-trade-watch',written_at:new Date().toISOString(),result:r,links:links(r.status)});
 console.log(`  receipt ${path}`);process.exit(r.ok?0:1);
}

// --live
const confirm=process.env.YEET_OPERATOR_CONFIRM?.trim();
const plan=latestPlan();
if(!plan)die('refused: no plan; run --plan first');
if(!confirm||confirm!==plan.id)die(`refused: YEET_OPERATOR_CONFIRM must equal the latest plan id (${plan.id})`);
if(Date.now()-Date.parse(plan.created_at)>PLAN_TTL_MS)die('refused: the plan is older than 15 minutes; run --plan again');
if(plan.used_at)die('refused: this plan id was already used; run --plan again');
if(plan.blockers.length)die(`refused: the plan has failed checks: ${plan.blockers.join('; ')}`);
if(!sameArgs(plan.args,args)||(args.account&&args.account!==plan.account)||(args.didSuffix&&args.didSuffix!==plan.args.didSuffix))die('refused: arguments differ from the plan');
let version;
try{version=await (await fetch(PUBLIC_VERSION,{signal:AbortSignal.timeout(8000)})).json()}catch(e){die(`refused: ${PUBLIC_VERSION} unreadable`)}
if(version?.trading!=='live')die(`refused: ${PUBLIC_VERSION} says trading=${version?.trading}; enable trading first (ops/FIRST-TRADE.md)`);
// Mark the plan used before anything is sent: a crash never lets the same approval start a second run.
const planFile=join(PLANS,`${plan.id}.json`);
writeFileSync(planFile,JSON.stringify({...plan,used_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
const path=receiptPath(plan.id);
const receipt={version:1,kind:'yeet-first-trade',plan_id:plan.id,account:plan.account,request:plan.args,server_commit:version.server_commit,started_at:new Date().toISOString(),plan_quote:plan.quote,events:[],result:null};
writeReceipt(path,receipt);
console.log(`LIVE run for plan ${plan.id}: ${args.usdc} USDC -> ${args.coin}, account ${plan.account}, gas ${args.selfGas?'self':'sponsored'}, server ${version.server_commit}`);
const r=await runCore({mode:'live',...args,account:plan.account,planId:plan.id,planQuote:plan.quote,maxDriftBps:MAX_DRIFT_BPS},e=>{
 console.log(describe(e));receipt.events.push({at:new Date().toISOString(),...e});writeReceipt(path,receipt);
}).catch(e=>{receipt.result={ok:false,stage:'tool',error:e.message};writeReceipt(path,receipt);die(`${e.message}; the trade may be running: check the core log and use --watch`,1)});
receipt.result=r;receipt.links=links(r.status);receipt.finished_at=new Date().toISOString();
writeReceipt(path,receipt);
printFinal(r);
console.log(`  receipt ${path}`);
process.exit(r.ok?0:1);

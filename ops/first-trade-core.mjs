// Container side of ops/first-trade.mjs. Not run by hand: the host tool pipes this file into node inside the core
// container (docker exec -i -e FT_ARGS=<json> <core> node --input-type=module -), so it runs with core's own modules,
// environment, /state and /secrets, and nothing is copied or mounted. It never prints an environment value or secret.
//
//   plan   read-only: account from /state/identities.sqlite (read-only open), wallets and signer/policy from the Privy
//          API, balances from public Base/Solana RPC, today's spend from /state/trade.sqlite (read-only, if present),
//          a DRY 1Click quote (no deposit address), the flags, and whether core answers the operator routes.
//   live   through core's own HTTP routes on 127.0.0.1 with the core-operator secret: /operator/trading,
//          /operator/trades/propose (request_id = the plan id), /operator/trades/execute (the minted one-time code),
//          then /operator/trades/status every 5 s until final. Same engine, audit, caps, accounting and XP as a card tap.
//   watch  only the status loop, for a trade already started.
// Output: one line per item, `PLAN <json>`, `EVT <json>`, `RESULT <json>`; diagnostics on stderr.
import {readFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const A=JSON.parse(process.env.FT_ARGS??'{}');
const APP='file:///app/connector/';
const imp=p=>import(APP+p);
const emit=(kind,obj)=>process.stdout.write(`${kind} ${JSON.stringify(obj)}\n`);
const CORE='http://127.0.0.1:38316';
const PUBLIC_BASE_RPC='https://mainnet.base.org',PUBLIC_SOLANA_RPC='https://api.mainnet-beta.solana.com';
const FINAL_TRADE=new Set(['success','refunded','failed']),FINAL_LEG=new Set(['SUCCESS','REFUNDED','FAILED']);
const short=s=>typeof s==='string'&&s.length>14?`${s.slice(0,6)}...${s.slice(-4)}`:s??null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function operatorSecret(){return readFileSync('/secrets/core-operator','utf8').trim()}
async function op(path,body,timeoutMs=15_000){
 const r=await fetch(CORE+path,{method:'POST',headers:{authorization:`Bearer ${operatorSecret()}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
 let json=null;try{json=await r.json()}catch{}
 return {status:r.status,body:json};
}
const strip=({confirm,...rest})=>rest;// the one-time code is never printed

function resolveAccount(){
 const appId=process.env.PRIVY_APP_ID;
 const db=new DatabaseSync('/state/identities.sqlite',{readOnly:true});
 try{
  if(A.account){
   if(!/^yeet-privy-[A-Za-z0-9_-]{1,80}$/.test(A.account))throw Error('bad --account');
   return db.prepare('SELECT account_id,did FROM identity_links WHERE app_id=? AND account_id=?').all(appId,A.account);
  }
  if(!/^[A-Za-z0-9_-]{6,64}$/.test(A.didSuffix??''))throw Error('bad --did-suffix');
  return db.prepare('SELECT account_id,did FROM identity_links WHERE app_id=? AND substr(did,-?)=?').all(appId,A.didSuffix.length,A.didSuffix);
 }finally{db.close()}
}
function spentTodayRaw(accountId){
 if(!existsSync('/state/trade.sqlite'))return {raw:0n,source:'no trade.sqlite yet'};
 const db=new DatabaseSync('/state/trade.sqlite',{readOnly:true});
 try{const row=db.prepare('SELECT usdc_raw FROM daily_spend WHERE account_id=? AND day=?').get(accountId,new Date().toISOString().slice(0,10));return {raw:row?BigInt(row.usdc_raw):0n,source:'trade.sqlite'}}
 finally{db.close()}
}

/** The trade an execute of this proposal committed (read-only), or null. */
function tradeForProposal(proposalId){
 if(!existsSync('/state/trade.sqlite')||typeof proposalId!=='string')return null;
 const db=new DatabaseSync('/state/trade.sqlite',{readOnly:true});
 try{return db.prepare("SELECT id FROM trades WHERE proposal_id=? AND status<>'requote_required' ORDER BY created_at DESC LIMIT 1").get(proposalId)?.id??null}
 finally{db.close()}
}

const GAS_FIELDS=new Set(['gas_limit','gas_price','max_fee_per_gas','max_priority_fee_per_gas','gas']);
/** Our Base transfer against one condition of an ALLOW rule: true, false, 'gas' (depends on gas fields), or 'unknown'. */
function baseCondition(c,{usdcAddress,usdcRaw}){
 const v=String(c?.value??'');
 if(c?.field_source==='ethereum_transaction'){
  if(GAS_FIELDS.has(c.field))return 'gas';
  if(c.field==='chain_id')return c.operator==='eq'?v==='8453':'unknown';
  if(c.field==='to')return c.operator==='eq'?v.toLowerCase()===usdcAddress.toLowerCase():'unknown';
  if(c.field==='value')return c.operator==='eq'?BigInt(v||'0')===0n:c.operator==='lte'?true:'unknown';
  return 'unknown';
 }
 if(c?.field_source==='ethereum_calldata'){
  if(c.field==='function_name')return c.operator==='eq'?v==='transfer':'unknown';
  if(c.field==='transfer.amount'){try{const cap=BigInt(v);return c.operator==='lte'?usdcRaw<=cap:c.operator==='lt'?usdcRaw<cap:'unknown'}catch{return 'unknown'}}
  return 'unknown';
 }
 if(c?.field_source==='reference')return 'unknown';// aggregation: counts eth_signTransaction only (policy-create.mjs)
 return 'unknown';
}
/** Read-only Privy reads: both signer policies, and the gas credits charged to the Base wallet in the last 30 days. */
async function policyChecks({env,limits,w,usdcRaw,check,out}){
 const {createPrivyApi,privyConfig}=await imp('core/trade/privy-api.mjs');
 const {USDC_BASE}=await imp('core/trade/signer.mjs');
 const {CATALOG,findToken}=await imp('core/trade/router.mjs');
 const config=privyConfig(env);if(!config)return;
 const api=createPrivyApi({config,timeoutMs:8000});
 out.policies={};
 if(limits.basePolicyId){
  try{
   const p=await api.app('GET',`/v1/policies/${limits.basePolicyId}`);
   const rules=(p?.rules??[]).filter(r=>r?.method==='eth_sendTransaction');
   const evals=rules.map(r=>({name:r.name,action:r.action,results:(r.conditions??[]).map(c=>({field:`${c.field_source}.${c.field}`,op:c.operator,ok:baseCondition(c,{usdcAddress:USDC_BASE,usdcRaw})}))}));
   const allow=evals.filter(r=>r.action==='ALLOW');
   const passes=r=>r.results.every(x=>x.ok===true||x.ok==='unknown'&&x.field.startsWith('reference.'));
   const gasDependent=allow.some(r=>r.results.some(x=>x.ok==='gas'));
   const denies=evals.filter(r=>r.action==='DENY').map(r=>r.name);
   out.policies.base={name:p?.name??null,chain_type:p?.chain_type??null,send_rules:evals,deny_rules:denies};
   check('Base policy: an ALLOW rule for eth_sendTransaction matches this USDC transfer',allow.some(passes),allow.map(r=>r.name).join(',')||'no eth_sendTransaction rule');
   check('Base policy: no condition on gas fields (sponsored and self-gas variants pass alike)',!gasDependent,gasDependent?'a rule constrains gas: self-gas may be denied':null,A.selfGas?'block':'info');
   if(denies.length)check('Base policy: DENY rules present (review)',false,denies.join(','),'info');
  }catch(e){check('Base policy readable (GET /v1/policies/{id})',false,e?.code??e?.message,'info')}
 }
 if(limits.solanaPolicyId){
  try{
   const p=await api.app('GET',`/v1/policies/${limits.solanaPolicyId}`);
   const send=(p?.rules??[]).filter(r=>r?.method==='signAndSendTransaction'&&r.action==='ALLOW');
   const coin=findToken(A.coin,'solana',CATALOG);
   const mintRule=send.find(r=>(r.conditions??[]).some(c=>c.field==='TransferChecked.mint'&&Array.isArray(c.value)&&c.value.includes(coin?.address)));
   out.policies.solana={name:p?.name??null,send_rules:send.map(r=>r.name)};
   check(`Solana policy (SKEET later): TransferChecked of ${A.coin} allowed for signAndSendTransaction`,!!mintRule,mintRule?.name??null,'info');
  }catch(e){check('Solana policy readable',false,e?.code??e?.message,'info')}
 }
 // There is no read-only Privy call that says whether gas sponsorship is switched on for the app (docs.privy.io,
 // 2026-11-13). gas_spend shows whether sponsored sends were charged for this wallet before; zero proves nothing.
 if(w.base.walletId){
  try{
   const end=Date.now(),start=end-29*86_400_000;
   const g=await api.app('GET','/v1/apps/gas_spend',undefined,{query:{wallet_ids:w.base.walletId,start_timestamp:String(start),end_timestamp:String(end)}});
   out.gas.spend_30d_usd=g?.value??null;
   check('Privy gas credits charged to this wallet, 30 days (info: sponsorship status is not readable)',true,`${g?.value??'?'} ${g?.currency??''}`.trim(),'info');
  }catch(e){check('Privy gas_spend readable',false,e?.code??e?.message,'info')}
 }
}

async function plan(){
 const env=process.env;
 const checks=[];
 // gate: expected to differ before trading is enabled; block: must pass for the live run.
 const check=(name,ok,detail,kind='block')=>checks.push({name,ok:!!ok,kind,detail:detail??null});
 const {formatUnits,parseUnits,buildYeetPlan,OneClickClient,CATALOG,findToken}=await imp('core/trade/router.mjs');
 const {limitsFromEnv,costBps}=await imp('core/trade/limits.mjs');
 const {usdRaw}=await imp('core/trade/util.mjs');
 const {createRpcBalances}=await imp('core/trade/wallets.mjs');
 const {createDelegatedSigner}=await imp('core/trade/signer-privy.mjs');
 const {privyConfig}=await imp('core/trade/privy-api.mjs');
 const out={mode:'plan',at:new Date().toISOString(),request:{coin:A.coin,usdc:A.usdc,slippage_bps:A.slippage}};

 const rows=resolveAccount();
 check('account resolved (exactly one)',rows.length===1,`${rows.length} match(es)`);
 if(rows.length!==1){out.checks=checks;return emit('PLAN',out)}
 const {account_id:accountId,did}=rows[0];
 out.account={id:accountId,did_suffix:did.slice(-8)};

 const limits=limitsFromEnv(env);
 const usdcRaw=parseUnits(A.usdc,6);
 const coin=findToken(A.coin,'solana',CATALOG);
 check('coin in catalogue (Solana)',coin&&coin.kind!=='funding',coin?`${coin.symbol} ${short(coin.address)}`:A.coin);
 check(`amount >= min leg ${formatUnits(limits.minLegRaw,6)} USDC`,usdcRaw>=limits.minLegRaw);
 check(`amount <= per-trade cap ${formatUnits(limits.maxTradeRaw,6)} USDC`,usdcRaw<=limits.maxTradeRaw);
 const spent=spentTodayRaw(accountId);
 check(`today's spend + amount <= daily cap ${formatUnits(limits.dailyCapRaw,6)} USDC`,spent.raw+usdcRaw<=limits.dailyCapRaw,`spent today ${formatUnits(spent.raw,6)} (${spent.source})`);

 const signerKind=env.YEET_SIGNER?.trim()||'delegated';
 check('signer mode is delegated (YEET_SIGNER)',signerKind==='delegated',signerKind);
 check('Privy server credentials present (names only)',!!privyConfig(env)&&!!env.YEET_PRIVY_KEY_QUORUM_ID?.trim());
 const jwt=!!env.ONECLICK_JWT?.trim();
 check('1Click JWT configured (ONECLICK_JWT)',jwt,jwt?'set':'absent: quotes run unauthenticated (1Click may add its own fee)','info');
 // Gas on Base, as signer-privy.mjs decides it from the environment of this (running) core.
 const gasMode=env.YEET_GAS_WALLET_ID?.trim()?'gas_wallet':(env.YEET_BASE_GAS?.trim()||'sponsor')==='self'?'self':'sponsored';
 const wantGas=A.selfGas?'self':'sponsored';
 out.gas={wanted:wantGas,core_env:gasMode};
 check(`Base gas mode of the running core is ${wantGas}`,gasMode===wantGas,gasMode,A.selfGas?'gate':'block');
 check('Base policy id configured (YEET_BASE_POLICY_ID)',!!limits.basePolicyId);

 const balances=createRpcBalances({baseRpcUrl:PUBLIC_BASE_RPC,solanaRpcUrl:PUBLIC_SOLANA_RPC});
 const signer=createDelegatedSigner({env,balances,didFor:()=>did});
 let w=null;
 try{w=await signer.directory.lookup(accountId)}catch(e){check('wallets from Privy',false,e?.code??e?.message)}
 if(w){
  out.wallets={base:{address:w.base.address,signer:w.base.signerState,policy_matches:w.base.policyId===limits.basePolicyId&&!!limits.basePolicyId,policy:short(w.base.policyId)},
   solana:{address:w.solana.address,signer:w.solana.signerState,policy_matches:w.solana.policyId===limits.solanaPolicyId&&!!limits.solanaPolicyId,policy:short(w.solana.policyId)}};
  check('Base wallet: YEET signer attached',w.base.signerState==='granted'&&!!w.base.walletId);
  check('Base wallet: signer carries exactly the configured policy',out.wallets.base.policy_matches,out.wallets.base.policy);
  if(A.expectBase)check('Base address is the expected one',w.base.address.toLowerCase()===A.expectBase.toLowerCase(),w.base.address);
  try{
   const [usdc,eth,toks]=await Promise.all([balances.baseUsdc(w.base.address),balances.baseEth(w.base.address),balances.solanaTokens(w.solana.address).catch(()=>null)]);
   const held=coin&&toks?toks.filter(t=>t.mint===coin.address).reduce((a,t)=>a+t.raw,0n):null;
   out.balances={base_usdc:formatUnits(usdc,6),base_eth:formatUnits(eth,18),[`solana_${A.coin}`]:held===null?null:formatUnits(held,coin.decimals),rpc:'public (mainnet.base.org, api.mainnet-beta.solana.com)'};
   check('Base USDC balance >= amount',usdc>=usdcRaw,`${formatUnits(usdc,6)} USDC`);
   // signer-privy.mjs GAS_MIN_WEI: the self-gas send refuses below 0.00001 ETH.
   if(A.selfGas)check('Base ETH >= 0.00001 for self-paid gas',eth>=10_000_000_000_000n,`${formatUnits(eth,18)} ETH`);
   else check('Base ETH not needed (sponsored)',true,`${formatUnits(eth,18)} ETH`,'info');
   // Self-gas cost now (base-gas.mjs): one USDC transfer at the current Base gas price plus the L1 data fee, x3.
   try{
    const {readBaseGasCost,selfGasCheck}=await imp('core/trade/base-gas.mjs');
    const g=await readBaseGasCost({rpcUrl:PUBLIC_BASE_RPC,from:w.base.address,amountRaw:usdcRaw>0n?usdcRaw:1n});
    let ethUsd;
    try{const toks=await new OneClickClient({jwt:env.ONECLICK_JWT||undefined,timeoutMs:8000,retryDelayMs:500}).getTokens();ethUsd=toks.find(t=>t.blockchain==='base'&&t.symbol==='ETH'&&typeof t.price==='number')?.price}catch{}
    const s=selfGasCheck({balanceWei:eth,gasLimit:g.gasLimit,gasPriceWei:g.gasPriceWei,l1FeeWei:g.l1FeeWei,ethUsd});
    out.self_gas={gas_limit:String(g.gasLimit),gas_estimated:g.estimated,gas_price_gwei:formatUnits(g.gasPriceWei,9),l1_fee_eth:formatUnits(g.l1FeeWei,18),l1_known:g.l1Known,
     cost_eth:s.cost_eth,cost_usd:s.cost_usd,needed_eth:s.needed_eth,needed_usd:s.needed_usd,margin:s.margin,balance_eth:s.balance_eth,eth_usd:ethUsd??null,covered:s.covered,
     engine_min_eth:'0.00001'};
    check(`Base ETH covers one self-gas USDC transfer x${s.margin} (needs ${s.needed_eth} ETH${s.needed_usd?` ~$${s.needed_usd}`:''})`,s.covered,
     `balance ${s.balance_eth} ETH; cost now ${s.cost_eth} ETH${s.cost_usd?` ~$${s.cost_usd}`:''} = ${g.gasLimit} gas${g.estimated?'':' (fallback)'} x ${formatUnits(g.gasPriceWei,9)} gwei + L1 ${formatUnits(g.l1FeeWei,18)} ETH`,A.selfGas?'block':'info');
   }catch(e){check('self-gas cost readable (Base RPC)',false,String(e?.message??e).slice(0,120),A.selfGas?'block':'info')}
  }catch(e){check('balances from public RPC',false,e?.message)}
  await policyChecks({env,limits,w,usdcRaw,check,out});

  if(coin){
   const client=new OneClickClient({jwt:env.ONECLICK_JWT||undefined,timeoutMs:8000,retryDelayMs:500});
   try{
    const p=await buildYeetPlan({amountUsdc:A.usdc,legs:[{symbol:coin.symbol,parts:10}],recipientSol:w.solana.address,refundBase:w.base.address,slippageBps:A.slippage,dry:true},{client,catalog:CATALOG,now:()=>new Date()});
    const l=p.legs[0];
    const bps=costBps(usdRaw(l.amountInUsd),usdRaw(l.amountOutUsd));
    out.quote={dry:true,plan_id:p.id,symbol:l.symbol,amount_in:l.amountInFormatted??formatUnits(BigInt(l.amountIn),6),amount_in_raw:l.amountIn,amount_in_usd:l.amountInUsd,
     est_out:l.amountOutFormatted??formatUnits(BigInt(l.amountOut),l.destination.decimals),est_out_raw:l.amountOut,min_out:l.minAmountOutFormatted,min_out_raw:l.minAmountOut,
     est_out_usd:l.amountOutUsd,cost_bps:bps,slippage_bps:A.slippage,time_estimate_s:l.timeEstimate,deadline:l.deadline,deposit_address_present:!!l.depositAddress,
     correlation_id:l.correlationId,recipient:p.recipient,refund_to:p.refundTo};
    check('1Click dry quote',true,`corr ${l.correlationId}`);
    check(`cost ${bps} bps <= max ${limits.maxCostBps} bps`,bps<=limits.maxCostBps);
    check('dry quote has no deposit address (expected)',!l.depositAddress,null,'info');
   }catch(e){check('1Click dry quote',false,String(e?.message??e).slice(0,200))}
  }
 }

 out.flags={yeet_live:limits.live,kill_switch:limits.killSwitch,trading:limits.live&&!limits.killSwitch?'live':'paused',
  live_accounts_env:env.YEET_LIVE_ACCOUNTS?.trim()?'set':'unset',max_trade_usdc:formatUnits(limits.maxTradeRaw,6),daily_cap_usdc:formatUnits(limits.dailyCapRaw,6),
  min_leg_usdc:formatUnits(limits.minLegRaw,6),max_cost_bps:limits.maxCostBps,requote_tolerance_bps:limits.requoteToleranceBps,p2:env.YEET_P2==='1'};
 check('trading enabled (YEET_LIVE=1, YEET_KILL_SWITCH off)',out.flags.trading==='live',out.flags.trading,'gate');
 let api;
 try{api=await op('/operator/trading',{account:accountId},5000)}catch(e){api={status:0,body:null}}
 out.operator_api={status:api.status,present:api.status===200,...(api.status===200?api.body:{})};
 check('core answers the operator trade routes (image with YEET_LIVE_ACCOUNTS)',api.status===200,api.status===200?null:`HTTP ${api.status}: redeploy needed`,'gate');
 check('account allowed by YEET_LIVE_ACCOUNTS',api.status===200&&api.body?.account_allowed,api.status===200?`scope ${api.body.scope}`:null,'gate');
 out.checks=checks;
 emit('PLAN',out);
}

/** One line per change of the trade or any leg; returns the last view. */
async function follow(accountId,tradeId,{timeoutMs,startedAt=Date.now()}){
 let last='',view=null,errors=0;
 for(;;){
  let r;
  try{r=await op('/operator/trades/status',{account:accountId,trade_id:tradeId},15_000);errors=0}
  catch(e){if(++errors>=12){emit('EVT',{stage:'status_unreachable',error:String(e?.message??e).slice(0,120)});return view}await sleep(5000);continue}
  if(r.status!==200){emit('EVT',{stage:'status_refused',http:r.status,error:r.body?.error??null});return view}
  view=r.body;
  // send: the engine's real leg state (queued | sending | sent | failed | not_sent), not the contract's folded view.
  const rec=view.record?.legs??[];
  const legs=view.legs.map((l,i)=>({symbol:l.symbol,status:l.status,send:rec[i]?.send_status??null,send_attempts:rec[i]?.send_attempts??null,hash_pending:rec[i]?.hash_pending??false,
   privy_error:rec[i]?.privy_error??null,origin_tx:l.origin_tx,destination_tx:l.destination_tx,amount_out:l.amount_out,refund_reason:l.refund_reason}));
  const key=JSON.stringify([view.status,legs,view.record?.last_error]);
  if(key!==last){last=key;emit('EVT',{stage:'status',trade_id:tradeId,status:view.status,legs,received:view.received,last_error:view.record?.last_error??null,xp_award:view.xp_award??null,elapsed_s:Math.round((Date.now()-startedAt)/1000)})}
  // Nothing was sent and nothing can be any more: final, whatever the trade status says.
  const noneSent=rec.length>0&&rec.every(l=>l.send_status==='failed'||l.send_status==='not_sent');
  const done=noneSent||FINAL_TRADE.has(view.status)||(view.status==='partial'&&view.legs.every(l=>FINAL_LEG.has(l.status)))||view.record?.receipt?.complete===true;
  if(done)return view;
  if(Date.now()-startedAt>timeoutMs){emit('EVT',{stage:'watch_timeout',status:view.status});return view}
  await sleep(5000);
 }
}

async function live(){
 const accountId=A.account;
 const t=await op('/operator/trading',{account:accountId},5000);
 if(t.status!==200||t.body?.operator_trades!==true)return emit('RESULT',{ok:false,stage:'trading',http:t.status,trading:t.body??null,reason:'core does not report trading enabled for this account'});
 const wantGas=A.selfGas?'self':'sponsored';
 if(t.body.base_gas!==wantGas)return emit('RESULT',{ok:false,stage:'trading',trading:t.body,reason:`core sends Base gas as ${t.body.base_gas}, this run wants ${wantGas} (YEET_BASE_GAS)`});
 emit('EVT',{stage:'trading',...t.body});
 const legs=[{symbol:A.coin,parts:10}];
 const p=await op('/operator/trades/propose',{account:accountId,request_id:A.planId,amount_usdc:A.usdc,legs,slippage_bps:A.slippage},30_000);
 if(p.status!==200)return emit('RESULT',{ok:false,stage:'propose',http:p.status,error:p.body?.error??null});
 const proposal=strip(p.body);
 emit('EVT',{stage:'proposed',proposal});
 if(!p.body.confirm?.code)return emit('RESULT',{ok:false,stage:'propose',proposal,reason:'no confirm code: this plan id was already used (proposal not in `proposed`); run --plan again'});
 const leg=proposal.legs[0];
 // The live price may not be much worse than what the owner approved at --plan time (the engine adds its own requote rule).
 if(proposal.legs.length!==1||leg.symbol!==A.coin||leg.amount_in!==A.usdc)return emit('RESULT',{ok:false,stage:'propose',proposal,reason:'proposal differs from the plan'});
 const {parseUnits}=await imp('core/trade/router.mjs');
 if(A.planQuote?.est_out){
  const d=Math.max(...[leg.est_out,A.planQuote.est_out].map(s=>(String(s).split('.')[1]??'').length));
  const now=parseUnits(String(leg.est_out),d),then=parseUnits(String(A.planQuote.est_out),d);
  if(now*10_000n<then*BigInt(10_000-A.maxDriftBps))return emit('RESULT',{ok:false,stage:'propose',proposal,reason:`estimate fell more than ${A.maxDriftBps} bps since --plan (${A.planQuote.est_out} -> ${leg.est_out}); run --plan again`});
 }
 let x,started=Date.now();
 for(let attempt=1;attempt<=3;attempt++){
  // A lost answer is safe to retry with the same code: a used code replays the trade it started, never a second one.
  try{x=await op('/operator/trades/execute',{account:accountId,proposal_id:proposal.proposal_id,revision:proposal.revision,confirm:p.body.confirm.code},90_000);break}
  catch(e){emit('EVT',{stage:'execute_retry',attempt,error:String(e?.message??e).slice(0,120)});if(attempt===3)return emit('RESULT',{ok:false,stage:'execute',proposal,reason:'no answer from execute after 3 tries; run --watch with the trade id from the core log (event operator_trade) or trade.sqlite'})}
 }
 if(x.status!==200){
  // execute refused after the trade was committed (e.g. Privy refused every leg): the trade, its real leg states and
  // the Privy error are still on record; read them so the receipt says why.
  const tradeId=tradeForProposal(proposal.proposal_id);
  const s=tradeId?await op('/operator/trades/status',{account:accountId,trade_id:tradeId},15_000).catch(()=>null):null;
  const status=s?.status===200?s.body:null;
  if(status)emit('EVT',{stage:'executed',execute:{trade_id:tradeId,status:'refused',error:x.body?.error??null},send_states:status.record?.legs??[]});
  return emit('RESULT',{ok:false,stage:'execute',http:x.status,error:x.body?.error??null,proposal,trade_id:tradeId,status,privy_errors:(status?.record?.legs??[]).map(l=>l.privy_error).filter(Boolean)});
 }
 const exec=strip(x.body);
 const s0=await op('/operator/trades/status',{account:accountId,trade_id:exec.trade_id},15_000).catch(()=>null);
 emit('EVT',{stage:'executed',execute:exec,send_states:s0?.status===200?s0.body.record?.legs??[]:null});
 if(exec.status==='requote_required')return emit('RESULT',{ok:false,stage:'requote',proposal,execute:exec,reason:'live quote worse than the preview; nothing was sent. Review the new quote with the owner and run --plan again'});
 const final=await follow(accountId,exec.trade_id,{timeoutMs:A.timeoutMin*60_000,startedAt:started});
 emit('RESULT',{ok:!!final&&final.status==='success',stage:'final',proposal,execute:exec,status:final});
}

/** --cancel: the operator cancel route, then the trade's final record. Changes only this trade's rows; sends nothing. */
async function cancel(){
 const c=await op('/operator/trades/cancel',{account:A.account,trade_id:A.tradeId,reason:A.reason??'operator cancel (ops/first-trade.mjs --cancel)'},60_000);
 if(c.status!==200)return emit('RESULT',{ok:false,stage:'cancel',http:c.status,error:c.body?.error??null});
 emit('EVT',{stage:'cancel',...c.body});
 const s=await op('/operator/trades/status',{account:A.account,trade_id:A.tradeId},15_000);
 const view=s.status===200?s.body:null;
 const legs=view?.record?.legs??[];
 const final=c.body.cancelled===true&&view?.status==='failed'&&legs.length>0&&legs.every(l=>l.send_status==='failed'||l.send_status==='not_sent');
 emit('RESULT',{ok:final,stage:'cancel',cancel:c.body,status:view,spent_today_usdc:spentTodayUsdc(A.account),...(final?{}:{reason:c.body.reason??'trade not in a final not-sent state'})});
}
function spentTodayUsdc(accountId){
 try{const s=spentTodayRaw(accountId);const v=s.raw.toString().padStart(7,'0');return `${v.slice(0,-6)}.${v.slice(-6)}`}catch{return null}
}

async function watch(){
 const final=await follow(A.account,A.tradeId,{timeoutMs:A.timeoutMin*60_000});
 emit('RESULT',{ok:!!final&&final.status==='success',stage:'final',status:final});
}

try{await ({plan,live,watch,cancel}[A.mode]??(()=>{throw Error('unknown mode')}))()}
catch(e){emit('RESULT',{ok:false,stage:'error',error:String(e?.message??e).slice(0,300)});process.exitCode=1}

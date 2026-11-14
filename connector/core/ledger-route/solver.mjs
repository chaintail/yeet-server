// Our solver account on the NEAR Intents ledger (docs/LEDGER-ROUTE.md section 5). It holds USDC only (our working
// float, never a person's funds), signs NEP-413 payloads with its own key, and sends `execute_intents` from its own
// NEAR account. Everything it does runs one at a time (`lock`): sourcing is recognised by the change of its own
// balances, so two operations must never overlap.
//   exposure   per trade and per UTC day, from env; checked before a person is asked to approve, recorded when the
//              solver actually puts USDC up
//   source     pays committed 1Click quotes that take their deposit inside the ledger and waits for the delivery
//   unload     sells coins left over from a trade that was not settled back to USDC, a capped number of tries per
//              coin and day (the spike had no retry and no cap)
// Ported from the proven spike (core/intents/live.mjs sendNearOnce, live-jit.mjs payInside, stepUnload).
import {existsSync} from 'node:fs';
import {loadOrCreateNearKey,buildFunctionCall,sendTransaction,transactionStatus} from '../intents/near-tx.mjs';
import {nep413Signer} from '../intents/sign.mjs';
import {signIntents} from '../intents/intents.mjs';
import {sourcingIntents} from '../intents/jit.mjs';
import {VERIFIER,EXECUTE_GAS,USDC_SOL_TOKEN_ID} from '../intents/constants.mjs';
import {TradeError,utcDay,iso} from '../trade/util.mjs';

const TERMINAL=['SUCCESS','REFUNDED','FAILED'];
const PERMANENT=/InvalidNonce|Expired|NotEnoughBalance|SignerDoesNotExist|InvalidAccessKey|INVALID_TRANSACTION/i;
export const settledOk=st=>st?.ok===true&&st.logs.some(l=>l.includes('"event":"intents_executed"'));

/** The solver key from its file. Never creates one: a missing file, a wrong mode or a key that is not the configured
 * account stops the start. Returns {accountId, address, publicKey, key}; the seed never leaves near-tx.mjs. */
export function loadSolverKey({accountId,keyFile}){
 if(!existsSync(keyFile))throw Error('YEET_SOLVER_KEY_FILE does not exist');
 const near=loadOrCreateNearKey(keyFile);
 if(near.accountId!==accountId)throw Error('YEET_SOLVER_KEY_FILE holds the key of another account than YEET_SOLVER_ACCOUNT');
 return near;
}

export const SOLVER_SCHEMA=`
CREATE TABLE IF NOT EXISTS ledger_solver_day(day TEXT PRIMARY KEY, usdc_raw TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_unload(
 id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, token_id TEXT NOT NULL, amount_raw TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('open','done','failed')), json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_unload_day ON ledger_unload(day,token_id);`;

/** `near` = loadSolverKey(); `rpc`, `verifier` = core/intents/verifier.mjs; `client` = the 1Click client. */
export function createSolver({cfg,near,rpc,verifier,client,db,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{},pollMs=1500,staleRetries=8,finalWaitMs=15_000,staleUnloadMs=20*60_000}){
 db.exec(SOLVER_SCHEMA);
 const signer=nep413Signer(near.key),accountId=near.accountId;
 const event=e=>{try{log({...e,at:iso(now())})}catch{}};

 // ---- one operation at a time ----
 let tail=Promise.resolve(),depth=0;
 function lock(fn){
  depth++;
  const run=tail.then(fn,fn);
  tail=run.then(()=>{},()=>{}).finally(()=>{depth--});
  return run;
 }

 // ---- exposure ----
 const usedToday=()=>BigInt(db.prepare('SELECT usdc_raw FROM ledger_solver_day WHERE day=?').get(utcDay(now()))?.usdc_raw??'0');
 /** Refuses (TEMPORARILY_UNAVAILABLE) a trade that would put up more than the per-trade or the per-day bound. */
 function checkExposure(raw){
  const v=BigInt(raw);
  if(v>cfg.maxTradeRaw)throw new TradeError('TEMPORARILY_UNAVAILABLE',`solver: ${v} is over the per-trade bound ${cfg.maxTradeRaw}`);
  if(usedToday()+v>cfg.maxDayRaw)throw new TradeError('TEMPORARILY_UNAVAILABLE',`solver: the daily bound ${cfg.maxDayRaw} would be passed (used ${usedToday()})`);
 }
 /** Checks again and records, in one step, at the moment the solver puts the USDC up. */
 function recordExposure(raw){
  checkExposure(raw);
  const day=utcDay(now()),next=(usedToday()+BigInt(raw)).toString();
  db.prepare('INSERT INTO ledger_solver_day(day,usdc_raw) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET usdc_raw=excluded.usdc_raw').run(day,next);
 }

 // ---- NEAR ----
 /**
  * Sends ONE `execute_intents` for `signed` and waits for its outcome. `slot` is durable state the caller saves
  * (`save()`): the transaction is stored before it is sent, and sent again unchanged after a restart. The signed
  * intents carry their own nonces, so even a rebuilt transaction can never execute them twice.
  * Returns transactionStatus(): {found, ok (null = no outcome yet), failure, logs, gasBurnt}.
  */
 async function sendOnce(slot,signed,save=()=>{},{waitMs=90_000,label='ledger'}={}){
  slot.at??={};
  if(!slot.tx_hash){
   const b=await buildFunctionCall({rpc,near,receiverId:VERIFIER,method:'execute_intents',args:{signed},gas:EXECUTE_GAS});
   Object.assign(slot,{tx_hash:b.hash,signed_base64:b.base64});slot.at.signed=iso(now());save();
  }
  let st=await transactionStatus(rpc,slot.tx_hash,accountId);
  if(!st.found){
   slot.at.submitted??=iso(now());save();
   try{await sendTransaction(rpc,slot.signed_base64,'INCLUDED')}
   catch(e){
    const text=JSON.stringify(e?.data??e?.message??String(e)).slice(0,400);
    if(PERMANENT.test(text)){
     // refused for good: this transaction can never run; the next call builds a new one around the same intents
     const dead=slot.tx_hash;delete slot.tx_hash;delete slot.signed_base64;slot.rejected=text;save();
     event({event:'ledger_near_tx_refused',label,tx_hash:dead,message:text.slice(0,200)});
     throw Error(`NEAR refused the transaction: ${text.slice(0,200)}`);
    }
    event({event:'ledger_near_send_uncertain',label,tx_hash:slot.tx_hash,message:text.slice(0,200)});
   }
   slot.at.included??=iso(now());save();
  }
  for(const t0=now();;){
   st=await transactionStatus(rpc,slot.tx_hash,accountId);
   if(st.found&&st.ok!==null)break;
   if(now()-t0>=waitMs)break;
   await sleep(pollMs);
  }
  if(st.ok!==null){slot.at.executed??=iso(now());slot.ok=st.ok;if(st.failure)slot.failure=st.failure;save()}
  event({event:'ledger_near_tx',label,tx_hash:slot.tx_hash,found:st.found,ok:st.ok,executed:settledOk(st),failure:st.failure??null,gas_burnt:st.gasBurnt??null});
  return st;
 }

 /** Waits until a sent transaction is final, so that the next read of a balance sees what it changed. Never throws;
  * gives up after finalWaitMs (the reads that follow are then retried or fail safe). */
 async function awaitFinal(slot){
  if(!slot?.tx_hash)return false;
  for(const t0=now();now()-t0<finalWaitMs;){
   try{const st=await transactionStatus(rpc,slot.tx_hash,accountId);if(st.found&&st.finality==='FINAL')return true}catch{}
   await sleep(pollMs);
  }
  return false;
 }

 /**
  * Pays committed quotes whose deposit is inside the ledger: ONE solver payload with a `transfer` per quote, one
  * NEAR call, then the destination balances are watched until every leg is delivered, 1Click reports a refund or a
  * failure, or `untilMs` passes. `run` is durable state ({signed, before, fund, notified}); `legs` =
  * [{symbol, originAsset, destinationAsset, quote:{depositAddress, amountIn, amountOut, minAmountOut}}] (strings) and
  * each gets `sourced` (raw, string) and `status`. Legs that share a destination (a sell's legs all pay into USDC)
  * are delivered together: the group is done when its balance grew by the sum of the minimums, and each leg's
  * `sourced` is its share of that growth by quoted amount. Returns {ok, reason, delta:{tokenId: bigint}}.
  */
 async function source(run,legs,{untilMs,save=()=>{},label='source'}){
  const dests=[...new Set(legs.map(l=>l.destinationAsset))];
  run.fund??={};
  if(!run.signed){
   const saltHex=await verifier.currentSalt();
   const {signed}=await signIntents(signer,{intents:sourcingIntents(legs.map(l=>({originAsset:l.originAsset,quote:l.quote}))),deadlineMs:Math.max(untilMs,now()+120_000),saltHex});
   // A view right after one of our own transactions can still show the state before it (seen live in the spike: the
   // unload after a sell was refused INSUFFICIENT_BALANCE on a stale read), so that one refusal is asked again.
   let sim=await verifier.simulate([signed]);
   for(let i=0;i<staleRetries&&!sim.ok&&sim.code==='INSUFFICIENT_BALANCE'&&now()<untilMs;i++){await sleep(pollMs);sim=await verifier.simulate([signed])}
   if(!sim.ok)return {ok:false,paid:false,reason:`the sourcing transfer does not simulate: ${sim.code}`,delta:{}};
   const bal=await verifier.balances(accountId,dests);
   run.before=Object.fromEntries(dests.map((d,i)=>[d,bal[i].toString()]));
   run.signed=signed;save();
  }
  let st;
  try{st=await sendOnce(run.fund,[run.signed],save,{label})}catch(e){return {ok:false,paid:false,reason:String(e?.message??e).slice(0,200),delta:{}}}
  if(st.ok===null)return {ok:false,paid:null,reason:'the sourcing transfer has no outcome yet',delta:{}};
  if(!settledOk(st))return {ok:false,paid:false,reason:'the sourcing transfer failed on NEAR: nothing was paid',delta:{}};
  if(!run.notified){
   // optional by the API's own description: it only saves 1Click the time to notice the transfer
   await Promise.all(legs.map(l=>Promise.resolve().then(()=>client.submitDeposit(l.quote.depositAddress,run.fund.tx_hash)).catch(()=>null)));
   run.notified=true;save();
  }
  const group=d=>legs.filter(l=>l.destinationAsset===d);
  let delta={};
  for(;;){
   const [bal,statuses]=await Promise.all([verifier.balances(accountId,dests),Promise.all(legs.map(l=>l.sourced||TERMINAL.includes(l.status)?null:Promise.resolve().then(()=>client.status(l.quote.depositAddress)).catch(()=>null)))]);
   legs.forEach((l,i)=>{const s=statuses[i]?.status;if(s&&!l.sourced)l.status=s});
   delta=Object.fromEntries(dests.map((d,i)=>[d,bal[i]-BigInt(run.before[d])]));
   for(const d of dests){
    const g=group(d).filter(l=>!l.sourced);
    if(!g.length||g.length!==group(d).length)continue;
    const min=g.reduce((a,l)=>a+BigInt(l.quote.minAmountOut),0n);
    if(delta[d]<min)continue;
    const quoted=g.reduce((a,l)=>a+BigInt(l.quote.amountOut),0n);
    let left=delta[d];
    g.forEach((l,i)=>{const share=i===g.length-1?left:delta[d]*BigInt(l.quote.amountOut)/quoted;left-=share;l.sourced=share.toString();l.status='SUCCESS'});
   }
   save();
   if(legs.every(l=>l.sourced||['REFUNDED','FAILED'].includes(l.status)))break;
   if(now()>=untilMs)break;
   await sleep(pollMs);
  }
  const ok=legs.every(l=>l.sourced);
  return {ok,paid:true,delta,reason:ok?null:`not sourced in time: ${legs.filter(l=>!l.sourced).map(l=>`${l.symbol} (${l.status??'no status'})`).join(', ')}`};
 }

 // ---- leftover inventory ----
 const triesToday=tokenId=>Number(db.prepare('SELECT COUNT(*) AS n FROM ledger_unload WHERE day=? AND token_id=?').get(utcDay(now()),tokenId).n);
 /**
  * Sells what the solver holds of `coins` ([{symbol, tokenId}]) back to USDC inside the ledger. Only while nothing
  * else runs (the caller holds no lock; this takes it). Per coin and UTC day at most cfg.unloadMaxTries tries; one
  * try sells at most cfg.unloadMaxRaw USDC worth. An unfinished try is followed before a new one is made. Reaching
  * the cap raises `onStuck` once per coin and day and leaves the coin for the operator.
  * `quote({originAsset, amount})` -> the firm internal quote (route.mjs). Returns [{symbol, state, ...}].
  */
 function unloadLeftovers({coins,quote,onStuck=()=>{},waitMs=90_000}){
  return lock(async()=>{
   const out=[];
   const bal=await verifier.balances(accountId,coins.map(c=>c.tokenId));
   for(const [i,c] of coins.entries()){
    const open=db.prepare("SELECT * FROM ledger_unload WHERE token_id=? AND state='open' ORDER BY id DESC LIMIT 1").get(c.tokenId);
    if(bal[i]<=0n&&!open)continue;
    // A sale that was paid and has had no outcome for longer than its quote lives is 1Click's to resolve (the coin
    // sits at its deposit account, to be delivered or refunded): it is closed here with an alert and counts as a try.
    if(open&&now()-open.created_at>staleUnloadMs){
     db.prepare("UPDATE ledger_unload SET state='failed',updated_at=? WHERE id=?").run(now(),open.id);
     onStuck({symbol:c.symbol,tokenId:c.tokenId,amount:open.amount_raw,tries:triesToday(c.tokenId),day:utcDay(now()),reason:'a paid sale has no outcome from 1Click',unload_id:open.id});
     out.push({symbol:c.symbol,state:'no_outcome'});continue;
    }
    let row=open,j;
    if(!row){
     const tries=triesToday(c.tokenId);
     if(tries>=cfg.unloadMaxTries){
      // the caller's alert outbox keeps one row per coin and day
      onStuck({symbol:c.symbol,tokenId:c.tokenId,amount:bal[i].toString(),tries,day:utcDay(now())});
      out.push({symbol:c.symbol,state:'capped',tries});continue;
     }
     let q,amount=bal[i];
     try{
      q=await quote({originAsset:c.tokenId,amount});
      if(q.amountOut>cfg.unloadMaxRaw){amount=amount*cfg.unloadMaxRaw/q.amountOut;if(amount<=0n)throw Error('nothing sellable under the unload bound');q=await quote({originAsset:c.tokenId,amount})}
     }catch(e){
      // a try that could not even be quoted still counts: an unsellable remainder must not be asked for forever
      db.prepare("INSERT INTO ledger_unload(day,token_id,amount_raw,state,json,created_at,updated_at) VALUES(?,?,?,'failed',?,?,?)").run(utcDay(now()),c.tokenId,amount.toString(),JSON.stringify({reason:String(e?.message??e).slice(0,200)}),now(),now());
      out.push({symbol:c.symbol,state:'no_quote',reason:String(e?.message??e).slice(0,120)});continue;
     }
     j={run:{},legs:[{symbol:c.symbol,originAsset:c.tokenId,destinationAsset:USDC_SOL_TOKEN_ID,quote:{depositAddress:q.depositAddress,amountIn:q.amountIn.toString(),amountOut:q.amountOut.toString(),minAmountOut:q.minAmountOut.toString()}}]};
     const id=db.prepare("INSERT INTO ledger_unload(day,token_id,amount_raw,state,json,created_at,updated_at) VALUES(?,?,?,'open',?,?,?)").run(utcDay(now()),c.tokenId,amount.toString(),JSON.stringify(j),now(),now()).lastInsertRowid;
     row={id};
    }else j=JSON.parse(row.json);
    const save=()=>db.prepare('UPDATE ledger_unload SET json=?,updated_at=? WHERE id=?').run(JSON.stringify(j),now(),row.id);
    const r=await source(j.run,j.legs,{untilMs:now()+waitMs,save,label:'unload'});
    const leg=j.legs[0],ended=r.ok||r.paid===false||['REFUNDED','FAILED'].includes(leg.status);
    if(ended)db.prepare('UPDATE ledger_unload SET state=?,json=?,updated_at=? WHERE id=?').run(r.ok?'done':'failed',JSON.stringify({...j,reason:r.reason}),now(),row.id);
    event({event:'ledger_unload',symbol:c.symbol,ok:r.ok,ended,usdc:leg.sourced??null,reason:r.reason});
    out.push({symbol:c.symbol,state:r.ok?'done':ended?'failed':'open',usdc:leg.sourced??null,reason:r.reason});
   }
   return out;
  });
 }

 return {accountId,signer,lock,busy:()=>depth>0,checkExposure,recordExposure,usedToday,sendOnce,awaitFinal,source,unloadLeftovers,
  /** The solver's USDC float inside the ledger (raw). */
  async float(){return (await verifier.balances(accountId,[USDC_SOL_TOKEN_ID]))[0]}};
}

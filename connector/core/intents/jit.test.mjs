// The balance model (docs/INTENTS-BALANCE-MODEL.md): builders, pricing rule, and the live steps against fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {base58Encode} from '../trade/router.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {TOKEN_PROGRAM} from '../pipeline/solana/message.mjs';
import {hex,uncurved} from './codec.mjs';
import {rawEd25519Signer,nep413Signer,verifyMultiPayload} from './sign.mjs';
import {unmatched,receivedFor,giveFor} from './intents.mjs';
import {createVerifier,NearRpcError} from './verifier.mjs';
import {transferIntent,sourcingIntents,quoteInternal,buyFloors,settleBuy,sellDiffs,sellSurplus,solverLoss,signUserDiff,signSolverSettle,costRow} from './jit.mjs';
import {stepJitBuy,stepJitSell,stepUnload,stepWithdrawUser,stepRefill,payInside} from './live-jit.mjs';
import {runStep} from './live.mjs';
import {parseArgs} from '../../../ops/intents-direct-spike.mjs';

const USDC='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
const WIF='nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near';
const BOME='nep141:sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near';
const TRUMP='nep141:sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near';
const SALT='252812b3';
const DEP='548b34d8fb77fa165a239f4e36ed549ba9ebd35e38715649da5126d36cb37225';
const LEGS=[{symbol:'WIF',tokenId:WIF,usdcIn:1_000_000n,minOut:6_519_736n},{symbol:'BOME',tokenId:BOME,usdcIn:1_000_000n,minOut:1_702_373_546n},{symbol:'TRUMP',tokenId:TRUMP,usdcIn:1_000_000n,minOut:890_826n}];
const QUOTED=[6_585_592n,1_719_569_239n,899_825n];

test('transfer intent: the shape 1Click itself generated for a committed quote on 2026-11-13 (no API key)',()=>{
 // POST /v0/generate-intent answered with this intents array for deposit account 548b… and 1.5 USDC
 const theirs=[{intent:'transfer',receiver_id:DEP,tokens:{[USDC]:'1500000'}}];
 assert.deepEqual(sourcingIntents([{originAsset:USDC,quote:{depositAddress:DEP,amountIn:1_500_000n}}]),theirs);
 assert.deepEqual(Object.keys(transferIntent({receiverId:DEP,tokens:{[WIF]:2n,[BOME]:1n}}).tokens),[BOME,WIF],'token ids sorted');
 assert.throws(()=>transferIntent({receiverId:DEP,tokens:{}}),/nothing/);
 assert.throws(()=>transferIntent({receiverId:DEP,tokens:{[USDC]:0n}}),/positive/);
 assert.throws(()=>transferIntent({receiverId:DEP,tokens:{'sol-x.omft.near':1n}}),/nep141/);
 assert.throws(()=>transferIntent({receiverId:'Not An Account',tokens:{[USDC]:1n}}),/account id/);
});

test('internal quote: the verifier on both sides, refunds to the same account; a committed quote must name a 64-hex deposit account',async()=>{
 const calls=[];
 const client=answer=>({quote:async req=>{calls.push(req);return {correlationId:'c',quoteRequest:{appFees:[{recipient:'5880',fee:20}]},quote:{amountIn:req.amount,amountOut:'9878382',minAmountOut:'9779598',amountInUsd:'1.499334',amountOutUsd:'1.486913',timeEstimate:12,...answer}}}});
 const q=await quoteInternal({client:client({depositAddress:DEP}),originAsset:USDC,destinationAsset:WIF,amount:1_500_000n,account:'aa'.repeat(32),dry:false,slippageBps:50,deadlineMs:Date.parse('2026-11-13T20:10:00Z')});
 assert.deepEqual((({dry,swapType,slippageTolerance,depositType,refundType,recipientType,refundTo,recipient,amount,deadline})=>({dry,swapType,slippageTolerance,depositType,refundType,recipientType,refundTo,recipient,amount,deadline}))(calls[0]),
  {dry:false,swapType:'EXACT_INPUT',slippageTolerance:50,depositType:'INTENTS',refundType:'INTENTS',recipientType:'INTENTS',refundTo:'aa'.repeat(32),recipient:'aa'.repeat(32),amount:'1500000',deadline:'2026-11-13T20:10:00.000Z'});
 assert.deepEqual([q.depositAddress,q.amountOut,q.minAmountOut,q.timeEstimate,q.appFees[0].fee],[DEP,9_878_382n,9_779_598n,12,20]);
 const args={originAsset:USDC,destinationAsset:WIF,amount:1_500_000n,account:'aa'.repeat(32),deadlineMs:0};
 assert.equal((await quoteInternal({...args,client:client({}),dry:true})).depositAddress,null,'a dry quote has no deposit account');
 await assert.rejects(quoteInternal({...args,client:client({}),dry:false}),/no verifier deposit account/);
 await assert.rejects(quoteInternal({...args,client:client({depositAddress:'So11111111111111111111111111111111111111112'}),dry:false}),/no verifier deposit account/);
 await assert.rejects(quoteInternal({...args,client:client({depositAddress:DEP,depositMemo:'1'}),dry:false}),/memo/);
 await assert.rejects(quoteInternal({...args,client:client({depositAddress:'aa'.repeat(32)}),dry:false}),/payer itself/);
 await assert.rejects(quoteInternal({...args,client:client({minAmountOut:'0'}),dry:true}),/minimum/);
});

test('buy: the user signs for the floor, the solver mirrors it exactly and hands over everything else it sourced',()=>{
 const f=buyFloors({legs:LEGS,feePips:1});
 assert.equal(f.userDiff[USDC],-3_000_000n);
 assert.deepEqual(f.legs.map(l=>l.userFloor),LEGS.map(l=>receivedFor(l.minOut,1)));
 assert.deepEqual(f.legs.map(l=>l.mustGive),LEGS.map(l=>giveFor(receivedFor(l.minOut,1),1)));
 assert.equal(f.usdc.solverReceives,2_999_997n);
 const s=settleBuy({floors:f,sourced:QUOTED,feePips:1});
 assert.equal(s.ok,true);
 assert.deepEqual(unmatched([f.userDiff,s.solverDiff],1),{},'the two diffs net to zero after the contract fee');
 // nothing stays with the solver: floor + surplus = what the solver gives away = what it sourced
 s.legs.forEach((l,i)=>{
  assert.equal(l.solverKeeps,0n);
  assert.equal(f.legs[i].mustGive+(s.surplus[l.tokenId]??0n),QUOTED[i]);
  assert.equal(l.userReceives,f.legs[i].userFloor+(s.surplus[l.tokenId]??0n));
 });
 // delivered exactly at the floor: no surplus intent at all
 assert.deepEqual(settleBuy({floors:f,sourced:f.legs.map(l=>l.mustGive),feePips:1}).surplus,{});
 // one unit below the floor on one leg: do not settle
 const short=settleBuy({floors:f,sourced:[f.legs[0].mustGive-1n,QUOTED[1],QUOTED[2]],feePips:1});
 assert.equal(short.ok,false);assert.deepEqual(short.short.map(x=>x.symbol),['WIF']);
 assert.equal(settleBuy({floors:f,sourced:[QUOTED[0]],feePips:1}).ok,false,'a leg that was never sourced counts as zero');
 // a margin is a setting: the solver keeps that share of what it sourced
 const fm=buyFloors({legs:LEGS,feePips:1,marginBps:50}),sm=settleBuy({floors:fm,sourced:QUOTED,feePips:1,marginBps:50});
 assert.equal(sm.legs[0].solverKeeps,QUOTED[0]-QUOTED[0]*9950n/10000n);
 assert.ok(fm.legs[0].userFloor<f.legs[0].userFloor);
 assert.throws(()=>buyFloors({legs:LEGS,feePips:1,marginBps:-1}),/margin/);
 assert.throws(()=>buyFloors({legs:[{...LEGS[0],minOut:1n}],feePips:1}),/too small/);
});

test('buy payloads: one token_diff for the user; the solver\'s payload carries the mirror diff and the surplus transfer',async()=>{
 const user=rawEd25519Signer(localSigner(Uint8Array.from({length:32},(_,i)=>i+1))),solver=nep413Signer(localSigner(Uint8Array.from({length:32},(_,i)=>200-i)));
 const f=buyFloors({legs:LEGS,feePips:1}),s=settleBuy({floors:f,sourced:QUOTED,feePips:1});
 const deadlineMs=Date.parse('2026-11-13T20:02:00Z');
 const u=await signUserDiff(user,{diff:f.userDiff,deadlineMs,saltHex:SALT});
 const p=JSON.parse(u.signed.payload);
 assert.deepEqual(p.intents.map(i=>i.intent),['token_diff']);
 assert.equal(p.intents[0].diff[USDC],'-3000000');assert.equal(p.deadline,'2026-11-13T20:02:00.000Z');
 assert.equal((await verifyMultiPayload(u.signed)).accountId,user.accountId);
 const so=await signSolverSettle(solver,{solverDiff:s.solverDiff,surplus:s.surplus,userAccount:user.accountId,deadlineMs,saltHex:SALT});
 const intents=JSON.parse(so.signed.payload.message).intents;
 assert.deepEqual(intents.map(i=>i.intent),['token_diff','transfer']);
 assert.equal(intents[1].receiver_id,user.accountId);
 assert.equal(intents[1].tokens[WIF],(QUOTED[0]-f.legs[0].mustGive).toString());
 assert.equal((await verifyMultiPayload(so.signed)).accountId,solver.accountId);
 const flat=await signSolverSettle(solver,{solverDiff:s.solverDiff,surplus:{},userAccount:user.accountId,deadlineMs,saltHex:SALT});
 assert.deepEqual(JSON.parse(flat.signed.payload.message).intents.map(i=>i.intent),['token_diff']);
});

test('sell: the solver receives the coin less the contract fee, pays the USDC floor at once, and passes the unload surplus on',()=>{
 const coin={symbol:'WIF',tokenId:WIF};
 const pre=sellDiffs({coin,amount:6_585_585n,feePips:1});
 assert.equal(pre.solverReceivesCoin,6_585_578n);
 const d=sellDiffs({coin,amount:6_585_585n,usdcMinOut:975_000n,feePips:1});
 assert.deepEqual(unmatched([d.userDiff,d.solverDiff],1),{});
 assert.equal(d.userDiff[WIF],-6_585_585n);assert.equal(d.userFloor,974_999n);assert.equal(d.solverPays,975_000n);
 assert.equal(sellSurplus({unloaded:985_000n,solverPays:d.solverPays}),10_000n);
 assert.equal(sellSurplus({unloaded:975_000n,solverPays:d.solverPays}),0n);
 assert.equal(sellSurplus({unloaded:985_000n,solverPays:d.solverPays,marginBps:100}),985_000n*99n/100n-975_000n);
 assert.throws(()=>sellDiffs({coin,amount:0n,feePips:1}),/nothing to sell/);
});

test('solver loss bound and the cost row',()=>{
 assert.deepEqual(solverLoss({spentUsdc:3_000_000n,receivesUsdc:2_999_997n}),{loss:3n,limit:3001n,ok:true});
 assert.equal(solverLoss({spentUsdc:3_000_000n,receivesUsdc:2_900_000n}).ok,false);
 const ii={amountIn:5_000_000n,amountOut:32_900_000n,amountInUsd:4.9978,amountOutUsd:4.9617,timeEstimate:12,appFees:[{fee:20}]};
 const r=costRow({symbol:'WIF',sizeUsdc:5,ii,back:{amountOut:4_927_900n},cc:{amountInUsd:4.9978,amountOutUsd:4.7496,timeEstimate:19},feePips:1,gasNear:0.006,nearUsd:3.54});
 assert.deepEqual([r.sourcing_cost_usd,r.sourcing_cost_basis,r.marked_cost_usd,r.of_which_1click_fee_usd,r.near_gas_usd,r.all_in_usd,r.round_trip_loss_usdc,r.chain_to_chain_cost_usd,r.time_estimate_s,r.chain_time_estimate_s],
  [0.0361,'half_round_trip',0.0361,0.01,0.0212,0.0573,0.0721,0.2482,12,19]);
 assert.equal(r.our_fee_usd,0);
 assert.equal(costRow({symbol:'WIF',sizeUsdc:5,ii,back:null,cc:null,feePips:1,gasNear:0,nearUsd:3.54}).sourcing_cost_basis,'usd_marks');
});

test('holdings: mt_tokens_for_owner is paged and zero balances are left out',async()=>{
 const ids=Array.from({length:5},(_,i)=>`nep141:t${i}.near`),calls=[];
 const rpc={view:async(account,method,args)=>{
  calls.push([method,args]);
  if(method==='mt_tokens_for_owner')return ids.slice(Number(args.from_index),Number(args.from_index)+args.limit).map(token_id=>({token_id}));
  if(method==='mt_batch_balance_of')return args.token_ids.map((_,i)=>String(i%2?0:i+1));
 }};
 const v=createVerifier({rpc});
 assert.deepEqual(await v.tokensForOwner('a.near',{pageSize:2}),ids);
 assert.deepEqual(calls.filter(c=>c[0]==='mt_tokens_for_owner').map(c=>c[1].from_index),['0','2','4']);
 assert.deepEqual(await v.holdings('a.near'),[{tokenId:ids[0],amount:1n},{tokenId:ids[2],amount:3n},{tokenId:ids[4],amount:5n}]);
});

test('CLI: the balance-model steps and their options; no fee of ours by default',()=>{
 const base=['--live','--near-key','k','--wallet','w'];
 assert.equal(parseArgs([]).marginBps,0);
 assert.deepEqual(parseArgs([]).sizeList,[5,10,15,25]);
 const b=parseArgs([...base,'--jit-buy','--usdc','3','--coins','WIF,BOME']);
 assert.deepEqual([b.step,b.source,b.deadlineS,b.usdc,b.sourceSlippageBps,b.minLeftS,b.maxLossBps],['jit-buy','inside',120,'3',100,10,10]);
 assert.equal(parseArgs([...base,'--jit-buy','--source','outside']).deadlineS,300);
 assert.equal(parseArgs([...base,'--jit-buy','--source','outside','--deadline-s','240']).deadlineS,240);
 assert.equal(parseArgs([...base,'--trade']).deadlineS,300);
 assert.throws(()=>parseArgs([...base,'--jit-buy','--source','jupiter']),/inside or outside/);
 const s=parseArgs([...base,'--jit-sell','--coin','WIF','--percent','50']);
 assert.deepEqual([s.step,s.coin,s.percent,s.deadlineS],['jit-sell','WIF',50,120]);
 assert.throws(()=>parseArgs([...base,'--jit-sell']),/needs --coin/);
 assert.throws(()=>parseArgs([...base,'--jit-sell','--coin','WIF','--percent','0']),/percent/);
 assert.deepEqual((({step,solverUsdc})=>({step,solverUsdc}))(parseArgs([...base,'--solver-usdc','3.5'])),{step:'solver-usdc',solverUsdc:'3.5'});
 assert.throws(()=>parseArgs([...base,'--solver-usdc','lots']),/positive amount/);
 assert.deepEqual((({step,usdc})=>({step,usdc}))(parseArgs([...base,'--deposit-user','6'])),{step:'deposit-user',usdc:'6'});
 assert.equal(parseArgs([...base,'--deposit-user']).usdc,'4.5');
 assert.equal(parseArgs([...base,'--deposit-user','--user-evm']).userEvm,true);
 assert.deepEqual((({step,coin})=>({step,coin}))(parseArgs([...base,'--withdraw-user','--coin','BOME'])),{step:'withdraw-user',coin:'BOME'});
 assert.equal(parseArgs([...base,'--refill','--refill-usdc','2']).refillUsdc,'2');
 assert.equal(parseArgs([...base,'--unload']).step,'unload');
 assert.throws(()=>parseArgs([...base,'--jit-buy','--unload']),/one step per run/);
 assert.throws(()=>parseArgs(['--jit-buy']),/--live step/);
 assert.throws(()=>parseArgs([...base,'--jit-buy','--min-left-s','200']),/min-left-s/);
 assert.equal(parseArgs(['--plan','--no-survey','--sizes','5,25']).survey,false);
 assert.throws(()=>parseArgs(['--sizes','0']),/sizes/);
});

// ---------- live steps against fakes ----------
// A NEAR node that knows a transaction only once it was sent, a verifier with real balances, and a 1Click that fills a
// funded deposit account at the quoted amount (or as `fill` says).
function jitCtx(over={}){
 const nearKey=localSigner(Uint8Array.from({length:32},(_,i)=>200-i)),wallet={solana:localSigner(Uint8Array.from({length:32},(_,i)=>i+1))};
 const n={accountId:hex(uncurved('ed25519',`ed25519:${nearKey.address}`,32)),address:nearKey.address,publicKey:`ed25519:${nearKey.address}`,key:nearKey,created:false};
 const user=rawEd25519Signer(wallet.solana);
 const lines=[],sent=[],sims=[],quotes=[],notified=[];
 let t=Date.parse('2026-11-13T17:00:00Z'),nonce=41;
 const bal={[user.accountId]:{[USDC]:6_000_000n},[n.accountId]:{[USDC]:3_500_000n}};
 const of=(a,id)=>bal[a]?.[id]??0n,add=(a,id,d)=>{(bal[a]??={})[id]=of(a,id)+d};
 const deposits={};   // deposit account -> {dest, out, origin, amountIn}
 const PRICE={[WIF]:6_585_592n,[BOME]:1_719_569_239n,[TRUMP]:899_825n};
 // applies what the contract would: transfers and diffs of every payload in the batch
 function apply(signed){
  for(const mp of signed){
   const p=typeof mp.payload==='string'?JSON.parse(mp.payload):JSON.parse(mp.payload.message);
   for(const it of p.intents){
    if(it.intent==='transfer')for(const [id,v] of Object.entries(it.tokens)){
     add(p.signer_id,id,-BigInt(v));
     const d=deposits[it.receiver_id];
     if(d){const out=over.fill?over.fill(d):d.out;if(out!==null){add(n.accountId,d.dest,out);d.filled=out}else d.refunded=true}
     else add(it.receiver_id,id,BigInt(v));
    }
    if(it.intent==='token_diff')for(const [id,v] of Object.entries(it.diff))add(p.signer_id,id,BigInt(v));
    if(it.intent==='ft_withdraw')add(p.signer_id,`nep141:${it.token}`,-BigInt(it.amount));
   }
  }
 }
 const known=new Set();
 const rpc={call:async(method,params)=>{
  if(method==='query'&&params.request_type==='view_access_key')return {nonce:nonce++,block_hash:'244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM',permission:'FullAccess'};
  if(method==='send_tx'){
   const raw=Buffer.from(params.signed_tx_base64,'base64');
   known.add(base58Encode(createHash('sha256').update(raw.subarray(0,raw.length-65)).digest()));
   sent.push(raw);
   const at=raw.indexOf(Buffer.from('{"signed":'));
   // the function-call arguments are length-prefixed (u32) in the transaction bytes: read exactly that many
   if(at>=0)apply(JSON.parse(raw.subarray(at,at+raw.readUInt32LE(at-4)).toString('utf8')).signed);
   return {};
  }
  if(method==='EXPERIMENTAL_tx_status'){
   if(!known.has(params.tx_hash))throw new NearRpcError('UNKNOWN_TRANSACTION',{cause:{name:'UNKNOWN_TRANSACTION'}});
   return {final_execution_status:'EXECUTED_OPTIMISTIC',transaction_outcome:{outcome:{status:{SuccessReceiptId:'r'},gas_burnt:1}},receipts_outcome:[{id:'r',outcome:{executor_id:'intents.near',status:{SuccessValue:''},logs:['EVENT_JSON:{"standard":"dip4","event":"intents_executed","data":[]}'],gas_burnt:2}}]};
  }
  throw Error(`unexpected ${method}`);
 }};
 const verifier={contract:'intents.near',currentSalt:async()=>SALT,fee:async()=>1,balances:async(a,ids)=>ids.map(id=>of(a,id)),holdings:async a=>Object.entries(bal[a]??{}).filter(([,v])=>v>0n).map(([tokenId,amount])=>({tokenId,amount})),
  simulate:async signed=>{
   sims.push(signed);
   if(over.simulate)return over.simulate(signed,sims.length);
   // a user payload alone passes every check and is only unmatched; anything else is taken as balanced
   const alone=signed.length===1&&signed[0].standard!=='nep413'&&JSON.parse(signed[0].payload).intents[0].intent==='token_diff';
   return alone?{ok:false,stage:'invariant',code:'INVARIANT_VIOLATED',message:'token deltas do not net to zero'}:{ok:true,output:{intents_executed:[]}};
  }};
 let dep=0;
 const client={baseUrl:'x',
  quote:async req=>{
   quotes.push(req);
   const out=req.destinationAsset===USDC?BigInt(req.amount)*150n/1000n:PRICE[req.destinationAsset]*BigInt(req.amount)/1_000_000n;
   const q={amountIn:req.amount,amountOut:out.toString(),minAmountOut:(out*99n/100n).toString(),amountInUsd:'1',amountOutUsd:'1',timeEstimate:12};
   if(!req.dry){q.depositAddress=req.depositType==='INTENTS'?(++dep).toString(16).padStart(64,'d'):base58Encode(Uint8Array.from({length:32},(_,i)=>i+dep++ +60));deposits[q.depositAddress]={dest:req.destinationAsset,out,origin:req.originAsset,amountIn:req.amount};q.deadline=new Date(t+30*60_000).toISOString()}
   return {correlationId:`c${quotes.length}`,quoteRequest:{},quote:q};
  },
  submitDeposit:async(address,hash)=>{notified.push([address,hash]);return {}},
  status:async address=>{const d=deposits[address];return {status:d?.filled!==undefined?'SUCCESS':d?.refunded?'REFUNDED':'PENDING_DEPOSIT',swapDetails:{amountOut:d?.filled?.toString()??null}}}};
 const omni={fee:async()=>({nativeFee:60_000_000_000_000_000_000_000n,usd:0.21}),storageBalance:async()=>over.storage===undefined?{total:10n**24n,available:10n**24n}:over.storage,
  storageRequirements:async()=>({account:1_410_000_000_000_000_000_000n,transfer:4_690_000_000_000_000_000_000n}),transfers:async()=>[{status:'Finalised',solanaTx:'s',initialisedAt:100,finalisedAt:168}]};
 const solana={};
 const sol={accountInfo:async()=>({owner:TOKEN_PROGRAM}),tokenBalance:async ata=>solana[ata]??null};
 const state={version:1,near_account:n.accountId,steps:{}};
 const ctx={near:n,wallet,user,recipient:wallet.solana.address,rpc,verifier,omni,client,sol,state,save:()=>{},emit:l=>lines.push(l),now:()=>t+=250,sleep:async()=>{},
  opts:parseArgs(['--live','--near-key','k','--wallet','w','--jit-buy','--usdc','3'])};
 return {ctx,lines,sent,sims,quotes,notified,bal,of,deposits,solana,user,n,clock:{jump:ms=>{t+=ms}}};
}
const intentsOf=mp=>(typeof mp.payload==='string'?JSON.parse(mp.payload):JSON.parse(mp.payload.message)).intents;

test('jit buy, inside: firm quotes, the user signs first, ONE sourcing transaction, then ONE settlement with [solver, user]; nothing is sent twice',async()=>{
 const {ctx,lines,sent,sims,quotes,notified,of,user,n}=jitCtx();
 const r=await stepJitBuy(ctx);
 assert.equal(r.ok,true);assert.equal(r.executed,true);assert.equal(r.source,'inside');
 // three committed quotes, each with the verifier on both sides and the solver's own account as payer and recipient
 assert.deepEqual(quotes.map(q=>[q.dry,q.depositType,q.recipientType,q.refundType,q.recipient,q.amount]),[WIF,BOME,TRUMP].map(()=>[false,'INTENTS','INTENTS','INTENTS',n.accountId,'1000000']));
 // order of events: the user's signature exists before anything is paid
 const stages=lines.map(l=>`${l.step}:${l.stage}`);
 assert.ok(stages.indexOf('jit_buy:user_signed')<stages.indexOf('jit_buy_fund:near_tx_sent'));
 assert.ok(stages.indexOf('jit_buy_fund:near_tx_sent')<stages.indexOf('jit_buy:simulated'));
 assert.equal(sent.length,2);
 // simulations: the user payload alone, the sourcing payload, the settlement
 assert.equal(sims.length,3);
 assert.deepEqual(intentsOf(sims[0][0]).map(i=>i.intent),['token_diff']);assert.equal(sims[0][0].standard,'raw_ed25519');
 assert.deepEqual(intentsOf(sims[1][0]).map(i=>[i.intent,Object.values(i.tokens)[0]]),[['transfer','1000000'],['transfer','1000000'],['transfer','1000000']]);
 assert.deepEqual(sims[2].map(s=>s.standard),['nep413','raw_ed25519']);
 assert.deepEqual(intentsOf(sims[2][0]).map(i=>i.intent),['token_diff','transfer']);
 assert.deepEqual(sims[2][1],ctx.state.steps.jit_buy.user_signed,'the user payload executed is the one signed before sourcing');
 assert.equal(notified.length,3);
 // balances inside the verifier: the user has every coin the solver sourced, the solver has its USDC back less the fee
 assert.equal(of(user.accountId,USDC),3_000_000n);
 assert.equal(of(user.accountId,WIF),BigInt(r.legs[0].user_receives));
 assert.deepEqual(r.user_delta,{USDC:'-3000000',WIF:r.legs[0].user_receives,BOME:r.legs[1].user_receives,TRUMP:r.legs[2].user_receives});
 assert.equal(r.solver_delta.USDC,'-3');
 assert.deepEqual([r.solver_delta.WIF,r.solver_delta.BOME,r.solver_delta.TRUMP].map(v=>BigInt(v)<=7n),[true,true,true],'only the contract fee dust is left with the solver');
 assert.deepEqual(r.legs.map(l=>l.solver_keeps),['0','0','0']);
 for(const k of ['quote','user_signature','sourcing_all','simulate','execute','total'])assert.equal(typeof r.seconds[k],'number',k);
 assert.deepEqual(Object.keys(r.seconds.sourcing),['WIF','BOME','TRUMP']);
 assert.ok(!JSON.stringify(lines).includes('seed'));
 // a rerun replays the result; --new-trade starts another
 const again=await stepJitBuy(ctx);
 assert.equal(again.tx_hash,r.tx_hash);assert.equal(sent.length,2);assert.equal(quotes.length,3);
 ctx.opts.newTrade=true;
 const second=await stepJitBuy(ctx);
 assert.equal(second.ok,true);assert.notEqual(second.tx_hash,r.tx_hash);assert.equal(sent.length,4);assert.equal(ctx.state.steps.jit_buy_done.length,1);
});

test('jit buy: refused before anything is signed or paid when the user or the solver is short, or the user payload does not simulate',async()=>{
 {const {ctx,lines,sent,quotes,bal,user}=jitCtx();bal[user.accountId][USDC]=1n;assert.equal((await stepJitBuy(ctx)).ok,false);assert.match(lines.at(-1).reason,/user verifier account holds less/);assert.equal(quotes.length,0);assert.equal(sent.length,0)}
 {const {ctx,lines,sent,bal,n}=jitCtx();bal[n.accountId][USDC]=2_000_000n;await stepJitBuy(ctx);assert.match(lines.at(-1).reason,/solver verifier account holds less/);assert.equal(lines.at(-1).fix,'--solver-usdc');assert.equal(sent.length,0)}
 {const {ctx,lines,sent}=jitCtx({simulate:()=>({ok:false,stage:'intent_execution',code:'INSUFFICIENT_BALANCE',message:'insufficient balance or overflow'})});
  await stepJitBuy(ctx);assert.match(lines.at(-1).reason,/user payload does not simulate/);assert.equal(sent.length,0);assert.equal(ctx.state.steps.jit_buy.user_signed,undefined)}
});

test('jit buy: a leg that is refunded, delivered short or late is never settled; the user\'s intent just expires',async()=>{
 // 1Click refunds one leg
 {
  const {ctx,sent,sims,of,user}=jitCtx({fill:d=>d.dest===BOME?null:d.out});
  const r=await stepJitBuy(ctx);
  assert.equal(r.ok,false);assert.equal(r.executed,false);assert.match(r.reason,/BOME \(REFUNDED\)/);
  assert.equal(sent.length,1,'only the sourcing transaction');assert.equal(sims.length,2,'no settlement was even simulated');
  assert.equal(of(user.accountId,USDC),6_000_000n,'the user still has all of their USDC');
  assert.equal(r.solver_delta_since_start.WIF,'6585592');assert.match(r.fix,/--unload/);
  assert.equal((await stepJitBuy(ctx)).replayed,true);assert.equal(sent.length,1);
 }
 // nothing arrives before the deadline (minus --min-left-s)
 {
  const {ctx,sent}=jitCtx({fill:()=>null});
  ctx.client.status=async()=>({status:'PROCESSING'});
  const r=await stepJitBuy(ctx);
  assert.equal(r.executed,false);assert.match(r.reason,/not sourced in time/);assert.equal(sent.length,1);
 }
 // the deadline is already too close when sourcing would start
 {
  const {ctx,sent,clock}=jitCtx();
  const sim=ctx.verifier.simulate;
  ctx.verifier.simulate=async s=>{const r=await sim(s);clock.jump(115_000);return r};
  const r=await stepJitBuy(ctx);
  assert.match(r.reason,/too close before sourcing started/);assert.equal(sent.length,0);
 }
 // the settlement does not simulate (for example the salt rotated): nothing is executed
 {
  const {ctx,sent}=jitCtx({simulate:(signed,k)=>k===3?{ok:false,stage:'nonce_salt',code:'INVALID_SALT',message:'invalid salt'}:k===1?{ok:false,stage:'invariant',code:'INVARIANT_VIOLATED'}:{ok:true,output:{}}});
  const r=await stepJitBuy(ctx);
  assert.match(r.reason,/does not simulate: INVALID_SALT/);assert.equal(sent.length,1);
 }
});

test('jit sell: the user is paid from the solver\'s USDC in one transaction; the solver then unloads and passes the surplus on',async()=>{
 const {ctx,lines,sent,sims,quotes,bal,of,user,n}=jitCtx();
 bal[user.accountId][WIF]=6_585_585n;
 Object.assign(ctx.opts,parseArgs(['--live','--near-key','k','--wallet','w','--jit-sell','--coin','WIF']));
 const r=await stepJitSell(ctx);
 assert.equal(r.ok,true);assert.equal(r.executed,true);
 // the unload quote is for what the solver will hold: the amount given less the contract fee
 assert.deepEqual([quotes[0].originAsset,quotes[0].destinationAsset,quotes[0].amount,quotes[0].depositType,quotes[0].recipientType],[WIF,USDC,'6585578','INTENTS','INTENTS']);
 assert.equal(sent.length,3,'settlement, unload, surplus');
 assert.deepEqual(sims[0].map(s=>s.standard),['nep413','raw_ed25519']);
 assert.deepEqual(intentsOf(sims[0][1])[0].diff[WIF],'-6585585');
 assert.equal(of(user.accountId,WIF),0n);
 // the user ends with everything the unload produced (less the fee on the floor part): floor at once, surplus after
 const unloaded=BigInt(r.unloaded_usdc);
 assert.equal(BigInt(r.user_paid_at_once)+BigInt(r.surplus_to_user),unloaded-1n);
 assert.equal(of(user.accountId,USDC),6_000_000n+unloaded-1n);
 assert.equal(of(n.accountId,USDC),3_500_000n,'the solver is back at its float');
 assert.equal(lines.filter(l=>l.stage==='near_tx_sent').length,3);
 for(const k of ['quote','user_signature','simulate','execute','user_paid_after','unload'])assert.equal(typeof r.seconds[k],'number',k);
 const again=await stepJitSell(ctx);assert.equal(again.replayed,true);assert.equal(sent.length,3);
 // refusals
 {const x=jitCtx();Object.assign(x.ctx.opts,{coin:'WIF',percent:100});await stepJitSell(x.ctx);assert.match(x.lines.at(-1).reason,/holds no WIF/)}
 {const x=jitCtx();x.bal[x.user.accountId][WIF]=6_585_585n;x.bal[x.n.accountId][USDC]=1n;Object.assign(x.ctx.opts,{coin:'WIF',percent:100});await stepJitSell(x.ctx);assert.match(x.lines.at(-1).reason,/must pay the user/);assert.equal(x.sent.length,0)}
});

test('unload, solver float, withdrawal on request and refill',async()=>{
 const {ctx,lines,sent,sims,quotes,bal,of,solana,user,n}=jitCtx();
 // unload: every coin the solver holds goes back to USDC in one sourcing-style transaction
 bal[n.accountId][WIF]=1000n;bal[n.accountId][TRUMP]=2000n;
 const u=await stepUnload(ctx);
 assert.equal(u.ok,true);assert.deepEqual(u.legs.map(l=>[l.symbol,l.sold]),[['WIF','1000'],['TRUMP','2000']]);
 assert.equal(sent.length,1);assert.deepEqual(intentsOf(sims[0][0]).map(i=>i.intent),['transfer','transfer']);
 assert.equal(of(n.accountId,WIF),0n);
 assert.equal((await stepUnload(ctx)).nothing_to_unload,true);
 // withdrawal on request: the user's whole balance of one token, one ft_withdraw through the Omni bridge
 bal[user.accountId][BOME]=5000n;
 Object.assign(ctx.opts,{coin:'BOME',followS:0});
 const w=await stepWithdrawUser(ctx);
 const wi=intentsOf(sims.at(-1)[0]);
 assert.deepEqual(wi.map(i=>[i.intent,i.receiver_id,i.amount]),[['ft_withdraw','omni.bridge.near','5000']]);
 assert.equal(sims.at(-1)[0].standard,'raw_ed25519');
 assert.equal(w.ok,false,'not on Solana yet in this fake');assert.match(w.note,/run the same step again/);
 const before=sent.length;
 // the coins land: the same step, run again, reports the arrival and sends nothing
 const {associatedTokenAddress}=await import('../pipeline/solana/message.mjs');
 solana[associatedTokenAddress(ctx.recipient,'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',TOKEN_PROGRAM)]=5000n;
 const w2=await stepWithdrawUser(ctx);
 assert.equal(w2.ok,true);assert.equal(w2.received_on_solana,'5000');assert.equal(sent.length,before);assert.equal(typeof w2.seconds.submit_to_arrival,'number');assert.equal(w2.bridge[0].bridge_seconds,68);
 // refill: the SOLVER's USDC leaves for the wallet
 Object.assign(ctx.opts,{refillUsdc:'2'});
 await stepRefill(ctx);
 const ri=intentsOf(sims.at(-1)[0]);
 assert.equal(sims.at(-1)[0].standard,'nep413');assert.deepEqual([ri[0].intent,ri[0].amount],['ft_withdraw','2000000']);
 // too little bridge storage: refused before signing a transaction
 const x=jitCtx({storage:null});x.bal[x.user.accountId][BOME]=5n;Object.assign(x.ctx.opts,{coin:'BOME',followS:0});
 await stepWithdrawUser(x.ctx);assert.match(x.lines.at(-1).reason,/storage balance/);assert.equal(x.sent.length,0);
 // runStep routes the new steps and the status line lists both portfolios
 const y=jitCtx();y.ctx.opts.step='unload';assert.equal(await runStep(y.ctx),0);
 assert.ok(!JSON.stringify(lines).includes('seed'));assert.equal(quotes.length>=2,true);
});

test('payInside: a sourcing payload that does not simulate pays nothing',async()=>{
 const {ctx,sent}=jitCtx({simulate:()=>({ok:false,stage:'intent_execution',code:'INSUFFICIENT_BALANCE',message:'insufficient balance or overflow'})});
 const r=await payInside(ctx,{},'x',[{symbol:'WIF',originAsset:USDC,destinationAsset:WIF,quote:{depositAddress:DEP,amountIn:'1',minAmountOut:'1'}}],{untilMs:0});
 assert.equal(r.ok,false);assert.match(r.reason,/does not simulate/);assert.equal(sent.length,0);
});

// the wallet's Solana side for the outside route and the float deposit: every transfer lands, and 1Click credits the
// solver's verifier account when it is told about the deposit
function withSolana(x){
 const {ctx,deposits,bal,n}=x,solSent=[];
 const USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 ctx.sol={accountInfo:async a=>a===USDC_MINT?{owner:TOKEN_PROGRAM,lamports:1}:null,tokenBalance:async()=>10_000_000n,latestBlockhash:async()=>({blockhash:'244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM',lastValidBlockHeight:'100'}),
  blockhashValid:async()=>true,balance:async()=>10_000_000,broadcast:async b=>{solSent.push(Uint8Array.from(b));return 'sig'}};
 ctx.signatureStatus=async()=>({status:'confirmed'});ctx.feePayer=null;
 ctx.client.submitDeposit=async address=>{const d=deposits[address];if(d&&d.filled===undefined){d.filled=d.out;(bal[n.accountId]??={})[d.dest]=(bal[n.accountId][d.dest]??0n)+d.out}return {}};
 return solSent;
}
test('jit buy, outside: the same user signature first; each coin is bought with the wallet\'s Solana USDC and delivered to the solver\'s verifier account; one NEAR transaction settles',async()=>{
 const x=jitCtx(),{ctx,lines,sent,sims,quotes,of,user,n}=x,solSent=withSolana(x);
 Object.assign(ctx.opts,parseArgs(['--live','--near-key','k','--wallet','w','--jit-buy','--usdc','3','--source','outside']));
 x.bal[n.accountId][USDC]=0n;   // the solver needs no USDC inside the verifier for this route
 const r=await stepJitBuy(ctx);
 assert.equal(r.ok,true,JSON.stringify([r,lines.slice(-6)]).slice(0,1500));assert.equal(r.source,'outside');assert.equal(r.sourcing_tx_hash,null);
 assert.deepEqual(quotes.map(q=>[q.dry,q.depositType,q.recipientType,q.recipient,q.refundType,q.amount]),[WIF,BOME,TRUMP].map(()=>[false,'ORIGIN_CHAIN','INTENTS',n.accountId,'ORIGIN_CHAIN','1000000']));
 assert.equal(solSent.length,3,'three Solana transfers');assert.equal(sent.length,1,'one NEAR transaction: the settlement');
 const stages=lines.map(l=>`${l.step}:${l.stage}`);
 assert.ok(stages.indexOf('jit_buy:user_signed')<stages.indexOf('jit_buy_WIF:transfer_sent'));
 assert.deepEqual(sims.at(-1).map(s=>s.standard),['nep413','raw_ed25519']);
 assert.equal(of(user.accountId,USDC),3_000_000n);assert.equal(of(user.accountId,BOME),BigInt(r.legs[1].user_receives));
 assert.equal(r.solver_delta.USDC,'2999997','the user\'s USDC stays with the solver inside the verifier: the pool that --refill sends back to Solana');
 assert.deepEqual(Object.keys(r.seconds.sourcing),['WIF','BOME','TRUMP']);
 assert.equal(ctx.state.steps.jit_buy.deadline_ms-ctx.state.steps.jit_buy.started_ms>250_000,true,'a 300 s user deadline for the route with a chain deposit');
});
test('solver float: one same-asset deposit quote from the wallet\'s Solana USDC into the solver\'s verifier account; a rerun pays nothing',async()=>{
 const x=jitCtx(),{ctx,lines,quotes,n,of}=x,solSent=withSolana(x);
 Object.assign(ctx.opts,parseArgs(['--live','--near-key','k','--wallet','w','--solver-usdc','3.5']));
 const {stepSolverUsdc}=await import('./live-jit.mjs');
 await stepSolverUsdc(ctx);
 assert.deepEqual([quotes[0].originAsset,quotes[0].destinationAsset,quotes[0].recipient,quotes[0].recipientType,quotes[0].amount],[USDC,USDC,n.accountId,'INTENTS','3500000']);
 assert.equal(lines.at(-1).ok,true);assert.equal(lines.at(-1).status,'SUCCESS');assert.equal(solSent.length,1);
 assert.equal(of(n.accountId,USDC),3_500_000n+3_500_000n*150n/1000n,'this fake fills USDC quotes at its own rate; the real quote is 1:1');
 await stepSolverUsdc(ctx);
 assert.equal(solSent.length,1);assert.equal(quotes.length,1);
});

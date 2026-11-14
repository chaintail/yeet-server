// Test doubles for the ledger route: an in-memory NEAR Intents ledger that really verifies every signed payload
// (core/intents/sign.mjs verifyMultiPayload) and applies `token_diff` and `transfer` with the contract's fee and its
// zero-sum rule, a NEAR RPC that executes `execute_intents` against it, and a 1Click that quotes and fills with the
// ledger on both sides. Nothing here touches a network.
import {createHash,randomBytes} from 'node:crypto';
import {base58Encode,CATALOG,formatUnits} from '../trade/router.mjs';
import {openTradeDb} from '../trade/db.mjs';
import {fakeBalances,fakeClock,BASE_WALLET} from '../trade/fakes.mjs';
import {createPipeline} from '../pipeline/pipeline.mjs';
import {staticWalletDirectory} from '../pipeline/wallet-directory.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {fakeSolanaRpc,fakeFeePayer,ALICE,BOB,aliceWallet,bobWallet} from '../pipeline/fakes.mjs';
import {verifyMultiPayload,ed25519AccountId} from '../intents/sign.mjs';
import {feeCeil} from '../intents/intents.mjs';
import {NearRpcError} from '../intents/verifier.mjs';
import {USDC_SOL_TOKEN_ID,VERIFIER} from '../intents/constants.mjs';
import {privyRpcBodies,signedFromWallets} from '../pipeline/wallet-request.mjs';

export {ALICE,BOB,aliceWallet,bobWallet};
const seed=s=>Uint8Array.from(createHash('sha256').update(s).digest());
export const coin=symbol=>CATALOG.find(c=>c.chain==='solana'&&c.symbol===symbol);
export const WIF=coin('WIF').assetId,BOME=coin('BOME').assetId,TRUMP=coin('TRUMP').assetId,USDC=USDC_SOL_TOKEN_ID;
/** The solver's key in the shape near-tx.mjs loadOrCreateNearKey returns. */
export function solverKey(name='ledger-solver'){
 const key=localSigner(seed(name));
 return {accountId:ed25519AccountId(key.address),address:key.address,publicKey:`ed25519:${key.address}`,key};
}
/** Coin raw units per 1 USDC (1,000,000 raw): the quotes of the spike's live buy (receipts/intents-live/06). */
export const RATES=Object.freeze({[WIF]:6_673_811n,[BOME]:1_738_598_300n,[TRUMP]:915_597n});

export function fakeLedger({now,feePips=1}){
 let bal=new Map(),nonces=new Set();
 const get=(m,a,id)=>m.get(a)?.get(id)??0n;
 const add=(m,a,id,v)=>{if(!m.has(a))m.set(a,new Map());m.get(a).set(id,get(m,a,id)+v)};
 const clone=()=>new Map([...bal].map(([a,t])=>[a,new Map(t)]));
 const stop=(code,message)=>({ok:false,code,message});
 /** The engine: every payload verified and applied in order, then the zero-sum check. `commit` keeps the result. */
 async function apply(signed,commit){
  const b=clone(),used=new Set(nonces),net={};
  const delta=(id,v)=>{net[id]=(net[id]??0n)+v};
  for(const mp of signed){
   let who;
   try{who=await verifyMultiPayload(mp)}catch{return stop('INVALID_SIGNATURE','invalid signature')}
   let body;
   try{body=mp.standard==='nep413'?{...JSON.parse(mp.payload.message),nonce:mp.payload.nonce,verifying_contract:mp.payload.recipient}:JSON.parse(mp.payload)}catch{return stop('BAD_ENCODING','JSON: bad payload')}
   if(body.verifying_contract!==VERIFIER)return stop('WRONG_VERIFYING_CONTRACT','wrong verifying_contract');
   if(!(Date.parse(body.deadline)>now()))return stop('DEADLINE_EXPIRED','deadline has expired');
   if(body.signer_id!==who.accountId)return stop('PUBLIC_KEY_NOT_EXIST',"public key doesn't exist for account");
   const key=`${who.accountId}|${body.nonce}`;
   if(used.has(key))return stop('NONCE_USED','nonce was already used');
   used.add(key);
   for(const it of body.intents){
    if(it.intent==='token_diff'){
     for(const [id,d] of Object.entries(it.diff)){
      const v=BigInt(d);
      add(b,who.accountId,id,v);
      if(get(b,who.accountId,id)<0n)return stop('INSUFFICIENT_BALANCE','insufficient balance or overflow');
      delta(id,v);
      if(v<0n){const fee=feeCeil(-v,feePips);add(b,'fee-collector',id,fee);delta(id,fee)}
     }
    }else if(it.intent==='transfer'){
     if(it.receiver_id===who.accountId)return stop('INVALID_INTENT','invalid intent');
     for(const [id,d] of Object.entries(it.tokens)){
      const v=BigInt(d);
      add(b,who.accountId,id,-v);
      if(get(b,who.accountId,id)<0n)return stop('INSUFFICIENT_BALANCE','insufficient balance or overflow');
      add(b,it.receiver_id,id,v);
     }
    }else return stop('INVALID_INTENT','invalid intent');
   }
  }
  if(Object.values(net).some(v=>v!==0n))return {ok:false,code:'INVARIANT_VIOLATED',invariant:true};
  if(commit){bal=b;nonces=used}
  return {ok:true};
 }
 const world={
  feePips,apply,executed:[],
  balance:(account,id)=>get(bal,account,id),
  credit:(account,id,v)=>add(bal,account,id,BigInt(v)),
  move(from,to,id,v){add(bal,from,id,-BigInt(v));add(bal,to,id,BigInt(v))},
  /** core/intents/verifier.mjs createVerifier, over this ledger. */
  verifier:{
   contract:VERIFIER,
   currentSalt:async()=>'0a0b0c0d',
   fee:async()=>feePips,
   balances:async(account,ids)=>ids.map(id=>get(bal,account,id)),
   isNonceUsed:async(account,nonce)=>nonces.has(`${account}|${nonce}`),
   async simulate(signed){
    world.simulations=(world.simulations??0)+1;
    const r=await apply(signed,false);
    if(r.ok)return {ok:true,output:{}};
    if(r.invariant)return {ok:false,stage:'invariant',code:'INVARIANT_VIOLATED',message:'token deltas do not net to zero'};
    return {ok:false,stage:'x',code:r.code,message:r.message};
   },
  },
 };
 // ---- NEAR RPC: access key, send_tx (executes at once), transaction status ----
 const txs=new Map();let keyNonce=100;
 world.txs=txs;
 /** `failSends`: the next n transactions are included but fail on chain (nothing is applied). `dropSends`: the next n
  * are lost in transport (unknown to the chain). */
 world.failSends=0;world.dropSends=0;
 world.rpc={
  urls:['fake'],
  async call(method,params){
   if(method==='query'&&params.request_type==='view_access_key')return {nonce:keyNonce++,block_hash:base58Encode(seed('block')),permission:'FullAccess'};
   if(method==='send_tx'){
    const bytes=Buffer.from(params.signed_tx_base64,'base64'),body=bytes.subarray(0,bytes.length-65);
    const hash=base58Encode(createHash('sha256').update(body).digest());
    if(world.dropSends>0){world.dropSends--;throw Error('socket hang up')}
    if(txs.has(hash))return {};
    // FunctionCall args are the JSON between the method name and gas (u64) + deposit (u128)
    const at=body.indexOf('{"signed":'),args=JSON.parse(body.subarray(at,body.length-24).toString('utf8'));
    let r;
    if(world.failSends>0){world.failSends--;r={ok:false,code:'FORCED_FAILURE'}}
    else r=await apply(args.signed,true);
    txs.set(hash,r);
    if(r.ok)world.executed.push({hash,signed:args.signed});
    return {};
   }
   if(method==='EXPERIMENTAL_tx_status'){
    const r=txs.get(params.tx_hash);
    if(!r)throw new NearRpcError('UNKNOWN_TRANSACTION',{name:'UNKNOWN_TRANSACTION'});
    return {final_execution_status:'FINAL',transaction_outcome:{outcome:{status:{SuccessReceiptId:'r'},gas_burnt:1}},
     receipts_outcome:[{id:'r',block_hash:'b',outcome:{executor_id:VERIFIER,gas_burnt:2,logs:r.ok?['EVENT_JSON:{"standard":"dip4","version":"0.3.0","event":"intents_executed","data":[]}']:[],
      status:r.ok?{SuccessValue:''}:{Failure:{ActionError:{kind:r.code}}}}}]};
   }
   throw Error(`fake NEAR RPC: ${method}`);
  },
 };
 return world;
}

/**
 * 1Click with the ledger on both sides. A firm quote names a deposit account inside the fake ledger; once that account
 * holds the quote's amount, the next status (or deposit notice) fills it: the amount leaves the deposit account and
 * `delivered` (default: the quoted amount) is credited to the recipient. `mode`: fill | refund | stall.
 * `deliver` maps a destination token id to the raw amount delivered for the next quote of it (the spike's real fills).
 */
export function fakeLedgerOneClick({world,rates=RATES,now}){
 const quotes=[];
 const c={authenticated:false,quotes,requests:[],mode:'fill',deliver:{},dryCalls:0,firmCalls:0,refuse:null,
  async getTokens(){return []},
  async quote(req){
   c.requests.push(req);
   if(c.refuse)throw Error(c.refuse);
   const amount=BigInt(req.amount),buy=req.originAsset===USDC,coinId=buy?req.destinationAsset:req.originAsset,rate=rates[coinId];
   if(!rate||(!buy&&req.destinationAsset!==USDC))throw Error('Quoting for this pair is not available');
   const out=buy?amount*rate/1_000_000n:amount*1_000_000n/rate,min=out*BigInt(10_000-req.slippageTolerance)/10_000n;
   const usd=v=>(Number(v)/1e6).toFixed(6),dec=id=>CATALOG.find(e=>e.assetId===id)?.decimals??6;
   const q={req,amountIn:amount,amountOut:out,minAmountOut:min,depositAddress:req.dry?null:randomBytes(32).toString('hex'),state:null,delivered:null};
   if(req.dry)c.dryCalls++;else{c.firmCalls++;quotes.push(q)}
   const quote={amountIn:amount.toString(),amountInFormatted:formatUnits(amount,dec(req.originAsset)),amountInUsd:usd(buy?amount:out),
    amountOut:out.toString(),amountOutFormatted:formatUnits(out,dec(req.destinationAsset)),amountOutUsd:usd((buy?amount:out)*995n/1000n),minAmountOut:min.toString(),timeEstimate:12,deadline:req.deadline};
   if(q.depositAddress)quote.depositAddress=q.depositAddress;
   return {correlationId:`corr-${quotes.length}-${c.dryCalls}`,timestamp:new Date(now()).toISOString(),signature:'ed25519:fake',quoteRequest:req,quote};
  },
  async status(depositAddress){
   const q=quotes.find(x=>x.depositAddress===depositAddress);
   if(!q)throw Error('unknown deposit address');
   const o=q.req.originAsset,d=q.req.destinationAsset;
   if(!q.state&&world.balance(depositAddress,o)>=q.amountIn){
    if(c.mode==='fill'){
     const delivered=c.deliver[d]!==undefined?BigInt(c.deliver[d]):q.amountOut;
     world.move(depositAddress,'market',o,q.amountIn);world.credit(q.req.recipient,d,delivered);
     q.state='SUCCESS';q.delivered=delivered;
    }else if(c.mode==='refund'){world.move(depositAddress,q.req.refundTo,o,q.amountIn);q.state='REFUNDED'}
   }
   const status=q.state??(world.balance(depositAddress,o)>=q.amountIn?'PROCESSING':'PENDING_DEPOSIT');
   return {status,correlationId:'corr-status',updatedAt:new Date(now()).toISOString(),
    swapDetails:{intentHashes:[],nearTxHashes:[],originChainTxHashes:[],destinationChainTxHashes:[],...(q.delivered!==null?{amountOut:q.delivered.toString()}:{})}};
  },
  submitDeposit(depositAddress){return c.status(depositAddress)},
 };
 return c;
}

export const LEDGER_ENV=Object.freeze({YEET_LIVE:'1',YEET_ROUTE:'ledger',YEET_SOLVER_KEY_FILE:'/nonexistent/never-read-in-tests',YEET_SOLVER_MAX_TRADE_USDC:'25',YEET_SOLVER_MAX_DAY_USDC:'60'});
/** The ledger account of a test wallet. */
export const accountOf=wallet=>ed25519AccountId(wallet.address);

/**
 * The real pipeline on the fake ledger. Alice and Bob have wallets; `userUsdc` is credited to Alice's ledger account,
 * `float` to the solver. The clock moves only when the route sleeps. `restart()` builds a new pipeline over the same
 * database, ledger and 1Click (a process restart: runs in memory are lost, state is kept).
 */
export function ledgerPipeline({env={},userUsdc=20_000_000n,float=30_000_000n,xp=0,chainHoldings=[],rates=RATES}={}){
 const now=fakeClock(),world=fakeLedger({now}),oneclick=fakeLedgerOneClick({world,now,rates}),near=solverKey(),db=openTradeDb(':memory:'),logs=[];
 world.credit(accountOf(aliceWallet),USDC,userUsdc);world.credit(near.accountId,USDC,float);
 const fullEnv={...LEDGER_ENV,YEET_SOLVER_ACCOUNT:near.accountId,...env};
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:BASE_WALLET},solana:{address:aliceWallet.address}},[BOB.accountId]:{base:{address:'0x27602fd697f91d31fe551b26a3b12b113789477e'},solana:{address:bobWallet.address}}});
 const chain=fakeBalances({usdc:'0',holdings:chainHoldings}),rpc=fakeSolanaRpc();
 const build=()=>createPipeline({db,env:fullEnv,client:oneclick,directory,balances:chain,now,trackerIntervalMs:0,landingWatchMs:0,log:l=>logs.push(JSON.parse(l)),xpOf:()=>xp,
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer:fakeFeePayer()},
  ledgerOverrides:{rpc:world.rpc,verifier:world.verifier,near,pollMs:0,unloadWaitMs:30_000,sleep:async ms=>{now.advance(Math.max(ms,500))}}});
 const t={p:build(),db,now,world,oneclick,near,logs,env:fullEnv,chain,restart(){t.p=build();return t.p}};
 return t;
}
/** What the card does with a near_intent request: its own check of the message, the wallet call, the `signed` value. */
export function approve(wallet,req){
 const [body]=privyRpcBodies(req);
 return signedFromWallets(req,[{data:{signature:Buffer.from(wallet.signMessage(Buffer.from(body.params.message,'base64'))).toString('base64')}}]);
}
/** propose -> execute for Alice: the proposal and the execute_trade answer. */
export async function buy(t,{usdc='3',coins=['WIF','BOME','TRUMP'],ctx=ALICE,id='r1'}={}){
 const prop=await t.p.propose(ctx,{request_id:id,amount_usdc:usdc,legs:coins.map(symbol=>({symbol,parts:1}))});
 const x=await t.p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
 return {prop,x};
}
export async function sell(t,{coins=['WIF'],percent=100,ctx=ALICE,id='s1'}={}){
 const prop=await t.p.skeet(ctx,{request_id:id,legs:coins.map(symbol=>({symbol,percent}))});
 const x=await t.p.execute(ctx,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
 return {prop,x};
}
/** The approval submitted and the run finished. */
export async function approveAndSettle(t,x,{wallet=aliceWallet,ctx=ALICE}={}){
 const req=x.sign_requests[0];
 const s=await t.p.submit(ctx,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed:approve(wallet,req)});
 await t.p.ledgerRoute.idle();
 return s;
}

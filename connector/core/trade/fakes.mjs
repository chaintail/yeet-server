// Test doubles for every external system the engine uses: 1Click (answers built from the router's recorded fixtures,
// vendor/yeet-win/router/test/fixtures), the signer adapter and the wallet balances. Nothing here touches a network.
import {readFileSync} from 'node:fs';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {openTradeDb} from './db.mjs';
import {createEngine} from './engine.mjs';
import {refuse} from './util.mjs';
import {base58Encode} from './router.mjs';
import {USDC_KEY} from './accounting.mjs';

const fixture=name=>JSON.parse(readFileSync(new URL(`../../vendor/yeet-win/router/test/fixtures/${name}`,import.meta.url),'utf8'));
// Well-formed addresses (the router tests' own: random bytes, not funded wallets).
export const SOL_WALLET='G4Xr9SPQWYmkXnTB7r4tienHXYU19TYfsff7wfScjNRt';
export const BASE_WALLET='0x17602fd697f91d31fe551b26a3b12b113789477e';
const hex=(s,n=64)=>createHash('sha256').update(s).digest('hex').slice(0,n);
/** The Privy policy ids the fake wallets carry, and the env that expects them (executor policy check). */
export const FAKE_POLICY_IDS=Object.freeze({base:'policy-base',solana:'policy-solana'});
export const FAKE_POLICY_ENV=Object.freeze({YEET_BASE_POLICY_ID:FAKE_POLICY_IDS.base,YEET_SOLANA_POLICY_ID:FAKE_POLICY_IDS.solana});

/**
 * Fake 1Click. quote() answers like the router test helper quoteReply: the recorded quote2-B response scaled to the
 * requested amount, times `ratio.dry` / `ratio.live`, minAmountOut 99% of amountOut. A live quote gets a fresh
 * deposit address. status() walks a per-deposit script of fixture names (default: processing, then success).
 */
export function fakeOneClick({dryRatio=1,liveRatio=1,cost=0,statuses=['status-processing.json','status-success.json'],tokens,depositFor,submitFailures=0,mutate}={}){
 const tpl=fixture('quote2-B-intents-res.json');
 const calls={quote:[],submit:[],status:[]};let n=0;
 const deposits=new Map();
 const scale=(v,r)=>BigInt(Math.floor(Number(v)*r));
 const client={
  authenticated:false,calls,deposits,
  set dryRatio(v){dryRatio=v},set liveRatio(v){liveRatio=v},set cost(v){cost=v},
  set depositFor(f){depositFor=f},set submitFailures(v){submitFailures=v},set mutate(f){mutate=f},
  async quote(req){
   calls.quote.push(req);
   const r=Number(req.amount)/Number(tpl.quote.amountIn),k=req.dry?dryRatio:liveRatio;
   const out=scale(tpl.quote.amountOut,r*k);
   const quote={...tpl.quote,amountIn:req.amount,amountInFormatted:String(Number(req.amount)/1e6),amountInUsd:(Number(tpl.quote.amountInUsd)*r).toFixed(12),
    minAmountIn:req.amount,amountOut:out.toString(),amountOutFormatted:String(Number(out)/1e6),amountOutUsd:(Number(tpl.quote.amountOutUsd)*r*k*(1-cost)).toFixed(12),
    minAmountOut:(out*99n/100n).toString()};
   if(!req.dry){
    n++;quote.depositAddress=depositFor?.(n,req)??(req.originAsset.includes('base-')?`0x${hex(`deposit-${n}`,40)}`:base58Encode(createHash('sha256').update(`deposit-${n}`).digest()));quote.deadline=req.deadline;
    deposits.set(quote.depositAddress,{step:0,amountIn:req.amount,amountOut:out.toString()});
   }
   const res={...tpl,quoteRequest:req,quote,correlationId:`cid-${n}-${req.destinationAsset.slice(-8)}`};
   return mutate?mutate(res,req)??res:res;
  },
  async submitDeposit(depositAddress,txHash){
   calls.submit.push({depositAddress,txHash});
   if(submitFailures>0){submitFailures--;throw Error('fake: deposit/submit unavailable')}
   return this.statusFor(depositAddress,'status-pending.json');
  },
  statusFor(depositAddress,name){
   const d=deposits.get(depositAddress),f=fixture(name);
   const res={...f,correlationId:`st-${depositAddress.slice(-6)}`,updatedAt:new Date().toISOString()};
   if(res.swapDetails)res.swapDetails={...res.swapDetails,amountIn:d.amountIn,...(res.status==='SUCCESS'?{amountOut:d.amountOut,amountOutFormatted:String(Number(d.amountOut)/1e6)}:{amountOut:undefined,amountOutFormatted:undefined}),
    originChainTxHashes:(res.swapDetails.originChainTxHashes??[]).map(()=>({hash:`0x${hex(depositAddress)}`})),
    destinationChainTxHashes:(res.swapDetails.destinationChainTxHashes??[]).map(()=>({hash:'5VfYmGBjvQKe3xgLtTQPkMeAZJcMBdkdhtQ1WtABpbQV3Q6yZ8NnHcRmw7pS4u9vKcXbNfLwDtYr2aE6hJ1gMxoP'}))};
   return res;
  },
  async status(depositAddress){
   calls.status.push(depositAddress);
   const d=deposits.get(depositAddress);if(!d)throw Error('unknown deposit');
   const script=d.script??statuses;
   const name=script[Math.min(d.step++,script.length-1)];
   return this.statusFor(depositAddress,name);
  },
  async getTokens(){return tokens??fixture('tokens.json')},
 };
 return client;
}

/**
 * Fake signer adapter: wallets for every account, recorded transfers, and failures per attempt index. It models the
 * provider's idempotency: a call with an idempotency key already broadcast answers the first transfer's hash and moves
 * nothing again (`replays` counts those).
 *   failLegs  refused before anything is broadcast (error carries notSent: true, like a policy denial)
 *   lostLegs  broadcast (recorded in `sent`), then the answer is lost (timeout, missing hash)
 *   hangLegs  the call never returns (a process that dies mid-send)
 */
export function fakeSigner({signerState='granted',failLegs=[],failCode='TEMPORARILY_UNAVAILABLE',lostLegs=[],hangLegs=[],onSend,policyIds=FAKE_POLICY_IDS}={}){
 const sent=[],byKey=new Map();let leg=0;
 const wallet=chain=>({address:chain==='base'?BASE_WALLET:SOL_WALLET,walletId:`wallet-${chain}`,signerState,policyId:policyIds[chain]??null});
 const s={
  kind:'fake',sent,replays:0,hashes:byKey,
  directory:{stable:false,lookup:async()=>({base:wallet('base'),solana:wallet('solana')})},
  set signerState(v){signerState=v},
  set policyIds(v){policyIds=v},
  transferUsdcBase:args=>transfer('base',args,`0x${hex(`${args.to}:${args.amountRaw}:${args.idempotencyKey}`)}`),
  transferSpl:args=>transfer('solana',args,base58Encode(createHash('sha256').update(`spl:${args.idempotencyKey}`).digest())),
 };
 async function transfer(chain,args,txHash){
  if(byKey.has(args.idempotencyKey)){s.replays++;return {txHash:byKey.get(args.idempotencyKey)}}
  const i=leg++;onSend?.(i,args);
  if(hangLegs.includes(i))return new Promise(()=>{});
  if(failLegs.includes(i)){try{refuse(failCode,'fake refusal')}catch(e){e.notSent=true;throw e}}
  sent.push({chain,...args});byKey.set(args.idempotencyKey,txHash);
  if(lostLegs.includes(i))refuse('TEMPORARILY_UNAVAILABLE','fake: broadcast, answer lost');
  return {txHash};
 }
 return s;
}

/** Fake balances: USDC on Base and SPL holdings on Solana. */
export function fakeBalances({usdc='100',holdings=[]}={}){
 const b={usdcRaw:BigInt(Math.round(Number(usdc)*1e6)),holdings,
  async baseUsdc(){return b.usdcRaw},async baseEth(){return 10n**16n},
  async solanaTokens(){return b.holdings},blockhashes:0,
  // A new blockhash on every call, like the chain: a rebuilt Solana transfer never has the same bytes.
  async recentBlockhash(){return base58Encode(createHash('sha256').update(`blockhash-${b.blockhashes++}`).digest())}};
 return b;
}

/** A P-256 authorization key and the Privy env for the delegated adapter against fakePrivy (generated per run). */
export function fakePrivyEnv(extra={}){
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 return {PRIVY_APP_ID:'fake-app',PRIVY_APP_SECRET:'fake-app-secret',YEET_PRIVY_AUTHORIZATION_KEY:`wallet-auth:${privateKey.export({format:'der',type:'pkcs8'}).toString('base64')}`,
  YEET_PRIVY_KEY_QUORUM_ID:'quorum-yeet',YEET_SOL_FEE_PAYER_ID:'fee-payer',...FAKE_POLICY_ENV,...extra};
}

/**
 * Fake Privy REST API (a `fetch`), for the real delegated adapter (signer-privy.mjs, privy-api.mjs). It models what
 * docs.privy.io documents and PRIVY-SETUP-REVIEW found:
 *   - POST /v1/wallets/{id}/rpc with privy-idempotency-key: the first request under a key is processed and its answer
 *     stored; the same key with the same body bytes replays that answer (2xx, 4xx and 5xx alike: /rpc caches a 5xx
 *     for 24 h); the same key with another body answers 400 "Invalid use of idempotency key".
 *   - a sponsored EVM eth_sendTransaction answers data.hash '' with transaction_id and user_operation_hash; the chain
 *     hash appears on GET /v1/transactions/{id} after `confirmAfter` reads (status broadcasted -> confirmed)
 *   - Solana signAndSendTransaction answers the signature in data.hash at once
 *   - GET /v1/transactions?reference_id= lists the transactions created with that reference_id
 *   - GET /v1/users/{did} and GET /v1/wallets/{id}: the person's embedded wallets, the YEET quorum attached with
 *     `policyIds[chain]` (an array value attaches several)
 * `rpcFailures`: [{at: rpc request index (new keys only), status: 500|503|'timeout', accepted: bool}]; accepted means
 * Privy created and broadcast the transaction before the failure.
 */
export function fakePrivy({confirmAfter=1,rpcFailures=[],policyIds=FAKE_POLICY_IDS,quorum='quorum-yeet',did='did:privy:alice'}={}){
 const keys=new Map(),txs=new Map(),calls=[];let rpcN=0,txN=0;
 const p={calls,txs,keys,replays:0,conflicts:0,broadcasts:[],
  set policyIds(v){policyIds=v},set confirmAfter(v){confirmAfter=v},set rpcFailures(v){rpcFailures=v},
  /** The rpc requests that reached the fake (key, raw body, answer status). */
  get rpc(){return calls.filter(c=>c.path.endsWith('/rpc'))}};
 const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const view=t=>({id:t.id,wallet_id:t.wallet_id,caip2:t.caip2,status:t.status,transaction_hash:t.transaction_hash,created_at:t.created_at,reference_id:t.reference_id,sponsored:t.sponsored});
 function create(walletId,body){
  const id=`tx-${++txN}`,evm=String(body.caip2).startsWith('eip155:');
  const hash=evm?`0x${hex(`chain-${id}`)}`:base58Encode(createHash('sha256').update(`sig-${id}`).digest())+base58Encode(createHash('sha256').update(`sig2-${id}`).digest());
  const pending=evm&&body.sponsor===true;
  const t={id,wallet_id:walletId,caip2:body.caip2,status:pending?'broadcasted':'confirmed',transaction_hash:pending?null:hash,chainHash:hash,reads:0,
   created_at:Date.now(),reference_id:body.reference_id??null,sponsored:!!body.sponsor,body};
  txs.set(id,t);p.broadcasts.push(t);
  const data=pending?{hash:'',transaction_id:id,user_operation_hash:`0x${hex(`userop-${id}`)}`,caip2:body.caip2,reference_id:t.reference_id}
   :{hash,transaction_id:id,caip2:body.caip2,reference_id:t.reference_id};
  return {method:body.method,data};
 }
 p.fetch=async(url,init={})=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method??'GET',headers=init.headers??{};
  const call={path,method,query:Object.fromEntries(u.searchParams),key:headers['privy-idempotency-key'],raw:init.body,status:null};calls.push(call);
  const answer=(status,body)=>{call.status=status;return reply(status,body)};
  let m;
  if(method==='POST'&&(m=path.match(/^\/v1\/wallets\/([^/]+)\/rpc$/))){
   const key=call.key,stored=key?keys.get(key):undefined;
   if(stored){
    if(stored.raw!==init.body){p.conflicts++;return answer(400,{error:'Invalid use of idempotency key: the request body differs from the original request'})}
    p.replays++;
    return answer(stored.status,stored.body);
   }
   const i=rpcN++,fail=rpcFailures.find(f=>f.at===i),body=JSON.parse(init.body);
   if(fail?.status==='timeout'){
    // The answer is lost on the way back; Privy kept the request (and its answer) only when it accepted it.
    if(fail.accepted){const res={status:200,body:create(m[1],body)};if(key)keys.set(key,{raw:init.body,...res})}
    call.status='timeout';throw new TypeError('fetch failed');
   }
   if(fail){
    if(fail.accepted)create(m[1],body);
    const res={status:fail.status,body:{error:'Internal server error'}};
    if(key)keys.set(key,{raw:init.body,...res});
    return answer(res.status,res.body);
   }
   const res={status:200,body:create(m[1],body)};
   if(key)keys.set(key,{raw:init.body,...res});
   return answer(200,res.body);
  }
  if(method==='GET'&&(m=path.match(/^\/v1\/transactions\/([^/]+)$/))){
   const t=txs.get(m[1]);if(!t)return answer(404,{error:'Transaction not found'});
   t.reads++;
   if(t.status==='broadcasted'&&t.reads>=confirmAfter){t.status='confirmed';t.transaction_hash=t.chainHash}
   return answer(200,view(t));
  }
  if(method==='GET'&&path==='/v1/transactions')return answer(200,{transactions:[...txs.values()].filter(t=>t.reference_id===u.searchParams.get('reference_id')).map(view)});
  if(method==='GET'&&path===`/v1/users/${did}`)return answer(200,{id:did,linked_accounts:[
   {type:'wallet',wallet_client_type:'privy',chain_type:'ethereum',address:BASE_WALLET,id:'wallet-base'},
   {type:'wallet',wallet_client_type:'privy',chain_type:'solana',address:SOL_WALLET,id:'wallet-solana'}]});
  if(method==='GET'&&(m=path.match(/^\/v1\/wallets\/(wallet-base|wallet-solana)$/))){
   const ids=policyIds[m[1]==='wallet-base'?'base':'solana'];
   return answer(200,{id:m[1],additional_signers:[{signer_id:quorum,override_policy_ids:ids==null?[]:[].concat(ids)}]});
  }
  return answer(404,{error:'not found'});
 };
 return p;
}

/**
 * Fake Privy users and wallet creation (a `fetch`), for wallet-ensure.mjs. Models docs.privy.io api-reference/wallets/
 * create: POST /v1/wallets {chain_type, owner:{user_id}, additional_signers} answers the Wallet and links it to the
 * user as an embedded wallet; a key seen before replays its answer (2xx and 4xx/5xx alike). GET /v1/users/{did} and
 * GET /v1/wallets/{id}. `users`: {did: [linked account]}; `createFailures`: [{at: create index, status}].
 */
export function fakePrivyWallets({users={},createFailures=[],existingSigners={}}={}){
 const keys=new Map(),wallets=new Map(),calls=[];let n=0,creates=0;
 for(const [did,list] of Object.entries(users))for(const a of list)wallets.set(a.id,{id:a.id,address:a.address,chain_type:a.chain_type,owner_id:did,additional_signers:existingSigners[a.id]??[]});
 const p={calls,wallets,users,get creates(){return calls.filter(c=>c.method==='POST'&&c.path==='/v1/wallets')}};
 const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 p.fetch=async(url,init={})=>{
  const u=new URL(String(url)),path=u.pathname,method=init.method??'GET',headers=init.headers??{};
  const call={path,method,key:headers['privy-idempotency-key'],body:init.body?JSON.parse(init.body):undefined,signed:'privy-authorization-signature' in headers};calls.push(call);
  let m;
  if(method==='GET'&&(m=path.match(/^\/v1\/users\/(did:privy:[^/]+)$/))){
   if(!users[m[1]])return reply(404,{error:'User not found'});
   return reply(200,{id:m[1],linked_accounts:users[m[1]]});
  }
  if(method==='GET'&&(m=path.match(/^\/v1\/wallets\/([^/]+)$/))){const w=wallets.get(m[1]);return w?reply(200,w):reply(404,{error:'Wallet not found'})}
  if(method==='POST'&&path==='/v1/wallets'){
   if(call.key&&keys.has(call.key)){const s=keys.get(call.key);return reply(s.status,s.body)}
   const i=creates++,fail=createFailures.find(f=>f.at===i);
   if(fail){const s={status:fail.status,body:{error:'Internal server error'}};if(call.key)keys.set(call.key,s);return reply(s.status,s.body)}
   const did=call.body?.owner?.user_id;
   if(!users[did])return reply(400,{error:'Invalid owner'});
   const id=`wallet-${++n}`,address=call.body.chain_type==='ethereum'?`0x${hex(id).slice(0,40)}`:base58Encode(createHash('sha256').update(id).digest());
   const w={id,address,chain_type:call.body.chain_type,owner_id:did,policy_ids:[],additional_signers:(call.body.additional_signers??[]).map(s=>({signer_id:s.signer_id,override_policy_ids:s.override_policy_ids??[]})),created_at:Date.now()};
   wallets.set(id,w);
   users[did].push({type:'wallet',wallet_client_type:'privy',chain_type:w.chain_type,address,id,delegated:false,imported:false});
   const s={status:200,body:w};if(call.key)keys.set(call.key,s);
   return reply(200,w);
  }
  return reply(404,{error:'not found'});
 };
 return p;
}

/**
 * Fake chain reader for the balance check (accounting.mjs): the fake balances minus what the fake signer broadcast,
 * so before/after reads move like the chain would. `adjust[asset]` adds to a balance (negative: an unexplained
 * debit), `failReads` makes the next n reads throw.
 */
export function fakeChain({balances,signer,adjust={},failReads=0}={}){
 const c={adjust,reads:0,set failReads(v){failReads=v},
  async source({chain,address,assets}){
   c.reads++;
   if(failReads>0){failReads--;throw Error('fake: rpc unavailable')}
   const sentOn=(ch,pred)=>(signer?.sent??[]).filter(x=>x.chain===ch&&pred(x)).reduce((a,x)=>a+BigInt(x.amountRaw),0n);
   if(chain==='base')return {[USDC_KEY]:balances.usdcRaw-sentOn('base',()=>true)+BigInt(c.adjust[USDC_KEY]??0)};
   return Object.fromEntries(assets.map(a=>[a,balances.holdings.filter(h=>h.mint===a).reduce((s,h)=>s+h.raw,0n)-sentOn('solana',x=>x.mint===a)+BigInt(c.adjust[a]??0)]));
  }};
 return c;
}

/** A clock tests can move. */
export function fakeClock(start=Date.parse('2026-11-12T12:00:00.000Z')){let t=start;const now=()=>t;now.advance=ms=>{t+=ms};now.set=ms=>{t=ms};return now}

/** An engine over an in-memory database with fakes for every external system. */
export async function fakeEngine({env={YEET_LIVE:'1'},oneclick,signer,balances,chain,now=fakeClock(),onSettled,budgetMs,hooks,db=openTradeDb(':memory:')}={}){
 env={...FAKE_POLICY_ENV,...env};
 oneclick??=fakeOneClick();signer??=fakeSigner();balances??=fakeBalances();chain??=fakeChain({balances,signer});
 const engine=await createEngine({db,env,client:oneclick,signer,balances,chain,now,onSettled,trackerIntervalMs:0,budgetMs,hooks});
 return {engine,db,oneclick,signer,balances,chain,now};
}

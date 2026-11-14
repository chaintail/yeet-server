// Funding on the ledger route (docs/LEDGER-ROUTE.md section 1.5): the person's permanent deposit addresses and the
// watch that follows a deposit into their ledger account.
//
// THE ADDRESSES. One set per account, made once by 1Click ("reusable deposit addresses": an ANY_INPUT quote from
// `1cs_v1:any` to `1cs_v1:original`, deadline 2038-01-01). Whatever is sent to one of its addresses is credited, as
// the coin it is, to the quote's recipient inside intents.near. The recipient and the refund account are ALWAYS the
// account's own ledger account (ledgerAccountOf of its Solana wallet address); nothing else is ever asked for, and a
// stored set is shown only when it was made for exactly that account (checked on every read).
//   - The set is stored here (table ledger_deposit_address, one row per account, the ledger account unique).
//   - Never made twice: one flight per account in this process; before any create the partner's own sets are listed
//     (GET /v0/quotes) and a set that already names this account is taken over instead; a create that answers
//     HTTP 400 (two creates overlapped) is followed by one more listing and never by a second create.
//   - Any failure leaves the row `failed`; the next try comes no sooner than RETRY_MS later and lists first.
//   - The partner key (env ONECLICK_JWT, header X-API-Key) is never logged, stored or put into an error.
//
// THE WATCH. yeet_fund is called by the model once and then by the Add funds card every 10 s. Each call compares the
// ledger account with the snapshot taken when the watch began (table ledger_deposit_watch):
//   ready       the account's USDC rose: the one proven signal, read from intents.near itself
//   other_coin  another token rose and USDC did not (the address accepts any coin; this route trades from USDC)
//   found / preparing   only from 1Click's own status of the set (GET /v0/status of the set's internal account: a new
//               deposit transaction or amount; PROCESSING, a new NEAR transaction or SUCCESS). They are never
//               inferred: when 1Click reports nothing the stage goes from waiting to ready.
// A trade of the account moves the same balances, so any trade activity since the last look re-bases the snapshot.
import {createHash} from 'node:crypto';
import {USDC_SOL_TOKEN_ID} from '../intents/constants.mjs';
import {formatUnits} from '../trade/router.mjs';

export const ONECLICK_URL='https://1click.chaindefuser.com';
export const SET_DEADLINE='2038-01-01T00:00:00.000Z';
export const ANY_ASSET='1cs_v1:any',SAME_ASSET='1cs_v1:original';
export const RETRY_MS=10*60_000,READY_HOLD_MS=2*60_000,WATCH_MAX_MS=24*60*60_000,LOOK_TTL_MS=4_000,STATUS_TTL_MS=8_000;
export const STEPS_STATUS=Object.freeze(['waiting','found','preparing','ready']),STEPS_BALANCE=Object.freeze(['waiting','ready']);
/** Card network name -> [1Click blockchain name, the address shape]. Solana first: the route trades from USDC sent there. */
const NETWORKS=Object.freeze({solana:['sol',/^[1-9A-HJ-NP-Za-km-z]{32,44}$/],base:['base',/^0x[0-9a-fA-F]{40}$/]});
const ACCOUNT=/^[0-9a-f]{64}$/;

const SCHEMA=`
CREATE TABLE IF NOT EXISTS ledger_deposit_address(
  account_id TEXT PRIMARY KEY,
  ledger_account TEXT NOT NULL UNIQUE,       -- the account the set was asked for: ledgerAccountOf(the Solana wallet)
  state TEXT NOT NULL CHECK(state IN('creating','ready','failed')),
  recipient TEXT,                            -- what 1Click states as recipient; shown only when equal to ledger_account
  refund_to TEXT,
  addresses TEXT,                            -- JSON: quote.chainDepositAddresses as answered
  internal_address TEXT,                     -- quote.depositAddress: 1Click's own account, never shown
  correlation_id TEXT,
  source TEXT,                               -- created | adopted (found in the partner's list)
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS ledger_deposit_watch(
  account_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  base TEXT NOT NULL,                        -- JSON {token id: raw} at the start (lowered when a balance falls)
  status_base TEXT,                          -- JSON: 1Click's status of the set at the start, or null
  stage TEXT NOT NULL,
  coin TEXT,
  arrived_raw TEXT,
  done_at INTEGER) STRICT;`;

/** The one request a set is made with. `account` is the person's own ledger account, on both sides. */
export const setRequest=account=>({dry:false,swapType:'ANY_INPUT',originAsset:ANY_ASSET,depositType:'INTENTS',destinationAsset:SAME_ASSET,amount:'0',slippageTolerance:50,
 recipient:account,recipientType:'INTENTS',refundTo:account,refundType:'INTENTS',deadline:SET_DEADLINE});

/** The networks of a stored set the card may show, in `allowed` order: an entry with a memo, or whose address is not
 * of its network's shape, is never offered. Returns the card block {default, networks} or null. */
export function networksOf(addresses,allowed=['solana']){
 const list=Array.isArray(addresses)?addresses:[],networks=[];
 for(const n of allowed){
  const d=Object.hasOwn(NETWORKS,n)?NETWORKS[n]:null;if(!d||networks.some(x=>x.network===n))continue;
  const hits=list.filter(e=>e&&typeof e==='object'&&e.blockchain===d[0]);
  // exactly one entry for the network, with no memo of any kind
  if(hits.length!==1)continue;
  const e=hits[0];
  if((e.memo!==undefined&&e.memo!==null&&e.memo!=='')||typeof e.address!=='string'||!d[1].test(e.address))continue;
  networks.push({network:n,address:e.address});
 }
 return networks.length?{default:networks[0].network,networks}:null;
}
/** YEET_LEDGER_DEPOSIT_NETWORKS: the networks offered, in order. Default `solana` alone: USDC sent on another network
 * is credited as that network's USDC, which this route cannot trade. */
export function depositNetworksFromEnv(env){
 const v=env.YEET_LEDGER_DEPOSIT_NETWORKS?.trim().toLowerCase();
 if(!v)return ['solana'];
 const list=v.split(',').map(s=>s.trim()).filter(Boolean);
 if(!list.length||list.some(n=>!Object.hasOwn(NETWORKS,n))||new Set(list).size!==list.length)throw Error('Invalid YEET_LEDGER_DEPOSIT_NETWORKS (solana, or solana,base)');
 return list;
}
/** YEET_LEDGER_DEPOSIT_STAGES: `status` (default: 1Click's status of the set may show the two middle stages) or
 * `balance` (the ledger balance alone: waiting, ready). */
export function depositStagesFromEnv(env){
 const v=env.YEET_LEDGER_DEPOSIT_STAGES?.trim().toLowerCase()||'status';
 if(v!=='status'&&v!=='balance')throw Error('Invalid YEET_LEDGER_DEPOSIT_STAGES (status or balance)');
 return v;
}

const short=(v,n=160)=>String(v??'').replace(/\s+/g,' ').slice(0,n);
/** 1Click over plain fetch with the partner key. Every call answers {status, json, message}; a call that got no
 * answer has status 0. The key rides in one header and nowhere else. */
function oneClick({key,fetch,baseUrl,timeoutMs}){
 return async(method,path,body)=>{
  let res;
  try{res=await fetch(baseUrl+path,{method,headers:{accept:'application/json','x-api-key':key,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeoutMs)})}
  catch(e){return {status:0,json:null,message:e?.name==='TimeoutError'||e?.name==='AbortError'?'no answer in time':'not reachable'}}
  let json=null;
  try{const text=await res.text();json=text.length?JSON.parse(text):null}catch{json=null}
  const m=json?.message??json?.errors?.[0]?.detail??'';
  return {status:res.status,json,message:short([m].flat().join('; '))};
 };
}
/** A listed or created set, in one shape, when it is a reusable set for exactly `account`; else null. */
function setFor(account,{recipient,refundTo,originAsset,destinationAsset,chainDepositAddresses,depositAddress,correlationId,createdAt}){
 if(recipient!==account||refundTo!==account||originAsset!==ANY_ASSET||destinationAsset!==SAME_ASSET)return null;
 if(!Array.isArray(chainDepositAddresses)||!chainDepositAddresses.length||chainDepositAddresses.length>200||typeof depositAddress!=='string'||!depositAddress||depositAddress.length>128)return null;
 return {recipient,refundTo,addresses:chainDepositAddresses,internal:depositAddress,correlationId:typeof correlationId==='string'?correlationId.slice(0,80):null,createdAt:createdAt??null};
}
/** The request 1Click states for a set: it must be the one we make, for `account`, on both sides, inside the ledger. */
const requestIsOurs=(account,r)=>!!r&&r.swapType==='ANY_INPUT'&&r.originAsset===ANY_ASSET&&r.destinationAsset===SAME_ASSET&&r.recipient===account&&r.refundTo===account
 &&r.recipientType==='INTENTS'&&r.refundType==='INTENTS'&&r.depositType==='INTENTS'&&r.deadline===SET_DEADLINE&&(!Array.isArray(r.appFees)||!r.appFees.length);

/** What 1Click says about a set right now, reduced to what the watch compares. */
function statusView(j){
 const d=j?.swapDetails??{},n=v=>Array.isArray(v)?v.length:0;
 return {status:typeof j?.status==='string'?j.status:null,updatedAt:typeof j?.updatedAt==='string'?j.updatedAt:null,deposited:d.depositedAmount??null,amountIn:d.amountIn??null,
  origins:n(d.originChainTxHashes),near:n(d.nearTxHashes),dests:n(d.destinationChainTxHashes)};
}
/** The stage 1Click's status shows against the status at the start of the watch: preparing, found, or null. */
export function stageFromStatus(base,cur){
 if(!base||!cur)return null;
 const moved=cur.status!==base.status||cur.updatedAt!==base.updatedAt;
 if(cur.near>base.near||cur.dests>base.dests||(moved&&(cur.status==='PROCESSING'||cur.status==='SUCCESS')))return 'preparing';
 if(cur.origins>base.origins||(cur.deposited!==base.deposited&&cur.deposited!==null)||(cur.amountIn!==base.amountIn&&cur.amountIn!==null)||(moved&&(cur.status==='KNOWN_DEPOSIT_TX'||cur.status==='INCOMPLETE_DEPOSIT')))return 'found';
 return null;
}

/**
 * `key` = the 1Click partner key (undefined: nothing can be made, and funding answers "not available").
 * `verifier` = core/intents/verifier.mjs (holdings or balances), `accountOf(solanaAddress)` = the ledger account.
 * `symbolOf(tokenId)` names a token for the "other coin" line (null: not named).
 */
export function createDeposits({db,key,verifier,accountOf,catalog=[],networks=['solana'],stages='status',fetch=globalThis.fetch,now=Date.now,log=()=>{},baseUrl=ONECLICK_URL,timeoutMs=15_000,retryMs=RETRY_MS}){
 db.exec(SCHEMA);
 const call=key?oneClick({key,fetch,baseUrl,timeoutMs}):null;
 const flights=new Map(),looks=new Map(),statuses=new Map();
 const rowOf=accountId=>db.prepare('SELECT * FROM ledger_deposit_address WHERE account_id=?').get(accountId)??null;
 const fail=(accountId,why)=>{db.prepare("UPDATE ledger_deposit_address SET state='failed',last_error=?,updated_at=? WHERE account_id=? AND state<>'ready'").run(short(why,200),now(),accountId);log({event:'ledger_deposit_set_failed',account:accountId,why:short(why,120)});return null};
 const coins=catalog.filter(e=>e.chain==='solana'&&typeof e.assetId==='string');

 /** Every reusable set this partner key has made, all pages. null: the list could not be read. */
 async function listSets(account){
  const found=[];let path='/v0/quotes?filter[swapType]=ANY_INPUT&page[size]=500';
  for(let page=0;page<40&&path;page++){
   const r=await call('GET',path);
   if(r.status!==200||!Array.isArray(r.json?.data))return null;
   for(const item of r.json.data){const s=setFor(account,item?.attributes??{});if(s)found.push(s)}
   const next=r.json.links?.next;
   path=typeof next==='string'&&next.startsWith('/v0/quotes?')?next:null;
   if(page===39&&path)return null;
  }
  // more than one set for the account (it should not happen): the oldest, always the same one
  return found.sort((a,b)=>String(a.createdAt??'').localeCompare(String(b.createdAt??'')));
 }
 /** A set found in the list is taken over only when 1Click's own record of its request is ours for this account. */
 async function adopt(accountId,account,set){
  const r=await call('GET',`/v0/status?${new URLSearchParams({depositAddress:set.internal})}`);
  if(r.status!==200)return fail(accountId,`status of the listed set: HTTP ${r.status} ${r.message}`);
  if(!requestIsOurs(account,r.json?.quoteResponse?.quoteRequest)||r.json?.quoteResponse?.quote?.depositAddress!==set.internal)return fail(accountId,'the listed set was not made with our request for this account');
  return store(accountId,account,{...set,correlationId:set.correlationId??r.json?.correlationId??null},'adopted');
 }
 function store(accountId,account,set,source){
  if(set.recipient!==account||set.refundTo!==account||!networksOf(set.addresses,networks))return fail(accountId,'the set has no address this route can show, or names another account');
  db.prepare("UPDATE ledger_deposit_address SET state='ready',recipient=?,refund_to=?,addresses=?,internal_address=?,correlation_id=?,source=?,last_error=NULL,updated_at=? WHERE account_id=? AND ledger_account=?")
   .run(set.recipient,set.refundTo,JSON.stringify(set.addresses),set.internal,set.correlationId,source,now(),accountId,account);
  log({event:'ledger_deposit_set',account:accountId,source,chains:set.addresses.length,correlation:set.correlationId});
  return rowOf(accountId);
 }
 async function make(accountId,account){
  const at=now(),row=rowOf(accountId);
  if(row?.state==='ready')return row;
  // a try that failed, or one a stopped process left open: not again before retryMs
  if(row&&at-row.updated_at<retryMs&&at>=row.updated_at)return null;
  try{
   db.prepare(`INSERT INTO ledger_deposit_address(account_id,ledger_account,state,created_at,updated_at) VALUES(?,?,'creating',?,?)
     ON CONFLICT(account_id) DO UPDATE SET state='creating',updated_at=excluded.updated_at WHERE state<>'ready' AND ledger_account=excluded.ledger_account`).run(accountId,account,at,at);
  }catch(e){log({event:'ledger_deposit_set_refused',account:accountId,why:'the ledger account belongs to another YEET account'});return null}
  if(rowOf(accountId)?.state!=='creating')return null;
  const listed=await listSets(account);
  if(listed===null)return fail(accountId,'the list of sets could not be read');
  if(listed.length)return adopt(accountId,account,listed[0]);
  const r=await call('POST','/v0/quote',setRequest(account));
  if(r.status===200||r.status===201){
   const q=r.json?.quote??{},req=r.json?.quoteRequest;
   // 1Click repeats the request it took: it must be ours. When it repeats none, the set is still read from the list.
   if(req!==undefined&&!requestIsOurs(account,req))return fail(accountId,'the answer names another request than ours');
   const set=setFor(account,{recipient:account,refundTo:account,originAsset:ANY_ASSET,destinationAsset:SAME_ASSET,chainDepositAddresses:q.chainDepositAddresses,depositAddress:q.depositAddress,correlationId:r.json?.correlationId});
   if(!set)return fail(accountId,'the answer carries no address set');
   if(req===undefined)return adopt(accountId,account,set);
   return store(accountId,account,set,'created');
  }
  if(r.status===400){
   // two creates overlapped (ours and one we do not know of): the set that exists is the one to use; never a second create
   const again=await listSets(account);
   if(again?.length)return adopt(accountId,account,again[0]);
   return fail(accountId,`create: HTTP 400 ${r.message}`);
  }
  return fail(accountId,r.status?`create: HTTP ${r.status} ${r.message}`:`create: ${r.message} (outcome unknown)`);
 }
 /** The account's stored set when it is ready AND was made for exactly `account`; else null. */
 function trusted(accountId,account){
  const row=rowOf(accountId);
  if(!row)return null;
  if(row.ledger_account!==account||(row.state==='ready'&&(row.recipient!==account||row.refund_to!==account))){
   log({event:'ledger_deposit_set_mismatch',account:accountId});
   return {mismatch:true};
  }
  return row.state==='ready'?row:null;
 }
 /** The set of `accountId` whose Solana wallet is `solanaAddress`: made once on first use. Returns
  * {account, deposit:{default,networks}, row} or {account, deposit:null, why}. Never throws. */
 async function ensure(accountId,solanaAddress){
  let account;
  try{account=accountOf(solanaAddress)}catch{return {account:null,deposit:null,why:'no ledger account'}}
  if(!ACCOUNT.test(account??''))return {account:null,deposit:null,why:'no ledger account'};
  let row=trusted(accountId,account);
  if(row?.mismatch)return {account,deposit:null,why:'the stored set is not this account\'s'};
  if(!row){
   if(!call)return {account,deposit:null,why:'no partner key'};
   if(!flights.has(accountId))flights.set(accountId,make(accountId,account).catch(e=>fail(accountId,`unexpected: ${short(e?.message,80)}`)).finally(()=>flights.delete(accountId)));
   await flights.get(accountId);
   row=trusted(accountId,account);
   if(!row||row.mismatch)return {account,deposit:null,why:rowOf(accountId)?.last_error??'not made yet'};
  }
  let addresses;
  try{addresses=JSON.parse(row.addresses)}catch{addresses=null}
  const deposit=networksOf(addresses,networks);
  return deposit?{account,deposit,row}:{account,deposit:null,why:'no address this route can show'};
 }

 // ---- the watch ----
 const hasActivity=db.prepare("SELECT 1 FROM trades WHERE account_id=? AND (status IN('signing','submitted','settling') OR updated_at>=?) LIMIT 1");
 /** {token id: raw string} of everything the account holds, USDC always present. */
 async function snapshot(account){
  const out={[USDC_SOL_TOKEN_ID]:'0'};
  if(typeof verifier.holdings==='function'){for(const h of await verifier.holdings(account))out[h.tokenId]=h.amount.toString();return out}
  // a verifier without enumeration (tests): USDC and the catalogue coins
  const ids=[...new Set([USDC_SOL_TOKEN_ID,...coins.map(c=>c.assetId)])],bal=await verifier.balances(account,ids);
  ids.forEach((id,i)=>{if(bal[i]>0n||id===USDC_SOL_TOKEN_ID)out[id]=bal[i].toString()});
  return out;
 }
 async function readStatus(row){
  const r=await call('GET',`/v0/status?${new URLSearchParams({depositAddress:row.internal_address})}`);
  return r.status===200?statusView(r.json):null;
 }
 async function setStatus(row){
  if(stages!=='status'||!call||!row?.internal_address)return null;
  const hit=statuses.get(row.account_id);
  if(hit&&now()-hit.at<STATUS_TTL_MS&&now()>=hit.at)return hit.value;
  const value=await readStatus(row);
  statuses.set(row.account_id,{at:now(),value});if(statuses.size>500)statuses.delete(statuses.keys().next().value);
  return value;
 }
 const symbolOf=id=>{const c=coins.find(e=>e.assetId===id);if(c&&/^[A-Za-z0-9$.]{1,16}$/.test(c.symbol))return c.symbol;
  // an omni token id names its chain: nep141:sol.omft.near is the chain's own coin
  const m=/^nep141:([a-z]{2,8})\.omft\.near$/.exec(id);return m?m[1].toUpperCase():null};
 const big=v=>{try{return BigInt(v??'0')}catch{return 0n}};
 const steps=()=>stages==='status'&&call?[...STEPS_STATUS]:[...STEPS_BALANCE];
 const answer=(w,cur)=>({steps:steps(),stage:w.stage,...(w.stage==='ready'&&w.arrived_raw?{arrived_usdc:formatUnits(big(w.arrived_raw),6)}:{}),...(w.stage==='other_coin'&&w.coin?{coin:w.coin}:{}),usdc_raw:big(cur[USDC_SOL_TOKEN_ID])});
 /** One look at the account for the Add funds card: {steps, stage, arrived_usdc?, coin?, usdc_raw}. Throws when the
  * ledger cannot be read (the caller then answers without a watch). */
 async function watch(accountId,account,row){
  const at=now(),seen=looks.get(accountId);
  if(seen&&at-seen.at<LOOK_TTL_MS&&at>=seen.at)return seen.value;
  const [cur,status]=await Promise.all([snapshot(account),setStatus(row).catch(()=>null)]);
  let w=db.prepare('SELECT * FROM ledger_deposit_watch WHERE account_id=?').get(accountId)??null;
  const fresh=!w||(w.done_at!==null&&at-w.done_at>READY_HOLD_MS)||(w.done_at===null&&at-w.started_at>WATCH_MAX_MS)||at<w.started_at;
  if(fresh){
   w={account_id:accountId,started_at:at,checked_at:at,base:JSON.stringify(cur),status_base:status?JSON.stringify(status):null,stage:'waiting',coin:null,arrived_raw:null,done_at:null};
  }else if(w.done_at===null){
   let base;try{base=JSON.parse(w.base)}catch{base={}}
   let statusBase;try{statusBase=w.status_base?JSON.parse(w.status_base):null}catch{statusBase=null}
   // A trade of this account moved the same balances: what it changed is not a deposit.
   if(hasActivity.get(accountId,w.checked_at)){base={...cur};if(status)statusBase=status}
   else{
    const up=big(cur[USDC_SOL_TOKEN_ID])-big(base[USDC_SOL_TOKEN_ID]);
    if(up>0n){w.stage='ready';w.arrived_raw=up.toString();w.coin=null;w.done_at=at;log({event:'ledger_deposit_arrived',account:accountId,usdc_raw:up.toString()})}
    else{
     const other=Object.keys(cur).find(id=>id!==USDC_SOL_TOKEN_ID&&big(cur[id])>big(base[id]));
     if(other){if(w.stage!=='other_coin')log({event:'ledger_deposit_other_coin',account:accountId,token:short(other,80)});w.stage='other_coin';w.coin=symbolOf(other)}
     else if(w.stage!=='other_coin'){
      const s=stageFromStatus(statusBase,status);
      // never backwards: a later look that shows less keeps the stage already reached
      if(s&&STEPS_STATUS.indexOf(s)>STEPS_STATUS.indexOf(w.stage))w.stage=s;
     }
     // a balance that fell (a trade spent it) lowers the mark, so a later deposit still shows as a rise
     for(const id of Object.keys(base))if(big(cur[id])<big(base[id]))base[id]=cur[id]??'0';
    }
   }
   if(!statusBase&&status)statusBase=status;
   w.base=JSON.stringify(base);w.status_base=statusBase?JSON.stringify(statusBase):null;w.checked_at=at;
  }
  db.prepare(`INSERT INTO ledger_deposit_watch(account_id,started_at,checked_at,base,status_base,stage,coin,arrived_raw,done_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id) DO UPDATE SET started_at=excluded.started_at,checked_at=excluded.checked_at,base=excluded.base,status_base=excluded.status_base,stage=excluded.stage,coin=excluded.coin,arrived_raw=excluded.arrived_raw,done_at=excluded.done_at`)
   .run(w.account_id,w.started_at,w.checked_at,w.base,w.status_base,w.stage,w.coin,w.arrived_raw,w.done_at);
  const value=answer(w,cur);
  looks.set(accountId,{at,value});if(looks.size>500)looks.delete(looks.keys().next().value);
  return value;
 }

 return {
  /** Whether a set can be made at all (the partner key is configured). */
  enabled:!!call,networks:[...networks],
  ensure,watch,rowOf,
  /** yeet_fund for an account on the ledger route. Card payments are not offered: they land in the person's wallet,
   * not in their ledger account. Returns {methods, card_deposit?, watch?, usdc_raw?}; never throws. */
  async fund(accountId,solanaAddress){
   const set=await ensure(accountId,solanaAddress);
   if(!set.deposit){log({event:'ledger_fund_unavailable',account:accountId,why:short(set.why,120)});return {methods:[]}}
   let w=null;
   try{w=await watch(accountId,set.account,set.row)}catch(e){log({event:'ledger_deposit_watch_failed',account:accountId,error:short(e?.message,120)})}
   const {usdc_raw,...shown}=w??{};
   return {methods:['crypto'],card_deposit:set.deposit,...(w?{watch:shown,usdc_raw}:{})};
  },
  /** Operator view of a stored set (ops/ledger-route-check.mjs): never the internal account's key material, there is none. */
  describe(accountId){const r=rowOf(accountId);if(!r)return null;let a=[];try{a=JSON.parse(r.addresses??'[]')}catch{}
   return {account_id:r.account_id,ledger_account:r.ledger_account,state:r.state,source:r.source,correlation_id:r.correlation_id,internal_address:r.internal_address,created_at:r.created_at,last_error:r.last_error,
    chains:a.map(e=>({chain:e.blockchain,address:e.address,...(e.memo?{memo:'yes (never offered)'}:{})}))}},
  /** 1Click's raw status of a stored set, for the operator's proof run: {status, updatedAt, deposited, origins, near, dests} or null. */
  async status(accountId){const r=rowOf(accountId);return call&&r?.internal_address?readStatus(r):null},
 };
}
/** A stable id for an operator-made set when no YEET account id is given (ops tool): `address:<first 16 hex of sha256>`. */
export const operatorAccountId=solanaAddress=>`address-${createHash('sha256').update(String(solanaAddress)).digest('hex').slice(0,16)}`;

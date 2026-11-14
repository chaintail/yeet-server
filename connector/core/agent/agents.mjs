// The agent route, core side (connector/docs/AGENT-ROUTE.md; shared/agent-route.mjs). A coding agent trades for a YEET account
// with its OWN ed25519 key, from its OWN balance inside the NEAR Intents ledger (intents.near): the key's implicit
// account. The server holds no key of the agent or of the person:
//   register   the agent names its public key; one key per OAuth client of an account. The answer carries the link to
//              the YEET signing page, where the person signs ONE ledger transfer from their own ledger account (the
//              one their Privy Solana key owns) to the agent's account: the budget.
//   trades     the pipeline's own proposals, confirm codes, caps, trade rows and the ledger route (ledger-route/route.mjs),
//              under the agent's own account id (yeet-agent-...), whose wallet is the agent's key. The agent gets the
//              unsigned token_diff message (raw_ed25519), signs it locally and hands the signature back.
//   return     the agent's whole balance back to the owner's ledger account, and only there: the message is built
//              here with the owner's account as the one receiver; the agent signs it.
// On top of the pipeline's own caps, each agent trade is capped (YEET_AGENT_MAX_TRADE_USDC, YEET_AGENT_MAX_DAY_USDC)
// and may name only the coins YEET lists on the ledger. Budget transfers and returns are relayed by the ledger route's
// solver (it pays the NEAR gas); it cannot change them: they are the signer's own message.
//
// Owner account mode (YEET_AGENT_OWNER_ACCOUNT=on, `account: "owner"` on the trade and read tools): the agent trades the
// PERSON's own ledger account instead of its own. The person approved the agent once with Privy; the agent obtains the
// signature from the person's Privy Solana wallet itself (signMessage), outside this server. Here it is the ChatGPT card's
// own path: the pipeline's proposal, confirm code, execute and submit under the person's account id (so the person's
// caps, XP and portfolio apply as for a card trade), the ledger route's token_diff, raw_ed25519 against the person's
// wallet key, simulate then settle, plus the agent caps per trade and per day. Trades only: no transfer is ever built
// or relayed for the person's account here.
import {createHash,randomBytes} from 'node:crypto';
import {ed25519AccountId,rawEd25519Payload,intentHash} from '../intents/sign.mjs';
import {transferIntent} from '../intents/jit.mjs';
import {payloadString} from '../intents/intents.mjs';
import {buildNonce} from '../intents/nonce.mjs';
import {USDC_SOL_TOKEN_ID,VERIFIER} from '../intents/constants.mjs';
import {settledOk} from '../ledger-route/solver.mjs';
import {CATALOG,parseUnits,formatUnits,base58Encode,base58Decode} from '../trade/router.mjs';
import {TradeError,newId,iso,utcDay} from '../trade/util.mjs';
import {spentToday} from '../trade/limits.mjs';

export const AGENT_PREFIX='yeet-agent-';
export const OP_ID=/^a_[a-z0-9]{20}$/;
const TOKEN_ID=/^nep141:[a-z0-9._-]{2,64}$/;
const USDC_RE=/^\d{1,7}(\.\d{1,6})?$/;
/** A budget link stays open this long; each message it issues is valid OP_DEADLINE_MS. */
export const FUND_WINDOW_MS=24*3600_000,OP_DEADLINE_MS=5*60_000,OP_MIN_LEFT_MS=20_000;
/** The route class of the pipeline context of an owner-mode call: confirm codes are bound to it (proposals.mint). */
export const OWNER_CLIENT_PREFIX='agent-owner:';

/** Whether owner account mode is on (YEET_AGENT_OWNER_ACCOUNT). Throws on a value it does not know, and on `on` without
 * YEET_AGENT_ROUTE=on (the service does not start). */
export function agentOwnerAccountOn(env=process.env,routeOn){
 const v=(env.YEET_AGENT_OWNER_ACCOUNT??'').trim().toLowerCase();
 if(v===''||v==='off')return false;
 if(v!=='on')throw Error('Invalid YEET_AGENT_OWNER_ACCOUNT (on or off)');
 if(!routeOn)throw Error('YEET_AGENT_OWNER_ACCOUNT=on needs YEET_AGENT_ROUTE=on');
 return true;
}

/** A refusal of the agent route: a code, a sentence a model can relay, and the HTTP status. */
export class AgentError extends Error{
 constructor(code,message,status=409,extra){super(message);this.name='AgentError';this.code=code;this.status=status;if(extra)this.extra=extra}
}
const fail=(code,message,status,extra)=>{throw new AgentError(code,message,status,extra)};

function usdcEnv(env,name,fallback){
 const v=env[name]?.trim()||fallback;
 if(!USDC_RE.test(v)||!(Number(v)>0))throw Error(`Invalid ${name} (a positive USDC amount like 25)`);
 return parseUnits(v,6);
}
/** The agent caps. Read only when the route is on. */
export function agentLimitsFromEnv(env=process.env){
 const maxTradeRaw=usdcEnv(env,'YEET_AGENT_MAX_TRADE_USDC','10'),maxDayRaw=usdcEnv(env,'YEET_AGENT_MAX_DAY_USDC','50'),maxBudgetRaw=usdcEnv(env,'YEET_AGENT_MAX_BUDGET_USDC','100');
 if(maxDayRaw<maxTradeRaw)throw Error('YEET_AGENT_MAX_DAY_USDC is below YEET_AGENT_MAX_TRADE_USDC');
 return Object.freeze({maxTradeRaw,maxDayRaw,maxBudgetRaw});
}

/** The agent's key as the base58 of its 32 public bytes (the shape the ledger route uses for a wallet). Accepts
 * `ed25519:<base58>`, bare base58 or 64 hex characters. */
export function parseAgentKey(value){
 const v=typeof value==='string'?value.trim():'';
 let bytes=null;
 try{
  if(/^[0-9a-f]{64}$/i.test(v))bytes=Buffer.from(v,'hex');
  else{const b=v.replace(/^ed25519:/,'');if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b))bytes=base58Decode(b)}
 }catch{bytes=null}
 if(!bytes||bytes.length!==32)fail('AGENT_KEY_INVALID','public_key must be an ed25519 public key: "ed25519:<base58>", base58 or 64 hex characters (32 bytes).',400);
 return base58Encode(Uint8Array.from(bytes));
}
/** The pipeline account of an agent key. */
export const agentAccountId=address=>`${AGENT_PREFIX}${ed25519AccountId(address).slice(0,40)}`;
/** A Base address nobody holds a key to, so the pipeline's wallet pair is complete; the ledger route never reads or pays
 * it (its USDC reads as 0, ledger-route/route.mjs ledgerBalances). */
const unusedBase=address=>`0x${createHash('sha256').update(`yeet-agent-unused-base:${address}`).digest('hex').slice(0,40)}`;

const SCHEMA=`
CREATE TABLE IF NOT EXISTS agent_key(
 account_id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, ledger_account TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN('pending','active','revoked')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS agent_key_client ON agent_key(owner,client_id) WHERE state<>'revoked';
CREATE TABLE IF NOT EXISTS agent_op(
 op_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('fund','return')),
 state TEXT NOT NULL CHECK(state IN('awaiting_signature','sending','settled','failed','expired')),
 attempt_no INTEGER NOT NULL DEFAULT 0, payload TEXT, payload_sha256 TEXT, nonce TEXT, deadline_ms INTEGER,
 json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_op_account ON agent_op(account_id,created_at);
CREATE TABLE IF NOT EXISTS agent_quote(
 proposal_id TEXT NOT NULL, revision INTEGER NOT NULL, account_id TEXT NOT NULL, confirm TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(proposal_id,revision));`;
// Owner account mode only (created only when it is on). Every row is bound to the person (owner) AND the agent
// connection (client_id): a quote, a trade or a request of one connection is unknown to every other one, and the
// ChatGPT route's own trades are unknown to all of them.
const OWNER_SCHEMA=`
CREATE TABLE IF NOT EXISTS agent_owner_quote(
 proposal_id TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT NOT NULL, client_id TEXT NOT NULL, confirm TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(proposal_id,revision));
CREATE TABLE IF NOT EXISTS agent_owner_trade(
 trade_id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL, proposal_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_owner_trade_client ON agent_owner_trade(owner,client_id,created_at);
CREATE TABLE IF NOT EXISTS agent_owner_request(
 request_id TEXT PRIMARY KEY, trade_id TEXT NOT NULL, owner TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL);`;

/** What the pipeline needs to know about agent accounts (pipeline.mjs `agents`). Creates the tables. */
export function agentAccounts(db){
 db.exec(SCHEMA);
 const get=id=>db.prepare("SELECT * FROM agent_key WHERE account_id=? AND state<>'revoked'").get(id);
 return {
  isAgent:id=>typeof id==='string'&&id.startsWith(AGENT_PREFIX)&&!!get(id),
  ownerOf:id=>get(id)?.owner??null,
  async walletsOf(id){const a=get(id);if(!a)return null;return {base:{address:unusedBase(a.public_key),walletId:null,signerState:'none',policyId:null},solana:{address:a.public_key,walletId:null,signerState:'none',policyId:null}}},
 };
}

/** The coins an agent may trade: the catalogue's Solana coins that the ledger holds, USDC excepted. */
export const agentCoins=(catalog=CATALOG)=>catalog.filter(e=>e.chain==='solana'&&e.kind!=='funding'&&e.address&&TOKEN_ID.test(e.assetId??'')&&e.assetId!==USDC_SOL_TOKEN_ID&&e.symbol!=='USDC');

/**
 * engine: the pipeline (pipeline.mjs, created with agents=agentAccounts(db)); limits: agentLimitsFromEnv;
 * pageUrl(opId): the signing page address of a budget link.
 */
export function createAgents({db,engine,limits,pageUrl,catalog=engine?.catalog??CATALOG,now=Date.now,log=()=>{},ownerAccount=false}){
 db.exec(SCHEMA);
 if(ownerAccount)db.exec(OWNER_SCHEMA);
 const route=engine?.ledgerRoute;
 if(!route?.solver||!route?.verifier)throw Error('The agent route needs the ledger route');
 const {solver,verifier}=route;
 const event=e=>{try{log(e)}catch{}};
 const coins=agentCoins(catalog),coinBySymbol=new Map(coins.map(c=>[c.symbol,c]));
 const usdcIds=[USDC_SOL_TOKEN_ID,...catalog.filter(e=>e.symbol==='USDC'&&e.assetId!==USDC_SOL_TOKEN_ID&&TOKEN_ID.test(e.assetId??'')).map(e=>e.assetId)];
 const keyOf=(owner,clientId)=>db.prepare("SELECT * FROM agent_key WHERE owner=? AND client_id=? AND state<>'revoked'").get(owner,clientId);
 const opRow=id=>db.prepare('SELECT * FROM agent_op WHERE op_id=?').get(id);
 const saveOp=(id,j,set={})=>{const cols=Object.keys(set);db.prepare(`UPDATE agent_op SET json=?,updated_at=?${cols.map(c=>`,${c}=?`).join('')} WHERE op_id=?`).run(JSON.stringify(j),now(),...cols.map(c=>set[c]),id)};
 const ctxOf=a=>({accountId:a.account_id,clientId:`agent:${a.client_id}`.slice(0,2048)});
 const usdcText=raw=>formatUnits(raw,6);

 function requireAgent(owner,clientId,{active=true}={}){
  const a=keyOf(owner,clientId);
  if(!a)fail('AGENT_NOT_REGISTERED','No agent key is registered for this connection yet. Generate an ed25519 key on your own machine and call the register tool with its public key.',409);
  if(active&&a.state!=='active')fail('AGENT_NOT_FUNDED',`The agent key is registered but has no budget yet. Ask the person to open ${linkOf(a)??'the budget link from the register tool'} and approve the budget.`,409);
  return a;
 }
 const openFund=a=>db.prepare("SELECT * FROM agent_op WHERE account_id=? AND kind='fund' AND state IN('awaiting_signature','sending') ORDER BY created_at DESC LIMIT 1").get(a.account_id);
 function linkOf(a){const o=openFund(a);return o&&now()<o.created_at+FUND_WINDOW_MS?pageUrl(o.op_id):null}
 const ownerWallet=async owner=>{
  const w=await engine.wallets.require(owner);
  if(!w?.solana?.address)fail('WALLET_NOT_READY','The YEET account has no wallet yet. Sign in to YEET once in ChatGPT or on yeet.win first.',409);
  return w.solana.address;
 };

 /** The agent's balance in the ledger: USDC (every USDC token id together) and each listed coin it holds. */
 async function balanceOf(a){
  const ids=[...usdcIds,...coins.map(c=>c.assetId)],bal=await verifier.balances(a.ledger_account,ids);
  const usdc=bal.slice(0,usdcIds.length).reduce((x,y)=>x+y,0n);
  const held=coins.map((c,i)=>({symbol:c.symbol,raw:bal[usdcIds.length+i],decimals:c.decimals,token_id:c.assetId})).filter(h=>h.raw>0n);
  return {usdcRaw:usdc,byToken:Object.fromEntries(ids.map((id,i)=>[id,bal[i]]).filter(([,v])=>v>0n)),
   view:{usdc:usdcText(usdc),coins:held.map(h=>({symbol:h.symbol,amount:formatUnits(h.raw,h.decimals)}))}};
 }
 function limitsView(a){
  const spent=spentToday(db,a.account_id,now()),left=spent>=limits.maxDayRaw?0n:limits.maxDayRaw-spent;
  return {max_trade_usdc:usdcText(limits.maxTradeRaw),max_day_usdc:usdcText(limits.maxDayRaw),spent_today_usdc:usdcText(spent),left_today_usdc:usdcText(left),
   max_budget_usdc:usdcText(limits.maxBudgetRaw),coins:coins.map(c=>c.symbol)};
 }

 // ---- budget transfers and returns: one transfer message, signed by its sender's own key ----
 async function issue(op){
  const j=JSON.parse(op.json),deadlineMs=now()+OP_DEADLINE_MS;
  const nonce=buildNonce({saltHex:await verifier.currentSalt(),deadlineMs});
  const payload=payloadString({signerId:j.signer_id,deadline:iso(deadlineMs),nonce,intents:[transferIntent({receiverId:j.receiver_id,tokens:j.tokens})]});
  const n=op.attempt_no+1;
  db.prepare("UPDATE agent_op SET attempt_no=?,payload=?,payload_sha256=?,nonce=?,deadline_ms=?,updated_at=? WHERE op_id=? AND state='awaiting_signature' AND attempt_no=?")
   .run(n,payload,createHash('sha256').update(payload).digest('hex'),nonce,deadlineMs,now(),op.op_id,op.attempt_no);
  return opRow(op.op_id);
 }
 /** The op's open message, renewed once it is too close to its deadline. Null when the op is not waiting. */
 async function openMessage(op){
  if(op.state!=='awaiting_signature')return null;
  const j=JSON.parse(op.json);
  if(j.expires_ms&&now()>j.expires_ms){db.prepare("UPDATE agent_op SET state='expired',updated_at=? WHERE op_id=? AND state='awaiting_signature'").run(now(),op.op_id);return null}
  return !op.payload||now()>op.deadline_ms-OP_MIN_LEFT_MS?issue(op):op;
 }
 /** The sign request of an op, in the near_intent shape the signing page checks (wallet-request.mjs checkIntent). */
 function requestOf(op){
  const j=JSON.parse(op.json),[[tokenId,amount]]=Object.entries(j.tokens);
  const symbol=usdcIds.includes(tokenId)?'USDC':coins.find(c=>c.assetId===tokenId)?.symbol??tokenId,decimals=usdcIds.includes(tokenId)?6:coins.find(c=>c.assetId===tokenId)?.decimals??0;
  const summary={side:op.kind,asset:symbol,amount_raw:String(amount),decimals,to:j.receiver_id};
  return {trade_id:op.op_id,leg:0,attempt_id:`${op.op_id}.${op.attempt_no}`,kind:'near_intent',chain:'sol',wallet:j.signer_wallet,
   payload:{standard:'raw_ed25519',message:op.payload,message_base64:Buffer.from(op.payload,'utf8').toString('base64'),signer_id:j.signer_id,verifying_contract:VERIFIER,
    deadline:iso(op.deadline_ms),transfer:{receiver_id:j.receiver_id,tokens:j.tokens}},
   payload_sha256:op.payload_sha256,expires_at:iso(op.deadline_ms-OP_MIN_LEFT_MS),summary,legs:[0],leg_summaries:[{leg:0,...summary}]};
 }
 const opStatus=op=>op.state==='settled'?'settled':op.state==='sending'?'sending':op.state==='awaiting_signature'?'awaiting_signature':op.state;
 /** Reads the outcome of an op that was handed to NEAR but not seen settled: the sender's nonce is used or it is not. */
 async function followUp(op){
  if(op.state!=='sending')return op;
  const j=JSON.parse(op.json);
  let used=false;try{used=await verifier.isNonceUsed(j.signer_id,op.nonce)}catch{return op}
  if(used)return settle(op,j);
  if(now()>op.deadline_ms+30_000){db.prepare("UPDATE agent_op SET state='failed',updated_at=? WHERE op_id=? AND state='sending'").run(now(),op.op_id);return opRow(op.op_id)}
  return op;
 }
 function settle(op,j){
  db.prepare("UPDATE agent_op SET state='settled',updated_at=? WHERE op_id=? AND state IN('awaiting_signature','sending')").run(now(),op.op_id);
  if(op.kind==='fund')db.prepare("UPDATE agent_key SET state='active',updated_at=? WHERE account_id=? AND state='pending'").run(now(),op.account_id);
  event({event:'agent_op_settled',op:op.op_id,kind:op.kind,tx_hash:j.tx?.tx_hash??null});
  return opRow(op.op_id);
 }
 /** A signature over an op's open message. Verified against the sender's key, simulated alone, then sent once. */
 async function submitOp(op,{attemptId,signature}){
  if(op.state==='settled'||op.state==='sending')return followUp(op);
  if(op.state!=='awaiting_signature')fail('REQUEST_CLOSED','This request is closed. Ask for a new one.',409);
  if(attemptId!==`${op.op_id}.${op.attempt_no}`||!op.payload)fail('REQUEST_EXPIRED','That message was replaced by a newer one. Ask for the request again and sign the new message.',409);
  if(now()>op.deadline_ms-OP_MIN_LEFT_MS)fail('REQUEST_EXPIRED','The message expired before it was signed. Ask for the request again and sign the new message.',409);
  const j=JSON.parse(op.json),sig=signatureBytes(signature);
  let mp;
  try{mp=rawEd25519Payload(op.payload,j.signer_wallet,sig)}
  catch{fail('SIGNATURE_INVALID','The signature does not verify over the exact message bytes with the expected key. Sign message (UTF-8 bytes, no prefix) with the ed25519 key.',400)}
  const sim=await verifier.simulate([mp]);
  if(!sim.ok){
   event({event:'agent_op_refused',op:op.op_id,kind:op.kind,code:sim.code});
   if(sim.code==='INSUFFICIENT_BALANCE')fail('BALANCE_LOW',op.kind==='fund'?'The YEET account does not hold that much USDC in its ledger account. Add funds in YEET first, or choose a smaller budget.':'The agent balance changed. Ask for the return request again.',409);
   if(['INVALID_SALT','DEADLINE_EXPIRED','NONCE_EXPIRED','NONCE_USED'].includes(sim.code))fail('REQUEST_EXPIRED','The message can no longer be used. Ask for the request again and sign the new message.',409);
   fail('TEMPORARILY_UNAVAILABLE','The ledger refused this message. Nothing moved. Try again in a minute.',503);
  }
  j.signed=mp;j.intent_hash=intentHash(mp);j.tx??={};
  if(db.prepare("UPDATE agent_op SET state='sending',json=?,updated_at=? WHERE op_id=? AND state='awaiting_signature'").run(JSON.stringify(j),now(),op.op_id).changes!==1)return opRow(op.op_id);
  let st=null;
  try{st=await solver.lock(()=>solver.sendOnce(j.tx,[mp],()=>saveOp(op.op_id,j),{label:`agent_${op.kind}`}))}
  catch(e){event({event:'agent_op_send_failed',op:op.op_id,error:String(e?.message??e).slice(0,160)})}
  saveOp(op.op_id,j);
  if(st&&settledOk(st)){const done=settle(opRow(op.op_id),j);await solver.awaitFinal(j.tx);return done}
  return followUp(opRow(op.op_id));
 }

 // ---- the tools ----
 async function overview(owner,clientId){
  const a=keyOf(owner,clientId);
  if(!a)return {route:'agent',registered:false,state:'not_registered',limits:{max_trade_usdc:usdcText(limits.maxTradeRaw),max_day_usdc:usdcText(limits.maxDayRaw),max_budget_usdc:usdcText(limits.maxBudgetRaw),coins:coins.map(c=>c.symbol)},
   next:'Generate an ed25519 key pair on your own machine, keep the private key there, and call the register tool with the public key and a budget in USDC.'};
  const bal=await balanceOf(a).catch(()=>null),link=linkOf(a);
  return {route:'agent',registered:true,state:a.state==='active'?'active':'awaiting_budget',public_key:`ed25519:${a.public_key}`,agent_account:a.ledger_account,
   balance:bal?.view??null,limits:limitsView(a),...(link?{budget_url:link}:{}),
   next:a.state==='active'?'Quote a trade, prepare it, sign the message with your key and submit the signature.':`Ask the person to open ${link??'a new budget link (call register again)'} and approve the budget.`};
 }
 /** Registers (or re-states) the agent's key for this connection and opens a budget link for `budget_usdc`. */
 async function register(owner,clientId,{public_key,budget_usdc}){
  const address=parseAgentKey(public_key),account=ed25519AccountId(address);
  if(!USDC_RE.test(String(budget_usdc??''))||!(Number(budget_usdc)>0))fail('INVALID_ARGUMENT','budget_usdc must be a positive USDC amount like "20".',400);
  const budget=parseUnits(String(budget_usdc),6);
  if(budget>limits.maxBudgetRaw)fail('LIMIT_EXCEEDED',`A budget is at most ${usdcText(limits.maxBudgetRaw)} USDC.`,409);
  const wallet=await ownerWallet(owner),ownerAccount=ed25519AccountId(wallet);
  if(account===ownerAccount||account===solver.accountId||address===wallet)fail('AGENT_KEY_INVALID','Use a key made for this agent only, never the key of a YEET wallet.',400);
  // A key once linked to a connection, revoked or not, stays with it: a revoked row is never handed to another
  // account (its ledger balance may still be the first owner's). A key that is any YEET account's wallet is refused too.
  const other=db.prepare("SELECT * FROM agent_key WHERE public_key=?").get(address);
  if(other&&(other.owner!==owner||other.client_id!==clientId))fail('AGENT_KEY_TAKEN','That key is already linked to another YEET connection. Generate a new key for this agent.',409);
  if(db.prepare("SELECT 1 FROM wallets WHERE (address=? OR lower(address)=lower(?)) AND account_id NOT LIKE 'yeet-agent-%' LIMIT 1").get(address,address))
   fail('AGENT_KEY_INVALID','Use a key made for this agent only, never the key of a YEET wallet.',400);
  let a=keyOf(owner,clientId);
  // A new budget link for an agent that already holds a balance: the balance and the new budget together stay within the cap.
  if(a&&a.public_key===address&&a.state==='active'){
   const held=(await balanceOf(a)).usdcRaw;
   if(held+budget>limits.maxBudgetRaw)fail('LIMIT_EXCEEDED',`An agent holds at most ${usdcText(limits.maxBudgetRaw)} USDC; it holds ${usdcText(held)} USDC now.`,409);
  }
  if(a&&a.public_key!==address){
   if(a.state==='active')fail('AGENT_KEY_LINKED',`This connection already trades with the key ed25519:${a.public_key}. Return its budget first, or connect again as a new agent to use another key.`,409);
   db.prepare("UPDATE agent_key SET state='revoked',updated_at=? WHERE account_id=?").run(now(),a.account_id);
   db.prepare("UPDATE agent_op SET state='expired',updated_at=? WHERE account_id=? AND state='awaiting_signature'").run(now(),a.account_id);
   a=null;
  }
  if(!a){
   const id=agentAccountId(address);
   db.prepare("INSERT INTO agent_key(account_id,owner,client_id,public_key,ledger_account,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner,client_id=excluded.client_id,state='pending',updated_at=excluded.updated_at")
    .run(id,owner,clientId,address,account,now(),now());
   a=keyOf(owner,clientId);
  }
  db.prepare("UPDATE agent_op SET state='expired',updated_at=? WHERE account_id=? AND kind='fund' AND state='awaiting_signature'").run(now(),a.account_id);
  const opId=newId('a');
  db.prepare("INSERT INTO agent_op(op_id,account_id,kind,state,json,created_at,updated_at) VALUES(?,?,'fund','awaiting_signature',?,?,?)")
   .run(opId,a.account_id,JSON.stringify({signer_wallet:wallet,signer_id:ownerAccount,receiver_id:account,tokens:{[USDC_SOL_TOKEN_ID]:budget.toString()},expires_ms:now()+FUND_WINDOW_MS}),now(),now());
  event({event:'agent_registered',account:a.account_id,owner,state:a.state});
  return {state:a.state==='active'?'active':'awaiting_budget',public_key:`ed25519:${address}`,agent_account:account,budget_usdc:usdcText(budget),budget_url:pageUrl(opId),
   expires_at:iso(now()+FUND_WINDOW_MS),
   next:'Give the person budget_url. They sign in to YEET there and approve one transfer of the budget from their YEET balance to your account. Then call the overview tool: state becomes active.'};
 }
 async function balance(owner,clientId){const a=requireAgent(owner,clientId,{active:false});return {agent_account:a.ledger_account,...(await balanceOf(a)).view}}
 function checkCoins(symbols){
  for(const s of symbols)if(!coinBySymbol.has(s))fail('COIN_NOT_SUPPORTED',`${s} is not a coin YEET lists. Listed coins: ${coins.map(c=>c.symbol).join(', ')}.`,409,{coins:coins.map(c=>c.symbol)});
 }
 /** A firm quote through the pipeline's proposals. The confirm code stays here; the agent gets the quote id. */
 async function quote(owner,clientId,{side,coins:symbols,amount_usdc,percent=100}){
  const a=requireAgent(owner,clientId);
  if(!['buy','sell'].includes(side))fail('INVALID_ARGUMENT','side is buy or sell.',400);
  if(!Array.isArray(symbols)||!symbols.length||symbols.length>5||new Set(symbols).size!==symbols.length)fail('INVALID_ARGUMENT','coins lists 1 to 5 different coin symbols.',400);
  const list=symbols.map(s=>String(s).trim().replace(/^\$/,'').toUpperCase());
  checkCoins(list);
  const ctx=ctxOf(a),request_id=`agent-${randomBytes(9).toString('hex')}`;
  let p;
  if(side==='buy'){
   if(!USDC_RE.test(String(amount_usdc??''))||!(Number(amount_usdc)>0))fail('INVALID_ARGUMENT','amount_usdc is the USDC to spend, like "5".',400);
   if(parseUnits(String(amount_usdc),6)>limits.maxTradeRaw)fail('LIMIT_EXCEEDED',`An agent trade is at most ${usdcText(limits.maxTradeRaw)} USDC.`,409,{limits:limitsView(a)});
   p=await engine.propose(ctx,{request_id,amount_usdc:String(amount_usdc),legs:list.map(symbol=>({symbol,parts:1}))});
  }else{
   if(!Number.isInteger(percent)||percent<1||percent>100)fail('INVALID_ARGUMENT','percent is a whole number from 1 to 100.',400);
   p=await engine.skeet(ctx,{request_id,legs:list.map(symbol=>({symbol,percent}))});
  }
  if(!p?.confirm?.code)fail('TEMPORARILY_UNAVAILABLE','The quote could not be made just now. Try again in a minute.',503);
  db.prepare('INSERT OR REPLACE INTO agent_quote(proposal_id,revision,account_id,confirm,created_at) VALUES(?,?,?,?,?)').run(p.proposal_id,p.revision,a.account_id,p.confirm.code,now());
  return {quote_id:p.proposal_id,revision:p.revision,side,amount_usdc:p.amount_usdc,legs:p.legs.map(l=>({symbol:l.symbol,amount_in:l.amount_in,est_out:l.est_out,min_out:l.min_out,est_out_usd:l.est_out_usd})),
   cost_pct:p.totals?.cost_pct??null,quoted_at:p.quoted_at,warnings:p.warnings??[],next:'Call the prepare tool with quote_id to get the message to sign.'};
 }
 /** The unsigned message for a quote, after the agent caps. */
 async function prepare(owner,clientId,{quote_id,revision}){
  const a=requireAgent(owner,clientId);
  const q=db.prepare('SELECT * FROM agent_quote WHERE proposal_id=? AND account_id=? ORDER BY revision DESC LIMIT 1').get(String(quote_id??''),a.account_id);
  if(!q||(revision!==undefined&&revision!==q.revision))fail('QUOTE_NOT_FOUND','Unknown quote_id for this agent. Call the quote tool first.',404);
  const prop=db.prepare('SELECT direction,amount_in_raw FROM proposals WHERE id=?').get(q.proposal_id);
  if(prop?.direction==='yeet'){
   const total=BigInt(prop.amount_in_raw),spent=spentToday(db,a.account_id,now());
   if(total>limits.maxTradeRaw)fail('LIMIT_EXCEEDED',`An agent trade is at most ${usdcText(limits.maxTradeRaw)} USDC.`,409,{limits:limitsView(a)});
   if(spent+total>limits.maxDayRaw)fail('LIMIT_EXCEEDED',`This agent can spend ${usdcText(spent>=limits.maxDayRaw?0n:limits.maxDayRaw-spent)} USDC more today (at most ${usdcText(limits.maxDayRaw)} USDC per UTC day).`,409,{limits:limitsView(a)});
  }
  const x=await engine.execute(ctxOf(a),{proposal_id:q.proposal_id,revision:q.revision,confirm:q.confirm});
  if(x?.status==='requote_required'||x?.proposal)fail('REQUOTE_REQUIRED','Prices moved past the quote. Call the quote tool again.',409);
  const req=(x?.sign_requests??[]).find(r=>r.kind==='near_intent');
  if(!req)return {trade_id:x?.trade_id??null,status:x?.status??'unknown',request:null};
  return {trade_id:x.trade_id,status:x.status,request:agentRequest(req)};
 }
 const agentRequest=req=>({request_id:`${req.trade_id}.${req.attempt_id}`,standard:'raw_ed25519',message:req.payload.message,message_base64:req.payload.message_base64,
  public_key:`ed25519:${req.wallet}`,signer_id:req.payload.signer_id,deadline:req.payload.deadline,sign_before:req.expires_at,gives:req.payload.gives,receives:req.payload.receives,
  how:'Sign the UTF-8 bytes of message (exactly, no prefix) with your ed25519 key; pass the 64-byte signature as base64 to the submit tool with request_id.'});
 /** The agent's signature for a trade request or a return request. */
 async function submit(owner,clientId,{request_id,signature}){
  const a=requireAgent(owner,clientId,{active:false});
  const m=/^(t_[a-z0-9]{20})\.([0-9a-f]{64})$/.exec(String(request_id??''))??/^(a_[a-z0-9]{20})\.(\d{1,4})$/.exec(String(request_id??''));
  if(!m)fail('INVALID_ARGUMENT','request_id is the one the prepare or return tool gave.',400);
  if(m[1].startsWith('a_')){
   const op=opRow(m[1]);
   if(!op||op.account_id!==a.account_id||op.kind!=='return')fail('INVALID_ARGUMENT','Unknown request_id for this agent.',404);
   const done=await submitOp(op,{attemptId:String(request_id),signature});
   return {request_id:String(request_id),kind:'return',status:opStatus(done)};
  }
  const ctx=ctxOf(a),sig=Buffer.from(signatureBytes(signature)).toString('base64');
  const t=db.prepare('SELECT account_id FROM trades WHERE id=?').get(m[1]);
  if(!t||t.account_id!==a.account_id)fail('INVALID_ARGUMENT','Unknown request_id for this agent.',404);
  const leg=db.prepare('SELECT MIN(idx) AS i FROM trade_legs WHERE trade_id=?').get(m[1])?.i??0;
  const s=await engine.submit(ctx,{trade_id:m[1],leg,attempt_id:m[2],signed:sig});
  const st=await status(owner,clientId,{trade_id:m[1]}).catch(()=>null);
  return {request_id:String(request_id),kind:'trade',trade_id:m[1],status:st?.status??s?.status??'pending',...(st?{trade:st}:{})};
 }
 async function status(owner,clientId,{trade_id}){
  const a=requireAgent(owner,clientId,{active:false});
  const v=engine.status(ctxOf(a),trade_id);
  return {trade_id,status:v.status,direction:v.direction,received:v.received??[],legs:(v.legs??[]).map(l=>({symbol:l.symbol,status:l.status,amount_in:l.amount_in,amount_out:l.amount_out,tx:l.origin_tx??null})),updated_at:v.updated_at};
 }
 async function positions(owner,clientId){
  const a=requireAgent(owner,clientId,{active:false});
  const [bal,pf]=await Promise.all([balanceOf(a),engine.portfolio(ctxOf(a)).catch(()=>null)]);
  const recent=db.prepare('SELECT id FROM trades WHERE account_id=? ORDER BY created_at DESC LIMIT 5').all(a.account_id);
  const trades=[];for(const r of recent){try{trades.push(await status(owner,clientId,{trade_id:r.id}))}catch{}}
  return {agent_account:a.ledger_account,usdc:bal.view.usdc,holdings:pf?.solana?.holdings?.filter(h=>h.symbol!=='USDC')??bal.view.coins.map(c=>({...c,usd:null})),total_usd:pf?.total_usd??null,recent_trades:trades,limits:limitsView(a)};
 }
 /** The unsigned transfer of the whole agent balance to the owner's ledger account (the only receiver it can name). */
 async function returnBudget(owner,clientId){
  const a=requireAgent(owner,clientId,{active:false});
  const wallet=await ownerWallet(owner),ownerAccount=ed25519AccountId(wallet);
  const {byToken}=await balanceOf(a),tokens=Object.fromEntries(Object.entries(byToken).map(([k,v])=>[k,v.toString()]));
  if(!Object.keys(tokens).length)fail('NOTHING_TO_RETURN','The agent balance is empty: there is nothing to send back.',409);
  // one token per message keeps the page and the agent's check simple: the largest first, the rest on the next call
  const [first]=Object.entries(tokens).sort(([a],[b])=>a===USDC_SOL_TOKEN_ID?-1:b===USDC_SOL_TOKEN_ID?1:0);
  db.prepare("UPDATE agent_op SET state='expired',updated_at=? WHERE account_id=? AND kind='return' AND state='awaiting_signature'").run(now(),a.account_id);
  const opId=newId('a');
  db.prepare("INSERT INTO agent_op(op_id,account_id,kind,state,json,created_at,updated_at) VALUES(?,?,'return','awaiting_signature',?,?,?)")
   .run(opId,a.account_id,JSON.stringify({signer_wallet:a.public_key,signer_id:a.ledger_account,receiver_id:ownerAccount,tokens:{[first[0]]:first[1]},expires_ms:now()+OP_DEADLINE_MS*2}),now(),now());
  const op=await openMessage(opRow(opId)),r=requestOf(op);
  return {request_id:r.attempt_id,standard:'raw_ed25519',message:r.payload.message,message_base64:r.payload.message_base64,public_key:`ed25519:${a.public_key}`,signer_id:a.ledger_account,
   receiver_id:ownerAccount,tokens:r.payload.transfer.tokens,deadline:r.payload.deadline,sign_before:r.expires_at,remaining_tokens:Object.keys(tokens).length-1,
   how:'Sign the UTF-8 bytes of message with your ed25519 key and pass the base64 signature to the submit tool with request_id. If remaining_tokens is above 0, call this tool again after it settles.'};
 }


 // ---- owner account mode: the person's own ledger account, trades only (YEET_AGENT_OWNER_ACCOUNT=on) ----
 /** 'agent' (the default, the route as before) or 'owner'. Anything else, and 'owner' while the mode is off, is refused. */
 function modeOf(account){
  if(account===undefined||account===null||account==='agent')return 'agent';
  if(account!=='owner')fail('INVALID_ARGUMENT','account is "owner" (the person\'s own YEET account) or "agent" (your own key\'s account, the default).',400);
  if(!ownerAccount)fail('OWNER_ACCOUNT_OFF','Trading the person\'s own YEET account from an agent is switched off on this server. Use account "agent" (your own key and budget).',403);
  return 'owner';
 }
 // The pipeline context of an owner-mode call: the person's own account (the token's subject, never a parameter) and a
 // client id of the agent route's class, so a confirm code minted here is never valid on the ChatGPT route and back.
 const ownerCtx=(owner,clientId)=>({accountId:owner,clientId:`${OWNER_CLIENT_PREFIX}${clientId}`.slice(0,2048)});
 /** The person's wallet and ledger account; refused unless the person's account trades on the ledger route. */
 async function requireOwner(owner){
  if(typeof owner!=='string'||owner.startsWith(AGENT_PREFIX))fail('INVALID_ARGUMENT','Unknown YEET account.',400);
  const wallet=await ownerWallet(owner);
  if(!route.handles(owner))fail('OWNER_NOT_ON_LEDGER','The person\'s YEET account does not trade on the YEET ledger yet, so an agent cannot trade it. Use account "agent" with your own key and budget.',409);
  return {wallet,ledgerAccount:ed25519AccountId(wallet)};
 }
 /** What this connection bought for the person today (UTC): buy legs of its owner-mode trades that were not given back
  * as not sent (the pipeline's own release of an unsent buy). */
 function ownerSpentToday(owner,clientId){
  const day=utcDay(now()),from=Date.parse(`${day}T00:00:00.000Z`);
  const rows=db.prepare(`SELECT l.amount_in_raw AS raw FROM agent_owner_trade o JOIN trades t ON t.id=o.trade_id JOIN trade_legs l ON l.trade_id=t.id
   WHERE o.owner=? AND o.client_id=? AND t.account_id=? AND t.direction='yeet' AND t.created_at>=? AND l.send_status<>'not_sent'`).all(owner,clientId,owner,from);
  return rows.reduce((x,r)=>x+BigInt(r.raw??0),0n);
 }
 /** The agent's per-day spend: its own key's account (when this connection has one) and what it bought for the person. */
 function connectionSpentToday(owner,clientId){
  const a=keyOf(owner,clientId);
  return (a?spentToday(db,a.account_id,now()):0n)+ownerSpentToday(owner,clientId);
 }
 function ownerLimitsView(owner,clientId){
  const spent=connectionSpentToday(owner,clientId),left=spent>=limits.maxDayRaw?0n:limits.maxDayRaw-spent;
  return {max_trade_usdc:usdcText(limits.maxTradeRaw),max_day_usdc:usdcText(limits.maxDayRaw),spent_today_usdc:usdcText(spent),left_today_usdc:usdcText(left),coins:coins.map(c=>c.symbol)};
 }
 // One prepare at a time per connection: the per-day check and the trade it admits are not split by another prepare.
 const locks=new Map();
 async function serial(key,fn){
  const prev=locks.get(key)??Promise.resolve();let release;const mine=new Promise(r=>release=r);locks.set(key,prev.then(()=>mine));
  await prev.catch(()=>{});
  try{return await fn()}finally{release();if(locks.get(key)===mine||locks.size>1000)locks.delete(key)}
 }
 /** A ledger request is accepted for the person only when it is exactly one token_diff signed by the person's own
  * ledger account: never a transfer, a withdrawal or anything else that could move funds to another account. */
 function tradeOnly(payload,ledgerAccount){
  let m=null;try{m=JSON.parse(payload)}catch{}
  const ok=m&&m.signer_id===ledgerAccount&&Array.isArray(m.intents)&&m.intents.length===1&&m.intents[0]?.intent==='token_diff'&&m.intents[0].diff&&typeof m.intents[0].diff==='object'
   &&Object.keys(m.intents[0]).every(k=>['intent','diff'].includes(k));
  if(!ok)fail('OWNER_TRADES_ONLY','Only trades can be signed for the person\'s own account through this route.',403);
 }
 async function ownerQuote(owner,clientId,{side,coins:symbols,amount_usdc,percent=100}){
  await requireOwner(owner);
  if(!['buy','sell'].includes(side))fail('INVALID_ARGUMENT','side is buy or sell.',400);
  if(!Array.isArray(symbols)||!symbols.length||symbols.length>5||new Set(symbols).size!==symbols.length)fail('INVALID_ARGUMENT','coins lists 1 to 5 different coin symbols.',400);
  const list=symbols.map(s=>String(s).trim().replace(/^\$/,'').toUpperCase());
  checkCoins(list);
  const ctx=ownerCtx(owner,clientId),request_id=`agent-owner-${randomBytes(9).toString('hex')}`;
  let p;
  if(side==='buy'){
   if(!USDC_RE.test(String(amount_usdc??''))||!(Number(amount_usdc)>0))fail('INVALID_ARGUMENT','amount_usdc is the USDC to spend, like "5".',400);
   if(parseUnits(String(amount_usdc),6)>limits.maxTradeRaw)fail('LIMIT_EXCEEDED',`An agent trade is at most ${usdcText(limits.maxTradeRaw)} USDC.`,409,{limits:ownerLimitsView(owner,clientId)});
   p=await engine.propose(ctx,{request_id,amount_usdc:String(amount_usdc),legs:list.map(symbol=>({symbol,parts:1}))});
  }else{
   if(!Number.isInteger(percent)||percent<1||percent>100)fail('INVALID_ARGUMENT','percent is a whole number from 1 to 100.',400);
   p=await engine.skeet(ctx,{request_id,legs:list.map(symbol=>({symbol,percent}))});
  }
  if(!p?.confirm?.code)fail('TEMPORARILY_UNAVAILABLE','The quote could not be made just now. Try again in a minute.',503);
  db.prepare('INSERT OR REPLACE INTO agent_owner_quote(proposal_id,revision,owner,client_id,confirm,created_at) VALUES(?,?,?,?,?,?)').run(p.proposal_id,p.revision,owner,clientId,p.confirm.code,now());
  return {account:'owner',quote_id:p.proposal_id,revision:p.revision,side,amount_usdc:p.amount_usdc,legs:p.legs.map(l=>({symbol:l.symbol,amount_in:l.amount_in,est_out:l.est_out,min_out:l.min_out,est_out_usd:l.est_out_usd})),
   cost_pct:p.totals?.cost_pct??null,quoted_at:p.quoted_at,warnings:p.warnings??[],next:'Call the prepare tool with quote_id and account "owner" to get the message the person\'s wallet signs.'};
 }
 async function ownerPrepare(owner,clientId,{quote_id,revision}){
  const {wallet,ledgerAccount}=await requireOwner(owner);
  const q=db.prepare('SELECT * FROM agent_owner_quote WHERE proposal_id=? AND owner=? AND client_id=? ORDER BY revision DESC LIMIT 1').get(String(quote_id??''),owner,clientId);
  if(!q||(revision!==undefined&&revision!==q.revision))fail('QUOTE_NOT_FOUND','Unknown quote_id for this connection and account "owner". Call the quote tool with account "owner" first.',404);
  return serial(`${owner}\n${clientId}`,async()=>{
   const prop=db.prepare('SELECT direction,amount_in_raw FROM proposals WHERE id=?').get(q.proposal_id);
   if(prop?.direction==='yeet'){
    const total=BigInt(prop.amount_in_raw),spent=connectionSpentToday(owner,clientId);
    if(total>limits.maxTradeRaw)fail('LIMIT_EXCEEDED',`An agent trade is at most ${usdcText(limits.maxTradeRaw)} USDC.`,409,{limits:ownerLimitsView(owner,clientId)});
    if(spent+total>limits.maxDayRaw)fail('LIMIT_EXCEEDED',`This agent can spend ${usdcText(spent>=limits.maxDayRaw?0n:limits.maxDayRaw-spent)} USDC more today (at most ${usdcText(limits.maxDayRaw)} USDC per UTC day).`,409,{limits:ownerLimitsView(owner,clientId)});
   }
   const x=await engine.execute(ownerCtx(owner,clientId),{proposal_id:q.proposal_id,revision:q.revision,confirm:q.confirm});
   if(x?.status==='requote_required'||x?.proposal)fail('REQUOTE_REQUIRED','Prices moved past the quote. Call the quote tool again.',409);
   if(x?.trade_id)db.prepare('INSERT OR IGNORE INTO agent_owner_trade(trade_id,owner,client_id,proposal_id,created_at) VALUES(?,?,?,?,?)').run(x.trade_id,owner,clientId,q.proposal_id,now());
   const req=(x?.sign_requests??[]).find(r=>r.kind==='near_intent');
   if(!req)return {account:'owner',trade_id:x?.trade_id??null,status:x?.status??'unknown',request:null};
   if(req.wallet!==wallet)fail('TEMPORARILY_UNAVAILABLE','The trade could not be prepared for the person\'s wallet. Nothing moved.',503);
   tradeOnly(req.payload.message,ledgerAccount);
   return {account:'owner',trade_id:x.trade_id,status:x.status,request:{...agentRequest(req),
    how:'Have the person\'s Privy Solana wallet sign the UTF-8 bytes of message exactly (Solana signMessage, no prefix); pass the 64-byte signature as base64 to the submit tool with request_id and account "owner".'}};
  });
 }
 /** The person's wallet signature for an owner-mode trade request of this connection. Single use. */
 async function ownerSubmit(owner,clientId,{request_id,signature}){
  const {wallet,ledgerAccount}=await requireOwner(owner);
  const id=String(request_id??'');
  if(/^a_[a-z0-9]{20}\./.test(id))fail('OWNER_TRADES_ONLY','Only trades can be signed for the person\'s own account through this route.',403);
  const m=/^(t_[a-z0-9]{20})\.([0-9a-f]{64})$/.exec(id);
  if(!m)fail('INVALID_ARGUMENT','request_id is the one the prepare tool gave.',400);
  const [,tradeId,attemptId]=m;
  const o=db.prepare('SELECT * FROM agent_owner_trade WHERE trade_id=?').get(tradeId),t=db.prepare('SELECT account_id FROM trades WHERE id=?').get(tradeId);
  if(!o||o.owner!==owner||o.client_id!==clientId||t?.account_id!==owner)fail('INVALID_ARGUMENT','Unknown request_id for this connection and account "owner".',404);
  const a=route.attempt(attemptId);
  if(!a||a.trade_id!==tradeId||a.account_id!==owner)fail('INVALID_ARGUMENT','Unknown request_id for this connection and account "owner".',404);
  if(db.prepare('SELECT 1 FROM agent_owner_request WHERE request_id=?').get(id)||a.status==='accepted')fail('REQUEST_USED','This request was already signed and submitted. Check the trade with the status tool; for a new trade, quote again.',409);
  if(a.status!=='pending')fail('REQUEST_EXPIRED','That message can no longer be used. Call the prepare tool again for a new one.',409);
  // the key that must have signed: the person's own wallet, read now, never the agent's word
  if(a.wallet!==wallet)fail('SIGNATURE_INVALID','The request is not for the person\'s current wallet. Call the prepare tool again.',409);
  tradeOnly(a.payload,ledgerAccount);
  const sig=signatureBytes(signature);
  try{rawEd25519Payload(a.payload,wallet,sig)}
  catch{fail('SIGNATURE_INVALID','The signature does not verify over the exact message bytes with the person\'s own wallet key. Have the person\'s Privy Solana wallet sign message (UTF-8 bytes, no prefix).',400)}
  // single use: the first submission claims the request id; a replay, concurrent or later, is refused
  if(db.prepare('INSERT OR IGNORE INTO agent_owner_request(request_id,trade_id,owner,client_id,created_at) VALUES(?,?,?,?,?)').run(id,tradeId,owner,clientId,now()).changes!==1)
   fail('REQUEST_USED','This request was already signed and submitted. Check the trade with the status tool; for a new trade, quote again.',409);
  const legIdx=db.prepare('SELECT MIN(idx) AS i FROM trade_legs WHERE trade_id=?').get(tradeId)?.i??0;
  let s;
  try{s=await engine.submit(ownerCtx(owner,clientId),{trade_id:tradeId,leg:legIdx,attempt_id:attemptId,signed:Buffer.from(sig).toString('base64')})}
  catch(e){
   // nothing was accepted (the attempt still waits): the claim is given back, so a corrected submission can go through
   if(route.attempt(attemptId)?.status==='pending')db.prepare('DELETE FROM agent_owner_request WHERE request_id=?').run(id);
   throw e;
  }
  event({event:'agent_owner_submitted',trade:tradeId,owner,state:s?.status??null});
  const st=await ownerStatus(owner,clientId,{trade_id:tradeId}).catch(()=>null);
  return {account:'owner',request_id:id,kind:'trade',trade_id:tradeId,status:st?.status??s?.status??'pending',...(st?{trade:st}:{}),...(s?.sign_requests?.length?{renewed:true}:{})};
 }
 async function ownerStatus(owner,clientId,{trade_id}){
  await requireOwner(owner);
  const v=engine.status(ownerCtx(owner,clientId),trade_id);
  return {account:'owner',trade_id,status:v.status,direction:v.direction,received:v.received??[],legs:(v.legs??[]).map(l=>({symbol:l.symbol,status:l.status,amount_in:l.amount_in,amount_out:l.amount_out,tx:l.origin_tx??null})),updated_at:v.updated_at};
 }
 async function ownerBalance(owner){
  const {ledgerAccount}=await requireOwner(owner);
  return {account:'owner',ledger_account:ledgerAccount,...(await balanceOf({ledger_account:ledgerAccount})).view};
 }
 async function ownerPositions(owner,clientId){
  const {ledgerAccount}=await requireOwner(owner);
  const ctx=ownerCtx(owner,clientId);
  const [bal,pf]=await Promise.all([balanceOf({ledger_account:ledgerAccount}),engine.portfolio(ctx).catch(()=>null)]);
  const recent=db.prepare('SELECT id FROM trades WHERE account_id=? ORDER BY created_at DESC LIMIT 5').all(owner);
  const trades=[];for(const r of recent){try{trades.push({...(await ownerStatus(owner,clientId,{trade_id:r.id})),via_agent:!!db.prepare('SELECT 1 FROM agent_owner_trade WHERE trade_id=? AND owner=? AND client_id=?').get(r.id,owner,clientId)})}catch{}}
  return {account:'owner',ledger_account:ledgerAccount,usdc:bal.view.usdc,holdings:pf?.solana?.holdings?.filter(h=>h.symbol!=='USDC')??bal.view.coins.map(c=>({...c,usd:null})),total_usd:pf?.total_usd??null,recent_trades:trades,limits:ownerLimitsView(owner,clientId)};
 }

 // ---- the signing page (as/sign-page.mjs): the owner approves a budget link ----
 async function pageRequests(owner,opId){
  let op=opRow(opId);
  const a=op&&db.prepare('SELECT * FROM agent_key WHERE account_id=?').get(op.account_id);
  if(!op||!a||a.owner!==owner||op.kind!=='fund')throw new TradeError('INVALID_ARGUMENT','unknown agent budget link');
  op=await followUp(op);
  const open=await openMessage(op);op=open??opRow(opId);
  const sent=op.state==='settled'||op.state==='sending';
  return {trade_id:op.op_id,direction:'fund',status:sent?'success':op.state==='awaiting_signature'?'awaiting_signature':'not_sent',
   legs:[{leg:0,symbol:'USDC',send_status:sent?'sent':op.state==='awaiting_signature'?'awaiting_signature':'not_sent'}],sign_requests:open?[requestOf(open)]:[]};
 }
 async function pageSubmit(owner,opId,{attempt_id,signed}){
  const op=opRow(opId),a=op&&db.prepare('SELECT * FROM agent_key WHERE account_id=?').get(op.account_id);
  if(!op||!a||a.owner!==owner||op.kind!=='fund')throw new TradeError('INVALID_ARGUMENT','unknown agent budget link');
  try{await submitOp(op,{attemptId:attempt_id,signature:signed})}
  catch(e){if(e instanceof AgentError)throw Object.assign(new TradeError(e.code,e.message),{userMessage:e.message});throw e}
  const r=await pageRequests(owner,opId);
  return {trade_id:r.trade_id,status:r.status,legs:r.legs,sign_requests:r.sign_requests};
 }

 // The tools take `account` ('agent' by default: the route exactly as before; 'owner': the person's own account).
 const by=(agentFn,ownerFn)=>async(owner,clientId,args={})=>{const {account,...rest}=args??{};return modeOf(account)==='owner'?ownerFn(owner,clientId,rest):agentFn(owner,clientId,rest)};
 const tradesOnly=async()=>fail('OWNER_TRADES_ONLY','Only trades are possible on the person\'s own account through this route: nothing can be sent from it to another account.',403);
 const isOwnerTrade=tradeId=>ownerAccount&&!!db.prepare('SELECT 1 FROM agent_owner_trade WHERE trade_id=?').get(String(tradeId??''));
 async function overviewAll(owner,clientId){
  const o=await overview(owner,clientId);
  if(!ownerAccount)return o;
  let onLedger=false,ledgerAccount=null;
  try{const w=await requireOwner(owner);onLedger=true;ledgerAccount=w.ledgerAccount}catch{}
  return {...o,owner_account:{available:onLedger,ledger_account:ledgerAccount,limits:ownerLimitsView(owner,clientId),
   how:'Pass account "owner" to the quote, prepare, submit, status, balance and positions tools to trade the person\'s own YEET account; the person\'s Privy Solana wallet signs each message.'}};
 }
 return {overview:overviewAll,register,
  balance:by(balance,ownerBalance),quote:by(quote,ownerQuote),prepare:by(prepare,ownerPrepare),submit:by(submit,ownerSubmit),status:by(status,ownerStatus),positions:by(positions,ownerPositions),
  returnBudget:by(returnBudget,tradesOnly),isOwnerTrade,ownerAccount:!!ownerAccount,
  pageRequests,pageSubmit,limits,coins:()=>coins.map(c=>c.symbol)};
}

/** base64 (or hex) of a 64-byte ed25519 signature. */
function signatureBytes(value){
 const v=typeof value==='string'?value.trim():'';
 let b=null;
 if(/^[0-9a-f]{128}$/i.test(v))b=Buffer.from(v,'hex');
 else if(/^[A-Za-z0-9+/]{86}==$/.test(v))b=Buffer.from(v,'base64');
 if(!b||b.length!==64)fail('SIGNATURE_INVALID','signature is the 64-byte ed25519 signature, base64 (88 characters) or hex (128 characters).',400);
 return b;
}

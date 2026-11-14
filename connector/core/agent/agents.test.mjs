// The agent route, core side (core/agent/agents.mjs, connector/docs/AGENT-ROUTE.md) on the real pipeline and ledger route,
// against the in-memory ledger and 1Click of the ledger tests (ledger-route/fakes.mjs). The agent's key is generated
// here, as an agent generates it on its own machine; the server never sees a private key.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTradeDb} from '../trade/db.mjs';
import {fakeBalances,fakeClock,BASE_WALLET} from '../trade/fakes.mjs';
import {createPipeline} from '../pipeline/pipeline.mjs';
import {staticWalletDirectory} from '../pipeline/wallet-directory.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {fakeSolanaRpc,fakeFeePayer} from '../pipeline/fakes.mjs';
import {checkIntent,privyRpcBodies} from '../pipeline/wallet-request.mjs';
import {fakeLedger,fakeLedgerOneClick,solverKey,approve,accountOf,LEDGER_ENV,ALICE,BOB,aliceWallet,bobWallet,WIF,USDC} from '../ledger-route/fakes.mjs';
import {agentAccounts,createAgents,agentLimitsFromEnv,parseAgentKey,agentAccountId,AgentError} from './agents.mjs';
import {ed25519AccountId} from '../intents/sign.mjs';

const CLIENT='agent-client-1';
function setup({env={},ownerUsdc=30_000_000n,float=30_000_000n}={}){
 const now=fakeClock(),world=fakeLedger({now}),oneclick=fakeLedgerOneClick({world,now}),near=solverKey(),db=openTradeDb(':memory:'),logs=[];
 world.credit(accountOf(aliceWallet),USDC,ownerUsdc);world.credit(near.accountId,USDC,float);
 const fullEnv={...LEDGER_ENV,YEET_SOLVER_ACCOUNT:near.accountId,YEET_MIN_LEG_USDC:'1',...env};
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:BASE_WALLET},solana:{address:aliceWallet.address}},[BOB.accountId]:{base:{address:'0x27602fd697f91d31fe551b26a3b12b113789477e'},solana:{address:bobWallet.address}}});
 const accounts=agentAccounts(db),rpc=fakeSolanaRpc();
 const p=createPipeline({db,env:fullEnv,client:oneclick,directory,balances:fakeBalances({usdc:'0',holdings:[]}),now,trackerIntervalMs:0,landingWatchMs:0,log:l=>logs.push(JSON.parse(l)),xpOf:()=>0,agents:accounts,
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer:fakeFeePayer()},
  ledgerOverrides:{rpc:world.rpc,verifier:world.verifier,near,pollMs:0,unloadWaitMs:30_000,sleep:async ms=>{now.advance(Math.max(ms,500))}}});
 const agents=createAgents({db,engine:p,limits:agentLimitsFromEnv(fullEnv),pageUrl:id=>`https://as.test/sign?trade_id=${id}`,now,log:e=>logs.push(e)});
 const key=localSigner();
 return {p,db,now,world,near,agents,key,logs,agentLedger:ed25519AccountId(key.address)};
}
const sign=(key,message)=>Buffer.from(key.signMessage(Buffer.from(message,'utf8'))).toString('base64');
const refused=(code,re)=>e=>{assert.ok(e instanceof AgentError,`${e?.name} ${e?.code} ${e?.message}`);assert.equal(e.code,code,e.message);if(re)assert.match(e.message,re);return true};
const opOf=url=>new URL(url).searchParams.get('trade_id');
/** register -> the page's request -> the owner's wallet signs it on the page -> settled. */
async function link(t,{budget='10'}={}){
 const r=await t.agents.register(ALICE.accountId,CLIENT,{public_key:`ed25519:${t.key.address}`,budget_usdc:budget});
 const op=opOf(r.budget_url),page=await t.agents.pageRequests(ALICE.accountId,op),req=page.sign_requests[0];
 const out=await t.agents.pageSubmit(ALICE.accountId,op,{attempt_id:req.attempt_id,signed:approve(aliceWallet,req)});
 return {r,op,req,out};
}

test('keys: ed25519 public keys in three spellings, anything else refused with a sentence',()=>{
 const k=localSigner();
 assert.equal(parseAgentKey(`ed25519:${k.address}`),k.address);
 assert.equal(parseAgentKey(k.address),k.address);
 assert.equal(parseAgentKey(ed25519AccountId(k.address)),k.address);
 for(const bad of ['', 'ed25519:xyz', '0x'+'ab'.repeat(32), 'ab'.repeat(31), 42])assert.throws(()=>parseAgentKey(bad),refused('AGENT_KEY_INVALID',/ed25519 public key/));
 assert.match(agentAccountId(k.address),/^yeet-agent-[0-9a-f]{40}$/);
 assert.throws(()=>agentLimitsFromEnv({YEET_AGENT_MAX_TRADE_USDC:'20',YEET_AGENT_MAX_DAY_USDC:'10'}),/below/);
 assert.deepEqual(agentLimitsFromEnv({}),{maxTradeRaw:10_000_000n,maxDayRaw:50_000_000n,maxBudgetRaw:100_000_000n});
});

test('the pipeline refuses agents without the ledger route; with it, an agent account trades on the ledger whatever YEET_ROUTE says',()=>{
 const db=openTradeDb(':memory:');
 assert.throws(()=>createPipeline({db,env:{YEET_LIVE:'1'},agents:agentAccounts(db),trackerIntervalMs:0}),/needs the ledger route/);
 const t=setup({env:{YEET_ROUTE:'chain',YEET_LEDGER_ACCOUNTS:BOB.accountId}});
 assert.equal(t.p.ledgerRoute.handles(ALICE.accountId),false,'the owner stays on the chain route');
 t.db.prepare("INSERT INTO agent_key(account_id,owner,client_id,public_key,ledger_account,state,created_at,updated_at) VALUES(?,?,?,?,?,'active',0,0)").run(agentAccountId(t.key.address),ALICE.accountId,CLIENT,t.key.address,t.agentLedger);
 assert.equal(t.p.ledgerRoute.handles(agentAccountId(t.key.address)),true);
});

test('register: the budget link, the page request the owner signs (checked like every ledger request), the budget arrives, the agent is active',async()=>{
 const t=setup();
 const before=await t.agents.overview(ALICE.accountId,CLIENT);
 assert.equal(before.state,'not_registered');assert.match(before.next,/ed25519 key/);
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3'}),refused('AGENT_NOT_REGISTERED'));
 await assert.rejects(t.agents.register(ALICE.accountId,CLIENT,{public_key:`ed25519:${aliceWallet.address}`,budget_usdc:'5'}),refused('AGENT_KEY_INVALID',/never the key of a YEET wallet/));
 await assert.rejects(t.agents.register(ALICE.accountId,CLIENT,{public_key:t.key.address,budget_usdc:'101'}),refused('LIMIT_EXCEEDED',/at most 100 USDC/));
 const r=await t.agents.register(ALICE.accountId,CLIENT,{public_key:t.key.address,budget_usdc:'10'});
 assert.equal(r.state,'awaiting_budget');assert.equal(r.agent_account,t.agentLedger);assert.match(r.budget_url,/^https:\/\/as\.test\/sign\?trade_id=a_[a-z0-9]{20}$/);
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3'}),refused('AGENT_NOT_FUNDED',/approve the budget/));
 const op=opOf(r.budget_url);
 // only the owner's page session sees it
 await assert.rejects(t.agents.pageRequests(BOB.accountId,op),e=>e.code==='INVALID_ARGUMENT');
 const page=await t.agents.pageRequests(ALICE.accountId,op),req=page.sign_requests[0];
 assert.equal(page.direction,'fund');assert.equal(req.kind,'near_intent');assert.equal(req.wallet,aliceWallet.address);
 const m=JSON.parse(req.payload.message);
 assert.equal(m.signer_id,accountOf(aliceWallet));
 assert.deepEqual(m.intents,[{intent:'transfer',receiver_id:t.agentLedger,tokens:{[USDC]:'10000000'}}]);
 assert.equal(checkIntent(req),true);
 // the page's own check refuses a request whose message and statement differ
 assert.throws(()=>checkIntent({...req,payload:{...req.payload,transfer:{receiver_id:t.agentLedger,tokens:{[USDC]:'1'}}}}),/not the stated transfer/);
 assert.throws(()=>checkIntent({...req,leg_summaries:[{...req.leg_summaries[0],to:accountOf(bobWallet)}]}),/leg summaries/);
 assert.equal(privyRpcBodies(req).length,1);
 // a signature from another key is refused and nothing moves
 await assert.rejects(t.agents.pageSubmit(ALICE.accountId,op,{attempt_id:req.attempt_id,signed:approve(bobWallet,req)}),e=>e.code==='SIGNATURE_INVALID'&&/does not verify/.test(e.userMessage));
 const out=await t.agents.pageSubmit(ALICE.accountId,op,{attempt_id:req.attempt_id,signed:approve(aliceWallet,req)});
 assert.equal(out.status,'success');assert.deepEqual(out.legs,[{leg:0,symbol:'USDC',send_status:'sent'}]);
 assert.equal(t.world.balance(t.agentLedger,USDC),10_000_000n);assert.equal(t.world.balance(accountOf(aliceWallet),USDC),20_000_000n);
 const o=await t.agents.overview(ALICE.accountId,CLIENT);
 assert.equal(o.state,'active');assert.equal(o.balance.usdc,'10');assert.equal(o.limits.max_trade_usdc,'10');
 // the same link again: nothing left to sign
 assert.deepEqual((await t.agents.pageRequests(ALICE.accountId,op)).sign_requests,[]);
 // another connection may not take the key
 await assert.rejects(t.agents.register(ALICE.accountId,'other-client',{public_key:t.key.address,budget_usdc:'5'}),refused('AGENT_KEY_TAKEN'));
});

test('trade: quote, prepare (the unsigned token_diff), the agent signs locally, submit, settled into the agent account only',async()=>{
 const t=setup();
 await link(t);
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['NOPE'],amount_usdc:'3'}),refused('COIN_NOT_SUPPORTED',/Listed coins: /));
 const q=await t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3'});
 assert.match(q.quote_id,/^p_/);assert.equal(q.legs[0].symbol,'WIF');assert.equal(Object.hasOwn(q,'confirm'),false,'the confirm code never leaves the server');
 const x=await t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:q.quote_id});
 const m=JSON.parse(x.request.message);
 assert.equal(x.request.standard,'raw_ed25519');assert.equal(m.signer_id,t.agentLedger);assert.equal(x.request.public_key,`ed25519:${t.key.address}`);
 assert.equal(m.intents[0].intent,'token_diff');assert.equal(m.intents[0].diff[USDC],'-3000000');assert.ok(BigInt(m.intents[0].diff[WIF])>0n);
 // a wrong signature: refused, nothing moves
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(localSigner(),x.request.message)}),e=>e.code==='INVALID_ARGUMENT');
 const s=await t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(t.key,x.request.message)});
 assert.equal(s.kind,'trade');
 await t.p.ledgerRoute.idle();
 const st=await t.agents.status(ALICE.accountId,CLIENT,{trade_id:x.trade_id});
 assert.equal(st.status,'success');
 assert.equal(t.world.balance(t.agentLedger,USDC),7_000_000n);assert.ok(t.world.balance(t.agentLedger,WIF)>0n);
 assert.equal(t.world.balance(accountOf(aliceWallet),WIF),0n,'the owner account is untouched by the agent trade');
 const pos=await t.agents.positions(ALICE.accountId,CLIENT);
 assert.equal(pos.usdc,'7');assert.equal(pos.holdings[0].symbol,'WIF');assert.equal(pos.recent_trades[0].trade_id,x.trade_id);assert.equal(pos.limits.spent_today_usdc,'3');
 // the owner's own trades never show the agent's
 await assert.rejects(async()=>t.p.status(ALICE,x.trade_id),e=>e.code==='INVALID_ARGUMENT');
});

test('limits: per trade and per UTC day, from env, checked again at prepare',async()=>{
 const t=setup({env:{YEET_AGENT_MAX_TRADE_USDC:'4',YEET_AGENT_MAX_DAY_USDC:'6'}});
 await link(t,{budget:'20'});
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'5'}),refused('LIMIT_EXCEEDED',/at most 4 USDC/));
 const trade=async usdc=>{const q=await t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:usdc});const x=await t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:q.quote_id});
  await t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(t.key,x.request.message)});await t.p.ledgerRoute.idle();return x};
 await trade('4');
 const q=await t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3'});
 await assert.rejects(t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:q.quote_id}),refused('LIMIT_EXCEEDED',/2 USDC more today/));
 await assert.rejects(t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:'p_aaaaaaaaaaaaaaaaaaaa'}),refused('QUOTE_NOT_FOUND'));
 // a sell is not a spend
 const sq=await t.agents.quote(ALICE.accountId,CLIENT,{side:'sell',coins:['WIF'],percent:50});
 const sx=await t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:sq.quote_id});
 assert.equal(JSON.parse(sx.request.message).intents[0].diff[USDC]>'0',true);
});

test('return: the whole USDC balance back to the owner ledger account, signed by the agent; nothing else can be named',async()=>{
 const t=setup();
 await link(t);
 const r=await t.agents.returnBudget(ALICE.accountId,CLIENT);
 const m=JSON.parse(r.message);
 assert.equal(m.signer_id,t.agentLedger);assert.equal(r.receiver_id,accountOf(aliceWallet));
 assert.deepEqual(m.intents,[{intent:'transfer',receiver_id:accountOf(aliceWallet),tokens:{[USDC]:'10000000'}}]);
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:r.request_id,signature:sign(aliceWallet,r.message)}),refused('SIGNATURE_INVALID'));
 const s=await t.agents.submit(ALICE.accountId,CLIENT,{request_id:r.request_id,signature:sign(t.key,r.message)});
 assert.equal(s.status,'settled');
 assert.equal(t.world.balance(t.agentLedger,USDC),0n);assert.equal(t.world.balance(accountOf(aliceWallet),USDC),30_000_000n);
 await assert.rejects(t.agents.returnBudget(ALICE.accountId,CLIENT),refused('NOTHING_TO_RETURN'));
});

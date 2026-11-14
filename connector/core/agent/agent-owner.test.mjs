// Owner account mode of the agent route (core/agent/agents.mjs, YEET_AGENT_OWNER_ACCOUNT, connector/docs/AGENT-ROUTE.md):
// the agent trades the PERSON's own ledger account; the person's wallet signs. On the real pipeline and ledger route,
// against the in-memory ledger and 1Click of the ledger tests. aliceWallet, a key generated locally, stands in for the
// person's Privy Solana wallet: the agent gets its signature from Privy, outside YEET, in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTradeDb} from '../trade/db.mjs';
import {fakeBalances,fakeClock,BASE_WALLET} from '../trade/fakes.mjs';
import {createPipeline} from '../pipeline/pipeline.mjs';
import {staticWalletDirectory} from '../pipeline/wallet-directory.mjs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {fakeSolanaRpc,fakeFeePayer} from '../pipeline/fakes.mjs';
import {fakeLedger,fakeLedgerOneClick,solverKey,approve,accountOf,buy,LEDGER_ENV,ALICE,BOB,aliceWallet,bobWallet,WIF,USDC} from '../ledger-route/fakes.mjs';
import {agentAccounts,createAgents,agentLimitsFromEnv,agentOwnerAccountOn,AgentError} from './agents.mjs';
import {ed25519AccountId} from '../intents/sign.mjs';

const CLIENT='agent-client-1',OTHER='agent-client-2';
function setup({env={},ownerAccount=true,ownerUsdc=30_000_000n,float=30_000_000n}={}){
 const now=fakeClock(),world=fakeLedger({now}),oneclick=fakeLedgerOneClick({world,now}),near=solverKey(),db=openTradeDb(':memory:'),logs=[],settled=[];
 world.credit(accountOf(aliceWallet),USDC,ownerUsdc);world.credit(accountOf(bobWallet),USDC,ownerUsdc);world.credit(near.accountId,USDC,float);
 const fullEnv={...LEDGER_ENV,YEET_SOLVER_ACCOUNT:near.accountId,YEET_MIN_LEG_USDC:'1',...env};
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:BASE_WALLET},solana:{address:aliceWallet.address}},[BOB.accountId]:{base:{address:'0x27602fd697f91d31fe551b26a3b12b113789477e'},solana:{address:bobWallet.address}}});
 const accounts=agentAccounts(db),rpc=fakeSolanaRpc();
 const p=createPipeline({db,env:fullEnv,client:oneclick,directory,balances:fakeBalances({usdc:'0',holdings:[]}),now,trackerIntervalMs:0,landingWatchMs:0,log:l=>logs.push(JSON.parse(l)),xpOf:()=>0,agents:accounts,
  onSettled:e=>settled.push(e),
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer:fakeFeePayer()},
  ledgerOverrides:{rpc:world.rpc,verifier:world.verifier,near,pollMs:0,unloadWaitMs:30_000,sleep:async ms=>{now.advance(Math.max(ms,500))}}});
 const agents=createAgents({db,engine:p,limits:agentLimitsFromEnv(fullEnv),pageUrl:id=>`https://as.test/sign?trade_id=${id}`,now,log:e=>logs.push(e),ownerAccount});
 return {p,db,now,world,near,agents,logs,settled,env:fullEnv};
}
const sign=(key,message)=>Buffer.from(key.signMessage(Buffer.from(message,'utf8'))).toString('base64');
const refused=(code,re)=>e=>{assert.ok(e instanceof AgentError,`${e?.name} ${e?.code} ${e?.message}`);assert.equal(e.code,code,e.message);if(re)assert.match(e.message,re);return true};
const O={account:'owner'};
/** quote -> prepare for the person, through the agent route in owner mode. */
async function prepared(t,{usdc='3',coins=['WIF'],who=ALICE.accountId,client=CLIENT}={}){
 const q=await t.agents.quote(who,client,{side:'buy',coins,amount_usdc:usdc,...O});
 return {q,x:await t.agents.prepare(who,client,{quote_id:q.quote_id,...O})};
}
const tables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_owner%'").all().map(r=>r.name);

test('switch: YEET_AGENT_OWNER_ACCOUNT is off unless exactly on, needs the agent route, and stops the service on anything else',()=>{
 assert.equal(agentOwnerAccountOn({},true),false);
 assert.equal(agentOwnerAccountOn({YEET_AGENT_OWNER_ACCOUNT:'off'},true),false);
 assert.equal(agentOwnerAccountOn({YEET_AGENT_OWNER_ACCOUNT:''},false),false);
 assert.equal(agentOwnerAccountOn({YEET_AGENT_OWNER_ACCOUNT:' ON '},true),true);
 assert.throws(()=>agentOwnerAccountOn({YEET_AGENT_OWNER_ACCOUNT:'on'},false),/needs YEET_AGENT_ROUTE=on/);
 for(const v of ['1','yes','true','owner'])assert.throws(()=>agentOwnerAccountOn({YEET_AGENT_OWNER_ACCOUNT:v},true),/Invalid YEET_AGENT_OWNER_ACCOUNT/);
});

test('switch off: account "owner" is refused with OWNER_ACCOUNT_OFF on every tool; without it (or with "agent") the route is the base route',async()=>{
 const t=setup({ownerAccount:false});
 assert.deepEqual(tables(t.db),[],'no owner tables while off');
 const off=refused('OWNER_ACCOUNT_OFF',/switched off/);
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3',...O}),off);
 await assert.rejects(t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:'p_aaaaaaaaaaaaaaaaaaaa',...O}),off);
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:'t_aaaaaaaaaaaaaaaaaaaa.'+'0'.repeat(64),signature:'x',...O}),off);
 await assert.rejects(t.agents.status(ALICE.accountId,CLIENT,{trade_id:'t_aaaaaaaaaaaaaaaaaaaa',...O}),off);
 await assert.rejects(t.agents.balance(ALICE.accountId,CLIENT,O),off);
 await assert.rejects(t.agents.positions(ALICE.accountId,CLIENT,O),off);
 await assert.rejects(t.agents.returnBudget(ALICE.accountId,CLIENT,O),off);
 try{await t.agents.balance(ALICE.accountId,CLIENT,O)}catch(e){assert.equal(e.status,403)}
 // the base answers, unchanged: overview without owner_account, agent-mode refusals as before
 const o=await t.agents.overview(ALICE.accountId,CLIENT);
 assert.deepEqual(Object.keys(o).sort(),['limits','next','registered','route','state']);
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3'}),refused('AGENT_NOT_REGISTERED'));
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3',account:'agent'}),refused('AGENT_NOT_REGISTERED'));
 await assert.rejects(t.agents.balance(ALICE.accountId,CLIENT),refused('AGENT_NOT_REGISTERED'));
 assert.equal(t.agents.isOwnerTrade('t_aaaaaaaaaaaaaaaaaaaa'),false);
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),30_000_000n,'nothing moved');
});

test('owner mode, happy path: quote, prepare (token_diff for the person\'s own ledger account), the person\'s wallet signs, submit, settled as the person\'s own trade',async()=>{
 const t=setup();
 const o=await t.agents.overview(ALICE.accountId,CLIENT);
 assert.equal(o.state,'not_registered','no agent key is needed');assert.equal(o.owner_account.available,true);assert.equal(o.owner_account.ledger_account,accountOf(aliceWallet));
 const {q,x}=await prepared(t);
 assert.equal(q.account,'owner');assert.match(q.quote_id,/^p_/);assert.equal(Object.hasOwn(q,'confirm'),false,'the confirm code never leaves the server');
 const m=JSON.parse(x.request.message);
 assert.equal(x.account,'owner');assert.equal(x.request.standard,'raw_ed25519');
 assert.equal(m.signer_id,accountOf(aliceWallet));assert.equal(x.request.public_key,`ed25519:${aliceWallet.address}`);
 assert.deepEqual(m.intents.map(i=>i.intent),['token_diff']);assert.equal(m.intents[0].diff[USDC],'-3000000');assert.ok(BigInt(m.intents[0].diff[WIF])>0n);
 assert.match(x.request.how,/Privy Solana wallet/);
 // the trade is the person's own: the pipeline's trade row and proposal under the person's account
 assert.equal(t.db.prepare('SELECT account_id FROM trades WHERE id=?').get(x.trade_id).account_id,ALICE.accountId);
 const s=await t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),...O});
 assert.equal(s.account,'owner');assert.equal(s.kind,'trade');assert.equal(s.trade_id,x.trade_id);
 await t.p.ledgerRoute.idle();
 const st=await t.agents.status(ALICE.accountId,CLIENT,{trade_id:x.trade_id,...O});
 assert.equal(st.status,'success');
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),27_000_000n);assert.ok(t.world.balance(accountOf(aliceWallet),WIF)>0n);
 // the settle event carries the person's account id (core.mjs pays XP and the wheel for every non-agent account)
 assert.ok(t.settled.some(e=>e.tradeId===x.trade_id&&e.accountId===ALICE.accountId&&e.direction==='yeet'));
 // the ChatGPT route's view of the same account sees the trade and the coins (one wallet, one portfolio)
 assert.equal(t.p.status(ALICE,x.trade_id).status,'success');
 assert.ok((await t.p.portfolio(ALICE)).solana.holdings.some(h=>h.symbol==='WIF'));
 const bal=await t.agents.balance(ALICE.accountId,CLIENT,O);
 assert.equal(bal.account,'owner');assert.equal(bal.ledger_account,accountOf(aliceWallet));assert.equal(bal.usdc,'27');assert.equal(bal.coins[0].symbol,'WIF');
 const pos=await t.agents.positions(ALICE.accountId,CLIENT,O);
 assert.equal(pos.usdc,'27');assert.equal(pos.holdings[0].symbol,'WIF');assert.equal(pos.recent_trades[0].trade_id,x.trade_id);assert.equal(pos.recent_trades[0].via_agent,true);
 assert.equal(pos.limits.spent_today_usdc,'3');
 assert.equal(t.agents.isOwnerTrade(x.trade_id),true);
 // a sell back, the same way
 const sq=await t.agents.quote(ALICE.accountId,CLIENT,{side:'sell',coins:['WIF'],percent:100,...O});
 const sx=await t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:sq.quote_id,...O});
 assert.ok(BigInt(JSON.parse(sx.request.message).intents[0].diff[USDC])>0n);
 await t.agents.submit(ALICE.accountId,CLIENT,{request_id:sx.request.request_id,signature:sign(aliceWallet,sx.request.message),...O});
 await t.p.ledgerRoute.idle();
 assert.equal((await t.agents.status(ALICE.accountId,CLIENT,{trade_id:sx.trade_id,...O})).status,'success');
 assert.equal(t.world.balance(accountOf(aliceWallet),WIF),0n);
});

test('owner mode: the signature verifies against the token subject\'s own wallet key only',async()=>{
 const t=setup();
 const {x}=await prepared(t);
 const agentKey=localSigner();
 for(const key of [bobWallet,agentKey,localSigner()])
  await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(key,x.request.message),...O}),refused('SIGNATURE_INVALID',/person's own wallet key/));
 // a signature over other bytes, by the right key
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message+' '),...O}),refused('SIGNATURE_INVALID'));
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:'not-a-signature',...O}),refused('SIGNATURE_INVALID'));
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),30_000_000n,'nothing moved');
 // the failures did not use the request up: the person's own signature still goes through once
 await t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),...O});
 await t.p.ledgerRoute.idle();
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),27_000_000n);
});

test('owner mode: an agent token never reaches another account, another connection, the ChatGPT route\'s trades or its confirm codes',async()=>{
 const t=setup();
 const {q,x}=await prepared(t);
 const sig=sign(aliceWallet,x.request.message);
 // another person's agent: the quote, the request and the trade are unknown to it (its subject is Bob)
 await assert.rejects(t.agents.prepare(BOB.accountId,CLIENT,{quote_id:q.quote_id,...O}),refused('QUOTE_NOT_FOUND'));
 await assert.rejects(t.agents.submit(BOB.accountId,CLIENT,{request_id:x.request.request_id,signature:sig,...O}),refused('INVALID_ARGUMENT'));
 await assert.rejects(t.agents.status(BOB.accountId,CLIENT,{trade_id:x.trade_id,...O}),e=>e.code==='INVALID_ARGUMENT');
 // another agent connection of the same person
 await assert.rejects(t.agents.prepare(ALICE.accountId,OTHER,{quote_id:q.quote_id,...O}),refused('QUOTE_NOT_FOUND'));
 await assert.rejects(t.agents.submit(ALICE.accountId,OTHER,{request_id:x.request.request_id,signature:sig,...O}),refused('INVALID_ARGUMENT'));
 // the same connection in agent mode: not its own key's trade
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sig}),refused('AGENT_NOT_REGISTERED'));
 // a caller cannot name the account: unknown selectors are refused, extra fields are ignored (the subject decides)
 for(const account of ['yeet-privy-bob',accountOf(bobWallet),'OWNER',1,{}])
  await assert.rejects(t.agents.balance(ALICE.accountId,CLIENT,{account}),refused('INVALID_ARGUMENT',/"owner".*"agent"/));
 const b=await t.agents.balance(ALICE.accountId,CLIENT,{...O,account_id:BOB.accountId,ledger_account:accountOf(bobWallet)});
 assert.equal(b.ledger_account,accountOf(aliceWallet));
 // the confirm code is bound to the agent route's class: the ChatGPT route cannot execute the agent's quote
 const confirm=t.db.prepare('SELECT confirm FROM agent_owner_quote WHERE proposal_id=?').get(q.quote_id).confirm;
 await assert.rejects(t.p.execute(ALICE,{proposal_id:q.quote_id,revision:q.revision,confirm}),e=>e.name==='TradeError');
 // and the ChatGPT route's own trades are unknown to the agent route
 const card=await buy(t,{usdc:'2',coins:['WIF'],id:'card-1'});
 const cr=card.x.sign_requests[0];
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:`${cr.trade_id}.${cr.attempt_id}`,signature:sign(aliceWallet,cr.payload.message),...O}),refused('INVALID_ARGUMENT'));
 assert.equal(t.agents.isOwnerTrade(cr.trade_id),false,'core.mjs keeps the ChatGPT signature route for the card trade');
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),30_000_000n,'nothing moved');assert.equal(t.world.balance(accountOf(bobWallet),USDC),30_000_000n);
});

test('owner mode: request ids are single use; a replay, later or concurrent, is refused and nothing moves twice',async()=>{
 const t=setup();
 const {x}=await prepared(t);
 const body={request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),...O};
 const [a,b]=await Promise.allSettled([t.agents.submit(ALICE.accountId,CLIENT,body),t.agents.submit(ALICE.accountId,CLIENT,body)]);
 assert.deepEqual([a.status,b.status].sort(),['fulfilled','rejected']);
 const r=[a,b].find(x=>x.status==='rejected').reason;assert.ok(refused('REQUEST_USED')(r));
 await t.p.ledgerRoute.idle();
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,body),refused('REQUEST_USED'));
 assert.equal((await t.agents.status(ALICE.accountId,CLIENT,{trade_id:x.trade_id,...O})).status,'success');
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),27_000_000n,'settled once');
 // prepare on the same quote again replays the same trade: there is no new message to sign
 const again=await t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:t.db.prepare('SELECT proposal_id FROM agent_owner_trade WHERE trade_id=?').get(x.trade_id).proposal_id,...O});
 assert.equal(again.trade_id,x.trade_id);assert.equal(again.request,null);
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),27_000_000n);
});

test('owner mode: trades only; no transfer, withdrawal or return can be built or relayed for the person\'s account',async()=>{
 const t=setup();
 await assert.rejects(t.agents.returnBudget(ALICE.accountId,CLIENT,O),refused('OWNER_TRADES_ONLY'));
 await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:'a_aaaaaaaaaaaaaaaaaaaa.1',signature:'x',...O}),refused('OWNER_TRADES_ONLY'));
 // a ledger request that is not exactly one token_diff of the person's account is never accepted, even signed by the person
 const {x}=await prepared(t);
 const attemptId=x.request.request_id.split('.')[1],orig=t.db.prepare('SELECT payload FROM ledger_attempt WHERE attempt_id=?').get(attemptId).payload,m=JSON.parse(orig);
 for(const intents of [[{intent:'transfer',receiver_id:accountOf(bobWallet),tokens:{[USDC]:'30000000'}}],[{intent:'ft_withdraw',token:'usdc',receiver_id:'bob.near',amount:'30000000'}],[m.intents[0],{intent:'transfer',receiver_id:accountOf(bobWallet),tokens:{[USDC]:'1'}}]]){
  const evil=JSON.stringify({...m,intents});
  t.db.prepare('UPDATE ledger_attempt SET payload=? WHERE attempt_id=?').run(evil,attemptId);
  await assert.rejects(t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(aliceWallet,evil),...O}),refused('OWNER_TRADES_ONLY'));
 }
 t.db.prepare('UPDATE ledger_attempt SET payload=? WHERE attempt_id=?').run(orig,attemptId);
 assert.equal(t.world.balance(accountOf(aliceWallet),USDC),30_000_000n);assert.equal(t.world.balance(accountOf(bobWallet),USDC),30_000_000n,'nothing reached another account');
});

test('owner mode: the agent caps per trade and per day on top of the person\'s own gate (kill switch, YEET_LIVE_ACCOUNTS)',async()=>{
 const t=setup({env:{YEET_AGENT_MAX_TRADE_USDC:'4',YEET_AGENT_MAX_DAY_USDC:'6'}});
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'5',...O}),refused('LIMIT_EXCEEDED',/at most 4 USDC/));
 const {x}=await prepared(t,{usdc:'4'});
 await t.agents.submit(ALICE.accountId,CLIENT,{request_id:x.request.request_id,signature:sign(aliceWallet,x.request.message),...O});await t.p.ledgerRoute.idle();
 const q=await t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3',...O});
 await assert.rejects(t.agents.prepare(ALICE.accountId,CLIENT,{quote_id:q.quote_id,...O}),refused('LIMIT_EXCEEDED',/2 USDC more today/));
 // another connection has its own day; the person's card trades do not count against the agent
 const other=await prepared(t,{usdc:'3',client:OTHER});assert.ok(other.x.request);
 // the person's own gate: the kill switch and YEET_LIVE_ACCOUNTS stop owner-mode trades as they stop card trades
 const paused=async()=>{const q=await t.agents.quote(ALICE.accountId,OTHER,{side:'buy',coins:['WIF'],amount_usdc:'1',...O});
  await assert.rejects(t.agents.prepare(ALICE.accountId,OTHER,{quote_id:q.quote_id,...O}),e=>e.code==='TRADING_PAUSED')};
 t.env.YEET_KILL_SWITCH='1';await paused();
 delete t.env.YEET_KILL_SWITCH;t.env.YEET_LIVE_ACCOUNTS=BOB.accountId;await paused();
 delete t.env.YEET_LIVE_ACCOUNTS;
 // listed coins only, as in agent mode
 await assert.rejects(t.agents.quote(BOB.accountId,CLIENT,{side:'buy',coins:['NOPE'],amount_usdc:'1',...O}),refused('COIN_NOT_SUPPORTED'));
});

test('owner mode: refused for a person whose account is not on the ledger route',async()=>{
 const t=setup({env:{YEET_ROUTE:'chain',YEET_LEDGER_ACCOUNTS:BOB.accountId}});
 await assert.rejects(t.agents.quote(ALICE.accountId,CLIENT,{side:'buy',coins:['WIF'],amount_usdc:'3',...O}),refused('OWNER_NOT_ON_LEDGER'));
 await assert.rejects(t.agents.balance(ALICE.accountId,CLIENT,O),refused('OWNER_NOT_ON_LEDGER'));
 assert.equal((await t.agents.overview(ALICE.accountId,CLIENT)).owner_account.available,false);
 const {x}=await prepared(t,{who:BOB.accountId});
 assert.equal(JSON.parse(x.request.message).signer_id,accountOf(bobWallet));
});

// The ledger route (docs/LEDGER-ROUTE.md) on the real pipeline: the route switch, the one message of a basket (golden
// numbers from the spike's real trades), the driver against an in-memory ledger that verifies every signature and
// applies the contract's fee and zero-sum rule, failure and recovery, the limits, the balance source and the solver's
// bounds. Nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {routeFromEnv,ledgerConfig,onLedger} from './config.mjs';
import {previewClient,diffOf,explorerUrl,ledgerAccountOf,KIND} from './route.mjs';
import {ledgerCheck} from './check.mjs';
import {ledgerPipeline,buy,sell,approve,approveAndSettle,accountOf,solverKey,fakeLedger,fakeLedgerOneClick,ALICE,BOB,aliceWallet,bobWallet,WIF,BOME,TRUMP,USDC,RATES} from './fakes.mjs';
import {fakePipeline} from '../pipeline/fakes.mjs';
import {fakeClock} from '../trade/fakes.mjs';
import {checkIntent,privyRpcBody,privyRpcBodies,signedFromWallet,reactSdkArgs} from '../pipeline/wallet-request.mjs';
import {spentToday} from '../trade/limits.mjs';
import {verifyMultiPayload} from '../intents/sign.mjs';
import {parseNonce} from '../intents/nonce.mjs';
import {cutSignRequests} from '../../mcp/tool-registration.mjs';
import {toolSchemas} from '../../mcp/tool-contract.mjs';
import {parseArgs as checkArgs} from '../../../ops/ledger-route-check.mjs';

const refused=(code,detail)=>e=>{assert.equal(e?.name,'TradeError');assert.equal(e.code,code,`${e.code}: ${e.detail}`);if(detail)assert.match(String(e.detail),detail);return true};
const user=accountOf(aliceWallet);
const balances=(t,account)=>Object.fromEntries([['USDC',USDC],['WIF',WIF],['BOME',BOME],['TRUMP',TRUMP]].map(([s,id])=>[s,t.world.balance(account,id)]));
const SPIKE={[WIF]:6_678_287n,[BOME]:1_739_046_991n,[TRUMP]:916_018n};
const legStates=(t,id)=>t.db.prepare('SELECT send_status FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id).map(l=>l.send_status);

// ---- the route switch ----
test('YEET_ROUTE: chain is the default and leaves the pipeline without a ledger route; anything else than chain or ledger is refused',async()=>{
 assert.deepEqual(routeFromEnv({}),{route:'chain',accounts:new Set(),enabled:false});
 assert.equal(routeFromEnv({YEET_ROUTE:' Ledger '}).route,'ledger');
 assert.throws(()=>routeFromEnv({YEET_ROUTE:'both'}),/Invalid YEET_ROUTE/);
 assert.throws(()=>routeFromEnv({YEET_LEDGER_ACCOUNTS:'a b'}),/Invalid YEET_LEDGER_ACCOUNTS/);
 assert.deepEqual(ledgerConfig({YEET_SOLVER_ACCOUNT:'x'}),{route:'chain',accounts:new Set(),enabled:false},'chain mode reads no solver setting');
 // the chain pipeline: no route object, a Solana transaction request as before, no ledger table
 const {p,db}=fakePipeline();
 assert.equal(p.ledgerRoute,null);
 const prop=await p.propose(ALICE,{request_id:'r1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});
 const x=await p.execute(ALICE,{proposal_id:prop.proposal_id,revision:prop.revision,confirm:prop.confirm.code});
 assert.equal(x.sign_requests[0].kind,'solana_tx');
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'ledger_%'").get().n,0,'the chain route creates none of the ledger tables');
});

test('the ledger route refuses to start without a complete solver configuration',()=>{
 const ok={YEET_ROUTE:'ledger',YEET_SOLVER_ACCOUNT:'ab'.repeat(32),YEET_SOLVER_KEY_FILE:'/x/key.json',YEET_SOLVER_MAX_TRADE_USDC:'25',YEET_SOLVER_MAX_DAY_USDC:'100'};
 const c=ledgerConfig(ok);
 assert.equal(c.enabled,true);assert.equal(c.maxTradeRaw,25_000_000n);assert.equal(c.maxDayRaw,100_000_000n);assert.equal(c.deadlineS,180);assert.equal(c.unloadMaxTries,3);
 for(const k of ['YEET_SOLVER_ACCOUNT','YEET_SOLVER_KEY_FILE','YEET_SOLVER_MAX_TRADE_USDC','YEET_SOLVER_MAX_DAY_USDC']){const e={...ok};delete e[k];assert.throws(()=>ledgerConfig(e),new RegExp(`needs ${k}`),k)}
 assert.throws(()=>ledgerConfig({...ok,YEET_SOLVER_ACCOUNT:'solver.near'}),/Invalid YEET_SOLVER_ACCOUNT/);
 assert.throws(()=>ledgerConfig({...ok,YEET_SOLVER_MAX_DAY_USDC:'10'}),/below YEET_SOLVER_MAX_TRADE_USDC/);
 assert.throws(()=>ledgerConfig({...ok,YEET_SOLVER_MAX_TRADE_USDC:'0'}),/Invalid YEET_SOLVER_MAX_TRADE_USDC/);
 // the opt-in list alone turns the route on, and so needs the solver too
 assert.throws(()=>ledgerConfig({YEET_LEDGER_ACCOUNTS:'yeet-privy-alice'}),/needs YEET_SOLVER_ACCOUNT/);
 // a pipeline in ledger mode whose key file is missing does not start
 assert.throws(()=>fakePipeline({env:ok}),/YEET_SOLVER_KEY_FILE does not exist/);
 assert.equal(onLedger(c,'anyone'),true);assert.equal(onLedger(ledgerConfig({}),'anyone'),false);
});

test('YEET_LEDGER_ACCOUNTS: one account trades on the ledger while every other account stays on the chain route',async()=>{
 const t=ledgerPipeline({env:{YEET_ROUTE:'chain',YEET_LEDGER_ACCOUNTS:ALICE.accountId},chainHoldings:[{mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',raw:50_000_000n,decimals:6}]});
 assert.equal(t.p.ledgerRoute.handles(ALICE.accountId),true);assert.equal(t.p.ledgerRoute.handles(BOB.accountId),false);
 const a=await buy(t,{usdc:'5',coins:['WIF']});
 assert.equal(a.x.sign_requests[0].kind,KIND);
 assert.equal((await t.p.home(ALICE)).funding.solana_usdc,'20','Alice: her ledger USDC');
 // Bob: the chain route end to end (his wallet's USDC, the chain plan's refusal of this fake 1Click's ledger-shaped
 // deposit account proves the chain checks still run for him)
 assert.equal((await t.p.home(BOB)).funding.solana_usdc,'50','Bob: his wallet USDC');
 // Bob's preview is the chain route's own request (USDC on Base in, delivered to his wallet), which this ledger-only
 // 1Click double has no pair for; Alice's was asked with the ledger on both sides
 await assert.rejects(t.p.propose(BOB,{request_id:'b1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]}),refused('TEMPORARILY_UNAVAILABLE',/pair is not available/));
 const bobReq=t.oneclick.requests.at(-1),aliceReq=t.oneclick.requests[0];
 assert.equal(bobReq.depositType,'ORIGIN_CHAIN');assert.equal(bobReq.recipientType,'DESTINATION_CHAIN');assert.equal(bobReq.recipient,bobWallet.address);assert.match(bobReq.originAsset,/^nep141:base-/);
 assert.equal(aliceReq.depositType,'INTENTS');assert.equal(aliceReq.recipient,t.near.accountId);
 assert.equal(t.p.ledgerRoute.owns(a.x.trade_id),true);
});

// ---- the one message ----
test('golden: the message, the minimums and the amounts received are those of the spike\'s real 3-coin buy (receipts/intents-live/06)',async()=>{
 const t=ledgerPipeline({env:{YEET_MIN_LEG_USDC:'1'},userUsdc:6_000_000n,float:3_500_000n});
 t.oneclick.deliver=SPIKE;
 const {prop,x}=await buy(t,{usdc:'3'});
 // the basket card: the route's own quotes (quoted_out and min_out of the receipt)
 assert.deepEqual(prop.legs.map(l=>[l.symbol,l.est_out,l.min_out]),[['WIF','6.673811','6.607072'],['BOME','1738.5983','1721.212317'],['TRUMP','0.915597','0.906441']]);
 assert.equal(x.status,'awaiting_signature');assert.equal(x.sign_requests.length,1,'one request, one approval, for the whole basket');
 const req=x.sign_requests[0],m=JSON.parse(req.payload.message);
 assert.equal(req.kind,'near_intent');assert.deepEqual(req.legs,[0,1,2]);assert.equal(req.wallet,aliceWallet.address);
 assert.equal(m.signer_id,user);assert.equal(m.verifying_contract,'intents.near');
 // `user_signs_for_at_least` of the receipt: 6607065, 1721210595, 906440; the person gives 3 USDC and nothing else
 assert.deepEqual(m.intents,[{intent:'token_diff',diff:{[BOME]:'1721210595',[USDC]:'-3000000',[WIF]:'6607065',[TRUMP]:'906440'}}]);
 assert.deepEqual(Object.keys(m.intents[0].diff),Object.keys(m.intents[0].diff).slice().sort(),'keys sorted as the contract keeps them');
 assert.equal(req.payload.message_base64,Buffer.from(req.payload.message).toString('base64'));
 assert.deepEqual(diffOf(req.payload),{[USDC]:-3_000_000n,[WIF]:6_607_065n,[BOME]:1_721_210_595n,[TRUMP]:906_440n});
 const nonce=parseNonce(m.nonce);
 assert.equal(nonce.versioned,true);assert.equal(nonce.saltHex,'0a0b0c0d');assert.equal(nonce.deadlineMs,Date.parse(m.deadline),'the nonce ends with the message');
 assert.equal(Date.parse(m.deadline)-t.now(),180_000);assert.equal(Date.parse(req.expires_at),Date.parse(m.deadline)-60_000);
 assert.deepEqual(req.leg_summaries.map(s=>[s.leg,s.side,s.asset,s.amount_raw,s.to]),[[0,'buy','USDC','1000000',user],[1,'buy','USDC','1000000',user],[2,'buy','USDC','1000000',user]]);
 const s=await approveAndSettle(t,x);
 assert.deepEqual(s.legs.map(l=>l.send_status),['signing','signing','signing']);
 // out_user_ledger of intents-jit-buy-20261114.json: WIF 6.678280, BOME 1739.045269, TRUMP 0.916017; the solver is
 // down 0.000003 USDC, the ledger's fee
 assert.deepEqual(balances(t,user),{USDC:3_000_000n,WIF:6_678_280n,BOME:1_739_045_269n,TRUMP:916_017n});
 assert.deepEqual(balances(t,t.near.accountId),{USDC:3_499_997n,WIF:0n,BOME:0n,TRUMP:0n});
 const st=t.p.status(ALICE,x.trade_id);
 assert.equal(st.status,'success');
 assert.deepEqual(st.received,[{symbol:'WIF',amount:'6.67828'},{symbol:'BOME',amount:'1739.045269'},{symbol:'TRUMP',amount:'0.916017'}]);
 assert.equal(t.world.executed.length,2,'two NEAR calls: the sourcing transfer and the settlement');
 // the settlement carried the solver's payload first, then exactly the message the person approved
 const settle=t.world.executed[1].signed;
 assert.equal(settle.length,2);assert.equal(settle[0].standard,'nep413');assert.equal(settle[1].standard,'raw_ed25519');assert.equal(settle[1].payload,req.payload.message);
 assert.equal((await verifyMultiPayload(settle[1])).accountId,user);
});

test('golden: a sell pays the approved minimum at once and passes the surplus on (receipts/intents-live/07: 6.678280 WIF, minimum 0.974976 USDC)',async()=>{
 // 6678273 WIF reaches the solver; the spike's unload quote was 984826 USDC with a minimum of 974977
 const rate=6_678_273n*1_000_000n/984_826n;
 const t=ledgerPipeline({env:{YEET_MIN_LEG_USDC:'0.5'},userUsdc:0n,float:3_500_000n,rates:{...RATES,[WIF]:rate}});
 t.world.credit(user,WIF,6_678_280n);
 const {x}=await sell(t,{coins:['WIF']});
 const req=x.sign_requests[0],m=JSON.parse(req.payload.message);
 assert.deepEqual(m.intents,[{intent:'token_diff',diff:{[USDC]:'974976',[WIF]:'-6678280'}}]);
 assert.deepEqual(req.leg_summaries,[{leg:0,side:'sell',asset:'WIF',amount_raw:'6678280',decimals:6,to:user}]);
 await approveAndSettle(t,x);
 // user_paid_at_once 974976, solver_pays_first 974977, then the unload brings 984826 and the 9849 above goes on
 const j=JSON.parse(t.p.ledgerRoute.row(x.trade_id).json);
 assert.equal(j.solver_pays,'974977');assert.equal(j.unload.state,'done');assert.equal(j.unload.unloaded,'984826');assert.equal(j.unload.surplus,'9849');
 assert.deepEqual(balances(t,user),{USDC:984_825n,WIF:0n,BOME:0n,TRUMP:0n});
 assert.deepEqual(balances(t,t.near.accountId),{USDC:3_500_000n,WIF:0n,BOME:0n,TRUMP:0n},'the solver keeps nothing and loses nothing');
 const st=t.p.status(ALICE,x.trade_id);
 assert.equal(st.status,'success');assert.deepEqual(st.received,[{symbol:'USDC',amount:'0.984825'}]);
 assert.equal(t.p.ledgerRoute.row(x.trade_id).state,'settled');
});

test('the card-side check refuses a message that is not exactly the stated exchange',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 const req=x.sign_requests[0];
 assert.equal(checkIntent(req),true);
 const body=privyRpcBody(req);
 assert.deepEqual(body,{method:'signMessage',chain_type:'solana',params:{message:req.payload.message_base64,encoding:'base64'}});
 assert.deepEqual(Buffer.from(reactSdkArgs(req).message).toString('utf8'),req.payload.message);
 const sig=aliceWallet.signMessage(Buffer.from(req.payload.message));
 assert.equal(signedFromWallet(req,{data:{signature:Buffer.from(sig).toString('base64')}}),signedFromWallet(req,{signature:sig}));
 assert.throws(()=>signedFromWallet(req,{data:{signature:'AAAA'}}),/no 64-byte signature/);
 const withMessage=change=>{const m=JSON.parse(req.payload.message);change(m);const message=JSON.stringify(m);return {...req,payload:{...req.payload,message,message_base64:Buffer.from(message).toString('base64')}}};
 const bad=[
  ['a second intent',withMessage(m=>m.intents.push({intent:'transfer',receiver_id:'thief.near',tokens:{[USDC]:'1'}}))],
  ['a larger amount given',withMessage(m=>{m.intents[0].diff[USDC]='-9000001'})],
  ['one more token given',withMessage(m=>{m.intents[0].diff['nep141:wrap.near']='-1'})],
  ['a lower minimum',withMessage(m=>{m.intents[0].diff[WIF]='1'})],
  ['another account',withMessage(m=>{m.signer_id=accountOf(bobWallet)})],
  ['another contract',withMessage(m=>{m.verifying_contract='intents.fake.near'})],
  ['another wallet',{...req,wallet:bobWallet.address}],
  ['a base64 that is not the message',{...req,payload:{...req.payload,message_base64:Buffer.from('{}').toString('base64')}}],
  ['summaries that state less',{...req,leg_summaries:req.leg_summaries.map(s=>({...s,amount_raw:'1'}))}],
  ['an expiry after the message ends',{...req,expires_at:new Date(Date.parse(req.payload.deadline)+1).toISOString()}],
 ];
 for(const [name,r] of bad)assert.throws(()=>privyRpcBodies(r),e=>e.code==='BATCH_REFUSED',name);
});

// ---- approval ----
test('the approval: only the wallet\'s own signature over the exact message is taken; a second submit changes nothing',async()=>{
 const t=ledgerPipeline();
 const {prop,x}=await buy(t,{usdc:'9'}),code=prop.confirm.code;
 const req=x.sign_requests[0],args={trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id};
 // another key, another message, another account, a transaction-shaped value
 await assert.rejects(t.p.submit(ALICE,{...args,signed:approve(bobWallet,{...req,wallet:bobWallet.address,payload:{...req.payload,signer_id:accountOf(bobWallet)},leg_summaries:req.leg_summaries.map(s=>({...s,to:accountOf(bobWallet)})),
  ...(()=>{const m=JSON.parse(req.payload.message);m.signer_id=accountOf(bobWallet);const message=JSON.stringify(m);return {payload:{...req.payload,signer_id:accountOf(bobWallet),message,message_base64:Buffer.from(message).toString('base64')}}})()})}),refused('INVALID_ARGUMENT',/approval/));
 await assert.rejects(t.p.submit(ALICE,{...args,signed:Buffer.from(aliceWallet.signMessage(Buffer.from('{"other":1}'))).toString('base64')}),refused('INVALID_ARGUMENT',/approval/));
 await assert.rejects(t.p.submit(ALICE,{...args,signed:'unsupported'}),refused('INVALID_ARGUMENT',/approval/));
 await assert.rejects(t.p.submit(BOB,{...args,signed:approve(aliceWallet,req)}),refused('INVALID_ARGUMENT'));
 await assert.rejects(t.p.submit(ALICE,{...args,leg:1,signed:approve(aliceWallet,req)}),refused('INVALID_ARGUMENT'));
 assert.deepEqual(legStates(t,req.trade_id),['awaiting_signature','awaiting_signature','awaiting_signature']);
 assert.equal(t.world.executed.length,0);
 // a dry run checks everything and stores nothing
 const dry=await t.p.submit(ALICE,{...args,signed:approve(aliceWallet,req)},{dryRun:true});
 assert.equal(dry.dry_run.state,'pending');assert.equal(dry.dry_run.simulation.outcome,'READY');assert.equal(t.p.ledgerRoute.row(req.trade_id).state,'awaiting_approval');
 const signed=approve(aliceWallet,req);
 const first=await t.p.submit(ALICE,{...args,signed});
 const again=await t.p.submit(ALICE,{...args,signed});
 assert.equal(first.status,'signing');assert.deepEqual(again.legs.map(l=>l.leg),[0,1,2]);
 await t.p.ledgerRoute.idle();
 assert.equal(t.p.status(ALICE,req.trade_id).status,'success');
 assert.equal(t.world.executed.length,2,'sourced once, settled once');
 // the same code again answers the same trade: nothing left to approve, each coin names the NEAR transaction
 assert.deepEqual((await t.p.signRequests(ALICE,req.trade_id)),[]);
 const replay=await t.p.execute(ALICE,{proposal_id:x.proposal_id,revision:1,confirm:code});
 assert.equal(replay.trade_id,req.trade_id);assert.deepEqual(replay.sign_requests,[]);assert.equal(replay.status,'submitted');
 for(const l of replay.legs){assert.equal(l.status,'sent');assert.match(l.explorer_url,/^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);assert.equal(l.explorer_url,explorerUrl(l.tx_hash))}
 assert.equal(explorerUrl(null),null);
});

test('a request that ran out answers a fresh one (new nonce, new deadline, same minimums); the old approval is not taken',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 const old=x.sign_requests[0];
 t.now.advance(121_000);
 const late=await t.p.submit(ALICE,{trade_id:old.trade_id,leg:old.leg,attempt_id:old.attempt_id,signed:approve(aliceWallet,old)});
 assert.equal(late.sign_requests.length,1);
 const fresh=late.sign_requests[0];
 assert.notEqual(fresh.attempt_id,old.attempt_id);assert.notEqual(JSON.parse(fresh.payload.message).nonce,JSON.parse(old.payload.message).nonce);
 assert.deepEqual(fresh.payload.receives,old.payload.receives);assert.ok(Date.parse(fresh.payload.deadline)>Date.parse(old.payload.deadline));
 assert.equal(t.world.executed.length,0,'nothing was sourced for the late approval');
 const stale=await t.p.submit(ALICE,{trade_id:old.trade_id,leg:old.leg,attempt_id:old.attempt_id,signed:approve(aliceWallet,old)});
 assert.deepEqual(legStates(t,old.trade_id),['awaiting_signature','awaiting_signature','awaiting_signature']);assert.equal(stale.sign_requests[0].attempt_id,fresh.attempt_id);
 await approveAndSettle(t,{sign_requests:[fresh]});
 assert.equal(t.p.status(ALICE,old.trade_id).status,'success');
});

// ---- failure and recovery ----
test('sourcing refunded: nothing of the person moves, every coin reads not sent, the amount returns to the daily cap, the solver is whole',async()=>{
 const t=ledgerPipeline();
 t.oneclick.mode='refund';
 const {x}=await buy(t,{usdc:'9'});
 assert.equal(spentToday(t.db,ALICE.accountId,t.now()),9_000_000n);
 await approveAndSettle(t,x);
 const st=t.p.status(ALICE,x.trade_id);
 assert.equal(st.status,'failed');assert.deepEqual(st.legs.map(l=>l.status),['FAILED','FAILED','FAILED']);assert.match(st.legs[0].refund_reason,/funds still in your wallet/);
 assert.deepEqual(legStates(t,x.trade_id),['failed','failed','failed']);
 assert.deepEqual(balances(t,user),{USDC:20_000_000n,WIF:0n,BOME:0n,TRUMP:0n});
 assert.deepEqual(balances(t,t.near.accountId),{USDC:30_000_000n,WIF:0n,BOME:0n,TRUMP:0n});
 assert.equal(spentToday(t.db,ALICE.accountId,t.now()),0n);
 assert.equal(t.p.ledgerRoute.row(x.trade_id).state,'not_executed');
 assert.equal(t.world.executed.length,1,'only the sourcing transfer ran; the person\'s message was never sent');
 // the person's message can no longer be used: the proposal is closed and a new quote is a new trade
 await assert.rejects(t.p.execute(ALICE,{proposal_id:x.proposal_id,revision:1,confirm:'000000'}),e=>e?.name==='TradeError');
});

test('one coin is not delivered in time: the trade is not settled, and the coin the solver did get is sold back, at most YEET_SOLVER_UNLOAD_MAX_TRIES times a day',async()=>{
 const t=ledgerPipeline({env:{YEET_SOLVER_UNLOAD_MAX_TRIES:'2'}});
 // WIF and BOME fill; TRUMP never does
 const status=t.oneclick.status.bind(t.oneclick);
 t.oneclick.status=async a=>{const q=t.oneclick.quotes.find(x=>x.depositAddress===a);if(q.req.destinationAsset===TRUMP)return {status:'PROCESSING',correlationId:'c',updatedAt:new Date(t.now()).toISOString()};return status(a)};
 t.oneclick.submitDeposit=a=>t.oneclick.status(a);
 const {x}=await buy(t,{usdc:'9'});
 await approveAndSettle(t,x);
 assert.equal(t.p.status(ALICE,x.trade_id).status,'failed');
 assert.match(JSON.parse(t.p.ledgerRoute.row(x.trade_id).json).result.reason,/not sourced in time: TRUMP/);
 assert.deepEqual(balances(t,user),{USDC:20_000_000n,WIF:0n,BOME:0n,TRUMP:0n},'the person gave nothing');
 // 1Click gives the undelivered leg's USDC back, and from here on refunds every sale
 t.oneclick.status=status;t.oneclick.mode='refund';
 for(const q of t.oneclick.quotes.filter(q=>!q.state))await t.oneclick.status(q.depositAddress);
 const held=balances(t,t.near.accountId);
 assert.equal(held.USDC,24_000_000n);assert.ok(held.WIF>0n&&held.BOME>0n&&held.TRUMP===0n,'the solver holds what was delivered');
 // each coin is tried twice that day, then left where it is with one alert per coin
 for(let i=0;i<8;i++){t.now.advance(61_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle()}
 const tries=t.db.prepare('SELECT token_id,COUNT(*) AS n,MIN(state) AS state FROM ledger_unload GROUP BY token_id ORDER BY token_id').all();
 assert.deepEqual(tries.map(r=>[r.n,r.state]),[[2,'failed'],[2,'failed']],'two tries per coin, no more');
 assert.deepEqual(balances(t,t.near.accountId),held,'refunded each time: the solver still holds the coins');
 assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM trade_alerts WHERE dedup_key LIKE 'ledger_unload:%'").get().n,2,'one alert per coin');
 // the next day it is tried again, and sold once 1Click fills
 t.oneclick.mode='fill';t.now.advance(24*3600_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.deepEqual(balances(t,t.near.accountId),{USDC:30_000_000n,WIF:0n,BOME:0n,TRUMP:0n});
});

test('a paid sale of leftover inventory that never gets an outcome is closed with an alert instead of being followed for ever',async()=>{
 const t=ledgerPipeline();
 t.world.credit(t.near.accountId,WIF,6_673_811n);
 t.oneclick.mode='stall';
 t.now.advance(61_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.deepEqual(t.db.prepare('SELECT state FROM ledger_unload').all().map(r=>r.state),['open']);
 assert.equal(t.world.balance(t.near.accountId,WIF),0n,'the coin is at the deposit account');
 t.now.advance(21*60_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.deepEqual(t.db.prepare('SELECT state FROM ledger_unload').all().map(r=>r.state),['failed']);
 assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM trade_alerts WHERE dedup_key LIKE 'ledger_unload_open:%'").get().n,1);
});

test('leftover inventory is sold back to USDC once 1Click fills again',async()=>{
 const t=ledgerPipeline();
 t.world.credit(t.near.accountId,WIF,6_673_811n);
 t.now.advance(61_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.deepEqual(balances(t,t.near.accountId),{USDC:31_000_000n,WIF:0n,BOME:0n,TRUMP:0n});
 assert.deepEqual(t.db.prepare('SELECT state FROM ledger_unload').all().map(r=>r.state),['done']);
});

test('the settlement transaction is lost and the process restarts: the run resumes from its stored state and settles once',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 const req=x.sign_requests[0];
 // the sourcing transfer goes through; every later send is lost in transport
 const call=t.world.rpc.call;let sends=0;
 t.world.rpc.call=async(method,params)=>{if(method==='send_tx'&&++sends>1)throw Error('socket hang up');return call(method,params)};
 await t.p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed:approve(aliceWallet,req)});
 await t.p.ledgerRoute.idle();
 assert.equal(t.p.ledgerRoute.row(req.trade_id).state,'running');assert.deepEqual(legStates(t,req.trade_id),['signing','signing','signing']);
 assert.equal(t.p.status(ALICE,req.trade_id).status,'signing');
 const before=JSON.parse(t.p.ledgerRoute.row(req.trade_id).json);
 assert.ok(before.signed_pair&&before.settle.tx_hash,'the signed settlement is stored before it is sent');
 // restart with the network back
 t.world.rpc.call=call;
 const p2=t.restart();
 await p2.tracker.pollOnce();await p2.ledgerRoute.idle();
 assert.equal(p2.status(ALICE,req.trade_id).status,'success');
 assert.equal(JSON.parse(p2.ledgerRoute.row(req.trade_id).json).settle.tx_hash,before.settle.tx_hash,'the same transaction, not a second one');
 assert.equal(t.world.executed.length,2);
 assert.equal(t.world.balance(user,USDC),11_000_000n);
});

test('the settlement fails on chain: the ledger says the person\'s message was not executed, the trade fails and the coins are left to the unload',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 const req=x.sign_requests[0];
 const call=t.world.rpc.call;let sends=0;
 t.world.rpc.call=async(method,params)=>{if(method==='send_tx'&&++sends===2)t.world.failSends=1;return call(method,params)};
 await t.p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed:approve(aliceWallet,req)});
 await t.p.ledgerRoute.idle();
 assert.equal(t.p.status(ALICE,req.trade_id).status,'failed');
 assert.equal(t.world.balance(user,USDC),20_000_000n);assert.equal(spentToday(t.db,ALICE.accountId,t.now()),0n);
 t.now.advance(61_000);await t.p.ledgerRoute.tick();await t.p.ledgerRoute.idle();
 assert.deepEqual(balances(t,t.near.accountId),{...balances(t,t.near.accountId),WIF:0n,BOME:0n,TRUMP:0n});
 assert.ok(t.world.balance(t.near.accountId,USDC)>29_990_000n,'the float is back but for the two fees');
});

test('never approved: the window closes, every coin reads not sent and the amount returns to the daily cap at once',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 t.now.advance(10*60_000+1);
 await t.p.tracker.pollOnce();
 assert.deepEqual(legStates(t,x.trade_id),['not_sent','not_sent','not_sent']);
 assert.equal(t.p.status(ALICE,x.trade_id).status,'failed');
 assert.equal(spentToday(t.db,ALICE.accountId,t.now()),0n);
 assert.equal(t.p.ledgerRoute.row(x.trade_id).state,'not_executed');
 assert.deepEqual(await t.p.signRequests(ALICE,x.trade_id),[]);
 assert.equal(t.world.executed.length,0);
});

test('the kill switch: an approval is refused while it is on, and one already taken is stopped before the solver pays anything',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 const req=x.sign_requests[0],args={trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed:approve(aliceWallet,req)};
 t.env.YEET_KILL_SWITCH='1';
 await assert.rejects(t.p.submit(ALICE,args),refused('TRADING_PAUSED'));
 assert.deepEqual(legStates(t,req.trade_id),['awaiting_signature','awaiting_signature','awaiting_signature']);
 t.env.YEET_KILL_SWITCH='0';
 // switched on after the approval passed the gate (here: during its simulation), before the run starts
 const simulate=t.world.verifier.simulate;
 t.world.verifier.simulate=async signed=>{t.env.YEET_KILL_SWITCH='1';return simulate(signed)};
 await t.p.submit(ALICE,args);
 await t.p.ledgerRoute.idle();
 assert.equal(t.p.status(ALICE,req.trade_id).status,'failed');
 assert.match(JSON.parse(t.p.ledgerRoute.row(req.trade_id).json).result.reason,/trading paused: kill switch/);
 assert.equal(t.world.executed.length,0,'nothing was paid');
 assert.equal(t.world.balance(t.near.accountId,USDC),30_000_000n);assert.equal(t.world.balance(user,USDC),20_000_000n);
 assert.equal(spentToday(t.db,ALICE.accountId,t.now()),0n);
 assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM ledger_solver_day').get().n,0,'no exposure was recorded');
});

test('the person no longer holds the USDC when the approval arrives: nothing is sourced and every coin reads not sent',async()=>{
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 t.world.move(user,'elsewhere',USDC,15_000_000n);
 const s=await approveAndSettle(t,x);
 assert.deepEqual(s.legs.map(l=>l.send_status),['not_sent','not_sent','not_sent']);
 assert.equal(t.world.executed.length,0);assert.equal(spentToday(t.db,ALICE.accountId,t.now()),0n);
});

// ---- limits ----
test('caps and limits are the chain route\'s: 3 USDC per coin, the tier\'s per-trade and daily caps, the balance',async()=>{
 const t=ledgerPipeline({userUsdc:200_000_000n,float:200_000_000n,env:{YEET_SOLVER_MAX_TRADE_USDC:'100',YEET_SOLVER_MAX_DAY_USDC:'500'}});
 await assert.rejects(t.p.propose(ALICE,{request_id:'small',amount_usdc:'5',legs:['WIF','BOME','TRUMP'].map(symbol=>({symbol,parts:1}))}),refused('AMOUNT_TOO_SMALL'));
 await assert.rejects(t.p.propose(ALICE,{request_id:'big',amount_usdc:'26',legs:[{symbol:'WIF',parts:1}]}),refused('LIMIT_EXCEEDED',/per-trade cap/));
 const home=await t.p.home(ALICE);
 assert.deepEqual(home.limits,{tier:'Noob',per_trade_usdc:'25',daily_limit_usdc:'100',left_today_usdc:'100'});
 for(const id of ['d1','d2','d3','d4']){const r=await buy(t,{usdc:'25',coins:['WIF'],id});await approveAndSettle(t,r.x);assert.equal(t.p.status(ALICE,r.x.trade_id).status,'success')}
 assert.equal((await t.p.home(ALICE)).limits.left_today_usdc,'0');
 await assert.rejects(t.p.propose(ALICE,{request_id:'d5',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]}),refused('LIMIT_EXCEEDED',/daily cap/));
 // sells are never capped
 const s=await sell(t,{coins:['WIF']});await approveAndSettle(t,s.x);
 assert.equal(t.p.status(ALICE,s.x.trade_id).status,'success');
 // the balance is the ledger account's
 const poor=ledgerPipeline({userUsdc:4_000_000n});
 const pr=await poor.p.propose(ALICE,{request_id:'p1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});
 assert.ok(pr.warnings.includes('BALANCE_LOW'));
 await assert.rejects(poor.p.execute(ALICE,{proposal_id:pr.proposal_id,revision:pr.revision,confirm:pr.confirm.code}),refused('BALANCE_LOW'));
});

test('the solver\'s exposure is bounded per trade and per day, and its float must cover the trade: refused before the person is asked',async()=>{
 const t=ledgerPipeline({userUsdc:100_000_000n,float:100_000_000n,env:{YEET_SOLVER_MAX_TRADE_USDC:'10',YEET_SOLVER_MAX_DAY_USDC:'15'}});
 const over=await t.p.propose(ALICE,{request_id:'o1',amount_usdc:'12',legs:[{symbol:'WIF',parts:1}]});
 await assert.rejects(t.p.execute(ALICE,{proposal_id:over.proposal_id,revision:over.revision,confirm:over.confirm.code}),refused('TEMPORARILY_UNAVAILABLE',/per-trade bound/));
 assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM trades').get().n,0,'no trade was made');
 const a=await buy(t,{usdc:'9',coins:['WIF'],id:'a'});await approveAndSettle(t,a.x);
 assert.equal(t.db.prepare('SELECT usdc_raw FROM ledger_solver_day').get().usdc_raw,'9000000');
 const b=await t.p.propose(ALICE,{request_id:'b',amount_usdc:'7',legs:[{symbol:'WIF',parts:1}]});
 await assert.rejects(t.p.execute(ALICE,{proposal_id:b.proposal_id,revision:b.revision,confirm:b.confirm.code}),refused('TEMPORARILY_UNAVAILABLE',/daily bound/));
 // the next UTC day starts a new bound
 t.now.advance(24*3600_000);
 const c=await buy(t,{usdc:'7',coins:['WIF'],id:'c'});await approveAndSettle(t,c.x);
 assert.equal(t.p.status(ALICE,c.x.trade_id).status,'success');
 const dry=ledgerPipeline({float:2_000_000n});
 const d=await dry.p.propose(ALICE,{request_id:'d',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});
 await assert.rejects(dry.p.execute(ALICE,{proposal_id:d.proposal_id,revision:d.revision,confirm:d.confirm.code}),refused('TEMPORARILY_UNAVAILABLE',/solver float/));
});

// ---- balance source, previews, the contract cut, the check tool ----
test('the welcome card and the portfolio read the person\'s ledger account, not their wallet',async()=>{
 const t=ledgerPipeline({userUsdc:7_250_000n,chainHoldings:[{mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',raw:999_000_000n,decimals:6}]});
 t.world.credit(user,WIF,2_500_000n);
 const home=await t.p.home(ALICE);
 assert.deepEqual(home.funding,{base_usdc:'0',solana_usdc:'7.25',chosen:'solana'});assert.equal(home.ready,'ready');
 const pf=await t.p.portfolio(ALICE);
 assert.deepEqual(pf.solana.holdings.map(h=>[h.symbol,h.amount]),[['USDC','7.25'],['WIF','2.5']]);assert.equal(pf.base.usdc,'0');
 assert.equal(ledgerAccountOf(aliceWallet.address),user);assert.match(user,/^[0-9a-f]{64}$/);
 const empty=ledgerPipeline({userUsdc:0n});
 assert.equal((await empty.p.home(ALICE)).ready,'needs_funds');
});

test('previews are quoted with the ledger on both sides and the solver as the account; firm quotes never pass the preview client',async()=>{
 const seen=[];
 const c=previewClient({authenticated:false,quote:async r=>{seen.push(r);return 'ok'},getTokens:async()=>[],status:async()=>null,submitDeposit:async()=>null},{solverAccount:'ab'.repeat(32),usdcAssetIds:['nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',USDC]});
 await c.quote({dry:true,originAsset:'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',destinationAsset:WIF,amount:'5000000',depositType:'ORIGIN_CHAIN',refundType:'ORIGIN_CHAIN',recipientType:'DESTINATION_CHAIN',refundTo:'0xabc',recipient:'sol'});
 assert.deepEqual(seen[0],{dry:true,originAsset:USDC,destinationAsset:WIF,amount:'5000000',depositType:'INTENTS',refundType:'INTENTS',recipientType:'INTENTS',refundTo:'ab'.repeat(32),recipient:'ab'.repeat(32)});
 assert.throws(()=>c.quote({dry:false}),/dry quotes only/);
 const t=ledgerPipeline();
 const {x}=await buy(t,{usdc:'9'});
 assert.equal(t.oneclick.quotes.length,3,'three firm quotes at the tap');
 for(const q of t.oneclick.quotes){assert.equal(q.req.recipient,t.near.accountId);assert.equal(q.req.refundTo,t.near.accountId);assert.equal(q.req.depositType,'INTENTS');assert.equal(q.req.recipientType,'INTENTS')}
 assert.deepEqual(x.legs.map(l=>l.deposit_address),t.oneclick.quotes.map(q=>q.depositAddress));
});

test('a request kind the pinned contract does not list is left out of the tool answer; the chain route\'s kinds pass untouched',()=>{
 const schema=toolSchemas.execute_trade.output;
 const chain={trade_id:'t',sign_requests:[{kind:'solana_tx'},{kind:'evm_tx'},{kind:'evm_7702'}]};
 assert.deepEqual(cutSignRequests(schema,structuredClone(chain)),chain);
 const listed=schema.properties.sign_requests.items.properties.kind.enum.includes('near_intent');
 assert.equal(cutSignRequests(schema,{sign_requests:[{kind:'near_intent'}]}).sign_requests.length,listed?1:0);
 assert.deepEqual(cutSignRequests(schema,{status:'x'}),{status:'x'});
 assert.deepEqual(cutSignRequests(toolSchemas.trade_status.output,{sign_requests:[{kind:'near_intent'}]}),{sign_requests:[{kind:'near_intent'}]},'a tool without the field is not touched');
});

test('the read-only check: account, balances, a 3-coin 5 USDC quote and the message, with no key and nothing sent',async()=>{
 const now=fakeClock(),world=fakeLedger({now}),client=fakeLedgerOneClick({world,now}),solver=solverKey().accountId;
 world.credit(user,USDC,12_340_000n);world.credit(user,WIF,1_000_000n);world.credit(solver,USDC,8_000_000n);
 const r=await ledgerCheck({address:aliceWallet.address,solverAccount:solver,usdc:'5',coins:'WIF,BOME,TRUMP',verifier:world.verifier,client,now});
 assert.equal(r.ledger_account,user);assert.equal(r.usdc_spendable,'12.34');assert.equal(r.covers_basket,true);
 assert.deepEqual(r.balances.map(b=>[b.symbol,b.amount]),[['USDC','12.34'],['WIF','1']]);
 assert.deepEqual(r.solver,{account:solver,usdc_float:'8',covers_basket:true});
 assert.deepEqual(r.basket.legs.map(l=>[l.symbol,l.usdc_in]),[['WIF','1.666668'],['BOME','1.666666'],['TRUMP','1.666666']]);
 assert.equal(r.product_limits.basket_passes,false);assert.match(r.product_limits.note,/under the 3 USDC minimum per coin/);
 const m=JSON.parse(r.would_approve.message);
 assert.equal(m.signer_id,user);assert.equal(m.intents.length,1);assert.equal(m.intents[0].diff[USDC],'-5000000');
 assert.deepEqual(Object.keys(m.intents[0].diff).sort(),[BOME,USDC,WIF,TRUMP].sort());
 assert.equal(client.firmCalls,0,'dry quotes only');assert.equal(world.executed.length,0);assert.equal(world.simulations??0,0);
 const one=await ledgerCheck({address:aliceWallet.address,solverAccount:solver,usdc:'5',coins:'WIF',verifier:world.verifier,client,now});
 assert.equal(one.product_limits.basket_passes,true);
 await assert.rejects(ledgerCheck({address:aliceWallet.address,solverAccount:'solver.near',verifier:world.verifier,client,now}),/64 hex/);
 await assert.rejects(ledgerCheck({address:aliceWallet.address,solverAccount:solver,coins:'NOPE',verifier:world.verifier,client,now}),/unknown coin/);
 assert.throws(()=>checkArgs(['--address','x']),/--address/);assert.throws(()=>checkArgs(['--address',aliceWallet.address],{}),/--solver/);
 assert.equal(checkArgs(['--address',aliceWallet.address,'--usdc','9'],{YEET_SOLVER_ACCOUNT:solver}).usdc,'9');
});

test('receipts: the golden numbers in this file are the ones the spike recorded (when the receipts are on this box)',t=>{
 const dir=join(homedir(),'.world/team/director/docs/plans/near-hackathon/receipts');
 if(!existsSync(join(dir,'intents-jit-buy-20261114.json')))return t.skip('receipts not on this box');
 const r=JSON.parse(readFileSync(join(dir,'intents-jit-buy-20261114.json'),'utf8'));
 assert.deepEqual(r.out_user_ledger,{WIF:'6.678280',BOME:'1739.045269',TRUMP:'0.916017'});
 const lines=readFileSync(join(dir,'intents-live/06-jit-buy-inside.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
 const signedLine=lines.find(l=>l.stage==='user_signed');
 assert.deepEqual(signedLine.legs.map(l=>[l.quoted_out,l.min_out,l.user_signs_for_at_least]),[['6673811','6607072','6607065'],['1738598300','1721212317','1721210595'],['915597','906441','906440']]);
 assert.deepEqual(Object.fromEntries(lines.filter(l=>l.stage==='sourced').map(l=>[l.symbol,BigInt(l.amount)])),{BOME:SPIKE[BOME],WIF:SPIKE[WIF],TRUMP:SPIKE[TRUMP]});
 const sellLine=readFileSync(join(dir,'intents-live/07-jit-sell.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)).find(l=>l.stage==='result');
 assert.deepEqual([sellLine.user_gave,sellLine.user_paid_at_once,sellLine.solver_delta.USDC,sellLine.solver_delta.WIF],['6678280','974976','-974977','6678273']);
});

test('the operator tool on the ledger route: dry verifies the approval and sends nothing; --broadcast buys, then sells with the surplus passed on',async()=>{
 const {parseArgs,runUserSignedTrade,OPERATOR_ACCOUNT}=await import('../pipeline/operator-trade.mjs');
 const {openTradeDb}=await import('../trade/db.mjs');
 const now=fakeClock(),world=fakeLedger({now}),client=fakeLedgerOneClick({world,now}),near=solverKey(),db=openTradeDb(':memory:');
 world.credit(user,USDC,5_500_000n);world.credit(near.accountId,USDC,6_000_000n);
 const wallet={solana:aliceWallet,base:{address:'0x17602fd697f91d31fe551b26a3b12b113789477e',privateKey:()=>{throw Error('the EVM key is never used on the ledger route')}}};
 const env={YEET_ROUTE:'ledger',YEET_SOLVER_ACCOUNT:near.accountId,YEET_SOLVER_KEY_FILE:'/nonexistent',YEET_SOLVER_MAX_TRADE_USDC:'6',YEET_SOLVER_MAX_DAY_USDC:'20',YEET_LIVE:'1',YEET_KILL_SWITCH:'0',YEET_LIVE_ACCOUNTS:OPERATOR_ACCOUNT};
 const run=async argv=>{const out=[];const r=await runUserSignedTrade({opts:parseArgs(argv),wallet,env,emit:o=>out.push(o),now,sleep:async()=>{},
  // as the tool itself does: a dry run keeps its records in memory, a broadcast in the operator's database
  overrides:{...(argv.includes('--broadcast')?{db}:{}),client,balances:{async baseUsdc(){return 0n},async solanaTokens(){return []}},ledgerOverrides:{rpc:world.rpc,verifier:world.verifier,near,pollMs:0,unloadWaitMs:30_000,sleep:async ms=>{now.advance(Math.max(ms,500))}}}});return {r,out}};
 const dry=await run(['--side','buy','--coin','WIF','--usdc','5']);
 const shown=dry.out.find(o=>o.step==='executed').sign_requests[0];
 assert.equal(shown.kind,'near_intent');assert.equal(JSON.parse(shown.message).intents[0].diff[USDC],'-5000000');
 assert.equal(dry.out.find(o=>o.step==='submitted').dry_run_state,'pending');
 assert.equal(world.executed.length,0);assert.equal(world.balance(user,USDC),5_500_000n);
 now.advance(5_000);
 const live=await run(['--side','buy','--coin','WIF','--usdc','5','--broadcast']);
 assert.equal(live.r.status,'success');
 assert.equal(live.out.find(o=>o.step==='ledger').state,'settled');
 assert.equal(world.balance(user,USDC),500_000n);assert.ok(world.balance(user,WIF)>33_000_000n);
 now.advance(5_000);
 const back=await run(['--side','sell','--coin','WIF','--broadcast']);
 assert.equal(back.r.status,'success');
 const last=back.out.find(o=>o.step==='ledger');
 assert.equal(last.unload.state,'done');assert.ok(BigInt(last.unload.surplus)>0n);
 assert.equal(world.balance(user,WIF),0n);assert.ok(world.balance(user,USDC)>5_490_000n,'all but the fees is back');
 assert.equal(world.balance(near.accountId,WIF),0n);assert.equal(world.balance(near.accountId,USDC),5_999_995n,'the solver paid the ledger fee of the buy, and nothing else');
});

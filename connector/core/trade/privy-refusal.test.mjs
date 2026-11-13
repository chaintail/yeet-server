// First supervised trade review (2026-11-13): Privy answered 400 to the sponsored Base send, core kept only the status,
// left the leg `sending` (re-issued, 5 USDC held against the cap) and the tool printed `sent`. Covered here:
//   1. the Privy error body's code and message are kept (redacted, <= 300 chars) on the leg, its audit row, the log
//   2. a Privy 4xx on the send fails the leg (first attempt at once; a re-issue after a reference lookup finds
//      nothing) and it is never sent again; only 408, 5xx, timeouts and key reuse stay pending
//   3. the operator cancel: a trade never broadcast ends failed, cap returned, audited, never re-sent
// Real delegated adapter and Privy client over fakePrivy; no network, no wallet, no funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeEngine,fakePrivy,fakePrivyEnv,fakeBalances} from './fakes.mjs';
import {createDelegatedSigner,definiteRefusal} from './signer-privy.mjs';
import {createPrivyApi,privyConfig,privyErrorDetail,redact,PRIVY_ERROR_MAX} from './privy-api.mjs';
import {tradeEvents} from './audit.mjs';
import {RESEND_AFTER_MS} from './executor.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const bob={accountId:'yeet-privy-bob',clientId:'operator'};
const one={request_id:'r1',amount_usdc:'5',legs:[{symbol:'WIF',parts:10}]};
const exec=(engine,ctx,p)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code});
const legRows=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const spent=db=>db.prepare('SELECT usdc_raw FROM daily_spend').get()?.usdc_raw;
const tradeOf=db=>db.prepare('SELECT * FROM trades').get();
const noDepositSeen=oneclick=>{for(const d of oneclick.deposits.values())d.script=['status-pending.json']};
const SPONSOR_400={code:'invalid_data',error:'Gas sponsorship is not enabled for this app on chain eip155:8453'};

async function privyEngine(privy,{wrap=f=>f}={}){
 const balances=fakeBalances();
 const signer=createDelegatedSigner({env:fakePrivyEnv(),fetch:wrap(privy.fetch),balances,didFor:id=>id===alice.accountId?'did:privy:alice':undefined});
 const logs=[];
 const e=await fakeEngine({signer,balances,env:{YEET_LIVE:'1'},logs});
 return {...e,privy,logs};
}

test('Privy error detail: code and message kept, credential-like parts redacted, cut to 300 characters',()=>{
 const d=privyErrorDetail(400,{code:'invalid_data',error:'Gas sponsorship is not enabled for chain eip155:8453'});
 assert.deepEqual(d,{status:400,code:'invalid_data',message:'Gas sponsorship is not enabled for chain eip155:8453'});
 assert.deepEqual(privyErrorDetail(500,null),{status:500,code:null,message:null});
 assert.equal(privyErrorDetail(400,{message:['a','b']}).message,'a; b');
 const long=privyErrorDetail(400,{error:'word '.repeat(200)}).message;
 assert.ok(long.length<=PRIVY_ERROR_MAX);
 const secret='sk_live_'+'Q'.repeat(10);
 const leaky=[`app secret ${secret} leaked`,'Authorization: Basic ZmFrZS1hcHA6ZmFrZS1zZWNyZXQ=','Bearer abc.def.ghi','token=hunter2hunter2','jwt eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
  '-----BEGIN PRIVATE KEY-----MIGHAgEAMBMG-----END PRIVATE KEY-----','key wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg','opaque '+'A1b2C3d4'.repeat(6)].join(' | ');
 const out=redact(leaky,[secret]);
 for(const bad of [secret,'ZmFrZS1hcHA6ZmFrZS1zZWNyZXQ=','abc.def.ghi','hunter2hunter2','eyJhbGciOiJFUzI1NiJ9','MIGHAgEAMBMG','A1b2C3d4A1b2C3d4'])assert.ok(!out.includes(bad),`${bad} redacted: ${out}`);
 const addr='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
 assert.equal(redact(`to ${addr} on eip155:8453`),`to ${addr} on eip155:8453`,'public addresses and chain ids stay');
});

test('Privy client: a non-2xx answer carries the redacted detail; the app secret never appears in it',async()=>{
 const env=fakePrivyEnv();
 const fetch=async()=>new Response(JSON.stringify({code:'invalid_data',error:`bad request for app ${env.PRIVY_APP_SECRET}-ish`}),{status:400});
 const api=createPrivyApi({config:privyConfig(env),fetch});
 await assert.rejects(api.app('GET','/v1/wallets/w1'),e=>e.status===400&&e.code==='PRIVY_HTTP_400'&&e.privy.code==='invalid_data'&&!e.privy.message.includes(env.PRIVY_APP_SECRET)&&e.privy.message.includes('[redacted]'));
});

test('rule: a Privy 4xx on the send is a definite refusal; 408, key reuse, 5xx and timeouts are not',()=>{
 const e=(status,code,privyCode)=>({status,code:code??`PRIVY_HTTP_${status}`,privy:privyCode?{code:privyCode}:undefined});
 for(const s of [400,401,403,404,409,422,429])assert.equal(definiteRefusal(e(s)),true,String(s));
 assert.equal(definiteRefusal(e(408)),false,'request timeout: Privy may still act');
 assert.equal(definiteRefusal(e(400,'PRIVY_IDEMPOTENCY_CONFLICT')),false,'the key was accepted before');
 for(const s of [500,502,503])assert.equal(definiteRefusal(e(s)),false,String(s));
 assert.equal(definiteRefusal(e(500,undefined,'transaction_broadcast_failure')),true,'documented: not broadcast');
 assert.equal(definiteRefusal({code:'PRIVY_TRANSPORT_UNAVAILABLE'}),false,'timeout / network');
});

test('engine: Privy 400 on the first sponsored send: leg failed at once with the Privy error on row, audit and log; cap returned; never re-sent',async()=>{
 const {engine,db,privy,now,logs}=await privyEngine(fakePrivy({rpcFailures:[{at:0,status:400,body:SPONSOR_400}]}));
 await assert.rejects(exec(engine,alice,await engine.propose(alice,one)),e=>e.code==='TEMPORARILY_UNAVAILABLE');
 const t=tradeOf(db),[leg]=legRows(db,t.id);
 assert.equal(leg.send_status,'failed');assert.equal(leg.send_attempts,1);
 assert.deepEqual(JSON.parse(leg.privy_error),{status:400,code:'invalid_data',message:SPONSOR_400.error});
 assert.equal(spent(db),'0','the amount is back under the daily cap');
 assert.equal(t.status,'failed');
 assert.match(t.last_error,/Privy 400 invalid_data: Gas sponsorship is not enabled/);
 const failed=tradeEvents(db,t.id).find(e=>e.kind==='leg'&&e.to_status==='failed');
 assert.equal(failed.from_status,'sending');assert.equal(failed.evidence.not_sent,true);assert.equal(failed.evidence.privy_error.code,'invalid_data');
 const line=logs.find(l=>l.event==='privy_send_error');
 assert.deepEqual([line.trade,line.leg,line.attempt,line.http,line.code,line.not_sent],[t.id,0,'first',400,'invalid_data',true]);
 assert.equal(line.message,SPONSOR_400.error);
 const rec=engine.tracker.record(alice,t.id);
 assert.equal(rec.legs[0].send_status,'failed');assert.equal(rec.legs[0].privy_error.code,'invalid_data');
 for(let i=0;i<4;i++){now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce()}
 assert.equal(privy.rpc.length,1,'one request, ever');assert.equal(privy.broadcasts.length,0);
 assert.equal(engine.status(alice,t.id).legs[0].status,'FAILED');
});

test('engine: a re-issue answered 4xx is never sent again and fails once Privy has nothing under the reference',async()=>{
 const {engine,db,privy,now,oneclick,logs}=await privyEngine(fakePrivy({rpcFailures:[{at:0,status:'timeout',accepted:false},{at:1,status:400,body:SPONSOR_400}]}));
 const r=await exec(engine,alice,await engine.propose(alice,one));
 noDepositSeen(oneclick);
 assert.equal(legRows(db,r.trade_id)[0].send_status,'sending','a timeout is ambiguous');
 assert.equal(spent(db),'5000000');
 now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce();
 const [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'failed');assert.equal(leg.send_attempts,2);assert.ok(leg.refused_at!==null);
 assert.equal(spent(db),'0');assert.equal(tradeOf(db).status,'failed');
 const ev=tradeEvents(db,r.trade_id).filter(e=>e.kind==='leg');
 assert.deepEqual(ev.map(e=>[e.from_status,e.to_status]),[[null,'queued'],['queued','sending'],['sending','sending'],['sending','failed']]);
 assert.equal(ev.at(-1).evidence.privy_lookup,'none');assert.equal(ev.at(-1).evidence.privy_error.status,400);
 assert.equal(logs.find(l=>l.event==='privy_send_error').attempt,'reissue');
 for(let i=0;i<4;i++){now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce()}
 assert.equal(privy.rpc.length,2,'no third request');assert.equal(privy.broadcasts.length,0);
});

test('engine: a refused re-issue whose reference lookup fails stays sending but is only looked up; failed once the lookup answers',async()=>{
 let lookups=true;
 const wrap=f=>async(url,init)=>(!lookups&&String(url).includes('/v1/transactions')?new Response(JSON.stringify({error:'unavailable'}),{status:503}):f(url,init));
 const {engine,db,privy,now,oneclick}=await privyEngine(fakePrivy({rpcFailures:[{at:0,status:'timeout',accepted:false},{at:1,status:403,body:{error:'Forbidden'}}]}),{wrap});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 noDepositSeen(oneclick);
 lookups=false;
 now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce();
 let [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sending');assert.ok(leg.refused_at!==null);
 for(let i=0;i<3;i++){now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce()}
 assert.equal(privy.rpc.length,2,'refused: never re-issued while the lookup is down');
 lookups=true;
 now.advance(1000);await engine.tracker.pollOnce();
 [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'failed');assert.equal(spent(db),'0');assert.equal(privy.rpc.length,2);
});

test('engine: ambiguous Privy answers (408, 5xx) keep the leg sending, with the Privy error on its audit trail',async()=>{
 const {engine,db}=await privyEngine(fakePrivy({rpcFailures:[{at:0,status:408,body:{error:'Request timeout'}}]}));
 const r=await exec(engine,alice,await engine.propose(alice,one));
 const [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sending');assert.equal(JSON.parse(leg.privy_error).status,408);assert.equal(spent(db),'5000000');
 assert.ok(tradeEvents(db,r.trade_id).some(e=>e.from_status==='sending'&&e.to_status==='sending'&&e.evidence.privy_error?.message==='Request timeout'));
});

/** The stuck trade of the first attempt: two send attempts, ambiguous answers, leg `sending`, 5 USDC held. */
async function stuck(extra=[]){
 const privy=fakePrivy({rpcFailures:[{at:0,status:'timeout',accepted:false},{at:1,status:408,body:{error:'Request timeout'}},...extra]});
 const e=await privyEngine(privy);
 const r=await exec(e.engine,alice,await e.engine.propose(alice,one));
 noDepositSeen(e.oneclick);
 e.now.advance(RESEND_AFTER_MS+1000);await e.engine.tracker.pollOnce();
 const [leg]=legRows(e.db,r.trade_id);
 assert.equal(leg.send_status,'sending');assert.equal(leg.send_attempts,2);assert.equal(spent(e.db),'5000000');
 return {...e,tradeId:r.trade_id};
}

test('cancel: a trade never broadcast ends failed through the guard, cap returned, audited, and is never re-sent even with trading live',async()=>{
 const {engine,db,privy,now,oneclick,logs,tradeId}=await stuck();
 const sends=privy.rpc.length;
 const out=await engine.cancel(alice,tradeId,{reason:'first trade: Privy 400'});
 assert.equal(out.cancelled,true,out.reason);
 assert.equal(out.status,'failed');assert.deepEqual(out.legs.map(l=>l.send_status),['failed']);assert.equal(out.released_raw,'5000000');
 assert.deepEqual(out.checks[0],{send_status:'sending',oneclick_status:'PENDING_DEPOSIT',privy_lookup:'none'});
 assert.equal(spent(db),'0');
 assert.equal(db.prepare('SELECT status FROM proposals').get().status,'failed');
 const ev=tradeEvents(db,tradeId);
 const legFail=ev.find(e=>e.kind==='leg'&&e.to_status==='failed');
 assert.equal(legFail.from_status,'sending');assert.equal(legFail.evidence.reason,'operator cancel: never broadcast');assert.equal(legFail.evidence.operator_note,'first trade: Privy 400');
 assert.ok(ev.some(e=>e.kind==='review'&&e.to_status==='operator_cancel'&&e.evidence.released_raw==='5000000'));
 assert.ok(ev.some(e=>e.kind==='trade'&&e.from_status==='signing'&&e.to_status==='failed'));
 assert.ok(logs.some(l=>l.event==='operator_trade_cancelled'&&l.trade===tradeId));
 for(let i=0;i<5;i++){now.advance(RESEND_AFTER_MS+1000);await engine.tracker.pollOnce()}
 assert.equal(privy.rpc.length,sends,'never sent again');assert.equal(legRows(db,tradeId)[0].send_status,'failed');
 assert.equal(oneclick.calls.submit.length,0);
 const again=await engine.cancel(alice,tradeId);
 assert.equal(again.cancelled,false);assert.match(again.reason,/nothing to cancel/);
 await assert.rejects(engine.cancel(bob,tradeId),e=>e.code==='INVALID_ARGUMENT','another account');
});

test('cancel refuses when Privy has a transaction under the reference, or 1Click sees a deposit, or a leg was sent; nothing changes',async()=>{
 // Privy accepted the first send (its answer was lost): the lookup finds it.
 {
  const privy=fakePrivy({rpcFailures:[{at:0,status:'timeout',accepted:true}]});
  const {engine,db,oneclick}=await privyEngine(privy);
  const r=await exec(engine,alice,await engine.propose(alice,one));
  noDepositSeen(oneclick);
  const out=await engine.cancel(alice,r.trade_id);
  assert.equal(out.cancelled,false);assert.match(out.reason,/Privy has a (pending|confirmed) transaction/);
  assert.equal(legRows(db,r.trade_id)[0].send_status,'sending');assert.equal(spent(db),'5000000');
 }
 // 1Click already sees a deposit at the leg's address.
 {
  const {engine,db,oneclick,tradeId}=await stuck();
  for(const d of oneclick.deposits.values())d.script=['status-processing.json'];
  const out=await engine.cancel(alice,tradeId);
  assert.equal(out.cancelled,false);assert.match(out.reason,/1Click reports PROCESSING/);
  assert.equal(legRows(db,tradeId)[0].send_status,'sending');assert.equal(spent(db),'5000000');
 }
 // A sent leg is tracked, never cancelled.
 {
  const {engine,db}=await privyEngine(fakePrivy());
  const r=await exec(engine,alice,await engine.propose(alice,one));
  const out=await engine.cancel(alice,r.trade_id);
  assert.equal(out.cancelled,false);assert.match(out.reason,/sent/);assert.equal(legRows(db,r.trade_id)[0].send_status,'sent');
 }
});

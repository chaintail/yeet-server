// The Privy signing path (PRIVY-SETUP-REVIEW real_code_mismatches 1-5 and "Not in the setup report"): the real
// delegated adapter and Privy client against fakePrivy (idempotency replay, 400 on a reused key with another body,
// cached 5xx, sponsored empty hash then confirmed), the executor's policy check, the server daily cap across restarts
// and concurrent executes, and the policy printer. No network, no wallet, no funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fakeEngine,fakePrivy,fakePrivyEnv,fakeBalances,fakeOneClick,fakeSigner,fakeClock,BASE_WALLET,SOL_WALLET,FAKE_POLICY_IDS} from './fakes.mjs';
import {createDelegatedSigner,signerAttachment,sendResult} from './signer-privy.mjs';
import {privyErrorCode} from './privy-api.mjs';
import {legIdempotencyKey,USDC_BASE} from './signer.mjs';
import {transitionLeg,tradeEvents,TransitionRefused} from './audit.mjs';
import {openTradeDb} from './db.mjs';
import {REKEY_AFTER_MS} from './executor.mjs';
import {baseAggregation,basePolicy,solanaPolicy,catalogMints,hexAmount} from './policy-create.mjs';
import {CATALOG} from './router.mjs';
import {TOKEN_PROGRAM} from './solana-tx.mjs';

const alice={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
const basket={request_id:'r1',amount_usdc:'20',legs:[{symbol:'WIF',parts:5},{symbol:'BOME',parts:3},{symbol:'TRUMP',parts:2}]};
const one={request_id:'r1',amount_usdc:'10',legs:[{symbol:'WIF',parts:10}]};
const exec=(engine,ctx,p)=>engine.execute(ctx,{proposal_id:p.proposal_id,revision:p.revision,confirm:p.confirm.code});
const legRows=(db,id)=>db.prepare('SELECT * FROM trade_legs WHERE trade_id=? ORDER BY idx').all(id);
const spent=db=>db.prepare('SELECT usdc_raw FROM daily_spend').get()?.usdc_raw;
const KEY='a'.repeat(64);
/** 1Click has not seen any deposit yet (so recovery cannot resolve a leg through 1Click). */
const noDepositSeen=oneclick=>{for(const d of oneclick.deposits.values())d.script=['status-pending.json']};
const SPL={walletId:'wallet-solana',owner:SOL_WALLET,source:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',destinationOwner:'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
 mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',decimals:6,amountRaw:'4000000',tokenProgram:TOKEN_PROGRAM};

/** An engine whose signer is the real delegated Privy adapter over fakePrivy. */
async function privyEngine({privy=fakePrivy(),env={}}={}){
 const balances=fakeBalances();
 const signer=createDelegatedSigner({env:fakePrivyEnv(),fetch:privy.fetch,balances,didFor:id=>id===alice.accountId?'did:privy:alice':undefined});
 const e=await fakeEngine({signer,balances,env:{YEET_LIVE:'1',...env}});
 return {...e,privy};
}

test('Privy error codes: the documented authorization codes are definite refusals; a reused key is a conflict',()=>{
 for(const code of ['zero_correct_authorization_signatures','insufficient_correct_authorization_signatures','missing_or_empty_authorization_header','incorrect_quantity_of_authorization_signatures'])
  for(const status of [400,401,403])assert.equal(privyErrorCode(status,{code,error:'x'}),'PRIVY_AUTHORIZATION_DENIED',`${code} ${status}`);
 assert.equal(privyErrorCode(400,{code:'invalid_data',error:'No valid authorization signatures were provided'}),'PRIVY_AUTHORIZATION_DENIED');
 assert.equal(privyErrorCode(400,{code:'invalid_data',error:'Invalid caip2'}),'PRIVY_HTTP_400','other invalid_data stays a plain 400');
 assert.equal(privyErrorCode(403,{code:'policy_violation'}),'PRIVY_POLICY_DENIED');
 assert.equal(privyErrorCode(400,{error:'Invalid use of idempotency key: the request body differs'}),'PRIVY_IDEMPOTENCY_CONFLICT');
 assert.equal(privyErrorCode(500,{code:'zero_correct_authorization_signatures'}),'PRIVY_HTTP_500','a 5xx is never a refusal');
});

test('adapter: an authorization refusal by documented code is WALLET_NOT_READY and notSent',async()=>{
 const fetch=async()=>new Response(JSON.stringify({code:'zero_correct_authorization_signatures',error:'No valid authorization signatures were provided'}),{status:401});
 const s=createDelegatedSigner({env:fakePrivyEnv(),fetch});
 await assert.rejects(s.transferUsdcBase({walletId:'wallet-base',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'1',idempotencyKey:KEY}),e=>e.code==='WALLET_NOT_READY'&&e.notSent===true);
});

test('adapter: a sponsored Base send answers a Privy transaction id with an empty hash; the hash comes from GET /v1/transactions/{id}',async()=>{
 const privy=fakePrivy({confirmAfter:2});
 const s=createDelegatedSigner({env:fakePrivyEnv(),fetch:privy.fetch});
 const r=await s.transferUsdcBase({walletId:'wallet-base',from:BASE_WALLET,to:'0x'+'22'.repeat(20),amountRaw:'5000000',idempotencyKey:KEY});
 assert.equal(r.txHash,null);assert.equal(r.hashPending,true);assert.match(r.transactionId,/^tx-/);assert.match(r.userOperationHash,/^0x/);
 assert.equal(privy.rpc[0].status,200);
 assert.deepEqual(await s.lookupTransfer({chain:'base',transactionId:r.transactionId}),{state:'pending',txHash:null,transactionId:r.transactionId,status:'broadcasted'});
 const done=await s.lookupTransfer({chain:'base',transactionId:r.transactionId});
 assert.equal(done.state,'confirmed');assert.match(done.txHash,/^0x[0-9a-f]{64}$/);
 assert.deepEqual(await s.lookupTransfer({chain:'base',transactionId:'tx-unknown'}),{state:'none',txHash:null,transactionId:null,status:null});
 const byRef=await s.lookupTransfer({chain:'base',referenceId:KEY});
 assert.equal(byRef.transactionId,r.transactionId,'reference_id (the first key) finds it');
 assert.deepEqual(privy.calls.filter(c=>c.method==='GET').map(c=>c.path.startsWith('/v1/transactions')),[true,true,true,true]);
 assert.throws(()=>sendResult('base',{data:{hash:''}}),e=>e.code==='TEMPORARILY_UNAVAILABLE','no hash and no transaction id is still unconfirmed');
});

test('adapter: Solana stores the built transaction and replays it byte for byte; a rebuild under the same key is the 400 conflict',async()=>{
 const privy=fakePrivy(),balances=fakeBalances();
 const s=createDelegatedSigner({env:fakePrivyEnv(),fetch:privy.fetch,balances});
 let stored;
 const first=await s.transferSpl({...SPL,idempotencyKey:KEY,persistRequest:b=>{stored=b}});
 assert.match(first.txHash,/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
 assert.equal(stored,privy.rpc[0].raw,'the persisted body is the exact body sent');
 assert.equal(JSON.parse(stored).reference_id,KEY);
 const again=await s.transferSpl({...SPL,idempotencyKey:KEY,request:stored,persistRequest:()=>assert.fail('a stored request is never persisted again')});
 assert.deepEqual(again,first);assert.equal(privy.replays,1);assert.equal(privy.rpc[1].raw,privy.rpc[0].raw);
 assert.equal(balances.blockhashes,1,'the replay did not fetch a blockhash or rebuild');
 // Control: a rebuild (new blockhash) under the same key is what the fake refuses with 400.
 await assert.rejects(s.transferSpl({...SPL,idempotencyKey:KEY}),e=>e.keyConflict===true&&e.notSent!==true&&e.code==='TEMPORARILY_UNAVAILABLE');
 assert.equal(privy.conflicts,1);assert.equal(privy.broadcasts.length,1);
 // A persist failure means nothing was sent.
 await assert.rejects(s.transferSpl({...SPL,idempotencyKey:'b'.repeat(64),persistRequest:()=>{throw Error('disk')}}),e=>e.notSent===true);
 assert.equal(privy.rpc.length,3);
});

test('adapter: a 5xx on /rpc is cached against the key (cachedFailure), and the same key answers the same 5xx again',async()=>{
 const privy=fakePrivy({rpcFailures:[{at:0,status:503,accepted:false}]});
 const s=createDelegatedSigner({env:fakePrivyEnv(),fetch:privy.fetch});
 const args={walletId:'wallet-base',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'1000000',idempotencyKey:KEY};
 for(let i=0;i<2;i++)await assert.rejects(s.transferUsdcBase(args),e=>e.cachedFailure===true&&e.privyStatus===503&&e.notSent!==true);
 assert.equal(privy.replays,1);assert.equal(privy.broadcasts.length,0);
 assert.equal((await s.lookupTransfer({chain:'base',referenceId:KEY})).state,'none');
});

test('directory: the signer entry must carry exactly one policy; signerAttachment exposes anything else as a mismatch',()=>{
 const w=ids=>({additional_signers:[{signer_id:'q',override_policy_ids:ids}]});
 assert.equal(signerAttachment(w(['p1']),'q').policyId,'p1');
 assert.equal(signerAttachment(w([]),'q').policyId,null);
 assert.equal(signerAttachment(w(['p1','p2']),'q').policyId,'p1,p2');
 assert.equal(signerAttachment({additional_signers:[{signer_id:'q',override_policy_ids:['p1']},{signer_id:'q',override_policy_ids:['p1']}]},'q').policyId,'p1,p1');
});

test('executor: signing is refused (WALLET_NOT_READY) unless the wallet signer carries exactly the configured policy',async()=>{
 for(const [policyIds,env] of [[{base:'policy-other',solana:FAKE_POLICY_IDS.solana},{}],[{base:null,solana:FAKE_POLICY_IDS.solana},{}],
  [{base:[FAKE_POLICY_IDS.base,'policy-extra'],solana:FAKE_POLICY_IDS.solana},{}],[FAKE_POLICY_IDS,{YEET_BASE_POLICY_ID:''}]]){
  const {engine,privy,db}=await privyEngine({privy:fakePrivy({policyIds}),env});
  const p=await engine.propose(alice,one);
  await assert.rejects(exec(engine,alice,p),e=>e.code==='WALLET_NOT_READY',JSON.stringify(policyIds));
  assert.equal(privy.rpc.length,0,'nothing signed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trades').get().n,0);
 }
 // fake signer adapter: the same check
 const {engine}=await fakeEngine({signer:fakeSigner({policyIds:{base:'policy-1',solana:'policy-1'}})});
 await assert.rejects(exec(engine,alice,await engine.propose(alice,one)),e=>e.code==='WALLET_NOT_READY');
});

test('engine: a sponsored Base send is "sent, hash pending" with the Privy transaction id as evidence, never re-sent; recovery resolves the hash',async()=>{
 const {engine,db,privy,oneclick,now}=await privyEngine({privy:fakePrivy({confirmAfter:2})});
 const p=await engine.propose(alice,basket);
 const r=await exec(engine,alice,p);
 assert.equal(r.status,'submitted');
 assert.deepEqual(r.legs.map(l=>[l.status,l.tx_hash]),[['sent',null],['sent',null],['sent',null]],'accepted by Privy: sent, never "send not confirmed"');
 let legs=legRows(db,r.trade_id);
 assert.deepEqual(legs.map(l=>l.send_status),['sent','sent','sent']);
 assert.ok(legs.every(l=>/^tx-/.test(l.privy_tx_id)&&l.tx_hash===null&&l.deposit_submitted===0));
 assert.ok(legs.every(l=>l.send_request===privy.rpc[l.idx].raw),'the exact body is stored before the send');
 const sentEvents=tradeEvents(db,r.trade_id).filter(e=>e.kind==='leg'&&e.to_status==='sent');
 assert.deepEqual(sentEvents.map(e=>[e.from_status,e.evidence.privy_transaction_id,e.evidence.hash_pending]),legs.map(l=>['sending',l.privy_tx_id,true]));
 assert.equal(oneclick.calls.submit.length,0,'no deposit/submit without a chain hash');
 noDepositSeen(oneclick);
 assert.equal(engine.status(alice,r.trade_id).status,'submitted');
 // Tick 1: GET /v1/transactions/{id} still broadcasted. Tick 2: confirmed, hash recorded, deposit submitted.
 await engine.tracker.pollOnce();
 assert.ok(legRows(db,r.trade_id).every(l=>l.tx_hash===null));
 now.advance(30_000);
 await engine.tracker.pollOnce();
 legs=legRows(db,r.trade_id);
 assert.ok(legs.every(l=>l.tx_hash===privy.txs.get(l.privy_tx_id).chainHash),'the chain hash of each leg\'s own Privy transaction');
 assert.deepEqual(oneclick.calls.submit.map(s=>s.txHash).sort(),legs.map(l=>l.tx_hash).sort());
 const hashEvents=tradeEvents(db,r.trade_id).filter(e=>e.kind==='leg'&&e.from_status==='sent'&&e.to_status==='sent');
 assert.deepEqual(hashEvents.map(e=>[e.evidence.privy_transaction_id,e.evidence.tx_hash,e.evidence.source]),legs.map(l=>[l.privy_tx_id,l.tx_hash,'privy_transaction']));
 assert.equal(privy.rpc.length,3,'one RPC send per leg, ever');assert.equal(privy.broadcasts.length,3);
 assert.equal(spent(db),'20000000');
 await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 assert.equal(privy.rpc.length,3);
});

test('engine: a send whose answer was lost but that Privy accepted is found by reference_id and adopted, not sent again',async()=>{
 const {engine,db,privy,now,oneclick}=await privyEngine({privy:fakePrivy({rpcFailures:[{at:0,status:'timeout',accepted:true}]})});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 noDepositSeen(oneclick);
 let [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sending');assert.equal(r.legs[0].status,'sent');
 now.advance(20_000);
 await engine.tracker.pollOnce();
 [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sent');assert.match(leg.privy_tx_id,/^tx-/);
 assert.equal(privy.rpc.length,1,'found by reference, never re-sent');assert.equal(privy.broadcasts.length,1);
 assert.equal(tradeEvents(db,r.trade_id).find(e=>e.to_status==='sent').evidence.source,'privy_reference');
});

test('engine: a cached 5xx Privy did act on is found by reference at once; the leg is sent with one broadcast',async()=>{
 const {engine,db,privy}=await privyEngine({privy:fakePrivy({rpcFailures:[{at:0,status:500,accepted:true}]})});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 const [leg]=legRows(db,r.trade_id);
 assert.equal(leg.send_status,'sent');assert.match(leg.privy_tx_id,/^tx-/);assert.equal(leg.cached_failure_at,null);
 assert.equal(privy.rpc.length,1);assert.equal(privy.broadcasts.length,1);
});

test('engine: a cached 5xx Privy never acted on: that key is never sent again; after a lookup finds nothing for 60 s, the stored body goes out under a new key, once',async()=>{
 const {engine,db,privy,now,oneclick}=await privyEngine({privy:fakePrivy({rpcFailures:[{at:0,status:502,accepted:false}]})});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 noDepositSeen(oneclick);
 let [leg]=legRows(db,r.trade_id);
 const first=leg.idempotency_key;
 assert.equal(leg.send_status,'sending');assert.ok(leg.cached_failure_at!==null);assert.equal(r.legs[0].status,'sent','a 5xx may follow a broadcast: never reported failed');
 assert.equal(spent(db),'10000000','still counted against the daily cap');
 for(const ms of [20_000,20_000]){now.advance(ms);await engine.tracker.pollOnce()}
 assert.equal(privy.rpc.length,1,'no retry under the key that holds the cached 5xx (no endless loop)');
 now.advance(REKEY_AFTER_MS);
 await engine.tracker.pollOnce();
 [leg]=legRows(db,r.trade_id);
 assert.equal(leg.key_generation,1);assert.equal(leg.idempotency_key,legIdempotencyKey('wallet-base',r.trade_id,0,1));
 assert.equal(privy.rpc.length,2);
 assert.notEqual(privy.rpc[1].key,first);assert.equal(privy.rpc[1].raw,privy.rpc[0].raw,'byte-identical body, same reference_id');
 assert.equal(JSON.parse(privy.rpc[1].raw).reference_id,first);
 assert.equal(leg.send_status,'sent');assert.equal(privy.broadcasts.length,1);
 const rekeyEvent=tradeEvents(db,r.trade_id).find(e=>e.from_status==='sending'&&e.to_status==='sending');
 assert.deepEqual([rekeyEvent.evidence.key_generation,rekeyEvent.evidence.reference_id],[1,first]);
 now.advance(60_000);await engine.tracker.pollOnce();
 assert.equal(privy.rpc.length,2);
});

test('engine: repeated cached 5xx stops after the last key generation; the leg is only looked up from then on',async()=>{
 const {engine,db,privy,now,oneclick}=await privyEngine({privy:fakePrivy({rpcFailures:[0,1,2,3].map(at=>({at,status:500,accepted:false}))})});
 const r=await exec(engine,alice,await engine.propose(alice,one));
 noDepositSeen(oneclick);
 for(let i=0;i<8;i++){now.advance(REKEY_AFTER_MS+1000);await engine.tracker.pollOnce()}
 const [leg]=legRows(db,r.trade_id);
 assert.equal(privy.rpc.length,3,'first key plus two more, then nothing');
 assert.equal(new Set(privy.rpc.map(c=>c.key)).size,3);
 assert.equal(leg.send_status,'sending');assert.equal(leg.key_generation,2);
 assert.match(db.prepare('SELECT last_error FROM trades').get().last_error,/only looked up/);
});

test('audit: sending -> sent accepts a Privy transaction id as evidence; evidence with no hash, status or id is refused',()=>{
 const db=openTradeDb(':memory:');
 db.exec(`INSERT INTO proposals(id,account_id,client_id,request_id,request_sha256,direction,amount_in_raw,slippage_bps,revision,status,created_at,updated_at) VALUES('p','a','c','r','h','yeet','1',100,1,'executing',0,0)`);
 db.exec(`INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES('t','p',1,'a','yeet','signing',0,0)`);
 db.exec(`INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,receipt_leg_json,updated_at) VALUES('t',0,'WIF','1','x','{}','sending','{}',0),('t',1,'WIF','1','y','{}','sending','{}',0)`);
 assert.throws(()=>transitionLeg(db,{tradeId:'t',idx:0,from:'sending',to:'sent',evidence:{source:'signer',hash_pending:true},at:1}),TransitionRefused);
 assert.equal(transitionLeg(db,{tradeId:'t',idx:0,from:'sending',to:'sent',evidence:{source:'signer',privy_transaction_id:'tx-1',hash_pending:true},set:{privy_tx_id:'tx-1'},at:1}),true);
 assert.equal(db.prepare('SELECT send_status s,privy_tx_id p FROM trade_legs WHERE idx=0').get().p,'tx-1');
});

test('daily cap: the server cap is the only daily limit and holds across a restart and concurrent executes',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'yeet-cap-'));
 try{
  const file=path.join(dir,'trade.sqlite'),now=fakeClock(),oneclick=fakeOneClick(),signer=fakeSigner(),balances=fakeBalances({usdc:'500'});
  const shared={now,oneclick,signer,balances};
  const env={YEET_LIVE:'1',YEET_DAILY_CAP_USDC:'50',YEET_MAX_TRADE_USDC:'25'};
  const legs=(id,usdc)=>({request_id:id,amount_usdc:usdc,legs:[{symbol:'WIF',parts:10}]});
  // Before the restart: 30 USDC.
  const a=await fakeEngine({...shared,env,db:openTradeDb(file)});
  await exec(a.engine,alice,await a.engine.propose(alice,legs('a1','20')));
  await exec(a.engine,alice,await a.engine.propose(alice,legs('a2','10')));
  assert.equal(spent(a.db),'30000000');
  a.db.close();
  // Restart: two engines (two connections, as two processes would) on the same file; both previews pass (30 + 15
  // <= 50), both executes run at once: exactly one commits.
  const b=await fakeEngine({...shared,env,db:openTradeDb(file)}),c=await fakeEngine({...shared,env,db:openTradeDb(file)});
  assert.equal(spent(b.db),'30000000','the spend survived the restart');
  const pb=await b.engine.propose(alice,legs('b1','15')),pc=await c.engine.propose(alice,legs('c1','15'));
  const results=await Promise.allSettled([exec(b.engine,alice,pb),exec(c.engine,alice,pc)]);
  assert.deepEqual(results.map(x=>x.status).sort(),['fulfilled','rejected']);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'LIMIT_EXCEEDED');
  assert.equal(spent(b.db),'45000000');
  assert.equal(signer.sent.length,3,'the refused trade signed nothing');
  // Anything over the remaining 5 USDC is refused at preview, and at execute even when previewed earlier.
  await assert.rejects(b.engine.propose(alice,legs('b2','6')),e=>e.code==='LIMIT_EXCEEDED');
  const ok=await b.engine.propose(alice,legs('b3','5'));
  const early=await c.engine.propose(alice,legs('c3','5'));
  await exec(b.engine,alice,ok);
  await assert.rejects(exec(c.engine,alice,early),e=>e.code==='LIMIT_EXCEEDED');
  assert.equal(spent(c.db),'50000000');
  // The next UTC day starts from zero.
  now.advance(24*3600_000);
  await exec(c.engine,alice,await c.engine.propose(alice,legs('d1','25')));
  b.db.close();c.db.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('policy printer: aggregation created on its own, policies owned by the admin quorum, hex amounts, Solana mint allowlist',()=>{
 assert.throws(()=>basePolicy({}),/policy-admin key quorum/);
 const owner='admin-quorum-1';
 const agg=baseAggregation({owner});
 assert.equal(agg.owner_id,owner);assert.equal(agg.method,'eth_signTransaction');assert.deepEqual(agg.window,{type:'rolling',seconds:86400});
 assert.equal(agg.id,undefined,'Privy assigns the aggregation id');
 const p=basePolicy({owner,aggregationId:'agg123'});
 assert.equal(p.owner_id,owner);assert.equal(p.aggregations,undefined,'no inline aggregations');
 assert.deepEqual(p.rules.map(r=>r.method),['eth_sendTransaction','eth_signTransaction']);
 const c=Object.fromEntries(p.rules[0].conditions.map(x=>[x.field,x]));
 assert.equal(c.chain_id.value,'8453');assert.equal(c.to.value,USDC_BASE);assert.equal(c.value.value,'0');assert.equal(c.function_name.value,'transfer');
 assert.deepEqual([c['transfer.amount'].operator,c['transfer.amount'].value],['lte','0x17D7840']);
 assert.deepEqual([c['aggregation.agg123'].field_source,c['aggregation.agg123'].value],['reference','0x2FAF080']);
 assert.equal(hexAmount('50'),'0x2FAF080');
 assert.ok(!basePolicy({owner}).rules[0].conditions.some(x=>x.field_source==='reference'),'no reference without an aggregation id');
 assert.ok(p.rules.every(r=>r.action==='ALLOW'&&r.name.length<50));
 const s=solanaPolicy({owner});
 assert.equal(s.owner_id,owner);assert.equal(s.chain_type,'solana');
 const mints=CATALOG.filter(x=>x.chain==='solana'&&x.address).map(x=>x.address);
 assert.deepEqual(catalogMints(),mints);
 const transfers=s.rules.filter(r=>r.name.includes('transfer-checked'));
 assert.equal(transfers.length,4);
 for(const r of transfers)assert.deepEqual(r.conditions.find(x=>x.field==='TransferChecked.mint'),{field_source:'solana_token_program_instruction',field:'TransferChecked.mint',operator:'in',value:mints});
 assert.deepEqual(JSON.stringify([agg,p,s]).match(/aggregation\.[A-Za-z0-9_-]+/g),['aggregation.agg123','aggregation.agg123'],'only the aggregation id passed in');
});

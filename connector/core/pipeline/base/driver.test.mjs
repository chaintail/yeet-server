// Base driver: user-signed USDC transfer, our just-in-time gas top-up. One test per guard of
// GAS-SPONSORSHIP-DESIGN.md 1.4 (each fails without its guard), then idempotency, replacement and recovery (1.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,parseTransaction,serializeTransaction} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {world,tradeLeg,preparedAndSigned,mine,keyFile,T0,ACCOUNT,DEPOSIT} from './test-support.mjs';
import {attemptIdFor} from './driver.mjs';
import {loadGasWallet} from './gas-wallet.mjs';
import {txFromPayload} from './source-executor.mjs';
import {USDC_BASE} from './config.mjs';

const code=c=>e=>{assert.equal(e.code,c,`expected ${c}, got ${e.code} (${e.message})`);return true};
const topups=w=>w.db.prepare("SELECT * FROM base_attempt WHERE kind='gas_topup' ORDER BY rowid").all();
const transfer=(w,id)=>w.db.prepare('SELECT * FROM base_attempt WHERE id=?').get(id);
/** A loadWallet that counts gas-wallet signatures. */
function counting(){const c={signs:0};return {c,loadWallet:cfg=>{const g=loadGasWallet(cfg);return {address:g.address,async sign(tx){c.signs++;return g.sign(tx)}}}}}

test('prepare returns the pinned USDC transfer: to USDC, transfer(deposit, amount), chain 8453, value 0, no gas spent', async()=>{
 const w=world(),{req}=await preparedAndSigned(w);
 const p=req.payload;
 assert.equal(p.type,'eip1559');assert.equal(p.chainId,8453);assert.equal(p.to,USDC_BASE);assert.equal(p.value,'0');
 assert.equal(p.data,'0xa9059cbb'+DEPOSIT.slice(2).padStart(64,'0')+(5_000_000).toString(16).padStart(64,'0'));
 assert.match(req.payloadSha256,/^[0-9a-f]{64}$/);
 assert.equal(req.expiresAt,T0+10*60_000);
 assert.ok(BigInt(p.gas)<=100_000n);assert.ok(BigInt(p.maxFeePerGas)<=100_000_000n);assert.ok(BigInt(p.maxPriorityFeePerGas)>0n);
 assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(topups(w).length,0);
});

test('happy path: top-up to the user wallet, then the stored user bytes, then the Transfer log confirms', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 const r=await w.driver.submit({...f.args,dryRun:false,now:w.clock.t});
 assert.equal(r.state,'pending');assert.equal(r.txHash,keccak256(f.signed));
 const [t]=topups(w);assert.equal(w.rpc.s.broadcasts.length,1);
 const top=parseTransaction(w.rpc.s.broadcasts[0]);
 assert.equal(top.to.toLowerCase(),w.wallet);assert.equal(top.gas,21000n);assert.equal(top.data??'0x','0x');assert.equal(t.state,'submitted');
 assert.equal(transfer(w,f.attemptId).state,'awaiting_gas');
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 const out=await w.driver.recover({now:w.clock.t+1000});
 assert.deepEqual(out.map(x=>x.state),['sent']);assert.equal(out[0].txHash,keccak256(f.signed));
 assert.equal(w.rpc.s.broadcasts[1],f.signed);
 await mine(w.rpc,f.signed);
 const fin=await w.driver.recover({now:w.clock.t+2000});
 assert.deepEqual(fin.map(x=>[x.state,x.tradeId,x.legIdx]),[['confirmed',f.trade.id,0]]);
 const row=transfer(w,f.attemptId);assert.equal(row.state,'confirmed');
 const led=JSON.parse(w.db.prepare('SELECT snapshot FROM base_gas_ledger WHERE wallet=?').get(w.wallet).snapshot);
 assert.equal(led.charges.length,1);assert.equal(led.reservations.length,0);assert.equal(led.topups.length,1);
 assert.ok(BigInt(row.gas_paid_raw)<=BigInt(row.needed_raw));
});

test('no top-up when the wallet already holds enough ETH: the user bytes go out at once', async()=>{
 const w=world();w.rpc.s.balance[w.wallet]=10n**16n;
 const f=await preparedAndSigned(w),r=await w.driver.submit({...f.args,dryRun:false});
 assert.equal(r.state,'sent');assert.deepEqual(w.rpc.s.broadcasts,[f.signed]);assert.equal(topups(w).length,0);
});

test('dry run is the default: bytes validated, top-up planned, nothing signed, persisted or broadcast', async()=>{
 const g=counting(),w=world({loadWallet:g.loadWallet,env:{YEET_LIVE:'0'}}),f=await preparedAndSigned(w);
 const r=await w.driver.submit(f.args);
 assert.equal(r.dryRun,true);assert.equal(r.txHash,keccak256(f.signed));assert.ok(r.topup.amount>0n);
 assert.ok(r.blocked.includes('TRADING_PAUSED'));
 assert.equal(g.c.signs,0);assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(transfer(w,f.attemptId).state,'prepared');
});

// ---- guard 1: kill switch, live flag, allowlist, YEET_BASE_PAUSE, read again just before signing
for(const [name,env,c] of [['kill switch',{YEET_KILL_SWITCH:'1'},'TRADING_PAUSED'],['live flag off',{YEET_LIVE:'0'},'TRADING_PAUSED'],
 ['account not allowlisted',{YEET_LIVE_ACCOUNTS:'yeet-privy-someoneelse'},'TRADING_PAUSED'],['Base paused',{YEET_BASE_PAUSE:'1'},'SOURCE_PAUSED']]){
 test(`guard 1: ${name} refuses ${c} before any gas-wallet signature`, async()=>{
  const g=counting(),w=world({loadWallet:g.loadWallet}),f=await preparedAndSigned(w);
  Object.assign(w.env,env);
  await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code(c));
  assert.equal(g.c.signs,0);assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(transfer(w,f.attemptId).state,'prepared');
 });
}
test('guard 1: a pause raised during the awaited reads is read again immediately before the top-up is signed', async()=>{
 const g=counting(),w=world({loadWallet:g.loadWallet}),f=await preparedAndSigned(w);
 w.rpc.s.hooks.nonce=(a,tag)=>{if(a===w.gas.address&&tag==='pending')w.env.YEET_BASE_PAUSE='1'};
 const r=await w.driver.submit({...f.args,dryRun:false});
 assert.equal(r.state,'pending');assert.equal(g.c.signs,0);assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(topups(w).length,0);
});

// ---- guard 2: leg identity
test('guard 2: another account, another wallet or a swapped deposit address is SOURCE_IDENTITY_MISMATCH', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await assert.rejects(w.driver.submit({...f.args,trade:{...f.trade,account_id:'yeet-privy-other'},dryRun:false}),code('SOURCE_IDENTITY_MISMATCH'));
 await assert.rejects(w.driver.submit({...f.args,wallet:'0x'+'22'.repeat(20),dryRun:false}),code('SOURCE_IDENTITY_MISMATCH'));
 await assert.rejects(w.driver.submit({...f.args,leg:{...f.leg,deposit_address:'0x'+'33'.repeat(20)},dryRun:false}),code('SOURCE_IDENTITY_MISMATCH'));
 await assert.rejects(w.driver.submit({...f.args,leg:{...f.leg,amount_in_raw:'4000000'},dryRun:false}),code('SOURCE_IDENTITY_MISMATCH'));
 assert.equal(w.rpc.s.broadcasts.length,0);
});

// ---- guard 3: validateSigned pins every field and the signer
test('guard 3: each tampered field, a foreign signer, a non-empty access list and a high-s twin are SIGNED_SOURCE_MISMATCH', async()=>{
 const w=world(),f=await preparedAndSigned(w),tx=txFromPayload(f.req.payload);
 const other=privateKeyToAccount(generatePrivateKey());
 const variants=[
  await w.userAccount.signTransaction({...tx,value:1n}),
  await w.userAccount.signTransaction({...tx,to:'0x'+'44'.repeat(20)}),
  await w.userAccount.signTransaction({...tx,data:'0xa9059cbb'+'55'.repeat(32)+tx.data.slice(74)}),
  await w.userAccount.signTransaction({...tx,data:tx.data.slice(0,74)+(1n).toString(16).padStart(64,'0')}),
  await w.userAccount.signTransaction({...tx,nonce:tx.nonce+1}),
  await w.userAccount.signTransaction({...tx,gas:tx.gas+1n}),
  await w.userAccount.signTransaction({...tx,maxFeePerGas:tx.maxFeePerGas+1n}),
  await w.userAccount.signTransaction({...tx,maxPriorityFeePerGas:tx.maxPriorityFeePerGas+1n}),
  await w.userAccount.signTransaction({...tx,chainId:1}),
  await w.userAccount.signTransaction({...tx,accessList:[{address:USDC_BASE,storageKeys:[]}]}),
  await other.signTransaction(tx),
  'not-hex','0x02',
 ];
 const p=parseTransaction(f.signed),N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
 variants.push(serializeTransaction(tx,{r:p.r,s:'0x'+(N-BigInt(p.s)).toString(16).padStart(64,'0'),yParity:p.yParity?0:1}));
 for(const v of variants)await assert.rejects(w.driver.submit({...f.args,signed:v,dryRun:false}),code('SIGNED_SOURCE_MISMATCH'));
 assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(transfer(w,f.attemptId).state,'prepared');
});
test('guard 3: a stored attempt whose transaction no longer pays the leg deposit address is refused', async()=>{
 const w=world(),f=await preparedAndSigned(w),row=transfer(w,f.attemptId),tx=JSON.parse(row.tx_json);
 tx.data='0xa9059cbb'+'0'.repeat(24)+'66'.repeat(20)+tx.data.slice(74);
 w.db.prepare('UPDATE base_attempt SET tx_json=? WHERE id=?').run(JSON.stringify(tx),f.attemptId);
 const signed=await w.userAccount.signTransaction(txFromPayload({...f.req.payload,data:tx.data}));
 await assert.rejects(w.driver.submit({...f.args,signed,dryRun:false}),code('SIGNED_SOURCE_MISMATCH'));
});

// ---- guard 4: window and caps
test('guard 4: a signature after expires_at returns expired SIGN_EXPIRED and never tops up', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 const r=await w.driver.submit({...f.args,dryRun:false,now:T0+10*60_000+1});
 assert.equal(r.state,'expired');assert.equal(r.code,'SIGN_EXPIRED');assert.equal(w.rpc.s.broadcasts.length,0);
 assert.equal(transfer(w,f.attemptId).state,'cancelled');
});
test('guard 4: prepare refuses when the deposit deadline leaves no signing window', async()=>{
 const w=world(),{trade,leg}=tradeLeg({deadline:T0+119_000});
 await assert.rejects(w.driver.prepare({trade,leg,wallet:w.wallet,attemptId:attemptIdFor(trade.id,0,0)}),code('SIGN_EXPIRED'));
});
for(const [name,env,c,spend] of [['over max trade',{YEET_MAX_TRADE_USDC:'4'},'LIMIT_EXCEEDED'],['under min leg',{YEET_MIN_LEG_USDC:'6'},'AMOUNT_TOO_SMALL'],
 ['over the daily cap',{YEET_DAILY_CAP_USDC:'10'},'LIMIT_EXCEEDED','11000000']]){
 test(`guard 4: ${name} is ${c}`, async()=>{
  const w=world(),f=await preparedAndSigned(w);
  Object.assign(w.env,env);
  if(spend)w.db.prepare('INSERT INTO daily_spend(account_id,day,usdc_raw) VALUES(?,?,?)').run(ACCOUNT,'2026-11-13',spend);
  await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code(c));assert.equal(w.rpc.s.broadcasts.length,0);
 });
}

// ---- guard 5: wallet code, USDC principal, nonce
test('guard 5: a wallet with contract code is refused WALLET_HAS_CODE', async()=>{
 const w=world(),f=await preparedAndSigned(w);w.rpc.s.code[w.wallet]='0xef0100'+'77'.repeat(20);
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('WALLET_HAS_CODE'));assert.equal(w.rpc.s.broadcasts.length,0);
});
test('guard 5: USDC balance under the amount is PRINCIPAL_SHORT', async()=>{
 const w=world(),f=await preparedAndSigned(w);w.rpc.s.token[w.wallet]=4_999_999n;
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('PRINCIPAL_SHORT'));assert.equal(w.rpc.s.broadcasts.length,0);
});
test('guard 5: a consumed nonce cancels the attempt NONCE_CHANGED, leg not_sent, reservation released', async()=>{
 const w=world(),f=await preparedAndSigned(w);w.rpc.s.latest[w.wallet]=1;
 const r=await w.driver.submit({...f.args,dryRun:false});
 assert.equal(r.state,'not_sent');assert.equal(r.code,'NONCE_CHANGED');assert.equal(w.rpc.s.broadcasts.length,0);
 assert.equal(transfer(w,f.attemptId).state,'cancelled');assert.equal(transfer(w,f.attemptId).signed_raw,null);
});
test('guard 5: prepare refuses a wallet with contract code before any sign request exists', async()=>{
 const w=world(),{trade,leg}=tradeLeg();w.rpc.s.code[w.wallet]='0x6080';
 await assert.rejects(w.driver.prepare({trade,leg,wallet:w.wallet,attemptId:attemptIdFor(trade.id,0,0)}),code('WALLET_HAS_CODE'));
});

// ---- guard 6: eth_call simulation
test('guard 6: transfer simulation returning false or reverting is SIMULATION_FAILED', async()=>{
 for(const s of [{call:'0x'+'0'.repeat(64)},{callError:true},{call:'0x'}]){
  const w=world(),f=await preparedAndSigned(w);Object.assign(w.rpc.s,s);
  await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('SIMULATION_FAILED'));assert.equal(w.rpc.s.broadcasts.length,0);
 }
});

// ---- guard 7: gas and fee budget
test('guard 7: user gas over 100,000 or a gas price over the cap is refused at prepare', async()=>{
 for(const s of [{estimate:90_000n},{gasPrice:100_000_001n}]){
  const w=world();Object.assign(w.rpc.s,s);const {trade,leg}=tradeLeg();
  await assert.rejects(w.driver.prepare({trade,leg,wallet:w.wallet,attemptId:attemptIdFor(trade.id,0,0)}),code('INVALID_TRANSACTION_BUDGET'));
 }
});
test('guard 7: a fee cap lowered after prepare refuses the signed transfer; a top-up fee over the cap is refused', async()=>{
 const a=world(),fa=await preparedAndSigned(a);a.env.YEET_BASE_MAX_FEE_WEI='1000';a.rpc.s.balance[a.wallet]=10n**16n;
 await assert.rejects(a.driver.submit({...fa.args,dryRun:false}),code('INVALID_TRANSACTION_BUDGET'));
 const b=world(),fb=await preparedAndSigned(b);b.rpc.s.gasPrice=200_000_000n;
 await assert.rejects(b.driver.submit({...fb.args,dryRun:false}),code('INVALID_TRANSACTION_BUDGET'));
 assert.equal(a.rpc.s.broadcasts.length+b.rpc.s.broadcasts.length,0);
});

// ---- guard 8: gas wallet identity and the top-up shape
test('guard 8: gas wallet unset, key file mode 0644, or key for another address is GAS_WALLET_NOT_CONFIGURED', async()=>{
 const loose=keyFile(undefined,0o644),other=keyFile();
 for(const env of [{YEET_BASE_GAS_WALLET:''},{YEET_BASE_GAS_WALLET_KEY_FILE:loose.file,YEET_BASE_GAS_WALLET:loose.address},{YEET_BASE_GAS_WALLET_KEY_FILE:other.file}]){
  const w=world(),f=await preparedAndSigned(w);Object.assign(w.env,env);
  await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('GAS_WALLET_NOT_CONFIGURED'));assert.equal(w.rpc.s.broadcasts.length,0);
  assert.equal(w.driver.readiness().ok,false);assert.ok(w.driver.readiness().reasons.includes('GAS_WALLET_NOT_CONFIGURED'));
 }
});
test('guard 8: the user wallet may not be the gas wallet, even when the key file matches it', async()=>{
 const key=generatePrivateKey(),same=keyFile(key),w=world({user:key});
 Object.assign(w.env,{YEET_BASE_GAS_WALLET:same.address,YEET_BASE_GAS_WALLET_KEY_FILE:same.file});
 const f=await preparedAndSigned(w);
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('GAS_WALLET_NOT_CONFIGURED'));
 assert.equal(w.rpc.s.broadcasts.length,0);
});
// ---- races: state that changes during the awaited gas-wallet nonce read is caught at the atomic insert
for(const [name,flip,c] of [
 ['a gas wallet swapped mid-flight',w=>{const o=keyFile();Object.assign(w.env,{YEET_BASE_GAS_WALLET:o.address,YEET_BASE_GAS_WALLET_KEY_FILE:o.file})},'GAS_WALLET_NOT_CONFIGURED'],
 ['a per-wallet cap lowered mid-flight',w=>{w.env.YEET_BASE_TOPUP_CAP_RAW='1000'},'TOPUP_CAP_EXCEEDED'],
 ['the account day count reaching 10 mid-flight',w=>{w.db.prepare('INSERT INTO base_topup_day(day,account_id,count,wei_raw) VALUES(?,?,?,?)').run('2026-11-13',ACCOUNT,10,'0')},'TOPUP_CAP_EXCEEDED'],
]){
 test(`race: ${name} is refused ${c} before the top-up is stored or broadcast`, async()=>{
  const w=world(),f=await preparedAndSigned(w);let once=false;
  w.rpc.s.hooks.nonce=(a,tag)=>{if(!once&&a===w.gas.address&&tag==='pending'){once=true;flip(w)}};
  const r=await w.driver.submit({...f.args,dryRun:false});
  assert.deepEqual([r.state,r.code],['not_sent',c]);assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(topups(w).length,0);
 });
}
test('race: a top-up that went live elsewhere mid-flight makes this one wait, unstored and unsent', async()=>{
 const w=world(),f=await preparedAndSigned(w);let once=false;
 w.rpc.s.hooks.nonce=(a,tag)=>{if(!once&&a===w.gas.address&&tag==='pending'){once=true;
  w.db.prepare("INSERT INTO base_attempt(id,kind,trade_id,leg_idx,account_id,wallet,sender,nonce,tx_json,state,signed_raw,tx_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .run('topup:t_other:0:0','gas_topup','t_other',0,ACCOUNT,'0x'+'12'.repeat(20),w.gas.address,0,'{"value":"1","gas":"21000","maxFeePerGas":"1","maxPriorityFeePerGas":"1"}','submitted','0x02','0x'+'ab'.repeat(32),0,0)}};
 const r=await w.driver.submit({...f.args,dryRun:false});
 assert.equal(r.state,'pending');assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(topups(w).length,1);
});
test('guard 8: signed top-up bytes that do not parse back to the prepared top-up are never stored or broadcast', async()=>{
 const w=world({loadWallet:cfg=>{const g=loadGasWallet(cfg);return {address:g.address,sign:tx=>g.sign({...tx,to:'0x'+'88'.repeat(20)})}}});
 const f=await preparedAndSigned(w);
 const r=await w.driver.submit({...f.args,dryRun:false});
 assert.deepEqual([r.state,r.code],['not_sent','GAS_WALLET_NOT_CONFIGURED']);
 assert.equal(w.rpc.s.broadcasts.length,0);assert.equal(topups(w).length,0);assert.equal(transfer(w,f.attemptId).state,'cancelled');
});

// ---- guard 9: per-wallet cumulative cap
test('guard 9: the per-wallet cumulative top-up cap refuses TOPUP_CAP_EXCEEDED', async()=>{
 const w=world({env:{YEET_BASE_TOPUP_CAP_RAW:'500000000000'}}),f=await preparedAndSigned(w);
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('TOPUP_CAP_EXCEEDED'));assert.equal(w.rpc.s.broadcasts.length,0);
});
test('guard 9: earlier confirmed top-ups count against the cap', async()=>{
 const w=world({env:{YEET_BASE_TOPUP_CAP_RAW:'2500000000000'}});
 const f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);await w.driver.recover({now:T0+1000});
 await mine(w.rpc,f.signed);await w.driver.recover({now:T0+2000});
 w.rpc.s.balance[w.wallet]=0n;
 const g=await preparedAndSigned(w,{tradeId:'t_bbbbbbbbbbbbbbbbbbbb'});
 await assert.rejects(w.driver.submit({...g.args,dryRun:false}),code('TOPUP_CAP_EXCEEDED'));
});

// ---- guard 10 (new): global daily cap and 10 top-ups per account per day
test('guard 10: the global daily top-up cap refuses TOPUP_CAP_EXCEEDED', async()=>{
 const w=world({env:{YEET_BASE_TOPUP_GLOBAL_DAILY_RAW:'1000000000000'}}),f=await preparedAndSigned(w);
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('TOPUP_CAP_EXCEEDED'));assert.equal(w.rpc.s.broadcasts.length,0);
});
test('guard 10: the 11th top-up for one account on one UTC day is refused', async()=>{
 const w=world({env:{YEET_MAX_TRADE_USDC:'25',YEET_DAILY_CAP_USDC:'999'}});
 w.db.prepare('INSERT INTO base_topup_day(day,account_id,count,wei_raw) VALUES(?,?,?,?)').run('2026-11-13',ACCOUNT,10,'1');
 const f=await preparedAndSigned(w);
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('TOPUP_CAP_EXCEEDED'));assert.equal(w.rpc.s.broadcasts.length,0);
});

// ---- guard 11: gas wallet floor
test('guard 11: a gas wallet that would drop under the floor refuses TOPUP_UNAVAILABLE and alerts once; refill alerts recovery', async()=>{
 const w=world(),f=await preparedAndSigned(w);w.rpc.s.balance[w.gas.address]=500_000_000_000_000n;
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('TOPUP_UNAVAILABLE'));
 await assert.rejects(w.driver.submit({...f.args,dryRun:false}),code('TOPUP_UNAVAILABLE'));
 assert.deepEqual(w.alerts.map(a=>a.kind),['gas_wallet_low']);assert.equal(w.rpc.s.broadcasts.length,0);
 w.rpc.s.balance[w.gas.address]=2_000_000_000_000_000n;
 assert.equal((await w.driver.submit({...f.args,dryRun:false})).state,'pending');
 assert.deepEqual(w.alerts.map(a=>a.kind),['gas_wallet_low','gas_wallet_recovered']);
});

// ---- guard 12: one top-up in flight, at most 3 failures per leg
test('guard 12: a second trade waits while a top-up is in flight; no second gas-wallet nonce or signature is used', async()=>{
 const g=counting(),w=world({loadWallet:g.loadWallet}),a=await preparedAndSigned(w);
 await w.driver.submit({...a.args,dryRun:false});
 const other=privateKeyToAccount(generatePrivateKey());
 const {trade,leg}=tradeLeg({tradeId:'t_cccccccccccccccccccc'}),id=attemptIdFor(trade.id,0,0);
 w.rpc.s.token[other.address.toLowerCase()]=20_000_000n;
 const req=await w.driver.prepare({trade,leg,wallet:other.address,attemptId:id});
 const signed=await other.signTransaction(txFromPayload(req.payload));
 const r=await w.driver.submit({trade,leg,wallet:other.address,attemptId:id,signed,dryRun:false});
 assert.equal(r.state,'pending');assert.equal(topups(w).length,1);assert.equal(w.rpc.s.broadcasts.length,1);assert.equal(g.c.signs,1);
 assert.equal(transfer(w,id).state,'awaiting_gas');
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 await w.driver.recover({now:T0+1000});
 assert.equal(topups(w).length,2);assert.equal(parseTransaction(topups(w)[1].signed_raw).nonce,1);
});
test('guard 12: after 3 failed top-ups for the leg the attempt ends TOPUP_ATTEMPTS_EXHAUSTED', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 await w.driver.submit({...f.args,dryRun:false});
 for(let i=0;i<3;i++){
  const last=topups(w).at(-1);await mine(w.rpc,last.signed_raw,{success:false});
  const out=await w.driver.recover({now:T0+1000*(i+1)});
  if(i<2)assert.equal(topups(w).length,i+2);else assert.deepEqual(out.map(x=>[x.state,x.code]),[['not_sent','TOPUP_ATTEMPTS_EXHAUSTED']]);
 }
 assert.equal(topups(w).filter(t=>t.state==='failed').length,3);assert.equal(transfer(w,f.attemptId).state,'cancelled');
});

// ---- 1.5 idempotency, replacement, uncertainty, deadline
test('resubmitting the same bytes returns the stored hash with no second top-up; other bytes are SOURCE_ATTEMPT_BLOCKED', async()=>{
 const g=counting(),w=world({loadWallet:g.loadWallet}),f=await preparedAndSigned(w);
 const r1=await w.driver.submit({...f.args,dryRun:false}),r2=await w.driver.submit({...f.args,dryRun:false});
 assert.equal(r2.txHash,r1.txHash);assert.equal(r2.state,'pending');assert.equal(g.c.signs,1);assert.equal(topups(w).length,1);
 const other=await w.userAccount.signTransaction({...txFromPayload(f.req.payload),maxPriorityFeePerGas:2n});
 await assert.rejects(w.driver.submit({...f.args,signed:other,dryRun:false}),code('SOURCE_ATTEMPT_BLOCKED'));
});
test('an unmined top-up is replaced at the same nonce with both fees raised at least 12.5%, the old one never resent', async()=>{
 const w=world(),f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 const first=parseTransaction(w.rpc.s.broadcasts[0]);
 await w.driver.recover({now:T0+31_000});
 const rows=topups(w);assert.equal(rows.length,2);assert.equal(rows[0].replaced_by,rows[1].id);
 const second=parseTransaction(rows[1].signed_raw);
 assert.equal(second.nonce,first.nonce);assert.equal(second.value,first.value);
 assert.ok(second.maxFeePerGas*1000n>=first.maxFeePerGas*1125n);assert.ok(second.maxPriorityFeePerGas*1000n>=first.maxPriorityFeePerGas*1125n);
 const sent=w.rpc.s.broadcasts.length;
 await w.driver.recover({now:T0+32_000});
 assert.ok(!w.rpc.s.broadcasts.slice(sent).includes(rows[0].signed_raw));
 await mine(w.rpc,rows[1].signed_raw);await w.driver.recover({now:T0+33_000});
 const after=topups(w);assert.equal(after[1].state,'confirmed');assert.equal(after[0].state,'failed');assert.equal(after[0].code,'SUPERSEDED_SIBLING');
 assert.equal(w.rpc.s.broadcasts.at(-1),f.signed);
});
test('replacement whose raised fee passes YEET_BASE_TOPUP_REPLACE_MAX_FEE_WEI is not signed; the stored bytes are replayed', async()=>{
 const w=world({rpc:{gasPrice:60_000_000n},env:{YEET_BASE_TOPUP_REPLACE_MAX_FEE_WEI:'100000000'}}),f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 await w.driver.recover({now:T0+31_000});
 assert.equal(topups(w).length,1);assert.equal(w.rpc.s.broadcasts.length,2);assert.equal(w.rpc.s.broadcasts[1],w.rpc.s.broadcasts[0]);
});
test('replacement over the per-wallet cap is not signed, alerts once, and the stored bytes keep replaying', async()=>{
 const w=world(),f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 const t=parseTransaction(w.rpc.s.broadcasts[0]);
 w.env.YEET_BASE_TOPUP_CAP_RAW=String(t.value+21000n*t.maxFeePerGas+w.rpc.s.l1);
 await w.driver.recover({now:T0+31_000});await w.driver.recover({now:T0+62_000});
 assert.equal(topups(w).length,1);assert.equal(w.alerts.filter(a=>a.kind==='gas_topup_replace_capped').length,1);
 assert.equal(w.rpc.s.broadcasts.length,3);
});
test('replacement over the global daily cap is not signed', async()=>{
 const w=world(),f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 w.env.YEET_BASE_TOPUP_GLOBAL_DAILY_RAW=w.db.prepare('SELECT wei_raw FROM base_topup_day').get().wei_raw;
 await w.driver.recover({now:T0+31_000});
 assert.equal(topups(w).length,1);
});
test('a lost broadcast leaves the top-up uncertain; recovery replays the same bytes', async()=>{
 const w=world(),f=await preparedAndSigned(w);w.rpc.s.broadcastError='socket hang up';
 const r=await w.driver.submit({...f.args,dryRun:false});assert.equal(r.state,'pending');
 assert.equal(topups(w)[0].state,'uncertain');
 w.rpc.s.broadcastError=null;await w.driver.recover({now:T0+1000});
 assert.equal(w.rpc.s.broadcasts.length,2);assert.equal(w.rpc.s.broadcasts[1],w.rpc.s.broadcasts[0]);assert.equal(topups(w)[0].state,'submitted');
});
test('awaiting gas past deadline - 120 s ends not_sent without broadcasting the user bytes', async()=>{
 const w=world(),f=await preparedAndSigned(w,{deadline:T0+10*60_000});await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 const out=await w.driver.recover({now:T0+10*60_000-119_000});
 assert.deepEqual(out.map(x=>x.state),['not_sent']);assert.ok(!w.rpc.s.broadcasts.includes(f.signed));
});
test('a receipt without the pinned Transfer log ends failed', async()=>{
 const w=world();w.rpc.s.balance[w.wallet]=10n**16n;
 const f=await preparedAndSigned(w);await w.driver.submit({...f.args,dryRun:false});
 await mine(w.rpc,f.signed,{logs:[]});
 const out=await w.driver.recover({now:T0+1000});
 assert.deepEqual(out.map(x=>[x.state,x.code]),[['failed','TRANSFER_LOG_MISSING']]);
});
test('two legs from one wallet get sequential nonces; leg 2 waits for leg 1 and its top-up covers both transfers', async()=>{
 const w=world();
 const a=await preparedAndSigned(w,{idx:0}),b=await preparedAndSigned(w,{idx:1,deposit:'0x'+'99'.repeat(20)});
 assert.equal(a.req.payload.nonce,0);assert.equal(b.req.payload.nonce,1);
 await w.driver.submit({...a.args,dryRun:false});
 assert.equal((await w.driver.submit({...b.args,dryRun:false})).state,'pending');
 assert.equal(topups(w).length,1);
 await mine(w.rpc,w.rpc.s.broadcasts[0]);
 const out=await w.driver.recover({now:T0+1000});
 assert.deepEqual(out.map(x=>[x.legIdx,x.state]),[[0,'sent']]);assert.equal(topups(w).length,2);
 const bal=w.rpc.s.balance[w.wallet],second=parseTransaction(topups(w)[1].signed_raw);
 assert.ok(bal+second.value>=BigInt(transfer(w,a.attemptId).needed_raw)+BigInt(transfer(w,b.attemptId).needed_raw));
 await mine(w.rpc,topups(w)[1].signed_raw);
 const out2=await w.driver.recover({now:T0+2000});
 assert.deepEqual(out2.map(x=>[x.legIdx,x.state]),[[1,'sent']]);
 assert.deepEqual([w.rpc.s.broadcasts[1],w.rpc.s.broadcasts[3]],[a.signed,b.signed]);
});
test('prepare is idempotent for the same attempt id and refuses a forged attempt number', async()=>{
 const w=world(),f=await preparedAndSigned(w);
 const again=await w.driver.prepare({trade:f.trade,leg:f.leg,wallet:w.wallet,attemptId:f.attemptId});
 assert.equal(again.payloadSha256,f.req.payloadSha256);
 await assert.rejects(w.driver.prepare({trade:f.trade,leg:f.leg,wallet:w.wallet,attemptId:f.attemptId,attemptNo:5}),code('SOURCE_IDENTITY_MISMATCH'));
 assert.equal(attemptIdFor('t_x',0,1).length,64);
});
test('readiness is ok with a configured gas wallet and reports a pause', async()=>{
 const w=world();assert.deepEqual(w.driver.readiness(),{ok:true,reasons:[]});
 w.env.YEET_BASE_PAUSE='1';assert.deepEqual(w.driver.readiness().reasons,['SOURCE_PAUSED']);
});

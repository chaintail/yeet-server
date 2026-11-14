// Fixed vectors for the NEAR Intents direct path. Where a vector comes from is named next to it: the contract's own
// unit tests (near/intents dbad9c8), near-api-js's serialisation tests (999eeee), and one public mainnet transaction
// (fixtures/mainnet-omni-withdrawal.json). No network, no keys of ours.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {base58Encode} from '../trade/router.mjs';
import {localSigner,verifySolanaSignedTransaction} from '../pipeline/solana/verify.mjs';
import {decodeTransaction,resolvedInstructions,TOKEN_PROGRAM,ATA_PROGRAM,COMPUTE_BUDGET_PROGRAM,USDC_SOLANA,associatedTokenAddress} from '../pipeline/solana/message.mjs';
import {hex,unhex,curved,uncurved,b64,u128} from './codec.mjs';
import {buildNonce,parseNonce} from './nonce.mjs';
import {ed25519AccountId,evmAccountId,secp256k1AccountId,erc191Hash,intentHash,verifyMultiPayload,rawEd25519Payload,erc191Payload,nep413Payload,nep413Hash,rawEd25519Signer,erc191Signer,nep413Signer} from './sign.mjs';
import {feeCeil,receivedFor,giveFor,mirrorDiff,unmatched,tokenDiff,contractOf,omniStorageAccountId,omniWithdrawToSolana,poaWithdraw,payloadString,nep413Message,signIntents} from './intents.mjs';
import {classifyPanic,panicMessage,createNearRpc,createVerifier,NearRpcError} from './verifier.mjs';
import {encodeTransaction,functionCall,transfer,signTransaction,loadOrCreateNearKey,transactionStatus} from './near-tx.mjs';
import {basketCoins,splitEven,basketDiffs,buildBasketTrade,quoteLegs} from './basket.mjs';
import {signerStorageNeeded,reservedTgas,maxWithdrawals,createOmni} from './omni.mjs';
import {buildSelfPaidTransaction,signedTokenTransfer,fundVia1Click} from './funding.mjs';
import {privySignBody,multiPayloadFromPrivy} from './wallet-adapter.mjs';
import {sendNearOnce,stepTrade,stepSetup,stepRegisterOmni,stepStock,stepDepositUser,stepStatus,stepWithdrawAll,createLiveContext,runStep} from './live.mjs';
import {parseArgs} from '../../../ops/intents-direct-spike.mjs';
import {evmAddress,createTestWalletFile} from '../pipeline/test-wallet.mjs';

const FIX=JSON.parse(readFileSync(new URL('./fixtures/mainnet-omni-withdrawal.json',import.meta.url),'utf8'));
const USDC='nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';
const WIF='nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near';
const BOME='nep141:sol-57d087fd8c460f612f8701f5499ad8b2eec5ab68.omft.near';
const TRUMP='nep141:sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near';
const SALT='252812b3';
// fixed test keys (public test material, never funded)
const ED_SEED=Uint8Array.from({length:32},(_,i)=>i+1);
const EVM_KEY=Uint8Array.from({length:32},(_,i)=>0x40+i);

// ---------- nonce ----------
test('nonce: the layout of a real mainnet nonce (magic, version, salt, nanosecond deadline, 15 random bytes)',()=>{
 const real=FIX.signed[1].payload.nonce; // the intent's own deadline is 2026-12-13T16:45:34.736Z
 const p=parseNonce(real);
 assert.equal(p.versioned,true);
 assert.equal(p.saltHex,SALT);
 assert.equal(new Date(p.deadlineMs).toISOString(),JSON.parse(FIX.signed[1].payload.message).deadline);
 assert.equal(buildNonce({saltHex:p.saltHex,deadlineMs:p.deadlineMs,random:unhex(p.randomHex)}),real);
});
test('nonce: fixed bytes',()=>{
 const n=buildNonce({saltHex:SALT,deadlineMs:1_800_000_000_000,random:new Uint8Array(15).fill(1)});
 // 1.8e18 ns = 0x18fae27693b40000, little-endian
 assert.equal(hex(Buffer.from(n,'base64')),'5628f6c600'+'252812b3'+'0000b49376e2fa18'+'01'.repeat(15));
 assert.ok(n.startsWith('Vij2xgAlKBKz'),'every docs example nonce starts like this');
 assert.deepEqual(parseNonce(b64(new Uint8Array(32))),{versioned:false});
 assert.throws(()=>buildNonce({saltHex:'2528',deadlineMs:1,random:new Uint8Array(15)}),/salt is 4 bytes/);
 assert.throws(()=>buildNonce({saltHex:SALT,deadlineMs:1,random:new Uint8Array(14)}),/15 bytes/);
});

// ---------- accounts ----------
test('implicit account ids (contracts/defuse/core/src/public_key.rs tests)',()=>{
 assert.equal(ed25519AccountId('5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJugxm'),'423df0a6640e9467769c55a573f15b9ee999dc8970048959c72890abf5cc3a8e');
 const key=uncurved('secp256k1','secp256k1:3aMVMxsoAnHUbweXMtdKaN1uJaNwsfKv7wnc97SDGjXhyK62VyJwhPUPLZefKVthcoUcuWK6cqkSU4M542ipNxS3',64);
 assert.equal(secp256k1AccountId(key),'0xbff77166b39599e54e391156eef7b8191e02be92');
 assert.equal(evmAccountId('0xBfF77166b39599E54e391156eEF7b8191e02bE92'),'0xbff77166b39599e54e391156eef7b8191e02be92','the verifier account is the LOWERCASE address');
 assert.throws(()=>ed25519AccountId('5TagutioHgKLh7KZ1VEFBYfgRkPtqnKm9LoMnJMJ'),/32 bytes/);
});

// ---------- signing standards ----------
test('raw_ed25519: the contract\'s own vector (core/src/payload/multi.rs test)',async()=>{
 const p={standard:'raw_ed25519',payload:'{"signer_id":"74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751","verifying_contract":"intents.near","deadline":{"timestamp":1732035219},"nonce":"XVoKfmScb3G+XqH9ke/fSlJ/3xO59sNhCxhpG821BH8=","intents":[{"intent":"token_diff","diff":{"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near":"-1000","nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near":"998"}}]}',
  public_key:'ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN',signature:'ed25519:3vtbNQJHZfuV1s5DykzyjkbNLc583hnkrhTz57eDhd966iqzkor6Twgr4Loh2C195SCSEsiGfrd6KcxpjNq9ZbVj'};
 assert.equal(intentHash(p),'8LKE47o44ybZQR9ozLyDnvMDTh4Ao5ipy2mJWsYByG5Q');
 const v=await verifyMultiPayload(p);
 assert.equal(v.publicKey,p.public_key);
 assert.equal(v.accountId,'74affa71ab030d400fdfa1bed033dfa6fd3ae34f92d17c046ebe368e80d53751');
 await assert.rejects(verifyMultiPayload({...p,payload:p.payload.replace('"998"','"999"')}),/invalid signature/);
});
test('erc191: the contract\'s own vector (crates/signatures/erc191 test) and the v byte',async()=>{
 const key=unhex('85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b801f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68');
 const sig=unhex('7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e4701');
 const v=await verifyMultiPayload({standard:'erc191',payload:'Hello world!',signature:curved('secp256k1',sig)});
 assert.equal(v.publicKey,curved('secp256k1',key));
 assert.equal(v.accountId,secp256k1AccountId(key));
 // what personal_sign returns ends in 1b/1c (27/28); the contract wants 00/01
 const personal='0x'+hex(sig.subarray(0,64))+'1c';
 const mp=await erc191Payload('Hello world!',v.accountId,personal);
 assert.equal(hex(uncurved('secp256k1',mp.signature,65)),hex(sig));
 assert.equal(erc191Hash('Hello world!').length,32);
 await assert.rejects(erc191Payload('Hello world?',v.accountId,personal),/does not recover the wallet address/);
 await assert.rejects(erc191Payload('Hello world!',v.accountId,'0x'+hex(sig.subarray(0,64))+'1f'),/recovery id/);
});
test('nep413: the contract\'s own vector (crates/signatures/nep413 test)',async()=>{
 const address=base58Encode(unhex('e2e9cb7ac57cb46d4da1ce1d1cc2c33bdfe17407c517916b522724a8ea2c6c50'));
 const sig=unhex('e2ff6254871a3fec1853c167b42f0f14248c4cf7fef5452dc24d8dbdc5c4bf183ab707322b4d782d5f5a05571bae476c5f7ee41c473f3002e600865e46b75d0f');
 const mp=nep413Payload({message:'Hello, world!',nonce:b64(new Uint8Array(32)),recipient:'intents.near'},address,sig);
 assert.equal((await verifyMultiPayload(mp)).publicKey,`ed25519:${address}`);
 assert.throws(()=>nep413Payload({message:'Hello, world?',nonce:b64(new Uint8Array(32)),recipient:'intents.near'},address,sig),/does not verify/);
});
test('nep413: two payloads the mainnet contract executed verify here and hash to the intent_hash it logged',async()=>{
 for(const [i,mp] of FIX.signed.entries()){
  await verifyMultiPayload(mp);
  assert.equal(intentHash(mp),FIX.intents_executed[i].intent_hash);
 }
});
test('local signers: each standard signs what the contract verifies; a key signs for its own implicit account',async()=>{
 const ed=localSigner(ED_SEED),raw=rawEd25519Signer(ed);
 assert.equal(raw.accountId,hex(uncurved('ed25519',raw.publicKey,32)));
 const a=await raw.sign('{"x":1}');
 assert.deepEqual(Object.keys(a),['standard','payload','public_key','signature']);
 assert.equal((await verifyMultiPayload(a)).accountId,raw.accountId);
 const evm=erc191Signer({address:evmAddress(EVM_KEY),privateKey:()=>Uint8Array.from(EVM_KEY)});
 const b=await evm.sign('{"x":1}');
 assert.deepEqual(Object.keys(b),['standard','payload','signature'],'erc191 carries no public key');
 assert.ok(uncurved('secp256k1',b.signature,65)[64]<=1);
 assert.equal((await verifyMultiPayload(b)).accountId,evmAddress(EVM_KEY).toLowerCase());
 const sol=nep413Signer(ed);
 const c=await sol.sign({message:'{"x":1}',nonce:b64(new Uint8Array(32))});
 assert.equal(c.payload.recipient,'intents.near');
 assert.equal((await verifyMultiPayload(c)).accountId,sol.accountId);
 // a wallet that signs something other than the raw bytes is caught before anything is submitted
 assert.throws(()=>rawEd25519Payload('{"x":1}',ed.address,ed.signMessage(Buffer.from('prefix{"x":1}'))),/does not verify over the raw payload bytes/);
});
test('wallet adapter: the Privy call per standard, and the wire object from its answer (27/28 becomes 0/1)',async()=>{
 const payload='{"signer_id":"x","intents":[]}';
 assert.deepEqual(privySignBody('erc191',payload),{method:'personal_sign',chain_type:'ethereum',params:{message:payload,encoding:'utf-8'}});
 assert.deepEqual(privySignBody('raw_ed25519',payload),{method:'signMessage',chain_type:'solana',params:{message:Buffer.from(payload).toString('base64'),encoding:'base64'}});
 assert.throws(()=>privySignBody('nep413',payload),/no wallet call/);
 // what a wallet answers: viem's signMessage is personal_sign; node's ed25519 is a Solana signMessage
 const {privateKeyToAccount}=await import('viem/accounts');
 const signature=await privateKeyToAccount(`0x${hex(EVM_KEY)}`).signMessage({message:payload});
 assert.ok(['1b','1c'].includes(signature.slice(-2)));
 const a=await multiPayloadFromPrivy('erc191',payload,evmAddress(EVM_KEY),{signature,encoding:'hex'});
 assert.ok(uncurved('secp256k1',a.signature,65)[64]<=1);
 assert.equal((await verifyMultiPayload(a)).accountId,evmAddress(EVM_KEY).toLowerCase());
 const ed=localSigner(ED_SEED);
 const b=await multiPayloadFromPrivy('raw_ed25519',payload,ed.address,{signature:Buffer.from(ed.signMessage(Buffer.from(payload))).toString('base64'),encoding:'base64'});
 assert.equal((await verifyMultiPayload(b)).accountId,ed25519AccountId(ed.address));
 await assert.rejects(multiPayloadFromPrivy('raw_ed25519',payload,ed.address,{signature:Buffer.from(ed.signMessage(Buffer.from('other'))).toString('base64')}),/does not verify/);
 await assert.rejects(multiPayloadFromPrivy('erc191',payload,evmAddress(EVM_KEY),{}),/no signature/);
});
test('nep413 prehash: the optional callback url is part of the hash, and the nonce must be 32 bytes',()=>{
 const h=nep413Hash({message:'m',nonce:new Uint8Array(32),recipient:'intents.near'});
 assert.equal(h.length,32);
 assert.notEqual(hex(h),hex(nep413Hash({message:'m',nonce:new Uint8Array(32),recipient:'intents.near',callbackUrl:''})));
 assert.throws(()=>nep413Hash({message:'m',nonce:new Uint8Array(31),recipient:'intents.near'}),/32 bytes/);
});

// ---------- fee arithmetic ----------
test('fees: the research map\'s 10 USDC example nets to zero at 1 pip',()=>{
 const user={[USDC]:-10_000_000n,[WIF]:22_265_977n,[BOME]:5_780_994_219n,[TRUMP]:3_029_996n};
 const solver={[USDC]:9_999_990n,[WIF]:-22_266_000n,[BOME]:-5_781_000_000n,[TRUMP]:-3_030_000n};
 assert.deepEqual(unmatched([user,solver],1),{});
 assert.deepEqual(mirrorDiff(user,1),solver);
 assert.equal(feeCeil(10_000_000n,1),10n);
 assert.equal(feeCeil(22_266_000n,1),23n);
 assert.deepEqual(unmatched([user],1),{[USDC]:-9_999_990n,[WIF]:22_265_977n,[BOME]:5_780_994_219n,[TRUMP]:3_029_996n});
});
test('fees: giveFor is the exact inverse of receivedFor for every fee the contract allows in practice',()=>{
 for(const fee of [0n,1n,100n,10_000n,500_000n])for(const want of [1n,2n,999n,1_000_000n,1_000_001n,22_265_977n,10n**24n+7n]){
  const s=giveFor(want,fee);
  assert.equal(receivedFor(s,fee),want,`fee ${fee} want ${want}`);
  if(s>1n)assert.ok(receivedFor(s-1n,fee)<want,'smallest such amount');
 }
 assert.throws(()=>giveFor(0n,1n),/positive/);
});

// ---------- intents ----------
test('token_diff: prefixed ids, string amounts, sorted keys, no zero delta',()=>{
 const t=tokenDiff({[WIF]:5n,[USDC]:-7n});
 assert.deepEqual(t,{intent:'token_diff',diff:{[USDC]:'-7',[WIF]:'5'}});
 assert.deepEqual(Object.keys(t.diff),[USDC,WIF]);
 assert.throws(()=>tokenDiff({[WIF]:0n}),/zero delta/);
 assert.throws(()=>tokenDiff({'sol-b9c6.omft.near':1n}),/nep141:/);
 assert.throws(()=>tokenDiff({}),/empty/);
 assert.equal(contractOf(WIF),'sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near');
});
test('Omni withdrawal: the storage account and the two intents of a real mainnet withdrawal, byte for byte',()=>{
 const real=JSON.parse(FIX.signed[1].payload.message).intents;
 const ev=FIX.omni.init_transfer_event;
 assert.equal(omniStorageAccountId({token:ev.token,amount:ev.amount,recipient:ev.recipient,fee:ev.fee.fee,nativeFee:ev.fee.native_fee,sender:ev.sender,msg:ev.msg,externalId:'6cdbe483-3a8e-47f8-aa2a-959932a9dd19'}),FIX.omni.storage_account_id);
 const w=omniWithdrawToSolana({tokenId:WIF,amount:19716532n,recipient:'3pdbUF2a37ANMsnvCHK4PdtvHCnxobF81ULE3rht8mVq',nativeFee:2865329513034496051232n,feeMode:'intent',externalId:'6cdbe483-3a8e-47f8-aa2a-959932a9dd19'});
 assert.equal(w.storageAccountId,FIX.omni.storage_account_id);
 assert.deepEqual(w.intents,[real[0],real[1]]);
 assert.equal(JSON.stringify(w.intents[0]),JSON.stringify(real[0]),'same key order as the protocol\'s own frontend');
 assert.equal(JSON.stringify(w.intents[1]),JSON.stringify(real[1]));
 // 'signer' mode: the same ft_withdraw alone; the NEAR transaction signer's bridge balance pays the fee
 const s=omniWithdrawToSolana({tokenId:WIF,amount:19716532n,recipient:'3pdbUF2a37ANMsnvCHK4PdtvHCnxobF81ULE3rht8mVq',nativeFee:2865329513034496051232n,feeMode:'signer',externalId:'6cdbe483-3a8e-47f8-aa2a-959932a9dd19'});
 assert.deepEqual(s.intents,[real[1]]);
 assert.equal(s.intents[0].memo,undefined,'no WITHDRAW_TO memo on the Omni route');
 assert.throws(()=>omniWithdrawToSolana({tokenId:WIF,amount:1n,recipient:'0xabc',nativeFee:1n}),/32 bytes/);
 assert.notEqual(omniStorageAccountId({token:ev.token,amount:ev.amount,recipient:ev.recipient,nativeFee:ev.fee.native_fee,externalId:'other'}),FIX.omni.storage_account_id);
});
test('PoA withdrawal shape (Base USDC and other tokens still on the PoA bridge)',()=>{
 assert.deepEqual(poaWithdraw({tokenId:'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',amount:5n,address:'0x00000000000000000000000000000000000000aa'}),
  {intent:'ft_withdraw',token:'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',receiver_id:'base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',amount:'5',memo:'WITHDRAW_TO:0x00000000000000000000000000000000000000aa',min_gas:'17050000000000'});
});
test('payload: the signed string is compact JSON with the five envelope fields; nep413 keeps nonce and recipient outside',async()=>{
 const intents=[tokenDiff({[WIF]:1n})];
 const s=payloadString({signerId:'a'.repeat(64),deadline:'2026-11-13T18:00:00.000Z',nonce:'AAAA',intents});
 assert.equal(s,`{"signer_id":"${'a'.repeat(64)}","verifying_contract":"intents.near","deadline":"2026-11-13T18:00:00.000Z","nonce":"AAAA","intents":[{"intent":"token_diff","diff":{"${WIF}":"1"}}]}`);
 assert.deepEqual(Object.keys(JSON.parse(nep413Message({signerId:'x.near',deadline:'d',intents}))),['deadline','intents','signer_id']);
 const ed=localSigner(ED_SEED);
 const r=await signIntents(rawEd25519Signer(ed),{intents,deadlineMs:1_800_000_000_000,saltHex:SALT,random:new Uint8Array(15)});
 const body=JSON.parse(r.signed.payload);
 assert.equal(body.signer_id,hex(uncurved('ed25519',`ed25519:${ed.address}`,32)));
 assert.equal(body.deadline,'2027-01-15T08:00:00.000Z');
 assert.equal(parseNonce(body.nonce).deadlineMs,1_800_000_000_000);
 const n=await signIntents(nep413Signer(ed),{intents,deadlineMs:1_800_000_000_000,saltHex:SALT,random:new Uint8Array(15)});
 assert.equal(n.signed.payload.nonce,body.nonce);
 assert.equal(JSON.parse(n.signed.payload.message).nonce,undefined);
 await assert.rejects(signIntents(rawEd25519Signer(ed),{intents:[],deadlineMs:1,saltHex:SALT}),/no intents/);
});

// ---------- verifier client ----------
test('simulate_intents errors: the contract\'s words are found in both RPC shapes and mapped to the failing check',()=>{
 const a='wasm execution failed with error: HostError(GuestPanic { panic_msg: "insufficient balance or overflow" })';
 assert.equal(panicMessage(a),'insufficient balance or overflow');
 const b=JSON.stringify({name:'HANDLER_ERROR',cause:{name:'CONTRACT_EXECUTION_ERROR',info:{vm_error:'wasm execution failed with error: HostError(GuestPanic { panic_msg: "public key \'secp256k1:abc\' doesn\'t exist for account \'0xab\'" })'}}});
 assert.match(panicMessage(b),/doesn't exist for account/);
 const cases={'invalid signature':'INVALID_SIGNATURE','deadline has expired':'DEADLINE_EXPIRED','nonce was already used':'NONCE_USED','nonce was already expired':'NONCE_EXPIRED','invalid salt':'INVALID_SALT',
  'deadline is greater than nonce':'DEADLINE_GREATER_THAN_NONCE','insufficient balance or overflow':'INSUFFICIENT_BALANCE','wrong verifying_contract':'WRONG_VERIFYING_CONTRACT',
  "public key 'x' doesn't exist for account 'y'":'PUBLIC_KEY_NOT_EXIST','Failed to deserialize input from JSON. Error: `unknown variant `bogus``':'BAD_ENCODING','something new':'UNKNOWN'};
 for(const [msg,code] of Object.entries(cases))assert.equal(classifyPanic(msg).code,code,msg);
 assert.equal(classifyPanic('insufficient balance or overflow').stage,'intent_execution');
});
test('verifier client: a panic, an unbalanced batch and a clean batch are three different answers',async()=>{
 const answers=[];
 const fetch=async(url,init)=>{
  const body=JSON.parse(init.body);
  assert.equal(body.params.account_id,'intents.near');
  const result=answers.shift();
  return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,result})};
 };
 const v=createVerifier({rpc:createNearRpc({urls:['http://rpc.invalid'],fetch})});
 const ok=o=>({result:[...Buffer.from(JSON.stringify(o))]});
 answers.push({error:'wasm execution failed with error: HostError(GuestPanic { panic_msg: "invalid signature" })',logs:[]});
 assert.deepEqual(await v.simulate([]),{ok:false,stage:'signature',code:'INVALID_SIGNATURE',message:'invalid signature'});
 answers.push(ok({intents_executed:[],logs:[],min_deadline:'x',invariant_violated:{error:'unmatched_deltas',unmatched_deltas:{a:'1'}},state:{fee:1,current_salt:SALT}}));
 const r=await v.simulate([]);
 assert.equal(r.code,'INVARIANT_VIOLATED');assert.equal(r.output.state.current_salt,SALT);
 answers.push(ok({intents_executed:[{intent_hash:'h'}],logs:[],min_deadline:'x',state:{fee:1,current_salt:SALT}}));
 assert.equal((await v.simulate([])).ok,true);
 answers.push(ok(['5','0']));
 assert.deepEqual(await v.balances('a',['t1','t2']),[5n,0n]);
});

// ---------- NEAR transaction ----------
test('NEAR transaction bytes: near-api-js vectors (test/unit/transactions/serialize.test.ts, data/transaction1.json)',()=>{
 assert.equal(hex(encodeTransaction({signerId:'test.near',publicKey:'Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC',nonce:1n,receiverId:'whatever.near',blockHash:'244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM',actions:[transfer(1n)]})),
  '09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000');
 // a function call, from the multi-action vector: functionCall('qqq', [1,2,3], 1000, 1000000)
 assert.equal(hex(functionCall({method:'qqq',args:Uint8Array.of(1,2,3),gas:1000n,deposit:1_000_000n})),'020300000071717103000000010203e80300000000000040420f00000000000000000000000000');
 // a whole function-call transaction
 const data='0000000000795cb7b5f57222e742d1759092f0e20071a0cd2bf30e1f681d800e67935e168801000000000000001000000073747564696f2d76776375396534316d4def837b838543990f3380af8e2a3817ddf70fe9960135b2add25a679b2a01ed01000000020a0000006164644d6573736167650b0000007b2274657874223a22227d80841e000000000000000000000000000000000000000000';
 assert.equal(hex(encodeTransaction({signerId:'',publicKey:base58Encode(unhex('795cb7b5f57222e742d1759092f0e20071a0cd2bf30e1f681d800e67935e1688')),nonce:1n,receiverId:'studio-vwcu9e41m',
  blockHash:base58Encode(unhex('4def837b838543990f3380af8e2a3817ddf70fe9960135b2add25a679b2a01ed')),actions:[functionCall({method:'addMessage',args:{text:''},gas:2_000_000n})]})),data);
 assert.equal(hex(u128(2865329513034496051232n)),'20882340f05a6f549b00000000000000','u128 little-endian (0x9b546f5af040238820)');
});
test('NEAR transaction signature: ed25519 over sha256 of the bytes; the hash is the transaction id',async()=>{
 const key=localSigner(ED_SEED);
 const tx={signerId:hex(uncurved('ed25519',`ed25519:${key.address}`,32)),publicKey:key.address,nonce:7n,receiverId:'intents.near',blockHash:'244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM',
  actions:[functionCall({method:'execute_intents',args:{signed:[]},gas:300_000_000_000_000n})]};
 const s=signTransaction(tx,key);
 const body=encodeTransaction(tx);
 assert.equal(s.bytes.length,body.length+65);
 assert.equal(s.bytes[body.length],0,'ed25519 signature tag');
 const {createHash,createPublicKey,verify}=await import('node:crypto');
 const digest=createHash('sha256').update(body).digest();
 assert.equal(s.hash,base58Encode(digest));
 const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(uncurved('ed25519',`ed25519:${key.address}`,32))]),format:'der',type:'spki'});
 assert.equal(verify(null,digest,pub,s.bytes.subarray(body.length+1)),true);
 assert.throws(()=>signTransaction({...tx,publicKey:'Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC'},key),/not the signing key/);
});
test('NEAR key file: created 0600, never overwritten, reloads to the same implicit account',()=>{
 const dir=mkdtempSync(join(tmpdir(),'intents-key-')),path=join(dir,'sub','near.json');
 const a=loadOrCreateNearKey(path);
 assert.equal(a.created,true);
 assert.equal(statSync(path).mode&0o777,0o600);
 assert.match(a.accountId,/^[0-9a-f]{64}$/);
 assert.equal(a.publicKey,`ed25519:${a.address}`);
 const b=loadOrCreateNearKey(path);
 assert.equal(b.created,false);assert.equal(b.accountId,a.accountId);
 const loose=join(dir,'loose.json');writeFileSync(loose,readFileSync(path),{mode:0o644});
 assert.throws(()=>loadOrCreateNearKey(loose),/mode 0600/);
 const j=JSON.parse(readFileSync(path,'utf8'));
 assert.deepEqual(Object.keys(j.near).sort(),['account_id','address','seed_base64']);
});
test('transaction status: a failed receipt makes the outcome false; nothing executed yet is null',async()=>{
 const mk=result=>({call:async()=>result});
 const pending=await transactionStatus(mk({final_execution_status:'INCLUDED',receipts_outcome:[]}),'h','a');
 assert.equal(pending.ok,null);
 const good=await transactionStatus(mk({final_execution_status:'EXECUTED_OPTIMISTIC',transaction_outcome:{outcome:{status:{SuccessReceiptId:'r'},gas_burnt:1}},receipts_outcome:[{id:'r',outcome:{executor_id:'intents.near',status:{SuccessValue:''},logs:['EVENT_JSON:{"event":"intents_executed"}'],gas_burnt:2}}]}),'h','a');
 assert.equal(good.ok,true);assert.equal(good.gasBurnt,'3');
 const bad=await transactionStatus(mk({final_execution_status:'FINAL',receipts_outcome:[{id:'r',outcome:{executor_id:'intents.near',status:{Failure:{ActionError:{kind:'x'}}},logs:[],gas_burnt:2}}]}),'h','a');
 assert.equal(bad.ok,false);assert.match(bad.failure,/ActionError/);
});

// ---------- basket ----------
const LEGS=[{symbol:'WIF',tokenId:WIF,mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',decimals:6,usdcIn:1_500_000n,quotedOut:9_898_008n},
 {symbol:'BOME',tokenId:BOME,mint:'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',decimals:6,usdcIn:1_500_000n,quotedOut:2_618_383_984n},
 {symbol:'TRUMP',tokenId:TRUMP,mint:'6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',decimals:6,usdcIn:1_500_000n,quotedOut:1_361_892n}];
test('basket: coins come from the catalogue; PENGU (an omdep token) is refused',()=>{
 assert.deepEqual(basketCoins('WIF,BOME,TRUMP').map(c=>c.tokenId),[WIF,BOME,TRUMP]);
 assert.deepEqual(basketCoins('$WIF').map(c=>c.symbol),['WIF']);
 assert.throws(()=>basketCoins('PENGU'),/Omni route|unknown coin/);
 assert.throws(()=>basketCoins('USDC'),/unknown coin/);
 assert.throws(()=>basketCoins('WIF,WIF'),/twice/);
 assert.deepEqual(splitEven(4_500_000n,3),[1_500_000n,1_500_000n,1_500_000n]);
 assert.deepEqual(splitEven(10n,3),[4n,3n,3n]);
});
test('basket diffs: the solver keeps its margin, the contract its fee, and every token nets to zero',()=>{
 const d=basketDiffs({legs:LEGS,feePips:1,marginBps:100});
 assert.equal(d.userDiff[USDC],-4_500_000n);
 assert.equal(d.solverDiff[USDC],4_499_995n);
 assert.deepEqual(d.legs.map(l=>[l.solverGives,l.userReceives]),[[9_799_027n,9_799_017n],[2_592_200_144n,2_592_197_551n],[1_348_273n,1_348_271n]]);
 assert.deepEqual(unmatched([d.userDiff,d.solverDiff],1),{});
 const w=basketDiffs({legs:LEGS,feePips:1,wnearForUser:180_000_000_000_000_000_000_000n});
 assert.equal(w.userDiff['nep141:wrap.near'],180_000_000_000_000_000_000_000n);
 assert.equal(w.solverDiff['nep141:wrap.near'],-180_000_180_000_180_000_180_001n);
 assert.deepEqual(unmatched([w.userDiff,w.solverDiff],1),{});
 assert.throws(()=>basketDiffs({legs:LEGS,feePips:1,marginBps:5000}),/margin/);
});
test('basket trade: ONE user payload holds the diff and every withdrawal; both sides verify for their own accounts',async()=>{
 const ed=localSigner(ED_SEED),solverKey=localSigner(Uint8Array.from({length:32},(_,i)=>200-i));
 const fees=[60_000_000_000_000_000_000_000n,60_000_000_000_000_000_000_001n,60_000_000_000_000_000_000_002n];
 for(const user of [rawEd25519Signer(ed),erc191Signer({address:evmAddress(EVM_KEY),privateKey:()=>Uint8Array.from(EVM_KEY)})]){
  const t=await buildBasketTrade({user,solver:nep413Signer(solverKey),legs:LEGS,recipient:ed.address,bridgeFees:fees,feePips:1,saltHex:SALT,deadlineMs:1_800_000_000_000});
  assert.equal(t.signed.length,2);
  assert.deepEqual(t.signed.map(s=>s.standard),['nep413',user.standard]);
  assert.equal((await verifyMultiPayload(t.signed[0])).accountId,nep413Signer(solverKey).accountId);
  assert.equal((await verifyMultiPayload(t.signed[1])).accountId,user.accountId);
  const body=JSON.parse(t.signed[1].payload);
  assert.deepEqual(body.intents.map(i=>i.intent),['token_diff','ft_withdraw','ft_withdraw','ft_withdraw']);
  assert.equal(body.verifying_contract,'intents.near');
  body.intents.slice(1).forEach((w,i)=>{
   assert.equal(w.receiver_id,'omni.bridge.near');
   assert.equal(w.token,contractOf(LEGS[i].tokenId));
   assert.equal(w.amount,body.intents[0].diff[LEGS[i].tokenId],'the withdrawal spends exactly what the diff credits');
   const m=JSON.parse(w.msg);
   assert.equal(m.recipient,`sol:${ed.address}`);assert.equal(m.native_token_fee,fees[i].toString());assert.equal(m.fee,'0');
  });
  const solverBody=JSON.parse(t.signed[0].payload.message);
  assert.deepEqual(solverBody.intents.map(i=>i.intent),['token_diff']);
  assert.notEqual(t.user.nonce,t.solver.nonce);
 }
 const t=await buildBasketTrade({user:rawEd25519Signer(ed),solver:nep413Signer(solverKey),legs:LEGS,recipient:ed.address,bridgeFees:fees,feePips:1,saltHex:SALT,deadlineMs:1_800_000_000_000,feeMode:'intent'});
 const intents=JSON.parse(t.signed[1].payload).intents;
 assert.deepEqual(intents.map(i=>i.intent),['token_diff','storage_deposit','ft_withdraw','storage_deposit','ft_withdraw','storage_deposit','ft_withdraw']);
 assert.equal(intents[0].diff['nep141:wrap.near'],(fees[0]+fees[1]+fees[2]).toString());
 assert.equal(intents[1].deposit_for_account_id,t.withdrawals[0].storageAccountId);
 assert.equal(signerStorageNeeded({nativeFees:fees,transferStorage:4_690_000_000_000_000_000_000n,feeMode:'intent'}),3n*4_690_000_000_000_000_000_000n);
 assert.equal(signerStorageNeeded({nativeFees:fees,transferStorage:4_690_000_000_000_000_000_000n,feeMode:'signer'}),3n*4_690_000_000_000_000_000_000n+fees[0]+fees[1]+fees[2]);
});

test('Omni client: fee request, transfer record and route check read what the bridge answers',async()=>{
 const seen=[];
 const fetch=async url=>{seen.push(String(url));
  if(String(url).includes('/transfer-fee'))return {ok:true,json:async()=>({native_token_fee:'60129337138809237667840',transferred_token_fee:null,usd_fee:0.21})};
  return {ok:true,json:async()=>({transfers:[{status:'Settled',token_id:'near:t',amount:'5',recipient:'sol:x',initialised:{timestamp_seconds:1794586634},finalised:{chain:'Sol',transaction_hash:'S',timestamp_seconds:1794586702}}]})}};
 const views={get_bridged_token:'sol:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',storage_balance_of:{total:'1',available:'0'},get_token_decimals:{decimals:6,origin_decimals:6}};
 const omni=createOmni({rpc:{view:async(a,m)=>views[m]},fetch});
 assert.deepEqual(await omni.fee({tokenId:WIF,recipient:DEPOSIT,amount:9_898_008n}),{nativeFee:60129337138809237667840n,usd:0.21});
 assert.ok(seen[0].startsWith('https://mainnet.api.bridge.nearone.org/api/v3/transfer-fee?sender=near%3Aintents.near&recipient=sol%3A'));
 assert.ok(seen[0].endsWith('&token=near%3Asol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near&amount=9898008'));
 assert.deepEqual(await omni.transfers('H'),[{status:'Settled',token:'near:t',amount:'5',recipient:'sol:x',initialisedAt:1794586634,solanaTx:'S',finalisedAt:1794586702}]);
 assert.equal((await omni.route({tokenId:WIF,mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'})).ok,true);
 assert.equal((await omni.route({tokenId:WIF,mint:'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'})).ok,false,'another mint');
 views.storage_balance_of=null;
 assert.equal((await omni.route({tokenId:WIF,mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'})).ok,false,'bridge not registered on the token');
 assert.equal(reservedTgas(3,'signer'),157.2);
 assert.deepEqual([maxWithdrawals('signer'),maxWithdrawals('intent')],[5,3]);
});

// ---------- funding (Solana transfer + 1Click), with fakes ----------
const BLOCKHASH=base58Encode(Uint8Array.from({length:32},(_,i)=>i+3));
const DEPOSIT=localSigner(Uint8Array.from({length:32},(_,i)=>90+i)).address;
function fakeSolana({held=10_000_000n,destExists=false,lamports=10_000_000}={}){
 const sent=[];
 return {sent,
  accountInfo:async a=>a===USDC_SOLANA?{owner:TOKEN_PROGRAM,lamports:1}:(destExists?{owner:TOKEN_PROGRAM,lamports:1}:null),
  tokenBalance:async()=>held,latestBlockhash:async()=>({blockhash:BLOCKHASH,lastValidBlockHeight:'100'}),blockhashValid:async()=>true,
  balance:async()=>lamports,broadcast:async b=>{sent.push(Uint8Array.from(b));return 'sig'}};
}
test('self-paid Solana transfer: one signer, strict wire format, the wallet\'s signature verifies',async()=>{
 const wallet=localSigner(ED_SEED),rpc=fakeSolana();
 const t=await signedTokenTransfer({rpc,wallet,to:DEPOSIT,amount:2_000_000n,blockhash:BLOCKHASH});
 const tx=decodeTransaction(t.bytes);
 assert.deepEqual(tx.message.header,{signers:1,readonlySigned:0,readonlyUnsigned:6});
 assert.equal(tx.message.accounts[0],wallet.address);
 const ix=resolvedInstructions(tx.message);
 assert.deepEqual(ix.map(i=>i.program),[COMPUTE_BUDGET_PROGRAM,COMPUTE_BUDGET_PROGRAM,ATA_PROGRAM,TOKEN_PROGRAM]);
 const dest=associatedTokenAddress(DEPOSIT,USDC_SOLANA,TOKEN_PROGRAM);
 assert.deepEqual(ix[3].accounts,[associatedTokenAddress(wallet.address,USDC_SOLANA,TOKEN_PROGRAM),USDC_SOLANA,dest,wallet.address]);
 assert.equal(Buffer.from(ix[3].data).readBigUInt64LE(1),2_000_000n);
 assert.equal(t.signature,base58Encode(tx.signatures[0]));
 const unsigned=Uint8Array.from(t.bytes);unsigned.fill(0,1,65);
 assert.deepEqual(verifySolanaSignedTransaction(unsigned,t.bytes,wallet.address),{signature:t.signature});
 assert.throws(()=>buildSelfPaidTransaction({payer:wallet.address,blockhash:BLOCKHASH,instructions:[{programAddress:TOKEN_PROGRAM,data:Uint8Array.of(1),accounts:[{address:DEPOSIT,signer:true}]}]}),/only the payer may sign/);
 assert.equal(t.createsAccount,true);
 const t2=await signedTokenTransfer({rpc:fakeSolana({destExists:true}),wallet,to:DEPOSIT,amount:2_000_000n,blockhash:BLOCKHASH});
 assert.equal(resolvedInstructions(decodeTransaction(t2.bytes).message).length,3,'no account creation when the deposit token account exists');
 await assert.rejects(signedTokenTransfer({rpc:fakeSolana({held:1n}),wallet,to:DEPOSIT,amount:2_000_000n,blockhash:BLOCKHASH}),/holds 1 raw units/);
});
function fakeOneClick(){
 const calls={quote:[],submit:[],status:0};
 return {calls,authenticated:false,
  quote:async req=>{calls.quote.push(req);return {correlationId:`c${calls.quote.length}`,quote:{depositAddress:DEPOSIT,amountIn:req.amount,amountOut:'13145119',minAmountOut:'13013667',deadline:req.deadline}}},
  submitDeposit:async(a,h)=>{calls.submit.push([a,h]);return {}},
  status:async()=>{calls.status++;return {status:calls.status<2?'PROCESSING':'SUCCESS',swapDetails:{amountOut:'13100000'}}}};
}
test('funding leg: quote, pay, report; a second run pays nothing and asks for no new quote',async()=>{
 const wallet=localSigner(ED_SEED),rpc=fakeSolana(),client=fakeOneClick(),lines=[];
 let saves=0,t=Date.parse('2026-11-13T17:00:00Z');
 const args={label:'stock_WIF',client,rpc,signatureStatus:async()=>({status:'confirmed'}),wallet,request:{destinationAsset:WIF,amount:2_000_000n,recipient:'a'.repeat(64),recipientType:'INTENTS'},
  emit:l=>lines.push(l),save:()=>{saves++},now:()=>t+=1000,sleep:async()=>{}};
 const state={};
 const r=await fundVia1Click({...args,state});
 assert.equal(r.status,'SUCCESS');
 assert.equal(client.calls.quote.length,1);
 assert.deepEqual({...client.calls.quote[0],deadline:null},{dry:false,swapType:'EXACT_INPUT',slippageTolerance:100,originAsset:USDC,depositType:'ORIGIN_CHAIN',destinationAsset:WIF,amount:'2000000',
  refundTo:wallet.address,refundType:'ORIGIN_CHAIN',recipient:'a'.repeat(64),recipientType:'INTENTS',deadline:null});
 assert.equal(rpc.sent.length,1);
 assert.deepEqual(client.calls.submit,[[DEPOSIT,state.solana_tx]]);
 assert.equal(state.solana_tx,base58Encode(decodeTransaction(rpc.sent[0]).signatures[0]));
 assert.ok(saves>=4,'saved before each irreversible stage');
 assert.deepEqual(lines.map(l=>l.stage),['quoted','transfer_sent','solana_confirmed','oneclick_status','oneclick_status']);
 assert.ok(!JSON.stringify(lines).includes(Buffer.from(ED_SEED).toString('base64')));
 await fundVia1Click({...args,state});
 assert.equal(client.calls.quote.length,1);assert.equal(rpc.sent.length,1);
 assert.equal(lines.at(-1).stage,'already_done');
});
test('funding leg: a transfer that was signed and saved is found again, not signed twice',async()=>{
 const wallet=localSigner(ED_SEED),rpc=fakeSolana(),client=fakeOneClick();
 let t=Date.parse('2026-11-13T17:00:00Z'),confirmed=false;
 const args={label:'deposit_user',client,rpc,signatureStatus:async()=>({status:confirmed?'confirmed':'not_found'}),wallet,request:{destinationAsset:USDC,amount:4_500_000n,recipient:'b'.repeat(64),recipientType:'INTENTS'},
  save:()=>{},now:()=>t+=30_000,sleep:async()=>{}};
 const state={};
 await assert.rejects(fundVia1Click({...args,state}),/not confirmed yet|run the step again/);
 const first=state.solana_tx;
 assert.ok(first);assert.equal(rpc.sent.length,1);
 confirmed=true;
 const r=await fundVia1Click({...args,state});
 assert.equal(r.status,'SUCCESS');
 assert.equal(state.solana_tx,first,'the same transaction');
 assert.equal(rpc.sent.length,1,'not broadcast a second time once it is confirmed');
 assert.equal(client.calls.quote.length,1);
 // a refusal by the node before sending leaves nothing behind
 const rpc2={...fakeSolana(),broadcast:async()=>{const e=Error('Relay RPC refused');e.rpcError={message:'Transaction simulation failed'};throw e}};
 const s2={};
 await assert.rejects(fundVia1Click({...args,rpc:rpc2,state:s2}),/refused the transfer before sending/);
 assert.equal(s2.solana_tx,undefined);
});

// ---------- live steps, with fakes ----------
function liveCtx(over={}){
 const nearKey=localSigner(Uint8Array.from({length:32},(_,i)=>200-i)),wallet={solana:localSigner(ED_SEED)};
 const n={accountId:hex(uncurved('ed25519',`ed25519:${nearKey.address}`,32)),address:nearKey.address,publicKey:`ed25519:${nearKey.address}`,key:nearKey,created:false};
 const lines=[],sent=[];
 let t=Date.parse('2026-11-13T17:00:00Z');
 // the chain knows a transaction only after it was sent
 const rpc={call:async(method,params)=>{
  if(method==='query'&&params.request_type==='view_access_key')return {nonce:41,block_hash:'244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM',permission:'FullAccess'};
  if(method==='send_tx'){sent.push(params.signed_tx_base64);return {}}
  if(method==='EXPERIMENTAL_tx_status'){
   if(!sent.length)throw new NearRpcError('UNKNOWN_TRANSACTION',{cause:{name:'UNKNOWN_TRANSACTION'}});
   return {final_execution_status:'EXECUTED_OPTIMISTIC',transaction_outcome:{outcome:{status:{SuccessReceiptId:'r'},gas_burnt:1}},receipts_outcome:[{id:'r',outcome:{executor_id:'intents.near',status:{SuccessValue:''},logs:['EVENT_JSON:{"standard":"dip4","event":"intents_executed","data":[]}'],gas_burnt:2}}]};
  }
  throw Error(`unexpected ${method}`);
 }};
 const balances={user:{[USDC]:4_500_000n},solver:{[WIF]:13_000_000n,[BOME]:3_400_000_000n,[TRUMP]:1_800_000n}};
 const sims=[];
 const verifier={contract:'intents.near',currentSalt:async()=>SALT,fee:async()=>1,
  balances:async(account,ids)=>ids.map(id=>(account===n.accountId?balances.solver:balances.user)[id]??0n),
  simulate:async signed=>{sims.push(signed);return over.simulate?over.simulate(signed):{ok:true,output:{intents_executed:[]}}}};
 const omni={fee:async()=>({nativeFee:60_000_000_000_000_000_000_000n,usd:0.21}),storageBalance:async()=>over.storage===undefined?{total:10n**24n,available:10n**24n}:over.storage,
  storageRequirements:async()=>({account:1_410_000_000_000_000_000_000n,transfer:4_690_000_000_000_000_000_000n}),transfers:async()=>[],
  route:async c=>over.route?over.route(c):{ok:true,bridged:`sol:${c.mint}`,mint_matches:true,bridge_registered_on_token:true,decimals:{decimals:6,origin_decimals:6}}};
 const client={quote:async req=>({correlationId:'c',quote:{amountOut:{[WIF]:'9898008',[BOME]:'2618383984',[TRUMP]:'1361892'}[req.destinationAsset]}})};
 const solana={};
 const sol={accountInfo:async()=>({owner:TOKEN_PROGRAM}),tokenBalance:async ata=>solana[ata]??null};
 const state={version:1,near_account:n.accountId,steps:{}};
 const ctx={near:n,wallet,user:rawEd25519Signer(wallet.solana),recipient:wallet.solana.address,rpc,verifier,omni,client,sol,state,save:()=>{},emit:l=>lines.push(l),now:()=>t+=500,sleep:async()=>{},
  opts:{coins:'WIF,BOME,TRUMP',usdc:'4.5',feeMode:'signer',marginBps:100,deadlineS:300,followS:0,newTrade:false}};
 return {ctx,lines,sent,sims,balances,solana,rpc};
}
test('live trade: refused before signing a NEAR transaction when the user has no USDC, the solver is short, the bridge balance is missing, or the simulation fails',async()=>{
 {const {ctx,lines,sent,balances}=liveCtx();balances.user[USDC]=1n;assert.equal((await stepTrade(ctx)).ok,false);assert.match(lines.at(-1).reason,/less USDC/);assert.equal(sent.length,0)}
 {const {ctx,lines,sent,balances}=liveCtx();balances.solver[WIF]=5n;await stepTrade(ctx);assert.match(lines.at(-1).reason,/inventory is short/);assert.equal(lines.at(-1).short[0].symbol,'WIF');assert.equal(sent.length,0)}
 {const {ctx,lines,sent}=liveCtx({storage:null});await stepTrade(ctx);assert.match(lines.at(-1).reason,/omni\.bridge\.near/);assert.equal(sent.length,0)}
 {const {ctx,lines,sent,sims}=liveCtx({route:()=>({ok:false,bridged:null})});await stepTrade(ctx);assert.match(lines.at(-1).reason,/route is not open/);assert.equal(sims.length,0);assert.equal(sent.length,0)}
 {const {ctx,lines}=liveCtx();ctx.opts.feeMode='intent';ctx.opts.coins='WIF,BOME,TRUMP,MELANIA';await stepTrade(ctx);assert.match(lines.at(-1).reason,/too many withdrawals/);assert.equal(lines.at(-1).max,3)}
 {const {ctx,lines,sent,sims}=liveCtx({simulate:()=>({ok:false,stage:'intent_execution',code:'INSUFFICIENT_BALANCE',message:'insufficient balance or overflow'})});
  assert.equal((await stepTrade(ctx)).ok,false);assert.equal(sims.length,1);assert.equal(lines.at(-1).outcome,'INSUFFICIENT_BALANCE');assert.equal(sent.length,0);assert.equal(ctx.state.steps.trade.tx_hash,undefined)}
});
test('live trade: simulate, then ONE execute_intents with [solver, user]; a rerun follows the same transaction',async()=>{
 const {ctx,lines,sent,sims}=liveCtx();
 const r=await stepTrade(ctx);
 assert.equal(sims.length,1);assert.equal(sent.length,1);
 const slot=ctx.state.steps.trade;
 assert.deepEqual(slot.signed.map(s=>s.standard),['nep413','raw_ed25519']);
 assert.deepEqual(sims[0],slot.signed,'what was simulated is what is sent');
 // the bytes sent are a transaction to intents.near calling execute_intents with 300 Tgas and no deposit
 const raw=Buffer.from(sent[0],'base64');
 const args=JSON.stringify({signed:slot.signed});
 assert.ok(raw.includes(Buffer.from('execute_intents')));assert.ok(raw.includes(Buffer.from(args)));
 const tail=raw.subarray(raw.indexOf(Buffer.from(args))+Buffer.byteLength(args));
 assert.equal(tail.readBigUInt64LE(0),300_000_000_000_000n);assert.equal(hex(tail.subarray(8,24)),'00'.repeat(16));
 assert.equal(r.ok,false,'nothing has arrived on Solana in this fake, and the follow window is zero');
 assert.deepEqual(r.missing,['WIF','BOME','TRUMP']);
 assert.ok(slot.at.signed&&slot.at.simulated&&slot.at.submitted&&slot.at.included&&slot.at.executed);
 assert.ok(!JSON.stringify(lines).includes('seed'));
 await stepTrade(ctx);
 assert.equal(sent.length,1,'never sent twice');assert.equal(sims.length,1);
});
test('sendNearOnce: the transaction is saved before it is sent, and a rejected one is forgotten',async()=>{
 const {ctx,rpc}=liveCtx();
 let saved=null;ctx.save=()=>{saved=JSON.parse(JSON.stringify(ctx.state))};
 rpc.call=async m=>{
  if(m==='EXPERIMENTAL_tx_status')throw new NearRpcError('UNKNOWN_TRANSACTION',{cause:{name:'UNKNOWN_TRANSACTION'}});
  if(m==='send_tx'){assert.equal(saved.steps.x.tx_hash,'HASH');throw new NearRpcError('InvalidNonce',{cause:{name:'INVALID_TRANSACTION'},data:{TxExecutionError:{InvalidTxError:{InvalidNonce:{}}}}})}
 };
 const slot=(ctx.state.steps.x={});
 await assert.rejects(sendNearOnce(ctx,slot,'x',async()=>({hash:'HASH',base64:'AAAA'})),/NEAR refused transaction HASH/);
 assert.equal(slot.tx_hash,undefined);
});

// ---------- CLI ----------
test('CLI arguments: plan is the default and takes no step; live needs a step, a key file and a wallet',()=>{
 assert.equal(parseArgs([]).mode,'plan');
 assert.deepEqual((({mode,standard,usdc,coins,feeMode})=>({mode,standard,usdc,coins,feeMode}))(parseArgs(['--plan','--standard','erc191','--usdc','3','--bridge-fee','intent'])),{mode:'plan',standard:'erc191',usdc:'3',coins:'WIF,BOME,TRUMP',feeMode:'intent'});
 assert.throws(()=>parseArgs(['--trade']),/--live step/);
 assert.throws(()=>parseArgs(['--live']),/needs one step/);
 assert.throws(()=>parseArgs(['--live','--trade','--near-key','k']),/--wallet/);
 assert.throws(()=>parseArgs(['--live','--trade','--stock','--near-key','k','--wallet','w']),/one step per run/);
 assert.throws(()=>parseArgs(['--live','--stock','--near-key','k','--wallet','w','--fund-near-from-1click']),/belongs to --setup/);
 assert.throws(()=>parseArgs(['--usdc','-1']),/needs a value|positive amount/);
 assert.throws(()=>parseArgs(['--bogus']),/unknown argument/);
 const t=parseArgs(['--live','--trade','--near-key','k','--wallet','w','--user-evm','--new-trade','--follow-s','30']);
 assert.equal(t.step,'trade');assert.equal(t.userEvm,true);assert.equal(t.newTrade,true);assert.equal(t.followS,30);
 assert.equal(parseArgs(['--live','--setup','--near-key','k']).step,'setup');
 assert.equal(parseArgs(['--live','--withdraw-all','solver','--near-key','k','--wallet','w']).who,'solver');
 assert.throws(()=>parseArgs(['--live','--withdraw-all','both','--near-key','k','--wallet','w']),/user or solver/);
});

// ---------- the other live steps, end to end over fakes ----------
/** liveCtx plus what the funding steps touch: NEAR account views, a Solana node, 1Click. */
function fundedCtx(over={}){
 const x=liveCtx(over),{ctx}=x;
 const base=ctx.rpc.call;
 ctx.rpc.call=async(m,p)=>m==='query'&&p.request_type==='view_account'?{amount:'600000000000000000000000',locked:'0',storage_usage:182}:base(m,p);
 const solNode=fakeSolana();
 ctx.sol={...solNode,tokenBalance:async()=>10_000_000n};
 ctx.signatureStatus=async()=>({status:'confirmed'});
 ctx.feePayer=null;
 const quotes=[];
 let n=0;
 ctx.client={authenticated:false,
  quote:async req=>{quotes.push(req);return {correlationId:`c${quotes.length}`,quote:{depositAddress:localSigner(Uint8Array.from({length:32},(_,i)=>(i*7+ ++n)%251)).address,amountIn:req.amount,amountOut:'1',minAmountOut:'1',deadline:req.deadline}}},
  submitDeposit:async()=>({}),status:async()=>({status:'SUCCESS',swapDetails:{amountOut:'1'}})};
 ctx.opts={...ctx.opts,fundNear:false,fundUsdc:'2',stockUsdc:'2',wnearUsdc:'1',followS:60};
 return {...x,quotes,solNode};
}
test('live setup: says which account to fund and with how much; --fund-near-from-1click asks 1Click to deliver NEAR to it',async()=>{
 const {ctx,lines,quotes,solNode}=fundedCtx();
 await stepSetup(ctx);
 assert.equal(lines.length,1);
 assert.equal(lines[0].near_account,ctx.near.accountId);assert.equal(lines[0].near_balance,'0.600000');assert.equal(lines[0].needs.send_near_to,ctx.near.accountId);
 assert.equal(lines[0].needs.omni_registration_near,'0.001410');assert.equal(lines[0].needs.omni_per_transfer_storage_near,'0.004690');
 ctx.opts.fundNear=true;
 await stepSetup(ctx);
 assert.deepEqual((({destinationAsset,amount,recipient,recipientType,dry})=>({destinationAsset,amount,recipient,recipientType,dry}))(quotes[0]),
  {destinationAsset:'nep141:wrap.near',amount:'2000000',recipient:ctx.near.accountId,recipientType:'DESTINATION_CHAIN',dry:false});
 assert.equal(solNode.sent.length,1);
 assert.equal(lines.at(-1).step,'fund_near');assert.equal(lines.at(-1).status,'SUCCESS');
 assert.equal(ctx.state.steps.fund_near.status,'SUCCESS');
});
test('live register-omni: one storage_deposit on omni.bridge.near sized for the trade, and nothing when the balance is enough',async()=>{
 const {ctx,lines,sent}=fundedCtx({storage:null});
 await stepRegisterOmni(ctx);
 assert.equal(sent.length,1);
 const raw=Buffer.from(sent[0],'base64'),args=JSON.stringify({account_id:ctx.near.accountId});
 assert.ok(raw.includes(Buffer.from('omni.bridge.near'))&&raw.includes(Buffer.from('storage_deposit'))&&raw.includes(Buffer.from(args)));
 const tail=raw.subarray(raw.indexOf(Buffer.from(args))+Buffer.byteLength(args));
 // three transfers: (storage 0.00469 + fee 0.06) each, plus 30 percent, plus the registration 0.00141
 const want=(3n*(4_690_000_000_000_000_000_000n+60_000_000_000_000_000_000_000n))*13n/10n+1_410_000_000_000_000_000_000n;
 assert.equal(tail.readBigUInt64LE(8)+(tail.readBigUInt64LE(16)<<64n),want);
 assert.equal(lines.at(-1).stage,'result');
 const b=fundedCtx();
 await stepRegisterOmni(b.ctx);
 assert.equal(b.sent.length,0);assert.equal(b.lines.at(-1).stage,'already_enough');
});
test('live stock and deposit-user: one 1Click leg per coin into the solver\'s verifier account; USDC into the user\'s',async()=>{
 const {ctx,lines,quotes,solNode}=fundedCtx();
 await stepStock(ctx);
 assert.deepEqual(quotes.map(q=>[q.destinationAsset,q.recipient,q.recipientType,q.amount]),[[WIF,ctx.near.accountId,'INTENTS','2000000'],[BOME,ctx.near.accountId,'INTENTS','2000000'],[TRUMP,ctx.near.accountId,'INTENTS','2000000']]);
 assert.equal(solNode.sent.length,3);
 assert.equal(lines.at(-1).ok,true);
 assert.deepEqual(Object.keys(ctx.state.steps.stock),['WIF','BOME','TRUMP']);
 await stepStock(ctx);
 assert.equal(quotes.length,3,'a second run buys nothing');assert.equal(solNode.sent.length,3);
 await stepDepositUser(ctx);
 assert.deepEqual([quotes[3].originAsset,quotes[3].destinationAsset,quotes[3].recipient,quotes[3].recipientType,quotes[3].amount],[USDC,USDC,ctx.user.accountId,'INTENTS','4500000']);
 assert.equal(lines.at(-1).user_verifier_account,ctx.user.accountId);assert.equal(lines.at(-1).ok,true);
 // with --bridge-fee intent the solver also stocks wNEAR
 const b=fundedCtx();b.ctx.opts.feeMode='intent';
 await stepStock(b.ctx);
 assert.deepEqual(b.quotes.map(q=>[q.destinationAsset,q.amount]).at(-1),['nep141:wrap.near','1000000']);
});
test('live status and withdraw-all: balances are reported; the solver\'s whole balance leaves in one signed payload',async()=>{
 const {ctx,lines,sent,sims}=fundedCtx();
 await stepStatus(ctx);
 assert.equal(lines[0].step,'status');
 assert.deepEqual(lines[0].solver_verifier_balances,{USDC:'0',WIF:'13000000',BOME:'3400000000',TRUMP:'1800000',WNEAR:'0'});
 assert.equal(lines[0].user_verifier_balances.USDC,'4500000');
 await stepWithdrawAll(ctx,'solver');
 assert.equal(sims.length,1);assert.equal(sims[0].length,1);assert.equal(sims[0][0].standard,'nep413');
 const intents=JSON.parse(sims[0][0].payload.message).intents;
 assert.deepEqual(intents.map(i=>[i.intent,i.receiver_id,i.amount]),[['ft_withdraw','omni.bridge.near','13000000'],['ft_withdraw','omni.bridge.near','3400000000'],['ft_withdraw','omni.bridge.near','1800000']]);
 assert.equal(JSON.parse(intents[0].msg).recipient,`sol:${ctx.recipient}`);
 assert.equal(sent.length,1);assert.equal(lines.at(-1).ok,true);
 const u=fundedCtx();
 await stepWithdrawAll(u.ctx,'user');
 assert.equal(u.sims[0][0].standard,'raw_ed25519');
 assert.deepEqual(JSON.parse(u.sims[0][0].payload).intents.map(i=>i.token),['sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near']);
});
test('live context: key file and state file are private files next to each other; the user signs with the wallet\'s Solana key, or its EVM key with --user-evm; no line carries a key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'intents-live-')),nearKey=join(dir,'near.json'),walletPath=join(dir,'wallet.json');
 const w=createTestWalletFile(walletPath);
 const lines=[],deps={rpc:{},verifier:{},omni:{},client:{authenticated:false}};
 const opts=o=>({...parseArgs(['--live','--status','--near-key',nearKey,'--wallet',walletPath,...o])});
 const ctx=await createLiveContext({opts:opts([]),env:{},deps,emit:l=>lines.push(l)});
 assert.equal(ctx.user.standard,'raw_ed25519');assert.equal(ctx.user.accountId,ed25519AccountId(w.solana));
 assert.equal(ctx.recipient,w.solana);assert.equal(ctx.feePayer,null);
 assert.match(ctx.near.accountId,/^[0-9a-f]{64}$/);assert.notEqual(ctx.near.accountId,ctx.user.accountId);
 ctx.state.steps.x={a:1};ctx.save();
 assert.equal(statSync(`${nearKey}.state.json`).mode&0o777,0o600);
 const evm=await createLiveContext({opts:opts(['--user-evm']),env:{},deps,emit:l=>lines.push(l)});
 assert.equal(evm.user.standard,'erc191');assert.equal(evm.user.accountId,w.base.toLowerCase());
 assert.equal(evm.near.accountId,ctx.near.accountId,'the same NEAR key on the second run');
 assert.deepEqual(evm.state.steps,{x:{a:1}},'the state file is read back');
 const secrets=[JSON.parse(readFileSync(nearKey,'utf8')).near.seed_base64,JSON.parse(readFileSync(walletPath,'utf8')).solana.seed_base64,JSON.parse(readFileSync(walletPath,'utf8')).base.private_key_hex];
 const out=JSON.stringify(lines)+readFileSync(`${nearKey}.state.json`,'utf8');
 for(const s of secrets)assert.ok(!out.includes(s));
 await assert.rejects(createLiveContext({opts:opts(['--recipient','0xabc']),env:{},deps,emit:()=>{}}),/not a Solana address/);
 await assert.rejects(createLiveContext({opts:opts(['--fee-payer','privy']),env:{},deps,emit:()=>{}}),/fee payer variables/);
 // another key must not pick up this state file
 const other=join(dir,'other.json');loadOrCreateNearKey(other);
 await assert.rejects(createLiveContext({opts:{...opts([]),nearKey:other,state:`${nearKey}.state.json`},env:{},deps,emit:()=>{}}),/belongs to another NEAR key/);
 await assert.rejects(runStep({opts:{step:'nope'}}),/unknown step/);
});
test('leg prices: a dry 1Click quote per coin; when 1Click has no route for the size, its token list price',async()=>{
 const asked=[];
 const client={quote:async req=>{asked.push(req);if(req.destinationAsset===BOME)throw Error('No liquidity available');return {correlationId:'c1',quote:{amountOut:'9898008'}}},
  getTokens:async()=>[{assetId:USDC,price:0.999497},{assetId:BOME,price:0.00057448}]};
 const coins=basketCoins('WIF,BOME');
 const legs=await quoteLegs({client,coins,usdcIns:[1_500_000n,1_500_000n],recipient:'a'.repeat(64),refundTo:DEPOSIT,now:()=>Date.parse('2026-11-13T17:00:00Z')});
 assert.equal(asked[0].dry,true,'never a live quote: no deposit address is created');
 assert.equal(asked[0].recipientType,'INTENTS');assert.equal(asked[0].originAsset,USDC);assert.equal(asked[0].amount,'1500000');
 assert.deepEqual(legs.map(l=>[l.symbol,l.quotedOut,l.priceSource]),[['WIF',9_898_008n,'dry_quote'],['BOME',2_609_743_594n,'tokens_list']]);
 await assert.rejects(quoteLegs({client:{quote:client.quote,getTokens:async()=>[]},coins,usdcIns:[1n,1n],recipient:'a',refundTo:DEPOSIT}),/no price for BOME/);
});

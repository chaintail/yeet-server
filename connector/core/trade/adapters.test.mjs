// Signer adapters (delegated and custodial Privy), wallet balances over JSON-RPC, the hand-built Solana transfer and
// the policy printer, all against fake fetch functions. The P-256 key is generated per run; nothing is sent anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {createDelegatedSigner} from './signer-privy.mjs';
import {createCustodialSigner} from './signer-custodial.mjs';
import {createSigner,signerKind,erc20TransferData,USDC_BASE} from './signer.mjs';
import {createRpcBalances,createWallets} from './wallets.mjs';
import {splTransferTransaction,associatedTokenAddress,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,SOLANA_MAINNET_CAIP2} from './solana-tx.mjs';
import {canonical} from './util.mjs';
import {openTradeDb} from './db.mjs';
import {base58Decode} from './router.mjs';
import {BASE_WALLET,SOL_WALLET} from './fakes.mjs';

const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const ENV={PRIVY_APP_ID:'test-app-id-123',PRIVY_APP_SECRET:'test-app-secret',YEET_PRIVY_AUTHORIZATION_KEY:`wallet-auth:${privateKey.export({format:'der',type:'pkcs8'}).toString('base64')}`,YEET_PRIVY_KEY_QUORUM_ID:'quorum-yeet'};
const SPKI=publicKey.export({format:'der',type:'spki'}).toString('base64');
const HASH='0x'+'ab'.repeat(32);
function fakeFetch(handler){
 const calls=[];
 const fn=async(url,init={})=>{const call={url:String(url),method:init.method??'GET',headers:init.headers??{},body:init.body===undefined?undefined:JSON.parse(init.body),raw:init.body};calls.push(call);
  const {status=200,body}=await handler(call,calls.length);return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})};
 return {fn,calls};
}
const refused=code=>e=>e.code===code;
const sigOk=call=>{
 const privy=Object.fromEntries(Object.entries(call.headers).filter(([k])=>k.startsWith('privy-')&&k!=='privy-authorization-signature'));
 const payload=canonical({version:1,method:call.method,url:call.url,body:call.body??{},headers:privy});
 return verify('sha256',Buffer.from(payload),{key:publicKey,dsaEncoding:'der'},Buffer.from(call.headers['privy-authorization-signature'],'base64'));
};

test('ERC-20 transfer calldata is selector + padded address + padded amount',()=>{
 assert.equal(erc20TransferData(BASE_WALLET,10_000_000n),'0xa9059cbb00000000000000000000000017602fd697f91d31fe551b26a3b12b113789477e0000000000000000000000000000000000000000000000000000000000989680');
 assert.throws(()=>erc20TransferData('0x1234',1n));assert.throws(()=>erc20TransferData(BASE_WALLET,0n));
});

test('YEET_SIGNER selects one adapter behind the same interface; unknown values are refused',async()=>{
 assert.equal(signerKind({}),'delegated');assert.equal(signerKind({YEET_SIGNER:'custodial'}),'custodial');
 assert.throws(()=>signerKind({YEET_SIGNER:'hot'}),/Invalid YEET_SIGNER/);
 for(const kind of ['delegated','custodial']){
  const s=await createSigner({env:{YEET_SIGNER:kind}});
  assert.equal(s.kind,kind);assert.equal(s.configured,false);
  for(const fn of ['transferUsdcBase','transferSpl'])assert.equal(typeof s[fn],'function');
  await assert.rejects(s.transferUsdcBase({}),refused('WALLET_NOT_READY'));
  await assert.rejects(s.directory.lookup('yeet-privy-a'),refused('WALLET_NOT_READY'));
 }
});

test('delegated Base transfer: Privy wallet RPC eth_sendTransaction with the Folio authorization-signature shape',async()=>{
 const f=fakeFetch(()=>({body:{method:'eth_sendTransaction',data:{hash:HASH}}}));
 const s=createDelegatedSigner({env:ENV,fetch:f.fn});
 const key='c'.repeat(64);
 assert.deepEqual(await s.transferUsdcBase({walletId:'wallet-base',from:BASE_WALLET,to:'0x'+'11'.repeat(20),amountRaw:'4000000',idempotencyKey:key}),{txHash:HASH,transactionId:null,hashPending:false});
 const [c]=f.calls;
 assert.equal(c.url,'https://api.privy.io/v1/wallets/wallet-base/rpc');assert.equal(c.method,'POST');
 assert.equal(c.headers['privy-app-id'],ENV.PRIVY_APP_ID);assert.equal(c.headers['privy-idempotency-key'],key);
 assert.equal(c.headers.authorization,`Basic ${Buffer.from(`${ENV.PRIVY_APP_ID}:${ENV.PRIVY_APP_SECRET}`).toString('base64')}`);
 assert.equal(c.headers['content-type'],'application/json');
 assert.ok(sigOk(c),'signature verifies over canonical {version, method, url, body, privy- headers}');
 assert.equal(c.raw,canonical(c.body),'the body is sent exactly as signed');
 assert.deepEqual(c.body,{method:'eth_sendTransaction',caip2:'eip155:8453',chain_type:'ethereum',sponsor:true,
  reference_id:key,params:{transaction:{to:USDC_BASE,data:erc20TransferData('0x'+'11'.repeat(20),4_000_000n),value:'0x0',chain_id:8453}}});
});

test('delegated: Privy refusals map to catalogue codes; no hash is TEMPORARILY_UNAVAILABLE',async()=>{
 const cases=[[{status:400,body:{error:'RPC request denied due to policy violation',code:'policy_violation'}},'LIMIT_EXCEEDED'],
  [{status:401,body:{error:'No valid authorization signatures were provided. x'}},'WALLET_NOT_READY'],
  [{status:500,body:{}},'TEMPORARILY_UNAVAILABLE'],[{status:200,body:{data:{}}},'TEMPORARILY_UNAVAILABLE']];
 for(const [reply,expected] of cases){
  const s=createDelegatedSigner({env:ENV,fetch:fakeFetch(()=>reply).fn});
  await assert.rejects(s.transferUsdcBase({walletId:'w1',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'1',idempotencyKey:'d'.repeat(64)}),refused(expected),expected);
 }
});

test('delegated with YEET_GAS_WALLET_ID: no sponsorship, and a gas top-up from the gas wallet when the wallet has no ETH',async()=>{
 const f=fakeFetch(()=>({body:{data:{hash:HASH}}}));
 const s=createDelegatedSigner({env:{...ENV,YEET_GAS_WALLET_ID:'gas-wallet'},fetch:f.fn,balances:{baseEth:async()=>0n}});
 await s.transferUsdcBase({walletId:'wallet-base',from:BASE_WALLET,to:BASE_WALLET,amountRaw:'5',idempotencyKey:'e'.repeat(64)});
 assert.deepEqual(f.calls.map(c=>c.url),['https://api.privy.io/v1/wallets/gas-wallet/rpc','https://api.privy.io/v1/wallets/wallet-base/rpc']);
 assert.equal(f.calls[0].body.params.transaction.to,BASE_WALLET);assert.equal(f.calls[0].body.params.transaction.value,'0x1b48eb57e000');
 assert.equal(f.calls[1].body.sponsor,false);
});

test('delegated directory: the person\'s embedded wallets from Privy, signer granted only with the YEET quorum attached',async()=>{
 const f=fakeFetch(call=>{
  if(call.url.includes('/v1/users/'))return {body:{id:'did:privy:abc',linked_accounts:[{type:'email',address:'x'},
   {type:'wallet',wallet_client_type:'privy',chain_type:'ethereum',address:BASE_WALLET,id:'wb'},{type:'wallet',wallet_client_type:'privy',chain_type:'solana',address:SOL_WALLET,id:'ws'}]}};
  if(call.url.endsWith('/v1/wallets/wb'))return {body:{id:'wb',additional_signers:[{signer_id:'quorum-yeet',override_policy_ids:['pol-base']}]}};
  return {body:{id:'ws',additional_signers:[]}};
 });
 const s=createDelegatedSigner({env:ENV,fetch:f.fn,didFor:id=>id==='yeet-privy-a'?'did:privy:abc':undefined});
 assert.deepEqual(await s.directory.lookup('yeet-privy-a'),{base:{address:BASE_WALLET,walletId:'wb',signerState:'granted',policyId:'pol-base'},solana:{address:SOL_WALLET,walletId:'ws',signerState:'none',policyId:null}});
 assert.equal(f.calls[0].url,'https://api.privy.io/v1/users/did:privy:abc');
 assert.ok(f.calls.every(c=>c.method==='GET'&&!c.headers['privy-authorization-signature']),'reads use app auth only');
 assert.equal(await s.directory.lookup('yeet-privy-unknown'),null);
});

test('SKEET transfer: WALLET_NOT_READY until a Solana fee payer is configured; then a sponsored signAndSendTransaction',async()=>{
 const s0=createDelegatedSigner({env:ENV,fetch:fakeFetch(()=>({body:{}})).fn});
 const leg={walletId:'ws',owner:SOL_WALLET,source:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',destinationOwner:'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',decimals:6,amountRaw:'4000000',tokenProgram:TOKEN_PROGRAM,idempotencyKey:'f'.repeat(64)};
 await assert.rejects(s0.transferSpl(leg),refused('WALLET_NOT_READY'));
 const sig='5'.repeat(88);
 const f=fakeFetch(()=>({body:{data:{hash:sig}}}));
 const s=createDelegatedSigner({env:{...ENV,YEET_SOL_FEE_PAYER_ID:'fee-payer'},fetch:f.fn,balances:{recentBlockhash:async()=>'11111111111111111111111111111111'}});
 assert.deepEqual(await s.transferSpl(leg),{txHash:sig,transactionId:null,hashPending:false});
 const b=f.calls[0].body;
 assert.equal(b.method,'signAndSendTransaction');assert.equal(b.caip2,SOLANA_MAINNET_CAIP2);assert.equal(b.sponsor,true);assert.equal(b.params.encoding,'base64');
 assert.ok(sigOk(f.calls[0]));
});

test('custodial: one server wallet per account and chain owned by the YEET key, created once with a stable idempotency key',async()=>{
 const f=fakeFetch(call=>({body:{id:`w-${call.body.chain_type}`,address:call.body.chain_type==='ethereum'?BASE_WALLET:SOL_WALLET,chain_type:call.body.chain_type}}));
 const env={...ENV};delete env.YEET_PRIVY_KEY_QUORUM_ID;
 const s=createCustodialSigner({env,fetch:f.fn});
 const db=openTradeDb(':memory:');
 const wallets=createWallets({db,directory:s.directory,balances:{}});
 const w=await wallets.resolve('yeet-privy-c');
 assert.equal(w.base.address,BASE_WALLET);assert.equal(w.solana.walletId,'w-solana');assert.equal(w.base.signerState,'granted');
 assert.deepEqual(f.calls.map(c=>[c.method,c.url,c.body]),[['POST','https://api.privy.io/v1/wallets',{chain_type:'ethereum',owner:{public_key:SPKI}}],['POST','https://api.privy.io/v1/wallets',{chain_type:'solana',owner:{public_key:SPKI}}]]);
 const keys=f.calls.map(c=>c.headers['privy-idempotency-key']);
 await wallets.resolve('yeet-privy-c');assert.equal(f.calls.length,2,'stored server wallets are never created again');
 const again=createCustodialSigner({env,fetch:f.fn});await again.directory.lookup('yeet-privy-c');
 assert.deepEqual(f.calls.slice(2).map(c=>c.headers['privy-idempotency-key']),keys,'a lost response retries with the same key');
 const q=fakeFetch(call=>({body:{id:'w',address:BASE_WALLET,chain_type:call.body.chain_type}}));
 await createCustodialSigner({env:ENV,fetch:q.fn}).directory.lookup('yeet-privy-d');
 assert.deepEqual(q.calls[0].body,{chain_type:'ethereum',owner_id:'quorum-yeet'});
});

test('balances over JSON-RPC: USDC balanceOf on Base and SPL accounts on both token programs',async()=>{
 const f=fakeFetch(call=>{
  const {method,params}=call.body;
  if(method==='eth_call'){assert.deepEqual(params,[{to:USDC_BASE,data:'0x70a08231'+BASE_WALLET.slice(2).padStart(64,'0')},'latest']);return {body:{jsonrpc:'2.0',id:1,result:'0x'+(12_500_000).toString(16).padStart(64,'0')}}}
  if(method==='getTokenAccountsByOwner')return {body:{jsonrpc:'2.0',id:1,result:{value:params[1].programId===TOKEN_PROGRAM?[{pubkey:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',account:{data:{parsed:{info:{mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',tokenAmount:{amount:'8000000',decimals:6}}}}}}]:[]}}};
  return {body:{jsonrpc:'2.0',id:1,result:{value:{blockhash:'11111111111111111111111111111111'}}}};
 });
 const b=createRpcBalances({baseRpcUrl:'https://base.rpc.test',solanaRpcUrl:'https://sol.rpc.test',fetch:f.fn});
 assert.equal(await b.baseUsdc(BASE_WALLET),12_500_000n);
 assert.deepEqual(await b.solanaTokens(SOL_WALLET),[{mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',raw:8_000_000n,decimals:6,tokenAccount:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',tokenProgram:TOKEN_PROGRAM}]);
 assert.deepEqual(f.calls.filter(c=>c.body.method==='getTokenAccountsByOwner').map(c=>c.body.params[1].programId),[TOKEN_PROGRAM,TOKEN_2022_PROGRAM]);
 const none=createRpcBalances({fetch:f.fn,baseRpcUrl:'',solanaRpcUrl:''});
 const w=createWallets({db:openTradeDb(':memory:'),directory:{lookup:async()=>null},balances:none});
 await assert.rejects(w.usdc(BASE_WALLET),refused('TEMPORARILY_UNAVAILABLE'));
 await assert.rejects(w.require('yeet-privy-x'),refused('WALLET_NOT_READY'));
});

test('Solana transfer built by hand: ATA by find_program_address (checked against @solana/kit), legacy message layout',()=>{
 assert.equal(associatedTokenAddress(SOL_WALLET,'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw');
 assert.equal(associatedTokenAddress(SOL_WALLET,'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',TOKEN_2022_PROGRAM),'5GS1zCS6E8A1YRSAs4buT3ZZEXgm4febVNqQ3zrb1Ys7');
 const {transaction,destination}=splTransferTransaction({owner:SOL_WALLET,source:'GfBdV2GY25Q5MAfyj9wxX7SiJh8yeJP55sA7WA2jM4fw',destinationOwner:'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',decimals:6,amountRaw:'4000000',recentBlockhash:'11111111111111111111111111111111'});
 const tx=Buffer.from(transaction,'base64');
 assert.equal(tx[0],1);assert.ok(tx.subarray(1,65).every(b=>b===0));
 const m=tx.subarray(65);
 assert.deepEqual([...m.subarray(0,4)],[1,0,5,8]);
 assert.deepEqual([...m.subarray(4,36)],[...base58Decode(SOL_WALLET)]);
 assert.deepEqual([...m.subarray(4+2*32,4+3*32)],[...base58Decode(destination)]);
 assert.equal(m[m.length-10],12);assert.equal(Buffer.from(m.subarray(m.length-9,m.length-1)).readBigUInt64LE(),4_000_000n);assert.equal(m[m.length-1],6);
});

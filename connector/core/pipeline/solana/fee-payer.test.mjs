// The Privy fee payer (Folio fee-payer.test.ts cases ported) and its policy body (Folio fee-payer-policy.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPrivyFeePayer,feePayerFromEnv,definiteRefusal} from './fee-payer.mjs';
import {feePayerPolicy,sponsoredMints} from './fee-payer-policy.mjs';
import {createPrivyApi,privyConfig} from '../../trade/privy-api.mjs';
import {fakePrivyEnv} from '../../trade/fakes.mjs';
import {feePayer as key,user,other,legTx} from './fixtures.mjs';
import {SYSTEM_PROGRAM,USDC_SOLANA} from './message.mjs';

/** fetch double for POST /v1/wallets/{id}/rpc: `answer(bodyJson)` -> {status, json}. */
function privy(answer){
 const calls=[];
 const fetch=async(url,init)=>{calls.push({url,headers:init.headers,body:init.body});const {status=200,json}=await answer(JSON.parse(init.body));return {status,async json(){return json}}};
 return {fetch,calls};
}
const env=fakePrivyEnv();
const payer=(fetch,address=key.address)=>createPrivyFeePayer({api:createPrivyApi({config:privyConfig(env),fetch}),walletId:'yeet-fee-payer',address});
const signedBy=(k,b64)=>Buffer.from(k.signTransaction(Buffer.from(b64,'base64'))).toString('base64');

test('authenticated signTransaction on the dedicated wallet; the person signature is preserved',async()=>{
 const partial=user.signTransaction(legTx());
 const t=privy(b=>({json:{data:{signed_transaction:signedBy(key,b.params.transaction),encoding:'base64'}}}));
 const signed=await payer(t.fetch).signTransaction(partial);
 assert.deepEqual(signed.slice(65,129),partial.slice(65,129));
 assert.equal(t.calls.length,1);
 assert.equal(t.calls[0].url,'https://api.privy.io/v1/wallets/yeet-fee-payer/rpc');
 assert.deepEqual(JSON.parse(t.calls[0].body),{method:'signTransaction',params:{encoding:'base64',transaction:Buffer.from(partial).toString('base64')}});
 assert.ok(t.calls[0].headers['privy-authorization-signature']);
});
test('answers that are not a valid co-signature of the same bytes are refused',async()=>{
 const partial=user.signTransaction(legTx());
 const cases=[
  b=>({json:{data:{signed_transaction:b.params.transaction,encoding:'base64'}}}),// unsigned slot
  b=>({json:{data:{signed_transaction:signedBy(key,b.params.transaction)+'=',encoding:'base64'}}}),// not canonical
  b=>({json:{data:{signed_transaction:signedBy(key,b.params.transaction),encoding:'base58'}}}),
  ()=>({json:{data:{signed_transaction:Buffer.from(key.signTransaction(user.signTransaction(legTx({create:false})))).toString('base64'),encoding:'base64'}}}),// other message
 ];
 for(const c of cases)await assert.rejects(payer(privy(c).fetch).signTransaction(partial),e=>e.code==='INVALID_FEE_PAYER_SIGNATURE');
 // The configured address must be the one that signed.
 await assert.rejects(payer(privy(b=>({json:{data:{signed_transaction:signedBy(key,b.params.transaction),encoding:'base64'}}})).fetch,other.address).signTransaction(partial),e=>e.code==='INVALID_FEE_PAYER_SIGNATURE');
});
test('Privy refusals keep their codes; definite ones are told apart from retryable ones',async()=>{
 const partial=user.signTransaction(legTx());
 await assert.rejects(payer(privy(()=>({status:400,json:{code:'policy_violation',error:'denied'}})).fetch).signTransaction(partial),e=>e.code==='PRIVY_POLICY_DENIED');
 await assert.rejects(payer(privy(()=>({status:503,json:{}})).fetch).signTransaction(partial),e=>e.code==='PRIVY_HTTP_503');
 assert.equal(definiteRefusal('PRIVY_POLICY_DENIED'),true);assert.equal(definiteRefusal('PRIVY_AUTHORIZATION_DENIED'),true);
 assert.equal(definiteRefusal('PRIVY_HTTP_400'),true);
 for(const c of ['PRIVY_HTTP_408','PRIVY_HTTP_429','PRIVY_HTTP_503','PRIVY_TRANSPORT_UNAVAILABLE',undefined])assert.equal(definiteRefusal(c),false);
});
test('configuration: wallet id and address checked; env without them gives no fee payer',()=>{
 const api=createPrivyApi({config:privyConfig(env),fetch:async()=>{}});
 assert.throws(()=>createPrivyFeePayer({api,walletId:'bad id',address:key.address}),e=>e.code==='INVALID_FEE_PAYER_WALLET_ID');
 assert.throws(()=>createPrivyFeePayer({api,walletId:'w',address:'0xabc'}),e=>e.code==='INVALID_FEE_PAYER_ADDRESS');
 assert.equal(feePayerFromEnv({...env,YEET_SOL_FEE_PAYER_ADDRESS:''}),null);
 assert.ok(feePayerFromEnv({...env,YEET_SOL_FEE_PAYER_ADDRESS:key.address}));
});
test('policy: System Transfer denied; ComputeBudget, ATA and TransferChecked of catalogue mints allowed; nothing else',()=>{
 const p=feePayerPolicy('owner-key');
 assert.equal(p.chain_type,'solana');assert.equal(p.rules[0].action,'DENY');
 assert.equal(p.rules[0].conditions[0].value,SYSTEM_PROGRAM);
 assert.ok(p.rules.slice(1).every(r=>r.action==='ALLOW'&&r.method==='signTransaction'));
 const mints=sponsoredMints();
 assert.ok(mints.includes(USDC_SOLANA)&&mints.includes('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'));
 const tc=p.rules.filter(r=>r.name.startsWith('allow-transfer-checked'));
 assert.equal(tc.length,2);assert.ok(tc.every(r=>r.conditions.some(c=>c.field==='TransferChecked.mint'&&c.operator==='in'&&JSON.stringify(c.value)===JSON.stringify(mints))));
});

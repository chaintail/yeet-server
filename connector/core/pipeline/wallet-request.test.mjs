// Decision (a): the card-builder contract. A sign request mapped to the Privy wallet call, answered the way the Privy
// wallet answers (RPC `data.signed_transaction`, or the React SDK result), is accepted by submit_trade_signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import {privyRpcBody,privyRpcBodies,reactSdkArgs,signedFromWallet,signedFromWallets} from './wallet-request.mjs';
import {fakePipeline,ALICE,aliceWallet} from './fakes.mjs';
import {world,preparedAndSigned,batchWorld,batchPrepared,asSignRequest} from './base/test-support.mjs';

/** What Privy's eth_signTransaction does with the RPC body: the snake_case hex fields as one EIP-1559 transaction. */
const privyEvmSign=(account,body)=>{const t=body.params.transaction;
 return account.signTransaction({type:'eip1559',chainId:t.chain_id,to:t.to,data:t.data,value:BigInt(t.value),nonce:t.nonce,gas:BigInt(t.gas_limit),
  maxFeePerGas:BigInt(t.max_fee_per_gas),maxPriorityFeePerGas:BigInt(t.max_priority_fee_per_gas)})};

test('Base: the Privy eth_signTransaction body signs bytes the server accepts; a re-estimated gas limit is refused',async()=>{
 const w=world(),f=await preparedAndSigned(w);
 const req={kind:'evm_tx',payload:f.req.payload};
 const body=privyRpcBody(req);
 assert.equal(body.method,'eth_signTransaction');assert.equal(body.chain_type,'ethereum');
 assert.deepEqual(Object.keys(body.params.transaction).sort(),['chain_id','data','gas_limit','max_fee_per_gas','max_priority_fee_per_gas','nonce','to','type','value']);
 assert.match(body.params.transaction.gas_limit,/^0x[0-9a-f]+$/);
 const signed=signedFromWallet(req,{method:'eth_signTransaction',data:{signed_transaction:await privyEvmSign(w.userAccount,body)}});
 assert.equal(signed,f.signed,'identical to the bytes signed from the payload directly');
 const r=await w.driver.submit({...f.args,signed,dryRun:true});
 assert.equal(r.state,'pending');assert.equal(r.dryRun,true);
 // React SDK shape gives the same transaction.
 const a=reactSdkArgs(req);
 assert.equal(a.gasLimit,body.params.transaction.gas_limit);assert.equal(a.chainId,8453);
 assert.equal(signedFromWallet(req,{signature:signed.toUpperCase().replace('0X','0x')}),signed);
 // A card that changes anything (here: gas re-estimated) is refused.
 const bumped={...body,params:{transaction:{...body.params.transaction,gas_limit:'0x'+(BigInt(body.params.transaction.gas_limit)+1n).toString(16)}}};
 await assert.rejects(w.driver.submit({...f.args,signed:await privyEvmSign(w.userAccount,bumped),dryRun:true}),e=>e.code==='SIGNED_SOURCE_MISMATCH');
});

test('Solana: the Privy signTransaction body signs bytes the server accepts; the React SDK result maps to the same string',async()=>{
 const {p}=fakePipeline();
 const x=await p.execute(ALICE,await (async()=>{const pr=await p.propose(ALICE,{request_id:'w1',amount_usdc:'5',legs:[{symbol:'WIF',parts:1}]});return {proposal_id:pr.proposal_id,revision:pr.revision,confirm:pr.confirm.code}})());
 const req=x.sign_requests[0];
 const body=privyRpcBody(req);
 assert.deepEqual(body,{method:'signTransaction',chain_type:'solana',params:{transaction:req.payload.transaction_base64,encoding:'base64'}});
 // Privy signs the partially signed transaction as the wallet's slot and answers base64.
 const signedBytes=aliceWallet.signTransaction(Buffer.from(body.params.transaction,'base64'));
 const signed=signedFromWallet(req,{data:{signed_transaction:Buffer.from(signedBytes).toString('base64')}});
 assert.equal(signedFromWallet(req,{signedTransaction:Uint8Array.from(signedBytes)}),signed);
 assert.deepEqual([...reactSdkArgs(req).transaction],[...Buffer.from(req.payload.transaction_base64,'base64')]);
 const out=await p.submit(ALICE,{trade_id:req.trade_id,leg:req.leg,attempt_id:req.attempt_id,signed},{dryRun:true});
 assert.equal(out.dry_run.state,'not_sent');assert.equal(out.dry_run.simulation.err,null);
});

test('Base evm_7702: two calls in order on a first trade (262 characters), one on a delegated wallet (132); solana_tx/evm_tx bodies unchanged',async()=>{
 const w=batchWorld(),p=await batchPrepared(w),req=asSignRequest(p.req,p.legs);
 const bodies=privyRpcBodies(req);
 assert.deepEqual(bodies[0],{method:'eth_sign7702Authorization',chain_type:'ethereum',params:{contract:req.payload.authorization.contract,chain_id:8453,nonce:0}});
 assert.deepEqual(bodies[1],{method:'eth_signTypedData_v4',chain_type:'ethereum',params:{typed_data:req.payload.typed_data}});
 assert.equal(p.signed.length,262);assert.match(p.signed,/^0x[0-9a-f]{260}$/);
 const r=await w.batch.submit({...p.args,dryRun:true,now:w.clock.t});
 assert.equal(r.state,'pending');assert.equal(r.simulation.legs_transferred,2);
 const v=batchWorld();v.rpc.s.code[v.wallet]='0xef0100000000005c84f8fd50b21cac312528a64437030e';
 const q=await batchPrepared(v),one=privyRpcBodies(asSignRequest(q.req,q.legs));
 assert.deepEqual(one.map(b=>b.method),['eth_signTypedData_v4']);assert.equal(q.signed.length,132);
 assert.equal(signedFromWallets(asSignRequest(q.req,q.legs),[{data:{signature:q.signed.toUpperCase().replace('0X','0x')}}]),q.signed);
 // The single-call kinds go through privyRpcBodies byte-identical to privyRpcBody.
 const f=await preparedAndSigned(world());
 assert.deepEqual(privyRpcBodies({kind:'evm_tx',payload:f.req.payload}),[privyRpcBody({kind:'evm_tx',payload:f.req.payload})]);
 assert.equal(signedFromWallets({kind:'evm_tx'},[{data:{signed_transaction:f.signed}}]),f.signed);
});

test('unknown kinds and wallet answers without a signed transaction are refused before any call',()=>{
 assert.throws(()=>privyRpcBody({kind:'eth_sign'}),TypeError);
 assert.throws(()=>signedFromWallet({kind:'evm_tx'},{data:{signature:'0xdeadbeef'}}),TypeError);
 assert.throws(()=>signedFromWallet({kind:'solana_tx'},{data:{}}),TypeError);
});

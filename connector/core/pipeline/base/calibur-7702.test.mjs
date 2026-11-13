// Fixed vectors for the Calibur 7702 builders (calibur-7702.mjs). Every digest is also recomputed independently the way
// Calibur's Solidity does it (EIP712.sol, SignedBatchedCallLib/BatchedCallLib/CallLib.sol, PrefixedSaltLib.sol), so a
// drift in our types or domain against the audited source fails here, not on chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256,toHex,toRlp,encodeAbiParameters,concat,parseTransaction,recoverTypedDataAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {CALIBUR,CALIBUR_DOMAIN_TYPEHASH,SIGNED_BATCHED_CALL_TYPE,EXECUTE_SIGNED_SELECTOR,EXECUTE_SIGNED_SIGNATURE,
 CALIBUR_ERRORS,ROOT_KEY_HASH,delegationCode,delegatedTo,caliburSalt,caliburDomain,batchNonce,nonceKey,buildBatch,
 batchTypedData,batchDigest,privyTypedData,wrapSignature,executeCalldata,decodeExecuteCalldata,authorizationRequest,
 authorizationDigest,fromPrivyAuthorization,assertAuthorization,assertBatchMatches,buildType4,assertType4Bytes,legEvidence,
 revertName} from './calibur-7702.mjs';
import {USDC_BASE,TRANSFER_TOPIC} from './config.mjs';

const user=privateKeyToAccount('0x'+'11'.repeat(32)),gas=privateKeyToAccount('0x'+'22'.repeat(32));
const USER='0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',GAS='0x1563915e194D8CfBA1943570603F7606A3115508';
const legs=[{to:'0x'+'a1'.repeat(20),amountRaw:10000n},{to:'0x'+'b2'.repeat(20),amountRaw:20000n}];
const spec={legs,nonce:batchNonce(7n,0n),executor:GAS,deadline:1_800_000_000n};
const k=s=>keccak256(toHex(s));
const pad=a=>'0x'+a.toLowerCase().slice(2).padStart(64,'0');

test('fixed keys derive the vector addresses',()=>{
 assert.equal(user.address,USER);assert.equal(gas.address,GAS);
});

test('delegation designator: 0xef0100 || Calibur, parsed back; other code is not a delegation',()=>{
 assert.equal(delegationCode(CALIBUR),'0xef0100000000005c84f8fd50b21cac312528a64437030e');
 assert.equal(delegatedTo('0xef0100000000005c84f8fd50b21cac312528a64437030e'),CALIBUR);
 assert.equal(delegatedTo('0x'),'');
 assert.equal(delegatedTo('0x6080604052'),null);
});

test('domain: typehash literal of EIP712.sol, salt = pack(prefix, Calibur)',()=>{
 assert.equal(k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)'),CALIBUR_DOMAIN_TYPEHASH);
 assert.equal(caliburSalt(),'0x000000000000000000000000000000005c84f8fd50b21cac312528a64437030e');
 assert.equal(caliburSalt(1n),'0x000000000000000000000001000000005c84f8fd50b21cac312528a64437030e');
 assert.throws(()=>caliburSalt(1n<<96n));
 assert.deepEqual(caliburDomain(USER),{name:'Calibur',version:'1.0.0',chainId:8453,verifyingContract:USER,salt:caliburSalt()});
});

test('nonce = key << 64 | seq',()=>{
 assert.equal(batchNonce(7n,0n),7n<<64n);
 assert.equal(batchNonce(1n,5n),(1n<<64n)+5n);
 assert.equal(nonceKey(batchNonce(123n,9n)),123n);
 assert.throws(()=>batchNonce(1n<<192n,0n));assert.throws(()=>batchNonce(0n,1n<<64n));
});

test('batch: USDC transfer calls, root key, revertOnFailure, executor and deadline pinned; refuses unsafe fields',()=>{
 const b=buildBatch(spec);
 assert.equal(b.batchedCall.calls.length,2);
 assert.equal(b.batchedCall.calls[0].to,USDC_BASE);
 assert.equal(b.batchedCall.calls[0].value,0n);
 assert.equal(b.batchedCall.calls[0].data,'0xa9059cbb'+pad(legs[0].to).slice(2)+toHex(10000n,{size:32}).slice(2));
 assert.equal(b.batchedCall.revertOnFailure,true);
 assert.equal(b.keyHash,ROOT_KEY_HASH);
 assert.equal(b.executor,GAS);
 assert.throws(()=>buildBatch({...spec,executor:'0x'+'00'.repeat(20)}),/anyone/);
 assert.throws(()=>buildBatch({...spec,deadline:0n}),/never expires/);
 assert.throws(()=>buildBatch({...spec,legs:Array(9).fill(legs[0])}));
 assert.throws(()=>buildBatch({...spec,legs:[{...legs[0],amountRaw:0n}]}));
});

test('typed data digest: fixed vector, equal to a Solidity-style recomputation of Calibur hashing',()=>{
 const b=buildBatch(spec);
 const d=batchDigest(USER,b);
 assert.equal(d,'0x5d9c6eaa090d1b2c689d272297513eb56b41054c47f630025ec889f42e992b90');
 // CallLib.hash / BatchedCallLib.hash / SignedBatchedCallLib.hash, EIP712.domainSeparator, toTypedDataHash.
 const CALL_T=k('Call(address to,uint256 value,bytes data)');
 const BC_T=k('BatchedCall(Call[] calls,bool revertOnFailure)Call(address to,uint256 value,bytes data)');
 const SBC_T=k(SIGNED_BATCHED_CALL_TYPE);
 const enc=(types,vals)=>keccak256(encodeAbiParameters(types.map(type=>({type})),vals));
 const callHashes=b.batchedCall.calls.map(c=>enc(['bytes32','address','uint256','bytes32'],[CALL_T,c.to,c.value,keccak256(c.data)]));
 const callsHash=keccak256(concat(callHashes));
 const bcHash=enc(['bytes32','bytes32','bool'],[BC_T,callsHash,true]);
 const sbcHash=enc(['bytes32','bytes32','uint256','bytes32','address','uint256'],[SBC_T,bcHash,b.nonce,b.keyHash,b.executor,b.deadline]);
 const ds=enc(['bytes32','bytes32','bytes32','uint256','address','bytes32'],[CALIBUR_DOMAIN_TYPEHASH,k('Calibur'),k('1.0.0'),8453n,USER,caliburSalt()]);
 assert.equal(keccak256(concat(['0x1901',ds,sbcHash])),d);
 // A different user address (verifyingContract) or salt prefix changes the digest.
 assert.notEqual(batchDigest(GAS,b),d);
 assert.notEqual(batchDigest(USER,b,{saltPrefix:1n}),d);
});

test('batch signature: fixed key signs the fixed vector; recovers to the user; Privy typed_data is JSON-safe',async()=>{
 const b=buildBatch(spec);
 const sig=await user.signTypedData(batchTypedData(USER,b));
 assert.equal(sig,'0xd200a44f8585153d4ab682c7f99e6be8325f3520ba9eba4d54cfb56cda1a62c17b9df321257bf23a06c24d99843e848c3e9263f3f093dd95c9df3db7937dbe141c');
 assert.equal(await recoverTypedDataAddress({...batchTypedData(USER,b),signature:sig}),USER);
 const p=privyTypedData(USER,b);
 assert.equal(p.primary_type,'SignedBatchedCall');
 assert.deepEqual(p.types.EIP712Domain.map(f=>f.name),['name','version','chainId','verifyingContract','salt']);
 assert.equal(p.message.nonce,String(7n<<64n));
 assert.equal(JSON.parse(JSON.stringify(p)).domain.salt,caliburSalt());
});

test('server batch validation: rebuilt from our legs, any altered field refused',()=>{
 const b=buildBatch(spec);
 assert.doesNotThrow(()=>assertBatchMatches(b,spec));
 const alt=structuredClone(b);alt.batchedCall.calls[1].data=buildBatch({...spec,legs:[legs[0],{...legs[1],amountRaw:20001n}]}).batchedCall.calls[1].data;
 assert.throws(()=>assertBatchMatches(alt,spec),/leg 1/);
 assert.throws(()=>assertBatchMatches({...b,executor:USER},spec),/executor/);
 assert.throws(()=>assertBatchMatches({...b,keyHash:'0x'+'01'.repeat(32)},spec),/root key/);
 assert.throws(()=>assertBatchMatches({...b,batchedCall:{...b.batchedCall,revertOnFailure:false}},spec),/revertOnFailure/);
 assert.throws(()=>assertBatchMatches({...b,nonce:b.nonce+1n},spec),/nonce/);
});

test('wrappedSignature = abi.encode(bytes sig, bytes hookData) with empty hookData (decodeWithHookData)',()=>{
 const sig='0x'+'ab'.repeat(65);
 const w=wrapSignature(sig);
 const words=w.slice(2).match(/.{64}/g);
 assert.equal(BigInt('0x'+words[0]),64n);// offset of signature
 assert.equal(BigInt('0x'+words[1]),64n+32n+96n);// offset of hookData: after sig length word + 3 words of data
 assert.equal(BigInt('0x'+words[2]),65n);// signature length
 assert.equal(BigInt('0x'+words[6]),0n);// hookData length
 assert.equal(words.length,7);
 assert.throws(()=>wrapSignature('0x'+'ab'.repeat(63)));
});

test('execute calldata: selector of execute(SignedBatchedCall,bytes) from the verified ABI, fixed vector, round trip',async()=>{
 assert.equal(EXECUTE_SIGNED_SIGNATURE,'execute((((address,uint256,bytes)[],bool),uint256,bytes32,address,uint256),bytes)');
 assert.equal(EXECUTE_SIGNED_SELECTOR,'0xc3c16ee4');
 const b=buildBatch(spec);
 const sig=await user.signTypedData(batchTypedData(USER,b));
 const data=executeCalldata(b,wrapSignature(sig));
 assert.equal(data.slice(0,10),'0xc3c16ee4');
 assert.equal((data.length-2)/2,1092);
 assert.equal(keccak256(data),'0x8c1e15455e238b1d2084bf57556ecfcce2a87cfe770e7cc7021c19463f92a613');
 const back=decodeExecuteCalldata(data);
 assert.equal(back.signature,sig);assert.equal(back.hookData,'0x');
 assert.equal(back.batch.executor,GAS);assert.equal(back.batch.nonce,b.nonce);
});

test('error selectors match the literals in WrappedSignatureLib.sol / CalldataDecoder.sol and the custom errors',()=>{
 assert.equal(CALIBUR_ERRORS['0x82b42900'],'Unauthorized');
 assert.equal(CALIBUR_ERRORS['0x756688fe'],'InvalidNonce');
 assert.equal(CALIBUR_ERRORS['0x8baa579f'],'InvalidSignature');
 assert.equal(CALIBUR_ERRORS['0x0819bdcd'],'SignatureExpired');
 assert.equal(CALIBUR_ERRORS['0x4be6321b'],'InvalidSignatureLength');
 assert.equal(CALIBUR_ERRORS['0x3b99b53d'],'SliceOutOfBounds');
 assert.equal(revertName('0x82b42900'),'Unauthorized');
 assert.equal(revertName(undefined),'no-revert-data');
});

test('authorization tuple: digest = keccak(0x05 || rlp([chain_id, address, nonce])), fixed signature, validation',async()=>{
 const req=authorizationRequest({nonce:3});
 assert.deepEqual(req,{chainId:8453,address:CALIBUR,nonce:3});
 const d=authorizationDigest(req);
 assert.equal(d,keccak256(concat(['0x05',toRlp([toHex(8453),CALIBUR,toHex(3)])])));
 assert.equal(d,'0xab2f498e4c9ca1816797153afb2bc2038fb64d8a4065b386a5138d132417b78b');
 const auth=await user.signAuthorization({chainId:8453,contractAddress:CALIBUR,nonce:3});
 assert.equal(auth.r,'0x04fc693e6707483415f93101e1193188ad513e46b69a855992e3a92c9ddeac44');
 assert.equal(auth.s,'0x441cb69a47c277bedb33267fe20b2d7af25a3e2c0323aef6be672ba1ae6203d7');
 assert.equal(auth.yParity,0);
 assert.equal(await assertAuthorization(auth,{user:USER,nonce:3}),true);
 await assert.rejects(assertAuthorization(auth,{user:USER,nonce:4}),/nonce/);
 await assert.rejects(assertAuthorization(auth,{user:GAS,nonce:3}),/not signed by the user/);
 await assert.rejects(assertAuthorization({...auth,address:GAS},{user:USER,nonce:3}),/contract/);
 await assert.rejects(assertAuthorization({...auth,chainId:1},{user:USER,nonce:3}),/chain_id/);
 assert.throws(()=>authorizationRequest({nonce:0,chainId:0}),/chain_id 0/);
 // Privy's answer shape maps to the same tuple.
 const p=fromPrivyAuthorization({contract:CALIBUR,chain_id:8453,nonce:3,r:auth.r,s:auth.s,y_parity:0});
 assert.equal(await assertAuthorization(p,{user:USER,nonce:3}),true);
});

test('type-4 transaction: built, signed by the gas wallet, parsed back field by field; tampering refused',async()=>{
 const b=buildBatch(spec);
 const data=executeCalldata(b,wrapSignature(await user.signTypedData(batchTypedData(USER,b))));
 const auth=await user.signAuthorization({chainId:8453,contractAddress:CALIBUR,nonce:3});
 const tx=buildType4({user:USER,authorization:auth,data,nonce:5,gas:200000n,maxFeePerGas:12_000_000n,maxPriorityFeePerGas:1_000_000n});
 const signed=await gas.signTransaction(tx);
 assert.equal(signed.slice(0,4),'0x04');
 assert.equal(await assertType4Bytes(signed,tx,GAS),'0xbbbeea9cecf5ece42e8db167b3edd21055226f8fd36bf754c4cbf22669abf31e');
 const p=parseTransaction(signed);
 assert.equal(p.to.toLowerCase(),USER.toLowerCase());assert.equal(p.authorizationList.length,1);
 assert.equal(p.authorizationList[0].address.toLowerCase(),CALIBUR.toLowerCase());
 await assert.rejects(assertType4Bytes(signed,{...tx,nonce:6},GAS),/differ/);
 await assert.rejects(assertType4Bytes(signed,tx,USER),/differ/);
 const other=await gas.signTransaction({...tx,authorizationList:[{...auth,nonce:4}]});
 await assert.rejects(assertType4Bytes(other,tx,GAS),/differ/);
});

test('leg evidence: one USDC Transfer(user -> to_i, amount_i) per leg, in order, repeats counted once each',()=>{
 const tlog=(from,to,amt,address=USDC_BASE)=>({address,topics:[TRANSFER_TOPIC,pad(from),pad(to)],data:toHex(amt,{size:32})});
 const L=[{to:legs[0].to,amountRaw:1n},{to:legs[0].to,amountRaw:1n},{to:legs[1].to,amountRaw:2n}];
 const ok=legEvidence([tlog(USER,legs[0].to,1n),tlog(USER,legs[0].to,1n),tlog(USER,legs[1].to,2n)],{user:USER,legs:L});
 assert.deepEqual(ok.map(x=>x.ok),[true,true,true]);
 const one=legEvidence([tlog(USER,legs[0].to,1n),tlog(USER,legs[1].to,2n)],{user:USER,legs:L});
 assert.deepEqual(one.map(x=>x.ok),[true,false,true]);
 const wrong=legEvidence([tlog(GAS,legs[0].to,1n),tlog(USER,legs[0].to,1n,GAS),tlog(USER,legs[0].to,3n)],{user:USER,legs:L.slice(0,1)});
 assert.deepEqual(wrong.map(x=>x.ok),[false]);
 assert.deepEqual(legEvidence([],{user:USER,legs:L}).map(x=>x.ok),[false,false,false]);
});

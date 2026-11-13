// EIP-7702 batched USDC transfers on Base through Uniswap Calibur v1.1.0, with OUR gas wallet as the sender (spike:
// ops/base-7702-spike.mjs, docs/BASE-7702-SPIKE.md). Pure builders, no I/O, no key storage.
//
// Encoding facts, read from Calibur v1.1.0 (github.com/Uniswap/calibur tag v1.1.0 = 249cac5; src/ is identical to the
// deployed commit d7dbc80 named in the README and to the Sourcify full-match sources for Base 8453 at CALIBUR):
//  - src/EIP712.sol: domain EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32
//    salt) with name "Calibur", version "1.0.0", chainId = block.chainid, verifyingContract = address(this) = the
//    user's EOA (code runs in the EOA's context), salt = _saltPrefix.pack(_cachedImplementation).
//  - src/libraries/PrefixedSaltLib.sol: pack(prefix, impl) = bytes32((uint256(prefix) << 160) | uint160(impl)), where
//    _cachedImplementation is the Calibur singleton (immutable set in its constructor) and _saltPrefix is 0 until the
//    EOA calls updateSalt(). So a fresh account's salt is CALIBUR left-padded to 32 bytes.
//  - src/libraries/{SignedBatchedCallLib,BatchedCallLib,CallLib}.sol: the type strings below; Call.data is hashed as
//    bytes, Call[] as keccak(concat(hashStruct(call_i))), i.e. standard EIP-712 (eth_signTypedData_v4 compatible).
//  - src/Calibur.sol execute(SignedBatchedCall,bytes wrappedSignature): executor must be 0 or msg.sender
//    (Unauthorized), deadline 0 or >= block.timestamp (SignatureExpired), _useNonce (InvalidNonce), then
//    wrappedSignature.decodeWithHookData() and key.verify(hashTypedData(hash(batch)), signature) (InvalidSignature).
//  - src/libraries/WrappedSignatureLib.sol decodeWithHookData: wrappedSignature = abi.encode(bytes signature, bytes
//    hookData), signature at least 64 bytes. hookData is unused for the root key (no hook), so it is empty.
//  - src/KeyManagement.sol getKey(0) = KeyLib.toRootKey() = Secp256k1 key of address(this): keyHash 0 = the EOA's key.
//  - src/NonceManager.sol: nonce = (uint192 key << 64) | uint64 seq; the seq for a key must match exactly, then +1.
import {encodeAbiParameters,encodeFunctionData,decodeFunctionData,decodeFunctionResult,hashTypedData,parseAbi,toFunctionSelector,
 keccak256,toHex,isAddress,getAddress,parseTransaction,recoverTransactionAddress,decodeAbiParameters,sha256} from 'viem';
import {hashAuthorization,recoverAuthorizationAddress} from 'viem/utils';
import {BASE_CHAIN_ID,USDC_BASE,TRANSFER_TOPIC} from './config.mjs';
import {transferData} from './source-executor.mjs';

export const CALIBUR='0x000000005c84F8Fd50b21CAC312528A64437030e';
export const DELEGATION_PREFIX='0xef0100';
export const ROOT_KEY_HASH='0x'+'00'.repeat(32);
export const ZERO_ADDRESS='0x'+'00'.repeat(20);
export const MAX_LEGS_7702=8;
export const CALIBUR_DOMAIN_TYPEHASH='0xd87cd6ef79d4e2b95e15ce8abf732db51ec771f1ca2edccf22a46c729ac56472';
export const SIGNED_BATCHED_CALL_TYPE='SignedBatchedCall(BatchedCall batchedCall,uint256 nonce,bytes32 keyHash,address executor,uint256 deadline)BatchedCall(Call[] calls,bool revertOnFailure)Call(address to,uint256 value,bytes data)';

export const CALIBUR_ABI=parseAbi([
 'struct Call { address to; uint256 value; bytes data; }',
 'struct BatchedCall { Call[] calls; bool revertOnFailure; }',
 'struct SignedBatchedCall { BatchedCall batchedCall; uint256 nonce; bytes32 keyHash; address executor; uint256 deadline; }',
 'function execute(SignedBatchedCall signedBatchedCall, bytes wrappedSignature) payable',
 'function getSeq(uint256 key) view returns (uint256)',
 'function domainSeparator() view returns (bytes32)',
 'function hashTypedData(bytes32 hash) view returns (bytes32)',
 'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
 'error Unauthorized()','error InvalidNonce()','error InvalidSignature()','error SignatureExpired()','error CallFailed(bytes reason)',
 'error InvalidSignatureLength()','error SliceOutOfBounds()','error KeyDoesNotExist()',
]);
/** Canonical signature of an ABI item (tuples expanded), e.g. execute((((address,uint256,bytes)[],bool),...),bytes). */
const canon=p=>p.type.startsWith('tuple')?`(${p.components.map(canon).join(',')})${p.type.slice(5)}`:p.type;
export const signatureOf=item=>`${item.name}(${item.inputs.map(canon).join(',')})`;
const selectorOf=item=>toFunctionSelector(signatureOf(item));
export const EXECUTE_SIGNED_SIGNATURE=signatureOf(CALIBUR_ABI.find(x=>x.type==='function'&&x.name==='execute'));
export const EXECUTE_SIGNED_SELECTOR=selectorOf(CALIBUR_ABI.find(x=>x.type==='function'&&x.name==='execute'));
/** Revert selectors we expect to see (InvalidSignatureLength 0x4be6321b and SliceOutOfBounds 0x3b99b53d are the
 * literals in WrappedSignatureLib.sol / CalldataDecoder.sol). */
export const CALIBUR_ERRORS=Object.freeze(Object.fromEntries(CALIBUR_ABI.filter(x=>x.type==='error').map(e=>[selectorOf(e),e.name])));

export const CALIBUR_TYPES=Object.freeze({
 SignedBatchedCall:[{name:'batchedCall',type:'BatchedCall'},{name:'nonce',type:'uint256'},{name:'keyHash',type:'bytes32'},
  {name:'executor',type:'address'},{name:'deadline',type:'uint256'}],
 BatchedCall:[{name:'calls',type:'Call[]'},{name:'revertOnFailure',type:'bool'}],
 Call:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'data',type:'bytes'}],
});

const lc=a=>String(a).toLowerCase();
const addr=(a,what)=>{if(!isAddress(String(a),{strict:false}))throw Error(`${what}: not an address`);return getAddress(a)};

/** 0xef0100 || delegate: the code an EOA carries once its 7702 authorization for `delegate` is processed. */
export const delegationCode=delegate=>DELEGATION_PREFIX+lc(addr(delegate,'delegate')).slice(2);
/** The delegate an EOA's code points to, '' for no code, null for other (non-designator) code. */
export function delegatedTo(code){
 const c=lc(code??'0x');
 if(c==='0x')return '';
 return /^0xef0100[0-9a-f]{40}$/.test(c)?getAddress('0x'+c.slice(8)):null;
}

/** PrefixedSaltLib.pack(prefix, implementation). */
export function caliburSalt(prefix=0n,implementation=CALIBUR){
 const p=BigInt(prefix);
 if(p<0n||p>=1n<<96n)throw Error('salt prefix out of range');
 return toHex((p<<160n)|BigInt(lc(addr(implementation,'implementation'))),{size:32});
}
export function caliburDomain(user,{chainId=BASE_CHAIN_ID,saltPrefix=0n}={}){
 return {name:'Calibur',version:'1.0.0',chainId,verifyingContract:addr(user,'user'),salt:caliburSalt(saltPrefix)};
}

/** nonce = (key << 64) | seq, key < 2^192, seq < 2^64 (NonceManager._useNonce). */
export function batchNonce(key,seq=0n){
 const k=BigInt(key),s=BigInt(seq);
 if(k<0n||k>=1n<<192n||s<0n||s>=1n<<64n)throw Error('nonce key/seq out of range');
 return (k<<64n)|s;
}
export const nonceKey=nonce=>BigInt(nonce)>>64n;

/** The SignedBatchedCall for N USDC transfers: root key, revertOnFailure true, executor = our gas wallet. */
export function buildBatch({legs,nonce,executor,deadline}){
 if(!Array.isArray(legs)||legs.length<1||legs.length>MAX_LEGS_7702)throw Error('legs: 1..'+MAX_LEGS_7702);
 const ex=addr(executor,'executor');
 if(lc(ex)===ZERO_ADDRESS)throw Error('executor 0 lets anyone execute');
 const d=BigInt(deadline);
 if(d<=0n)throw Error('deadline 0 never expires');
 return {
  batchedCall:{calls:legs.map(({to,amountRaw})=>{
   const a=BigInt(amountRaw);if(a<=0n)throw Error('amount must be positive');
   return {to:getAddress(USDC_BASE),value:0n,data:transferData(lc(addr(to,'recipient')),a)}}),revertOnFailure:true},
  nonce:BigInt(nonce),keyHash:ROOT_KEY_HASH,executor:ex,deadline:d,
 };
}
export function batchTypedData(user,batch,opts){
 return {domain:caliburDomain(user,opts),types:CALIBUR_TYPES,primaryType:'SignedBatchedCall',message:batch};
}
export const batchDigest=(user,batch,opts)=>hashTypedData(batchTypedData(user,batch,opts));

/** The `typed_data` object for Privy eth_signTypedData_v4 (JSON-safe: bigints as decimal strings). */
export function privyTypedData(user,batch,opts){
 const t=batchTypedData(user,batch,opts);
 const j=v=>JSON.parse(JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x));
 return {domain:j(t.domain),types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},
  {name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'},{name:'salt',type:'bytes32'}],...j(t.types)},
  primary_type:t.primaryType,message:j(t.message)};
}

/** WrappedSignatureLib.decodeWithHookData input: abi.encode(bytes signature, bytes hookData) with empty hookData. */
export function wrapSignature(signature,hookData='0x'){
 const n=(String(signature).length-2)/2;
 if(n!==65&&n!==64)throw Error('signature must be 64 or 65 bytes');
 return encodeAbiParameters([{type:'bytes'},{type:'bytes'}],[signature,hookData]);
}
export const executeCalldata=(batch,wrappedSignature)=>encodeFunctionData({abi:CALIBUR_ABI,functionName:'execute',args:[batch,wrappedSignature]});
export function decodeExecuteCalldata(data){
 const {functionName,args}=decodeFunctionData({abi:CALIBUR_ABI,data});
 if(functionName!=='execute'||args.length!==2)throw Error('not execute(SignedBatchedCall,bytes)');
 const [signature,hookData]=decodeAbiParameters([{type:'bytes'},{type:'bytes'}],args[1]);
 return {batch:args[0],signature,hookData};
}

/** The unsigned 7702 authorization the user signs (Privy eth_sign7702Authorization {contract, chain_id, nonce}). */
export function authorizationRequest({nonce,contract=CALIBUR,chainId=BASE_CHAIN_ID}){
 if(!Number.isInteger(chainId)||chainId===0)throw Error('chain_id 0 is valid on every chain: refused');
 if(!Number.isInteger(nonce)||nonce<0)throw Error('authorization nonce');
 return {chainId,address:addr(contract,'contract'),nonce};
}
/** keccak256(0x05 || rlp([chain_id, address, nonce])), the digest the authority signs. */
export const authorizationDigest=req=>hashAuthorization({chainId:req.chainId,contractAddress:req.address,nonce:req.nonce});
/** Privy's answer data.authorization {contract, chain_id, nonce, r, s, y_parity} -> viem SignedAuthorization. */
export function fromPrivyAuthorization(a){
 return {chainId:Number(a.chain_id),address:addr(a.contract,'contract'),nonce:Number(a.nonce),r:a.r,s:a.s,yParity:Number(a.y_parity)};
}

/** Server validation of a signed authorization (research section 4). Throws with the failing rule. */
export async function assertAuthorization(auth,{user,nonce,contract=CALIBUR,chainId=BASE_CHAIN_ID}){
 if(auth.chainId!==chainId)throw Error('authorization chain_id');
 if(lc(auth.address)!==lc(contract))throw Error('authorization contract');
 if(auth.nonce!==nonce)throw Error('authorization nonce is not the user\'s current nonce');
 const who=await recoverAuthorizationAddress({authorization:auth});
 if(lc(who)!==lc(user))throw Error('authorization not signed by the user');
 return true;
}
/** Server validation of a signed batch: rebuilt from our own legs, field by field, then signer recovery is by the
 * caller (viem recoverTypedDataAddress over batchTypedData). Returns the rebuilt batch. */
export function assertBatchMatches(batch,expected){
 const e=buildBatch(expected);
 const c=batch?.batchedCall?.calls??[];
 if(c.length!==e.batchedCall.calls.length)throw Error('batch leg count');
 c.forEach((x,i)=>{const y=e.batchedCall.calls[i];
  if(lc(x.to)!==lc(y.to)||BigInt(x.value)!==0n||lc(x.data)!==lc(y.data))throw Error(`batch leg ${i} differs`)});
 if(batch.batchedCall.revertOnFailure!==true)throw Error('revertOnFailure must be true');
 if(lc(batch.keyHash)!==ROOT_KEY_HASH)throw Error('keyHash must be the root key');
 if(lc(batch.executor)!==lc(e.executor))throw Error('executor must be our gas wallet');
 if(BigInt(batch.nonce)!==e.nonce||BigInt(batch.deadline)!==e.deadline)throw Error('nonce/deadline');
 return e;
}

/** The exact type-4 transaction our gas wallet sends: to = the user's EOA, data = execute(batch, wrappedSignature). */
export function buildType4({user,authorization,data,nonce,gas,maxFeePerGas,maxPriorityFeePerGas,chainId=BASE_CHAIN_ID}){
 return {type:'eip7702',chainId,to:addr(user,'user'),value:0n,data,nonce,gas:BigInt(gas),
  maxFeePerGas:BigInt(maxFeePerGas),maxPriorityFeePerGas:BigInt(maxPriorityFeePerGas),authorizationList:[authorization]};
}
/** The signed bytes parse back to exactly `tx`, signed by `sender`. Returns the hash. */
export async function assertType4Bytes(bytes,tx,sender){
 const p=parseTransaction(bytes),from=await recoverTransactionAddress({serializedTransaction:bytes});
 const a=p.authorizationList??[],b=tx.authorizationList;
 const same=p.type==='eip7702'&&p.chainId===tx.chainId&&lc(p.to)===lc(tx.to)&&(p.value??0n)===0n&&lc(p.data??'0x')===lc(tx.data)
  &&p.nonce===tx.nonce&&p.gas===tx.gas&&p.maxFeePerGas===tx.maxFeePerGas&&p.maxPriorityFeePerGas===tx.maxPriorityFeePerGas
  &&(p.accessList?.length??0)===0&&a.length===b.length&&a.every((x,i)=>x.chainId===b[i].chainId&&lc(x.address)===lc(b[i].address)
  &&x.nonce===b[i].nonce&&BigInt(x.r)===BigInt(b[i].r)&&BigInt(x.s)===BigInt(b[i].s)&&x.yParity===b[i].yParity)&&lc(from)===lc(sender);
 if(!same)throw Error('signed type-4 bytes differ from the prepared transaction');
 return keccak256(bytes);
}

const topicAddr=t=>typeof t==='string'&&/^0x0{24}[0-9a-f]{40}$/i.test(t)?'0x'+t.slice(26).toLowerCase():null;
/** Per-leg evidence: the USDC Transfer(user -> to_i, amount_i) logs, matched in order (a leg = one log). */
export function legEvidence(logs,{user,legs}){
 const t=(logs??[]).map((l,index)=>({l,index})).filter(({l})=>lc(l.address)===lc(USDC_BASE)&&l.topics?.[0]===TRANSFER_TOPIC
  &&topicAddr(l.topics[1])===lc(user));
 let k=0;// a log is used by at most one leg; a missing leg does not consume the logs after it
 return legs.map((leg,i)=>{
  for(let j=k;j<t.length;j++){const {l,index}=t[j];
   if(topicAddr(l.topics[2])===lc(leg.to)&&BigInt(l.data)===BigInt(leg.amountRaw)){k=j+1;return {leg:i,ok:true,log_index:index,from:lc(user),to:lc(leg.to),amount_raw:String(BigInt(l.data))}}}
  return {leg:i,ok:false,to:lc(leg.to),amount_raw:String(leg.amountRaw)};
 });
}
/** Revert data -> Calibur error name (or the raw selector). */
export function revertName(data){
 const s=lc(data??'').slice(0,10);
 return CALIBUR_ERRORS[s]??(s.length===10?s:'no-revert-data');
}

// Production helpers (batch-driver.mjs, BASE-7702-PRODUCTION-PLAN.md 2.1-2.2).

/** Plan 2.1 step 4: the batch nonce key of a trade = the top 192 bits of sha256("yeet-7702:" + trade_id). Every attempt
 * of the trade shares it, so at most one signed batch per trade can ever run on chain. */
export const tradeNonceKey=tradeId=>BigInt(sha256(toHex('yeet-7702:'+String(tradeId))))>>64n;
export const getSeqCalldata=key=>encodeFunctionData({abi:CALIBUR_ABI,functionName:'getSeq',args:[BigInt(key)]});
export const decodeSeq=data=>BigInt(decodeFunctionResult({abi:CALIBUR_ABI,functionName:'getSeq',data}));
export const EIP712_DOMAIN_CALLDATA=encodeFunctionData({abi:CALIBUR_ABI,functionName:'eip712Domain'});
/** eip712Domain() of a delegated EOA -> {name, version, chainId, verifyingContract, salt, saltPrefix}. The salt must be
 * pack(prefix, CALIBUR) (PrefixedSaltLib), else the domain is not Calibur's and the call throws. */
export function decodeDomain(data){
 const [,name,version,chainId,verifyingContract,salt]=decodeFunctionResult({abi:CALIBUR_ABI,functionName:'eip712Domain',data});
 const v=BigInt(salt),impl=v&((1n<<160n)-1n);
 if(impl!==BigInt(CALIBUR))throw Error('domain salt does not name Calibur');
 return {name,version,chainId:Number(chainId),verifyingContract:getAddress(verifyingContract),salt:toHex(v,{size:32}),saltPrefix:v>>160n};
}
/** The Privy typed_data of a sign request -> the viem signTypedData argument (bigints back, EIP712Domain dropped). */
export function typedDataForSigning(td){
 const {EIP712Domain:_d,...types}=td.types;
 const m=td.message;
 return {domain:{...td.domain,chainId:Number(td.domain.chainId)},types,primaryType:td.primary_type,
  message:{batchedCall:{calls:m.batchedCall.calls.map(c=>({to:c.to,value:BigInt(c.value),data:c.data})),revertOnFailure:m.batchedCall.revertOnFailure},
   nonce:BigInt(m.nonce),keyHash:m.keyHash,executor:m.executor,deadline:BigInt(m.deadline)}};
}
/** The type-2 twin of buildType4 for an already delegated wallet (no authorization list). */
export function buildType2({user,data,nonce,gas,maxFeePerGas,maxPriorityFeePerGas,chainId=BASE_CHAIN_ID}){
 return {type:'eip1559',chainId,to:addr(user,'user'),value:0n,data,nonce,gas:BigInt(gas),
  maxFeePerGas:BigInt(maxFeePerGas),maxPriorityFeePerGas:BigInt(maxPriorityFeePerGas)};
}
/** assertType4Bytes for the type-2 twin. Returns the hash. */
export async function assertType2Bytes(bytes,tx,sender){
 const p=parseTransaction(bytes),from=await recoverTransactionAddress({serializedTransaction:bytes});
 const same=p.type==='eip1559'&&p.chainId===tx.chainId&&lc(p.to)===lc(tx.to)&&(p.value??0n)===0n&&lc(p.data??'0x')===lc(tx.data)
  &&p.nonce===tx.nonce&&p.gas===tx.gas&&p.maxFeePerGas===tx.maxFeePerGas&&p.maxPriorityFeePerGas===tx.maxPriorityFeePerGas
  &&(p.accessList?.length??0)===0&&lc(from)===lc(sender);
 if(!same)throw Error('signed type-2 bytes differ from the prepared transaction');
 return keccak256(bytes);
}

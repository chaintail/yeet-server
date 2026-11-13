// The Solana basket: every leg in ONE transaction, the person signs once (plan SOLANA-BASKET-ONE-TX-PLAN.md 4.1).
// Exact bytes of the builder, the size boundary, and the basket guard: every refusal starts from a valid 5-leg basket
// and changes one thing, so each test fails if its rule is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertSponsorable,assertSponsorableBasket,SponsorshipRefusal} from './sponsorship.mjs';
import {buildBasketTransaction,buildLegTransaction,BatchRefusal} from './transfer-leg.mjs';
import {decodeTransaction,encodeTransaction,encodeMessage,associatedTokenAddress,transferChecked,createAssociatedTokenIdempotent,encodeLength,
 SYSTEM_PROGRAM,TOKEN_PROGRAM,USDC_SOLANA,TOKEN_ACCOUNT_RENT_LAMPORTS,MAX_TRANSACTION_BYTES} from './message.mjs';
import {feePayer,user,other,BLOCKHASH,pin,legTx,basketTx,buyPins,sellPins,DEPOSITS,COIN_MINTS} from './fixtures.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const refused=(fn,reason)=>assert.throws(fn,e=>e instanceof SponsorshipRefusal&&e.reason===reason,`expected ${reason}`);
const guard=(bytes,pins=buyPins())=>assertSponsorableBasket(bytes,pins,{});
/** Decode, change the compiled message, re-encode with one zero signature slot per header signer. */
function rewrite(bytes,fn){
 const t=decodeTransaction(bytes);const m=structuredClone(t.message);fn(m);
 return encodeTransaction(Array.from({length:m.header.signers},()=>new Uint8Array(64)),encodeMessage(m));
}
const all=pins=>pins.map(()=>true);
const MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// In the 5-leg buy with every create: instruction pairs (create, transfer) per leg; leg k's create at 2k, transfer at 2k+1.
const CREATE=k=>2*k,TRANSFER=k=>2*k+1;

test('exact bytes: the single-leg transaction is today\'s; 5-leg buy 899, sell 1155, sell with Token-2022 1187 bytes',()=>{
 // Today's single-leg fixture (compiled by fixtures.legTx, independent of transfer-leg.mjs), hash pinned.
 const today=legTx();
 assert.equal(today.length,535);
 assert.equal(sha(today),'f0e00b5d4dac158463643a5ce286a469b5dbacf0ebdcbd64200364ce06c84a6e');
 assert.deepEqual(buildLegTransaction(pin(),{blockhash:BLOCKHASH,createDestination:true}),today);
 assert.deepEqual(buildBasketTransaction([pin()],{blockhash:BLOCKHASH,creates:[true]}),today,'the basket of one is the leg');
 assert.equal(sha(buildLegTransaction(pin(),{blockhash:BLOCKHASH,createDestination:false})),'9a53c02320060f6456a0d54517b263a236455263841d14ff530516f99caa4e05');
 for(const [pins,size,hash] of [[buyPins(),899,'bb56ba8d00a3795bdb0de991b89857829987c7b693ae3d12b490db4662218583'],
  [sellPins(),1155,'deeb2e9e047d8261cad65951270426c032344a22339a68a2648e345d43ed2ec8'],
  [sellPins({token2022:true}),1187,'f6c86f55533b7f2eb75f88e6c42f8eb19d603d757ebc16ae6d2ebd40e3c8a35a']]){
  const b=buildBasketTransaction(pins,{blockhash:BLOCKHASH,creates:all(pins)});
  assert.equal(b.length,size);assert.equal(sha(b),hash);
  assert.deepEqual(b,basketTx({pins}),'builder and independent fixture agree');
  const t=decodeTransaction(b);
  assert.equal(t.message.header.signers,2);assert.deepEqual(t.message.accounts.slice(0,2),[feePayer.address,user.address]);
  assert.equal(t.message.instructions.length,2+2*pins.length);
 }
});

test('valid 5-leg basket: fee 18,000 lamports (two signatures + 400,000 CU x 20,000), 5 rent accounts, creates per leg',()=>{
 const r=guard(basketTx());
 assert.equal(r.feeLamports,18_000);assert.equal(r.rentAccounts,5);assert.equal(r.rentLamports,5*TOKEN_ACCOUNT_RENT_LAMPORTS);
 assert.deepEqual(r.creates,[true,true,true,true,true]);
 assert.deepEqual(r.legs.map(l=>l.destination),DEPOSITS.map(d=>associatedTokenAddress(d,USDC_SOLANA)));
 const some=[true,false,true,false,false];
 const s=guard(basketTx({creates:some}));
 assert.deepEqual(s.creates,some);assert.equal(s.rentAccounts,2);
 const sell=assertSponsorableBasket(basketTx({pins:sellPins({token2022:true})}),sellPins({token2022:true}),{});
 assert.equal(sell.rentAccounts,5);
 // The single-leg guard keeps its result shape.
 assert.deepEqual(Object.keys(assertSponsorable(legTx(),pin())).sort(),['createsDepositAccount','destination','feeLamports','rentLamports','source']);
});

test('extra instruction: a Memo, a System transfer, a second transfer of a leg',()=>{
 refused(()=>guard(basketTx({edit:ixs=>[...ixs,{programAddress:MEMO,data:Uint8Array.from([104,105]),accounts:[]}]})),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(basketTx({edit:ixs=>[...ixs,{programAddress:SYSTEM_PROGRAM,data:Uint8Array.from([2,0,0,0,1,0,0,0,0,0,0,0]),accounts:[{address:user.address,signer:true,writable:true},{address:other.address,writable:true}]}]})),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(basketTx({edit:ixs=>[...ixs,ixs[TRANSFER(4)]]})),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>guard(basketTx({edit:ixs=>[...ixs.slice(0,TRANSFER(2)+1),ixs[TRANSFER(2)],...ixs.slice(TRANSFER(2)+1)]})),'SPONSOR_TRANSFER_MISMATCH');
});

test('wrong mint on leg 3, wrong amount on leg 2',()=>{
 const p=buyPins();
 const mint3=p.map((x,i)=>i===3?{...x,mint:COIN_MINTS[0]}:x);
 // The transfer of leg 3 in another mint (its deposit account already exists, so no create).
 refused(()=>guard(basketTx({pins:mint3,creates:[true,true,true,false,true]}),p),'SPONSOR_TRANSFER_MISMATCH');
 // With its create: the fee payer would pay rent for an account of a mint no leg has.
 refused(()=>guard(basketTx({pins:mint3}),p),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(basketTx({pins:p.map((x,i)=>i===2?{...x,amount:x.amount+1n}:x)}),p),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>guard(basketTx({pins:p.map((x,i)=>i===2?{...x,decimals:9}:x)}),p),'SPONSOR_TRANSFER_MISMATCH');
});

test('wrong destination owner on leg 1 (create and transfer to another owner); wrong source; authority not the person',()=>{
 const p=buyPins();
 refused(()=>guard(basketTx({pins:p.map((x,i)=>i===1?{...x,depositOwner:other.address}:x)}),p),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(basketTx({pins:p.map((x,i)=>i===1?{...x,depositOwner:other.address}:x),creates:[true,false,true,true,true]}),p),'SPONSOR_TRANSFER_MISMATCH');
 const src=basketTx({edit:ixs=>ixs.map((ix,i)=>i===TRANSFER(2)?transferChecked({source:associatedTokenAddress(other.address,USDC_SOLANA),mint:USDC_SOLANA,destination:associatedTokenAddress(DEPOSITS[2],USDC_SOLANA),authority:user.address,amount:p[2].amount,decimals:6,tokenProgram:TOKEN_PROGRAM}):ix)});
 refused(()=>guard(src),'SPONSOR_TRANSFER_MISMATCH');
 // Authority of leg 3's transfer pointed at another (non-signer) account of the message.
 const auth=rewrite(basketTx(),m=>{const ix=m.instructions[2+TRANSFER(3)];ix.accounts[3]=m.instructions[2+TRANSFER(0)].accounts[2]});
 refused(()=>guard(auth),'SPONSOR_TRANSFER_MISMATCH');
});

test('signers: a third signer, another fee payer, the fee payer outside a create payer slot',()=>{
 const three=rewrite(basketTx(),m=>{m.accounts.splice(2,0,other.address);m.header.signers=3;m.header.readonlySigned+=1;
  m.instructions=m.instructions.map(ix=>({...ix,programIndex:ix.programIndex>=2?ix.programIndex+1:ix.programIndex,accounts:ix.accounts.map(a=>a>=2?a+1:a)}))});
 refused(()=>guard(three),'SPONSOR_SIGNERS_MISMATCH');
 refused(()=>guard(basketTx({pins:buyPins({feePayer:other.address})})),'SPONSOR_SIGNERS_MISMATCH');
 // Pins that disagree on the wallet.
 refused(()=>guard(basketTx(),buyPins().map((x,i)=>i===4?{...x,wallet:other.address}:x)),'SPONSOR_SIGNERS_MISMATCH');
 // Account 0 as the source of leg 2's transfer, and as the owner slot of leg 0's create.
 refused(()=>guard(rewrite(basketTx(),m=>{m.instructions[2+TRANSFER(2)].accounts[0]=0})),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(rewrite(basketTx(),m=>{m.instructions[2+CREATE(0)].accounts[2]=0})),'SPONSOR_INSTRUCTION_REFUSED');
});

test('positional walk: reordered legs, a create without its transfer, a second create for a leg, a missing leg',()=>{
 // Swap legs 1 and 2 (both pairs).
 refused(()=>guard(basketTx({edit:ixs=>[ixs[0],ixs[1],ixs[4],ixs[5],ixs[2],ixs[3],...ixs.slice(6)]})),'SPONSOR_TRANSFER_MISMATCH');
 // Only the transfers of legs 1 and 2 swapped.
 refused(()=>guard(basketTx({edit:ixs=>ixs.map((ix,i)=>i===TRANSFER(1)?ixs[TRANSFER(2)]:i===TRANSFER(2)?ixs[TRANSFER(1)]:ix)})),'SPONSOR_TRANSFER_MISMATCH');
 // Leg 2's create with no transfer after it.
 refused(()=>guard(basketTx({edit:ixs=>ixs.filter((_,i)=>i!==TRANSFER(2))})),'SPONSOR_TRANSFER_MISMATCH');
 // Leg 2's create twice.
 refused(()=>guard(basketTx({edit:ixs=>[...ixs.slice(0,TRANSFER(2)),ixs[CREATE(2)],...ixs.slice(TRANSFER(2))]})),'SPONSOR_TRANSFER_MISMATCH');
 // Leg 4 missing entirely.
 refused(()=>guard(basketTx({pins:buyPins().slice(0,4)})),'SPONSOR_TRANSFER_MISMATCH');
 // A trailing create for leg 4's account again (after its transfer).
 refused(()=>guard(basketTx({edit:ixs=>[...ixs,ixs[CREATE(4)]]})),'SPONSOR_TRANSFER_MISMATCH');
});

test('duplicate destination: refused by the guard; the builder will not make one transaction of it',()=>{
 const dup=buyPins().map((x,i)=>i===1?{...x,depositOwner:DEPOSITS[0]}:x);
 refused(()=>guard(basketTx({pins:dup,creates:[true,false,true,true,true]}),dup),'SPONSOR_TRANSFER_MISMATCH');
 assert.throws(()=>buildBasketTransaction(dup,{blockhash:BLOCKHASH,creates:all(dup)}),e=>e instanceof BatchRefusal&&e.code==='BATCH_UNSUPPORTED');
 // A deposit memo cannot ride in a basket either (a leg alone keeps today's behaviour).
 const memo=buyPins().map((x,i)=>i===3?{...x,depositMemo:'m-1'}:x);
 assert.throws(()=>buildBasketTransaction(memo,{blockhash:BLOCKHASH,creates:all(memo)}),e=>e.code==='BATCH_UNSUPPORTED');
 assert.doesNotThrow(()=>buildBasketTransaction([memo[3]],{blockhash:BLOCKHASH,creates:[true]}));
});

test('stray account, lookup table, compute price and limit over cap',()=>{
 const stray=rewrite(basketTx(),m=>{m.accounts.push(other.address);m.header.readonlyUnsigned+=1});
 refused(()=>guard(stray),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(rewrite(basketTx(),m=>{m.lookups=[{table:other.address,writable:[0],readonly:[]}]})),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>guard(basketTx({priorityMicroLamports:50_001n})),'CLIENT_FEE_CAP_EXCEEDED');
 refused(()=>guard(basketTx({computeUnitLimit:1_400_001})),'CLIENT_FEE_CAP_EXCEEDED');
 // 1.4M CU at 50,000 micro-lamports is 70,000 lamports of priority + 10,000: exactly the 80,000 cap; a lower cap refuses.
 assert.equal(guard(basketTx({computeUnitLimit:1_400_000,priorityMicroLamports:50_000n})).feeLamports,80_000);
 refused(()=>assertSponsorableBasket(basketTx({computeUnitLimit:1_400_000,priorityMicroLamports:50_000n}),buyPins(),{maxFeeLamports:79_999}),'CLIENT_FEE_CAP_EXCEEDED');
 refused(()=>assertSponsorableBasket(basketTx(),buyPins(),{maxFeeLamports:17_999}),'CLIENT_FEE_CAP_EXCEEDED');
});

test('size boundary: the largest 5-leg basket fits; a synthetic 6th leg is BATCH_TOO_LARGE for the builder and unreadable for the guard',()=>{
 const big=sellPins({token2022:true});
 const b=buildBasketTransaction(big,{blockhash:BLOCKHASH,creates:all(big)});
 assert.ok(b.length<=MAX_TRANSACTION_BYTES);assert.doesNotThrow(()=>assertSponsorableBasket(b,big,{}));
 const six=[...big,pin({depositOwner:other.address,mint:user.address,amount:7n})];
 assert.throws(()=>buildBasketTransaction(six,{blockhash:BLOCKHASH,creates:all(six)}),e=>e.code==='BATCH_UNSUPPORTED','at most 5 legs');
 assert.throws(()=>buildBasketTransaction(six,{blockhash:BLOCKHASH,creates:all(six),maxLegs:6}),e=>e instanceof BatchRefusal&&e.code==='BATCH_TOO_LARGE');
 // The same 6-leg message encoded past the limit by hand: the guard refuses it unread.
 const ixs=six.flatMap(p=>{const ata=associatedTokenAddress(p.depositOwner,p.mint,p.tokenProgram);return [createAssociatedTokenIdempotent({payer:p.feePayer,ata,owner:p.depositOwner,mint:p.mint,tokenProgram:p.tokenProgram}),
  transferChecked({source:associatedTokenAddress(p.wallet,p.mint,p.tokenProgram),mint:p.mint,destination:ata,authority:p.wallet,amount:p.amount,decimals:p.decimals,tokenProgram:p.tokenProgram})]});
 const five=decodeTransaction(b).message;
 const msg=structuredClone(five);
 // Extra accounts and instruction bytes until one byte over (a 6th leg's worth of accounts: more than enough).
 const extra=[...new Set(ixs.slice(-2).flatMap(ix=>ix.accounts.map(a=>a.address)))].filter(a=>!msg.accounts.includes(a));
 msg.accounts.push(...extra);msg.header.readonlyUnsigned+=extra.length;
 const bytes=Uint8Array.from([...encodeLength(2),...new Uint8Array(128),...encodeMessage(msg)]);
 assert.ok(bytes.length>MAX_TRANSACTION_BYTES,`${bytes.length}`);
 refused(()=>assertSponsorableBasket(bytes,six,{}),'SPONSOR_TRANSACTION_UNREADABLE');
});

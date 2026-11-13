// Guard vectors for the Solana leg (design 2.2, Folio sponsorship-*.test.ts and fee-payer.test.ts cases ported).
// Every refusal starts from the valid leg transaction and changes one thing, so each test fails if its guard is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSponsorable,SponsorshipRefusal,readSponsorshipLimits,sponsoredSendKey} from './sponsorship.mjs';
import {verifySolanaPartialTransaction,verifySolanaSignedTransaction} from './verify.mjs';
import {decodeTransaction,encodeTransaction,encodeMessage,decodeMessage,associatedTokenAddress,createAssociatedTokenIdempotent,transferChecked,
 SYSTEM_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC_SOLANA,TOKEN_ACCOUNT_RENT_LAMPORTS,WireError} from './message.mjs';
import {feePayer,user,other,DEPOSIT,BLOCKHASH,pin,legTx} from './fixtures.mjs';

const refused=(fn,reason)=>assert.throws(fn,e=>e instanceof SponsorshipRefusal&&e.reason===reason,`expected ${reason}`);
/** Decode, change the compiled message, re-encode with one zero signature slot per header signer. */
function rewrite(bytes,fn){
 const t=decodeTransaction(bytes);const m=structuredClone(t.message);fn(m);
 return encodeTransaction(Array.from({length:m.header.signers},()=>new Uint8Array(64)),encodeMessage(m));
}
const WIF='EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

test('valid leg: accepted, fee and deposit-account rent reported',()=>{
 const r=assertSponsorable(legTx(),pin());
 assert.equal(r.createsDepositAccount,true);
 assert.equal(r.rentLamports,TOKEN_ACCOUNT_RENT_LAMPORTS);
 assert.equal(r.feeLamports,2*5000+Math.ceil(80_000*20_000/1e6));
 assert.equal(r.destination,associatedTokenAddress(DEPOSIT,USDC_SOLANA));
 const noCreate=assertSponsorable(legTx({create:false}),pin());
 assert.equal(noCreate.createsDepositAccount,false);assert.equal(noCreate.rentLamports,0);
});
test('message codec: strict decode and re-encode equality, v0 with no lookup table, fee payer then owner',()=>{
 const t=decodeTransaction(legTx());
 assert.equal(t.message.version,0);assert.deepEqual(t.message.lookups,[]);
 assert.deepEqual(t.message.accounts.slice(0,2),[feePayer.address,user.address]);
 assert.deepEqual(encodeMessage(decodeMessage(t.messageBytes)),t.messageBytes);
});
test('unreadable: trailing byte, non-canonical length, oversize, garbage',()=>{
 const ok=legTx();
 refused(()=>assertSponsorable(Uint8Array.from([...ok,0]),pin()),'SPONSOR_TRANSACTION_UNREADABLE');
 refused(()=>assertSponsorable(Uint8Array.from([0x82,0x00,...ok.subarray(1)]),pin()),'SPONSOR_TRANSACTION_UNREADABLE');
 refused(()=>assertSponsorable(new Uint8Array(1300),pin()),'SPONSOR_TRANSACTION_UNREADABLE');
 refused(()=>assertSponsorable(new Uint8Array(200),pin()),'SPONSOR_TRANSACTION_UNREADABLE');
 assert.throws(()=>decodeTransaction(Uint8Array.from([...ok,0])),WireError);
});
test('signers: exactly two, fee payer first, the person second',()=>{
 refused(()=>assertSponsorable(legTx({p:pin({feePayer:other.address})}),pin()),'SPONSOR_SIGNERS_MISMATCH');
 refused(()=>assertSponsorable(legTx(),pin({wallet:other.address})),'SPONSOR_SIGNERS_MISMATCH');
 // A third signer: other becomes a required signer.
 const three=rewrite(legTx(),m=>{m.accounts.splice(2,0,other.address);m.header.signers=3;m.header.readonlySigned+=1;
  m.instructions=m.instructions.map(ix=>({...ix,programIndex:ix.programIndex>=2?ix.programIndex+1:ix.programIndex,accounts:ix.accounts.map(a=>a>=2?a+1:a)}))});
 refused(()=>assertSponsorable(three,pin()),'SPONSOR_SIGNERS_MISMATCH');
});
test('lookup table refused',()=>{
 const lut=rewrite(legTx(),m=>{m.lookups=[{table:other.address,writable:[0],readonly:[]}]});
 refused(()=>assertSponsorable(lut,pin()),'SPONSOR_INSTRUCTION_REFUSED');
});
test('System instruction refused (a transfer of the fee payer lamports)',()=>{
 const sys=legTx({edit:ixs=>[...ixs,{programAddress:SYSTEM_PROGRAM,data:Uint8Array.from([2,0,0,0,1,0,0,0,0,0,0,0]),accounts:[{address:feePayer.address,signer:true,writable:true},{address:DEPOSIT,writable:true}]}]});
 refused(()=>assertSponsorable(sys,pin()),'SPONSOR_INSTRUCTION_REFUSED');
});
test('program outside the allowlist refused',()=>{
 const memo=legTx({edit:ixs=>[...ixs,{programAddress:'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',data:Uint8Array.from([104,105]),accounts:[]}]});
 refused(()=>assertSponsorable(memo,pin()),'SPONSOR_INSTRUCTION_REFUSED');
 // An unknown program dressed as TransferChecked (same data and account layout).
 const fake=legTx({edit:ixs=>[ixs[0],{...ixs[1],programAddress:'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'}]});
 refused(()=>assertSponsorable(fake,pin()),'SPONSOR_INSTRUCTION_REFUSED');
});
test('rent rule: only the deposit address token account for the leg mint (new rule)',()=>{
 const create=o=>legTx({edit:ixs=>[createAssociatedTokenIdempotent({payer:feePayer.address,tokenProgram:TOKEN_PROGRAM,...o}),ixs[1]]});
 // Another owner (the person: Folio's rule would allow this one).
 refused(()=>assertSponsorable(create({owner:user.address,mint:USDC_SOLANA,ata:associatedTokenAddress(user.address,USDC_SOLANA)}),pin()),'SPONSOR_INSTRUCTION_REFUSED');
 // Another mint.
 refused(()=>assertSponsorable(create({owner:DEPOSIT,mint:WIF,ata:associatedTokenAddress(DEPOSIT,WIF)}),pin()),'SPONSOR_INSTRUCTION_REFUSED');
 // A second reference to account 0: the fee payer as the owner of the created account.
 refused(()=>assertSponsorable(create({owner:feePayer.address,mint:USDC_SOLANA,ata:associatedTokenAddress(feePayer.address,USDC_SOLANA)}),pin()),'SPONSOR_INSTRUCTION_REFUSED');
 // Right owner and mint, but the fee payer also in the System program slot.
 const sysSlot=legTx({edit:ixs=>[{...ixs[0],accounts:ixs[0].accounts.map((a,i)=>i===4?{address:feePayer.address}:a)},ixs[1]]});
 refused(()=>assertSponsorable(sysSlot,pin()),'SPONSOR_INSTRUCTION_REFUSED');
 // Right owner and mint, but an account other than their ATA.
 refused(()=>assertSponsorable(create({owner:DEPOSIT,mint:USDC_SOLANA,ata:other.address}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 // Two creates.
 const two=legTx({edit:ixs=>[ixs[0],ixs[0],ixs[1]]});
 refused(()=>assertSponsorable(two,pin()),'SPONSOR_TRANSFER_MISMATCH');
});
test('TransferChecked pinned: amount, destination, source, mint, decimals, authority, program; exactly one',()=>{
 const tc=o=>{const p=pin();const ata=associatedTokenAddress(DEPOSIT,USDC_SOLANA);
  return legTx({edit:ixs=>[ixs[0],transferChecked({source:associatedTokenAddress(user.address,USDC_SOLANA),mint:USDC_SOLANA,destination:ata,authority:user.address,amount:p.amount,decimals:6,tokenProgram:TOKEN_PROGRAM,...o})]})};
 assert.doesNotThrow(()=>assertSponsorable(tc({}),pin()));
 refused(()=>assertSponsorable(tc({amount:5_000_001n}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(tc({destination:associatedTokenAddress(other.address,USDC_SOLANA)}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(tc({source:associatedTokenAddress(other.address,USDC_SOLANA)}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(tc({mint:WIF}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(tc({decimals:9}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(tc({tokenProgram:TOKEN_2022_PROGRAM}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 // The fee payer as authority references account 0 outside the rent position.
 refused(()=>assertSponsorable(legTx({owner:user.address,edit:ixs=>[ixs[0],{...ixs[1],accounts:ixs[1].accounts.map((a,i)=>i===3?{address:feePayer.address,signer:true}:a)},{programAddress:TOKEN_PROGRAM,data:Uint8Array.from([12,0,0,0,0,0,0,0,0,6]),accounts:[{address:associatedTokenAddress(user.address,USDC_SOLANA),writable:true},{address:USDC_SOLANA},{address:associatedTokenAddress(DEPOSIT,USDC_SOLANA),writable:true},{address:user.address,signer:true}]}]}),pin()),'SPONSOR_INSTRUCTION_REFUSED');
 refused(()=>assertSponsorable(legTx({edit:ixs=>[ixs[0],ixs[1],ixs[1]]}),pin()),'SPONSOR_TRANSFER_MISMATCH');
 refused(()=>assertSponsorable(rewrite(legTx(),m=>{m.instructions=m.instructions.slice(0,3)}),pin()),'SPONSOR_TRANSFER_MISMATCH');
});
test('token instructions other than TransferChecked refused (CloseAccount, Approve, ApproveChecked, SetAuthority, Transfer)',()=>{
 const src=associatedTokenAddress(user.address,USDC_SOLANA);
 const extra=data=>legTx({edit:ixs=>[...ixs,{programAddress:TOKEN_PROGRAM,data:Uint8Array.from(data),accounts:[{address:src,writable:true},{address:DEPOSIT,writable:true},{address:user.address,signer:true}]}]});
 refused(()=>assertSponsorable(extra([9]),pin()),'SPONSOR_CLOSE_ACCOUNT_REFUSED');
 for(const tag of [4,13,6,3])refused(()=>assertSponsorable(extra([tag,1,0,0,0,0,0,0,0]),pin()),'SPONSOR_INSTRUCTION_REFUSED');
});
test('fee cap: compute limit, priority price, total fee, compute-budget layout',()=>{
 refused(()=>assertSponsorable(legTx({computeUnitLimit:1_500_000}),pin()),'CLIENT_FEE_CAP_EXCEEDED');
 refused(()=>assertSponsorable(legTx({priorityMicroLamports:50_001n}),pin()),'CLIENT_FEE_CAP_EXCEEDED');
 refused(()=>assertSponsorable(legTx(),pin({maxFeeLamports:10_000})),'CLIENT_FEE_CAP_EXCEEDED');
 // Compute budget moved after the transfer.
 const moved=rewrite(legTx(),m=>{m.instructions=[...m.instructions.slice(2),...m.instructions.slice(0,2)]});
 refused(()=>assertSponsorable(moved,pin()),'CLIENT_FEE_CAP_EXCEEDED');
 // A third compute-budget instruction (a second price) at the end.
 const third=rewrite(legTx(),m=>{m.instructions=[...m.instructions,m.instructions[1]]});
 refused(()=>assertSponsorable(third,pin()),'CLIENT_FEE_CAP_EXCEEDED');
});
test('message decoder alone refuses a trailing byte',()=>{
 const {messageBytes}=decodeTransaction(legTx());
 assert.throws(()=>decodeMessage(Uint8Array.from([...messageBytes,0])),WireError);
});
test('partial verify: only the person slot, over the unchanged message, fee-payer slot zero',()=>{
 const unsigned=legTx(),partial=user.signTransaction(unsigned);
 assert.equal(verifySolanaPartialTransaction(unsigned,partial,user.address),true);
 // Mutated message (another amount) signed by the person: not the stored message.
 const mutated=user.signTransaction(legTx({p:pin({amount:4_000_000n})}));
 assert.equal(verifySolanaPartialTransaction(unsigned,mutated,user.address),false);
 // The fee payer slot already filled.
 assert.equal(verifySolanaPartialTransaction(unsigned,feePayer.signTransaction(partial),user.address),false);
 // Wrong wallet.
 assert.equal(verifySolanaPartialTransaction(unsigned,partial,other.address),false);
 // A flipped signature bit.
 const bad=Uint8Array.from(partial);bad[1+64+3]^=1;
 assert.equal(verifySolanaPartialTransaction(unsigned,bad,user.address),false);
 // The original must be unsigned.
 assert.equal(verifySolanaPartialTransaction(partial,partial,user.address),false);
});
test('full verify: every slot valid, preserved person signature unchanged, signature = slot 0',()=>{
 const partial=user.signTransaction(legTx()),full=feePayer.signTransaction(partial);
 const v=verifySolanaSignedTransaction(partial,full,feePayer.address);
 assert.ok(v&&typeof v.signature==='string'&&v.signature.length>=64);
 // A fee payer answer that replaced the person's signature with another valid-looking one.
 const swapped=feePayer.signTransaction(user.signTransaction(legTx({p:pin({amount:1n})})));
 assert.equal(verifySolanaSignedTransaction(partial,swapped,feePayer.address),null);
 // The stored bytes carry a person signature; the answer carries a different (valid) one in that slot.
 const t=decodeTransaction(partial),stored=encodeTransaction([t.signatures[0],new Uint8Array(64).fill(7)],t.messageBytes);
 const why=[];
 assert.equal(verifySolanaSignedTransaction(stored,full,feePayer.address,r=>why.push(r)),null);
 assert.deepEqual(why,['preserved_signature_changed']);
 const reasons=[];
 const resigned=Uint8Array.from(full);resigned[1+64+64+5]^=1;// message byte changed
 assert.equal(verifySolanaSignedTransaction(partial,resigned,feePayer.address,r=>reasons.push(r)),null);
 assert.deepEqual(reasons,['message_changed']);
});
test('sponsorship limits: strict env parsing and the exit reserve check',()=>{
 assert.equal(readSponsorshipLimits({}).daily_lamports,2_000_000);
 for(const bad of ['0','2e6','2_000_000','1.5','-1'])assert.throws(()=>readSponsorshipLimits({YEET_SPONSOR_DAILY_LAMPORTS:bad}));
 assert.throws(()=>readSponsorshipLimits({YEET_SPONSOR_DAILY_LAMPORTS:'6000000'}),/exit reserve/);
 assert.throws(()=>readSponsorshipLimits({YEET_SPONSOR_MAX_FEE_LAMPORTS:'90000'}));
 assert.match(sponsoredSendKey(legTx()),/^[0-9a-f]{64}$/);
 assert.equal(BLOCKHASH.length>30,true);
});

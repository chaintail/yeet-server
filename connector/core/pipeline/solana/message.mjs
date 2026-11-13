// Solana wire format for the sponsored leg, by hand (no web3 dependency).
// Lifted from Folio (stock-app origin/main 70848f097): apps/server/src/assembly/message.ts `buildMessage` rules
// (account 0 = fee payer, account 1 = owner, no third signer, exactly two compute-budget instructions lead, every
// program static, at most 1232 bytes) and packages/wallet-privy/src/solana.ts `assertStaticPolicyAccounts` (strict
// compact-u16 reader). Folio compiles with @solana/kit; YEET encodes the same v0 layout directly. The ATA derivation is
// YEET's own (trade/solana-tx.mjs, kept unchanged here).
import {createHash} from 'node:crypto';
import {base58Decode,base58Encode} from '../../trade/router.mjs';

export const SYSTEM_PROGRAM='11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM='ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const USDC_SOLANA='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_MAINNET_CAIP2='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** Folio message.ts MAX_TRANSACTION_BYTES. */
export const MAX_TRANSACTION_BYTES=1232;
/** Folio client-signing.ts: base64 of at most 1232 bytes. */
export const MAX_TRANSACTION_BASE64=1644;
/** Rent-exempt minimum of a 165-byte token account (the deposit address's ATA). */
export const TOKEN_ACCOUNT_RENT_LAMPORTS=2_039_280;

export class WireError extends Error{constructor(m='unreadable transaction'){super(m);this.name='WireError'}}

/** 32 raw bytes of a base58 Solana address; throws on anything else. */
export function key(address){
 const b=typeof address==='string'?base58Decode(address):null;
 if(!b||b.length!==32)throw new WireError('invalid Solana address');
 return Uint8Array.from(b);
}
export const isAddress=a=>{try{key(a);return true}catch{return false}};

// ---- ATA derivation (trade/solana-tx.mjs) ----
const P=2n**255n-19n;
const mod=a=>((a%P)+P)%P;
function pow(b,e){let r=1n;b=mod(b);while(e>0n){if(e&1n)r=r*b%P;b=b*b%P;e>>=1n}return r}
const D=mod(-121665n*pow(121666n,P-2n));
/** Whether 32 bytes decode to an ed25519 point (curve25519-dalek decompress semantics). */
export function isOnCurve(bytes){
 let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)|BigInt(bytes[i]);
 y&=(1n<<255n)-1n;y=mod(y);
 const y2=y*y%P,u=mod(y2-1n),v=mod(D*y2+1n);
 if(v===0n)return u===0n;
 const x2=u*pow(v,P-2n)%P;
 return x2===0n||pow(x2,(P-1n)/2n)===1n;
}
export function findProgramAddress(seeds,programId){
 for(let bump=255;bump>=0;bump--){
  const h=createHash('sha256');for(const s of seeds)h.update(s);h.update(Uint8Array.of(bump));h.update(key(programId));h.update('ProgramDerivedAddress');
  const out=h.digest();
  if(!isOnCurve(out))return [base58Encode(out),bump];
 }
 throw Error('no program address');
}
export const associatedTokenAddress=(owner,mint,tokenProgram=TOKEN_PROGRAM)=>findProgramAddress([key(owner),key(tokenProgram),key(mint)],ATA_PROGRAM)[0];

// ---- compact-u16 ----
export function encodeLength(n){
 if(!Number.isInteger(n)||n<0||n>0xffff)throw new WireError('length out of range');
 const out=[];do{let b=n&0x7f;n>>=7;if(n)b|=0x80;out.push(b)}while(n);return out;
}
/** Strict reader over `bytes`: compact-u16 lengths must be canonical (Folio solana.ts `length`), reads past the end throw. */
function reader(bytes){
 let offset=0;
 const r={
  get offset(){return offset},
  byte(){if(offset>=bytes.length)throw new WireError();return bytes[offset++]},
  take(n){if(n<0||offset+n>bytes.length)throw new WireError();const v=bytes.slice(offset,offset+n);offset+=n;return v},
  length(){
   let value=0;
   for(let i=0;i<3;i++){
    const next=r.byte();
    if(i===2&&next>3)throw new WireError();
    value|=(next&127)<<(7*i);
    if(!(next&128)){if(i>0&&next===0)throw new WireError();return value}
   }
   throw new WireError();
  },
 };
 return r;
}

// ---- message codec ----
/**
 * Compiled message (legacy or v0) from its bytes, strictly: every read in bounds, header consistent with the account
 * list, every index in range, nothing left over. Returns
 * {version: 'legacy'|0, header:{signers, readonlySigned, readonlyUnsigned}, accounts:[base58], blockhash, instructions:
 *  [{programIndex, accounts:[index], data:Uint8Array}], lookups:[{table, writable:[index], readonly:[index]}]}.
 */
export function decodeMessage(bytes){
 const r=reader(bytes);
 let first=r.byte(),version='legacy';
 if(first&0x80){if(first!==0x80)throw new WireError('unsupported version');version=0;first=r.byte()}
 const header={signers:first,readonlySigned:r.byte(),readonlyUnsigned:r.byte()};
 const n=r.length();
 if(n<header.signers||n>256||header.readonlySigned>=header.signers||header.readonlyUnsigned>n-header.signers)throw new WireError('header');
 const accounts=Array.from({length:n},()=>base58Encode(r.take(32)));
 const blockhash=base58Encode(r.take(32));
 const count=r.length(),instructions=[];
 for(let i=0;i<count;i++){
  const programIndex=r.byte();
  const acc=[...r.take(r.length())],data=r.take(r.length());
  instructions.push({programIndex,accounts:acc,data});
 }
 const lookups=[];
 if(version===0){
  const t=r.length();
  for(let i=0;i<t;i++)lookups.push({table:base58Encode(r.take(32)),writable:[...r.take(r.length())],readonly:[...r.take(r.length())]});
 }
 if(r.offset!==bytes.length)throw new WireError('trailing bytes');
 const loaded=lookups.reduce((a,l)=>a+l.writable.length+l.readonly.length,0);
 for(const ix of instructions){
  if(ix.programIndex>=n)throw new WireError('program index');
  if(ix.accounts.some(a=>a>=n+loaded))throw new WireError('account index');
 }
 return {version,header,accounts,blockhash,instructions,lookups};
}
export function encodeMessage(m){
 const out=[];
 if(m.version===0)out.push(0x80);else if(m.version!=='legacy')throw new WireError('version');
 out.push(m.header.signers,m.header.readonlySigned,m.header.readonlyUnsigned,...encodeLength(m.accounts.length));
 for(const a of m.accounts)out.push(...key(a));
 out.push(...key(m.blockhash),...encodeLength(m.instructions.length));
 for(const ix of m.instructions)out.push(ix.programIndex,...encodeLength(ix.accounts.length),...ix.accounts,...encodeLength(ix.data.length),...ix.data);
 if(m.version===0){
  out.push(...encodeLength(m.lookups.length));
  for(const l of m.lookups)out.push(...key(l.table),...encodeLength(l.writable.length),...l.writable,...encodeLength(l.readonly.length),...l.readonly);
 }
 return Uint8Array.from(out);
}
/** Wire transaction: {signatures:[Uint8Array(64)], messageBytes, message}. Strict like decodeMessage; the number of
 * signature slots must equal the header's signer count and the message must re-encode to its own bytes. */
export function decodeTransaction(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length>MAX_TRANSACTION_BYTES)throw new WireError('size');
 const r=reader(bytes);
 const count=r.length();
 if(count<1||count>16)throw new WireError('signature count');
 const signatures=Array.from({length:count},()=>r.take(64));
 const messageBytes=bytes.slice(r.offset);
 const message=decodeMessage(messageBytes);
 if(message.header.signers!==count)throw new WireError('signer count');
 const again=encodeMessage(message);
 if(again.length!==messageBytes.length||again.some((b,i)=>b!==messageBytes[i]))throw new WireError('re-encode');
 return {signatures,messageBytes,message};
}
export function encodeTransaction(signatures,messageBytes){
 if(signatures.some(s=>s.length!==64))throw new WireError('signature length');
 const bytes=Uint8Array.from([...encodeLength(signatures.length),...signatures.flatMap(s=>[...s]),...messageBytes]);
 if(bytes.length>MAX_TRANSACTION_BYTES)throw new WireError('TX_TOO_LARGE');
 return bytes;
}
/** Account roles from the header (Solana's rule). */
export function accountRole(message,index){
 const {signers,readonlySigned,readonlyUnsigned}=message.header,n=message.accounts.length;
 const signer=index<signers;
 const writable=signer?index<signers-readonlySigned:index<n-readonlyUnsigned;
 return {signer,writable};
}
/** Instructions with program and account addresses resolved (static accounts only; a lookup index resolves to null). */
export function resolvedInstructions(message){
 return message.instructions.map(ix=>({program:message.accounts[ix.programIndex]??null,accounts:ix.accounts.map(i=>message.accounts[i]??null),indices:ix.accounts,data:ix.data}));
}

// ---- instruction builders (Folio assembly/ops/external.ts, compute-budget and token-2022 program layouts) ----
const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32LE(v);return [...b]};
const u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return [...b]};
export const setComputeUnitLimit=units=>({programAddress:COMPUTE_BUDGET_PROGRAM,accounts:[],data:Uint8Array.from([2,...u32(units)])});
export const setComputeUnitPrice=microLamports=>({programAddress:COMPUTE_BUDGET_PROGRAM,accounts:[],data:Uint8Array.from([3,...u64(microLamports)])});
/** Associated Token CreateIdempotent: payer, ata, owner, mint, system program, token program. */
export const createAssociatedTokenIdempotent=({payer,ata,owner,mint,tokenProgram})=>({programAddress:ATA_PROGRAM,data:Uint8Array.of(1),accounts:[
 {address:payer,signer:true,writable:true},{address:ata,writable:true},{address:owner},{address:mint},{address:SYSTEM_PROGRAM},{address:tokenProgram}]});
/** SPL Token / Token-2022 TransferChecked (tag 12): source, mint, destination, authority (signer). */
export const transferChecked=({source,mint,destination,authority,amount,decimals,tokenProgram})=>({programAddress:tokenProgram,data:Uint8Array.from([12,...u64(amount),decimals]),accounts:[
 {address:source,writable:true},{address:mint},{address:destination,writable:true},{address:authority,signer:true}]});

/**
 * The one v0 transaction a leg compiles to (Folio message.ts rules): account 0 = fee payer, account 1 = owner, no other
 * signer, SetComputeUnitLimit and SetComputeUnitPrice first, no lookup tables, at most 1232 bytes, both signature slots
 * zero. `instructions` exclude compute budget. Returns {bytes, messageBytes, message}.
 */
export function buildMessage({feePayer,owner,blockhash,computeUnitLimit,priorityMicroLamports,instructions}){
 if(feePayer===owner)throw new WireError('FEE_PAYER_REFERENCED');
 if(!instructions?.length)throw new WireError('NOTHING_TO_ASSEMBLE');
 if(instructions.some(ix=>ix.programAddress===COMPUTE_BUDGET_PROGRAM))throw new WireError('COMPUTE_BUDGET_FROM_OP');
 const all=[setComputeUnitLimit(computeUnitLimit),setComputeUnitPrice(priorityMicroLamports),...instructions];
 // Metas in first-appearance order, flags OR-ed; the fee payer is always first.
 const metas=new Map([[feePayer,{signer:true,writable:true}]]);
 const add=(address,{signer=false,writable=false})=>{key(address);const m=metas.get(address)??{signer:false,writable:false};metas.set(address,{signer:m.signer||signer,writable:m.writable||writable})};
 for(const ix of all){for(const a of ix.accounts)add(a.address,a);add(ix.programAddress,{})}
 for(const [a,m] of metas)if(m.signer&&a!==feePayer&&a!==owner)throw new WireError('EXTRA_SIGNER');
 if(!metas.get(owner)?.signer)throw new WireError('OWNER_NOT_SIGNER');
 const entries=[...metas];
 const group=(s,w)=>entries.filter(([a,m])=>a!==feePayer&&m.signer===s&&m.writable===w).map(([a])=>a);
 const accounts=[feePayer,...group(true,true),...group(true,false),...group(false,true),...group(false,false)];
 const message={version:0,header:{signers:2,readonlySigned:group(true,false).length,readonlyUnsigned:group(false,false).length},accounts,blockhash,
  instructions:all.map(ix=>({programIndex:accounts.indexOf(ix.programAddress),accounts:ix.accounts.map(a=>accounts.indexOf(a.address)),data:Uint8Array.from(ix.data)})),lookups:[]};
 if(accounts[1]!==owner)throw new WireError('LAYOUT_MISMATCH');
 const messageBytes=encodeMessage(message);
 const bytes=encodeTransaction([new Uint8Array(64),new Uint8Array(64)],messageBytes);
 return {bytes,messageBytes,message};
}

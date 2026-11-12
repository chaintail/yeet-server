// SKEET leg on Solana, built by hand (no web3 dependency): create the deposit address's associated token account if
// it is missing (CreateIdempotent) and TransferChecked the exact amount to it. Legacy message, one signer (the
// person's wallet as fee payer; Privy's sponsored send replaces the fee payer and blockhash, Folio transport.ts).
import {createHash} from 'node:crypto';
import {base58Decode,base58Encode} from './router.mjs';

export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM='11111111111111111111111111111111';
export const SOLANA_MAINNET_CAIP2='solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

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
const key=address=>{const b=base58Decode(address);if(!b||b.length!==32)throw Error('invalid Solana address');return b};
/** find_program_address: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds,programId){
 for(let bump=255;bump>=0;bump--){
  const h=createHash('sha256');for(const s of seeds)h.update(s);h.update(Uint8Array.of(bump));h.update(key(programId));h.update('ProgramDerivedAddress');
  const out=h.digest();
  if(!isOnCurve(out))return [base58Encode(out),bump];
 }
 throw Error('no program address');
}
export const associatedTokenAddress=(owner,mint,tokenProgram=TOKEN_PROGRAM)=>findProgramAddress([key(owner),key(tokenProgram),key(mint)],ATA_PROGRAM)[0];

function compactU16(n){const out=[];do{let b=n&0x7f;n>>=7;if(n)b|=0x80;out.push(b)}while(n);return out}
function u64le(v){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b}

/**
 * Unsigned legacy transaction (base64): [CreateIdempotent(destination ATA), TransferChecked(amount, decimals)].
 * `source` is the person's token account for `mint` (from getTokenAccountsByOwner).
 */
export function splTransferTransaction({owner,source,destinationOwner,mint,decimals,amountRaw,tokenProgram=TOKEN_PROGRAM,recentBlockhash}){
 const destination=associatedTokenAddress(destinationOwner,mint,tokenProgram);
 // Account order: signer+writable, writable, read-only (header [1 signer, 0 read-only signed, 5 read-only unsigned]).
 const keys=[owner,source,destination,destinationOwner,mint,SYSTEM_PROGRAM,tokenProgram,ATA_PROGRAM];
 if(new Set(keys).size!==keys.length)throw Error('account collision');
 const at=k=>keys.indexOf(k);
 const ix=(program,accounts,data)=>[at(program),...compactU16(accounts.length),...accounts.map(at),...compactU16(data.length),...data];
 const create=ix(ATA_PROGRAM,[owner,destination,destinationOwner,mint,SYSTEM_PROGRAM,tokenProgram],[1]);
 const transfer=ix(tokenProgram,[source,mint,destination,owner],[12,...u64le(amountRaw),decimals]);
 const message=Buffer.from([1,0,5,...compactU16(keys.length),...keys.flatMap(k=>[...key(k)]),...key(recentBlockhash),...compactU16(2),...create,...transfer]);
 const tx=Buffer.concat([Buffer.from(compactU16(1)),Buffer.alloc(64),message]);
 return {transaction:tx.toString('base64'),destination};
}

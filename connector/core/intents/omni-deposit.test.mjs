// The deposit without 1Click: our Omni bridge `init_transfer` instruction against a real mainnet deposit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {localSigner} from '../pipeline/solana/verify.mjs';
import {decodeTransaction,resolvedInstructions,associatedTokenAddress,USDC_SOLANA} from '../pipeline/solana/message.mjs';
import {hex} from './codec.mjs';
import {buildSelfPaidTransaction} from './funding.mjs';
import {omniSolanaAccounts,initTransferData,omniDepositInstruction,omniDepositFee,anchorDiscriminator,OMNI_SOLANA_PROGRAM} from './omni-deposit.mjs';
import {probeOmniDeposit} from './balance-plan.mjs';
import {parseArgs} from '../../../ops/intents-direct-spike.mjs';

const FIX=JSON.parse(readFileSync(new URL('./fixtures/mainnet-omni-init-transfer.json',import.meta.url),'utf8'));
const BLOCKHASH='244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM';

test('Omni deposit: every derived account and the instruction data of a real mainnet USDC deposit into intents.near, byte for byte',()=>{
 const [authority,mint,from,vault,solVault,user,config,bridge,feeCollector,sequence,message,payer,clock,rent,wormhole,system,shim,shimEa,tokenProgram]=FIX.accounts;
 assert.equal(FIX.program,OMNI_SOLANA_PROGRAM);assert.equal(mint,USDC_SOLANA);
 assert.deepEqual(omniSolanaAccounts(mint),{authority,vault,solVault,config,wormholeBridge:bridge,wormholeFeeCollector:feeCollector,wormholeSequence:sequence,wormholeMessage:message,shimEventAuthority:shimEa});
 assert.equal(hex(anchorDiscriminator('init_transfer')),'ae3286637af3f3e0');
 const p=FIX.payload;
 assert.equal(p.recipient,'near:intents.near');assert.match(p.message,/^[0-9a-f]{64}$/,'the owner account inside the verifier');
 assert.equal(hex(initTransferData({amount:p.amount,recipient:p.recipient,fee:p.fee,nativeFee:p.native_fee,message:p.message})),FIX.data_hex);
 // the same deposit rebuilt: a separate fee payer, as in the real transaction
 const ix=omniDepositInstruction({user,payer,mint,amount:p.amount,ownerAccount:p.message,nativeFee:p.native_fee,from});
 assert.deepEqual(ix.accounts.map(a=>a.address),FIX.accounts);
 assert.equal(hex(ix.data),FIX.data_hex);
 assert.deepEqual(ix.accounts.filter(a=>a.signer).map(a=>a.address),[user,payer]);
 assert.deepEqual(ix.accounts.filter(a=>a.writable).map(a=>a.address),[mint,from,vault,solVault,user,bridge,feeCollector,sequence,message,payer]);
 assert.deepEqual([clock,rent,wormhole,system,shim,tokenProgram],['SysvarC1ock11111111111111111111111111111111','SysvarRent111111111111111111111111111111111','worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth','11111111111111111111111111111111','EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
});

test('Omni deposit: by default the user pays and the tokens leave their associated account; bad input is refused',()=>{
 const w=localSigner(Uint8Array.from({length:32},(_,i)=>i+1));
 const owner='ab'.repeat(32);
 const ix=omniDepositInstruction({user:w.address,mint:USDC_SOLANA,amount:4_500_000n,ownerAccount:owner,nativeFee:124_501n});
 assert.equal(ix.accounts[2].address,associatedTokenAddress(w.address,USDC_SOLANA));
 assert.equal(ix.accounts[5].address,w.address);assert.equal(ix.accounts[11].address,w.address);
 // it fits one transaction with a single signer
 const bytes=buildSelfPaidTransaction({payer:w.address,blockhash:BLOCKHASH,instructions:[ix]});
 assert.ok(bytes.length<1232);
 const tx=decodeTransaction(bytes);
 assert.equal(tx.message.header.signers,1);
 const mine=resolvedInstructions(tx.message).find(i=>i.program===OMNI_SOLANA_PROGRAM);
 assert.equal(hex(mine.data),hex(ix.data));
 assert.ok(Buffer.from(ix.data).includes(Buffer.from(`near:intents.near`)));assert.ok(Buffer.from(ix.data).includes(Buffer.from(owner)));
 assert.throws(()=>omniDepositInstruction({user:w.address,mint:USDC_SOLANA,amount:1n,ownerAccount:'Not An Account',nativeFee:1n}),/verifier account/);
 assert.throws(()=>initTransferData({amount:5n,recipient:'near:intents.near',fee:5n,nativeFee:1n,message:owner}),/exceed the fee/);
});

test('Omni deposit fee and the plan probe: chain checks, the built transaction, and a simulation only when an address is given',async()=>{
 const asked=[];
 const fetch=async url=>{asked.push(String(url));return {ok:true,json:async()=>({native_token_fee:'124501',transferred_token_fee:null,usd_fee:0.01})}};
 const w=localSigner(Uint8Array.from({length:32},(_,i)=>i+1));
 const f=await omniDepositFee({user:w.address,mint:USDC_SOLANA,amount:4_500_000n,fetch});
 assert.deepEqual(f,{nativeFee:124_501n,usd:0.01});
 assert.match(asked[0],/sender=sol%3A.*recipient=near%3Aintents\.near.*token=sol%3AEPjF.*amount=4500000/);
 const rpc={view:async(c,m,a)=>{if(a.address.startsWith('sol:'))return 'sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';throw Error('ERR_TOKEN_NOT_REGISTERED')}};
 const sims=[];
 const sol={accountInfo:async()=>({owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',lamports:1}),latestBlockhash:async()=>({blockhash:BLOCKHASH,lastValidBlockHeight:'1'}),
  simulate:async b=>{sims.push(b);return {err:null,unitsConsumed:57426,logs:['Program worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth success',`Program ${OMNI_SOLANA_PROGRAM} success`]}}};
 const lines=[];
 const a=await probeOmniDeposit({rpc,sol,amount:4_500_000n,emit:l=>lines.push(l),fetch});
 assert.equal(a.ok,true);assert.equal(sims.length,0,'no address given: nothing is simulated');
 assert.equal(lines.find(l=>l.info)?.route_from_base,false);
 assert.equal(lines.find(l=>l.built).recipient,'near:intents.near');
 const b=await probeOmniDeposit({rpc,sol,amount:4_500_000n,from:w.address,ownerAccount:'ab'.repeat(32),emit:()=>{},fetch});
 assert.equal(b.ok,true);assert.equal(sims.length,1);assert.equal(b.checks.at(-1).got,'SIMULATED');
 const c=await probeOmniDeposit({rpc,sol:{...sol,simulate:async()=>({err:{InstructionError:[2,{Custom:17}]},unitsConsumed:1,logs:['Program log: Error: Account is frozen']})},amount:4_500_000n,from:w.address,emit:()=>{},fetch});
 assert.equal(c.ok,false);
});

test('CLI: --deposit-user --via omni is a plan-only step',()=>{
 const p=parseArgs(['--deposit-user','--via','omni','--omni-from','2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S']);
 assert.deepEqual([p.mode,p.step,p.via,p.omniDepositPlan],['plan','deposit-user','omni',true]);
 assert.throws(()=>parseArgs(['--deposit-user']),/--live step/);
 assert.throws(()=>parseArgs(['--deposit-user','--via','wormhole']),/1click or omni/);
 assert.throws(()=>parseArgs(['--omni-from','0xabc']),/Solana address/);
 assert.equal(parseArgs(['--live','--deposit-user','--near-key','k','--wallet','w']).via,'1click');
});

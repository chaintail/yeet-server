// A deposit into intents.near with NO 1Click and no deposit-address API: the user's own Solana transaction calls the
// Omni bridge program's `init_transfer` with recipient `near:intents.near` and the owner account as the message.
// The bridge locks the tokens in its vault and posts a Wormhole message; a relayer (anyone may: the proof is public)
// calls `fin_transfer` on omni.bridge.near, which sends the NEP-141 token to intents.near with `msg` = the owner
// account, and the verifier credits that account (deposits doc: an account id string as `msg` assigns ownership).
// Sources, read 2026-11-13:
//   program  Near-One/omni-bridge af6d95b solana/programs/bridge_token_factory/src/{lib.rs,instructions/user/
//            init_transfer.rs,instructions/wormhole_cpi.rs,state/message/init_transfer.rs,constants.rs}
//   ids      the same repo's README "Mainnet Addresses" (Solana program dahPEo…); Wormhole core and its post-message
//            shim as they appear in real transactions
//   NEAR     near/omni-bridge/src/lib.rs `fin_transfer` -> `process_fin_transfer_to_near` -> `send_tokens`
//            (`ft_transfer_call`/`mint` with the message); view `get_token_id("sol:<USDC mint>")` answers
//            `sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near`: the SAME token the verifier already holds
//   chain    Solana tx 3fdso6JNkxjunpdsoeurz4tqmKxw413uEthm86ZbsZ6ZfvwxBc1qBsXavNRrEQUdA9k4CMtyBeU8vgZJMtYSbmN
//            (fixtures/mainnet-omni-init-transfer.json): USDC, recipient near:intents.near, message = a 64-hex
//            account, fee 0, native fee 124,533 lamports; credited on NEAR 68 s later (bridge API record)
//   docs     https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits.md
// USDC on Base is NOT registered on the Omni bridge (`get_token_id("base:0x8335…")` -> ERR_TOKEN_NOT_REGISTERED), so
// this route exists for Solana tokens only today.
import {createHash} from 'node:crypto';
import {findProgramAddress,associatedTokenAddress,key,SYSTEM_PROGRAM,TOKEN_PROGRAM} from '../pipeline/solana/message.mjs';
import {VERIFIER,OMNI_API} from './constants.mjs';
import {concat,u32,u64,u128,utf8} from './codec.mjs';

export const OMNI_SOLANA_PROGRAM='dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe';
export const WORMHOLE_CORE='worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth';
export const WORMHOLE_POST_MESSAGE_SHIM='EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX';
const CLOCK='SysvarC1ock11111111111111111111111111111111',RENT='SysvarRent111111111111111111111111111111111';
const pda=(seeds,program)=>findProgramAddress(seeds.map(s=>typeof s==='string'?utf8(s):s),program)[0];
const borshString=s=>{const b=utf8(s);return concat(u32(b.length),b)};

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export const anchorDiscriminator=name=>Uint8Array.from(createHash('sha256').update(`global:${name}`).digest().subarray(0,8));

/** The program's fixed accounts (all derived, none looked up). */
export function omniSolanaAccounts(mint){
 const config=pda(['config'],OMNI_SOLANA_PROGRAM);
 return {authority:pda(['authority'],OMNI_SOLANA_PROGRAM),vault:pda(['vault',key(mint)],OMNI_SOLANA_PROGRAM),solVault:pda(['sol_vault'],OMNI_SOLANA_PROGRAM),config,
  wormholeBridge:pda(['Bridge'],WORMHOLE_CORE),wormholeFeeCollector:pda(['fee_collector'],WORMHOLE_CORE),wormholeSequence:pda(['Sequence',key(config)],WORMHOLE_CORE),
  wormholeMessage:pda([key(config)],WORMHOLE_POST_MESSAGE_SHIM),shimEventAuthority:pda(['__event_authority'],WORMHOLE_POST_MESSAGE_SHIM)};
}
/** `InitTransferPayload` in borsh after the discriminator: amount u128, recipient string, fee u128, native_fee u64, message string. */
export function initTransferData({amount,recipient,fee=0n,nativeFee,message}){
 if(BigInt(amount)<=BigInt(fee))throw Error('amount must exceed the fee');
 return concat(anchorDiscriminator('init_transfer'),u128(amount),borshString(recipient),u128(fee),u64(nativeFee),borshString(message));
}
/**
 * The `init_transfer` instruction that deposits `amount` of a Solana-native SPL token (one the bridge keeps a vault
 * for, e.g. USDC, WIF) from `user` into `ownerAccount` inside intents.near. `payer` pays the Wormhole fee and may be
 * someone else (a fee payer); `nativeFee` (lamports, from the bridge's fee API) is taken from `user` and pays the
 * relayer that finalises on NEAR. Returns {programAddress, accounts:[{address, signer, writable}], data}.
 */
export function omniDepositInstruction({user,payer=user,mint,amount,ownerAccount,nativeFee,tokenProgram=TOKEN_PROGRAM,from=associatedTokenAddress(user,mint,tokenProgram)}){
 if(!/^(?:[0-9a-f]{64}|0x[0-9a-f]{40}|[a-z0-9._-]{2,64})$/.test(ownerAccount))throw Error('owner is not a verifier account id');
 if(BigInt(nativeFee)<0n)throw Error('native fee must not be negative');
 const a=omniSolanaAccounts(mint);
 const ro=address=>({address,signer:false,writable:false}),rw=address=>({address,signer:false,writable:true}),sig=address=>({address,signer:true,writable:true});
 return {programAddress:OMNI_SOLANA_PROGRAM,
  accounts:[ro(a.authority),rw(mint),rw(from),rw(a.vault),rw(a.solVault),sig(user),
   // WormholeCPI, in the order of the struct
   ro(a.config),rw(a.wormholeBridge),rw(a.wormholeFeeCollector),rw(a.wormholeSequence),rw(a.wormholeMessage),sig(payer),ro(CLOCK),ro(RENT),ro(WORMHOLE_CORE),ro(SYSTEM_PROGRAM),ro(WORMHOLE_POST_MESSAGE_SHIM),ro(a.shimEventAuthority),
   ro(tokenProgram)],
  data:initTransferData({amount,recipient:`near:${VERIFIER}`,nativeFee,message:ownerAccount})};
}
/** Relayer fee (lamports) the bridge asks for a Solana -> intents.near deposit: {nativeFee (bigint), usd}. */
export async function omniDepositFee({user,mint,amount,fetch=globalThis.fetch,api=OMNI_API}){
 const res=await fetch(`${api}/api/v3/transfer-fee?${new URLSearchParams({sender:`sol:${user}`,recipient:`near:${VERIFIER}`,token:`sol:${mint}`,amount:BigInt(amount).toString()})}`,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15_000)});
 if(!res.ok)throw Error(`Omni API transfer-fee HTTP ${res.status}`);
 const r=await res.json();
 if(!/^\d+$/.test(String(r?.native_token_fee??'')))throw Error('Omni API returned no native fee');
 return {nativeFee:BigInt(r.native_token_fee),usd:typeof r.usd_fee==='number'?r.usd_fee:null};
}

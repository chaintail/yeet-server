// From an intent payload to the Privy wallet call that signs it, and from Privy's answer to the verifier's wire
// object. Pure mapping, in the manner of pipeline/wallet-request.mjs; NOT yet exercised against Privy (the spike signs
// with local keys). Privy references:
//   EVM   POST /v1/wallets/{wallet_id}/rpc {method:"personal_sign", params:{message, encoding:"utf-8"}}
//         -> data.signature "0x" + r(32) s(32) v(1), v = 1b/1c        https://docs.privy.io/api-reference/wallets/ethereum/personal-sign
//   Solana POST /v1/wallets/{wallet_id}/rpc {method:"signMessage", params:{message:<base64>, encoding:"base64"}}
//         -> data.signature base64 of 64 bytes                        https://docs.privy.io/api-reference/wallets/solana/sign-message
// `personal_sign` applies the ERC-191 prefix the verifier rebuilds, so the message is the payload string itself.
// Privy's page does not say that Solana `signMessage` signs the bytes with no prefix; multiPayloadFromPrivy checks the
// signature over the raw bytes locally and throws if it does not verify, so a prefixed signature never reaches the chain.
import {rawEd25519Payload,erc191Payload} from './sign.mjs';

/** The Privy wallet RPC body that signs `payload` (the string from intents.mjs payloadString). */
export function privySignBody(standard,payload){
 if(typeof payload!=='string'||!payload.length)throw TypeError('payload is the intent string');
 if(standard==='erc191')return {method:'personal_sign',chain_type:'ethereum',params:{message:payload,encoding:'utf-8'}};
 if(standard==='raw_ed25519')return {method:'signMessage',chain_type:'solana',params:{message:Buffer.from(payload,'utf8').toString('base64'),encoding:'base64'}};
 throw TypeError(`no wallet call for standard ${standard}`);
}
/** The verifier's wire object from Privy's answer `data` ({signature}). `address` = the wallet's own address (EVM
 * address for erc191, Solana address for raw_ed25519). Throws unless the signature verifies for that wallet. */
export async function multiPayloadFromPrivy(standard,payload,address,data){
 const s=data?.signature;
 if(typeof s!=='string')throw TypeError('the wallet returned no signature');
 if(standard==='erc191')return erc191Payload(payload,address,s);
 if(standard==='raw_ed25519'){
  const sig=Buffer.from(s,'base64');
  if(sig.toString('base64')!==s)throw TypeError('signature is not base64');
  return rawEd25519Payload(payload,address,sig);
 }
 throw TypeError(`no wallet call for standard ${standard}`);
}

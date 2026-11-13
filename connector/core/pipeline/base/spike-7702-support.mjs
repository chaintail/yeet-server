// viem re-exports for ops/base-7702-spike.mjs (ops/ resolves no bare packages, as with plan-support.mjs).
export {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
export {createPublicClient,http,recoverTypedDataAddress,toHex,encodeFunctionData,decodeFunctionResult,parseAbi,
 formatEther,serializeTransaction} from 'viem';

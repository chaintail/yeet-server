/** Decode a base58 string (Bitcoin alphabet). Returns null on any invalid character. */
export declare function base58Decode(input: string): Uint8Array | null;
export declare function base58Encode(bytes: Uint8Array): string;
/** EVM address: 0x followed by exactly 40 hex characters. Case is preserved so 1Click can enforce EIP-55. */
export declare function isEvmAddress(addr: string): boolean;
/** Solana address: base58 that decodes to exactly 32 bytes. */
export declare function isSolanaAddress(addr: string): boolean;
/** Obvious non-wallet EVM addresses (zero address, burn addresses). */
export declare function isBurnEvmAddress(addr: string): boolean;
export declare function randomEvmAddress(): string;
export declare function randomSolanaAddress(): string;

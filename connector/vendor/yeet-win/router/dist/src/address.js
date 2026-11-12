import { randomBytes } from "node:crypto";
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]));
/** Decode a base58 string (Bitcoin alphabet). Returns null on any invalid character. */
export function base58Decode(input) {
    if (input.length === 0)
        return null;
    let value = 0n;
    for (const ch of input) {
        const digit = B58_INDEX.get(ch);
        if (digit === undefined)
            return null;
        value = value * 58n + BigInt(digit);
    }
    const bytes = [];
    while (value > 0n) {
        bytes.push(Number(value & 0xffn));
        value >>= 8n;
    }
    for (const ch of input) {
        if (ch !== "1")
            break;
        bytes.push(0);
    }
    return Uint8Array.from(bytes.reverse());
}
export function base58Encode(bytes) {
    let value = 0n;
    for (const b of bytes)
        value = (value << 8n) | BigInt(b);
    let out = "";
    while (value > 0n) {
        out = B58_ALPHABET[Number(value % 58n)] + out;
        value /= 58n;
    }
    for (const b of bytes) {
        if (b !== 0)
            break;
        out = "1" + out;
    }
    return out;
}
/** EVM address: 0x followed by exactly 40 hex characters. Case is preserved so 1Click can enforce EIP-55. */
export function isEvmAddress(addr) {
    return /^0x[0-9a-fA-F]{40}$/.test(addr);
}
/** Solana address: base58 that decodes to exactly 32 bytes. */
export function isSolanaAddress(addr) {
    if (addr.length < 32 || addr.length > 44)
        return false;
    const bytes = base58Decode(addr);
    return bytes !== null && bytes.length === 32;
}
/** Obvious non-wallet EVM addresses (zero address, burn addresses). */
export function isBurnEvmAddress(addr) {
    const lower = addr.toLowerCase();
    return /^0x0{40}$/.test(lower) || /^0x0{36}dead$/.test(lower);
}
export function randomEvmAddress() {
    return "0x" + randomBytes(20).toString("hex");
}
export function randomSolanaAddress() {
    return base58Encode(randomBytes(32));
}

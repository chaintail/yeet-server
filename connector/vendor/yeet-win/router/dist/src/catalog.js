import { z } from "zod";
import raw from "./catalog.json" with { type: "json" };
export const ChainSchema = z.enum(["solana", "base"]);
export const TokenKindSchema = z.enum(["funding", "meme", "major"]);
export const CatalogEntrySchema = z.object({
    /** Symbol used by YEET (unique per chain). */
    symbol: z.string().min(1),
    name: z.string().min(1),
    chain: ChainSchema,
    /** 1Click asset id, taken verbatim from GET /v0/tokens. */
    assetId: z.string().min(1),
    decimals: z.number().int().min(0).max(30),
    /** Token contract (Base) or SPL mint (Solana); null for the native chain asset. */
    address: z.string().nullable(),
    kind: TokenKindSchema,
    /** Symbol as listed by 1Click when it differs from `symbol` (e.g. "$WIF"). */
    listedSymbol: z.string().optional(),
    coingeckoId: z.string().optional(),
});
export const MAX_CATALOG_SIZE = 25;
export const CatalogSchema = z
    .array(CatalogEntrySchema)
    .max(MAX_CATALOG_SIZE)
    .superRefine((entries, ctx) => {
    const seen = new Set();
    for (const e of entries) {
        const key = `${e.chain}:${e.symbol.toUpperCase()}`;
        if (seen.has(key))
            ctx.addIssue({ code: "custom", message: `duplicate catalogue symbol ${key}` });
        seen.add(key);
    }
});
export const CATALOG = Object.freeze(CatalogSchema.parse(raw));
/** USDC on Base: the asset every YEET basket is funded with and every SKEET returns to. */
export const FUNDING = findToken("USDC", "base") ?? fail("catalogue is missing USDC on Base");
function fail(msg) {
    throw new Error(msg);
}
/** Look up a token by symbol (case-insensitive; also accepts the 1Click listed symbol, e.g. "$WIF"). */
export function findToken(symbol, chain, catalog = CATALOG) {
    const s = symbol.trim().toUpperCase();
    return catalog.find((e) => e.chain === chain && (e.symbol.toUpperCase() === s || e.listedSymbol?.toUpperCase() === s));
}
/** Tokens a basket leg may target: Solana memes and majors, never the funding asset. */
export function tradableOnSolana(catalog = CATALOG) {
    return catalog.filter((e) => e.chain === "solana" && e.kind !== "funding");
}
/** Every mint/contract address in the catalogue. A token address is never a valid wallet recipient. */
export function knownTokenAddresses(catalog = CATALOG) {
    const out = new Set();
    for (const e of catalog)
        if (e.address)
            out.add(e.address.toLowerCase());
    return out;
}

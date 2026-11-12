import { z } from "zod";
export declare const ChainSchema: z.ZodEnum<{
    base: "base";
    solana: "solana";
}>;
export type Chain = z.infer<typeof ChainSchema>;
export declare const TokenKindSchema: z.ZodEnum<{
    funding: "funding";
    major: "major";
    meme: "meme";
}>;
export type TokenKind = z.infer<typeof TokenKindSchema>;
export declare const CatalogEntrySchema: z.ZodObject<{
    symbol: z.ZodString;
    name: z.ZodString;
    chain: z.ZodEnum<{
        base: "base";
        solana: "solana";
    }>;
    assetId: z.ZodString;
    decimals: z.ZodNumber;
    address: z.ZodNullable<z.ZodString>;
    kind: z.ZodEnum<{
        funding: "funding";
        major: "major";
        meme: "meme";
    }>;
    listedSymbol: z.ZodOptional<z.ZodString>;
    coingeckoId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export declare const MAX_CATALOG_SIZE = 25;
export declare const CatalogSchema: z.ZodArray<z.ZodObject<{
    symbol: z.ZodString;
    name: z.ZodString;
    chain: z.ZodEnum<{
        base: "base";
        solana: "solana";
    }>;
    assetId: z.ZodString;
    decimals: z.ZodNumber;
    address: z.ZodNullable<z.ZodString>;
    kind: z.ZodEnum<{
        funding: "funding";
        major: "major";
        meme: "meme";
    }>;
    listedSymbol: z.ZodOptional<z.ZodString>;
    coingeckoId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export declare const CATALOG: readonly CatalogEntry[];
/** USDC on Base: the asset every YEET basket is funded with and every SKEET returns to. */
export declare const FUNDING: CatalogEntry;
/** Look up a token by symbol (case-insensitive; also accepts the 1Click listed symbol, e.g. "$WIF"). */
export declare function findToken(symbol: string, chain: Chain, catalog?: readonly CatalogEntry[]): CatalogEntry | undefined;
/** Tokens a basket leg may target: Solana memes and majors, never the funding asset. */
export declare function tradableOnSolana(catalog?: readonly CatalogEntry[]): CatalogEntry[];
/** Every mint/contract address in the catalogue. A token address is never a valid wallet recipient. */
export declare function knownTokenAddresses(catalog?: readonly CatalogEntry[]): Set<string>;

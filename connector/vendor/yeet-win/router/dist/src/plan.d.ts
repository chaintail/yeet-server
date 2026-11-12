import { type CatalogEntry } from "./catalog.js";
import { OneClickError, type OneClickClient } from "./oneclick.js";
export declare const TOTAL_PARTS = 10;
export declare const DEFAULT_SLIPPAGE_BPS = 100;
export declare const MAX_SLIPPAGE_BPS = 1000;
export declare const DEFAULT_DEADLINE_MINUTES = 30;
export type Direction = "yeet" | "skeet";
export interface YeetInput {
    /** USDC (on Base) to spend, human units, e.g. 20 or "20.5". */
    amountUsdc: string | number;
    legs: {
        symbol: string;
        parts: number;
    }[];
    /** Solana wallet that receives the tokens. */
    recipientSol: string;
    /** Base address that receives refunds. */
    refundBase: string;
    slippageBps?: number;
    dry?: boolean;
    deadlineMinutes?: number;
}
export interface SkeetInput {
    /** Solana tokens to sell, amounts in human token units. */
    legs: {
        symbol: string;
        amount: string | number;
    }[];
    /** Base address that receives the USDC. */
    recipientBase: string;
    /** Solana address that receives refunds. */
    refundSol: string;
    slippageBps?: number;
    dry?: boolean;
    deadlineMinutes?: number;
}
export interface PlanDeps {
    client: OneClickClient;
    catalog?: readonly CatalogEntry[];
    now?: () => Date;
}
export interface PlanLeg {
    index: number;
    symbol: string;
    parts?: number;
    origin: {
        symbol: string;
        chain: string;
        assetId: string;
        decimals: number;
    };
    destination: {
        symbol: string;
        chain: string;
        assetId: string;
        decimals: number;
    };
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    minAmountOutFormatted: string;
    /** Seconds after deposit confirmation. */
    timeEstimate: number;
    /** Present only on live (non-dry) plans. */
    depositAddress?: string;
    depositMemo?: string;
    /** Quote deadline from 1Click when live; otherwise the deadline we requested. */
    deadline: string;
    timeWhenInactive?: string;
    correlationId: string;
    signature: string;
    quoteTimestamp: string;
}
export interface Plan {
    id: string;
    direction: Direction;
    dry: boolean;
    createdAt: string;
    recipient: string;
    refundTo: string;
    slippageBps: number;
    authenticated: boolean;
    legs: PlanLeg[];
    totals: {
        amountInUsd: string;
        amountOutUsd: string;
        /** Sum of amountIn when every leg spends the same asset (YEET). */
        amountIn?: string;
        amountInFormatted?: string;
        /** Sum of amountOut when every leg returns the same asset (SKEET). */
        amountOut?: string;
        amountOutFormatted?: string;
        minAmountOut?: string;
        minAmountOutFormatted?: string;
        /** Slowest leg, seconds. Legs run in parallel. */
        timeEstimate: number;
    };
}
export type YeetPlan = Plan & {
    direction: "yeet";
};
export type SkeetPlan = Plan & {
    direction: "skeet";
};
export declare class PlanValidationError extends Error {
    readonly field: string;
    readonly name = "PlanValidationError";
    constructor(field: string, message: string);
}
export declare class PlanQuoteError extends Error {
    readonly failures: {
        symbol: string;
        error: OneClickError | Error;
    }[];
    readonly name = "PlanQuoteError";
    constructor(failures: {
        symbol: string;
        error: OneClickError | Error;
    }[]);
}
/**
 * Split `total` smallest units by integer `parts`. Each share is floor(total*p/sum);
 * the remainder goes to the leg with the most parts (first one on a tie). Shares sum to `total` exactly.
 */
export declare function splitByParts(total: bigint, parts: readonly number[]): bigint[];
/** Plan id = sha256 of the canonical request (no timestamps), so the same request always gets the same id. */
export declare function planId(direction: Direction, canonicalRequest: unknown): string;
/** USDC on Base -> weighted basket of Solana tokens delivered to `recipientSol`. Validates everything before any API call. */
export declare function buildYeetPlan(input: YeetInput, deps: PlanDeps): Promise<YeetPlan>;
/** One or more Solana tokens -> USDC on Base delivered to `recipientBase`. */
export declare function buildSkeetPlan(input: SkeetInput, deps: PlanDeps): Promise<SkeetPlan>;

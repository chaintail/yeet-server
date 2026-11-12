import { z } from "zod";
import { type OneClickClient, type StatusResponse, type SwapStatus } from "./oneclick.js";
import type { Plan } from "./plan.js";
/** Final per 1Click: funds delivered, refunded, or failed. */
export declare const TERMINAL: ReadonlySet<SwapStatus>;
/**
 * States at which tracking stops. INCOMPLETE_DEPOSIT is included: it needs a human (top up, or wait for the
 * refund at the deadline), so the receipt records it with `final: false`.
 */
export declare const STOP: ReadonlySet<SwapStatus>;
export declare const isTerminal: (s: SwapStatus) => boolean;
export declare const isStop: (s: SwapStatus) => boolean;
/** Returns an anomaly description when a status change goes backwards or leaves a terminal state. */
export declare function transitionAnomaly(prev: SwapStatus | undefined, next: SwapStatus): string | undefined;
export interface Backoff {
    initialMs: number;
    maxMs: number;
    factor: number;
}
export declare const DEFAULT_BACKOFF: Backoff;
export declare function backoffDelay(attempt: number, b?: Backoff): number;
export declare const ReceiptLegSchema: z.ZodObject<{
    index: z.ZodNumber;
    symbol: z.ZodString;
    depositAddress: z.ZodString;
    depositMemo: z.ZodOptional<z.ZodString>;
    status: z.ZodNullable<z.ZodEnum<{
        FAILED: "FAILED";
        INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
        KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
        PENDING_DEPOSIT: "PENDING_DEPOSIT";
        PROCESSING: "PROCESSING";
        REFUNDED: "REFUNDED";
        SUCCESS: "SUCCESS";
    }>>;
    final: z.ZodBoolean;
    updatedAt: z.ZodNullable<z.ZodString>;
    quote: z.ZodObject<{
        amountIn: z.ZodString;
        amountOut: z.ZodString;
        minAmountOut: z.ZodString;
        correlationId: z.ZodString;
        signature: z.ZodString;
    }, z.core.$strip>;
    settled: z.ZodObject<{
        amountIn: z.ZodOptional<z.ZodString>;
        amountInFormatted: z.ZodOptional<z.ZodString>;
        amountOut: z.ZodOptional<z.ZodString>;
        amountOutFormatted: z.ZodOptional<z.ZodString>;
        amountOutUsd: z.ZodOptional<z.ZodString>;
        refundedAmount: z.ZodOptional<z.ZodString>;
        refundReason: z.ZodOptional<z.ZodString>;
        slippage: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
    originTxHashes: z.ZodArray<z.ZodString>;
    destinationTxHashes: z.ZodArray<z.ZodString>;
    nearTxHashes: z.ZodArray<z.ZodString>;
    correlationIds: z.ZodArray<z.ZodString>;
    history: z.ZodArray<z.ZodObject<{
        status: z.ZodEnum<{
            FAILED: "FAILED";
            INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
            KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
            PENDING_DEPOSIT: "PENDING_DEPOSIT";
            PROCESSING: "PROCESSING";
            REFUNDED: "REFUNDED";
            SUCCESS: "SUCCESS";
        }>;
        observedAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>>;
    anomalies: z.ZodArray<z.ZodString>;
    lastError: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ReceiptLeg = z.infer<typeof ReceiptLegSchema>;
export declare const ReceiptSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    planId: z.ZodString;
    direction: z.ZodEnum<{
        skeet: "skeet";
        yeet: "yeet";
    }>;
    recipient: z.ZodString;
    refundTo: z.ZodString;
    planCreatedAt: z.ZodString;
    trackingStartedAt: z.ZodString;
    writtenAt: z.ZodString;
    complete: z.ZodBoolean;
    timedOut: z.ZodBoolean;
    legs: z.ZodArray<z.ZodObject<{
        index: z.ZodNumber;
        symbol: z.ZodString;
        depositAddress: z.ZodString;
        depositMemo: z.ZodOptional<z.ZodString>;
        status: z.ZodNullable<z.ZodEnum<{
            FAILED: "FAILED";
            INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
            KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
            PENDING_DEPOSIT: "PENDING_DEPOSIT";
            PROCESSING: "PROCESSING";
            REFUNDED: "REFUNDED";
            SUCCESS: "SUCCESS";
        }>>;
        final: z.ZodBoolean;
        updatedAt: z.ZodNullable<z.ZodString>;
        quote: z.ZodObject<{
            amountIn: z.ZodString;
            amountOut: z.ZodString;
            minAmountOut: z.ZodString;
            correlationId: z.ZodString;
            signature: z.ZodString;
        }, z.core.$strip>;
        settled: z.ZodObject<{
            amountIn: z.ZodOptional<z.ZodString>;
            amountInFormatted: z.ZodOptional<z.ZodString>;
            amountOut: z.ZodOptional<z.ZodString>;
            amountOutFormatted: z.ZodOptional<z.ZodString>;
            amountOutUsd: z.ZodOptional<z.ZodString>;
            refundedAmount: z.ZodOptional<z.ZodString>;
            refundReason: z.ZodOptional<z.ZodString>;
            slippage: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>;
        originTxHashes: z.ZodArray<z.ZodString>;
        destinationTxHashes: z.ZodArray<z.ZodString>;
        nearTxHashes: z.ZodArray<z.ZodString>;
        correlationIds: z.ZodArray<z.ZodString>;
        history: z.ZodArray<z.ZodObject<{
            status: z.ZodEnum<{
                FAILED: "FAILED";
                INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
                KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
                PENDING_DEPOSIT: "PENDING_DEPOSIT";
                PROCESSING: "PROCESSING";
                REFUNDED: "REFUNDED";
                SUCCESS: "SUCCESS";
            }>;
            observedAt: z.ZodString;
            updatedAt: z.ZodString;
        }, z.core.$strip>>;
        anomalies: z.ZodArray<z.ZodString>;
        lastError: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export interface TrackOptions {
    client: OneClickClient;
    /** Directory the receipt JSON is written to (created if missing). */
    dir: string;
    backoff?: Partial<Backoff>;
    /** Give up after this long; the receipt is still written with `timedOut: true`. Default 20 min. */
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => Date;
    onUpdate?: (leg: ReceiptLeg) => void;
}
/** Fold one /status response into a receipt leg (pure apart from mutation of `leg`). */
export declare function applyStatus(leg: ReceiptLeg, res: StatusResponse, observedAt: string): ReceiptLeg;
export declare function receiptFileName(plan: Pick<Plan, "id" | "createdAt">): string;
/**
 * Poll /status for every leg of a live plan until each reaches a stop state (or timeout), writing the receipt
 * after every round so a crash never loses observed tx hashes.
 */
export declare function trackPlan(plan: Plan, opts: TrackOptions): Promise<{
    receipt: Receipt;
    path: string;
}>;
export interface ReplayLeg {
    index: number;
    symbol: string;
    depositAddress: string;
    storedStatus: SwapStatus | null;
    currentStatus: SwapStatus | null;
    matches: boolean;
    differences: string[];
}
export interface ReplayResult {
    planId: string;
    matches: boolean;
    legs: ReplayLeg[];
}
/** Re-query /status for every leg in a stored receipt and report whether the stored facts still hold. */
export declare function replay(receiptPath: string, opts: {
    client: OneClickClient;
}): Promise<ReplayResult>;

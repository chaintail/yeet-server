import { z } from "zod";
export declare const DEFAULT_BASE_URL = "https://1click.chaindefuser.com/v0";
export declare const TokenSchema: z.ZodObject<{
    assetId: z.ZodString;
    decimals: z.ZodNumber;
    blockchain: z.ZodString;
    symbol: z.ZodString;
    price: z.ZodOptional<z.ZodNumber>;
    priceUpdatedAt: z.ZodOptional<z.ZodString>;
    contractAddress: z.ZodOptional<z.ZodString>;
    coingeckoId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type Token = z.infer<typeof TokenSchema>;
export declare const TokensSchema: z.ZodArray<z.ZodObject<{
    assetId: z.ZodString;
    decimals: z.ZodNumber;
    blockchain: z.ZodString;
    symbol: z.ZodString;
    price: z.ZodOptional<z.ZodNumber>;
    priceUpdatedAt: z.ZodOptional<z.ZodString>;
    contractAddress: z.ZodOptional<z.ZodString>;
    coingeckoId: z.ZodOptional<z.ZodString>;
}, z.core.$loose>>;
export declare const SwapType: z.ZodEnum<{
    ANY_INPUT: "ANY_INPUT";
    EXACT_INPUT: "EXACT_INPUT";
    EXACT_OUTPUT: "EXACT_OUTPUT";
    FLEX_INPUT: "FLEX_INPUT";
}>;
export declare const QuoteRequestSchema: z.ZodObject<{
    dry: z.ZodBoolean;
    swapType: z.ZodEnum<{
        ANY_INPUT: "ANY_INPUT";
        EXACT_INPUT: "EXACT_INPUT";
        EXACT_OUTPUT: "EXACT_OUTPUT";
        FLEX_INPUT: "FLEX_INPUT";
    }>;
    slippageTolerance: z.ZodNumber;
    originAsset: z.ZodString;
    depositType: z.ZodEnum<{
        CONFIDENTIAL_INTENTS: "CONFIDENTIAL_INTENTS";
        INTENTS: "INTENTS";
        ORIGIN_CHAIN: "ORIGIN_CHAIN";
    }>;
    destinationAsset: z.ZodString;
    amount: z.ZodString;
    refundTo: z.ZodString;
    refundType: z.ZodEnum<{
        CONFIDENTIAL_INTENTS: "CONFIDENTIAL_INTENTS";
        INTENTS: "INTENTS";
        ORIGIN_CHAIN: "ORIGIN_CHAIN";
    }>;
    recipient: z.ZodString;
    recipientType: z.ZodEnum<{
        CONFIDENTIAL_INTENTS: "CONFIDENTIAL_INTENTS";
        DESTINATION_CHAIN: "DESTINATION_CHAIN";
        INTENTS: "INTENTS";
    }>;
    deadline: z.ZodString;
    depositMode: z.ZodOptional<z.ZodEnum<{
        MEMO: "MEMO";
        SIMPLE: "SIMPLE";
    }>>;
    referral: z.ZodOptional<z.ZodString>;
    quoteWaitingTimeMs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export declare const QuoteSchema: z.ZodObject<{
    depositAddress: z.ZodOptional<z.ZodString>;
    depositMemo: z.ZodOptional<z.ZodString>;
    amountIn: z.ZodString;
    amountInFormatted: z.ZodString;
    amountInUsd: z.ZodString;
    minAmountIn: z.ZodString;
    amountOut: z.ZodString;
    amountOutFormatted: z.ZodString;
    amountOutUsd: z.ZodString;
    minAmountOut: z.ZodString;
    deadline: z.ZodOptional<z.ZodString>;
    timeWhenInactive: z.ZodOptional<z.ZodString>;
    timeEstimate: z.ZodNumber;
    refundFee: z.ZodOptional<z.ZodString>;
    withdrawFee: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type Quote = z.infer<typeof QuoteSchema>;
export declare const QuoteResponseSchema: z.ZodObject<{
    correlationId: z.ZodString;
    timestamp: z.ZodString;
    signature: z.ZodString;
    quoteRequest: z.ZodObject<{}, z.core.$loose>;
    quote: z.ZodObject<{
        depositAddress: z.ZodOptional<z.ZodString>;
        depositMemo: z.ZodOptional<z.ZodString>;
        amountIn: z.ZodString;
        amountInFormatted: z.ZodString;
        amountInUsd: z.ZodString;
        minAmountIn: z.ZodString;
        amountOut: z.ZodString;
        amountOutFormatted: z.ZodString;
        amountOutUsd: z.ZodString;
        minAmountOut: z.ZodString;
        deadline: z.ZodOptional<z.ZodString>;
        timeWhenInactive: z.ZodOptional<z.ZodString>;
        timeEstimate: z.ZodNumber;
        refundFee: z.ZodOptional<z.ZodString>;
        withdrawFee: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
}, z.core.$loose>;
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
export declare const STATUSES: readonly ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"];
export declare const StatusSchema: z.ZodEnum<{
    FAILED: "FAILED";
    INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
    KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
    PENDING_DEPOSIT: "PENDING_DEPOSIT";
    PROCESSING: "PROCESSING";
    REFUNDED: "REFUNDED";
    SUCCESS: "SUCCESS";
}>;
export type SwapStatus = z.infer<typeof StatusSchema>;
export declare const SwapDetailsSchema: z.ZodObject<{
    intentHashes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    nearTxHashes: z.ZodDefault<z.ZodArray<z.ZodString>>;
    amountIn: z.ZodOptional<z.ZodString>;
    amountInFormatted: z.ZodOptional<z.ZodString>;
    amountInUsd: z.ZodOptional<z.ZodString>;
    amountOut: z.ZodOptional<z.ZodString>;
    amountOutFormatted: z.ZodOptional<z.ZodString>;
    amountOutUsd: z.ZodOptional<z.ZodString>;
    slippage: z.ZodOptional<z.ZodNumber>;
    originChainTxHashes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        hash: z.ZodString;
        explorerUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    destinationChainTxHashes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        hash: z.ZodString;
        explorerUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    refundedAmount: z.ZodOptional<z.ZodString>;
    refundedAmountFormatted: z.ZodOptional<z.ZodString>;
    refundReason: z.ZodOptional<z.ZodString>;
    depositedAmount: z.ZodOptional<z.ZodString>;
    depositedAmountFormatted: z.ZodOptional<z.ZodString>;
    withdrawFee: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type SwapDetails = z.infer<typeof SwapDetailsSchema>;
export declare const StatusResponseSchema: z.ZodObject<{
    correlationId: z.ZodString;
    quoteResponse: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    status: z.ZodEnum<{
        FAILED: "FAILED";
        INCOMPLETE_DEPOSIT: "INCOMPLETE_DEPOSIT";
        KNOWN_DEPOSIT_TX: "KNOWN_DEPOSIT_TX";
        PENDING_DEPOSIT: "PENDING_DEPOSIT";
        PROCESSING: "PROCESSING";
        REFUNDED: "REFUNDED";
        SUCCESS: "SUCCESS";
    }>;
    updatedAt: z.ZodString;
    swapDetails: z.ZodOptional<z.ZodObject<{
        intentHashes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        nearTxHashes: z.ZodDefault<z.ZodArray<z.ZodString>>;
        amountIn: z.ZodOptional<z.ZodString>;
        amountInFormatted: z.ZodOptional<z.ZodString>;
        amountInUsd: z.ZodOptional<z.ZodString>;
        amountOut: z.ZodOptional<z.ZodString>;
        amountOutFormatted: z.ZodOptional<z.ZodString>;
        amountOutUsd: z.ZodOptional<z.ZodString>;
        slippage: z.ZodOptional<z.ZodNumber>;
        originChainTxHashes: z.ZodDefault<z.ZodArray<z.ZodObject<{
            hash: z.ZodString;
            explorerUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>>;
        destinationChainTxHashes: z.ZodDefault<z.ZodArray<z.ZodObject<{
            hash: z.ZodString;
            explorerUrl: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>>;
        refundedAmount: z.ZodOptional<z.ZodString>;
        refundedAmountFormatted: z.ZodOptional<z.ZodString>;
        refundReason: z.ZodOptional<z.ZodString>;
        depositedAmount: z.ZodOptional<z.ZodString>;
        depositedAmountFormatted: z.ZodOptional<z.ZodString>;
        withdrawFee: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export type StatusResponse = z.infer<typeof StatusResponseSchema>;
export type OneClickErrorKind = "http" | "network" | "timeout" | "invalid-response";
export declare class OneClickError extends Error {
    readonly kind: OneClickErrorKind;
    readonly status: number | undefined;
    readonly correlationId: string | undefined;
    readonly path: string;
    readonly name = "OneClickError";
    constructor(message: string, kind: OneClickErrorKind, status: number | undefined, correlationId: string | undefined, path: string);
    /** 5xx, network and timeout failures are worth one retry; 4xx are not. */
    get retryable(): boolean;
    toJSON(): {
        name: string;
        message: string;
        kind: OneClickErrorKind;
        status: number | undefined;
        correlationId: string | undefined;
        path: string;
    };
}
export interface OneClickOptions {
    baseUrl?: string;
    /** Partner JWT. Defaults to env ONECLICK_JWT; never logged. */
    jwt?: string | undefined;
    timeoutMs?: number;
    /** Delay before the single retry. */
    retryDelayMs?: number;
    fetch?: typeof fetch;
}
export declare class OneClickClient {
    #private;
    readonly baseUrl: string;
    constructor(opts?: OneClickOptions);
    get authenticated(): boolean;
    getTokens(): Promise<Token[]>;
    quote(req: QuoteRequest): Promise<QuoteResponse>;
    submitDeposit(depositAddress: string, txHash: string, memo?: string): Promise<StatusResponse>;
    status(depositAddress: string, depositMemo?: string): Promise<StatusResponse>;
}

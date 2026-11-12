import { z } from "zod";
export const DEFAULT_BASE_URL = "https://1click.chaindefuser.com/v0";
// ---------- schemas (lenient on extra fields, strict on the fields we use) ----------
export const TokenSchema = z.looseObject({
    assetId: z.string(),
    decimals: z.number().int(),
    blockchain: z.string(),
    symbol: z.string(),
    price: z.number().optional(),
    priceUpdatedAt: z.string().optional(),
    contractAddress: z.string().optional(),
    coingeckoId: z.string().optional(),
});
export const TokensSchema = z.array(TokenSchema);
export const SwapType = z.enum(["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"]);
export const QuoteRequestSchema = z.object({
    dry: z.boolean(),
    swapType: SwapType,
    slippageTolerance: z.number().int().min(0).max(10_000),
    originAsset: z.string(),
    depositType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
    destinationAsset: z.string(),
    amount: z.string().regex(/^\d+$/, "amount must be an integer string in smallest units"),
    refundTo: z.string(),
    refundType: z.enum(["ORIGIN_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
    recipient: z.string(),
    recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
    deadline: z.string(),
    depositMode: z.enum(["SIMPLE", "MEMO"]).optional(),
    referral: z.string().optional(),
    quoteWaitingTimeMs: z.number().int().optional(),
});
export const QuoteSchema = z.looseObject({
    depositAddress: z.string().optional(),
    depositMemo: z.string().optional(),
    amountIn: z.string(),
    amountInFormatted: z.string(),
    amountInUsd: z.string(),
    minAmountIn: z.string(),
    amountOut: z.string(),
    amountOutFormatted: z.string(),
    amountOutUsd: z.string(),
    minAmountOut: z.string(),
    deadline: z.string().optional(),
    timeWhenInactive: z.string().optional(),
    timeEstimate: z.number(),
    refundFee: z.string().optional(),
    withdrawFee: z.string().optional(),
});
export const QuoteResponseSchema = z.looseObject({
    correlationId: z.string(),
    timestamp: z.string(),
    signature: z.string(),
    quoteRequest: z.looseObject({}),
    quote: QuoteSchema,
});
export const STATUSES = [
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
];
export const StatusSchema = z.enum(STATUSES);
const TxSchema = z.looseObject({ hash: z.string(), explorerUrl: z.string().optional() });
export const SwapDetailsSchema = z.looseObject({
    intentHashes: z.array(z.string()).default([]),
    nearTxHashes: z.array(z.string()).default([]),
    amountIn: z.string().optional(),
    amountInFormatted: z.string().optional(),
    amountInUsd: z.string().optional(),
    amountOut: z.string().optional(),
    amountOutFormatted: z.string().optional(),
    amountOutUsd: z.string().optional(),
    slippage: z.number().optional(),
    originChainTxHashes: z.array(TxSchema).default([]),
    destinationChainTxHashes: z.array(TxSchema).default([]),
    refundedAmount: z.string().optional(),
    refundedAmountFormatted: z.string().optional(),
    refundReason: z.string().optional(),
    depositedAmount: z.string().optional(),
    depositedAmountFormatted: z.string().optional(),
    withdrawFee: z.string().optional(),
});
export const StatusResponseSchema = z.looseObject({
    correlationId: z.string(),
    quoteResponse: z.looseObject({}).optional(),
    status: StatusSchema,
    updatedAt: z.string(),
    swapDetails: SwapDetailsSchema.optional(),
});
const ErrorBodySchema = z.looseObject({
    message: z.union([z.string(), z.array(z.string())]).optional(),
    correlationId: z.string().optional(),
});
export class OneClickError extends Error {
    kind;
    status;
    correlationId;
    path;
    name = "OneClickError";
    constructor(message, kind, status, correlationId, path) {
        super(message);
        this.kind = kind;
        this.status = status;
        this.correlationId = correlationId;
        this.path = path;
    }
    /** 5xx, network and timeout failures are worth one retry; 4xx are not. */
    get retryable() {
        return this.kind === "network" || this.kind === "timeout" || (this.status !== undefined && this.status >= 500);
    }
    toJSON() {
        return { name: this.name, message: this.message, kind: this.kind, status: this.status, correlationId: this.correlationId, path: this.path };
    }
}
export class OneClickClient {
    baseUrl;
    #jwt;
    #timeoutMs;
    #retryDelayMs;
    #fetch;
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.#jwt = "jwt" in opts ? opts.jwt : process.env.ONECLICK_JWT || undefined;
        this.#timeoutMs = opts.timeoutMs ?? 20_000;
        this.#retryDelayMs = opts.retryDelayMs ?? 750;
        this.#fetch = opts.fetch ?? globalThis.fetch;
    }
    get authenticated() {
        return Boolean(this.#jwt);
    }
    getTokens() {
        return this.#call("GET", "/tokens", undefined, TokensSchema);
    }
    async quote(req) {
        const body = QuoteRequestSchema.parse(req);
        return this.#call("POST", "/quote", body, QuoteResponseSchema);
    }
    submitDeposit(depositAddress, txHash, memo) {
        const body = { txHash, depositAddress };
        if (memo)
            body.memo = memo;
        return this.#call("POST", "/deposit/submit", body, StatusResponseSchema);
    }
    status(depositAddress, depositMemo) {
        const qs = new URLSearchParams({ depositAddress });
        if (depositMemo)
            qs.set("depositMemo", depositMemo);
        return this.#call("GET", `/status?${qs}`, undefined, StatusResponseSchema);
    }
    async #call(method, path, body, schema) {
        try {
            return await this.#once(method, path, body, schema);
        }
        catch (err) {
            if (err instanceof OneClickError && err.retryable) {
                await new Promise((r) => setTimeout(r, this.#retryDelayMs));
                return this.#once(method, path, body, schema);
            }
            throw err;
        }
    }
    async #once(method, path, body, schema) {
        const headers = { accept: "application/json" };
        if (body !== undefined)
            headers["content-type"] = "application/json";
        if (this.#jwt)
            headers["x-api-key"] = this.#jwt;
        const bare = path.split("?")[0] ?? path;
        let res;
        try {
            res = await this.#fetch(this.baseUrl + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
        }
        catch (err) {
            const e = err;
            if (e?.name === "TimeoutError" || e?.name === "AbortError") {
                throw new OneClickError(`1Click ${method} ${bare} timed out after ${this.#timeoutMs} ms`, "timeout", undefined, undefined, bare);
            }
            throw new OneClickError(`1Click ${method} ${bare} network error: ${e?.message ?? String(err)}`, "network", undefined, undefined, bare);
        }
        const text = await res.text();
        let json;
        try {
            json = text.length ? JSON.parse(text) : undefined;
        }
        catch {
            json = undefined;
        }
        if (!res.ok) {
            const parsed = ErrorBodySchema.safeParse(json);
            const msg = parsed.success && parsed.data.message !== undefined
                ? [parsed.data.message].flat().join("; ")
                : text.slice(0, 200) || res.statusText || "request failed";
            const correlationId = (parsed.success ? parsed.data.correlationId : undefined) ?? res.headers.get("x-correlation-id") ?? undefined;
            throw new OneClickError(msg, "http", res.status, correlationId, bare);
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
            const cid = json?.correlationId;
            throw new OneClickError(`1Click ${method} ${bare} returned an unexpected body: ${z.prettifyError(parsed.error).slice(0, 300)}`, "invalid-response", res.status, typeof cid === "string" ? cid : undefined, bare);
        }
        return parsed.data;
    }
}

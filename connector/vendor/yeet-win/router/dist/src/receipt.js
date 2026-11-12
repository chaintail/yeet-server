import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OneClickError, StatusSchema } from "./oneclick.js";
// ---------- state machine ----------
/** Final per 1Click: funds delivered, refunded, or failed. */
export const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
/**
 * States at which tracking stops. INCOMPLETE_DEPOSIT is included: it needs a human (top up, or wait for the
 * refund at the deadline), so the receipt records it with `final: false`.
 */
export const STOP = new Set([...TERMINAL, "INCOMPLETE_DEPOSIT"]);
const RANK = {
    PENDING_DEPOSIT: 0,
    KNOWN_DEPOSIT_TX: 1,
    INCOMPLETE_DEPOSIT: 1,
    PROCESSING: 2,
    SUCCESS: 3,
    REFUNDED: 3,
    FAILED: 3,
};
export const isTerminal = (s) => TERMINAL.has(s);
export const isStop = (s) => STOP.has(s);
/** Returns an anomaly description when a status change goes backwards or leaves a terminal state. */
export function transitionAnomaly(prev, next) {
    if (prev === undefined || prev === next)
        return undefined;
    if (isTerminal(prev))
        return `left terminal state ${prev} for ${next}`;
    if (RANK[next] < RANK[prev])
        return `went backwards ${prev} -> ${next}`;
    return undefined;
}
export const DEFAULT_BACKOFF = { initialMs: 5_000, maxMs: 60_000, factor: 1.6 };
export function backoffDelay(attempt, b = DEFAULT_BACKOFF) {
    return Math.min(b.maxMs, Math.round(b.initialMs * b.factor ** Math.max(0, attempt)));
}
// ---------- receipt ----------
const TxList = z.array(z.string());
export const ReceiptLegSchema = z.object({
    index: z.number().int(),
    symbol: z.string(),
    depositAddress: z.string(),
    depositMemo: z.string().optional(),
    status: StatusSchema.nullable(),
    final: z.boolean(),
    updatedAt: z.string().nullable(),
    quote: z.object({
        amountIn: z.string(),
        amountOut: z.string(),
        minAmountOut: z.string(),
        correlationId: z.string(),
        signature: z.string(),
    }),
    settled: z.object({
        amountIn: z.string().optional(),
        amountInFormatted: z.string().optional(),
        amountOut: z.string().optional(),
        amountOutFormatted: z.string().optional(),
        amountOutUsd: z.string().optional(),
        refundedAmount: z.string().optional(),
        refundReason: z.string().optional(),
        slippage: z.number().optional(),
    }),
    originTxHashes: TxList,
    destinationTxHashes: TxList,
    nearTxHashes: TxList,
    correlationIds: z.array(z.string()),
    history: z.array(z.object({ status: StatusSchema, observedAt: z.string(), updatedAt: z.string() })),
    anomalies: z.array(z.string()),
    lastError: z.string().optional(),
});
export const ReceiptSchema = z.object({
    version: z.literal(1),
    planId: z.string(),
    direction: z.enum(["yeet", "skeet"]),
    recipient: z.string(),
    refundTo: z.string(),
    planCreatedAt: z.string(),
    trackingStartedAt: z.string(),
    writtenAt: z.string(),
    /** Every leg reached SUCCESS, REFUNDED or FAILED. */
    complete: z.boolean(),
    timedOut: z.boolean(),
    legs: z.array(ReceiptLegSchema),
});
function emptyLeg(plan, i) {
    const l = plan.legs[i];
    if (!l.depositAddress)
        throw new Error(`leg ${l.symbol} has no depositAddress`);
    const leg = {
        index: l.index,
        symbol: l.symbol,
        depositAddress: l.depositAddress,
        status: null,
        final: false,
        updatedAt: null,
        quote: { amountIn: l.amountIn, amountOut: l.amountOut, minAmountOut: l.minAmountOut, correlationId: l.correlationId, signature: l.signature },
        settled: {},
        originTxHashes: [],
        destinationTxHashes: [],
        nearTxHashes: [],
        correlationIds: [l.correlationId],
        history: [],
        anomalies: [],
    };
    if (l.depositMemo)
        leg.depositMemo = l.depositMemo;
    return leg;
}
/** Fold one /status response into a receipt leg (pure apart from mutation of `leg`). */
export function applyStatus(leg, res, observedAt) {
    const anomaly = transitionAnomaly(leg.status ?? undefined, res.status);
    if (anomaly)
        leg.anomalies.push(`${observedAt}: ${anomaly}`);
    if (leg.status !== res.status)
        leg.history.push({ status: res.status, observedAt, updatedAt: res.updatedAt });
    leg.status = res.status;
    leg.final = isTerminal(res.status);
    leg.updatedAt = res.updatedAt;
    if (!leg.correlationIds.includes(res.correlationId))
        leg.correlationIds.push(res.correlationId);
    const d = res.swapDetails;
    if (d) {
        const s = leg.settled;
        if (d.amountIn)
            s.amountIn = d.amountIn;
        if (d.amountInFormatted)
            s.amountInFormatted = d.amountInFormatted;
        if (d.amountOut)
            s.amountOut = d.amountOut;
        if (d.amountOutFormatted)
            s.amountOutFormatted = d.amountOutFormatted;
        if (d.amountOutUsd)
            s.amountOutUsd = d.amountOutUsd;
        if (d.refundedAmount)
            s.refundedAmount = d.refundedAmount;
        if (d.refundReason)
            s.refundReason = d.refundReason;
        if (d.slippage !== undefined)
            s.slippage = d.slippage;
        leg.originTxHashes = uniq([...leg.originTxHashes, ...d.originChainTxHashes.map((t) => t.hash)]);
        leg.destinationTxHashes = uniq([...leg.destinationTxHashes, ...d.destinationChainTxHashes.map((t) => t.hash)]);
        leg.nearTxHashes = uniq([...leg.nearTxHashes, ...d.nearTxHashes]);
    }
    delete leg.lastError;
    return leg;
}
const uniq = (xs) => [...new Set(xs)];
export function receiptFileName(plan) {
    return `${plan.id}-${plan.createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}
async function writeReceipt(dir, name, receipt) {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    await rename(tmp, path);
    return path;
}
/**
 * Poll /status for every leg of a live plan until each reaches a stop state (or timeout), writing the receipt
 * after every round so a crash never loses observed tx hashes.
 */
export async function trackPlan(plan, opts) {
    if (plan.dry)
        throw new Error("cannot track a dry plan: it has no deposit addresses");
    const now = opts.now ?? (() => new Date());
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    const started = now();
    const legs = plan.legs.map((_, i) => emptyLeg(plan, i));
    const name = receiptFileName(plan);
    const snapshot = (timedOut) => ({
        version: 1,
        planId: plan.id,
        direction: plan.direction,
        recipient: plan.recipient,
        refundTo: plan.refundTo,
        planCreatedAt: plan.createdAt,
        trackingStartedAt: started.toISOString(),
        writtenAt: now().toISOString(),
        complete: legs.every((l) => l.final),
        timedOut,
        legs,
    });
    let path = "";
    for (let attempt = 0;; attempt++) {
        const open = legs.filter((l) => l.status === null || !isStop(l.status));
        await Promise.all(open.map(async (leg) => {
            try {
                const res = await opts.client.status(leg.depositAddress, leg.depositMemo);
                applyStatus(leg, res, now().toISOString());
            }
            catch (e) {
                const cid = e instanceof OneClickError && e.correlationId ? ` (correlationId ${e.correlationId})` : "";
                leg.lastError = `${e.message}${cid}`;
                if (e instanceof OneClickError && e.correlationId && !leg.correlationIds.includes(e.correlationId)) {
                    leg.correlationIds.push(e.correlationId);
                }
            }
            opts.onUpdate?.(leg);
        }));
        const done = legs.every((l) => l.status !== null && isStop(l.status));
        const timedOut = !done && now().getTime() - started.getTime() >= timeoutMs;
        const receipt = snapshot(timedOut);
        path = await writeReceipt(opts.dir, name, receipt);
        if (done || timedOut)
            return { receipt, path };
        await sleep(backoffDelay(attempt, backoff));
    }
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** Re-query /status for every leg in a stored receipt and report whether the stored facts still hold. */
export async function replay(receiptPath, opts) {
    const receipt = ReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    const legs = await Promise.all(receipt.legs.map(async (stored) => {
        const differences = [];
        let currentStatus = null;
        try {
            const res = await opts.client.status(stored.depositAddress, stored.depositMemo);
            currentStatus = res.status;
            const fresh = applyStatus(structuredClone({ ...stored, status: null, history: [], anomalies: [], originTxHashes: [], destinationTxHashes: [], nearTxHashes: [], settled: {} }), res, new Date().toISOString());
            if (stored.status !== res.status)
                differences.push(`status ${stored.status} -> ${res.status}`);
            if (!sameSet(stored.originTxHashes, fresh.originTxHashes))
                differences.push("origin tx hashes differ");
            if (!sameSet(stored.destinationTxHashes, fresh.destinationTxHashes))
                differences.push("destination tx hashes differ");
            if ((stored.settled.amountOut ?? null) !== (fresh.settled.amountOut ?? null)) {
                differences.push(`amountOut ${stored.settled.amountOut ?? "-"} -> ${fresh.settled.amountOut ?? "-"}`);
            }
            if ((stored.settled.refundedAmount ?? null) !== (fresh.settled.refundedAmount ?? null)) {
                differences.push(`refundedAmount ${stored.settled.refundedAmount ?? "-"} -> ${fresh.settled.refundedAmount ?? "-"}`);
            }
        }
        catch (e) {
            const cid = e instanceof OneClickError && e.correlationId ? ` (correlationId ${e.correlationId})` : "";
            differences.push(`status query failed: ${e.message}${cid}`);
        }
        return {
            index: stored.index,
            symbol: stored.symbol,
            depositAddress: stored.depositAddress,
            storedStatus: stored.status,
            currentStatus,
            matches: differences.length === 0,
            differences,
        };
    }));
    return { planId: receipt.planId, matches: legs.every((l) => l.matches), legs };
}

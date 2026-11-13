import { createHash } from "node:crypto";
import { isBurnEvmAddress, isEvmAddress, isSolanaAddress } from "./address.js";
import { CATALOG, FUNDING, findToken, knownTokenAddresses } from "./catalog.js";
import { OneClickError } from "./oneclick.js";
import { formatUnits, parseUnits, sumUsd } from "./units.js";
/** Most parts one coin can have. Parts are a free ratio: a coin's share is parts / sum(parts); 0 leaves it out. */
export const MAX_PARTS = 99;
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 1_000;
export const DEFAULT_DEADLINE_MINUTES = 30;
export class PlanValidationError extends Error {
    field;
    name = "PlanValidationError";
    constructor(field, message) {
        super(`${field}: ${message}`);
        this.field = field;
    }
}
export class PlanQuoteError extends Error {
    failures;
    name = "PlanQuoteError";
    constructor(failures) {
        super("quote failed for " +
            failures
                .map((f) => `${f.symbol} (${f.error.message}${f.error instanceof OneClickError && f.error.correlationId ? `, correlationId ${f.error.correlationId}` : ""})`)
                .join("; "));
        this.failures = failures;
    }
}
// ---------- arithmetic ----------
/**
 * Split `total` smallest units by integer `parts`. Each share is floor(total*p/sum);
 * the remainder goes to the leg with the most parts (first one on a tie). Shares sum to `total` exactly.
 */
export function splitByParts(total, parts) {
    if (parts.length === 0)
        throw new RangeError("no parts");
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum <= 0)
        throw new RangeError("parts must sum to a positive number");
    const shares = parts.map((p) => (total * BigInt(p)) / BigInt(sum));
    const remainder = total - shares.reduce((a, b) => a + b, 0n);
    let largest = 0;
    parts.forEach((p, i) => {
        if (p > (parts[largest] ?? 0))
            largest = i;
    });
    shares[largest] = (shares[largest] ?? 0n) + remainder;
    return shares;
}
// ---------- validation ----------
function checkSlippage(bps) {
    const v = bps ?? DEFAULT_SLIPPAGE_BPS;
    if (!Number.isInteger(v) || v < 0 || v > MAX_SLIPPAGE_BPS) {
        throw new PlanValidationError("slippageBps", `must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`);
    }
    return v;
}
function checkEvm(field, addr, catalog) {
    const a = addr.trim();
    if (!isEvmAddress(a))
        throw new PlanValidationError(field, "not an EVM address (0x + 40 hex characters)");
    if (isBurnEvmAddress(a))
        throw new PlanValidationError(field, "zero/burn address cannot receive funds");
    if (knownTokenAddresses(catalog).has(a.toLowerCase()))
        throw new PlanValidationError(field, "this is a token contract, not a wallet");
    return a;
}
function checkSol(field, addr, catalog) {
    const a = addr.trim();
    if (!isSolanaAddress(a))
        throw new PlanValidationError(field, "not a Solana address (base58, 32 bytes)");
    if (knownTokenAddresses(catalog).has(a.toLowerCase()))
        throw new PlanValidationError(field, "this is a token mint, not a wallet");
    return a;
}
function checkDeadlineMinutes(m) {
    const v = m ?? DEFAULT_DEADLINE_MINUTES;
    if (!Number.isFinite(v) || v < 5 || v > 24 * 60)
        throw new PlanValidationError("deadlineMinutes", "must be between 5 and 1440");
    return v;
}
function resolveSolToken(field, symbol, catalog) {
    const t = findToken(symbol, "solana", catalog);
    if (!t)
        throw new PlanValidationError(field, `unknown Solana token ${JSON.stringify(symbol)}`);
    if (t.kind === "funding")
        throw new PlanValidationError(field, `${t.symbol} is the funding asset`);
    return t;
}
// ---------- plan id ----------
function canonical(value) {
    if (Array.isArray(value))
        return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
    }
    return JSON.stringify(value);
}
/** Plan id = sha256 of the canonical request (no timestamps), so the same request always gets the same id. */
export function planId(direction, canonicalRequest) {
    const h = createHash("sha256").update(canonical({ direction, request: canonicalRequest })).digest("hex");
    return `${direction}_${h.slice(0, 24)}`;
}
function brief(t) {
    return { symbol: t.symbol, chain: t.chain, assetId: t.assetId, decimals: t.decimals };
}
async function quoteLegs(deps, legs, common) {
    const settled = await Promise.allSettled(legs.map((leg) => {
        const req = {
            dry: common.dry,
            swapType: "EXACT_INPUT",
            slippageTolerance: common.slippageBps,
            originAsset: leg.origin.assetId,
            depositType: "ORIGIN_CHAIN",
            destinationAsset: leg.destination.assetId,
            amount: leg.amount.toString(),
            refundTo: common.refundTo,
            refundType: "ORIGIN_CHAIN",
            recipient: common.recipient,
            recipientType: "DESTINATION_CHAIN",
            deadline: common.deadline,
        };
        return deps.client.quote(req);
    }));
    const failures = [];
    const out = [];
    settled.forEach((r, i) => {
        const leg = legs[i];
        if (r.status === "rejected") {
            failures.push({ symbol: leg.symbol, error: r.reason instanceof Error ? r.reason : new Error(String(r.reason)) });
            return;
        }
        try {
            out.push(toPlanLeg(i, leg, r.value, common));
        }
        catch (e) {
            failures.push({ symbol: leg.symbol, error: e });
        }
    });
    if (failures.length)
        throw new PlanQuoteError(failures);
    return out;
}
function toPlanLeg(index, leg, res, common) {
    const q = res.quote;
    if (q.amountIn !== leg.amount.toString()) {
        throw new Error(`quote amountIn ${q.amountIn} differs from requested ${leg.amount} (correlationId ${res.correlationId})`);
    }
    if (!common.dry && !q.depositAddress) {
        throw new Error(`live quote returned no depositAddress (correlationId ${res.correlationId})`);
    }
    if (common.dry && q.depositAddress) {
        throw new Error(`dry quote unexpectedly returned a depositAddress (correlationId ${res.correlationId})`);
    }
    const legOut = {
        index,
        symbol: leg.symbol,
        origin: brief(leg.origin),
        destination: brief(leg.destination),
        amountIn: q.amountIn,
        amountInFormatted: q.amountInFormatted,
        amountInUsd: q.amountInUsd,
        amountOut: q.amountOut,
        amountOutFormatted: q.amountOutFormatted,
        amountOutUsd: q.amountOutUsd,
        minAmountOut: q.minAmountOut,
        minAmountOutFormatted: formatUnits(BigInt(q.minAmountOut), leg.destination.decimals),
        timeEstimate: q.timeEstimate,
        deadline: q.deadline ?? common.deadline,
        correlationId: res.correlationId,
        signature: res.signature,
        quoteTimestamp: res.timestamp,
    };
    if (leg.parts !== undefined)
        legOut.parts = leg.parts;
    if (q.depositAddress)
        legOut.depositAddress = q.depositAddress;
    if (q.depositMemo)
        legOut.depositMemo = q.depositMemo;
    if (q.timeWhenInactive)
        legOut.timeWhenInactive = q.timeWhenInactive;
    return legOut;
}
function sumSame(legs, key, side) {
    const first = legs[0]?.[side];
    if (!first || legs.some((l) => l[side].assetId !== first.assetId))
        return undefined;
    const total = legs.reduce((a, l) => a + BigInt(l[key]), 0n);
    return { raw: total.toString(), formatted: formatUnits(total, first.decimals) };
}
function totals(legs) {
    const t = {
        amountInUsd: sumUsd(legs.map((l) => l.amountInUsd)),
        amountOutUsd: sumUsd(legs.map((l) => l.amountOutUsd)),
        timeEstimate: Math.max(0, ...legs.map((l) => l.timeEstimate)),
    };
    const inn = sumSame(legs, "amountIn", "origin");
    if (inn) {
        t.amountIn = inn.raw;
        t.amountInFormatted = inn.formatted;
    }
    const out = sumSame(legs, "amountOut", "destination");
    const min = sumSame(legs, "minAmountOut", "destination");
    if (out && min) {
        t.amountOut = out.raw;
        t.amountOutFormatted = out.formatted;
        t.minAmountOut = min.raw;
        t.minAmountOutFormatted = min.formatted;
    }
    return t;
}
// ---------- public builders ----------
/** USDC on Base -> weighted basket of Solana tokens delivered to `recipientSol`. Validates everything before any API call. */
export async function buildYeetPlan(input, deps) {
    const catalog = deps.catalog ?? CATALOG;
    const now = (deps.now ?? (() => new Date()))();
    const dry = input.dry ?? true;
    const slippageBps = checkSlippage(input.slippageBps);
    const deadlineMinutes = checkDeadlineMinutes(input.deadlineMinutes);
    const recipient = checkSol("recipientSol", input.recipientSol, catalog);
    const refundTo = checkEvm("refundBase", input.refundBase, catalog);
    const funding = findToken(FUNDING.symbol, "base", catalog) ?? FUNDING;
    let total;
    try {
        total = parseUnits(input.amountUsdc, funding.decimals);
    }
    catch (e) {
        throw new PlanValidationError("amountUsdc", e.message);
    }
    if (total <= 0n)
        throw new PlanValidationError("amountUsdc", "must be greater than zero");
    if (!Array.isArray(input.legs) || input.legs.length === 0)
        throw new PlanValidationError("legs", "at least one leg is required");
    const seen = new Set();
    const all = input.legs.map((l, i) => {
        if (!Number.isInteger(l.parts) || l.parts < 0 || l.parts > MAX_PARTS)
            throw new PlanValidationError(`legs[${i}].parts`, `must be a whole number from 0 to ${MAX_PARTS}`);
        const token = resolveSolToken(`legs[${i}].symbol`, l.symbol, catalog);
        if (seen.has(token.assetId))
            throw new PlanValidationError(`legs[${i}].symbol`, `${token.symbol} appears twice`);
        seen.add(token.assetId);
        return { token, parts: l.parts, index: i };
    });
    // A coin at 0 parts is left out of the trade; the rest split the USDC by parts / sum(parts).
    const resolved = all.filter((l) => l.parts > 0);
    if (resolved.length === 0)
        throw new PlanValidationError("legs", "at least one coin needs 1 or more parts");
    const shares = splitByParts(total, resolved.map((l) => l.parts));
    // Name the leg as the caller sent it, 0-part coins included, so the index matches their input.
    shares.forEach((s, i) => {
        if (s <= 0n)
            throw new PlanValidationError(`legs[${resolved[i].index}]`, "amount too small to split");
    });
    const legs = resolved.map((l, i) => ({
        symbol: l.token.symbol,
        parts: l.parts,
        origin: funding,
        destination: l.token,
        amount: shares[i],
    }));
    const id = planId("yeet", {
        amountIn: total.toString(),
        originAsset: funding.assetId,
        legs: legs.map((l) => ({ assetId: l.destination.assetId, parts: l.parts, amount: l.amount.toString() })),
        recipient,
        refundTo,
        slippageBps,
        dry,
    });
    const deadline = new Date(now.getTime() + deadlineMinutes * 60_000).toISOString();
    const planLegs = await quoteLegs(deps, legs, { recipient, refundTo, slippageBps, dry, deadline });
    return {
        id,
        direction: "yeet",
        dry,
        createdAt: now.toISOString(),
        recipient,
        refundTo,
        slippageBps,
        authenticated: deps.client.authenticated,
        legs: planLegs,
        totals: totals(planLegs),
    };
}
/** One or more Solana tokens -> USDC on Base delivered to `recipientBase`. */
export async function buildSkeetPlan(input, deps) {
    const catalog = deps.catalog ?? CATALOG;
    const now = (deps.now ?? (() => new Date()))();
    const dry = input.dry ?? true;
    const slippageBps = checkSlippage(input.slippageBps);
    const deadlineMinutes = checkDeadlineMinutes(input.deadlineMinutes);
    const recipient = checkEvm("recipientBase", input.recipientBase, catalog);
    const refundTo = checkSol("refundSol", input.refundSol, catalog);
    const funding = findToken(FUNDING.symbol, "base", catalog) ?? FUNDING;
    if (!Array.isArray(input.legs) || input.legs.length === 0)
        throw new PlanValidationError("legs", "at least one leg is required");
    const seen = new Set();
    const legs = input.legs.map((l, i) => {
        const token = resolveSolToken(`legs[${i}].symbol`, l.symbol, catalog);
        if (seen.has(token.assetId))
            throw new PlanValidationError(`legs[${i}].symbol`, `${token.symbol} appears twice`);
        seen.add(token.assetId);
        let amount;
        try {
            amount = parseUnits(l.amount, token.decimals);
        }
        catch (e) {
            throw new PlanValidationError(`legs[${i}].amount`, e.message);
        }
        if (amount <= 0n)
            throw new PlanValidationError(`legs[${i}].amount`, "must be greater than zero");
        return { symbol: token.symbol, origin: token, destination: funding, amount };
    });
    const id = planId("skeet", {
        destinationAsset: funding.assetId,
        legs: legs.map((l) => ({ assetId: l.origin.assetId, amount: l.amount.toString() })),
        recipient,
        refundTo,
        slippageBps,
        dry,
    });
    const deadline = new Date(now.getTime() + deadlineMinutes * 60_000).toISOString();
    const planLegs = await quoteLegs(deps, legs, { recipient, refundTo, slippageBps, dry, deadline });
    return {
        id,
        direction: "skeet",
        dry,
        createdAt: now.toISOString(),
        recipient,
        refundTo,
        slippageBps,
        authenticated: deps.client.authenticated,
        legs: planLegs,
        totals: totals(planLegs),
    };
}

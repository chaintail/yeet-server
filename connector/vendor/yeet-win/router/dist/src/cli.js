#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CATALOG } from "./catalog.js";
import { OneClickClient, OneClickError } from "./oneclick.js";
import { buildSkeetPlan, buildYeetPlan, PlanQuoteError, PlanValidationError } from "./plan.js";
import { replay, ReceiptSchema, trackPlan } from "./receipt.js";
import { roundUsd } from "./units.js";
const USAGE = `yeet-router <command>

  quote   --usdc <amount> --legs SYM:parts,... --to <solana wallet> --refund <base address>
          [--slippage <bps>] [--save plan.json] [--json] [--live]
  skeet   --sell SYM:amount,... --to <base address> --refund <solana wallet>
          [--slippage <bps>] [--save plan.json] [--json] [--live]
  catalog [--json]
  status  <depositAddress> [--memo <memo>]
  track   <plan.json> [--dir receipts] [--timeout-min 20]
  replay  <receipt.json> [--statuses statuses.json]

Quotes are dry (no deposit address) unless --live is passed AND YEET_ALLOW_LIVE=1 is set.
replay asks 1Click /status again for every leg; with --statuses it reads the /status answers from a JSON file
({depositAddress: statusResponse}) instead of the network.`;
/**
 * A 1Click client whose /status answers come from a file ({depositAddress: statusResponse}) instead of the network.
 * The answers still pass through the client's zod validation. An address missing from the file is a 404.
 */
export function recordedStatusClient(statuses) {
    const answer = (async (input) => {
        const addr = new URL(String(input)).searchParams.get("depositAddress") ?? "";
        const known = Object.hasOwn(statuses, addr);
        const body = known ? statuses[addr] : { message: `no recorded status for ${addr}` };
        return new Response(JSON.stringify(body), { status: known ? 200 : 404, headers: { "content-type": "application/json" } });
    });
    return new OneClickClient({ fetch: answer, jwt: undefined, retryDelayMs: 0 });
}
const EXPLORER = {
    base: (h) => `https://basescan.org/tx/${h}`,
    solana: (h) => `https://solscan.io/tx/${h}`,
    near: (h) => `https://nearblocks.io/txns/${h}`,
};
/** The tx hashes a receipt leg holds, with an explorer link for each. */
function txLines(receipt, leg) {
    const [origin, dest] = receipt.direction === "yeet" ? ["base", "solana"] : ["solana", "base"];
    const line = (label, url) => `  ${label.padEnd(24)}${url}`;
    return [
        ...leg.originTxHashes.map((h) => line(`deposit tx (${origin})`, EXPLORER[origin](h))),
        ...leg.nearTxHashes.map((h) => line("NEAR Intents tx (near)", EXPLORER.near(h))),
        ...leg.destinationTxHashes.map((h) => line(`delivery tx (${dest})`, EXPLORER[dest](h))),
    ];
}
export class UsageError extends Error {
}
/** Column 0 and any column listed in `left` are left-aligned; the rest (numbers) are right-aligned. */
function table(rows, left = []) {
    const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
    return rows
        .map((r) => r
        .map((cell, c) => (c === 0 || left.includes(c) ? cell.padEnd(widths[c]) : cell.padStart(widths[c])))
        .join("  ")
        .trimEnd())
        .join("\n");
}
function short(n, max = 14) {
    if (n.length <= max)
        return n;
    const [w, f = ""] = n.split(".");
    if ((w ?? "").length >= max)
        return w ?? n;
    return `${w}.${f.slice(0, Math.max(0, max - (w ?? "").length - 1))}`;
}
function printPlan(plan) {
    const head = ["leg", "parts", "in", "out", "min out", "usd in", "usd out", "eta s"];
    const rows = plan.legs.map((l) => [
        `${l.origin.symbol}->${l.destination.symbol}`,
        l.parts !== undefined ? String(l.parts) : "-",
        short(l.amountInFormatted),
        short(l.amountOutFormatted),
        short(l.minAmountOutFormatted),
        roundUsd(l.amountInUsd),
        roundUsd(l.amountOutUsd),
        String(l.timeEstimate),
    ]);
    const t = plan.totals;
    rows.push([
        "total",
        plan.direction === "yeet" ? String(plan.legs.reduce((a, l) => a + (l.parts ?? 0), 0)) : "-",
        t.amountInFormatted ? short(t.amountInFormatted) : "-",
        t.amountOutFormatted ? short(t.amountOutFormatted) : "-",
        t.minAmountOutFormatted ? short(t.minAmountOutFormatted) : "-",
        roundUsd(t.amountInUsd),
        roundUsd(t.amountOutUsd),
        String(t.timeEstimate),
    ]);
    console.log(`${plan.direction.toUpperCase()} plan ${plan.id}  ${plan.dry ? "DRY (no deposit addresses)" : "LIVE"}  slippage ${plan.slippageBps} bps${plan.authenticated ? "" : "  (no API key: +25 bps 1Click fee)"}`);
    console.log(`to ${plan.recipient}  refund ${plan.refundTo}`);
    console.log(table([head, ...rows]));
    if (!plan.dry) {
        for (const l of plan.legs) {
            console.log(`deposit ${l.amountInFormatted} ${l.origin.symbol} to ${l.depositAddress}${l.depositMemo ? ` memo ${l.depositMemo}` : ""} before ${l.deadline}`);
        }
    }
}
function liveAllowed(flag) {
    if (!flag)
        return false;
    if (process.env.YEET_ALLOW_LIVE !== "1") {
        throw new UsageError("refusing a live quote: --live also requires YEET_ALLOW_LIVE=1 in the environment");
    }
    return true;
}
function pairs(spec, flag) {
    if (!spec)
        throw new UsageError(`${flag} is required`);
    return spec.split(",").map((p) => {
        const [sym, val, ...rest] = p.split(":");
        if (!sym || !val || rest.length)
            throw new UsageError(`${flag}: expected SYM:value, got ${JSON.stringify(p)}`);
        return [sym.trim(), val.trim()];
    });
}
function slippage(v) {
    if (v === undefined)
        return undefined;
    if (!/^\d+$/.test(v))
        throw new UsageError("--slippage must be an integer number of basis points");
    return Number(v);
}
async function emit(plan, values) {
    if (values.save)
        await writeFile(values.save, JSON.stringify(plan, null, 2) + "\n", "utf8");
    if (values.json)
        console.log(JSON.stringify(plan, null, 2));
    else
        printPlan(plan);
    if (values.save)
        console.error(`plan saved to ${values.save}`);
}
const tradeOptions = {
    usdc: { type: "string" },
    legs: { type: "string" },
    sell: { type: "string" },
    to: { type: "string" },
    refund: { type: "string" },
    slippage: { type: "string" },
    save: { type: "string" },
    json: { type: "boolean" },
    live: { type: "boolean" },
    memo: { type: "string" },
    dir: { type: "string" },
    "timeout-min": { type: "string" },
    statuses: { type: "string" },
    help: { type: "boolean", short: "h" },
};
export async function main(argv) {
    const [command, ...rest] = argv;
    const { values, positionals } = parseArgs({ args: rest, options: tradeOptions, allowPositionals: true, strict: true });
    if (!command || values.help || command === "help") {
        console.log(USAGE);
        return 0;
    }
    const client = new OneClickClient();
    switch (command) {
        case "quote": {
            const legs = pairs(values.legs, "--legs").map(([symbol, parts]) => {
                if (!/^\d+$/.test(parts))
                    throw new UsageError(`--legs: parts for ${symbol} must be an integer`);
                return { symbol, parts: Number(parts) };
            });
            if (!values.usdc)
                throw new UsageError("--usdc is required");
            if (!values.to || !values.refund)
                throw new UsageError("--to and --refund are required");
            const plan = await buildYeetPlan({ amountUsdc: values.usdc, legs, recipientSol: values.to, refundBase: values.refund, slippageBps: slippage(values.slippage), dry: !liveAllowed(values.live) }, { client });
            await emit(plan, values);
            return 0;
        }
        case "skeet": {
            const legs = pairs(values.sell, "--sell").map(([symbol, amount]) => ({ symbol, amount }));
            if (!values.to || !values.refund)
                throw new UsageError("--to and --refund are required");
            const plan = await buildSkeetPlan({ legs, recipientBase: values.to, refundSol: values.refund, slippageBps: slippage(values.slippage), dry: !liveAllowed(values.live) }, { client });
            await emit(plan, values);
            return 0;
        }
        case "catalog": {
            if (values.json) {
                console.log(JSON.stringify(CATALOG, null, 2));
                return 0;
            }
            const rows = CATALOG.map((e) => [e.symbol, e.kind, e.chain, String(e.decimals), e.name, e.address ?? "(native)"]);
            console.log(table([["symbol", "kind", "chain", "dec", "name", "address"], ...rows], [1, 2, 4, 5]));
            console.log(`${CATALOG.length} tokens`);
            return 0;
        }
        case "status": {
            const addr = positionals[0];
            if (!addr)
                throw new UsageError("status needs a deposit address");
            const s = await client.status(addr, values.memo);
            const d = s.swapDetails;
            console.log(`${s.status}  updated ${s.updatedAt}  correlationId ${s.correlationId}`);
            if (d?.amountInFormatted || d?.amountOutFormatted)
                console.log(`in ${d.amountInFormatted ?? "-"}  out ${d.amountOutFormatted ?? "-"}`);
            for (const t of d?.originChainTxHashes ?? [])
                console.log(`origin tx ${t.hash}`);
            for (const h of d?.nearTxHashes ?? [])
                console.log(`near tx ${h}`);
            for (const t of d?.destinationChainTxHashes ?? [])
                console.log(`destination tx ${t.hash}`);
            if (d?.refundReason)
                console.log(`refund reason ${d.refundReason}`);
            return 0;
        }
        case "track": {
            const file = positionals[0];
            if (!file)
                throw new UsageError("track needs a plan.json saved with --save");
            const plan = JSON.parse(await readFile(file, "utf8"));
            const timeoutMin = values["timeout-min"] ? Number(values["timeout-min"]) : 20;
            const { receipt, path } = await trackPlan(plan, {
                client,
                dir: values.dir ?? "receipts",
                timeoutMs: timeoutMin * 60_000,
                onUpdate: (l) => console.error(`${l.symbol} ${l.status ?? "?"}${l.lastError ? `  (${l.lastError})` : ""}`),
            });
            console.log(`receipt ${path}  complete=${receipt.complete} timedOut=${receipt.timedOut}`);
            return receipt.complete ? 0 : 1;
        }
        case "replay": {
            const file = positionals[0];
            if (!file)
                throw new UsageError("replay needs a receipt.json");
            const source = values.statuses
                ? recordedStatusClient(JSON.parse(await readFile(values.statuses, "utf8")))
                : client;
            const stored = ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
            const r = await replay(file, { client: source });
            for (const l of r.legs) {
                console.log(`${l.symbol}  ${l.storedStatus ?? "-"} -> ${l.currentStatus ?? "-"}  ${l.matches ? "match" : l.differences.join("; ")}`);
                const leg = stored.legs.find((x) => x.index === l.index);
                if (leg)
                    for (const line of txLines(stored, leg))
                        console.log(line);
            }
            const against = values.statuses ? `the statuses in ${values.statuses}` : "1Click";
            console.log(`plan ${r.planId}: ${r.matches ? `receipt matches ${against}` : `receipt differs from ${against}`}`);
            return r.matches ? 0 : 1;
        }
        default:
            throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
}
function invokedDirectly() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(entry)).href;
    }
    catch {
        return false;
    }
}
if (invokedDirectly()) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        if (err instanceof UsageError || err?.code?.startsWith("ERR_PARSE_ARGS")) {
            console.error(`error: ${err.message}\n\n${USAGE}`);
            process.exit(2);
        }
        if (err instanceof PlanValidationError) {
            console.error(`invalid request: ${err.message}`);
            process.exit(2);
        }
        if (err instanceof OneClickError) {
            console.error(`1Click error${err.status ? ` ${err.status}` : ""}: ${err.message}${err.correlationId ? ` (correlationId ${err.correlationId})` : ""}`);
        }
        else if (err instanceof PlanQuoteError) {
            console.error(err.message);
        }
        else {
            console.error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
    });
}

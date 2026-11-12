/** Parse a non-negative decimal string (or safe number) into smallest units. Rejects excess precision. */
export function parseUnits(value, decimals) {
    const s = typeof value === "number" ? numberToPlain(value) : value.trim();
    const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
    if (!m)
        throw new RangeError(`not a plain non-negative decimal: ${JSON.stringify(value)}`);
    const whole = m[1] ?? "0";
    const frac = (m[2] ?? "").replace(/0+$/, "");
    if (frac.length > decimals)
        throw new RangeError(`${s} has more than ${decimals} decimal places`);
    return BigInt(whole + frac.padEnd(decimals, "0"));
}
function numberToPlain(n) {
    if (!Number.isFinite(n) || n < 0)
        throw new RangeError(`not a finite non-negative number: ${n}`);
    const s = String(n);
    if (/e/i.test(s))
        throw new RangeError(`number ${s} uses exponent notation; pass a string`);
    return s;
}
export function formatUnits(value, decimals) {
    const neg = value < 0n;
    const abs = neg ? -value : value;
    const str = abs.toString().padStart(decimals + 1, "0");
    const whole = str.slice(0, str.length - decimals) || "0";
    const frac = decimals > 0 ? str.slice(str.length - decimals).replace(/0+$/, "") : "";
    return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
const USD_SCALE = 12;
/** Sum decimal USD strings exactly (12-decimal fixed point; extra digits truncated). */
export function sumUsd(values) {
    let total = 0n;
    for (const v of values) {
        const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(v.trim());
        if (!m)
            continue;
        const frac = (m[3] ?? "").slice(0, USD_SCALE).padEnd(USD_SCALE, "0");
        const n = BigInt((m[2] ?? "0") + frac);
        total += m[1] === "-" ? -n : n;
    }
    return formatUnits(total, USD_SCALE);
}
export function roundUsd(value, places = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(places) : value;
}

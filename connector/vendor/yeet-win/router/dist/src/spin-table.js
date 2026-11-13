// The daily spin's draw table, as the card draws it: contracts/yeet-tools.json `x-yeet-spin`. The server owns the draw;
// the card owns the wheel. Both must agree on the values, or the wheel lands on a slice that names a different award.
// The server calls assertSpinTable at boot with its own table and the vendored contract's `x-yeet-spin`.
const isXp = (v) => Number.isInteger(v) && v >= 0;
/** Every way `table` disagrees with `spec`, as readable lines; empty when they match. */
export function spinTableProblems(table, spec) {
    const out = [];
    if (!spec || !Array.isArray(spec.bonus_xp) || !isXp(spec.base_xp) || !isXp(spec.streak_bonus_xp) || !spec.bonus_xp.every(isXp)) {
        return ['contract x-yeet-spin: base_xp, streak_bonus_xp and bonus_xp must be whole XP values'];
    }
    if (!table || !Array.isArray(table.bonus))
        return ['server table: bonus must be a list'];
    if (table.base_xp !== spec.base_xp)
        out.push(`base_xp: server ${String(table.base_xp)}, contract ${spec.base_xp}`);
    if (table.streak_bonus_xp !== spec.streak_bonus_xp)
        out.push(`streak_bonus_xp: server ${String(table.streak_bonus_xp)}, contract ${spec.streak_bonus_xp}`);
    const xp = [];
    let weights = 0, weighted = 0;
    table.bonus.forEach((row, i) => {
        if (typeof row === 'number') {
            xp.push(row);
            return;
        }
        xp.push(row?.xp);
        if (row && row.weight !== undefined) {
            weighted += 1;
            if (typeof row.weight !== 'number' || !Number.isFinite(row.weight) || row.weight <= 0)
                out.push(`bonus[${i}]: weight must be above 0`);
            else
                weights += row.weight;
        }
    });
    xp.forEach((v, i) => { if (!isXp(v))
        out.push(`bonus[${i}]: xp must be a whole number of 0 or more`); });
    if (new Set(xp).size !== xp.length)
        out.push('bonus: duplicate xp values');
    if (weighted !== 0 && weighted !== xp.length)
        out.push('bonus: every row needs a weight, or none');
    if (weighted === xp.length && xp.length && Math.abs(weights - 100) > 1e-9)
        out.push(`bonus: weights sum to ${weights}, not 100`);
    if (xp.length !== spec.bonus_xp.length || xp.some((v, i) => v !== spec.bonus_xp[i])) {
        out.push(`bonus xp: server [${xp.map(String).join(', ')}], contract [${spec.bonus_xp.join(', ')}]`);
    }
    return out;
}
/** Throws when `table` disagrees with `spec`; the message lists every difference. */
export function assertSpinTable(table, spec) {
    const problems = spinTableProblems(table, spec);
    if (problems.length)
        throw new Error(`spin table does not match the contract x-yeet-spin: ${problems.join('; ')}`);
}

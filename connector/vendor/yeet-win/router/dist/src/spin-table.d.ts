/** The contract's `x-yeet-spin` block (only the fields this check reads). */
export interface SpinSpec {
    base_xp: number;
    bonus_xp: readonly number[];
    streak_bonus_xp: number;
}
/** A server's spin table. `bonus` is the weighted draw table in draw order: plain XP values or {xp, weight} rows. */
export interface ServerSpinTable {
    base_xp: number;
    bonus: readonly (number | {
        readonly xp: number;
        readonly weight?: number;
    })[];
    streak_bonus_xp: number;
}
/** Every way `table` disagrees with `spec`, as readable lines; empty when they match. */
export declare function spinTableProblems(table: ServerSpinTable, spec: SpinSpec): string[];
/** Throws when `table` disagrees with `spec`; the message lists every difference. */
export declare function assertSpinTable(table: ServerSpinTable, spec: SpinSpec): void;

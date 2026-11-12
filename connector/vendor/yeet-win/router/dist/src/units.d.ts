/** Parse a non-negative decimal string (or safe number) into smallest units. Rejects excess precision. */
export declare function parseUnits(value: string | number, decimals: number): bigint;
export declare function formatUnits(value: bigint, decimals: number): string;
/** Sum decimal USD strings exactly (12-decimal fixed point; extra digits truncated). */
export declare function sumUsd(values: readonly string[]): string;
export declare function roundUsd(value: string, places?: number): string;

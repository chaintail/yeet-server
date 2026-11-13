#!/usr/bin/env node
import { OneClickClient } from "./oneclick.js";
/**
 * A 1Click client whose /status answers come from a file ({depositAddress: statusResponse}) instead of the network.
 * The answers still pass through the client's zod validation. An address missing from the file is a 404.
 */
export declare function recordedStatusClient(statuses: Record<string, unknown>): OneClickClient;
export declare class UsageError extends Error {
}
export declare function main(argv: string[]): Promise<number>;

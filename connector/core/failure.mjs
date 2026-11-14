import {toolMessage,isRetryable} from '#contracts/errors';
/** The contract `failure` shape for one catalogue code. */
export const failure=code=>({error:code,message:toolMessage(code),retryable:isRetryable(code)});
/** LIMIT_EXCEEDED carries the person's tier and numbers (trade/limits.mjs overCap), BALANCE_LOW the person's USDC on
 * Base and on Solana (pipeline/funding.mjs): that sentence replaces the catalogue message. Other codes keep the
 * catalogue text. */
// AMOUNT_TOO_SMALL carries its own sentence only for a SELL under the sell minimum (trade/limits.mjs skeetTooSmall).
export const OWN_MESSAGE=Object.freeze(['LIMIT_EXCEEDED','BALANCE_LOW','AMOUNT_TOO_SMALL']);
export const userMessageOk=(code,m)=>OWN_MESSAGE.includes(code)&&typeof m==='string'&&m.length>=1&&m.length<=500;
export const withUserMessage=(f,e)=>userMessageOk(f.error,e?.userMessage)?{...f,message:e.userMessage}:f;
/** A route that is registered but not built yet. */
export const unavailable=res=>res.status(503).json(failure('TEMPORARILY_UNAVAILABLE'));

import {toolMessage,isRetryable} from '#contracts/errors';
/** The contract `failure` shape for one catalogue code. */
export const failure=code=>({error:code,message:toolMessage(code),retryable:isRetryable(code)});
/** A route that is registered but not built yet. */
export const unavailable=res=>res.status(503).json(failure('TEMPORARILY_UNAVAILABLE'));

// Review finding 5 (security): viem error messages carry the full transport URL, and BASE_RPC_URL may hold an API key
// in its path. Every Base error that reaches a log line, trades.last_error or trade_events goes through safeError:
// viem's shortMessage when present, any URL replaced, at most 120 characters.
const URL_RE=/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
export function safeError(e){
 const raw=e?.shortMessage??e?.message??(typeof e==='string'?e:e?.name)??'error';
 return String(raw).replace(URL_RE,'<url>').slice(0,120);
}

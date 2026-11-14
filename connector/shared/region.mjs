// The sanctions geoblock (YEET_GEOBLOCK). Ported from Folio's region gate (chaintail/stock-app
// apps/server/src/region.ts, regionVersion 2026-10-07): the same country list (its `app_blocked` default, FOLIO_REGION_APP_BLOCKED:
// CU, IR, KP, SY), the same reading of the country (Cloudflare's CF-IPCountry, two letters, `XX` and anything else
// that is not a country code is no country), the same answer (HTTP 451 with `REGION_BLOCKED` and the country), and the
// same rule that a request with no country is not blocked. Folio blocks new actions and keeps reads, sign-out and
// settlement of what was already sent; so does this: sign-in, consent, approval, the trade pages and the MCP tool
// calls that create an account or prepare or send a trade. Reading pages and status stays possible.
//
//   YEET_GEOBLOCK            on: the block is active. Unset, empty or off: no block (the default). Anything else stops the service.
//   YEET_GEOBLOCK_COUNTRIES  comma list of two-letter codes, replacing the default list. Unset: CU,IR,KP,SY. An entry
//                            that is not a code stops the service.
//
// The header is trusted only when the request came through our proxy: the same TRUST_PROXY=1 that makes the sign-in
// server trust X-Forwarded-For (as.mjs). Without it no country is read, so YEET_GEOBLOCK=on without TRUST_PROXY=1
// stops the service instead of silently blocking nothing.
export const REGION_BLOCKED='REGION_BLOCKED';
/** Folio's app_blocked default (stock-app apps/server/src/region.ts readRegionConfig). */
export const DEFAULT_BLOCKED=Object.freeze(['CU','IR','KP','SY']);

/** A two-letter country code, upper case, or null (Folio countryCode: `XX`, Tor's `T1` and junk are no country). */
export function countryCode(value){
 if(typeof value!=='string')return null;
 const code=value.trim().toUpperCase();
 return /^[A-Z]{2}$/.test(code)&&code!=='XX'?code:null;
}

/** {on, countries} from the environment; throws on a value the code does not know. */
export function readGeoblock(env=process.env){
 const v=env.YEET_GEOBLOCK;
 if(v!==undefined&&v!==''&&v!=='on'&&v!=='off')throw Error('Invalid YEET_GEOBLOCK');
 const on=v==='on';
 let countries=DEFAULT_BLOCKED;
 if(env.YEET_GEOBLOCK_COUNTRIES!==undefined&&env.YEET_GEOBLOCK_COUNTRIES!==''){
  const codes=env.YEET_GEOBLOCK_COUNTRIES.split(',').map(s=>s.trim()).filter(Boolean).map(countryCode);
  if(!codes.length||codes.some(c=>c===null))throw Error('Invalid YEET_GEOBLOCK_COUNTRIES');
  countries=Object.freeze([...new Set(codes)]);
 }
 const trustProxy=env.TRUST_PROXY==='1';
 if(on&&!trustProxy)throw Error('YEET_GEOBLOCK=on needs TRUST_PROXY=1');
 return Object.freeze({on,countries,trustProxy});
}

/** The request's country from CF-IPCountry, or null when untrusted or absent. */
export function requestCountry(headers,config){
 if(!config?.trustProxy||!headers)return null;
 const h=headers['cf-ipcountry'];
 return countryCode(Array.isArray(h)?h[0]:h);
}

/** The blocked country of this request, or null. */
export function blockedCountry(headers,config){
 if(!config?.on)return null;
 const c=requestCountry(headers,config);
 return c&&config.countries.includes(c)?c:null;
}

/**
 * The core routes behind MCP tool calls that create an account or prepare or send a trade, on both hosts.
 * ChatGPT: yeet_propose, skeet_propose, yeet_quote, execute_trade, submit_trade_signature. Agent: agent_register_key,
 * agent_quote, agent_prepare_trade, agent_submit_signature (except a budget return, request id `a_...`: like Folio's
 * settlement, funds going back to the person stay possible). Reads (overview, portfolio, status, coins) are not here.
 */
export function regionGatedRoute(route,body){
 if(typeof route!=='string'||body===undefined)return false;
 if(/^\/proposals(\/skeet|\/[^/]+\/quote)?$/.test(route))return true;
 if(/^\/trades(\/[^/]+\/signature)?$/.test(route))return true;
 if(route==='/agent/register'||route==='/agent/quote'||route==='/agent/prepare')return true;
 if(route==='/agent/submit')return !(typeof body?.request_id==='string'&&body.request_id.startsWith('a_'));
 return false;
}

/** The sign-in server's paths that are blocked: sign-in, consent, agent approval, the trade and funding pages and the
 * wallet set-up after sign-in. The terms page, sign-out, static files and the OAuth endpoints stay open. */
export function regionGatedPath(path){
 return path==='/account/login'||path==='/account/email-step'||path==='/account/wallets'
  ||path==='/approve'||path==='/agent/approve'
  ||/^\/interaction(\/|$)/.test(path)
  ||path==='/sign'||path.startsWith('/sign/api/')
  ||path==='/fund'||path.startsWith('/fund/api/');
}

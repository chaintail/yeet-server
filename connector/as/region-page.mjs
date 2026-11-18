// The sanctions geoblock on the sign-in server (shared/region.mjs, YEET_GEOBLOCK, off by default). A request from a
// blocked country to sign-in, consent, agent approval, the trade page, the funding page or the wallet set-up gets
// HTTP 451: a plain page for a browser, `{error: "REGION_BLOCKED", country}` for the pages' own JSON calls (the same
// answer as the region gate it is ported from, shared/region.mjs). The terms page, sign-out, static files and the OAuth endpoints are not touched.
import {log} from '#shared/log.mjs';
import {document,html} from './auth-pages.mjs';
import {readGeoblock,blockedCountry,regionGatedPath,REGION_BLOCKED} from '#shared/region.mjs';
export const REGION_TITLE='Not available in your region';
export const REGION_LINE='YEET is not available in your region. Sanctions law does not allow us to serve people or places under sanctions.';
export const REGION_TERMS_LINE='The YEET terms explain who can use YEET.';
const TERMS_LINK='https://yeet.win/terms#section-2a';
export const regionBody=()=>`<p class="lead">${html(REGION_LINE)}</p><p>${html(REGION_TERMS_LINE)} <a href="${TERMS_LINK}" target="_blank" rel="noopener">Read the terms</a></p>`;
const isJson=q=>q.path==='/account/wallets'||q.path==='/account/email-step'||q.path.startsWith('/sign/api/')||q.path.startsWith('/fund/api/');
/** Express middleware; `config` = readGeoblock(env). Installed before every page route. */
export function regionGate(config=readGeoblock()){
 return (q,r,next)=>{
  if(!config.on||!regionGatedPath(q.path))return next();
  const country=blockedCountry(q.headers,config);
  if(!country)return next();
  log.warn('region_blocked',{country,path:q.path});
  r.set('Cache-Control','no-store');
  if(isJson(q))return r.status(451).json({error:REGION_BLOCKED,country});
  return r.status(451).type('html').send(document(REGION_TITLE,regionBody()));
 };
}

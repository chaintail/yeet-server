// Where a person adds USDC: the /fund page (as/fund-page.mjs) on the sign-in server's public origin (ISSUER).
// The contract's https_url type only takes https links, so a local http origin yields no link and the result carries
// no fund_url (the card then shows no Add funds button) rather than failing the output check.
import {AS} from '#shared/common.mjs';

export const FUND_PATH='/fund';
/** <origin>/fund when the origin is a plain https origin; null otherwise. */
export function fundUrlFor(origin){
 try{
  const u=new URL(FUND_PATH,origin);
  return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=508?u.href:null;
 }catch{return null}
}
export const FUND_URL=fundUrlFor(AS);
/** The amounts the funding page offers as chips (login/fund-links.js AMOUNT_CHIPS; fund-link.test.mjs keeps them equal).
 * The page starts on one of them when its URL carries ?amount=. */
export const FUND_PRESETS=Object.freeze(['10','25','50','100']);
/** yeet_fund: the person's USDC as one number, the presets and the funding page (left out when it is not https). */
export const fundAnswer=(usdc,url=FUND_URL)=>({usdc,presets:[...FUND_PRESETS],...(url?{fund_url:url}:{})});
/** yeet_home: a needs_funds answer carries fund_url. */
export const homeWithFundUrl=(home,url=FUND_URL)=>url&&home?.ready==='needs_funds'?{...home,fund_url:url}:home;
/** A BALANCE_LOW refusal carries fund_url. */
export const failureWithFundUrl=(f,url=FUND_URL)=>url&&f?.error==='BALANCE_LOW'?{...f,fund_url:url}:f;

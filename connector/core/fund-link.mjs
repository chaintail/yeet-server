// Where a person adds USDC: the /fund page (as/fund-page.mjs) on the sign-in server's public origin (ISSUER).
// The contract's https_url type only takes https links, so a local http origin yields no link and the result carries
// no fund_url (the card then shows no Add funds button) rather than failing the output check.
import {AS} from '#shared/common.mjs';
import {withLinkToken} from '#shared/link-token.mjs';
import {totalUsdc} from './overview.mjs';

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
/** yeet_home as the connector answers it: no wallets and no address, the person's USDC as one number (both networks
 * added up when the engine read both). ChatGPT never reads an address: it could type one wrong. */
export function homeAnswer(home){
 if(!home||typeof home!=='object')return home;
 const {wallets,...rest}=home,f=home.funding;
 return {usdc:f?totalUsdc(f.base_usdc,f.solana_usdc):totalUsdc(wallets?.base?.usdc),...rest};
}
/** yeet_portfolio as the connector answers it: holdings and USDC, no address. */
export const portfolioAnswer=p=>p&&typeof p==='object'&&p.solana&&p.base?{...p,solana:{holdings:p.solana.holdings},base:{usdc:p.base.usdc}}:p;
const DEPOSIT=Object.freeze({sol:['solana',/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,w=>w?.solana?.address],base:['base',/^0x[0-9a-fA-F]{40}$/,w=>w?.base?.address]});
/** The Add funds card's addresses (card only: the connector moves `card_deposit` to `_meta["yeet/deposit"]`, the model
 * never reads it): the account's own addresses as the engine's wallet directory holds them (the record the funding
 * page's /fund/api/check answers from), for `chains` in their order (funding.deposits(): the first is the network a
 * first YEET spends from). An address that is not one of its network's is left out; none left: null. */
export function depositFor(wallets,chains=['sol','base']){
 const networks=[];
 for(const c of chains){const d=Object.hasOwn(DEPOSIT,c)?DEPOSIT[c]:null,a=d?.[2](wallets);if(d&&typeof a==='string'&&d[1].test(a)&&!networks.some(n=>n.network===d[0]))networks.push({network:d[0],address:a})}
 return networks.length?{default:networks[0].network,networks}:null;
}
/** yeet_home: a needs_funds answer carries fund_url. */
export const homeWithFundUrl=(home,url=FUND_URL)=>url&&home?.ready==='needs_funds'?{...home,fund_url:url}:home;
/** A BALANCE_LOW refusal carries fund_url. */
export const failureWithFundUrl=(f,url=FUND_URL)=>url&&f?.error==='BALANCE_LOW'?{...f,fund_url:url}:f;
/** The funding page link for ONE account: <fund_url>?h=<signed hint> (shared/link-token.mjs, account-login.mjs
 * hintFor). The page then shows only that account's sign-in methods and refuses any other account. No hint: null,
 * and the answer carries no fund_url. A funding link that names no account is never handed to ChatGPT. */
export const fundUrlWithHint=(hint,url=FUND_URL)=>url&&hint?withLinkToken(url,'h',hint):null;

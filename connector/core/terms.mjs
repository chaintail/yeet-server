// The YEET terms a person accepts once per version (docs/TERMS-IN-CHAT.md). EDIT HERE: the version and the statements.
//
// Structure copied from Folio's consent flow (chaintail/stock-app origin/main: apps/server/src/consent.ts and
// apps/android/.../ui/consent/ConsentText.kt): one version constant; a list of lines, each with the link to the
// document it refers to; the server holds the ids because "all of the required ones" is the gate; the first
// acceptance of a version stands; a new version is a new acceptance; one optional product-email line that is never
// ticked for the person.
//
// Changing TERMS_VERSION asks everyone again, the same way: every tool but yeet_overview and yeet_terms answers
// TERMS_REQUIRED until the person accepted the new version. Change it whenever a statement's meaning or a linked
// document changes.
import {AS} from '#shared/common.mjs';
export const TERMS_VERSION='2026-11-13';
export const TERMS_URL='https://yeet.win/terms';
export const PRIVACY_URL='https://yeet.win/privacy';

/** In order. `required: false` is a choice, not a condition. Every url is the exact document or section. */
export const STATEMENTS=Object.freeze([
 {id:'age',text:'You are at least 18 and allowed to use YEET where you live.',url:`${TERMS_URL}#section-2`,required:true},
 {id:'wallet',text:'You agree to a YEET wallet created and secured by Privy, which only you control.',url:'https://privy.io/user-terms-of-service',required:true},
 {id:'near_intents',text:'You understand your trades are routed through NEAR Intents.',url:`${TERMS_URL}#section-9`,required:true},
 {id:'risk',text:'You understand meme coins can go to zero and you can lose everything you put in.',url:`${TERMS_URL}#section-7`,required:true},
 {id:'no_advice',text:'You understand nothing in YEET or from ChatGPT is financial advice.',url:`${TERMS_URL}#section-4`,required:true},
 {id:'terms',text:'You agree to the YEET Terms and Conditions.',url:TERMS_URL,required:true},
 {id:'privacy',text:'You agree to the YEET Privacy Policy.',url:PRIVACY_URL,required:true},
 {id:'product_email',text:'Send me YEET product emails.',url:`${PRIVACY_URL}#section-3`,required:false},
].map(Object.freeze));
export const REQUIRED_IDS=Object.freeze(STATEMENTS.filter(s=>s.required).map(s=>s.id));
const KNOWN=new Set(STATEMENTS.map(s=>s.id));

/** Where the acceptance is recorded: `chat` (ChatGPT shows the statements and calls yeet_accept_terms) or `page` (the
 * person accepts on the YEET terms page). One switch: YEET_TERMS_MODE, default chat. */
export function termsMode(value=process.env.YEET_TERMS_MODE){
 if(value===undefined||value==='')return 'chat';
 if(value!=='chat'&&value!=='page')throw Error('Invalid YEET_TERMS_MODE');
 return value;
}
/** The first-party page with the same statements as checkboxes (as/terms-page.mjs), or null without an https AS. */
export function termsPageUrl(as=AS){
 try{const u=new URL(as);return u.protocol==='https:'?`${u.origin}/account/terms`:null}catch{return null}
}
/** The contract's `terms` object. record: the acceptance of the CURRENT version, or null. */
export function termsObject(record,{mode=termsMode(),pageUrl=termsPageUrl()}={}){
 return {
  accepted:!!record,version:TERMS_VERSION,accepted_at:record?new Date(record.accepted_at).toISOString().replace(/\.\d+Z$/,'Z'):null,
  statements:STATEMENTS.map(s=>({...s})),terms_url:TERMS_URL,privacy_url:PRIVACY_URL,
  // Without the page (no https sign-in origin) the chat is the only place.
  mode:mode==='page'&&pageUrl?'page':'chat',...(pageUrl?{page_url:pageUrl}:{}),
 };
}
/** Connector routes that answer without an acceptance: the overview (it carries the terms), the terms themselves and
 * the eligibility check. Every other connector route is refused with TERMS_REQUIRED (core.mjs). */
export const TERMS_OPEN=Object.freeze([['GET',/^\/overview$/],['GET',/^\/terms$/],['POST',/^\/terms\/accept$/],['GET',/^\/eligibility$/]]);
export const termsOpen=(method,path)=>TERMS_OPEN.some(([m,p])=>m===method&&p.test(path));
/** Checks one acceptance. Returns {ok:true, confirmed} (known ids only, in list order) or {ok:false, reason, missing}. */
export function checkAcceptance({version,confirmed}){
 if(version!==TERMS_VERSION)return {ok:false,reason:'version',missing:[...REQUIRED_IDS]};
 const given=new Set(Array.isArray(confirmed)?confirmed.filter(x=>typeof x==='string'):[]);
 const missing=REQUIRED_IDS.filter(id=>!given.has(id));
 if(missing.length)return {ok:false,reason:'missing',missing};
 return {ok:true,confirmed:STATEMENTS.map(s=>s.id).filter(id=>given.has(id)&&KNOWN.has(id))};
}

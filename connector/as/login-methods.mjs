// Which sign-in methods the YEET pages offer where no account-bound link says otherwise: the connect screen,
// /account/login and a trade, funding or terms page opened with no signed link. One setting, read when a page is
// served (a new value needs a restart of the sign-in server, never a rebuild of the sign-in bundle):
//
//   YEET_LOGIN_METHODS   comma list of google, apple, email. Default: google,apple.
//
// A method still appears only when the Privy app has it on (login/login-methods.js enabledMethods), so Apple shows up
// by itself once it is switched on there. `google,apple,email` is the behaviour before this setting existed.
//
// Why email is off by default: a person who comes in once with an emailed code and once with Google can end up
// with two YEET accounts and two wallets, and YEET never merges accounts or moves a login between them.
export const METHOD_IDS=Object.freeze(['google','apple','email']);
export const DEFAULT_LOGIN_METHODS=Object.freeze(['google','apple']);
/** The setting as a list in page order. Throws on an unknown name or an empty list (the server then does not start). */
export function loginMethods(value=process.env.YEET_LOGIN_METHODS){
 if(value===undefined||value==='')return [...DEFAULT_LOGIN_METHODS];
 const given=String(value).split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!given.length||given.some(m=>!METHOD_IDS.includes(m)))throw Error('Invalid YEET_LOGIN_METHODS');
 return METHOD_IDS.filter(m=>given.includes(m));
}
/** A list of method ids (a signed link's) cut to the known ones, in page order. */
export const knownMethods=list=>METHOD_IDS.filter(m=>Array.isArray(list)&&list.includes(m));

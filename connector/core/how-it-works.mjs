// yeet_how_it_works: security, wallet and private-key facts (owner, 2026-11-14). EDIT THE WORDING HERE. The shape is
// the public contract's ($defs.how_it_works); the words live only in this repository.
//
// Every sentence must stay true of the running system: YEET's server holds no key to a person's wallet,
// every trade is signed by the key owner or by an agent they authorized, YEET takes no fee. If one of those ever changes,
// this text changes in the same commit.
export const EXPORT_URL='https://home.privy.io/';
export const TERMS_CUSTODY_URL='https://yeet.win/terms#section-5a';
export const TERMS_BETA_URL='https://yeet.win/terms#section-7a';

/** In order. Each `id` is one of the contract's section ids. */
export const SECTIONS=Object.freeze([
 {id:'keys',title:'Who holds the keys',
  text:'Your YEET wallet is a Privy embedded wallet, and it is non-custodial. The private key belongs to you: it is secured by Privy and opened only by your own sign-in. YEET never holds it.',
  url:TERMS_CUSTODY_URL},
 {id:'server_can',title:'What the YEET server can do',
  text:'Read your public balances and holdings, find prices and coins, prepare a quote for a trade you asked for, follow a trade on the blockchain after you approved it, and keep your XP, streak and leaderboard name.'},
 {id:'server_cannot',title:'What the YEET server cannot do',
  text:'YEET\'s server holds no key to your wallet. It cannot move, spend, freeze or recover your funds, and it cannot send a trade by itself: every trade is signed by you or by an agent you authorized, from your own wallet. YEET takes no fee.'},
 {id:'wallet',title:'Your wallet',
  text:'YEET does not control your funds. Even so, do not deposit large sums: YEET is in beta and its code is not audited.',
  url:TERMS_BETA_URL},
 {id:'export',title:'Export your private key',
  text:'Go to home.privy.io and sign in with the same login you use for YEET. There you can export the private key of your YEET wallet and use it in another wallet.',
  url:EXPORT_URL},
 {id:'export_warning',title:'Before you export',
  text:'Exporting is an advanced feature. Anyone who has your private key controls your funds. Never share it, never paste it into a chat or a website, and keep it where only you can reach it.'},
 {id:'risk',title:'The risk',
  text:'Meme coin trading is extremely risky and coins can go to zero. Never trade more than you are willing to lose. *winning is not guaranteed.'},
].map(Object.freeze));

/** The contract's `how_it_works` object. */
export function howItWorks(){
 return {provider:'Privy',custody:'non_custodial',sections:SECTIONS.map(s=>({...s})),export_url:EXPORT_URL};
}

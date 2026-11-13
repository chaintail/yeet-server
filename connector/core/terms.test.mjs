// The YEET terms: the statements and their links, the acceptance check, the record (first one stands), a new version
// asks again, which connector routes stay open without an acceptance, and the win code record.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.STATE_DIR=mkdtempSync(path.join(tmpdir(),'yeet-terms-'));
const {TERMS_VERSION,STATEMENTS,REQUIRED_IDS,TERMS_URL,PRIVACY_URL,termsObject,checkAcceptance,termsMode,termsPageUrl,termsOpen}=await import('./terms.mjs');
const {acceptanceOf,recordAcceptance,referralOf,decideReferral,referralCode}=await import('./terms-store.mjs');
const {maskEmail,loginFacts,createAccountLogin,withCardAccount}=await import('./account-login.mjs');
const {contract,zodSchema}=await import('../mcp/tool-contract.mjs');
const {z}=await import('zod');
const A='yeet-privy-terms-a',B='yeet-privy-terms-b';

test('the statements: each has its own link to the exact document or section; all but the product emails are required',()=>{
 assert.equal(TERMS_VERSION,'2026-11-13');
 assert.deepEqual(STATEMENTS.map(s=>[s.id,s.text,s.url,s.required]),[
  ['age','You are at least 18 and allowed to use YEET where you live.','https://yeet.win/terms#section-2',true],
  ['wallet','You agree to a YEET wallet created and secured by Privy, which only you control.','https://privy.io/user-terms-of-service',true],
  ['near_intents','You understand your trades are routed through NEAR Intents.','https://yeet.win/terms#section-9',true],
  ['risk','You understand meme coins can go to zero and you can lose everything you put in.','https://yeet.win/terms#section-7',true],
  ['no_advice','You understand nothing in YEET or from ChatGPT is financial advice.','https://yeet.win/terms#section-4',true],
  ['terms','You agree to the YEET Terms and Conditions.','https://yeet.win/terms',true],
  ['privacy','You agree to the YEET Privacy Policy.','https://yeet.win/privacy',true],
  ['product_email','Send me YEET product emails.','https://yeet.win/privacy#section-3',false],
 ]);
 assert.deepEqual([...REQUIRED_IDS],['age','wallet','near_intents','risk','no_advice','terms','privacy']);
 // Owner wording rules: no tapping, nothing about the wallet's act.
 for(const s of STATEMENTS)assert.doesNotMatch(s.text,/\btap|\bsign(ing|ature)?\b|only when/i,s.id);
 const schema=zodSchema(z,contract.$defs.terms);
 for(const record of [null,{accepted_at:Date.parse('2026-11-13T10:00:00Z')}])assert.doesNotThrow(()=>schema.parse(termsObject(record,{mode:'chat',pageUrl:'https://chatgpt.yeet.win/account/terms'})));
 assert.equal(termsObject(null).terms_url,TERMS_URL);assert.equal(termsObject(null).privacy_url,PRIVACY_URL);
});

test('the anchors the statements link to exist in the landing pages (when the yeet-win checkout is next to this repo)',t=>{
 const page=name=>{try{return readFileSync(new URL(`../../../yeet-win-wt-int/apps/landing/${name}/index.html`,import.meta.url),'utf8')}catch{return null}};
 const terms=page('terms'),privacy=page('privacy');
 if(!terms||!privacy)return t.skip('no yeet-win checkout here');
 for(const s of STATEMENTS){
  const u=new URL(s.url);if(u.host!=='yeet.win'||!u.hash)continue;
  assert.ok((u.pathname.startsWith('/terms')?terms:privacy).includes(`id="${u.hash.slice(1)}"`),`${s.id}: ${s.url}`);
 }
});

test('one switch for where the acceptance happens: YEET_TERMS_MODE chat (default) or page; page needs the https page',()=>{
 assert.equal(termsMode(undefined),'chat');assert.equal(termsMode(''),'chat');assert.equal(termsMode('page'),'page');
 assert.throws(()=>termsMode('both'),/Invalid YEET_TERMS_MODE/);
 assert.equal(termsPageUrl('https://chatgpt.yeet.win'),'https://chatgpt.yeet.win/account/terms');assert.equal(termsPageUrl('http://127.0.0.1:1'),null);
 const page=termsObject(null,{mode:'page',pageUrl:'https://chatgpt.yeet.win/account/terms'});
 assert.equal(page.mode,'page');assert.equal(page.page_url,'https://chatgpt.yeet.win/account/terms');
 assert.equal(termsObject(null,{mode:'chat',pageUrl:'https://chatgpt.yeet.win/account/terms'}).page_url,'https://chatgpt.yeet.win/account/terms','the page URL rides along in chat mode too');
 assert.equal(termsObject(null,{mode:'page',pageUrl:null}).mode,'chat');
});

test('accepting: every required statement of the CURRENT version, or nothing is recorded',()=>{
 assert.deepEqual(checkAcceptance({version:TERMS_VERSION,confirmed:[...REQUIRED_IDS]}),{ok:true,confirmed:[...REQUIRED_IDS]});
 assert.deepEqual(checkAcceptance({version:TERMS_VERSION,confirmed:['product_email',...REQUIRED_IDS,'made_up']}).confirmed,[...REQUIRED_IDS,'product_email'],'the optional line is kept, unknown ids are dropped');
 // A missing statement is refused and named.
 assert.deepEqual(checkAcceptance({version:TERMS_VERSION,confirmed:REQUIRED_IDS.filter(id=>id!=='risk')}),{ok:false,reason:'missing',missing:['risk']});
 assert.equal(checkAcceptance({version:TERMS_VERSION,confirmed:[]}).ok,false);
 // An old (or any other) version is refused.
 assert.deepEqual(checkAcceptance({version:'2026-10-01',confirmed:[...REQUIRED_IDS]}),{ok:false,reason:'version',missing:[...REQUIRED_IDS]});
});

test('the record: account, version, statement ids, time, source, client and conversation; the first acceptance stands',()=>{
 assert.equal(acceptanceOf(A,TERMS_VERSION),null);assert.equal(termsObject(acceptanceOf(A,TERMS_VERSION)).accepted,false);
 const first=recordAcceptance({accountId:A,version:TERMS_VERSION,statements:[...REQUIRED_IDS],source:'chat',clientId:'https://chatgpt.com/oauth/client.json',session:'conv-1',now:1_000});
 assert.equal(first.fresh,true);
 assert.deepEqual(first.record,{account_id:A,version:TERMS_VERSION,statements:[...REQUIRED_IDS],accepted_at:1_000,source:'chat',client_id:'https://chatgpt.com/oauth/client.json',session:'conv-1'});
 const again=recordAcceptance({accountId:A,version:TERMS_VERSION,statements:['terms'],source:'page',now:9_000});
 assert.equal(again.fresh,false);assert.deepEqual(again.record,first.record,'a second acceptance changes nothing');
 const t=termsObject(acceptanceOf(A,TERMS_VERSION));assert.equal(t.accepted,true);assert.equal(t.accepted_at,'1970-01-01T00:00:01Z');
 assert.equal(acceptanceOf(B,TERMS_VERSION),null,'per account');
 assert.throws(()=>recordAcceptance({accountId:'nobody',version:TERMS_VERSION,statements:[],source:'chat'}),/Invalid account/);
});

test('a new version asks everyone again: an acceptance of another version does not count',()=>{
 recordAcceptance({accountId:B,version:'2026-10-01',statements:[...REQUIRED_IDS],source:'chat',now:5});
 assert.ok(acceptanceOf(B,'2026-10-01'));
 // What the core reads is always the acceptance of the CURRENT constant: after a bump the old row is not it.
 assert.equal(acceptanceOf(B,TERMS_VERSION),null);assert.equal(termsObject(acceptanceOf(B,TERMS_VERSION)).accepted,false);
 assert.equal(acceptanceOf(A,'2027-01-01'),null,'and an account that accepted today is asked again under a later version');
});

test('without an acceptance only the overview, the terms and the eligibility check answer; every other connector route is gated',()=>{
 for(const [m,p] of [['GET','/overview'],['GET','/terms'],['POST','/terms/accept'],['GET','/eligibility']])assert.equal(termsOpen(m,p),true,`${m} ${p}`);
 for(const [m,p] of [['GET','/home'],['GET','/coins'],['POST','/proposals'],['POST','/proposals/skeet'],['POST','/proposals/p_abcdefghij0123456789/quote'],['POST','/trades'],
  ['POST','/trades/t_abcdefghij0123456789/signature'],['GET','/trades/t_abcdefghij0123456789'],['GET','/portfolio'],['GET','/fund'],['GET','/leaderboard/xp'],['GET','/checkin'],['POST','/spin'],
  ['GET','/lucky'],['POST','/lucky/spin'],['POST','/username'],['GET','/referral'],['POST','/referral'],['POST','/overview'],['GET','/terms/accept']])assert.equal(termsOpen(m,p),false,`${m} ${p}`);
 // Every tool but the overview and the terms tools lists the refusal in the contract.
 for(const [name,t] of Object.entries(contract.tools))assert.equal(t.errors.includes('TERMS_REQUIRED'),!['yeet_overview','yeet_terms'].includes(name),name);
});

test('the win code: WIN to start with; applied once and it stands; a skip can still become a code; the old screen’s rule for codes',()=>{
 assert.deepEqual(referralOf(A),{status:'open',code:null,default_code:'WIN'});
 assert.equal(referralCode(' win '),'WIN');assert.equal(referralCode('abc123'),'ABC123');
 for(const bad of ['','not a code!','A'.repeat(17),null,7])assert.equal(referralCode(bad),null);
 assert.deepEqual(decideReferral(A,{skip:true}),{status:'skipped',code:null,default_code:'WIN'});
 assert.deepEqual(decideReferral(A,{code:'FRIEND'}),{status:'applied',code:'FRIEND',default_code:'WIN'});
 assert.deepEqual(decideReferral(A,{code:'OTHER'}),{status:'applied',code:'FRIEND',default_code:'WIN'},'one code per account');
 assert.deepEqual(decideReferral(A,{skip:true}),{status:'applied',code:'FRIEND',default_code:'WIN'});
 assert.deepEqual(referralOf(B),{status:'open',code:null,default_code:'WIN'});
});

test('the connected account for the device check: the code goes only to a linked email; Google and Apple accounts have none',async()=>{
 assert.equal(maskEmail('luke@chaintail.xyz'),'l•••@c•••.xyz');assert.equal(maskEmail('nope'),null);
 const email={id:'did:privy:e',linked_accounts:[{type:'email',address:'luke@chaintail.xyz'},{type:'wallet'}]};
 assert.deepEqual(loginFacts(email),{user:'did:privy:e',email:'luke@chaintail.xyz',masked:'l•••@c•••.xyz',google:false,apple:false});
 // A Google account's address is not a linked email account: no code can reach that user.
 assert.deepEqual(loginFacts({id:'did:privy:g',linked_accounts:[{type:'google_oauth',email:'luke@chaintail.xyz'}]}),{user:'did:privy:g',email:null,masked:null,google:true,apple:false});
 assert.equal(loginFacts({id:'did:privy:a',linked_accounts:[{type:'apple_oauth',email:'x@y.zz'}]}).apple,true);
 let calls=0;
 const lookup=createAccountLogin({api:{app:async(_m,p)=>{calls++;if(p.endsWith('did:privy:down'))throw Error('down');return email}}});
 assert.equal((await lookup('did:privy:e')).email,'luke@chaintail.xyz');await lookup('did:privy:e');assert.equal(calls,1,'cached');
 assert.equal(await lookup('did:privy:down'),null,'a failed read is no answer, never an error');
 assert.equal(await lookup('not-a-did'),null);
 assert.equal(await createAccountLogin({env:{}})('did:privy:e'),null,'no Privy credentials: no answer');
});

test('an account without an email login is read again after a minute, and at once when the page says it linked one; with one it stays 10 minutes',async()=>{
 const google={id:'did:privy:g',linked_accounts:[{type:'google_oauth',email:'gina@gmail.example'}]};
 const linked={id:'did:privy:g',linked_accounts:[{type:'email',address:'gina@gmail.example'},{type:'google_oauth',email:'gina@gmail.example'}]};
 let user=google,calls=0,t=0;
 const lookup=createAccountLogin({api:{app:async()=>{calls++;return user}},now:()=>t});
 assert.equal((await lookup('did:privy:g')).email,null);assert.equal((await lookup('did:privy:g')).google,true);assert.equal(calls,1,'cached');
 t=59_000;await lookup('did:privy:g');assert.equal(calls,1);
 // The person links an email on the YEET page: without the notice it is seen a minute later at most.
 user=linked;t=61_000;
 assert.equal((await lookup('did:privy:g')).email,'gina@gmail.example');assert.equal(calls,2);
 t=61_000+9*60_000;await lookup('did:privy:g');assert.equal(calls,2,'an account with an email login is kept for 10 minutes');
 // With the notice: at once.
 const told=createAccountLogin({api:{app:async()=>{calls++;return user}},now:()=>0});
 user=google;calls=0;
 assert.equal((await told('did:privy:g')).email,null);
 user=linked;told.forget('did:privy:g');
 assert.equal((await told('did:privy:g')).masked,'g•••@g•••.example');assert.equal(calls,2);
 told.forget('did:privy:unknown');
});

test('the basket answers carry the card-only account facts: the code for an email login, the YEET page for Google or Apple; no facts, no change',async()=>{
 const users={'did:privy:e':{id:'did:privy:e',linked_accounts:[{type:'email',address:'luke@chaintail.xyz'}]},'did:privy:g':{id:'did:privy:g',linked_accounts:[{type:'google_oauth',email:'gina@gmail.example'}]}};
 const lookup=createAccountLogin({api:{app:async(_m,p)=>{const u=users[p.split('/').at(-1)];if(!u)throw Error('down');return u}}});
 const dids={'yeet-privy-e':'did:privy:e','yeet-privy-g':'did:privy:g','yeet-privy-down':'did:privy:down','yeet-dev':null};
 const basket=withCardAccount({lookup:()=>lookup,didOf:ctx=>dids[ctx.accountId]});
 const proposal={proposal_id:'p_abcdefghij0123456789',revision:1,confirm:{code:'c'.repeat(43)}};
 const propose=basket(async(_e,_ctx,a)=>({...proposal,echo:a}));
 assert.deepEqual(await propose(null,{accountId:'yeet-privy-e'},{x:1}),{...proposal,echo:{x:1},card_account:{user:'did:privy:e',email:'luke@chaintail.xyz',masked:'l•••@c•••.xyz',google:false,apple:false,wallets:[]}});
 assert.deepEqual((await propose(null,{accountId:'yeet-privy-g'},{})).card_account,{user:'did:privy:g',email:null,masked:null,google:true,apple:false,wallets:[]});
 // Privy did not answer, or the account has no Privy user (development): the answer as it was, so the card keeps its own step.
 assert.deepEqual(await propose(null,{accountId:'yeet-privy-down'},{}),{...proposal,echo:{}});
 assert.deepEqual(await propose(null,{accountId:'yeet-dev'},{}),{...proposal,echo:{}});
 // A lookup that cannot even be made never fails the call; a refusal of the handler is passed on untouched.
 const broken=withCardAccount({lookup:()=>{throw Error('no client')},didOf:()=>'did:privy:e'});
 assert.deepEqual(await broken(async()=>proposal)(null,{accountId:'x'}),proposal);
 const refused=Object.assign(Error('BALANCE_LOW'),{name:'TradeError',code:'BALANCE_LOW'});
 await assert.rejects(basket(()=>{throw refused})(null,{accountId:'yeet-privy-e'}),e=>e===refused);
 await assert.rejects(basket(async()=>{throw refused})(null,{accountId:'yeet-privy-g'}),e=>e===refused);
});

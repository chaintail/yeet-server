// Lane E end to end: sign-in server, connector and core in this process (ports 38864-38867, throwaway state), YEET_P2=1.
// A real consented token goes home -> daily_spin -> yeet_leaderboard, and a settled trade shows its xp_award.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';

const ORIGIN='https://chatgpt.yeet.win';
const PORTS={AS_PORT:38864,CONNECTOR_PORT:38865,CORE_PORT:38866,ADMIN_PORT:38867};
const AS=`http://127.0.0.1:${PORTS.AS_PORT}`,CONNECTOR=`http://127.0.0.1:${PORTS.CONNECTOR_PORT}`;
const root=mkdtempSync(join(tmpdir(),'yeet-xp-e2e-'));
const secrets=join(root,'secrets'),state=join(root,'state');
mkdirSync(secrets);mkdirSync(state);
for(const name of ['core-introspection','introspection','core-as','core-mcp','core-operator','operator','csrf'])
 writeFileSync(join(secrets,name),randomBytes(32).toString('base64url'),{mode:0o600});
Object.assign(process.env,{
 ISSUER:ORIGIN,RESOURCE:ORIGIN,AS_INTERNAL:AS,CORE_INTERNAL:`http://127.0.0.1:${PORTS.CORE_PORT}`,
 STATE_DIR:state,SECRETS_DIR:secrets,LISTEN_HOST:'127.0.0.1',TEST_PROFILE:'1',DEV_IDENTITY_STUB:'1',ACCESS_TTL:'300',
 YEET_P2:'1',YEET_XP_SECRET:randomBytes(32).toString('base64url'),
 ...Object.fromEntries(Object.entries(PORTS).map(([k,v])=>[k,String(v)])),
});
for(const name of ['PUBLIC_MODE','PRIVY_LOGIN','MOCK_PASSWORD_LOGIN','PUBLIC_BASE_URL','COOKIE_SECURE','TRUST_PROXY'])delete process.env[name];
const core=await import('../core.mjs');
const as=await import('../../as/as.mjs');
const connector=await import('../../mcp/mcp.mjs');
const {configureTradeEngine,tradeEngine}=await import('../trade/runtime.mjs');
const {fakeRuntime,signAs}=await import('../pipeline/fakes.mjs');
const {USDC_SOLANA}=await import('../pipeline/solana/message.mjs');
const {handle}=await import('./board.mjs');
after(async()=>{
 configureTradeEngine({});
 for(const s of [connector.server,as.server,as.adminServer,core.server]){s.closeAllConnections();await new Promise(r=>s.close(r))}
 rmSync(root,{recursive:true,force:true});
});

// Tap on the connector's core calls: the last JSON body core answered, so a tool result can be compared with what the
// server actually sent (the connector's contract check must not drop a field: stamps, spin counts, lucky fields).
let lastCore=null;
const realFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 const r=await realFetch(url,init);
 if(String(url).startsWith(process.env.CORE_INTERNAL))lastCore=await r.clone().json().catch(()=>null);
 return r;
};
after(()=>{globalThis.fetch=realFetch});
/** Tools whose structuredContent must be exactly the core answer (the one-time confirm code goes to _meta only). */
const PASS_THROUGH=new Set(['yeet_home','daily_spin','lucky_wheel','lucky_spin','yeet_propose','execute_trade','submit_trade_signature','trade_status']);
const checked=new Set();
after(()=>{for(const n of PASS_THROUGH)assert.ok(checked.has(n),`no successful ${n} call was compared with core`)});

const SCOPES=['openid','offline_access','yeet:read','yeet:write','yeet:trade'];
const local=url=>{const u=new URL(url,ORIGIN);return u.origin===ORIGIN?`${AS}${u.pathname}${u.search}`:u.href};
function jar(){const c=new Map();return {header:()=>[...c].map(([k,v])=>`${k}=${v}`).join('; '),add(r){for(const s of r.headers.getSetCookie()){const p=s.split(';')[0],i=p.indexOf('=');c.set(p.slice(0,i),p.slice(i+1))}}}}
const rpc=(body,bearer)=>fetch(CONNECTOR+'/',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${bearer}`},body:JSON.stringify(body)});

async function signIn(did){
 const cookies=jar(),verifier=randomBytes(32).toString('base64url');
 const redirect='http://127.0.0.1:38314/callback';
 const auth=new URL(AS+'/auth');
 auth.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:redirect,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:SCOPES.join(' '),resource:ORIGIN,state:'s1'});
 const step=async(url,init={})=>{const r=await fetch(local(url),{redirect:'manual',...init,headers:{cookie:cookies.header(),...init.headers}});cookies.add(r);return r};
 const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 let r=await step(auth.href);let page=r.headers.get('location');let d=await (await step(page)).json();
 r=await step(page,form({csrf:d.csrf,identity_token:`DEV:${did}`}));r=await step(r.headers.get('location'));
 page=r.headers.get('location');d=await (await step(page)).json();assert.equal(d.prompt,'consent');
 r=await step(page,form({csrf:d.csrf,consent:'yes',agree_wallet:'yes',agree_chatgpt:'yes',agree_near:'yes',agree_terms:'yes',agree_privacy:'yes'}));d=await (await step(r.headers.get('location'))).json();assert.equal(d.prompt,'referral');
 r=await step(page,form({csrf:d.csrf,step:'referral',referral_action:'win',referral_code:'WIN'}));r=await step(r.headers.get('location'));
 const code=new URL(r.headers.get('location')).searchParams.get('code');
 const token=await (await fetch(AS+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirect,client_id:'local-chatgpt-fixture',resource:ORIGIN})})).json();
 assert.ok(token.access_token);
 const me=await (await fetch(AS+'/me',{headers:{authorization:`Bearer ${token.access_token}`}})).json();
 const call=async(name,args={})=>{
  lastCore=null;
  const result=(await (await rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},token.access_token)).json()).result;
  if(PASS_THROUGH.has(name)&&result&&!result.isError){
   const {confirm:_c,...sent}=lastCore??{};
   // The connector adds one field for the model, the agent guidance (mcp/guidance.mjs); everything else is core's.
   const {guidance,...rest}=result.structuredContent??{};
   assert.equal(typeof guidance,'string',`${name}: guidance for the model`);
   assert.deepEqual(rest,sent,`${name}: the tool result is every field core sent`);
   checked.add(name);
  }
  return result;
 };
 return {token:token.access_token,sub:me.sub,call};
}

test('YEET_P2=1: tools/list adds the leaderboard (model and card) and daily_spin (card only)',async()=>{
 const {token}=await signIn('did:privy:xp-lister');
 const {result:{tools}}=await (await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},token)).json();
 const names=tools.map(t=>t.name);
 for(const n of ['yeet_leaderboard','daily_spin'])assert.ok(names.includes(n),n);
 const spin=tools.find(t=>t.name==='daily_spin'),board=tools.find(t=>t.name==='yeet_leaderboard');
 assert.equal(spin._meta['openai/visibility'],'private');assert.deepEqual(spin._meta.ui.visibility,['app']);assert.equal(spin._meta['openai/widgetAccessible'],true);
 assert.equal(spin._meta['openai/outputTemplate'],'ui://yeet/home-v1.html');
 assert.equal(board._meta['openai/visibility'],undefined);assert.deepEqual(board._meta.ui.visibility,['model','app']);
 assert.equal(board._meta['openai/outputTemplate'],'ui://yeet/leaderboard-v1.html');
});

test('YEET_P2=1 end to end: home -> spin -> leaderboard, then a settled trade shows its xp_award',async()=>{
 const f=fakeRuntime();
 configureTradeEngine(f.overrides);
 const alice=await signIn('did:privy:xp-alice'),bob=await signIn('did:privy:xp-bob');

 // Sign-in paid 5 XP once today; the spin is open; no wins are invented.
 const home=await alice.call('yeet_home');
 assert.equal(home.isError,undefined,JSON.stringify(home.content));
 const {xpRuntime}=await import('./xp.mjs');
 const {wheel,stamps,...xpRest}=home.structuredContent.xp;
 assert.deepEqual(xpRest,{total:5,streak_days:1,spin_available:true,next_streak_milestone:{days:3,xp:25},spins_available:1,extra_spin_reason:null,sets_completed:0});
 // Nothing the server sends in xp is dropped by the connector's contract check (stamps, spin counts, wheel).
 assert.deepEqual(home.structuredContent.xp,xpRuntime().summary(alice.sub),'yeet_home.xp is the server summary, every field');
 assert.ok(Array.isArray(wheel)&&wheel.length>=2&&wheel.every(w=>typeof w.coin==='string'&&Number.isInteger(w.xp)),'xp.wheel reaches the card');
 assert.ok(wheel.every(w=>w.coin!=='SOL'),'every daily wheel slice is a meme coin');
 assert.ok(stamps.length===wheel.length&&stamps.every(c=>c.count===0&&c.coin!=='SOL'),'xp.stamps reaches the card');
 assert.deepEqual(home.structuredContent.recent_wins,[]);

 const spin=await alice.call('daily_spin');
 assert.equal(spin.isError,undefined,JSON.stringify(spin.content));
 const s=spin.structuredContent;
 // daily_spin carries every field the server sends (wheel, slice, stamp, stamps, spin counts and reasons): the tool
 // result equals the server's own repeat of the spin.
 const {guidance:spinGuidance,...spinRest}=s;
 assert.deepEqual(spinRest,xpRuntime().spin.spin(alice.sub),'daily_spin is the server result, every field');
 // The model reads the stamp and its count in the guidance too (second text block).
 assert.match(spinGuidance,new RegExp(`^Name the ${s.stamp.coin} stamp: 1 of 7 on their ${s.stamp.coin} card, plus ${s.xp_won} XP\\.`));
 assert.equal(spin.content[1].text,spinGuidance);
 for(const k of ['wheel','slice','stamp','set_bonus_xp','stamps','sets_completed','spin_kind','spin_reason','spins_available','extra_spin_reason'])assert.ok(k in s,k);
 assert.deepEqual(s.wheel,wheel,'xp.wheel before the spin is the wheel the spin used');
 assert.deepEqual(s.wheel[s.slice],{coin:s.stamp.coin,xp:s.draw_xp});
 assert.notEqual(s.stamp.coin,'SOL');
 assert.match(spin.content[0].text,new RegExp(`^You won ${s.xp_won} XP and a [A-Z]+ stamp \\(1 of 7\\)\\.$`));
 assert.ok(s.xp_won>=5&&s.xp_won<=5+40+25,String(s.xp_won));assert.equal(s.total,5+s.xp_won);assert.equal(s.streak_days,1);
 assert.equal(s.next_spin_at,new Date(Date.UTC(...(d=>[d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1])(new Date()))).toISOString());
 assert.deepEqual((await alice.call('daily_spin')).structuredContent,s,"YEET text.");
 assert.equal((await alice.call('yeet_home')).structuredContent.xp.spin_available,false);

 const board=await alice.call('yeet_leaderboard',{board:'xp'});
 assert.equal(board.isError,undefined,JSON.stringify(board.content));
 assert.deepEqual(board.structuredContent.me,{rank:1,xp:5+s.xp_won});
 const rows=board.structuredContent.rows;
 assert.deepEqual(rows.find(r=>r.name===handle(alice.sub)),{rank:1,name:handle(alice.sub),xp:5+s.xp_won});
 assert.ok(rows.some(r=>r.name===handle(bob.sub)&&r.xp===5));
 const text=JSON.stringify(board);
 for(const leak of [alice.sub,bob.sub,'did:privy','xp-alice','xp-bob'])assert.ok(!text.includes(leak),leak);
 const week=await bob.call('yeet_leaderboard',{board:'week'});
 assert.equal(week.structuredContent.me.xp,5);assert.ok(week.structuredContent.me.rank>1);
 assert.equal((await alice.call('yeet_leaderboard')).structuredContent.me.rank,1,'board defaults to all time');

 // A trade: no award while open, 70 XP once settled (first YEET 50 + YEET settled 20), the same on every read.
 const p=await alice.call('yeet_propose',{request_id:'xp-e2e-1',amount_usdc:'20',legs:[{symbol:'WIF',parts:6},{symbol:'BOME',parts:4}]});
 const x=await alice.call('execute_trade',{proposal_id:p.structuredContent.proposal_id,revision:1,confirm:p._meta['yeet/confirm'].code});
 assert.equal(x.structuredContent.status,'awaiting_signature');
 const id=x.structuredContent.trade_id;
 for(const r of x.structuredContent.sign_requests){
  const s=await alice.call('submit_trade_signature',{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(f.wallet,r)});
  assert.equal(s.isError,undefined,JSON.stringify(s.content));
 }
 assert.equal((await alice.call('trade_status',{trade_id:id})).structuredContent.xp_award,null);
 f.confirmSent();
 const engine=await tradeEngine();await engine.tracker.pollOnce();await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 const total=5+s.xp_won+70;
 for(let i=0;i<2;i++){
  const st=await alice.call('trade_status',{trade_id:id});
  assert.equal(st.isError,undefined,JSON.stringify(st.content));assert.equal(st.structuredContent.status,'success');
  assert.deepEqual(st.structuredContent.xp_award,{points:70,total});
 }
 assert.equal((await alice.call('yeet_home')).structuredContent.xp.total,total);

 // yeet_overview, the entry tool: the person in one answer, USDC as one number, no wallet or network, the follow-ups.
 const o=await alice.call('yeet_overview');
 assert.equal(o.isError,undefined,JSON.stringify(o.content));
 const ov=o.structuredContent;
 assert.equal(ov.username,handle(alice.sub));assert.equal(ov.xp,total);assert.equal(ov.streak_days,1);assert.equal(ov.checkin_open,false);
 assert.match(ov.usdc,/^[0-9]+(\.[0-9]+)?$/);assert.equal(ov.needs_card_sign_in,'unknown');assert.equal(ov.trading,'live');
 assert.equal(ov.tier,total>=69?'Winner':'Noob');
 assert.ok(ov.suggestions.length>=3&&ov.suggestions.every(s=>s.label&&s.say));assert.ok(!ov.suggestions.some(s=>s.id==='checkin'),'the check-in was done today');
 assert.equal(ov.suggestions.at(-1).id,'others');
 assert.match(ov.guidance,/^Welcome .+ in one short line/);assert.equal(o.content[1].text,ov.guidance);
 assert.match(o.content[0].text,new RegExp(`^${handle(alice.sub)}: [0-9.]+ USDC, ${total} XP \\((Noob|Winner)\\), 1-day streak`));
 assert.match(o.content[0].text,/Offer next: /);
 for(const leak of [alice.sub,'0x','Base','Solana','wallet'])assert.ok(!JSON.stringify([ov,o.content[0].text]).includes(leak),leak);
});

test('lucky wheel end to end: lucky_wheel -> lucky_spin -> YEET 5 USDC into the landed coin -> settled: claimed, one bonus spin',async()=>{
 const f=fakeRuntime();
 configureTradeEngine(f.overrides);
 const {xpRuntime}=await import('./xp.mjs');
 const gus=await signIn('did:privy:lucky-gus'),hal=await signIn('did:privy:lucky-hal');
 const err=r=>{assert.equal(r.isError,true);return JSON.parse(r.content[0].text).error};

 const w=await gus.call('lucky_wheel');
 assert.equal(w.isError,undefined,JSON.stringify(w.content));
 const L=w.structuredContent.lucky;
 assert.match(L.lucky_id,/^l_[a-z0-9]{8,40}$/);assert.equal(L.wheel.length,5);assert.equal(L.slice,null);assert.equal(L.claimed,false);assert.equal(L.amount_usdc,'5');
 assert.match(w.content[0].text,/^Today's lucky wheel: [A-Z0-9, ]+\. Spin it in the card\.$/);
 // Before the spin, a propose with the lucky_id is refused.
 assert.equal(err(await gus.call('yeet_propose',{request_id:'lucky-early',amount_usdc:'5',legs:[{symbol:L.wheel[0].coin,parts:1}],lucky_id:L.lucky_id})),'INVALID_ARGUMENT');

 const s=await gus.call('lucky_spin',{lucky_id:L.lucky_id});
 assert.equal(s.isError,undefined,JSON.stringify(s.content));
 const landed=s.structuredContent.lucky;assert.ok(Number.isInteger(landed.slice));
 const coin=landed.wheel[landed.slice].coin;
 assert.deepEqual((await gus.call('lucky_spin',{lucky_id:L.lucky_id})).structuredContent,s.structuredContent,'second lucky spin the same day: same coin');
 assert.equal(err(await hal.call('lucky_spin',{lucky_id:L.lucky_id})),'INVALID_ARGUMENT','someone else’s wheel');
 assert.equal(err(await hal.call('yeet_propose',{request_id:'lucky-hal',amount_usdc:'5',legs:[{symbol:coin,parts:1}],lucky_id:L.lucky_id})),'INVALID_ARGUMENT','propose with someone else’s lucky_id');

 // What the card sends: {request_id, amount_usdc: lucky.amount_usdc, legs: [{symbol: <landed coin>, parts: 1}], lucky_id}.
 const p=await gus.call('yeet_propose',{request_id:'lucky-1',amount_usdc:landed.amount_usdc,legs:[{symbol:coin,parts:1}],lucky_id:L.lucky_id});
 assert.equal(p.isError,undefined,JSON.stringify(p.content));
 // An idempotent retry returns the same proposal (and a fresh confirm code, which replaces the first).
 const retry=await gus.call('yeet_propose',{request_id:'lucky-1',amount_usdc:'5',legs:[{symbol:coin,parts:1}],lucky_id:L.lucky_id});
 assert.equal(retry.structuredContent.proposal_id,p.structuredContent.proposal_id,'idempotent retry');
 const x=await gus.call('execute_trade',{proposal_id:p.structuredContent.proposal_id,revision:1,confirm:retry._meta['yeet/confirm'].code});
 assert.equal(x.structuredContent?.status,'awaiting_signature',JSON.stringify(x.content));
 for(const r of x.structuredContent.sign_requests)assert.equal((await gus.call('submit_trade_signature',{trade_id:r.trade_id,leg:r.leg,attempt_id:r.attempt_id,signed:signAs(f.wallet,r)})).isError,undefined);
 assert.equal((await gus.call('lucky_wheel')).structuredContent.lucky.claimed,false,'not before it settles');
 f.confirmSent();
 const engine=await tradeEngine();await engine.tracker.pollOnce();await engine.tracker.pollOnce();await engine.tracker.pollOnce();
 await new Promise(r=>setImmediate(r));
 // The tracker's settle event claimed it (before any trade_status read).
 assert.equal(xpRuntime().lucky.get(gus.sub,L.lucky_id).lucky.claimed,true);
 const st=await gus.call('trade_status',{trade_id:x.structuredContent.trade_id});
 assert.equal(st.structuredContent.status,'success');
 const after=await gus.call('lucky_wheel');
 assert.equal(after.structuredContent.lucky.claimed,true);assert.equal(after.content[0].text,'Lucky wheel claimed: your bonus spin is ready in the card.');
 const grants=xpRuntime().ledger.db.prepare("SELECT reason,unique_ref FROM xp_spin_grant WHERE identity_id=? AND reason='trade_bonus'").all(gus.sub).map(r=>({...r}));
 assert.deepEqual(grants,[{reason:'trade_bonus',unique_ref:L.lucky_id}],'one grant per lucky_id after settle event + trade_status');
 assert.equal(xpRuntime().spin.stamps.list(gus.sub).find(c=>c.coin===coin).count,1,'a stamp of the landed coin');
 // The bonus spin is an ordinary extra spin through daily_spin: the daily spin, then the bonus, then nothing left.
 assert.equal(xpRuntime().summary(gus.sub).spins_available,2);
 await gus.call('daily_spin');
 assert.equal(xpRuntime().summary(gus.sub).extra_spin_reason,'trade_bonus');
 const bonus=await gus.call('daily_spin');assert.equal(bonus.isError,undefined);
 assert.equal(xpRuntime().summary(gus.sub).spins_available,0);
});

test('yeet_home: needs_funds carries fund_url on the public origin; a funded wallet carries none',async()=>{
 // BUY pays with USDC on Solana: the funding check reads the Solana USDC holding.
 const f=fakeRuntime({usdc:'0.5',holdings:[{mint:USDC_SOLANA,raw:500_000n,decimals:6}]}),{balances}=f;
 configureTradeEngine(f.overrides);
 const carol=await signIn('did:privy:fund-carol');
 const low=await carol.call('yeet_home');
 assert.equal(low.isError,undefined,JSON.stringify(low.content));
 assert.equal(low.structuredContent.ready,'needs_funds');
 assert.equal(low.structuredContent.fund_url,`${ORIGIN}/fund`);
 assert.equal(low.structuredContent.xp.next_streak_milestone.days,3);
 balances.holdings=[{mint:USDC_SOLANA,raw:100_000_000n,decimals:6}];
 const ok=await carol.call('yeet_home');
 assert.equal(ok.structuredContent.ready,'ready');
 assert.equal('fund_url' in ok.structuredContent,false);
});

test('username: set by the connector route or the account page, unique ignoring case, shown on the leaderboard',async()=>{
 const dana=await signIn('did:privy:name-dana'),eli=await signIn('did:privy:name-eli');
 const coreSecret=readFileSync(join(secrets,'core-mcp'),'utf8');
 // What the connector sends for yeet_set_username (tool-registration.mjs ROUTES), with the person's own token.
 const setName=(who,username)=>fetch(process.env.CORE_INTERNAL+'/username',{method:'POST',headers:{authorization:`Bearer ${coreSecret}`,'x-delegated-bearer':who.token,'content-type':'application/json'},body:JSON.stringify({username})});
 let r=await setName(dana,'@Dana_Wins');assert.equal(r.status,200);assert.deepEqual(await r.json(),{username:'Dana_Wins'});
 r=await setName(eli,'dana_WINS');assert.equal(r.status,409);assert.equal((await r.json()).error,'USERNAME_TAKEN');
 r=await setName(eli,'Admin');assert.equal(r.status,400);assert.equal((await r.json()).error,'USERNAME_NOT_ALLOWED');
 r=await setName(eli,'no spaces');assert.equal(r.status,400);assert.equal((await r.json()).error,'INVALID_ARGUMENT');
 const board=(await dana.call('yeet_leaderboard',{board:'xp'})).structuredContent.rows;
 assert.ok(board.some(row=>row.name==='Dana_Wins'),JSON.stringify(board));
 assert.ok(!board.some(row=>row.name===handle(dana.sub)),'the default name is gone');
 assert.ok(board.some(row=>row.name===handle(eli.sub)),'no username: default name');

 // The account page: sign in on the sign-in server, read the page, post the field.
 const c=jar();
 const step=async(path,init={})=>{const res=await fetch(AS+path,{redirect:'manual',...init,headers:{cookie:c.header(),...init.headers}});c.add(res);return res};
 const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN},body:new URLSearchParams(body)});
 await step('/account/login');
 const login=c.header().match(/yeet_login=([0-9a-f]+)/)[1];
 r=await step('/account/login',form({csrf:login,identity_token:'DEV:did:privy:name-eli'}));assert.equal(r.status,302);
 let page=await (await step('/account/')).text();
 assert.match(page,/<title>Your YEET account<\/title>/);
 assert.ok(page.includes(handle(eli.sub)),'shows the current board name');
 const csrf=page.match(/name="csrf" value="([0-9a-f]+)"/)[1];
 r=await step('/account/username',form({csrf:'wrong',username:'Eli_Moon'}));assert.equal(r.status,403);
 r=await step('/account/username',form({csrf,username:'DANA_WINS'}));assert.equal(r.status,409);
 assert.match(await r.text(),/That username is taken/);
 r=await step('/account/username',form({csrf,username:'Eli_Moon'}));assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/account/?username=saved');
 page=await (await step('/account/?username=saved')).text();
 assert.match(page,/Username saved/);assert.match(page,/value="Eli_Moon"/);
 const after=(await eli.call('yeet_leaderboard',{board:'xp'})).structuredContent.rows;
 assert.ok(after.some(row=>row.name==='Eli_Moon')&&after.some(row=>row.name==='Dana_Wins'),JSON.stringify(after));
});

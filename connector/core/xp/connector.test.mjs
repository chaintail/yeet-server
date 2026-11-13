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
 const call=async(name,args={})=>(await (await rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},token.access_token)).json()).result;
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
 assert.deepEqual(home.structuredContent.xp,{total:5,streak_days:1,spin_available:true,next_streak_milestone:{days:3,xp:25}});
 assert.deepEqual(home.structuredContent.recent_wins,[]);

 const spin=await alice.call('daily_spin');
 assert.equal(spin.isError,undefined,JSON.stringify(spin.content));
 const s=spin.structuredContent;
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

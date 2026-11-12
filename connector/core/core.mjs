import {initializeIdentityStore,resolveIdentity,account} from './identity-store.mjs';
import express from 'express';
import {introspectBearer,validatePrincipal} from '#shared/introspection.mjs';
import {secret,equal,read,write,port,TEST,DEV_APP_ID} from '#shared/common.mjs';
import {coins} from './coins.mjs';
import {unavailable} from './failure.mjs';
// Accounts are created on the first verified sign-in (identity-store.mjs). The identity app is Privy in
// production and the development stub only under TEST_PROFILE=1 with DEV_IDENTITY_STUB=1.
const devStub=TEST&&process.env.DEV_IDENTITY_STUB==='1';
if(process.env.PRIVY_LOGIN==='1'&&devStub)throw Error('Identity modes must be separate');
if(process.env.PRIVY_LOGIN!=='1'&&!devStub)throw Error('No identity verifier configured');
initializeIdentityStore({app:process.env.PRIVY_LOGIN==='1'?process.env.PRIVY_APP_ID:DEV_APP_ID});
const user=id=>account(id);
const app=express();app.use(express.json({limit:'32kb'}));
app.get('/health',(_q,r)=>r.json({ok:true}));
app.use((q,r,next)=>{const token=q.headers.authorization?.replace(/^Bearer /,'');q.role=['mcp','as','operator'].find(role=>equal(token,secret(`core-${role}`)));if(!q.role)return r.sendStatus(401);next()});
app.post('/identity/resolve',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const id=resolveIdentity(q.body);if(!id||read('policy.json')[id]?.suspended)return r.sendStatus(403);r.json({id})});
app.post('/policy',(q,r)=>{if(q.role!=='operator')return r.sendStatus(403);const {account,client,suspended,disconnect,reconnect}=q.body;if(!user(account))return r.sendStatus(400);const p=read('policy.json');const row=p[account]||{clients:{}};if(typeof suspended==='boolean')row.suspended=suspended;if(disconnect||reconnect){if(typeof client!=='string'||!client)return r.sendStatus(400);row.clients[client]=!!disconnect}p[account]=row;write('policy.json',p);r.json({ok:true})});
app.get('/policy',(q,r)=>{if(q.role!=='as')return r.sendStatus(403);const subject=q.headers['x-yeet-subject'];const exists=!!user(subject);r.json({...read('policy.json')[subject],exists,eligible:exists})});
app.use(async(q,r,next)=>{if(Object.keys(q.query).length)return r.sendStatus(400);if(q.role==='operator')return r.sendStatus(403);let subject,client;if(q.role==='mcp'){try{q.principal=validatePrincipal(await introspectBearer(q.headers['x-delegated-bearer'],'core-resource','core-introspection'));subject=q.principal.subject;client=q.principal.client}catch{return r.sendStatus(401)}}else subject=q.headers['x-yeet-subject'];if(!user(subject))return r.sendStatus(400);q.subject=subject;const p=read('policy.json')[subject];if(p?.suspended||q.role==='mcp'&&p?.clients?.[client])return r.sendStatus(403);next()});
app.get('/eligibility',(q,r)=>q.role==='mcp'?r.json({ok:true}):r.sendStatus(403));
/** Scope each connector route needs; a route not listed here is refused for the connector. */
export const ROUTE_SCOPES=Object.freeze([
 ['GET',/^\/home$/,'yeet:read'],
 ['GET',/^\/coins$/,'yeet:read'],
 ['POST',/^\/proposals$/,'yeet:write'],
 ['POST',/^\/proposals\/p_[a-z0-9]{20}\/quote$/,'yeet:write'],
 ['POST',/^\/trades$/,'yeet:trade'],
 ['GET',/^\/trades\/t_[a-z0-9]{20}$/,'yeet:read'],
 ['GET',/^\/portfolio$/,'yeet:read'],
 ['GET',/^\/leaderboard$/,'yeet:read'],
 ['POST',/^\/spin$/,'yeet:write'],
]);
export const routeScope=(method,path)=>ROUTE_SCOPES.find(([m,p])=>m===method&&p.test(path))?.[2]??null;
app.use((q,r,next)=>{if(q.role==='mcp'){const needed=routeScope(q.method,q.path);if(!needed||!q.principal.scopes.has(needed))return r.sendStatus(403)}next()});
app.get('/coins',(_q,r)=>r.json(coins()));
// Trade engine, XP and portfolio arrive in lanes B and E; until then each answers a typed retryable failure.
for(const [method,path] of [['get','/home'],['post','/proposals'],['post','/proposals/:id/quote'],['post','/trades'],['get','/trades/:id'],['get','/portfolio'],['get','/leaderboard'],['post','/spin']])
 app[method](path,(_q,r)=>unavailable(r));
app.use((_e,_q,r,_n)=>r.status(400).json({error:'invalid request'}));
export const server=app.listen(port('CORE_PORT',38316),process.env.LISTEN_HOST||'0.0.0.0');

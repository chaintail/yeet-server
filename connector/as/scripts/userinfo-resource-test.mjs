import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Provider from 'oidc-provider';
import {allScopes,baseScopes} from '../../scope-catalog.mjs';
import {resourceUserinfo} from '../userinfo.mjs';

// Retry 4-6 (2026-10-29): every ChatGPT connection got a token, then GET /me answered
// 403 insufficient_scope and ChatGPT showed "Reauthentication required". Folio access tokens
// are bound to RESOURCE (aud set, openid not in the token scope), which oidc-provider's own
// userinfo always rejects, so /me must accept the resource-bound token on the grant's openid.
const RESOURCE='https://chatgpt.tryfolio.io';
const CLIENT='https://chatgpt.com/oauth/client.json';
const provider=new Provider('https://as.test',{
 scopes:['openid','offline_access',...allScopes],
 clients:[{client_id:CLIENT,redirect_uris:['https://chatgpt.com/cb'],token_endpoint_auth_method:'none'}],
 features:{resourceIndicators:{enabled:true,defaultResource:()=>RESOURCE,useGrantedResource:()=>true,
  getResourceServerInfo:()=>({scope:allScopes.join(' '),audience:RESOURCE,accessTokenFormat:'opaque'})}},
});
async function mint({openid=true,account='folio-privy-alice',audience=RESOURCE,ttl,grantExpired=false}={}){
 const client=await provider.Client.find(CLIENT);
 const grant=new provider.Grant({accountId:account,clientId:CLIENT});
 if(openid)grant.addOIDCScope('openid');
 grant.addResourceScope(RESOURCE,baseScopes.join(' '));
 if(grantExpired)grant.exp=Math.floor(Date.now()/1000)-10;
 const grantId=await grant.save();
 const token=new provider.AccessToken({accountId:account,client,grantId,scope:baseScopes.join(' '),
  resourceServer:new provider.ResourceServer(audience,{audience,scope:allScopes.join(' '),accessTokenFormat:'opaque'})});
 if(ttl!==undefined)token.expiresIn=ttl;
 return {value:await token.save(),grantId};
}
function call(handler,authorization,method='GET'){
 return new Promise((resolve,reject)=>{
  const res={headers:{},statusCode:200,set(k,v){this.headers[k.toLowerCase()]=v;return this},
   status(c){this.statusCode=c;return this},json(body){resolve({status:this.statusCode,headers:this.headers,body})}};
  Promise.resolve(handler({method,headers:authorization?{authorization}:{}},res,()=>resolve({next:true}))).catch(reject);
 });
}
// Records which lookups ran, so a refusal can be pinned to the check that made it.
const deletedClients=new Set();
let seen=[];
const handler=resourceUserinfo({
 resource:RESOURCE,
 findAccessToken:v=>provider.AccessToken.find(v),
 findGrant:id=>{seen.push('grant');return provider.Grant.find(id)},
 findClient:async id=>{seen.push('client');return deletedClients.has(id)?undefined:provider.Client.find(id)},
 findAccount:async(id,token)=>{seen.push('account');return id.startsWith('folio-privy-')&&token.clientId===CLIENT?{accountId:id}:undefined},
});
const bearer=t=>`Bearer ${t.value}`;
function assertInvalid(out){
 assert.equal(out.status,401);
 assert.equal(out.body.error,'invalid_token');
 assert.match(out.headers['www-authenticate'],/^Bearer error="invalid_token"$/);
 assert.equal(out.headers['cache-control'],'no-store');
}
async function retarget(grantId,change){
 const grant=await provider.Grant.find(grantId);
 Object.assign(grant,change);
 await grant.save();
}

test('root cause: a resource-bound access token never carries openid or an empty aud',async()=>{
 const token=await provider.AccessToken.find((await mint()).value);
 assert.equal(token.aud,RESOURCE);
 assert.equal(token.scopes.has('openid'),false);
});

test('/me answers sub for a resource-bound token whose grant consented to openid',async()=>{
 for(const method of ['GET','POST']){
  const out=await call(handler,bearer(await mint()),method);
  assert.equal(out.status,200);
  assert.deepEqual(out.body,{sub:'folio-privy-alice'});
  assert.equal(out.headers['cache-control'],'no-store');
 }
});

test('/me refuses a resource-bound token whose grant lacks openid',async()=>{
 const out=await call(handler,bearer(await mint({openid:false})));
 assert.equal(out.status,403);
 assert.equal(out.body.error,'insufficient_scope');
 assert.equal(out.headers['www-authenticate'],'Bearer error="insufficient_scope", scope="openid"');
 assert.equal(out.headers['cache-control'],'no-store');
});

test('/me refuses unknown, malformed and expired tokens',async()=>{
 for(const auth of ['Bearer not-a-token','Basic eA==',bearer(await mint({ttl:-10}))])assertInvalid(await call(handler,auth));
});

test('/me refuses an ineligible account at the account check',async()=>{
 seen=[];
 assertInvalid(await call(handler,bearer(await mint({account:'mallory'}))));
 assert.deepEqual(seen,['grant','client','account']);
});

test('/me refuses a token whose grant was destroyed',async()=>{
 const t=await mint();
 await (await provider.Grant.find(t.grantId)).destroy();
 seen=[];
 assertInvalid(await call(handler,bearer(t)));
 assert.deepEqual(seen,['grant']);
});

test('/me refuses a token whose grant belongs to another client',async()=>{
 const t=await mint();
 await retarget(t.grantId,{clientId:'https://other.example/client.json'});
 seen=[];
 assertInvalid(await call(handler,bearer(t)));
 assert.deepEqual(seen,['grant']);
});

test('/me refuses a token whose grant belongs to another account',async()=>{
 const t=await mint();
 await retarget(t.grantId,{accountId:'folio-privy-bob'});
 seen=[];
 assertInvalid(await call(handler,bearer(t)));
 assert.deepEqual(seen,['grant']);
});

test('/me refuses a token whose grant has expired',async()=>{
 const t=await mint({grantExpired:true});
 assert.equal((await provider.Grant.find(t.grantId)).isExpired,true,'adapter still returns the expired grant');
 seen=[];
 assertInvalid(await call(handler,bearer(t)));
 assert.deepEqual(seen,['grant']);
});

test('/me refuses a token whose client was deleted',async()=>{
 const t=await mint();
 deletedClients.add(CLIENT);
 try{
  seen=[];
  assertInvalid(await call(handler,bearer(t)));
  assert.deepEqual(seen,['grant','client']);
 }finally{deletedClients.delete(CLIENT)}
});

test('/me leaves other methods, audiences and non-header requests to oidc-provider',async()=>{
 assert.deepEqual(await call(handler,undefined),{next:true});
 const t=await mint();
 for(const method of ['PUT','DELETE','OPTIONS'])assert.deepEqual(await call(handler,bearer(t),method),{next:true});
 const other=await mint({audience:'https://other.example/mcp'});
 assert.deepEqual(await call(handler,bearer(other)),{next:true});
});

test('as.mjs mounts the resource userinfo before provider.callback with a client lookup',()=>{
 const source=readFileSync(new URL('../as.mjs',import.meta.url),'utf8');
 const mount=source.search(/app\.(get|all|use)\(\s*["']\/me["'][^)]*resourceUserinfo\(/);
 assert.ok(mount>0,'resourceUserinfo is not mounted on /me');
 assert.ok(mount<source.indexOf('app.use(provider.callback())'));
 assert.match(source.slice(mount,mount+600),/findClient: \(id\) => provider\.Client\.find\(id\)/);
});

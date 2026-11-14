// The agent route switched off (the default): the connector answers the agent host with 404 and the ChatGPT endpoint
// exactly as before. Connector only, on 127.0.0.1:38882; no secrets are read by these requests.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';

const ORIGIN='https://chatgpt.yeet.win';
Object.assign(process.env,{ISSUER:ORIGIN,RESOURCE:ORIGIN,LISTEN_HOST:'127.0.0.1',CONNECTOR_PORT:'38882',TEST_PROFILE:'1'});
for(const name of ['YEET_AGENT_ROUTE','AGENT_RESOURCE','PUBLIC_MODE'])delete process.env[name];
const connector=await import('../mcp/mcp.mjs');
after(async()=>{connector.server.closeAllConnections();await new Promise(r=>connector.server.close(r))});
const get=(host,path,method='GET')=>new Promise((resolve,reject)=>{const q=request({host:'127.0.0.1',port:38882,path,method,headers:{host,'content-type':'application/json'}},r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>resolve({status:r.statusCode,text:t}))});q.on('error',reject);q.end(method==='POST'?'{}':undefined)});

test('off: the agent host is 404 on every path; the ChatGPT endpoint is unchanged',async()=>{
 for(const [path,method] of [['/','POST'],['/.well-known/oauth-protected-resource','GET'],['/version','GET']])
  assert.equal((await get('mcp.yeet.win',path,method)).status,404,path);
 const prm=await get(new URL(ORIGIN).host,'/.well-known/oauth-protected-resource');
 assert.equal(prm.status,200);assert.equal(JSON.parse(prm.text).resource,ORIGIN);
 assert.equal((await get(new URL(ORIGIN).host,'/','POST')).status,401);
});

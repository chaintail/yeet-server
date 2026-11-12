import assert from 'node:assert/strict';
import http from 'node:http';
function request(url,headers){return new Promise((resolve,reject)=>{http.get(url,{headers},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{const h=new Headers();for(let i=0;i<r.rawHeaders.length;i+=2)h.append(r.rawHeaders[i],r.rawHeaders[i+1]);resolve(new Response(Buffer.concat(chunks),{status:r.statusCode,headers:h}))})}).on('error',reject)})}

// In-image only: run as `node shared/scripts/public-check.mjs as|mcp` from /app/current, which mirrors current/.
const role=process.argv[2];if(!['as','mcp'].includes(role))throw Error('Bad role');await import(`../../${role}/${role}.mjs`);
const port=role==='as'?38312:38313;const canonical=new URL(role==='as'?process.env.ISSUER:process.env.RESOURCE);const path=role==='as'?'/.well-known/oauth-authorization-server':'/.well-known/oauth-protected-resource/mcp';
assert.equal((await request(`http://127.0.0.1:${port}${path}`,{host:'attacker.example'})).status,421);
assert.equal((await request(`http://127.0.0.1:${port}${path}`,{host:canonical.host,'x-forwarded-proto':'https'})).status,200);
if(role==='as'){const page=await request('http://127.0.0.1:38312/demo/login',{host:canonical.host,'x-forwarded-proto':'https'});assert.match(page.headers.getSetCookie().join(';'),/Secure/);assert.match(page.headers.getSetCookie().join(';'),/HttpOnly/);const metadata=await(await request('http://127.0.0.1:38312/.well-known/oauth-authorization-server',{host:canonical.host,'x-forwarded-proto':'https'})).json();assert.equal(metadata.issuer,process.env.ISSUER);const q=new URL('http://127.0.0.1:38312/auth');q.search=new URLSearchParams({client_id:'local-chatgpt-fixture',response_type:'code',redirect_uri:'http://127.0.0.1:38314/callback',code_challenge:'x'.repeat(43),code_challenge_method:'S256',scope:'folio:profile:read',resource:process.env.RESOURCE});const r=await request(q,{host:canonical.host,'x-forwarded-proto':'https'});assert.notEqual(r.status,302);assert.equal(r.status,400)}
console.log(`PASS public-${role} exact Host/canonical metadata${role==='as'?' Secure cookie; local fixture disabled':''}`);process.exit(0);

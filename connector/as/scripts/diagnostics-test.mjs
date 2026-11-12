import assert from 'node:assert/strict';
process.env.REFRESH_DIAGNOSTICS='1';
const events=[];const original=console.info;console.info=value=>events.push(JSON.parse(value));
const {observeAuthorization,observeAccepted,observeToken,diagnostic,safeServerError}=await import('../diagnostics.mjs');
// A frame in the shared module tree is kept as shared/<name>.mjs:<line>, the same name it has under /app in the image.
{const {secret:readSecret}=await import('#shared/common.mjs');let thrown;try{readSecret('diagnostics-test-missing-'+process.pid)}catch(e){thrown=e}
 const safe=safeServerError(thrown);const frame=safe.frames.find(f=>f.file==='shared/common.mjs');
 assert.ok(frame&&Number.isInteger(frame.line)&&frame.line>0,JSON.stringify(safe));assert.ok(!JSON.stringify(safe).includes('diagnostics-test-missing'));}
const secret='must-not-be-logged';
observeAuthorization({query:{client_id:'https://example/'+secret,scope:'openid offline_access '+secret,prompt:'consent '+secret,response_type:'code',resource:'https://resource.example/',code:secret,state:secret}},'https://resource.example/');
observeAccepted({params:{scope:'openid '+secret}},{grantTypeAllowed:()=>true,tokenEndpointAuthMethod:'private_key_jwt'});
observeToken({body:{access_token:secret,refresh_token:secret,expires_in:300},status:200,oidc:{params:{grant_type:'authorization_code',code:secret}}});
assert.ok(!JSON.stringify(events).includes(secret));assert.deepEqual(events[0].scopes,['openid','offline_access']);assert.equal(events[2].refresh_token_present,true);
for(let i=0;i<250;i++)diagnostic('oauth_token_result',{access_token_present:true,unexpected:secret});assert.equal(events.length,200);process.env.REFRESH_DIAGNOSTICS='0';diagnostic('oauth_token_result');assert.equal(events.length,200);console.info=original;console.log('PASS whitelisted secret-free bounded opt-in diagnostics');

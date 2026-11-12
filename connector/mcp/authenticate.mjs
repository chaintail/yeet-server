/** Network uncertainty is not evidence of revocation. Keep those outcomes distinct. */
export async function authenticate(bearer,{introspect,validate}) {
 if(!bearer)return {status:401,error:'invalid_token'};
 let token;
 try{token=await introspect(bearer)}catch{return {status:503,error:'temporarily_unavailable'}}
 try{validate(token)}catch{return {status:401,error:'invalid_token'}}
 return {token};
}

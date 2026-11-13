// Operator tools for the user-signed path (design section 4): the test wallet file, ops/user-signed-trade.mjs (dry by
// default, broadcast only with the live flags) and the Folio fee-payer bootstrap. Nothing here touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,statSync,chmodSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {evmAddress,createTestWalletFile,loadTestWallet} from './test-wallet.mjs';
import {parseArgs,coinSymbol,assertBroadcastAllowed,runUserSignedTrade,OPERATOR_ACCOUNT} from './operator-trade.mjs';
import {bootstrapFeePayer,bootstrapBody,policyHash} from './solana/fee-payer-bootstrap.mjs';
import {fakeFeePayer,fakeSolanaRpc,aliceWallet,WIF_MINT} from './fakes.mjs';
import {fakeOneClick,fakeBalances,BASE_WALLET} from '../trade/fakes.mjs';
import {USDC_SOLANA} from './solana/message.mjs';

const dir=mkdtempSync(join(tmpdir(),'yeet-optools-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));

test('evmAddress: the secp256k1 key 1 is 0x7E5F…5Bdf (EIP-55)',()=>{
 const k=Buffer.alloc(32);k[31]=1;
 assert.equal(evmAddress(k),'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
});

test('test wallet file: mode 0600, never overwritten, addresses only returned; load refuses a readable file and mismatched addresses',()=>{
 const path=join(dir,'w','yeet-test-wallet.json');
 const out=createTestWalletFile(path);
 assert.deepEqual(Object.keys(out).sort(),['base','solana']);
 assert.match(out.base,/^0x[0-9a-fA-F]{40}$/);assert.match(out.solana,/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
 assert.equal(statSync(path).mode&0o777,0o600);
 assert.equal(statSync(join(dir,'w')).mode&0o777,0o700);
 const before=readFileSync(path,'utf8');
 assert.throws(()=>createTestWalletFile(path),e=>e.code==='EEXIST');
 assert.equal(readFileSync(path,'utf8'),before,'the existing keys are untouched');
 const w=loadTestWallet(path);
 assert.equal(w.solana.address,out.solana);assert.equal(w.base.address,out.base);
 chmodSync(path,0o644);
 assert.throws(()=>loadTestWallet(path),/mode 0600/);
 chmodSync(path,0o600);
 const j=JSON.parse(before);j.base.address=BASE_WALLET;writeFileSync(path,JSON.stringify(j),{mode:0o600});
 assert.throws(()=>loadTestWallet(path),/Base address does not match/);
 j.base.address=out.base;j.solana.address=aliceWallet.address;writeFileSync(path,JSON.stringify(j),{mode:0o600});
 assert.throws(()=>loadTestWallet(path),/Solana address does not match/);
});

test('user-signed-trade arguments: --local-fee-payer is dry only; a buy needs --usdc; $WIF resolves to the catalogue WIF',()=>{
 assert.throws(()=>parseArgs(['--coin','$WIF','--usdc','5','--broadcast','--local-fee-payer']),/dry runs only/);
 assert.throws(()=>parseArgs(['--coin','$WIF']),/--usdc is required/);
 assert.throws(()=>parseArgs(['--coin','WIF','--usdc','5','--chain','eth']),/--chain/);
 assert.deepEqual(parseArgs(['--coin','$WIF','--usdc','5']),{chain:'sol',side:'buy',coin:'$WIF',usdc:'5',percent:100,broadcast:false,localFeePayer:false,account:OPERATOR_ACCOUNT,wallet:null,db:null,followS:600});
 assert.equal(coinSymbol('$WIF'),'WIF');assert.equal(coinSymbol('wif'),'WIF');
 assert.throws(()=>coinSymbol('USDC'),/unknown coin/);
});

test('--broadcast is refused unless YEET_LIVE=1, the kill switch is off and the account is in YEET_LIVE_ACCOUNTS',()=>{
 const ok={YEET_LIVE:'1',YEET_LIVE_ACCOUNTS:OPERATOR_ACCOUNT};
 assert.doesNotThrow(()=>assertBroadcastAllowed(ok,OPERATOR_ACCOUNT));
 assert.throws(()=>assertBroadcastAllowed({...ok,YEET_LIVE:'0'},OPERATOR_ACCOUNT),/YEET_LIVE=1/);
 assert.throws(()=>assertBroadcastAllowed({...ok,YEET_KILL_SWITCH:'1'},OPERATOR_ACCOUNT),/kill switch/);
 assert.throws(()=>assertBroadcastAllowed({YEET_LIVE:'1'},OPERATOR_ACCOUNT),/YEET_LIVE_ACCOUNTS/);
 assert.throws(()=>assertBroadcastAllowed({YEET_LIVE:'1',YEET_LIVE_ACCOUNTS:'yeet-privy-someone-else'},OPERATOR_ACCOUNT),/YEET_LIVE_ACCOUNTS/);
});

const testWallet={solana:aliceWallet,base:{address:BASE_WALLET,privateKey:()=>new Uint8Array(32)}};
function fakes(){
 const rpc=fakeSolanaRpc(),feePayer=fakeFeePayer('optools-fee-payer');
 return {rpc,feePayer,overrides:{client:fakeOneClick(),balances:fakeBalances({holdings:[{mint:USDC_SOLANA,raw:100_000_000n,decimals:6},{mint:WIF_MINT,raw:1_000_000_000n,decimals:6}]}),
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer}}};
}

for(const side of ['buy','sell'])test(`dry operator run, Solana ${side.toUpperCase()}: the test wallet signs, guards and simulation run, nothing co-signed or sent`,async()=>{
 const f=fakes(),lines=[];
 const opts=parseArgs(side==='buy'?['--coin','$WIF','--usdc','5']:['--side','sell','--coin','$WIF','--percent','10']);
 // The operator's shell has trading off: a dry run still works (its gate is in process), and changes nothing there.
 const env={YEET_LIVE:'0',YEET_KILL_SWITCH:'1'};
 const r=await runUserSignedTrade({opts,wallet:testWallet,env,emit:l=>lines.push(l),overrides:f.overrides});
 assert.equal(env.YEET_LIVE,'0');assert.equal(env.YEET_KILL_SWITCH,'1');
 assert.equal(r.results.length,1);
 const s=lines.find(l=>l.step==='submitted');
 assert.equal(s.dry_run_state,'not_sent');assert.equal(s.simulation_err,null);assert.ok(s.fee_lamports>0);
 assert.equal(f.feePayer.calls,0,'dry: never co-signed');assert.equal(f.rpc.sent.length,0,'dry: never sent');assert.equal(f.rpc.simulated.length,1);
 const x=lines.find(l=>l.step==='executed');
 assert.equal(x.sign_requests[0].wallet,aliceWallet.address);assert.equal(x.sign_requests[0].asset,side==='buy'?'USDC':'WIF');
 for(const l of lines)assert.doesNotMatch(JSON.stringify(l),/seed|private|secret/i);
});

test('broadcast run is refused before anything is built when the operator env has trading off',async()=>{
 const f=fakes();
 await assert.rejects(runUserSignedTrade({opts:parseArgs(['--coin','WIF','--usdc','5','--broadcast']),wallet:testWallet,env:{YEET_LIVE:'0'},overrides:f.overrides}),/YEET_LIVE=1/);
 assert.equal(f.feePayer.calls,0);assert.equal(f.rpc.sent.length,0);
});

// Fee payer bootstrap (Folio fee-payer-bootstrap.test.ts cases).
const authKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
const config={appId:'app-1',appSecret:'secret-1',authorizationKey:`wallet-auth:${authKey}`};
function fakePrivyApi({mutatePolicy,mutateWallet}={}){
 const calls=[],policies=new Map(),wallets=new Map();
 const api={calls,
  async signed(method,path,body,opts){calls.push({method,path,signed:true,idempotencyKey:opts?.idempotencyKey});
   if(path==='/v1/policies'){const id='pol_1';policies.set(id,{id,name:body.name,chain_type:body.chain_type,owner_id:'own_1',rules:body.rules.map((r,i)=>({id:`r${i}`,...r})).reverse()});return {id}}
   if(path==='/v1/wallets'){const id='wal_1',address=aliceWallet.address;wallets.set(id,{id,address,chain_type:'solana',policy_ids:body.policy_ids});return {id,address}}
   throw Error('unexpected')},
  async app(method,path){calls.push({method,path,signed:false});
   const m=path.match(/^\/v1\/(policies|wallets)\/(.+)$/);
   if(m[1]==='policies'){const p=structuredClone(policies.get(m[2]));mutatePolicy?.(p);return p}
   const w=structuredClone(wallets.get(m[2]));mutateWallet?.(w);return w}};
 return api;
}

test('fee payer bootstrap: policy then wallet, idempotent keys, both read back; env lines name the wallet, address and policy',async()=>{
 const api=fakePrivyApi();
 const r=await bootstrapFeePayer(config,api);
 assert.deepEqual(api.calls.map(c=>`${c.method} ${c.path}`),['POST /v1/policies','GET /v1/policies/pol_1','POST /v1/wallets','GET /v1/wallets/wal_1']);
 const hash=policyHash(bootstrapBody(config));
 assert.equal(api.calls[0].idempotencyKey,policyHash({app_id:'app-1',policy_hash:hash,resource:'policy'}));
 assert.equal(api.calls[2].idempotencyKey,policyHash({app_id:'app-1',policy_hash:hash,resource:'fee-payer-wallet'}));
 assert.equal(r.env,`YEET_SOL_FEE_PAYER_ID=wal_1\nYEET_SOL_FEE_PAYER_ADDRESS=${aliceWallet.address}\nYEET_SOL_FEE_PAYER_POLICY_ID=pol_1\nYEET_SOL_FEE_PAYER_POLICY_HASH=${hash}\n`);
 assert.doesNotMatch(r.env,/secret|wallet-auth/);
});

test('fee payer bootstrap refuses a policy read back with other rules, and a wallet with another policy attached',async()=>{
 await assert.rejects(bootstrapFeePayer(config,fakePrivyApi({mutatePolicy:p=>{p.rules=p.rules.filter(r=>r.name!=='deny-system-transfer')}})),e=>e.code==='FEE_PAYER_POLICY_READBACK_REQUIRED');
 const api=fakePrivyApi({mutateWallet:w=>{w.policy_ids=[...w.policy_ids,'pol_other']}});
 await assert.rejects(bootstrapFeePayer(config,api),e=>e.code==='FEE_PAYER_POLICY_ATTACHMENT_REQUIRED');
});

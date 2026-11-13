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
import {privateKeyToAccount} from 'viem/accounts';
import {fakeRpc,keyFile} from './base/test-support.mjs';

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
 assert.deepEqual(parseArgs(['--coin','$WIF','--usdc','5']),{chain:'sol',side:'buy',coin:'$WIF',usdc:'5',percent:100,broadcast:false,localFeePayer:false,feePayerAddress:null,account:OPERATOR_ACCOUNT,wallet:null,db:null,followS:600});
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

test('dry operator run of a 2-coin basket: one sign request for both legs, one simulation; --fee-payer-address is dry only',async()=>{
 const f=fakes(),lines=[];
 const opts=parseArgs(['--coin','$WIF, bome','--usdc','6']);
 const r=await runUserSignedTrade({opts,wallet:testWallet,env:{},emit:l=>lines.push(l),overrides:f.overrides});
 const x=lines.find(l=>l.step==='executed');
 assert.equal(x.sign_requests.length,1);assert.deepEqual(x.sign_requests[0].legs,[0,1]);assert.ok(x.sign_requests[0].unsigned_bytes<=1232);
 assert.deepEqual(r.results.map(q=>q.legs),[[0,1]]);
 const s=lines.find(l=>l.step==='submitted');
 assert.equal(s.dry_run_state,'not_sent');assert.equal(s.simulation_err,null);assert.deepEqual(s.legs,[0,1]);
 assert.equal(f.feePayer.calls,0);assert.equal(f.rpc.sent.length,0);assert.equal(f.rpc.simulated.length,1);
 // The address-only fee payer: refused with --broadcast and with --local-fee-payer; a dry run never asks it to sign.
 assert.throws(()=>parseArgs(['--coin','WIF','--usdc','5','--broadcast','--fee-payer-address',aliceWallet.address]),/dry runs only/);
 assert.throws(()=>parseArgs(['--coin','WIF','--usdc','5','--local-fee-payer','--fee-payer-address',aliceWallet.address]),/exclude/);
 assert.throws(()=>parseArgs(['--coin','WIF','--usdc','5','--fee-payer-address','nope']),/Solana address/);
 const g=fakes(),out=[];
 const {feePayer:_,...driverOverrides}=g.overrides.driverOverrides;
 const fpAddr=g.feePayer.address;
 await runUserSignedTrade({opts:parseArgs(['--coin','WIF,BOME,TRUMP','--usdc','9','--fee-payer-address',fpAddr]),wallet:testWallet,env:{},emit:l=>out.push(l),overrides:{...g.overrides,driverOverrides}});
 assert.equal(out.find(l=>l.step==='fee_payer').address_only,true);
 assert.deepEqual(out.find(l=>l.step==='executed').sign_requests.map(q=>q.legs),[[0,1,2]]);
 assert.equal(out.find(l=>l.step==='submitted').simulation_err,null);
 // --coin lists: 1 to 5 distinct coins.
 await assert.rejects(runUserSignedTrade({opts:parseArgs(['--coin','WIF,WIF','--usdc','6']),wallet:testWallet,env:{},overrides:fakes().overrides}),/twice/);
 await assert.rejects(runUserSignedTrade({opts:parseArgs(['--coin','WIF,BOME,TRUMP,PENGU,SPX,TURBO','--usdc','18']),wallet:testWallet,env:{},overrides:fakes().overrides}),/1 to 5 coins/);
});

test('dry operator run of a Base basket (plan 2.10): YEET_BASE_MODE=7702 gives one evm_7702 request, the test key signs it like the card, the simulation prints; legacy gives N evm_tx',async()=>{
 const key=Uint8Array.from(Buffer.from('6b'.repeat(32),'hex')),acct=privateKeyToAccount('0x'+'6b'.repeat(32));
 const wallet={solana:aliceWallet,base:{address:acct.address,privateKey:()=>Uint8Array.from(key)}};
 const run=async mode=>{
  const gas=keyFile(),rpc=fakeRpc();rpc.s.now=Date.now;rpc.s.token[acct.address.toLowerCase()]=50_000_000n;rpc.s.balance[gas.address]=10n**18n;
  const env={YEET_BASE_MODE:mode,BASE_RPC_URL:'http://fake.invalid',YEET_BASE_GAS_WALLET:gas.address,YEET_BASE_GAS_WALLET_KEY_FILE:gas.file};
  const lines=[];
  await runUserSignedTrade({opts:parseArgs(['--chain','base','--coin','WIF,BOME','--usdc','6']),wallet,env,emit:l=>lines.push(l),
   overrides:{client:fakeOneClick(),balances:fakeBalances({usdc:'50',holdings:[]}),driverOverrides:{baseRpc:rpc,feePayer:null}}});
  return {lines,rpc};
 };
 const a=await run('7702');
 const x=a.lines.find(l=>l.step==='executed');
 assert.deepEqual(x.sign_requests.map(r=>[r.kind,r.legs]),[['evm_7702',[0,1]]]);
 const s=a.lines.find(l=>l.step==='submitted');
 assert.equal(s.dry_run_state,'not_sent');assert.equal(s.simulation.legs_transferred,2);assert.ok(BigInt(s.simulation.max_cost_wei)>0n);
 assert.equal(a.rpc.s.broadcasts.length,0,'dry: nothing sent');
 const b=await run('legacy');
 assert.deepEqual(b.lines.find(l=>l.step==='executed').sign_requests.map(r=>[r.kind,r.legs]),[['evm_tx',[0]],['evm_tx',[1]]]);
 assert.equal(b.rpc.s.broadcasts.length,0);
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

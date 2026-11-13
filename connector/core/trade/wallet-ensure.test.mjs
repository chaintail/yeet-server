// Server-side wallet setup at sign-in (wallet-ensure.mjs) against fakePrivyWallets: a person with no wallets gets one
// Base and one Solana wallet owned by them with no additional signer (decision (b)); a second call creates nothing;
// concurrent calls create once; a Privy failure is reported with its status and a retry uses a new key; existing
// wallets are kept and an old YEET signer on them is reported `legacy`. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakePrivyWallets,fakePrivyEnv,fakeClock,FAKE_POLICY_IDS} from './fakes.mjs';
import {createWalletEnsurer,walletSetupConfig,linkedWallets,walletSetupMessage,WalletSetupError} from './wallet-ensure.mjs';
import {privyDirectory} from './signer-privy.mjs';
import {createPrivyApi} from './privy-api.mjs';

const DID='did:privy:owner8b3aujyq';
const google=[{type:'google_oauth',email:'x@example.test'}];
const setup=(opts={})=>{
 const privy=fakePrivyWallets({users:{[DID]:[...(opts.linked??google)]},...opts});
 const events=[];
 const config=walletSetupConfig(fakePrivyEnv());
 const ensurer=createWalletEnsurer({config,fetch:privy.fetch,now:opts.now??fakeClock(),logger:(event,f)=>events.push({event,...f})});
 return {privy,events,config,ensurer};
};

test('config needs only the Privy app; no signer quorum or policy is required (decision (b))', ()=>{
 assert.ok(walletSetupConfig(fakePrivyEnv()));
 assert.ok(walletSetupConfig(fakePrivyEnv({YEET_SOLANA_POLICY_ID:'',YEET_BASE_POLICY_ID:''})));
 assert.equal(walletSetupConfig(fakePrivyEnv({YEET_PRIVY_KEY_QUORUM_ID:''})).legacySignerId,null);
 assert.equal(walletSetupConfig({}),null);
});

test('a Google-only user with no wallets gets one Base and one Solana wallet with no additional signer', async()=>{
 const {privy,events,ensurer}=setup();
 const out=await ensurer.ensure('acct-1',DID);
 assert.equal(out.ready,true);
 assert.deepEqual(Object.keys(out.chains),['base','solana']);
 for(const c of ['base','solana']){assert.equal(out.chains[c].created,true);assert.equal(out.chains[c].signer,'none')}
 const creates=privy.creates;
 assert.equal(creates.length,2);
 assert.deepEqual(creates.map(c=>c.body.chain_type),['ethereum','solana']);
 for(const c of creates){
  assert.deepEqual(c.body,{chain_type:c.body.chain_type,owner:{user_id:DID}},'no additional_signers in the create body');
  assert.match(c.key,/^[a-f0-9]{64}$/);
  assert.equal(c.signed,false);
 }
 assert.deepEqual(events.map(e=>e.event),['wallet_ensure_start','wallet_ensure_created','wallet_ensure_created','wallet_ensure_done']);
 assert.ok(!JSON.stringify(events).includes('fake-app-secret'));
 // The old engine's directory finds both wallets and no YEET signer on either.
 const env=fakePrivyEnv();
 const dir=privyDirectory({api:createPrivyApi({config:walletSetupConfig(env).privy,fetch:privy.fetch}),didFor:()=>DID,keyQuorumId:'quorum-yeet'});
 const found=await dir.lookup('acct-1');
 assert.notEqual(found.base.signerState,'granted');assert.notEqual(found.solana.signerState,'granted');
});

test('a second call creates nothing and reports the wallets', async()=>{
 const {privy,events,ensurer}=setup();
 const first=await ensurer.ensure('acct-1',DID);
 const second=await ensurer.ensure('acct-1',DID);
 assert.equal(privy.creates.length,2);
 assert.equal(second.ready,true);
 assert.equal(second.chains.base.created,false);
 assert.equal(second.chains.base.address,first.chains.base.address);
 assert.equal(second.chains.solana.address,first.chains.solana.address);
 assert.equal(events.filter(e=>e.event==='wallet_ensure_exists').length,2);
 const w=linkedWallets({linked_accounts:privy.users[DID]});
 assert.ok(w.base&&w.solana);
 assert.equal(privy.users[DID].filter(a=>a.type==='wallet').length,2);
});

test('concurrent calls for one person create each wallet once', async()=>{
 const {privy,ensurer}=setup();
 const [a,b,c]=await Promise.all([ensurer.ensure('acct-1',DID),ensurer.ensure('acct-1',DID),ensurer.ensure('acct-1',DID)]);
 assert.equal(privy.creates.length,2);
 assert.equal(a.chains.base.address,b.chains.base.address);
 assert.equal(a.chains.solana.address,c.chains.solana.address);
});

test('a Privy failure names the chain and status; the retry uses a new key and keeps the wallet made before', async()=>{
 const {privy,events,ensurer}=setup({createFailures:[{at:1,status:500}]});
 await assert.rejects(ensurer.ensure('acct-1',DID),e=>e instanceof WalletSetupError&&e.code==='PRIVY_HTTP_500'&&e.chain==='solana'&&e.status===500);
 const failed=events.find(e=>e.event==='wallet_ensure_failed');
 assert.deepEqual({chain:failed.chain,code:failed.code,privy_status:failed.privy_status},{chain:'solana',code:'PRIVY_HTTP_500',privy_status:500});
 const firstKey=privy.creates[1].key;
 const out=await ensurer.ensure('acct-1',DID);
 assert.equal(out.ready,true);
 assert.equal(out.chains.base.created,false);
 assert.equal(out.chains.solana.created,true);
 assert.notEqual(privy.creates[2].key,firstKey);
 assert.equal(privy.users[DID].filter(a=>a.type==='wallet').length,2);
 assert.match(walletSetupMessage('PRIVY_HTTP_500'),/did not answer/);
});

test('existing wallets are kept and ready; one still carrying the old YEET signer is reported legacy and logged', async()=>{
 const linked=[...google,
  {type:'wallet',wallet_client_type:'privy',chain_type:'ethereum',address:'0x'+'1'.repeat(40),id:'w-base'},
  {type:'wallet',wallet_client_type:'privy',chain_type:'solana',address:'So1ana1111111111111111111111111111111111111',id:'w-sol'}];
 const {privy,events,ensurer}=setup({linked,existingSigners:{'w-base':[{signer_id:'quorum-yeet',override_policy_ids:[FAKE_POLICY_IDS.base]}]}});
 const out=await ensurer.ensure('acct-1',DID);
 assert.equal(privy.creates.length,0);
 assert.equal(out.ready,true);
 assert.equal(out.chains.base.signer,'legacy');
 assert.equal(out.chains.solana.signer,'none');
 assert.deepEqual(events.find(e=>e.event==='wallet_legacy_signer').chains,['base']);
 // Nothing in sign-in adds or changes a signer: only reads and (for missing wallets) creates.
 assert.ok(privy.calls.every(c=>c.method==='GET'||c.path==='/v1/wallets'));
});

test('an unknown account is refused before any Privy call', async()=>{
 const {privy,ensurer}=setup();
 await assert.rejects(ensurer.ensure('acct-x',undefined),{code:'UNKNOWN_ACCOUNT'});
 assert.equal(privy.calls.length,0);
});

// Unit vectors: GasLedger (ported from Folio apps/server/test/bridge/gas.test.ts @70848f097, Base units, principal
// stripped), the YEET wallet ledger adaptation, top-up fee rules (source-service.ts F10), the gas-wallet key file and the
// transfer encoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import {statSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {GasLedger,WalletGasLedger,prepareTopup} from './gas-ledger.mjs';
import {topupFees,replacementFees} from './fees.mjs';
import {createGasWalletKey,loadGasWallet} from './gas-wallet.mjs';
import {transferData,decodeTransfer,payloadOf,txFromPayload,buildTransfer} from './source-executor.mjs';
import {readBaseConfig} from './config.mjs';
import {keyFile} from './test-support.mjs';

const hash=n=>'0x'+n.toString(16).padStart(64,'0');
const wallet='0x'+'aa'.repeat(20),sender='0x'+'bb'.repeat(20);

test('Folio FND-023,030 vector (Base units): contribution, three charges, exact residual, restore, changed top-up refused', ()=>{
 const l=new GasLedger('base');
 assert.equal(l.topupRequired(10_000_000_000_000_000n),10_000_000_000_000_000n);
 assert.throws(()=>l.beforeSigning('approve',10_000_000_000_000_000n),/TOPUP/);
 const topup={attemptId:'topup',txHash:hash(1),contribution:30_000_000_000_000_000n};
 l.confirmTopup(topup);l.confirmTopup(topup);
 assert.equal(prepareTopup(wallet,sender,topup.contribution).value,topup.contribution);
 for(const [id,n,paid,failed] of [['approve',2,4_000_000_000_000_001n,false],['failed-burn',3,5_000_000_000_000_002n,true],['burn',4,6_000_000_000_000_003n,false]]){
  l.beforeSigning(id,10_000_000_000_000_000n);const c={attemptId:id,txHash:hash(n),paid,failed};l.reconcile(c);l.reconcile(c);
 }
 assert.equal(l.gasCharged,15_000_000_000_000_006n);assert.equal(l.sponsorResidual,14_999_999_999_999_994n);
 const restored=new GasLedger('base');restored.restore(l.snapshot());assert.equal(restored.snapshot(),l.snapshot());
 assert.throws(()=>l.confirmTopup({...topup,contribution:1n}),/CHANGED/);
 assert.throws(()=>l.confirmTopup({attemptId:'other',txHash:hash(1),contribution:1n}),/HASH_REUSED/);
});

test('Folio vector: reservations survive restart and bound every charge', ()=>{
 const l=new GasLedger('base');l.confirmTopup({attemptId:'topup',txHash:hash(1),contribution:100n});
 l.beforeSigning('one',75n);
 assert.throws(()=>l.beforeSigning('two',50n),/TOPUP/);
 const restarted=new GasLedger('base');restarted.restore(l.snapshot());
 assert.equal(restarted.availableResidual,25n);
 assert.throws(()=>restarted.reconcile({attemptId:'one',txHash:hash(2),paid:76n,failed:true}),/VIOLATION/);
 restarted.reconcile({attemptId:'one',txHash:hash(2),paid:70n,failed:true});
 assert.equal(restarted.sponsorResidual,30n);
});

test('YEET wallet ledger: reserves without our residual (the user may hold ETH), refuses a charge above the reservation', ()=>{
 const l=new WalletGasLedger('base');
 l.beforeSigning('t1',800n);
 assert.throws(()=>l.beforeSigning('t1',800n),/ATTEMPT_ALREADY_USED/);
 assert.throws(()=>l.reconcile({attemptId:'t1',txHash:hash(5),paid:801n,failed:false}),/VIOLATION/);
 l.reconcile({attemptId:'t1',txHash:hash(5),paid:799n,failed:false});l.reconcile({attemptId:'t1',txHash:hash(5),paid:799n,failed:false});
 assert.throws(()=>l.reconcile({attemptId:'t1',txHash:hash(5),paid:1n,failed:false}),/CHANGED/);
 l.beforeSigning('t2',5n);l.release('t2');assert.equal(l.reservations.size,0);
 const r=new WalletGasLedger('base');r.restore(l.snapshot());assert.equal(r.snapshot(),l.snapshot());
});

test('prepareTopup refuses the gas wallet as recipient, a malformed address and a zero amount', ()=>{
 assert.throws(()=>prepareTopup(sender,sender,1n),/GAS_WALLET_NOT_CONFIGURED/);
 assert.throws(()=>prepareTopup('0x12',sender,1n),/GAS_WALLET_NOT_CONFIGURED/);
 assert.throws(()=>prepareTopup(wallet,undefined,1n),/GAS_WALLET_NOT_CONFIGURED/);
 assert.throws(()=>prepareTopup(wallet,sender,0n),/GAS_WALLET_NOT_CONFIGURED/);
 assert.deepEqual(prepareTopup(wallet,sender,7n),{from:sender,to:wallet,value:7n,data:'0x'});
});

test('Folio F10 fee rules: non-zero tip bounded by maxFee; replacement raises both fees 12.5% rounded up, or to a fresh read', ()=>{
 assert.deepEqual(topupFees({maxFeePerGas:10_000_000n,maxPriorityFeePerGas:0n}),{maxFeePerGas:10_000_000n,maxPriorityFeePerGas:1_000_000n});
 assert.deepEqual(topupFees({maxFeePerGas:500n,maxPriorityFeePerGas:0n}),{maxFeePerGas:500n,maxPriorityFeePerGas:500n});
 assert.deepEqual(replacementFees({maxFeePerGas:1000n,maxPriorityFeePerGas:9n},{maxFeePerGas:1n,maxPriorityFeePerGas:1n}),{maxFeePerGas:1125n,maxPriorityFeePerGas:11n});
 assert.deepEqual(replacementFees({maxFeePerGas:1000n,maxPriorityFeePerGas:9n},{maxFeePerGas:5000n,maxPriorityFeePerGas:50n}),{maxFeePerGas:5000n,maxPriorityFeePerGas:50n});
});

test('gas-wallet key file: 0600 in a 0700 directory, refuses to overwrite, returns the address only', ()=>{
 const {dir}=keyFile(),file=path.join(dir,'keys','base-gas-wallet.key');
 const out=createGasWalletKey(file);
 assert.deepEqual(Object.keys(out).sort(),['address','file']);assert.match(out.address,/^0x[0-9a-f]{40}$/);
 assert.equal(statSync(file).mode&0o777,0o600);assert.equal(statSync(path.dirname(file)).mode&0o777,0o700);
 const key=readFileSync(file,'utf8').trim();assert.match(key,/^0x[0-9a-f]{64}$/);assert.ok(!JSON.stringify(out).includes(key.slice(2)));
 assert.throws(()=>createGasWalletKey(file),/EEXIST|exists/);
 const loaded=loadGasWallet(readBaseConfig({YEET_BASE_GAS_WALLET:out.address,YEET_BASE_GAS_WALLET_KEY_FILE:file}));
 assert.equal(loaded.address,out.address);assert.ok(!JSON.stringify(loaded).includes(key.slice(2)));
 chmodSync(file,0o640);
 assert.throws(()=>loadGasWallet(readBaseConfig({YEET_BASE_GAS_WALLET:out.address,YEET_BASE_GAS_WALLET_KEY_FILE:file})),/GAS_WALLET_NOT_CONFIGURED/);
 chmodSync(file,0o600);writeFileSync(file,'0xzz\n');
 assert.throws(()=>loadGasWallet(readBaseConfig({YEET_BASE_GAS_WALLET:out.address,YEET_BASE_GAS_WALLET_KEY_FILE:file})),/GAS_WALLET_NOT_CONFIGURED/);
});

test('transfer encoding round-trips and the payload carries integers as decimal strings', ()=>{
 const to='0x'+'12'.repeat(20),data=transferData(to,5_000_000n);
 assert.deepEqual(decodeTransfer(data),{recipient:to,amount:5_000_000n});
 assert.equal(decodeTransfer(data+'00'),null);assert.equal(decodeTransfer('0x095ea7b3'+data.slice(10)),null);
 const tx=buildTransfer({depositAddress:to,amountRaw:5_000_000n,nonce:3,gas:75_000n,maxFeePerGas:10n**7n,maxPriorityFeePerGas:10n**6n});
 const p=payloadOf(tx);assert.equal(typeof p.gas,'string');assert.equal(typeof p.nonce,'number');
 assert.deepEqual(txFromPayload(p),tx);
 assert.throws(()=>transferData('0x12',1n));assert.throws(()=>transferData(to,0n));
});

test('config: defaults from the design, malformed values throw', ()=>{
 const c=readBaseConfig({});
 assert.equal(c.topupCapRaw,100_000_000_000_000n);assert.equal(c.globalDailyRaw,1_000_000_000_000_000n);
 assert.equal(c.floorRaw,500_000_000_000_000n);assert.equal(c.maxFeeWei,100_000_000n);assert.equal(c.paused,false);
 assert.throws(()=>readBaseConfig({YEET_BASE_TOPUP_CAP_RAW:'-1'}));assert.throws(()=>readBaseConfig({YEET_BASE_GAS_WALLET:'0x12'}));
});

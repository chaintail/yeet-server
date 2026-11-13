// Self-gas check of `ops/first-trade.mjs --plan` (base-gas.mjs): the cost of one USDC transfer on Base now (gas x gas
// price + L1 data fee), x3, against the wallet's ETH. Fake JSON-RPC; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readBaseGasCost,selfGasCheck,GAS_PRICE_ORACLE,FALLBACK_TRANSFER_GAS,TRANSFER_TX_BYTES} from './base-gas.mjs';
import {USDC_BASE} from './signer.mjs';

const FROM='0x17602fd697f91d31fe551b26a3b12b113789477e';
const rpc=(answers,seen=[])=>async(_url,init)=>{const batch=JSON.parse(init.body);seen.push(...batch);return new Response(JSON.stringify(batch.map(c=>({jsonrpc:'2.0',id:c.id,...answers[c.method==='eth_call'?'l1':c.method]}))))};

test('selfGasCheck: cost = gas x price + L1 fee; needed = cost x 3; covered only at or above it',()=>{
 const g={gasLimit:62_000n,gasPriceWei:6_000_000n,l1FeeWei:826_288_142n};// live Base values of 2026-11-13
 const cost=62_000n*6_000_000n+826_288_142n;
 const empty=selfGasCheck({...g,balanceWei:0n,ethUsd:3000});
 assert.equal(empty.costWei,cost);assert.equal(empty.neededWei,cost*3n);assert.equal(empty.covered,false);
 assert.equal(empty.needed_eth,'0.000001118478864426');assert.equal(empty.needed_usd,(Number(cost*3n)/1e18*3000).toFixed(6));
 assert.equal(selfGasCheck({...g,balanceWei:cost*3n}).covered,true);
 assert.equal(selfGasCheck({...g,balanceWei:cost*3n-1n}).covered,false);
 assert.equal(selfGasCheck({...g,balanceWei:10n**14n}).balance_eth,'0.0001');
 assert.equal(selfGasCheck({...g,balanceWei:0n}).needed_usd,null,'no price: no USD figure');
});

test('readBaseGasCost: read-only calls only (gas price, estimate of the exact USDC transfer, L1 fee bound)',async()=>{
 const seen=[];
 const g=await readBaseGasCost({rpcUrl:'https://rpc.invalid',from:FROM,amountRaw:5_000_000n,fetch:rpc({eth_gasPrice:{result:'0x5b8d80'},eth_estimateGas:{result:'0xf230'},l1:{result:'0x'+'0'.repeat(56)+'3140280e'}},seen)});
 assert.deepEqual(seen.map(c=>c.method).sort(),['eth_call','eth_estimateGas','eth_gasPrice']);
 const est=seen.find(c=>c.method==='eth_estimateGas').params[0];
 assert.equal(est.to,USDC_BASE);assert.equal(est.value,'0x0');assert.match(est.data,/^0xa9059cbb/);
 const l1=seen.find(c=>c.method==='eth_call').params[0];
 assert.equal(l1.to,GAS_PRICE_ORACLE);assert.equal(BigInt('0x'+l1.data.slice(10)),BigInt(TRANSFER_TX_BYTES));
 assert.deepEqual([g.gasLimit,g.gasPriceWei,g.l1FeeWei,g.estimated,g.l1Known],[0xf230n,0x5b8d80n,0x3140280en,true,true]);
});

test('readBaseGasCost: a refused estimate falls back to 65k gas; an unreadable gas price is an error',async()=>{
 const g=await readBaseGasCost({rpcUrl:'x',from:FROM,amountRaw:1n,fetch:rpc({eth_gasPrice:{result:'0x1'},eth_estimateGas:{error:{code:-32000,message:'execution reverted'}},l1:{error:{code:-32000}}})});
 assert.deepEqual([g.gasLimit,g.estimated,g.l1FeeWei,g.l1Known],[FALLBACK_TRANSFER_GAS,false,0n,false]);
 await assert.rejects(readBaseGasCost({rpcUrl:'x',from:FROM,amountRaw:1n,fetch:rpc({eth_gasPrice:{result:'nope'},eth_estimateGas:{result:'0x1'},l1:{result:'0x1'}})}),/eth_gasPrice unreadable/);
});

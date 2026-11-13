// ops/first-trade.mjs output (first-trade-format.mjs): state lines show the engine's real leg state. The 2026-11-13
// attempt printed `sent` for a leg Privy had refused (the contract folds `sending` into `sent`). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {describe,sendWord,privyErrors,printFinal} from '../first-trade-format.mjs';

const AT='T';
const privy={status:400,code:'invalid_data',message:'Gas sponsorship is not enabled'};

test('sendWord: only a sent leg reads "sent"; sending is NOT CONFIRMED',()=>{
 assert.equal(sendWord({send_status:'sent',tx_hash:'0xab'}),'sent');
 assert.equal(sendWord({send_status:'sent',hash_pending:true}),'sent (hash pending)');
 assert.equal(sendWord({send_status:'sending',send_attempts:2}),'NOT CONFIRMED (sending, 2 attempts)');
 assert.equal(sendWord({send_status:'failed'}),'FAILED (not sent)');
 assert.equal(sendWord({send_status:'not_sent'}),'NOT SENT');
 assert.equal(sendWord(undefined),'?');
});

test('execute line: the contract says sent, the engine says sending -> NOT CONFIRMED with the Privy error',()=>{
 const line=describe({stage:'executed',execute:{trade_id:'t_x',status:'submitted',legs:[{symbol:'WIF',status:'sent',deposit_address:'0xd',tx_hash:null}]},
  send_states:[{idx:0,symbol:'WIF',send_status:'sending',send_attempts:1,privy_error:privy}]},AT);
 assert.match(line,/send=NOT CONFIRMED/);assert.doesNotMatch(line,/send=sent/);
 assert.match(line,/Privy 400 invalid_data: Gas sponsorship is not enabled/);assert.match(line,/tx none/);
 const unread=describe({stage:'executed',execute:{trade_id:'t_x',status:'submitted',legs:[{symbol:'WIF',status:'sent',deposit_address:'0xd',tx_hash:null}]}},AT);
 assert.match(unread,/send=unknown/);assert.doesNotMatch(unread,/send=sent/);
 const refused=describe({stage:'executed',execute:{trade_id:'t_x',status:'refused',error:'TEMPORARILY_UNAVAILABLE'},send_states:[{symbol:'WIF',send_status:'failed',privy_error:privy}]},AT);
 assert.match(refused,/REFUSED TEMPORARILY_UNAVAILABLE.*WIF send=FAILED \(not sent\) \[Privy 400/);
});

test('status and cancel lines carry the real state; the receipt collects every Privy error',()=>{
 const s=describe({stage:'status',elapsed_s:3,status:'signing',legs:[{symbol:'WIF',status:'PENDING_DEPOSIT',send:'sending',send_attempts:2,privy_error:privy}]},AT);
 assert.match(s,/WIF PENDING_DEPOSIT send=NOT CONFIRMED \(sending, 2 attempts\) \[Privy 400/);
 const c=describe({stage:'cancel',cancelled:true,trade_id:'t_x',status:'failed',legs:[{idx:0,symbol:'WIF',send_status:'failed'}],released_raw:'5000000'},AT);
 assert.match(c,/CANCELLED trade t_x status failed; leg 0 WIF failed; released 5 USDC/);
 const r={status:{record:{legs:[{idx:0,symbol:'WIF',send_status:'failed',privy_error:privy},{idx:1,symbol:'BOME',send_status:'sent',privy_error:null}]}}};
 assert.deepEqual(privyErrors(r),[{leg:0,symbol:'WIF',send_status:'failed',...privy}]);
 const out=[];printFinal({ok:false,stage:'final',status:{trade_id:'t_x',status:'failed',received:[],legs:[{symbol:'WIF',status:'FAILED'}],record:{legs:r.status.record.legs,last_error:'leg 0: x'}}},l=>out.push(l));
 assert.match(out.join('\n'),/RESULT NOT OK/);assert.match(out.join('\n'),/WIF: FAILED, send=FAILED \(not sent\) \[Privy 400/);
});

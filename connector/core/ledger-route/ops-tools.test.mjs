// The operator tools of the deposit proof (docs/LEDGER-ROUTE.md 6.3): ops/ledger-route-check.mjs --deposit-addresses /
// --deposit-watch and ops/send-usdc.mjs, on fakes. Nothing here touches a network or a real wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs as checkArgs,depositRun} from '../../../ops/ledger-route-check.mjs';
import {parseArgs as sendArgs,runSend,CONFIRM,HARD_MAX_USDC} from '../../../ops/send-usdc.mjs';
import {createDeposits,operatorAccountId} from './deposits.mjs';
import {ledgerAccountOf} from './route.mjs';
import {ledgerPipeline,fakeDepositApi,accountOf,aliceWallet,bobWallet,USDC} from './fakes.mjs';
import {fakeSolanaRpc,fakeFeePayer} from '../pipeline/fakes.mjs';
import {fakeClock} from '../trade/fakes.mjs';
import {CATALOG} from '../trade/router.mjs';

const KEY='ops-partner-key-51aa',TO=bobWallet.address;

test('ledger-route-check: the deposit flags need no solver; --db and --account only go with them; the plain check is as before',()=>{
 const o=checkArgs(['--address',aliceWallet.address,'--deposit-addresses','--account','yeet-privy-operator-test-wallet','--db','/tmp/x.sqlite'],{});
 assert.equal(o.depositAddresses,true);assert.equal(o.depositWatch,false);assert.equal(o.account,'yeet-privy-operator-test-wallet');assert.equal(o.db,'/tmp/x.sqlite');
 assert.equal(checkArgs(['--address',aliceWallet.address,'--deposit-watch','--follow-s','60'],{}).followS,60);
 assert.throws(()=>checkArgs(['--address',aliceWallet.address,'--deposit-watch','--follow-s','5'],{}),/--follow-s/);
 assert.throws(()=>checkArgs(['--address',aliceWallet.address,'--deposit-addresses','--account','a b'],{}),/--account/);
 assert.throws(()=>checkArgs(['--address',aliceWallet.address,'--db','/tmp/x.sqlite'],{YEET_SOLVER_ACCOUNT:'a'.repeat(64)}),/--db and --account/);
 assert.throws(()=>checkArgs(['--address',aliceWallet.address],{}),/--solver/);
 assert.match(operatorAccountId(aliceWallet.address),/^address-[0-9a-f]{16}$/);
});

test('ledger-route-check --deposit-addresses and --deposit-watch: the set (every chain, never the key), then one line per change until the USDC is credited',async()=>{
 const t=ledgerPipeline({userUsdc:0n}),api=fakeDepositApi({key:KEY,now:t.now}),account=accountOf(aliceWallet),lines=[];
 const deposits=createDeposits({db:t.db,key:KEY,verifier:t.world.verifier,accountOf:ledgerAccountOf,catalog:CATALOG,networks:['solana','base'],fetch:(...a)=>api.fetch(...a),now:t.now,log:l=>lines.push({step:'log',...l})});
 const o=checkArgs(['--address',aliceWallet.address,'--deposit-addresses'],{}),id=operatorAccountId(aliceWallet.address);
 assert.equal(await depositRun(o,{deposits,accountId:id,ledgerAccount:account,emit:l=>lines.push(l),now:t.now}),0);
 const set=lines.find(l=>l.step==='deposit_addresses');
 assert.equal(set.ledger_account,account);assert.equal(set.state,'ready');assert.equal(set.source,'created');
 assert.deepEqual(set.chains.map(c=>c.chain),['eth','base','sol','stellar']);assert.equal(set.chains[3].memo,'yes (never offered)');
 assert.deepEqual(set.card_shows.map(n=>n.network),['solana','base']);
 assert.equal(set.card_shows[0].address,set.chains[2].address);
 // again: read from the store, nothing made
 assert.equal(await depositRun(o,{deposits,accountId:id,ledgerAccount:account,emit:l=>lines.push(l),now:t.now}),0);
 assert.equal(api.posts(),1);
 // the watch: the deposit is seen by 1Click, then credited
 let n=0;
 const sleep=async ms=>{t.now.advance(ms);n++;
  if(n===2){const s=api.sets[0].status;s.status='KNOWN_DEPOSIT_TX';s.swapDetails.originChainTxHashes=[{hash:'x'}];s.updatedAt=new Date(t.now()).toISOString()}
  if(n===4)t.world.credit(account,USDC,1_000_000n)};
 const w=checkArgs(['--address',aliceWallet.address,'--deposit-watch','--follow-s','120'],{});
 assert.equal(await depositRun(w,{deposits,accountId:id,ledgerAccount:account,emit:l=>lines.push(l),sleep,now:t.now}),0);
 const seen=lines.filter(l=>l.step==='deposit_watch');
 assert.deepEqual(seen.map(l=>l.stage),['waiting','found','ready'],'one line per change, not one per look');
 assert.equal(seen[1].oneclick.status,'KNOWN_DEPOSIT_TX');assert.equal(seen[2].arrived_usdc,'1');assert.equal(seen[2].ledger_usdc,'1');
 assert.deepEqual(lines.at(-1),{step:'done',ok:true,credited_usdc:'1',ledger_usdc:'1'});
 assert.ok(!JSON.stringify(lines).includes(KEY),'the key is never printed');
 // nothing arrives: the tool stops after --follow-s and says so
 const idle=ledgerPipeline({userUsdc:0n}),api2=fakeDepositApi({key:KEY,now:idle.now}),out=[];
 const d2=createDeposits({db:idle.db,key:KEY,verifier:idle.world.verifier,accountOf:ledgerAccountOf,fetch:(...a)=>api2.fetch(...a),now:idle.now});
 assert.equal(await depositRun(checkArgs(['--address',aliceWallet.address,'--deposit-watch','--follow-s','30'],{}),{deposits:d2,accountId:id,ledgerAccount:account,emit:l=>out.push(l),sleep:async ms=>idle.now.advance(ms),now:idle.now}),3);
 assert.equal(out.at(-1).ok,false);assert.equal(out.filter(l=>l.step==='deposit_watch').length,1);
 // no set can be made (the list cannot be read): exit 1 and the reason, no watch
 const blind=ledgerPipeline(),api3=fakeDepositApi({key:KEY});api3.listFails=true;const out3=[];
 const d3=createDeposits({db:blind.db,key:KEY,verifier:blind.world.verifier,accountOf:ledgerAccountOf,fetch:(...a)=>api3.fetch(...a),now:blind.now});
 assert.equal(await depositRun(w,{deposits:d3,accountId:id,ledgerAccount:account,emit:l=>out3.push(l),now:blind.now}),1);
 assert.match(out3[0].why,/list of sets could not be read/);assert.deepEqual(out3[0].card_shows,[]);
});

function sender({usdc=5_000_000n,feePayer=null}={}){
 const rpc=fakeSolanaRpc(),now=fakeClock(),lines=[],state={};let saves=0;
 rpc.tokenBalance=async()=>usdc;
 const deps={wallet:aliceWallet,rpc,signatureStatus:rpc.signatureStatus,feePayer,state,save:()=>{saves++},emit:l=>lines.push(l),sleep:async ms=>now.advance(ms),now};
 return {rpc,now,lines,state,deps,saves:()=>saves};
}
const args=(...more)=>sendArgs(['--to',TO,'--usdc','1','--wallet','/nonexistent/wallet.json',...more]);

test('send-usdc: the arguments are bounded (an address, a small amount, a wallet file)',()=>{
 assert.deepEqual(args(),{to:TO,usdc:'1',wallet:'/nonexistent/wallet.json',feePayer:'self',state:null,maxUsdc:'5',broadcast:false,again:false});
 assert.equal(args('--fee-payer','privy','--broadcast').broadcast,true);
 assert.throws(()=>sendArgs(['--to','nope','--usdc','1','--wallet','w']),/--to/);
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','0','--wallet','w']),/--usdc/);
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','6','--wallet','w']),/over --max-usdc 5/);
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','30','--wallet','w','--max-usdc','30']),new RegExp(`at most ${HARD_MAX_USDC}`));
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','1']),/--wallet/);
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','1','--wallet','w','--fee-payer','other']),/--fee-payer/);
 assert.throws(()=>sendArgs(['--to',TO,'--usdc','1','--wallet','w','--yes']),/unknown argument/);
});

test('send-usdc: dry by default; --broadcast is refused without the confirm value; nothing is sent either way',async()=>{
 const s=sender();
 assert.equal(await runSend(args(),s.deps),0);
 assert.equal(s.lines[0].stage,'dry');assert.equal(s.lines[0].sent,'nothing');assert.equal(s.lines[0].to,TO);assert.equal(s.lines[0].usdc,'1');assert.equal(s.lines[0].creates_token_account,true);
 assert.equal(await runSend(args('--broadcast'),s.deps),1);
 assert.equal(s.lines[1].step,'refused');
 assert.equal(await runSend(args('--broadcast'),{...s.deps,confirm:'yes'}),1);
 assert.deepEqual(s.rpc.sent,[]);assert.deepEqual(s.state,{});assert.equal(s.saves(),0);
 // never to the wallet itself, and not more than the wallet holds
 await assert.rejects(runSend(sendArgs(['--to',aliceWallet.address,'--usdc','1','--wallet','w']),s.deps),/the wallet itself/);
 await assert.rejects(runSend(args(),sender({usdc:500_000n}).deps),/holds 500000 raw units/);
});

test('send-usdc --broadcast: saved before it is sent, confirmed, and never paid twice',async()=>{
 const s=sender({feePayer:fakeFeePayer()});
 let savedFirst=null;
 s.rpc.onBroadcast=()=>{savedFirst=s.saves()>0&&typeof s.state.signed_base64==='string';s.rpc.statuses.set(s.state.solana_tx,{status:'confirmed',commitment:'confirmed',slot:1})};
 assert.equal(await runSend(args('--broadcast','--fee-payer','privy'),{...s.deps,confirm:CONFIRM}),0);
 assert.equal(savedFirst,true,'the signed transaction is in the state file before the broadcast');
 assert.equal(s.rpc.sent.length,1);assert.equal(s.lines.at(-1).ok,true);assert.equal(s.lines.at(-1).solana_tx,s.state.solana_tx);assert.equal(s.lines[0].fee_payer,'privy');
 assert.equal(s.state.confirmed,true);
 // the same command again: already sent, nothing new
 assert.equal(await runSend(args('--broadcast'),{...s.deps,confirm:CONFIRM}),0);
 assert.equal(s.lines.at(-1).stage,'already_sent');assert.equal(s.rpc.sent.length,1);
 // --again, or another amount: a new transfer
 const first=s.state.solana_tx;
 assert.equal(await runSend(args('--broadcast','--again'),{...s.deps,confirm:CONFIRM}),0);
 assert.equal(s.rpc.sent.length,2);assert.notEqual(s.state.solana_tx,first);
});

test('send-usdc: a transfer that has no outcome yet is followed by the next run, with the same bytes; one that expired or failed is signed anew',async()=>{
 const s=sender();
 assert.equal(await runSend(args('--broadcast'),{...s.deps,confirm:CONFIRM}),3);
 assert.equal(s.lines.at(-1).ok,false);assert.equal(s.rpc.sent.length,1);
 const tx=s.state.solana_tx,bytes=s.rpc.sent[0];
 // dry while it is pending: says so, sends nothing
 assert.equal(await runSend(args(),s.deps),0);assert.equal(s.lines.at(-1).stage,'pending');assert.equal(s.rpc.sent.length,1);
 // the next --broadcast: the same transaction again, and now it lands
 s.rpc.onBroadcast=()=>s.rpc.statuses.set(tx,{status:'finalized',commitment:'finalized',slot:2});
 assert.equal(await runSend(args('--broadcast'),{...s.deps,confirm:CONFIRM}),0);
 assert.equal(s.rpc.sent.length,2);assert.equal(s.rpc.sent[1],bytes,'the same bytes: it cannot pay twice');assert.equal(s.state.solana_tx,tx);
 // expired before landing: the run says nothing was sent, and the next one signs a new transfer
 const e=sender();
 e.rpc.onBroadcast=()=>{e.rpc.valid=false};
 await assert.rejects(runSend(args('--broadcast'),{...e.deps,confirm:CONFIRM}),/expired before it landed/);
 assert.equal(e.state.failed,true);
 e.rpc.valid=true;const old=e.state.solana_tx;
 e.rpc.onBroadcast=()=>e.rpc.statuses.set(e.state.solana_tx,{status:'confirmed',commitment:'confirmed',slot:3});
 assert.equal(await runSend(args('--broadcast'),{...e.deps,confirm:CONFIRM}),0);
 assert.notEqual(e.state.solana_tx,old);
});

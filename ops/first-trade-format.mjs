// Output of ops/first-trade.mjs (pure; tested by ops/scripts/first-trade-format-test.mjs). Every state line shows the
// engine's real leg state (`send=`), never only the contract's folded view: an unconfirmed send (`sending`) reads
// "NOT CONFIRMED", and a send Privy refused prints Privy's HTTP status, error code and (redacted) message.
export const et=d=>new Date(d).toLocaleString('en-US',{timeZone:'America/New_York',hour12:false})+' ET';

/** `Privy 400 code: message` for a leg's redacted Privy error. */
export const privyText=p=>p?`Privy ${p.status}${p.code?` ${p.code}`:''}${p.message?`: ${p.message}`:''}`:'';
/** The engine's real leg state in words. */
export function sendWord(s){
 if(!s?.send_status)return '?';
 if(s.send_status==='sent')return s.tx_hash?'sent':s.hash_pending?'sent (hash pending)':'sent';
 if(s.send_status==='sending')return `NOT CONFIRMED (sending, ${s.send_attempts??'?'} attempt${s.send_attempts===1?'':'s'}${s.refused?', refused':''})`;
 if(s.send_status==='failed')return 'FAILED (not sent)';
 if(s.send_status==='not_sent')return 'NOT SENT';
 if(s.send_status==='queued')return 'queued (not sent yet)';
 return s.send_status;
}
const privyPart=p=>p?` [${privyText(p)}]`:'';

export function describe(e,at=et(Date.now())){
 if(e.stage==='trading')return `${at}  stack: trading=${e.trading} scope=${e.scope} account_allowed=${e.account_allowed} gas=${e.base_gas}`;
 if(e.stage==='proposed'){const l=e.proposal.legs[0];return `${at}  proposed ${e.proposal.proposal_id} r${e.proposal.revision}: ${l.amount_in} USDC -> est ${l.est_out} ${l.symbol} (min ${l.min_out}), cost ${e.proposal.totals.cost_pct}%`}
 if(e.stage==='executed'){
  const x=e.execute,real=e.send_states??[];
  // The execute answer's leg status is the contract's (an unconfirmed send reads `sent`): print the engine's state.
  if(x.status==='refused')return `${at}  execute: REFUSED ${x.error??''} trade ${x.trade_id}: `+real.map(s=>`${s.symbol} send=${sendWord(s)}${privyPart(s.privy_error)}`).join('; ');
  return `${at}  execute: answered ${x.status} ${x.trade_id??''} `+(x.legs??[]).map((l,i)=>{
   const s=real[i];
   return `${l.symbol} send=${s?sendWord(s):`unknown (engine state unread; contract says ${l.status})`} deposit ${l.deposit_address} tx ${l.tx_hash??(s?.hash_pending?'(hash pending)':'none')}${privyPart(s?.privy_error)}`;
  }).join('; ');
 }
 if(e.stage==='status')return `${at}  [+${e.elapsed_s}s] trade ${e.status}: `+e.legs.map(l=>`${l.symbol} ${l.status} send=${l.send?sendWord({send_status:l.send,send_attempts:l.send_attempts,hash_pending:l.hash_pending,tx_hash:l.origin_tx}):'?'}${privyPart(l.privy_error)}${l.origin_tx?` base_tx ${l.origin_tx}`:''}${l.destination_tx?` sol_tx ${l.destination_tx}`:''}${l.amount_out?` out ${l.amount_out}`:''}${l.refund_reason?` (${l.refund_reason})`:''}`).join('; ')+(e.last_error?`  last_error: ${e.last_error}`:'');
 if(e.stage==='cancel')return `${at}  cancel: ${e.cancelled?'CANCELLED':'REFUSED'} trade ${e.trade_id} status ${e.status}${e.reason?` (${e.reason})`:''}; `+(e.legs??[]).map(l=>`leg ${l.idx} ${l.symbol} ${l.send_status}`).join('; ')+(e.released_raw&&e.released_raw!=='0'?`; released ${Number(e.released_raw)/1e6} USDC to the daily cap`:'');
 return `${at}  ${e.stage} ${JSON.stringify(e)}`;
}

/** Every Privy error on record for the trade: the receipt keeps them at the top level. */
export function privyErrors(r){
 const legs=r?.status?.record?.legs??[];
 return legs.filter(l=>l.privy_error).map(l=>({leg:l.idx,symbol:l.symbol,send_status:l.send_status,...l.privy_error}));
}
export function links(status){
 const legs=status?.record?.receipt?.legs??[];
 return (status?.legs??[]).map((l,i)=>({symbol:l.symbol,status:l.status,base_tx:l.origin_tx,basescan:l.origin_tx?`https://basescan.org/tx/${l.origin_tx}`:null,
  deposit_address:legs[i]?.depositAddress??null,near_intents:legs[i]?.depositAddress?`https://explorer.near-intents.org/transactions/${legs[i].depositAddress}`:null,
  solana_tx:l.destination_tx,solscan:l.destination_tx?`https://solscan.io/tx/${l.destination_tx}`:null,amount_out:l.amount_out,refund_reason:l.refund_reason}));
}
/** The final lines; `print` defaults to console.log. */
export function printFinal(r,print=console.log){
 print(`\nRESULT ${r.ok?'OK':'NOT OK'} (stage ${r.stage})${r.reason?`: ${r.reason}`:''}${r.error?`: ${r.error}`:''}`);
 if(r.status){
  print(`  trade ${r.status.trade_id} status ${r.status.status}; received ${JSON.stringify(r.status.received)}; xp ${JSON.stringify(r.status.xp_award??null)}`);
  const rec=r.status.record?.legs??[];
  for(const [i,l] of links(r.status).entries())print(`  ${l.symbol}: ${l.status}, send=${sendWord(rec[i])}${privyPart(rec[i]?.privy_error)}\n    base tx      ${l.basescan??'-'}\n    near intents ${l.near_intents??'-'}\n    solana tx    ${l.solscan??'-'}${l.refund_reason?`\n    refund       ${l.refund_reason}`:''}`);
  if(r.status.record?.last_error)print(`  last_error   ${r.status.record.last_error}`);
 }
 if(r.spent_today_usdc!==undefined&&r.spent_today_usdc!==null)print(`  daily cap used today (UTC) ${r.spent_today_usdc} USDC`);
}

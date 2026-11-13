#!/usr/bin/env node
// Ops view of the trade alert outbox (accounting.mjs) in $STATE_DIR/trade.sqlite (or TRADE_DB): one JSON line per
// alert, oldest first. Kinds: stuck (not final after YEET_STUCK_AFTER_MINUTES), stale (tracking stopped), partial,
// balance_mismatch (source debit outside the expected range; the trade has a needs_review row in trade_events).
//   node core/scripts/trade-alerts.mjs            open alerts
//   node core/scripts/trade-alerts.mjs --all      open and acknowledged alerts
//   node core/scripts/trade-alerts.mjs --sweep    raise stuck alerts first, then list
//   node core/scripts/trade-alerts.mjs --ack 12   acknowledge alert 12
import {openTradeDb} from '../trade/db.mjs';
import {listAlerts,ackAlert,sweepStuck,accountingFromEnv} from '../trade/accounting.mjs';

const args=process.argv.slice(2);
const db=openTradeDb(process.env.TRADE_DB||undefined);
try{
 const ack=args.indexOf('--ack');
 if(ack>=0){
  const id=Number(args[ack+1]);
  if(!Number.isSafeInteger(id))throw Error('--ack needs an alert id');
  console.log(JSON.stringify({acked:id,changed:ackAlert(db,id)}));
 }else{
  if(args.includes('--sweep'))sweepStuck(db,{ageMs:accountingFromEnv().stuckAfterMs});
  for(const a of listAlerts(db,{all:args.includes('--all')}))console.log(JSON.stringify(a));
 }
}finally{db.close()}

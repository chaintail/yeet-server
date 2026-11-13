// What a person paid for their coins and what their SKEETs made, from settled trade legs only (trade.sqlite).
//
// Measure (stated on every board that uses it): REALISED ON SKEETS, AVERAGE COST.
//   - A settled YEET leg (1Click status SUCCESS) adds `settled_out_raw` coins at a cost of `amount_in_raw` USDC.
//   - A settled SKEET leg sells `amount_in_raw` coins for `settled_out_raw` USDC. Its result is the USDC received minus
//     the average YEET cost of the coins sold. Coins that did not come from a YEET on this account (a transfer in) have
//     no known cost: that part of a sale is left out, and a sale with no known cost at all is not counted.
//   - Coins still held are not counted (no price history is stored); `winnerOf` marks holdings against the same average
//     cost with the live price the portfolio already shows.
// A leg's time is its last update (the settle write). Amounts are floats here: these numbers rank and display, they
// never move money.
const SETTLED=`SELECT t.id trade_id,t.account_id,t.direction,l.idx,l.symbol,l.amount_in_raw,l.settled_out_raw,l.updated_at
 FROM trade_legs l JOIN trades t ON t.id=l.trade_id
 WHERE l.oneclick_status='SUCCESS' AND l.settled_out_raw IS NOT NULL`;
const units=(raw,decimals)=>Number(BigInt(raw))/10**decimals;
/** Decimals of a tradable coin on Solana, or null (USDC is the money side, never a position). */
export function coinDecimals(catalog,symbol){
 if(symbol==='USDC')return null;
 const e=catalog.find(c=>c.chain==='solana'&&c.symbol===symbol&&c.kind!=='funding');
 return e&&Number.isInteger(e.decimals)?e.decimals:null;
}
/** Walks settled legs oldest first. Returns {positions: Map("account|symbol" -> {qty,cost}), sales: [{accountId, symbol,
 * tradeId, at, pnl_usd, pct, cost_usd}]}. `accountId` narrows the walk to one account. */
export function walk(db,catalog,{accountId=null}={}){
 const rows=db.prepare(`${SETTLED}${accountId?' AND t.account_id=?':''} ORDER BY l.updated_at,t.id,l.idx`).all(...(accountId?[accountId]:[]));
 const positions=new Map(),sales=[];
 for(const r of rows){
  const d=coinDecimals(catalog,r.symbol);if(d===null)continue;
  const key=`${r.account_id}|${r.symbol}`,p=positions.get(key)??{qty:0,cost:0};
  let coins,usdc;
  try{if(r.direction==='yeet'){coins=units(r.settled_out_raw,d);usdc=units(r.amount_in_raw,6)}else{coins=units(r.amount_in_raw,d);usdc=units(r.settled_out_raw,6)}}catch{continue}
  if(!(coins>0)||!(usdc>=0))continue;
  if(r.direction==='yeet'){p.qty+=coins;p.cost+=usdc;positions.set(key,p);continue}
  if(!(p.qty>0))continue;
  const covered=Math.min(coins,p.qty),cost=p.cost*covered/p.qty,proceeds=usdc*covered/coins;
  p.qty-=covered;p.cost-=cost;if(p.qty<1e-12){p.qty=0;p.cost=0}
  positions.set(key,p);
  if(cost>0)sales.push({accountId:r.account_id,symbol:r.symbol,tradeId:r.trade_id,at:Number(r.updated_at),pnl_usd:proceeds-cost,pct:(proceeds/cost-1)*100,cost_usd:cost});
 }
 return {positions,sales};
}
/** Every SKEET sale with a known cost that settled at or after `since` (ms; null: all), every account. */
export const sales=(db,catalog,{since=null}={})=>walk(db,catalog).sales.filter(s=>since===null||s.at>=since);
/** Settled YEET legs at or after `since`, per coin: [{symbol, usdc, people}] (USDC spent, distinct accounts). */
export function yeeted(db,catalog,{since=null}={}){
 const rows=db.prepare(`${SETTLED} AND t.direction='yeet'${since===null?'':' AND l.updated_at>=?'}`).all(...(since===null?[]:[since]));
 const by=new Map();
 for(const r of rows){
  if(coinDecimals(catalog,r.symbol)===null)continue;
  let usdc;try{usdc=units(r.amount_in_raw,6)}catch{continue}
  const c=by.get(r.symbol)??{symbol:r.symbol,micro:0,accounts:new Set()};c.micro+=Math.round(usdc*1e6);c.accounts.add(r.account_id);by.set(r.symbol,c);
 }
 return [...by.values()].map(c=>({symbol:c.symbol,usdc:Math.round(c.micro/1e4)/100,people:c.accounts.size}));
}
/** One account's average YEET price per held coin: Map(symbol -> USD per coin). */
export function averageCost(db,catalog,accountId){
 const out=new Map();
 for(const [key,p] of walk(db,catalog,{accountId}).positions){if(p.qty>0&&p.cost>0)out.set(key.slice(key.indexOf('|')+1),p.cost/p.qty)}
 return out;
}
/** The held coin that is up the most against its average YEET price: {symbol, pct, since:'buy'} or null.
 * holdings: yeet_portfolio's [{symbol, amount, usd}] (usd null: no live price). */
export function winnerOf(holdings,avg){
 let best=null;
 for(const h of holdings??[]){
  const a=avg.get(h.symbol),amount=Number(h.amount),usd=Number(h.usd);
  if(!a||h.usd===null||!(amount>0)||!Number.isFinite(usd))continue;
  const pct=(usd/amount/a-1)*100;
  if(pct>0&&(!best||pct>best.pct))best={symbol:h.symbol,pct:Math.min(1_000_000,Math.round(pct*10)/10),since:'buy'};
 }
 return best&&best.pct>0?best:null;
}

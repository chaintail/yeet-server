// yeet_leaderboard: one answer per board and window (owner, voice 39611: "multiple leaderboards, not just by XP. Biggest
// daily winner in dollar amount. Biggest percentage trade win. Biggest loser. And also a seven days").
//
//   xp          XP earned (xp.sqlite), all time, the last 7 days or today
//   winners     most USDC made on SKEETs in the window          } realised on SKEETs against the average YEET cost
//   best_trade  biggest percent win on one SKEET in the window  } of the coins sold (trade/pnl.mjs); coins still held
//   losers      most USDC lost on SKEETs in the window          } are not counted, because no price history is stored
//   coins       USDC yeeted into each coin in the window (settled YEET legs): what other people are yeeting
//
// Windows: `today` is the current UTC day (the same day the daily spin uses), `7d` the last 7 x 24 hours, `all`
// everything (xp only). Each answer names its measure in one sentence; the card prints it under the rows.
// Names are the board names (username or default handle): no account id, email or address.
import {BOARD_ROWS,WEEK_MS} from './board.mjs';
import {sales,yeeted} from '../trade/pnl.mjs';

export const BOARDS=Object.freeze(['xp','winners','best_trade','losers','coins']);
const WINDOW_WORDS={today:'today (UTC)','7d':'in the last 7 days',all:'of all time'};
/** Start of the window in ms, or null for all time. */
export function windowStart(window,now){
 if(window==='today')return Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate());
 if(window==='7d')return now-WEEK_MS;
 return null;
}
export const MEASURE=Object.freeze({
 xp:w=>w==='all'?'XP earned, all time.':`XP earned ${WINDOW_WORDS[w]}.`,
 winners:w=>`USDC made on SKEETs ${WINDOW_WORDS[w]}: USDC received minus the average YEET cost of the coins sold. Coins still held are not counted.`,
 best_trade:w=>`Biggest percent win on one SKEET ${WINDOW_WORDS[w]}: USDC received against the average YEET cost of the coins sold.`,
 losers:w=>`USDC lost on SKEETs ${WINDOW_WORDS[w]}: USDC received minus the average YEET cost of the coins sold. Coins still held are not counted.`,
 coins:w=>`USDC yeeted into each coin ${WINDOW_WORDS[w]}, from YEETs that landed.`,
});
const cents=n=>{const v=Math.round(Math.abs(n)*100)/100;return `${n<0&&v>0?'-':''}${Math.min(v,999_999_999.99).toFixed(2)}`};
const pct1=n=>Math.max(-100,Math.min(1_000_000,Math.round(n*10)/10));
/** Ranks rows already sorted best first: equal values share a rank (1, 2, 2, 4). */
function ranked(rows,key){let seen=0,rank=0,prev=null;for(const r of rows){seen++;if(r[key]!==prev)rank=seen;r.rank=rank;prev=r[key]}return rows}

/** board 'week' is xp over 7d (the older name). The default window: all for xp, today for the others. */
export function normalize(board='xp',window){
 if(board==='week')return {board:'xp',window:'7d'};
 const b=BOARDS.includes(board)?board:'xp';
 const w=['today','7d','all'].includes(window)?window:b==='xp'?'all':'today';
 return {board:b,window:b!=='xp'&&w==='all'?'today':w};
}
/**
 * x: the XP runtime (board, total). db and catalog: the trade database and coin catalogue (engine.db, engine.catalog).
 * names(accountId): the name a row shows. Returns the yeet_leaderboard structuredContent.
 */
export function boardAnswer({x,db,catalog,who,board,window,names,now=Date.now()}){
 const n=normalize(board,window),since=windowStart(n.window,now);
 const head={board:n.board,window:n.window,unit:n.board==='xp'?'xp':n.board==='best_trade'?'pct':'usd',measure:MEASURE[n.board](n.window)};
 if(n.board==='xp')return {...x.board('xp',who,names,since===null?null:new Date(since).toISOString()),...head};
 const myXp=x.total(who);
 if(n.board==='coins'){
  const rows=ranked(yeeted(db,catalog,{since}).sort((a,b)=>b.usdc-a.usdc||a.symbol.localeCompare(b.symbol)),'usdc').slice(0,BOARD_ROWS);
  return {rows:rows.map(r=>({rank:r.rank,name:r.symbol,symbol:r.symbol,usd:cents(r.usdc),people:r.people})),me:{rank:null,xp:myXp},...head};
 }
 const all=sales(db,catalog,{since});
 let rows;
 if(n.board==='best_trade'){
  // Each person's best single SKEET, winners only.
  const best=new Map();for(const s of all)if(s.pct>0&&(!best.has(s.accountId)||s.pct>best.get(s.accountId).pct))best.set(s.accountId,s);
  rows=ranked([...best.values()].map(s=>({id:s.accountId,value:pct1(s.pct),symbol:s.symbol})).sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id)),'value');
 }else{
  const sum=new Map();for(const s of all)sum.set(s.accountId,(sum.get(s.accountId)??0)+s.pnl_usd);
  const lose=n.board==='losers';
  rows=ranked([...sum].map(([id,v])=>({id,value:Math.round(v*100)/100})).filter(r=>lose?r.value<0:r.value>0).sort((a,b)=>(lose?a.value-b.value:b.value-a.value)||a.id.localeCompare(b.id)),'value');
 }
 const field=r=>n.board==='best_trade'?{pct:r.value,symbol:r.symbol}:{usd:cents(r.value)};
 const mine=rows.find(r=>r.id===who);
 return {rows:rows.slice(0,BOARD_ROWS).map(r=>({rank:r.rank,name:names(r.id),...field(r)})),me:{rank:mine?mine.rank:null,xp:myXp,...(mine?field(mine):{})},...head};
}

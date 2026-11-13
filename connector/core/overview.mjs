// yeet_overview: what the assistant reads first when the person opens YEET, says "@yeet", asks "How do I win?" or
// comes back (owner, voice 39611: "the first thing ChatGPT should be doing is calling an MCP function that's like get
// user overview"). One number for USDC (every network added up), no wallet and no chain named, and the next actions to
// offer as follow-ups, ordered by the person's state.
const MICRO=/^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/;
const micro=v=>{const m=typeof v==='string'?MICRO.exec(v):null;return m?BigInt(m[1])*1_000_000n+BigInt((m[2]??'').padEnd(6,'0')):null};
const fmt=raw=>{const s=`${raw/1_000_000n}.${String(raw%1_000_000n).padStart(6,'0')}`.replace(/\.?0+$/,'');return s===''?'0':s};
const CAP=999_999_999_999n;
/** All the person's USDC as one decimal string: the sum of what could be read; null when nothing could. */
export function totalUsdc(...amounts){
 const known=amounts.map(micro).filter(v=>v!==null);
 if(!known.length)return null;
 const sum=known.reduce((a,b)=>a+b,0n);
 return fmt(sum>CAP?CAP:sum);
}
/** The follow-ups, as the owner said them. `say` is what the person would type to pick one. */
export const SUGGESTIONS=Object.freeze({
 checkin:Object.freeze({id:'checkin',label:'Do your daily check-in',say:'Do my daily check-in'}),
 holdings:Object.freeze({id:'holdings',label:'Review your meme holdings',say:'Show my meme holdings'}),
 discover:Object.freeze({id:'discover',label:'Discover a new coin to yeet',say:'Help me find a new coin to yeet'}),
 fund:Object.freeze({id:'fund',label:'Fund my account',say:'Fund my account'}),
 others:Object.freeze({id:'others',label:'See what other people are yeeting',say:'What are other people yeeting?'}),
});
/**
 * Order by state: no USDC -> funding first; a daily check-in still open -> the check-in first (after funding when
 * both hold); holdings before discovery only when the person holds a coin. A check-in already done today goes last.
 * `wheel` and `board`: whether the check-in and the leaderboard exist in this deployment.
 */
export function suggestionsFor({usdc,checkinOpen,holdings,wheel=true,board=true}){
 const broke=usdc!==null&&micro(usdc)===0n,S=SUGGESTIONS,out=[];
 if(broke)out.push(S.fund);
 if(wheel&&checkinOpen)out.push(S.checkin);
 if(holdings>0)out.push(S.holdings,S.discover);else out.push(S.discover,S.holdings);
 if(!broke)out.push(S.fund);
 if(board)out.push(S.others);
 return out.slice(0,5);
}
/**
 * home: the pipeline's yeet_home answer (funding, ready, limits). bag: yeet_portfolio's answer or null. xp: the XP
 * summary or null. winner: pnl.mjs winnerOf or null. username: the name a board shows.
 */
export function overview({home,bag=null,xp=null,winner=null,username,wheel=true,board=true}){
 const f=home.funding??null;
 const usdc=f?totalUsdc(f.base_usdc,f.solana_usdc):totalUsdc(home.wallets?.base?.usdc);
 const coins=bag?(bag.solana?.holdings??[]).filter(h=>h.symbol!=='USDC'&&Number(h.amount)>0):null;
 const spins=xp?(Number.isInteger(xp.spins_available)?xp.spins_available:xp.spin_available?1:0):0;
 const checkinOpen=xp&&wheel?spins>0:null;
 return {
  username:String(username).slice(0,32),usdc,
  xp:xp?xp.total:null,tier:home.limits?.tier??'Noob',streak_days:xp?xp.streak_days:null,checkin_open:checkinOpen,
  holdings_count:coins?Math.min(64,coins.length):null,top_winner:winner,
  trading:home.ready==='paused'?'paused':'live',needs_card_sign_in:'unknown',
  suggestions:suggestionsFor({usdc,checkinOpen:checkinOpen===true,holdings:coins?.length??0,wheel:wheel&&!!xp,board}),
 };
}

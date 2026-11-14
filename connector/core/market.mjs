// Market data for the coins in YEET's own catalogue, read server-side from free public endpoints with no key:
//
//   Jupiter Tokens API V2   GET https://api.jup.ag/tokens/v2/search?query=<mints, comma separated, up to 100>
//     per mint: usdPrice, stats1h / stats6h / stats24h .priceChange (percent), mcap, liquidity, buy and sell volume,
//     and for some coins website and twitter. Keyless: 0.5 requests a second (30 a minute, 60 s sliding window).
//     One request covers the whole catalogue, kept for 45 s. (Jupiter's Price API V3 has the price and only the
//     24 hour change, so it is not used.)
//   GeckoTerminal public API  https://api.geckoterminal.com/api/v2/networks/solana  (beta, about 10 calls a minute)
//     /tokens/<mint>/info                     description, websites, twitter_handle       kept 10 minutes
//     /tokens/<mint>/pools                    the coin's pools, most liquid first          kept 24 hours
//     /pools/<pool>/ohlcv/hour?limit=24       24 hourly closes in USD: the coin card's chart   kept 3 minutes
//
// Only catalogue mints are ever looked up. Every call has a deadline; a failure answers null (the card hides what is
// missing, the model is told the price could not be read) and is not retried for 15 s. Nothing here is invented: a
// number the source does not have stays null. YEET_MARKET_DATA=off turns every lookup off (tests, an outage).
//
// The description is third-party text. cleanText() strips links, markup and control characters and cuts it to 280
// characters; it goes to the model only as data in the `description` field, never into guidance or instructions.

export const WRAPPED_SOL='So11111111111111111111111111111111111111112';
const JUPITER='https://api.jup.ag/tokens/v2/search';
const GECKO='https://api.geckoterminal.com/api/v2/networks/solana';
const MINT=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SECOND=1000,MINUTE=60*SECOND;

/** The Solana mint a catalogue entry is priced by; null for a coin that is not on Solana. SOL itself has no mint in
 * the catalogue: its price is the wrapped SOL mint's, as Jupiter lists it. */
export function mintOf(entry){
 if(entry?.chain!=='solana')return null;
 const mint=entry.address??(entry.symbol==='SOL'?WRAPPED_SOL:null);
 return typeof mint==='string'&&MINT.test(mint)?mint:null;
}
const finite=v=>typeof v==='number'&&Number.isFinite(v);
/** A USD price as a plain decimal string with six significant digits ("0.000534157", "75.8288"); null when unknown. */
export function priceString(n){
 if(!finite(n)||n<=0||n>=1e18)return null;
 const decimals=Math.min(18,Math.max(0,5-Math.floor(Math.log10(n))));
 const s=n.toFixed(decimals);
 const out=s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s;
 return /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$/.test(out)&&Number(out)>0?out:null;
}
/** A percent change with two decimals; null when the source has none or it is out of any sane range. */
export function pct(n){return finite(n)&&n>=-100&&n<=1_000_000?Math.round(n*100)/100:null}
const usd=n=>finite(n)&&n>=0&&n<1e15?Math.round(n*100)/100:null;
/** https only, no credentials, no whitespace, at most 200 characters; anything else is null. */
export function httpsUrl(v){
 if(typeof v!=='string'||v.length>200||/[\s<>"'`\\]/.test(v))return null;
 try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')?u.href:null}catch{return null}
}
/** A coin's X profile from a handle or a twitter.com / x.com link: always https://x.com/<handle>; anything else is null. */
export function xUrl(v){
 if(typeof v!=='string')return null;
 const m=/^(?:https?:\/\/(?:www\.)?(?:twitter|x)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/.exec(v.trim());
 return m?`https://x.com/${m[1]}`:null;
}
/** Third-party text made plain: no links, no markup, no control or invisible characters, one line, at most `max`
 * characters, cut at a word with an ellipsis. Null when nothing readable is left. */
export function cleanText(v,max=280){
 if(typeof v!=='string')return null;
 let s=v.normalize('NFKC')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufff9-\ufffb\ufeff]/g,' ')
  .replace(/<[^>]{0,200}>/g,' ')                                   // tags
  .replace(/!?\[([^\]]{0,200})\]\([^)]{0,500}\)/g,'$1')             // markdown links and images keep their words
  .replace(/\b(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.)\S+/gi,' ')      // links
  .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|xyz|fun|app|win|co|gg|me|finance|money|link)\b(?:\/\S*)?/gi,' ')
  .replace(/[<>`*_#~|\\{}\[\]]/g,' ')                               // what is left of markup
  .replace(/\s+/g,' ').trim();
 if(!/[\p{L}\p{N}]/u.test(s))return null;
 if(s.length>max){s=s.slice(0,max-1);const cut=s.lastIndexOf(' ');s=`${(cut>max*0.6?s.slice(0,cut):s).replace(/[\s.,;:!?-]+$/,'')}…`}
 return s;
}

/**
 * The feed. `entries`: catalogue entries ({symbol, chain, address}).
 *   quotes(entries)  -> {as_of, bySymbol: Map(symbol -> {price_usd, change_pct, market_cap_usd, volume_24h_usd, liquidity_usd, website, x})}
 *   profile(entry)   -> {description, website, x} or null
 *   history(entry)   -> [24 hourly prices, oldest first] or null
 * as_of is null and the map empty when the prices could not be read.
 */
export function createMarket({fetch:fetchImpl=globalThis.fetch,now=Date.now,env=process.env,timeoutMs=4000,priceTtl=45*SECOND,profileTtl=10*MINUTE,historyTtl=3*MINUTE,
 poolTtl=24*60*MINUTE,failTtl=15*SECOND,geckoPerMinute=8,log=e=>console.error(JSON.stringify(e))}={}){
 const off=()=>env.YEET_MARKET_DATA==='off';
 const cache=new Map();       // key -> {at, ttl, value} | {promise}
 const geckoCalls=[];         // times of the last GeckoTerminal calls (the public API allows about 10 a minute)
 async function getJson(url){
  const r=await fetchImpl(url,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw Error(`HTTP ${r.status}`);
  return r.json();
 }
 /** One read per key at a time; a good answer is kept for `ttl`, a failure (null) for failTtl. */
 function cached(key,ttl,read){
  const hit=cache.get(key);
  if(hit?.promise)return hit.promise;
  if(hit&&now()-hit.at<hit.ttl)return Promise.resolve(hit.value);
  const promise=(async()=>{
   let value=null;
   try{value=await read()}catch(e){log({event:'market_read_failed',key:key.slice(0,80),error:String(e?.message??e).slice(0,120)})}
   cache.set(key,{at:now(),ttl:value===null?failTtl:ttl,value});
   return value;
  })();
  cache.set(key,{promise});
  return promise;
 }
 function gecko(path){
  const t=now();
  while(geckoCalls.length&&t-geckoCalls[0]>=MINUTE)geckoCalls.shift();
  if(geckoCalls.length>=geckoPerMinute)throw Error('local rate limit');
  geckoCalls.push(t);
  return getJson(`${GECKO}${path}`);
 }
 const EMPTY=Object.freeze({as_of:null,bySymbol:new Map()});
 async function quotes(entries){
  if(off())return EMPTY;
  const wanted=entries.map(e=>[e.symbol,mintOf(e)]).filter(([,m])=>m).slice(0,100);
  if(!wanted.length)return EMPTY;
  const mints=[...new Set(wanted.map(([,m])=>m))].sort();
  const read=await cached(`jupiter:${mints.join(',')}`,priceTtl,async()=>{
   const list=await getJson(`${JUPITER}?query=${mints.join(',')}`);
   if(!Array.isArray(list))throw Error('unexpected answer');
   const byMint=new Map();
   for(const t of list){
    if(!t||typeof t.id!=='string'||!mints.includes(t.id))continue;
    const buy=t.stats24h?.buyVolume,sell=t.stats24h?.sellVolume;
    byMint.set(t.id,{price_usd:priceString(t.usdPrice),
     change_pct:{h1:pct(t.stats1h?.priceChange),h6:pct(t.stats6h?.priceChange),h24:pct(t.stats24h?.priceChange)},
     market_cap_usd:usd(t.mcap),volume_24h_usd:finite(buy)||finite(sell)?usd((finite(buy)?buy:0)+(finite(sell)?sell:0)):null,liquidity_usd:usd(t.liquidity),
     website:httpsUrl(t.website),x:xUrl(t.twitter)});
   }
   if(![...byMint.values()].some(q=>q.price_usd))throw Error('no price in the answer');
   return {as_of:new Date(now()).toISOString().replace(/\.\d+Z$/,'Z'),byMint};
  });
  if(!read)return EMPTY;
  // A coin the source has no price for is left out: its change numbers without a price would mean nothing.
  return {as_of:read.as_of,bySymbol:new Map(wanted.filter(([,m])=>read.byMint.get(m)?.price_usd).map(([s,m])=>[s,read.byMint.get(m)]))};
 }
 async function profile(entry){
  const mint=mintOf(entry);
  if(off()||!mint)return null;
  return cached(`profile:${mint}`,profileTtl,async()=>{
   const a=(await gecko(`/tokens/${mint}/info`))?.data?.attributes;
   if(!a||typeof a!=='object')throw Error('unexpected answer');
   const sites=Array.isArray(a.websites)?a.websites:[];
   return {description:cleanText(a.description),website:sites.map(httpsUrl).find(Boolean)??null,x:xUrl(a.twitter_handle)};
  });
 }
 async function history(entry){
  const mint=mintOf(entry);
  if(off()||!mint)return null;
  const pool=await cached(`pool:${mint}`,poolTtl,async()=>{
   const first=(await gecko(`/tokens/${mint}/pools?page=1`))?.data?.[0]?.attributes?.address;
   if(typeof first!=='string'||!MINT.test(first))throw Error('no pool');
   return first;
  });
  if(!pool)return null;
  return cached(`history:${mint}`,historyTtl,async()=>{
   const rows=(await gecko(`/pools/${pool}/ohlcv/hour?aggregate=1&limit=24&currency=usd&token=${mint}`))?.data?.attributes?.ohlcv_list;
   if(!Array.isArray(rows))throw Error('unexpected answer');
   // [time, open, high, low, close, volume], newest first: the closes, oldest first.
   const points=rows.filter(r=>Array.isArray(r)&&finite(r[0])&&finite(r[4])&&r[4]>0).sort((a,b)=>a[0]-b[0]).slice(-24).map(r=>Number(r[4].toPrecision(6)));
   if(points.length<2)throw Error('too few points');
   return points;
  });
 }
 return {quotes,profile,history};
}

// The daily wheel's commit-reveal draw, server half (yeet-win docs/FAIR-WHEEL.md; the public check is yeet-win
// packages/fair/fair.mjs, and fair.test.mjs holds both to the same vectors). The server publishes
// commitment = SHA-256(server_seed) before the spin, takes the card's client_seed, draws from
// HMAC-SHA256(server_seed, client_seed + ":" + spin_id) by rejection sampling, and reveals server_seed after the spin.
import {createHash,createHmac,randomBytes} from 'node:crypto';

export const FAIR_VERSION='yeet-fair-1';
export const SPIN_ID=/^s_[0-9a-f]{24}$/;
export const SERVER_SEED=/^[0-9a-f]{64}$/;
export const CLIENT_SEED=/^[0-9A-Za-z_-]{8,64}$/;
export const MAX_BLOCKS=16;
const TWO32=2**32;

/** Whether the switch is on: YEET_FAIR_WHEEL=on (default off). */
export const fairWheelOn=(env=process.env)=>env.YEET_FAIR_WHEEL==='on';
export const commitmentOf=seed=>createHash('sha256').update(seed,'utf8').digest('hex');
export const message=(clientSeed,spinId,block=0)=>block?`${clientSeed}:${spinId}:${block}`:`${clientSeed}:${spinId}`;
export function blockWords(serverSeed,clientSeed,spinId,block=0){
 const d=createHmac('sha256',Buffer.from(serverSeed,'utf8')).update(message(clientSeed,spinId,block),'utf8').digest();
 return Array.from({length:8},(_,i)=>d.readUInt32BE(i*4));
}
export const newServerSeed=()=>randomBytes(32).toString('hex');
export const newSpinId=()=>'s_'+randomBytes(12).toString('hex');
/** The client seed the server picks for a card that sent none (an older card); the reveal says so. */
export const serverClientSeed=()=>randomBytes(16).toString('hex');

/** The draw from `words`, or null when they run out: bonus XP by weight, coin uniform, streak draw by weight. */
export function drawFromWords(words,{weights,coins}){
 if(!Array.isArray(coins)||!coins.length)throw Error('fair draw: no coins');
 for(const r of weights)if(!Number.isInteger(r.weight)||r.weight<=0)throw Error('fair draw: weights must be whole and above 0');
 let i=0;
 const uniform=n=>{const limit=TWO32-(TWO32%n);while(i<words.length){const u=words[i++];if(u<limit)return u%n}return null};
 const total=weights.reduce((a,r)=>a+r.weight,0);
 const pick=()=>{let r=uniform(total);if(r===null)return null;for(const row of weights){if(r<row.weight)return row.xp;r-=row.weight}return null};
 const draw_xp=pick();if(draw_xp===null)return null;
 const coin_index=uniform(coins.length);if(coin_index===null)return null;
 const streak_draw_xp=pick();if(streak_draw_xp===null)return null;
 return {draw_xp,coin:coins[coin_index],coin_index,streak_draw_xp,words_used:i};
}
/** One spin's outcome from its seeds: {draw_xp, coin, coin_index, streak_draw_xp, words_used}. */
export function fairOutcome({serverSeed,clientSeed,spinId,coins,weights}){
 const words=[];
 for(let k=0;k<MAX_BLOCKS;k+=1){words.push(...blockWords(serverSeed,clientSeed,spinId,k));const r=drawFromWords(words,{weights,coins});if(r)return r}
 throw Error('fair draw: no draw within the block limit');
}
/**
 * The wheel after the draw: the committed layout with the drawn XP moved onto the drawn coin's slice (the two slices
 * swap values, so every value still shows once). Returns {wheel, slice}.
 */
export function landedWheel(layout,coin,draw_xp){
 const wheel=layout.map(s=>({...s}));
 const slice=wheel.findIndex(s=>s.coin===coin);
 if(slice<0)throw Error('fair draw: coin not on the wheel');
 const j=wheel.findIndex(s=>s.xp===draw_xp);
 if(j>=0&&j!==slice)wheel[j].xp=wheel[slice].xp;
 wheel[slice].xp=draw_xp;
 return {wheel,slice};
}

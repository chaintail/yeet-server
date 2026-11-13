// Leaderboards: all-time XP and the last 7 days. Equal XP shares a rank (1, 2, 2, 4); order within a tie is by name.
// Names are short handles derived from a one-way hash of the account id: no email, wallet address or sign-in id
// appears on a board.
import {createHash} from 'node:crypto';

export const BOARD_ROWS=50;
export const WEEK_MS=7*86_400_000;

const ADJECTIVES=['Lucky','Swift','Brave','Sunny','Cosmic','Fuzzy','Jolly','Mighty','Rapid','Zesty','Witty','Bold',
 'Calm','Daring','Eager','Fancy','Gentle','Happy','Icy','Keen','Lively','Merry','Nimble','Plucky','Quick','Rowdy',
 'Snappy','Tidy','Vivid','Wild','Zippy','Breezy'];
const ANIMALS=['Otter','Falcon','Panda','Gecko','Lynx','Moose','Koala','Badger','Heron','Bison','Corgi','Dolphin',
 'Ferret','Gopher','Hippo','Ibis','Jaguar','Lemur','Marmot','Narwhal','Ocelot','Puffin','Quokka','Raven','Shark',
 'Tapir','Walrus','Yak','Zebra','Beaver','Crab','Frog'];

/** Display handle for an account, e.g. "Lucky Otter 42". Depends only on a SHA-256 of the account id. */
export function handle(accountId){
 const h=createHash('sha256').update(`yeet-handle|${accountId}`).digest();
 return `${ADJECTIVES[h[0]%ADJECTIVES.length]} ${ANIMALS[h[1]%ANIMALS.length]} ${String(h.readUInt16BE(2)%100).padStart(2,'0')}`;
}

/** Ranks rows sorted by xp descending: a row with the same xp as the one above shares its rank. Mutates and returns. */
export function rankRows(rows){
 rows.sort((a,b)=>b.xp-a.xp||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
 let seen=0,rank=0,previous=null;
 for(const row of rows){seen++;if(row.xp!==previous)rank=seen;row.rank=rank;previous=row.xp}
 return rows;
}

/** `kind` 'xp' (all time) or 'week' (last 7 days to `at`). Returns the contract shape {rows, me}. */
export function leaderboard(db,{kind='xp',me,at=Date.now(),names=handle,since:from=null}={}){
 // `since` (an ISO time) narrows the xp board to a window (boards.mjs: today, 7d); 'week' is the older name for 7d.
 const since=from??(kind==='week'?new Date(at-WEEK_MS).toISOString():null);
 const sums=db.prepare(`SELECT identity_id id,SUM(points) xp FROM xp_event ${since?'WHERE ts>=?':''} GROUP BY identity_id HAVING SUM(points)>0`)
  .all(...(since?[since]:[]));
 const rows=rankRows(sums.map(r=>({id:r.id,xp:Number(r.xp),name:names(r.id)})));
 const mine=rows.find(r=>r.id===me);
 return {rows:rows.slice(0,BOARD_ROWS).map(({rank,name,xp})=>({rank,name,xp})),me:mine?{rank:mine.rank,xp:mine.xp}:{rank:null,xp:0}};
}

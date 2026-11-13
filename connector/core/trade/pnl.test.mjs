// trade/pnl.mjs: average cost from settled YEET legs, realised result of SKEET legs, the holding that is up the most.
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTradeDb} from './db.mjs';
import {CATALOG} from './router.mjs';
import {walk,averageCost,winnerOf,coinDecimals} from './pnl.mjs';

const WIF=coinDecimals(CATALOG,'WIF');
let n=0;
/** One settled (or not) single-leg trade. coins and usdc are whole units. */
export function leg(db,{account='yeet-privy-a',direction='yeet',symbol='WIF',coins,usdc,at,status='SUCCESS',settled=true}){
 const id=`t_${String(++n).padStart(20,'0')}`,d=coinDecimals(CATALOG,symbol);
 const coinRaw=String(BigInt(Math.round(coins*1e6))*10n**BigInt(d)/1_000_000n),usdcRaw=String(Math.round(usdc*1e6));
 db.prepare('INSERT INTO trades(id,proposal_id,revision,account_id,direction,status,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)').run(id,`p_${String(n).padStart(20,'0')}`,account,direction,'success',at,at);
 db.prepare(`INSERT INTO trade_legs(trade_id,idx,symbol,amount_in_raw,deposit_address,live_quote_json,send_status,oneclick_status,settled_out_raw,updated_at)
  VALUES(?,0,?,?,?,?,?,?,?,?)`).run(id,symbol,direction==='yeet'?usdcRaw:coinRaw,'dep','{}','sent',status,settled?(direction==='yeet'?coinRaw:usdcRaw):null,at);
 return id;
}

test('coinDecimals: tradable Solana coins only; USDC is never a position',()=>{
 assert.ok(Number.isInteger(WIF));assert.equal(coinDecimals(CATALOG,'USDC'),null);assert.equal(coinDecimals(CATALOG,'NOPE'),null);
});

test('average cost: two YEETs average; a SKEET keeps the average and realises the difference',()=>{
 const db=openTradeDb(':memory:');
 leg(db,{coins:10,usdc:10,at:1000});
 leg(db,{coins:10,usdc:30,at:2000});
 assert.equal(averageCost(db,CATALOG,'yeet-privy-a').get('WIF'),2);
 const sell=leg(db,{direction:'skeet',coins:5,usdc:15,at:3000});
 const {sales,positions}=walk(db,CATALOG);
 assert.equal(sales.length,1);
 assert.deepEqual({...sales[0],pnl_usd:Math.round(sales[0].pnl_usd*1e6)/1e6,pct:Math.round(sales[0].pct*1e6)/1e6},{accountId:'yeet-privy-a',symbol:'WIF',tradeId:sell,at:3000,pnl_usd:5,pct:50,cost_usd:10});
 const p=positions.get('yeet-privy-a|WIF');assert.equal(p.qty,15);assert.equal(p.cost,30);
 assert.equal(averageCost(db,CATALOG,'yeet-privy-a').get('WIF'),2,'a sale does not move the average');
});

test('a loss is negative; unsettled, refunded and unknown-coin legs are ignored; accounts are separate',()=>{
 const db=openTradeDb(':memory:');
 leg(db,{coins:10,usdc:20,at:1});
 leg(db,{coins:99,usdc:99,at:2,status:'REFUNDED'});
 leg(db,{coins:99,usdc:99,at:3,settled:false});
 leg(db,{account:'yeet-privy-b',coins:4,usdc:4,at:4});
 leg(db,{direction:'skeet',coins:10,usdc:15,at:5});
 const {sales}=walk(db,CATALOG);
 assert.equal(sales.length,1);assert.equal(sales[0].pnl_usd,-5);assert.equal(sales[0].pct,-25);
 assert.equal(averageCost(db,CATALOG,'yeet-privy-a').size,0,'everything sold');
 assert.equal(averageCost(db,CATALOG,'yeet-privy-b').get('WIF'),1);
});

test('coins that did not come from a YEET have no cost: that part of a sale is left out, a sale with none is not counted',()=>{
 const db=openTradeDb(':memory:');
 leg(db,{direction:'skeet',coins:5,usdc:50,at:1});
 assert.deepEqual(walk(db,CATALOG).sales,[]);
 leg(db,{coins:10,usdc:10,at:2});
 // Sells 20 but only 10 have a known cost (10 USDC): half the 40 USDC received counts.
 leg(db,{direction:'skeet',coins:20,usdc:40,at:3});
 const {sales}=walk(db,CATALOG);
 assert.equal(sales.length,1);assert.equal(sales[0].cost_usd,10);assert.equal(sales[0].pnl_usd,10);assert.equal(sales[0].pct,100);
});

test('winnerOf: the holding up the most against its average YEET price; none when nothing is up or priced',()=>{
 const avg=new Map([['WIF',2],['BOME',1]]);
 assert.deepEqual(winnerOf([{symbol:'WIF',amount:'10',usd:'25'},{symbol:'BOME',amount:'10',usd:'30'},{symbol:'USDC',amount:'5',usd:'5'}],avg),{symbol:'BOME',pct:200,since:'buy'});
 assert.equal(winnerOf([{symbol:'WIF',amount:'10',usd:'15'}],avg),null,'down is not a winner');
 assert.equal(winnerOf([{symbol:'WIF',amount:'10',usd:null}],avg),null,'no live price');
 assert.equal(winnerOf([{symbol:'PENGU',amount:'10',usd:'99'}],avg),null,'no known cost');
 assert.equal(winnerOf([],avg),null);
});

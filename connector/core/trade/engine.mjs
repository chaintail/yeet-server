// Assembles the trade engine from its modules. Every external system is an injected interface:
//   client    1Click (router OneClickClient or a fake with quote/submitDeposit/status/getTokens)
//   signer    signer.mjs interface (delegated or custodial Privy adapter, or a fake); its directory finds wallets
//   balances  wallets.mjs balances interface (JSON-RPC or a fake)
import {OneClickClient,formatUnits,findToken,CATALOG} from './router.mjs';
import {limitsFromEnv} from './limits.mjs';
import {createConfirmCodes} from './nonce.mjs';
import {createWallets,createRpcBalances} from './wallets.mjs';
import {createProposals} from './proposals.mjs';
import {createExecutor} from './executor.mjs';
import {createTracker} from './tracker.mjs';
import {createSigner} from './signer.mjs';
import {iso,usd,refuse} from './util.mjs';

export const PRICE_TTL_MS=5*60_000;

export async function createEngine({db,env=process.env,client,signer,balances,didFor,now=Date.now,onSettled,trackerIntervalMs=5000,budgetMs,hooks,catalog=CATALOG,fetch=globalThis.fetch}){
 const limits=limitsFromEnv(env);
 client??=new OneClickClient({jwt:env.ONECLICK_JWT||undefined,timeoutMs:6000,retryDelayMs:500});
 balances??=createRpcBalances({baseRpcUrl:env.BASE_RPC_URL,solanaRpcUrl:env.SOLANA_RPC_URL,fetch});
 signer??=await createSigner({env,fetch,balances,didFor,db,now});
 const codes=createConfirmCodes({db,now});
 const wallets=createWallets({db,directory:signer.directory,balances,now});
 const proposals=createProposals({db,client,limits,wallets,codes,now,catalog});
 const tracker=createTracker({db,client,now,onSettled,intervalMs:trackerIntervalMs,trackMaxHours:limits.trackMaxHours});
 const executor=createExecutor({db,client,limits,wallets,signer,codes,proposals,tracker,now,hooks,...(budgetMs?{budgetMs}:{})});
 tracker.useRecovery(id=>executor.recover(id));

 let prices={at:0,bySymbol:new Map()};
 async function priceMap(){
  if(now()-prices.at<PRICE_TTL_MS)return prices.bySymbol;
  try{
   const tokens=await client.getTokens();
   const bySymbol=new Map();
   for(const e of catalog){const t=tokens.find(t=>t.assetId===e.assetId);if(t&&typeof t.price==='number'&&Number.isFinite(t.price))bySymbol.set(e.symbol,t.price)}
   prices={at:now(),bySymbol};
  }catch{/* prices stay unknown */}
  return prices.bySymbol;
 }

 return {
  limits,signer,wallets,proposals,executor,tracker,codes,
  /** yeet_home: wallets, readiness and (until lane E) no XP. */
  async home(ctx){
   const w=await wallets.require(ctx.accountId,{refresh:true});
   let usdc=null;try{usdc=await wallets.usdc(w.base.address)}catch{}
   const ready=limits.killSwitch||!limits.live?'paused':w.base.signerState!=='granted'?'needs_signer':usdc!==null&&usdc<limits.minLegRaw?'needs_funds':'ready';
   return {wallets:{base:{address:w.base.address,usdc:usdc===null?null:usd(formatUnits(usdc,6))},solana:{address:w.solana.address}},ready,xp:null,recent_wins:[]};
  },
  propose:(ctx,body)=>proposals.propose(ctx,body),
  skeet:(ctx,body)=>proposals.skeet(ctx,body),
  quote:(ctx,body)=>proposals.quote(ctx,body),
  execute:(ctx,body)=>executor.execute(ctx,body),
  status:(ctx,id)=>tracker.status(ctx,id),
  /** yeet_portfolio: catalogue coins held on Solana, USDC on Base, values from 1Click /tokens prices when known. */
  async portfolio(ctx){
   const w=await wallets.require(ctx.accountId);
   const [held,usdc,px]=await Promise.all([wallets.holdings(w.solana.address),wallets.usdc(w.base.address).catch(()=>null),priceMap()]);
   const holdings=[];
   for(const e of catalog.filter(e=>e.chain==='solana'&&e.kind!=='funding'&&e.address)){
    const raw=held.filter(h=>h.mint===e.address).reduce((a,h)=>a+h.raw,0n);
    if(raw<=0n)continue;
    const amount=formatUnits(raw,e.decimals),p=px.get(e.symbol);
    holdings.push({symbol:e.symbol,amount,usd:p===undefined?null:usd((Number(amount)*p).toFixed(6))});
   }
   const top=holdings.slice(0,25);
   const priced=top.every(h=>h.usd!==null)&&usdc!==null;
   const total=priced?usd((top.reduce((a,h)=>a+Number(h.usd),0)+Number(formatUnits(usdc,6))).toFixed(6)):null;
   return {solana:{address:w.solana.address,holdings:top},base:{address:w.base.address,usdc:usdc===null?null:usd(formatUnits(usdc,6))},total_usd:total,priced_at:iso(now())};
  },
 };
}
export {findToken,refuse};

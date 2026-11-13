// Proposals: yeet_propose and skeet_propose create one from a DRY router plan (no deposit address, nothing moves);
// yeet_quote adds a revision with a fresh dry quote. Idempotent on (account, client, request_id): the same request
// returns the same proposal, a different payload under the same request_id is INVALID_ARGUMENT. Every answer carries
// a new one-time confirm code that the connector moves to the card-only `_meta`.
import {buildYeetPlan,buildSkeetPlan,PlanValidationError,PlanQuoteError,CATALOG,findToken,parseUnits,formatUnits,splitByParts,MAX_PARTS} from './router.mjs';
import {checkKillSwitch,checkLegCount,checkBasket,checkCost,checkDaily,costBps,COST_WARN_BPS} from './limits.mjs';
import {refuse,sha256,newId,iso,usd,usdRaw,TradeError} from './util.mjs';
import {tx} from './db.mjs';

export const NEXT={yeet:'Tap ⚡ YEET in the card',skeet:'Tap SKEET in the card'};

/** Router failures as catalogue codes. */
export async function routed(fn){
 try{return await fn()}
 catch(e){
  if(e instanceof TradeError)throw e;
  if(e instanceof PlanValidationError)refuse(/symbol/.test(e.field)?'COIN_NOT_SUPPORTED':'INVALID_ARGUMENT',e.message);
  if(e instanceof PlanQuoteError){
   const text=e.failures.map(f=>f.error?.message??'').join(' ');
   if(/too low|minimum/i.test(text))refuse('AMOUNT_TOO_SMALL',text);
   refuse('TEMPORARILY_UNAVAILABLE',text);
  }
  refuse('TEMPORARILY_UNAVAILABLE',e?.message);
 }
}

/** Hash of what a confirm code approves: proposal, revision and each leg's coin, exact input and minimum output. */
export const quoteHash=(proposalId,revision,legs)=>sha256({proposalId,revision,legs:legs.map(l=>({symbol:l.symbol,asset:l.asset_id,in:l.amount_in_raw,min:l.dry_min_out_raw}))});

export function createProposals({db,client,limits,wallets,codes,now=Date.now,catalog=CATALOG}){
 const coin=symbol=>{const t=findToken(symbol,'solana',catalog);if(!t||t.kind==='funding')refuse('COIN_NOT_SUPPORTED',symbol);return t};
 const legsOf=(id,revision)=>db.prepare('SELECT * FROM proposal_legs WHERE proposal_id=? AND revision=? ORDER BY idx').all(id,revision);
 const row=id=>db.prepare('SELECT * FROM proposals WHERE id=?').get(id);
 const deps=()=>({client,catalog,now:()=>new Date(now())});

 function validateYeetLegs(legs){
  checkLegCount(limits,legs?.length);
  const seen=new Set();
  const tokens=legs.map(l=>{const t=coin(l.symbol);if(seen.has(t.assetId))refuse('INVALID_ARGUMENT','duplicate coin');seen.add(t.assetId);return t});
  // Parts are a free ratio of whole numbers: 0-99 per coin, each coin gets parts / sum(parts), a coin at 0 is left out.
  if(legs.some(l=>!Number.isInteger(l.parts)||l.parts<0||l.parts>MAX_PARTS))refuse('INVALID_ARGUMENT','parts');
  if(!legs.some(l=>l.parts>0))refuse('PARTS_EMPTY');
  return tokens;
 }
 /** USDC per coin that is in the trade (parts > 0), split in micro-units like the router: remainder to the largest leg. */
 const legShares=(total,legs)=>splitByParts(total,legs.filter(l=>l.parts>0).map(l=>l.parts));
 function amountRaw(amount){
  let raw;try{raw=parseUnits(amount,6)}catch{refuse('INVALID_ARGUMENT','amount')}
  if(raw<=0n)refuse('INVALID_ARGUMENT','amount');
  return raw;
 }
 /** Leg rows for one revision from a router plan (dry or live). */
 function legRows(plan,{percents}={}){
  const t=now();
  return plan.legs.map((l,i)=>{
   const coinSide=plan.direction==='yeet'?l.destination:l.origin;
   return {idx:i,symbol:l.symbol,asset_id:coinSide.assetId,parts:plan.direction==='yeet'?l.parts??null:null,percent:percents?.[i]??null,
    amount_in_raw:l.amountIn,amount_in:formatUnits(BigInt(l.amountIn),l.origin.decimals),in_usd:l.amountInUsd,
    dry_out_raw:l.amountOut,dry_out:formatUnits(BigInt(l.amountOut),l.destination.decimals),
    dry_min_out_raw:l.minAmountOut,dry_min_out:formatUnits(BigInt(l.minAmountOut),l.destination.decimals),
    out_usd:l.amountOutUsd,time_estimate_s:Math.max(0,Math.round(l.timeEstimate)),quoted_at:t};
  });
 }
 const sumUsdRaw=(legs,key)=>legs.reduce((a,l)=>a+usdRaw(l[key]),0n);
 const legsCost=legs=>costBps(sumUsdRaw(legs,'in_usd'),sumUsdRaw(legs,'out_usd'));
 function insertRevision(id,revision,legs){
  const ins=db.prepare('INSERT INTO proposal_legs(proposal_id,revision,idx,symbol,asset_id,parts,percent,amount_in_raw,amount_in,in_usd,dry_out_raw,dry_out,dry_min_out_raw,dry_min_out,out_usd,time_estimate_s,quoted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(const l of legs)ins.run(id,revision,l.idx,l.symbol,l.asset_id,l.parts,l.percent,l.amount_in_raw,l.amount_in,l.in_usd,l.dry_out_raw,l.dry_out,l.dry_min_out_raw,l.dry_min_out,l.out_usd,l.time_estimate_s,l.quoted_at);
 }
 /** Warnings that depend on the person's wallet: balance and signer. Failures to read the balance add none. */
 async function walletWarnings(w,direction,amount){
  const out=[];
  if(direction==='yeet'&&w){try{if(await wallets.usdc(w.base.address)<amount)out.push('BALANCE_LOW')}catch{}}
  if(w&&w.base.signerState!=='granted')out.push('SIGNER_MISSING');
  return out;
 }

 /** The contract `proposal` for a stored revision. */
 function view(p,revision,extraWarnings=[]){
  const legs=legsOf(p.id,revision);
  const bps=legsCost(legs);
  const warnings=[];
  if(bps>COST_WARN_BPS)warnings.push('COST_HIGH');
  if(p.direction==='yeet'&&legs.some(l=>BigInt(l.amount_in_raw)<2n*limits.minLegRaw))warnings.push('LEG_SMALL');
  for(const w of extraWarnings)if(!warnings.includes(w))warnings.push(w);
  return {
   proposal_id:p.id,revision,direction:p.direction,
   amount_usdc:p.direction==='yeet'?formatUnits(BigInt(p.amount_in_raw),6):usd(formatUnits(sumUsdRaw(legs,'in_usd'),12)),
   ...(p.direction==='yeet'?{min_leg_usdc:formatUnits(limits.minLegRaw,6)}:{}),
   legs:legs.map(l=>({symbol:l.symbol,parts:l.parts,amount_in:l.amount_in,est_out:l.dry_out,est_out_usd:usd(l.out_usd),min_out:l.dry_min_out})),
   totals:{in_usd:usd(formatUnits(sumUsdRaw(legs,'in_usd'),12)),out_usd:usd(formatUnits(sumUsdRaw(legs,'out_usd'),12)),cost_pct:bps/100,time_estimate_s:Math.max(0,...legs.map(l=>l.time_estimate_s))},
   quoted_at:iso(Math.max(...legs.map(l=>l.quoted_at))),
   warnings:warnings.slice(0,4),
   next:NEXT[p.direction],
  };
 }
 function mint(p,revision,accountId,clientId,opts){
  return codes.mint({accountId,clientId,proposalId:p.id,revision,quoteSha:quoteHash(p.id,revision,legsOf(p.id,revision))},opts);
 }
 async function present(p,revision,ctx,w){
  const out=view(p,revision,await walletWarnings(w,p.direction,BigInt(p.amount_in_raw)));
  return p.status==='proposed'&&p.revision===revision?{...out,confirm:mint(p,revision,ctx.accountId,ctx.clientId)}:out;
 }
 /** Same request again: the stored proposal (latest revision). Another payload under the same id: INVALID_ARGUMENT. */
 function prior(ctx,request_id,hash){
  const p=db.prepare('SELECT * FROM proposals WHERE account_id=? AND client_id=? AND request_id=?').get(ctx.accountId,ctx.clientId,request_id);
  if(p&&p.request_sha256!==hash)refuse('INVALID_ARGUMENT','request_id reused with another payload');
  return p;
 }
 function store(ctx,{request_id,hash,direction,amountInRaw,slippage,legs}){
  const id=newId('p'),t=now();
  try{
   tx(db,()=>{
    db.prepare('INSERT INTO proposals(id,account_id,client_id,request_id,request_sha256,direction,amount_in_raw,slippage_bps,revision,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)')
     .run(id,ctx.accountId,ctx.clientId,request_id,hash,direction,amountInRaw.toString(),slippage,'proposed',t,t);
    insertRevision(id,1,legs);
   });
  }catch(e){if(/UNIQUE/.test(e.message))return prior(ctx,request_id,hash);throw e}
  return row(id);
 }

 async function yeetPlan(w,amount,legs,slippage){
  return routed(()=>buildYeetPlan({amountUsdc:amount,legs:legs.map(l=>({symbol:l.symbol,parts:l.parts})),recipientSol:w.solana.address,refundBase:w.base.address,slippageBps:slippage,dry:true},deps()));
 }
 async function skeetLegs(w,legs){
  checkLegCount(limits,legs?.length);
  const seen=new Set();
  const held=await wallets.holdings(w.solana.address);
  return legs.map(l=>{
   const t=coin(l.symbol);if(seen.has(t.assetId))refuse('INVALID_ARGUMENT','duplicate coin');seen.add(t.assetId);
   if(!Number.isInteger(l.percent)||l.percent<1||l.percent>100)refuse('INVALID_ARGUMENT','percent');
   const h=held.filter(x=>x.mint===t.address).reduce((a,x)=>a+x.raw,0n);
   const raw=h*BigInt(l.percent)/100n;
   if(raw<=0n)refuse('BALANCE_LOW',`no ${t.symbol}`);
   return {symbol:t.symbol,percent:l.percent,amount:formatUnits(raw,t.decimals)};
  });
 }
 async function skeetPlan(w,legs,slippage){
  const plan=await routed(()=>buildSkeetPlan({legs:legs.map(l=>({symbol:l.symbol,amount:l.amount})),recipientBase:w.base.address,refundSol:w.solana.address,slippageBps:slippage,dry:true},deps()));
  if(plan.legs.some(l=>BigInt(l.amountOut)<limits.minLegRaw))refuse('AMOUNT_TOO_SMALL','skeet leg under minimum');
  return plan;
 }
 const slippageOf=s=>{if(s===undefined||s===null)return 100;if(!Number.isInteger(s)||s<50||s>300)refuse('INVALID_ARGUMENT','slippage');return s};
 const owned=(ctx,proposal_id)=>{
  const p=row(proposal_id);
  if(!p||p.account_id!==ctx.accountId||p.client_id!==ctx.clientId)refuse('INVALID_ARGUMENT','unknown proposal');
  return p;
 };

 return {
  view,legsOf,row,legRows,insertRevision,mint,legsCost,
  /** SPL mint of a catalogue coin. */
  mintOf:symbol=>coin(symbol).address,
  /** yeet_propose */
  async propose(ctx,{request_id,amount_usdc,legs,slippage_bps}){
   checkKillSwitch(limits);
   codes.checkRate(ctx.accountId);
   const slippage=slippageOf(slippage_bps);
   const hash=sha256({direction:'yeet',amount_usdc,legs,slippage});
   const existing=prior(ctx,request_id,hash);
   if(existing)return present(existing,existing.revision,ctx,await wallets.resolve(ctx.accountId));
   validateYeetLegs(legs);
   const total=amountRaw(amount_usdc);
   checkBasket(limits,legShares(total,legs));
   checkDaily(db,limits,ctx.accountId,now(),total);
   const w=await wallets.require(ctx.accountId);
   const plan=await yeetPlan(w,amount_usdc,legs,slippage);
   const rows=legRows(plan);
   checkCost(limits,legsCost(rows));
   const p=store(ctx,{request_id,hash,direction:'yeet',amountInRaw:total,slippage,legs:rows});
   return present(p,p.revision,ctx,w);
  },
  /** skeet_propose: sell a percent of 1-5 held coins back to USDC on Base. */
  async skeet(ctx,{request_id,legs}){
   checkKillSwitch(limits);
   codes.checkRate(ctx.accountId);
   const hash=sha256({direction:'skeet',legs});
   const existing=prior(ctx,request_id,hash);
   if(existing)return present(existing,existing.revision,ctx,await wallets.resolve(ctx.accountId));
   const w=await wallets.require(ctx.accountId);
   const amounts=await skeetLegs(w,legs);
   const plan=await skeetPlan(w,amounts,100);
   const rows=legRows(plan,{percents:amounts.map(l=>l.percent)});
   checkCost(limits,legsCost(rows));
   const p=store(ctx,{request_id,hash,direction:'skeet',amountInRaw:0n,slippage:100,legs:rows});
   return present(p,p.revision,ctx,w);
  },
  /** yeet_quote: a new revision with a fresh dry quote (optionally new parts or amount; YEET only). */
  async quote(ctx,{proposal_id,legs,amount_usdc}){
   checkKillSwitch(limits);
   const p=owned(ctx,proposal_id);
   codes.checkRate(ctx.accountId);
   if(p.status!=='proposed')refuse('INVALID_ARGUMENT','proposal already used');
   const w=await wallets.require(ctx.accountId);
   const prev=legsOf(p.id,p.revision);
   let rows,total=BigInt(p.amount_in_raw);
   if(p.direction==='yeet'){
    const nextLegs=legs??prev.map(l=>({symbol:l.symbol,parts:l.parts}));
    validateYeetLegs(nextLegs);
    const amount=amount_usdc??formatUnits(total,6);
    total=amountRaw(amount);
    checkBasket(limits,legShares(total,nextLegs));
    checkDaily(db,limits,ctx.accountId,now(),total);
    rows=legRows(await yeetPlan(w,amount,nextLegs,p.slippage_bps));
   }else{
    if(legs!==undefined||amount_usdc!==undefined)refuse('INVALID_ARGUMENT','a SKEET quote takes no new legs or amount');
    const amounts=await skeetLegs(w,prev.map(l=>({symbol:l.symbol,percent:l.percent})));
    rows=legRows(await skeetPlan(w,amounts,p.slippage_bps),{percents:amounts.map(l=>l.percent)});
   }
   checkCost(limits,legsCost(rows));
   const revision=p.revision+1;
   const moved=tx(db,()=>{
    const ok=db.prepare("UPDATE proposals SET revision=?,amount_in_raw=?,updated_at=? WHERE id=? AND revision=? AND status='proposed'").run(revision,total.toString(),now(),p.id,p.revision).changes===1;
    if(ok)insertRevision(p.id,revision,rows);
    return ok;
   });
   if(!moved)refuse('INVALID_ARGUMENT','proposal changed meanwhile');
   return present(row(p.id),revision,ctx,w);
  },
 };
}

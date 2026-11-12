// The account's Base and Solana wallets (addresses, Privy wallet ids, signer state) and their balances.
// Two interfaces, each with a real implementation here and fakes in tests:
//   directory (from the signer adapter): lookup(accountId) -> {base, solana} | null
//   balances: baseUsdc(address) -> bigint, baseEth(address) -> bigint,
//             solanaTokens(owner) -> [{mint, raw, decimals, tokenAccount, tokenProgram}], recentBlockhash() -> string
// Real balances use BASE_RPC_URL (eth_call balanceOf on USDC, eth_getBalance) and SOLANA_RPC_URL
// (getTokenAccountsByOwner over both token programs, getLatestBlockhash).
import {USDC_BASE,erc20BalanceOfData} from './signer.mjs';
import {TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from './solana-tx.mjs';
import {refuse} from './util.mjs';

export const WALLET_TTL_MS=5*60_000;

export function createWallets({db,directory,balances,now=Date.now,ttlMs=WALLET_TTL_MS}){
 const rows=accountId=>db.prepare('SELECT * FROM wallets WHERE account_id=?').all(accountId);
 const shape=list=>{
  const by=Object.fromEntries(list.map(r=>[r.chain,{address:r.address,walletId:r.privy_wallet_id,signerState:r.signer_state,policyId:r.policy_id,updatedAt:r.updated_at}]));
  return by.base&&by.solana?{base:by.base,solana:by.solana}:null;
 };
 const upsert=db.prepare(`INSERT INTO wallets(account_id,chain,address,privy_wallet_id,signer_state,policy_id,updated_at) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(account_id,chain) DO UPDATE SET address=excluded.address,privy_wallet_id=excluded.privy_wallet_id,signer_state=excluded.signer_state,policy_id=excluded.policy_id,updated_at=excluded.updated_at`);
 return {
  /** Wallets for the account, from the table while fresh (always, for a stable directory), else from the directory. */
  async resolve(accountId,{refresh=false}={}){
   const cached=shape(rows(accountId));
   if(cached&&!refresh&&(directory.stable||now()-Math.min(cached.base.updatedAt,cached.solana.updatedAt)<ttlMs))return cached;
   const found=await directory.lookup(accountId);
   if(!found)return cached&&directory.stable?cached:null;
   const t=now();
   for(const chain of ['base','solana']){const w=found[chain];upsert.run(accountId,chain,w.address,w.walletId??null,w.signerState??'none',w.policyId??null,t)}
   return shape(rows(accountId));
  },
  /** Like resolve, but WALLET_NOT_READY when the account has no wallets yet. */
  async require(accountId,opts){const w=await this.resolve(accountId,opts);if(!w)refuse('WALLET_NOT_READY','no wallets');return w},
  async usdc(address){try{return await balances.baseUsdc(address)}catch(e){if(e?.name==='TradeError')throw e;refuse('TEMPORARILY_UNAVAILABLE','Base balance')}},
  async holdings(owner){try{return await balances.solanaTokens(owner)}catch(e){if(e?.name==='TradeError')throw e;refuse('TEMPORARILY_UNAVAILABLE','Solana balance')}},
 };
}

async function jsonRpc(fetch,url,method,params){
 if(!url)refuse('TEMPORARILY_UNAVAILABLE',`no RPC url for ${method}`);
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:AbortSignal.timeout(4000)});
 if(!r.ok)throw Error(`rpc ${method} ${r.status}`);
 const j=await r.json();
 if(j.error)throw Error(`rpc ${method} error`);
 return j.result;
}

export function createRpcBalances({baseRpcUrl=process.env.BASE_RPC_URL,solanaRpcUrl=process.env.SOLANA_RPC_URL,fetch=globalThis.fetch}={}){
 return {
  async baseUsdc(address){
   const hex=await jsonRpc(fetch,baseRpcUrl,'eth_call',[{to:USDC_BASE,data:erc20BalanceOfData(address)},'latest']);
   if(typeof hex!=='string'||!/^0x[0-9a-fA-F]*$/.test(hex))throw Error('bad balance');
   return hex==='0x'?0n:BigInt(hex);
  },
  async baseEth(address){return BigInt(await jsonRpc(fetch,baseRpcUrl,'eth_getBalance',[address,'latest']))},
  async solanaTokens(owner){
   const out=[];
   for(const programId of [TOKEN_PROGRAM,TOKEN_2022_PROGRAM]){
    const res=await jsonRpc(fetch,solanaRpcUrl,'getTokenAccountsByOwner',[owner,{programId},{encoding:'jsonParsed',commitment:'confirmed'}]);
    for(const acc of res?.value??[]){
     const info=acc?.account?.data?.parsed?.info,amt=info?.tokenAmount;
     if(!info||typeof info.mint!=='string'||!/^\d+$/.test(amt?.amount??''))continue;
     out.push({mint:info.mint,raw:BigInt(amt.amount),decimals:amt.decimals,tokenAccount:acc.pubkey,tokenProgram:programId});
    }
   }
   return out;
  },
  async recentBlockhash(){return (await jsonRpc(fetch,solanaRpcUrl,'getLatestBlockhash',[{commitment:'confirmed'}]))?.value?.blockhash},
 };
}

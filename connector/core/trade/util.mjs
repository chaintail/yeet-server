// Small helpers shared by the trade engine modules. No I/O.
import {createHash,randomBytes} from 'node:crypto';

/** A refusal carrying one catalogue code (contract x-yeet-errors). `detail` stays in the server log only. */
export class TradeError extends Error{
 constructor(code,detail){super(code);this.name='TradeError';this.code=code;if(detail)this.detail=detail}
}
export const refuse=(code,detail)=>{throw new TradeError(code,detail)};

/** Sorted-key JSON (same idea as the request ledger's `stable`), for hashes that must not depend on key order. */
export function canonical(value){
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
 if(typeof value==='bigint')return JSON.stringify(value.toString());
 return JSON.stringify(value);
}
export const sha256=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');

const ALPHABET='abcdefghijklmnopqrstuvwxyz0123456789';
/** `p_` / `t_` + 20 lowercase base36 characters (contract proposal_id / trade_id). */
export function newId(prefix,bytes=randomBytes){
 const b=bytes(20);let s='';for(let i=0;i<20;i++)s+=ALPHABET[b[i]%36];
 return `${prefix}_${s}`;
}

export const iso=ms=>new Date(ms).toISOString();
export const utcDay=ms=>new Date(ms).toISOString().slice(0,10);

const USDC_RE=/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;
/** A decimal string (e.g. 1Click amountOutUsd "24.983109630603") as a contract `usdc`: at most 6 decimals, truncated. */
export function usd(value){
 const m=/^(\d+)(?:\.(\d*))?$/.exec(String(value??'').trim());
 if(!m)return '0';
 const whole=m[1].replace(/^0+(?=\d)/,''),frac=(m[2]??'').slice(0,6).replace(/0+$/,'');
 const out=frac?`${whole}.${frac}`:whole;
 return USDC_RE.test(out)?out:'999999.999999';
}
/** Exact decimal compare of two non-negative decimal strings as fixed point with 12 decimals. */
export function usdRaw(value){
 const m=/^(\d+)(?:\.(\d*))?$/.exec(String(value??'').trim());
 if(!m)return 0n;
 return BigInt(m[1]+(m[2]??'').slice(0,12).padEnd(12,'0'));
}

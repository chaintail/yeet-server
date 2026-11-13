// Test doubles for the user-signed pipeline: a scriptable Solana RPC and signature status, a local fee payer that
// counts its signatures, and a pipeline wired to the trade fakes (1Click from the router's recorded fixtures). Nothing
// here touches a network.
import {createHash} from 'node:crypto';
import {openTradeDb} from '../trade/db.mjs';
import {fakeOneClick,fakeBalances,fakeClock,BASE_WALLET} from '../trade/fakes.mjs';
import {base58Encode,CATALOG} from '../trade/router.mjs';
import {createPipeline} from './pipeline.mjs';
import {staticWalletDirectory} from './wallet-directory.mjs';
import {localSigner} from './solana/verify.mjs';
import {decodeTransaction,TOKEN_PROGRAM,USDC_SOLANA} from './solana/message.mjs';

const seed=s=>Uint8Array.from(createHash('sha256').update(s).digest());
export const ALICE={accountId:'yeet-privy-alice',clientId:'https://chatgpt.com/oauth/client.json'};
export const BOB={accountId:'yeet-privy-bob',clientId:ALICE.clientId};
export const aliceWallet=localSigner(seed('pipeline-alice-solana'));
export const bobWallet=localSigner(seed('pipeline-bob-solana'));
export const WIF_MINT=CATALOG.find(c=>c.symbol==='WIF'&&c.chain==='solana').address;

/** Fee payer in process; `refuse` makes the next signatures fail with that Privy code. */
export function fakeFeePayer(name='pipeline-fee-payer'){
 const k=localSigner(seed(name));
 const f={address:k.address,calls:0,refuse:null,
  async signTransaction(bytes){f.calls++;if(f.refuse){const e=Error(f.refuse);e.code=f.refuse;throw e}return k.signTransaction(bytes)}};
 return f;
}

/** Solana RPC double. `s.valid` / `s.height` / `s.finalized` drive the lifetime; `s.statuses` maps signature -> status. */
export function fakeSolanaRpc({feePayerLamports=50_000_000}={}){
 const mints=new Set([USDC_SOLANA,...CATALOG.filter(c=>c.chain==='solana'&&c.address).map(c=>c.address)]);
 const s={height:1000,finalized:968,valid:true,accounts:new Map(),sent:[],simulated:[],statuses:new Map(),feePayerLamports,onBroadcast:null,n:0,
  async latestBlockhash(){return {blockhash:base58Encode(createHash('sha256').update(`bh-${s.n++}`).digest()),lastValidBlockHeight:String(s.height+150)}},
  async blockhashValid(_b,lvh){return s.valid&&BigInt(s.height)<=BigInt(lvh)},
  async blockHeight(c='confirmed'){return c==='finalized'?s.finalized:s.height},
  async broadcast(bytes){s.onBroadcast?.(bytes);s.sent.push(Buffer.from(bytes).toString('base64'));return base58Encode(decodeTransaction(bytes).signatures[0])},
  async simulate(bytes){s.simulated.push(bytes.length);return {err:null,logs:['Program log: simulated'],unitsConsumed:30_000}},
  async accountInfo(a){return mints.has(a)?{owner:TOKEN_PROGRAM,lamports:1}:s.accounts.get(a)??null},
  async balance(){return s.feePayerLamports},
  async tokenBalance(){return null},
 };
 s.signatureStatus=async sig=>s.statuses.get(sig)??{status:'not_found',commitment:null,slot:null};
 return s;
}

/** The pipeline on fakes. `holdings` are the person's Solana token accounts (default 100 USDC and 1,000 WIF). */
export function fakePipeline({env={},now=fakeClock(),oneclick=fakeOneClick(),holdings,rpc=fakeSolanaRpc(),feePayer=fakeFeePayer(),floor,logs=[],db=openTradeDb(':memory:'),landing={landingWatchMs:0}}={}){
 const balances=fakeBalances({holdings:holdings??[{mint:USDC_SOLANA,raw:100_000_000n,decimals:6},{mint:WIF_MINT,raw:1_000_000_000n,decimals:6}]});
 const directory=staticWalletDirectory({[ALICE.accountId]:{base:{address:BASE_WALLET},solana:{address:aliceWallet.address}},[BOB.accountId]:{base:{address:'0x27602fd697f91d31fe551b26a3b12b113789477e'},solana:{address:bobWallet.address}}});
 const fullEnv={YEET_LIVE:'1',...env};
 const p=createPipeline({db,env:fullEnv,client:oneclick,directory,balances,now,trackerIntervalMs:0,log:l=>logs.push(l),...landing,
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer,...(floor!==undefined?{floor}:{})}});
 return {p,db,env:fullEnv,now,oneclick,rpc,feePayer,balances,logs};
}
/** Overrides for trade/runtime.mjs configureTradeEngine in the in-process connector tests: every signed-in account
 * maps to the local test wallet (`wallet`), 1Click from the recorded fixtures, the Solana RPC double and a local fee
 * payer. Returns the overrides plus the handles a test needs to sign and confirm. */
export function fakeRuntime({env={},oneclick=fakeOneClick(),holdings,usdc,rpc=fakeSolanaRpc(),feePayer=fakeFeePayer(),wallet=aliceWallet}={}){
 const balances=fakeBalances({...(usdc!==undefined?{usdc}:{}),holdings:holdings??[{mint:USDC_SOLANA,raw:100_000_000n,decimals:6},{mint:WIF_MINT,raw:1_000_000_000n,decimals:6}]});
 const directory={stable:true,async lookup(){return {base:{address:BASE_WALLET,walletId:null,signerState:'none',policyId:null},solana:{address:wallet.address,walletId:null,signerState:'none',policyId:null}}}};
 const overrides={client:oneclick,directory,balances,env:{...process.env,YEET_LIVE:'1',...env},trackerIntervalMs:0,landingWatchMs:0,
  driverOverrides:{rpc,signatureStatus:rpc.signatureStatus,historySignatureStatus:rpc.signatureStatus,feePayer}};
 /** Mark every landed signature confirmed, the way the chain would. */
 const confirmSent=()=>{for(const b64 of rpc.sent)rpc.statuses.set(base58Encode(decodeTransaction(Buffer.from(b64,'base64')).signatures[0]),{status:'confirmed',commitment:'confirmed',slot:5})};
 return {overrides,oneclick,rpc,feePayer,balances,wallet,confirmSent};
}
/** The person's wallet signing a sign request (sign only). */
export const signAs=(wallet,req)=>Buffer.from(wallet.signTransaction(Buffer.from(req.payload.transaction_base64,'base64'))).toString('base64');

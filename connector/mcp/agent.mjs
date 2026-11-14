// The agent endpoint's MCP server (connector/docs/AGENT-ROUTE.md): served only on the agent host (AGENT_RESOURCE, by default
// https://mcp.yeet.win) and only with YEET_AGENT_ROUTE=on. For coding agents: no cards, no widget metadata, no
// conversation guidance; every result is plain JSON (structuredContent, repeated as the text). The agent trades with its
// own ed25519 key from its own ledger balance (core/agent/agents.mjs); this server holds no key and forwards calls.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {hasScope} from '#scope-catalog';

const SYMBOL=z.string().regex(/^\$?[A-Za-z0-9]{2,12}$/).describe('Coin symbol, e.g. WIF.');
const USDC=z.string().regex(/^\d{1,7}(\.\d{1,6})?$/);
const ACCOUNT=z.enum(['agent','owner']).optional().describe('Whose account: "agent" (default) is your own key\'s ledger account and budget; "owner" is the person\'s own YEET account, whose Privy Solana wallet signs (only when the server has owner account mode on).');
const SIGNATURE=z.string().min(64).max(200).describe('The 64-byte ed25519 signature over the exact UTF-8 bytes of `message`, base64 (88 chars) or hex (128 chars): made by your key (account "agent") or by the person\'s Privy Solana wallet (account "owner").');

/** The text of agent_how_it_works. */
export const HOW_IT_WORKS=`YEET for agents: trade meme coins for a YEET account with your own key, from a budget the person gives you.

Keys
- Generate an ed25519 key pair on your own machine. Keep the private key there; YEET never asks for it and never holds it.
- Your public key's implicit NEAR account inside the NEAR Intents ledger (intents.near) is your own balance: the 64-hex encoding of the 32 public key bytes.

Budget
- agent_register_key with your public key and a budget in USDC returns budget_url. Give it to the person. They sign in to YEET there and approve ONE ledger transfer from their own YEET balance to your account.
- You can only ever spend that balance. agent_return_budget sends it back to the person's YEET ledger account and nowhere else.

Trading
1. agent_quote (side buy with amount_usdc, or sell with percent; listed coins only).
2. agent_prepare_trade with quote_id returns request.message: a NEAR Intents token_diff for your own account (standard raw_ed25519), what you give and the least you receive.
3. Sign the UTF-8 bytes of message exactly, with no prefix, using your ed25519 key.
4. agent_submit_signature with request_id and the base64 signature. YEET checks the signature, simulates the message and settles it against its solver in one ledger call, or nothing moves.
5. agent_trade_status until status is success or failed. Sign before sign_before; after it, prepare again.

Limits
- Per trade and per UTC day in USDC (agent_overview limits), on top of the account's own limits. Only coins in limits.coins. YEET charges no fee; the ledger's own fee is in the quote.

Owner account (when the server has it on; agent_overview shows owner_account)
- account "owner" on agent_quote, agent_prepare_trade, agent_submit_signature, agent_trade_status, agent_balance and agent_positions trades and reads the person's OWN YEET account instead of yours: the same wallet and portfolio as YEET in ChatGPT.
- The person's Privy Solana wallet signs each message (signMessage over the UTF-8 bytes of message), obtained by you through the Privy approval the person gave you. YEET is not on that path and only checks the signature against the person's own wallet key.
- Trades only: no transfer or return from the person's account. Your per-trade and per-day limits apply on top of the person's own.

Errors
- Every refusal is JSON {error, message, retryable}. message is a sentence you can relay to the person.
- OWNER_ACCOUNT_OFF: account "owner" is switched off on this server; use account "agent".
- WRONG_ROUTE: this endpoint is for agents only; ChatGPT uses the other YEET URL, named in the message.`;

/** The tools: name -> [title, description, input shape, core route(args) -> [path, body?], scope, readOnly]. */
const TOOLS={
 agent_overview:['YEET agent status','Your agent link to the YEET account: registered key, state (not_registered, awaiting_budget, active), balance, limits, and the next step.',{},()=>['/agent/overview'],'yeet:read',true],
 agent_how_it_works:['How YEET for agents works','How keys, the budget, signing and the limits work. No account data.',{},null,'yeet:read',true],
 agent_register_key:['Register agent key','Registers your ed25519 public key for this connection and returns budget_url, where the person approves one transfer of budget_usdc from their YEET balance to your own ledger account.',
  {public_key:z.string().min(32).max(120).describe('Your ed25519 public key: "ed25519:<base58>", base58, or 64 hex.'),budget_usdc:USDC.describe('The budget to ask for, in USDC, e.g. "20".')},a=>['/agent/register',a],'yeet:write',false],
 agent_balance:['Agent balance','Your own ledger balance (or, with account "owner", the person\'s): USDC and listed coins.',{account:ACCOUNT},a=>a.account===undefined?['/agent/balance']:['/agent/balance',{account:a.account}],'yeet:read',true],
 agent_quote:['Quote a trade','A firm quote for a buy (amount_usdc split evenly over coins) or a sell (percent of each coin held). Returns quote_id for agent_prepare_trade.',
  {side:z.enum(['buy','sell']),coins:z.array(SYMBOL).min(1).max(5),amount_usdc:USDC.optional().describe('buy: the USDC to spend.'),percent:z.number().int().min(1).max(100).optional().describe('sell: the share of each coin to sell (default 100).'),account:ACCOUNT},a=>['/agent/quote',a],'yeet:write',false],
 agent_prepare_trade:['Prepare a trade','Checks the agent limits and returns the unsigned NEAR Intents message for a quote (request.message, raw_ed25519) and request_id.',
  {quote_id:z.string().regex(/^p_[a-z0-9]{20}$/),revision:z.number().int().min(1).optional(),account:ACCOUNT},a=>['/agent/prepare',a],'yeet:prepare',false],
 agent_submit_signature:['Submit a signature','Hands over your signature for a prepared trade or a budget return. YEET verifies it against your key, simulates, and settles it or moves nothing.',
  {request_id:z.string().min(10).max(120),signature:SIGNATURE,account:ACCOUNT},a=>['/agent/submit',a],'yeet:prepare',false],
 agent_trade_status:['Trade status','The status of one of your trades and what it received.',{trade_id:z.string().regex(/^t_[a-z0-9]{20}$/),account:ACCOUNT},a=>['/agent/status',a],'yeet:read',true],
 agent_positions:['Agent positions','Your USDC, the coins you hold with their USD value, your recent trades and what is left of today\'s limit.',{account:ACCOUNT},a=>a.account===undefined?['/agent/positions']:['/agent/positions',{account:a.account}],'yeet:read',true],
 agent_return_budget:['Return budget','The unsigned transfer of your balance (one token per call, USDC first) back to the person\'s YEET ledger account, the only receiver it can name. Sign it and submit it with agent_submit_signature. Not possible with account "owner" (trades only).',{account:ACCOUNT},a=>['/agent/return',a.account===undefined?{}:{account:a.account}],'yeet:write',false],
};
export const AGENT_TOOL_NAMES=Object.freeze(Object.keys(TOOLS));

const result=data=>({structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}]});
const refusal=e=>{
 const data={error:typeof e?.error==='string'?e.error:'TEMPORARILY_UNAVAILABLE',message:typeof e?.message==='string'&&e.message.length<=600?e.message:'YEET could not answer just now. Nothing moved. Try again in a minute.',
  retryable:typeof e?.retryable==='boolean'?e.retryable:true,...Object.fromEntries(['correct_url','terms_url','coins','limits'].filter(k=>e?.[k]!==undefined).map(k=>[k,e[k]]))};
 return {isError:true,content:[{type:'text',text:JSON.stringify(data)}]};
};

/** token: the introspection answer (its `scope` string); callCore(path, body) -> JSON or throws the core's refusal body. */
export function createAgentMcpServer({token,callCore}){
 const server=new McpServer({name:'yeet-agent',version:'0.1.0'},{instructions:'YEET for agents. Call agent_how_it_works first. Every result is JSON; refusals carry error, message and retryable.'});
 for(const [name,[title,description,shape,route,scope,readOnly]] of Object.entries(TOOLS)){
  server.registerTool(name,{title,description,inputSchema:shape,annotations:{readOnlyHint:readOnly,openWorldHint:false,destructiveHint:false}},async(args)=>{
   if(!hasScope(typeof token.scope==='string'?token.scope.split(' '):[],scope))return refusal({error:'REAUTH_REQUIRED',message:'This connection lacks the permission for this tool. Connect YEET again and approve it.',retryable:false});
   if(!route)return result({text:HOW_IT_WORKS});
   try{const [path,body]=route(args??{});return result(await callCore(path,body))}
   catch(e){return refusal(e)}
  });
 }
 return server;
}

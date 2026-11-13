import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {toolSchemas,zodSchema,contract} from '../tool-contract.mjs';
import {toolError} from '../errors.mjs';
import {instructions,descriptions,titles} from '../instructions.mjs';
import {allScopes} from '#scope-catalog';
const ALL=['yeet_home','yeet_coins','yeet_propose','yeet_quote','execute_trade','submit_trade_signature','trade_status','yeet_portfolio','skeet_propose','yeet_leaderboard','daily_spin','yeet_set_username'];
test('every published schema has a top-level object, resolved references, strict input; the twelve contract tools',()=>{
 assert.deepEqual(Object.keys(toolSchemas),ALL);
 for(const schema of Object.values(toolSchemas)){
  assert.equal(schema.output.type,'object');assert.doesNotMatch(JSON.stringify(schema),/\$ref/);assert.equal(schema.input.additionalProperties,false);
 }
});
test('shared pieces follow plan 2.1',()=>{
 const p=n=>zodSchema(z,contract.$defs[n]);
 for(const ok of ['0','20','20.5','999999.123456'])assert.doesNotThrow(()=>p('usdc').parse(ok),ok);
 for(const bad of ['020','-1','1.1234567','1e3','1000000',''])assert.throws(()=>p('usdc').parse(bad),bad);
 assert.doesNotThrow(()=>p('symbol').parse('WIF'));assert.throws(()=>p('symbol').parse('$WIF'));assert.throws(()=>p('symbol').parse('W'));
 assert.doesNotThrow(()=>p('proposal_id').parse('p_abcdefghij0123456789'));assert.throws(()=>p('proposal_id').parse('p_ABC'));
 assert.doesNotThrow(()=>p('trade_id').parse('t_abcdefghij0123456789'));
 assert.doesNotThrow(()=>p('leg_in').parse({symbol:'WIF',parts:0}));assert.doesNotThrow(()=>p('leg_in').parse({symbol:'WIF',parts:99}));assert.throws(()=>p('leg_in').parse({symbol:'WIF',parts:100}));assert.throws(()=>p('leg_in').parse({symbol:'WIF',parts:1,extra:1}));
 const input=zodSchema(z,toolSchemas.yeet_propose.input);
 assert.doesNotThrow(()=>input.parse({request_id:'r',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}]}));
 assert.throws(()=>input.parse({request_id:'r',amount_usdc:'20',legs:[]}));
 assert.throws(()=>input.parse({request_id:'r',amount_usdc:'20',legs:[{symbol:'WIF',parts:10}],slippage_bps:400}));
 const exec=zodSchema(z,toolSchemas.execute_trade.input);
 assert.doesNotThrow(()=>exec.parse({proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'A'.repeat(43)}));
 assert.throws(()=>exec.parse({proposal_id:'p_abcdefghij0123456789',revision:1,confirm:'A'.repeat(42)}));
 assert.deepEqual(contract.$defs.proposal.properties.next.enum,['Tap ⚡ YEET in the card','Tap SKEET in the card']);
});
test('the error enum and x-yeet-errors catalogue agree; every code has a card; retryable codes as the contract says',async()=>{
 const {TOOL_ERRORS}=await import('#contracts/errors');
 const codes=contract.$defs.failure.properties.error.enum;
 assert.deepEqual(codes,['INVALID_ARGUMENT','COIN_NOT_SUPPORTED','PARTS_EMPTY','AMOUNT_TOO_SMALL','COST_TOO_HIGH','LIMIT_EXCEEDED','BALANCE_LOW','WALLET_NOT_READY','CONFIRMATION_REQUIRED','REQUOTE_REQUIRED','TRADING_PAUSED','REAUTH_REQUIRED','TEMPORARILY_UNAVAILABLE','USERNAME_TAKEN','USERNAME_NOT_ALLOWED']);
 assert.deepEqual(Object.keys(TOOL_ERRORS).sort(),[...codes].sort());
 for(const code of codes){
  const result=JSON.parse(toolError({error:code}).content[0].text);
  assert.equal(result.error,code);assert.equal(result.retryable,TOOL_ERRORS[code].retryable);
  assert.ok(TOOL_ERRORS[code].title&&TOOL_ERRORS[code].message,code);
  assert.doesNotThrow(()=>zodSchema(z,contract.$defs.failure).parse(result),code);
 }
 assert.deepEqual(codes.filter(code=>TOOL_ERRORS[code].retryable).sort(),['CONFIRMATION_REQUIRED','COST_TOO_HIGH','REQUOTE_REQUIRED','TEMPORARILY_UNAVAILABLE','TRADING_PAUSED']);
});
test('step-up repeats the complete scope catalog; tool failures never echo stacks or hosts',()=>{
 const result=toolError({error:'REAUTH_REQUIRED'});
 assert.ok(result._meta['mcp/www_authenticate'][0].includes(allScopes.join(' ')));
 assert.doesNotMatch(JSON.stringify(toolError({error:'host-internal:38316 token=secret',message:'private'})),/internal|secret|private/);
 assert.equal(toolError({error:'NOPE'}).content[0].text.includes('TEMPORARILY_UNAVAILABLE'),true);
});
test('model-visible catalog: titles and descriptions for every tool; data-not-instructions and no-execution rules',()=>{
 assert.deepEqual(Object.keys(titles),ALL);assert.deepEqual(Object.keys(descriptions),ALL);
 assert.match(instructions,/YEET/);
 assert.match(instructions,/YEET/);
 assert.ok(instructions.length>=450&&instructions.length<=650,`instructions length ${instructions.length}`);
 assert.match(descriptions.execute_trade,/Only the card can call this/);
});
test('the core yeet_coins answer fits the published output schema and lists only tradable Solana coins',async()=>{
 const {coins,tradable}=await import('../../core/coins.mjs');
 const value=coins();
 zodSchema(z,toolSchemas.yeet_coins.output).parse(value);
 assert.ok(value.coins.length>=1&&value.coins.length<=25);
 assert.ok(value.coins.some(c=>c.symbol==='WIF'&&c.kind==='meme'));
 assert.equal(tradable([{chain:'base',kind:'funding'},{chain:'solana',kind:'funding'},{chain:'solana',kind:'meme',symbol:'X'}]).length,1);
 assert.deepEqual(value.limits,{min_leg_usdc:'3',max_trade_usdc:'25',max_legs:5,default_usdc:'20'});
});

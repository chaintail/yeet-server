// fund_url: yeet_home needs_funds and BALANCE_LOW refusals point at <public origin>/fund (contract https_url only).
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fundUrlFor,homeWithFundUrl,failureWithFundUrl,fundAnswer,FUND_PRESETS,homeAnswer,portfolioAnswer,depositFor} from '../fund-link.mjs';
import {AMOUNT_CHIPS,chipFromSearch} from '../../login/fund-links.js';
import {failure} from '../failure.mjs';
import {toolError} from '../../mcp/errors.mjs';
import {toolSchemas,zodSchema,contract} from '../../mcp/tool-contract.mjs';

const URL_='https://chatgpt.yeet.win/fund';

test('yeet_fund: one USDC number, the presets the funding page offers, the page only when it is https; ?amount= starts the page on a preset',()=>{
 const out=zodSchema(z,toolSchemas.yeet_fund.output);
 assert.deepEqual([...FUND_PRESETS],[...AMOUNT_CHIPS],'the card offers the amounts the page has chips for');
 const v=fundAnswer('3.2',URL_);
 assert.deepEqual(v,{usdc:'3.2',presets:['10','25','50','100'],fund_url:URL_});assert.doesNotThrow(()=>out.parse(v));
 assert.deepEqual(fundAnswer(null,null),{usdc:null,presets:['10','25','50','100']});assert.doesNotThrow(()=>out.parse(fundAnswer(null,null)));
 for(const p of FUND_PRESETS)assert.equal(chipFromSearch(`?amount=${p}`),p);
 for(const bad of ['?amount=7','?amount=','?x=25','',undefined,'?amount=25abc'])assert.equal(chipFromSearch(bad),null,String(bad));
});

test('fundUrlFor: https origins only, path /fund, no credentials',()=>{
 assert.equal(fundUrlFor('https://chatgpt.yeet.win'),URL_);
 assert.equal(fundUrlFor('https://chatgpt.yeet.win/'),URL_);
 for(const o of ['http://127.0.0.1:38312','https://u:p@chatgpt.yeet.win','not a url','',undefined])assert.equal(fundUrlFor(o),null,String(o));
});

test('homeWithFundUrl: only needs_funds gets the link, and the result parses against yeet_home',()=>{
 const home={wallets:{base:{address:'0x'+'1'.repeat(40),usdc:'0.5'},solana:{address:'So11111111111111111111111111111111111111112'}},ready:'needs_funds',xp:null,recent_wins:[]};
 const out=zodSchema(z,toolSchemas.yeet_home.output);
 const withLink=homeWithFundUrl(home,URL_);
 assert.equal(withLink.fund_url,URL_);
 // The engine's own answer names the wallets; what the route answers (homeAnswer) has one USDC number and no address.
 assert.equal(out.safeParse(withLink).success,false,'the engine answer itself is not the tool answer');
 const answer=homeAnswer(withLink);
 assert.deepEqual(answer,{usdc:'0.5',ready:'needs_funds',xp:null,recent_wins:[],fund_url:URL_});
 assert.equal(out.safeParse(answer).success,true,JSON.stringify(out.safeParse(answer).error?.issues));
 assert.equal(homeAnswer({...home,funding:{base_usdc:'0.5',solana_usdc:'2',chosen:null}}).usdc,'2.5');
 assert.equal(homeAnswer({...home,funding:{base_usdc:null,solana_usdc:null,chosen:null}}).usdc,null);
 for(const ready of ['ready','needs_signer','paused'])assert.equal('fund_url' in homeWithFundUrl({...home,ready},URL_),false,ready);
 assert.equal('fund_url' in homeWithFundUrl(home,null),false,'no https origin, no link');
});

test('BALANCE_LOW: core failure and the tool error carry fund_url; other codes and unsafe links do not',()=>{
 const f=failureWithFundUrl(failure('BALANCE_LOW'),URL_);
 assert.equal(f.fund_url,URL_);
 const failureSchema=zodSchema(z,contract.$defs.failure);
 assert.equal(failureSchema.safeParse(f).success,true);
 assert.equal('fund_url' in failureWithFundUrl(failure('LIMIT_EXCEEDED'),URL_),false);
 const text=r=>JSON.parse(r.content[0].text);
 assert.equal(text(toolError(f)).fund_url,URL_);
 assert.equal('fund_url' in text(toolError({error:'BALANCE_LOW'})),false);
 assert.equal('fund_url' in text(toolError({error:'BALANCE_LOW',fund_url:'http://chatgpt.yeet.win/fund'})),false);
 assert.equal('fund_url' in text(toolError({error:'LIMIT_EXCEEDED',fund_url:URL_})),false);
});

// ChatGPT never reads an address: the portfolio answer has none, and the account's own deposit addresses travel as
// card_deposit (the connector moves it to card-only _meta["yeet/deposit"]).
test('portfolioAnswer drops the addresses; depositFor names the account\'s own addresses per network, the default first',()=>{
 const SOL='So11111111111111111111111111111111111111112',BASE='0x'+'1'.repeat(40);
 const p={solana:{address:SOL,holdings:[{symbol:'WIF',amount:'8',usd:'9'}]},base:{address:BASE,usdc:'3'},total_usd:'12',priced_at:'2026-11-12T00:00:00Z'};
 const out=zodSchema(z,toolSchemas.yeet_portfolio.output);
 assert.deepEqual(portfolioAnswer(p),{solana:{holdings:p.solana.holdings},base:{usdc:'3'},total_usd:'12',priced_at:p.priced_at});
 assert.equal(out.safeParse(portfolioAnswer(p)).success,true);assert.equal(out.safeParse(p).success,false,'an address would fail the tool answer');
 const w={base:{address:BASE,usdc:'3'},solana:{address:SOL}};
 assert.deepEqual(depositFor(w),{default:'solana',networks:[{network:'solana',address:SOL},{network:'base',address:BASE}]});
 assert.deepEqual(depositFor(w,['base','sol']),{default:'base',networks:[{network:'base',address:BASE},{network:'solana',address:SOL}]});
 assert.deepEqual(depositFor(w,['base']),{default:'base',networks:[{network:'base',address:BASE}]},'one network: only its address');
 // An address that is not one of its network's is never handed on; nothing usable: no block at all.
 assert.deepEqual(depositFor({base:{address:SOL},solana:{address:SOL}}),{default:'solana',networks:[{network:'solana',address:SOL}]});
 assert.equal(depositFor({base:{address:'0x12'},solana:{}}),null);assert.equal(depositFor(null),null);assert.equal(depositFor(w,['tron']),null);
 // The card-only block matches the contract's shape for it.
 assert.deepEqual(Object.keys(contract.tools.yeet_fund.resultMeta),['yeet/deposit']);
 assert.equal(zodSchema(z,{...contract.tools.yeet_fund.resultMeta['yeet/deposit']}).safeParse(depositFor(w)).success,true);
});

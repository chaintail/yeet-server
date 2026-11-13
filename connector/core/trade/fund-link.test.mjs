// fund_url: yeet_home needs_funds and BALANCE_LOW refusals point at <public origin>/fund (contract https_url only).
import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fundUrlFor,homeWithFundUrl,failureWithFundUrl} from '../fund-link.mjs';
import {failure} from '../failure.mjs';
import {toolError} from '../../mcp/errors.mjs';
import {toolSchemas,zodSchema,contract} from '../../mcp/tool-contract.mjs';

const URL_='https://chatgpt.yeet.win/fund';

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
 assert.equal(out.safeParse(withLink).success,true,JSON.stringify(out.safeParse(withLink).error?.issues));
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

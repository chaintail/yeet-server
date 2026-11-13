import test from 'node:test';
import assert from 'node:assert/strict';
import {versionInfo,vendoredPin} from './version.mjs';

test('trading is live only with YEET_LIVE=1 and the kill switch off',()=>{
 assert.equal(versionInfo({}).trading,'paused');
 assert.equal(versionInfo({YEET_LIVE:'1',YEET_KILL_SWITCH:'1'}).trading,'paused');
 assert.equal(versionInfo({YEET_LIVE:'0',YEET_KILL_SWITCH:'0'}).trading,'paused');
 assert.equal(versionInfo({YEET_LIVE:'1'}).trading,'live');
});
test('limits are the enforced values; server_commit only a hex sha',()=>{
 const v=versionInfo({YEET_MAX_TRADE_USDC:'10.5',YEET_DAILY_CAP_USDC:'40',YEET_MIN_LEG_USDC:'2',YEET_SERVER_COMMIT:'abc1234'});
 assert.deepEqual({...v.limits,tiers:undefined},{max_trade_usdc:'10.5',daily_cap_usdc:'40',min_leg_usdc:'2',tiers:undefined});
 assert.deepEqual(v.limits.tiers.map(t=>t.name),['Noob','Winner','VIP']);
 assert.equal(v.server_commit,'abc1234');
 assert.equal(versionInfo({YEET_SERVER_COMMIT:'http://core:38316'}).server_commit,null);
 assert.throws(()=>versionInfo({YEET_MAX_TRADE_USDC:'lots'}),/Invalid YEET_MAX_TRADE_USDC/);
});
test('the pin is read from PINNED',()=>{
 assert.equal(vendoredPin('repo: x\ncommit: '+'a'.repeat(40)+'\n'),'a'.repeat(40));
 assert.throws(()=>vendoredPin('commit: abc'),/no commit/);
});

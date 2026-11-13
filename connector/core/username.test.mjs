// Usernames: the shape and blocklist check, uniqueness in any letter case, and the leaderboard showing the username
// in place of the default name.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkUsername,usernameFailure,RESERVED,USERNAME_ERRORS} from './username.mjs';

const state=mkdtempSync(join(tmpdir(),'yeet-username-'));
process.env.STATE_DIR=state;
const store=await import('./identity-store.mjs');
const {openXp}=await import('./xp/xp.mjs');
const {handle}=await import('./xp/board.mjs');
after(()=>rmSync(state,{recursive:true,force:true}));
const APP='username-test-app';
store.initializeIdentityStore({app:APP});
const person=did=>store.resolveIdentity({provider:'privy.io',app_id:APP,did:`did:privy:${did}`});
const code=fn=>{try{fn()}catch(e){return e.code}return null};

test('shape: 3 to 16 letters, digits or underscores; a leading @ and outer spaces are dropped',()=>{
 for(const ok of ['abc','Moon_Boi','x_1','A23456789012345B','__init'])assert.equal(checkUsername(ok).name,ok,ok);
 assert.deepEqual(checkUsername('  @MoonBoi '),{name:'MoonBoi',key:'moonboi'});
 for(const bad of ['ab','a'.repeat(17),'moon boi','moon-boi','moön','emoji🚀','',' ','@@abc',null,42,{}])
  assert.equal(code(()=>checkUsername(bad)),'INVALID_ARGUMENT',String(bad));
});

test('blocklist: reserved names in any case, with underscores or trailing digits, are refused',()=>{
 for(const bad of ['admin','ADMIN','Admin_1','yeet','YEET99','y_e_e_t','support','Support','chatgpt','near','skeet'])
  assert.equal(code(()=>checkUsername(bad)),'USERNAME_NOT_ALLOWED',bad);
 for(const ok of ['yeetking','adminton','supporter','nearby'])assert.equal(checkUsername(ok).name,ok,ok);
 assert.ok(RESERVED.includes('admin')&&RESERVED.includes('yeet')&&RESERVED.includes('support'));
});

test('failure shape: one catalogue-style answer per code, never retryable',()=>{
 for(const c of Object.keys(USERNAME_ERRORS))assert.deepEqual(usernameFailure(c),{error:c,message:USERNAME_ERRORS[c],retryable:false});
});

test('store: set, change, and unique ignoring case; the holder may change its own case',()=>{
 const a=person('name-a'),b=person('name-b');
 assert.equal(store.usernameOf(a),undefined);
 assert.equal(store.setUsername(a,'MoonBoi'),'MoonBoi');
 assert.equal(store.usernameOf(a),'MoonBoi');
 assert.equal(code(()=>store.setUsername(b,'moonboi')),'USERNAME_TAKEN');
 assert.equal(code(()=>store.setUsername(b,'MOONBOI')),'USERNAME_TAKEN');
 assert.equal(store.setUsername(a,'moonBOI'),'moonBOI','own name, new case');
 assert.equal(store.setUsername(a,'Sunny_Day'),'Sunny_Day');
 assert.equal(store.setUsername(b,'MoonBoi'),'MoonBoi','a released name can be taken');
 assert.equal(code(()=>store.setUsername(b,'admin')),'USERNAME_NOT_ALLOWED');
 assert.equal(store.usernameOf(b),'MoonBoi','a refused change keeps the old name');
 assert.equal(code(()=>store.setUsername('yeet-privy-nobody','Nobody1')),'INVALID_ARGUMENT','no such account');
});

test('leaderboard: a username replaces the default name; others keep theirs',()=>{
 const c=person('board-c'),d=person('board-d');
 store.setUsername(c,'Chad_Wins');
 const xp=openXp({secret:'test-xp-secret-0123456789abcdef'});
 xp.ledger.award(c,'first_yeet','t1');xp.ledger.award(d,'sign_in','2026-11-13');
 const names=id=>store.usernameOf(id)??handle(id);
 const board=xp.board('xp',d,names);
 assert.deepEqual(board.rows,[{rank:1,name:'Chad_Wins',xp:50},{rank:2,name:handle(d),xp:5}]);
 assert.deepEqual(board.me,{rank:2,xp:5});
 assert.equal(xp.board('xp',d).rows[0].name,handle(c),'without names the default name shows');
 xp.close();
});

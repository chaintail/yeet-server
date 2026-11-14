#!/usr/bin/env node
// The limited-beta waitlist (connector/core/waitlist.mjs): prints how many addresses are on it and writes them to a CSV
// file. Read-only: identities.sqlite is opened read-only and nothing in it changes. Sends nothing to anyone.
//
//   STATE_DIR=/var/lib/yeet-connector/core-state node ops/waitlist-export.mjs <out.csv>
//   (inside the core container: STATE_DIR is /state, the default)
//
// CSV columns: email, created_at (ISO 8601, UTC), source (chatgpt | web); oldest first. The file is created with mode
// 0600 and never overwrites one that exists. Output: `waitlist <count>` and `wrote <n> rows to <path>`.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';

const out=process.argv[2];
if(!out||process.argv.length>3){console.error('usage: node ops/waitlist-export.mjs <out.csv>');process.exit(2)}
const file=path.join(process.env.STATE_DIR||'/state','identities.sqlite');
if(!existsSync(file)){console.error(`no store at ${file} (set STATE_DIR)`);process.exit(1)}
const db=new DatabaseSync(file,{readOnly:true,timeout:2000});
const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='waitlist'").get();
const rows=table?db.prepare('SELECT email,created_at,source FROM waitlist ORDER BY created_at,email').all():[];
db.close();
// Every field quoted; a quote inside is doubled. A leading = + - @ is prefixed with ' so a spreadsheet never runs it.
const cell=v=>{const s=String(v);return `"${(/^[=+\-@]/.test(s)?`'${s}`:s).replace(/"/g,'""')}"`};
const csv=['email,created_at,source',...rows.map(r=>[r.email,new Date(Number(r.created_at)).toISOString(),r.source].map(cell).join(','))].join('\n')+'\n';
console.log(`waitlist ${rows.length}`);
try{writeFileSync(out,csv,{mode:0o600,flag:'wx'})}
catch(e){console.error(e.code==='EEXIST'?`${out} exists; choose a new path`:`could not write ${out}: ${e.message}`);process.exit(1)}
console.log(`wrote ${rows.length} rows to ${out}`);

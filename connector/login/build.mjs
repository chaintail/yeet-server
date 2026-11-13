// Builds the sign-in bundle (dist/login.js) and the fund page bundle (dist/fund.js), served by the sign-in server
// at /account/privy-login/. Shared code (React, Privy) lands in split chunks next to them.
import {build} from 'esbuild';
const src=(f)=>new URL(f,import.meta.url).pathname;
await build({entryPoints:{login:src('./src.jsx'),fund:src('./fund.jsx')},bundle:true,format:'esm',target:'es2022',outdir:new URL('./dist',import.meta.url).pathname,entryNames:'[name]',splitting:true,minify:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'});

// Builds the sign-in bundle to dist/login.js (served by the sign-in server at /demo/privy-login/login.js).
import {build} from 'esbuild';
await build({entryPoints:[new URL('./src.jsx',import.meta.url).pathname],bundle:true,format:'esm',target:'es2022',outdir:new URL('./dist',import.meta.url).pathname,entryNames:'login',splitting:true,minify:true,define:{'process.env.NODE_ENV':'"production"'},logLevel:'warning'});

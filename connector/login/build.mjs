import {build} from 'esbuild';
await build({entryPoints:['src.jsx'],bundle:true,format:'esm',target:'es2022',outdir:'../viewer/privy-login',entryNames:'login',splitting:true,minify:true,define:{'process.env.NODE_ENV':'"production"'}});

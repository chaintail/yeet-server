// Builds the sign-in bundle (dist/login.js), the fund page bundle (dist/fund.js) and the trade page's sign-in step
// (dist/sign.js, which as/viewer/sign/sign.js imports only when the browser has no session) and the agent approval page
// (dist/agent.js, as/agent-page.mjs), served by the sign-in server
// at /account/privy-login/. Shared code (React, Privy) lands in split chunks next to them.
import {build} from 'esbuild';
import {writeFileSync} from 'node:fs';
import {agentBundleFiles,AGENT_MANIFEST} from './agent-files.mjs';
const src=(f)=>new URL(f,import.meta.url).pathname;
// The sign-in page creates the Solana wallet with useCreateWallet from "@privy-io/react-auth/solana" (3.47.0). That
// entry also imports getAddMemoInstruction from the optional peer "@solana-program/memo", used only for Sign In With
// Solana memo transactions, which YEET does not offer. The peer is not installed; this stands in for it and throws
// if anything ever calls it.
const optionalSolanaMemo={name:'optional-solana-memo',setup(b){
 b.onResolve({filter:/^@solana-program\/memo$/},()=>({path:'solana-memo',namespace:'optional-peer'}));
 b.onLoad({filter:/.*/,namespace:'optional-peer'},()=>({contents:'export function getAddMemoInstruction(){throw Error("Sign In With Solana is not available here")}',loader:'js'}));
}};
const out=await build({entryPoints:{login:src('./src.jsx'),fund:src('./fund.jsx'),sign:src('./sign.jsx'),agent:src('./agent.jsx')},bundle:true,format:'esm',target:'es2022',outdir:new URL('./dist',import.meta.url).pathname,entryNames:'[name]',splitting:true,minify:true,define:{'process.env.NODE_ENV':'"production"'},plugins:[optionalSolanaMemo],logLevel:'warning',metafile:true});
// The files agent.js loads (itself and its chunks): the only bundle files the agent host serves (as/agent-page.mjs).
const agentFiles=agentBundleFiles(out.metafile);
if(!agentFiles.includes('agent.js'))throw Error('agent.js missing from the build');
writeFileSync(new URL('./dist/'+AGENT_MANIFEST,import.meta.url),JSON.stringify(agentFiles)+'\n');

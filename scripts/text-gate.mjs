// Text gate (port plan 1.6, acceptance A-5): no human-visible string may contain the whole words "mcp" or "folio"
// (case-insensitive). Protocol identifiers that must contain "mcp" are allow-listed by exact string and removed
// before matching; nothing else is exempt. Run from anywhere: node scripts/text-gate.mjs
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const C=new URL('connector/',root);
export const ALLOW=Object.freeze([
 'text/html;profile=mcp-app',               // app template MIME type (protocol)
 'mcp/www_authenticate',                    // result _meta key for step-up authorization (protocol)
 '@modelcontextprotocol/sdk/server/mcp.js', // SDK import path
 '@modelcontextprotocol/sdk/server/streamableHttp.js', // SDK import path
 'connector/mcp',                           // directory name
 'mcp-resource',                            // internal OAuth client id of the connector (introspection only, never rendered)
]);
const BANNED=/\b(mcp|folio)\b/gi;
const stripAllowed=text=>ALLOW.reduce((t,a)=>t.split(a).join(' '),text).replace(/data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi,' ');
const hits=[];
export function check(label,text){
 const lines=stripAllowed(String(text)).split('\n');
 lines.forEach((line,i)=>{for(const m of line.matchAll(BANNED))hits.push(`${label}:${i+1}: "${m[0]}" in ${JSON.stringify(line.trim().slice(Math.max(0,m.index-40),m.index+40))}`)});
}
// Self-check: the gate must catch both words and must not be defeated by case.
check('self-test','Connect Folio');check('self-test','POST /MCP');
if(hits.length!==2){console.error('text gate self-test failed');process.exit(2)}
hits.length=0;

// 1. Whole files whose text is shown to people (pages, consent copy, card and tool text, error catalogue, login bundle).
const files=['as/as.mjs','as/auth-pages.mjs','as/consent-selection.mjs','as/account-recovery.mjs','as/viewer/auth-pages.css',
 'mcp/instructions.mjs','mcp/widgets.mjs','mcp/errors.mjs','mcp/tool-registration.mjs',
 'vendor/yeet-win/contracts/yeet-tools.json','contracts/errors.mjs','core/failure.mjs','core/coins.mjs','core/trade/proposals.mjs','core/trade/tracker.mjs','core/trade/engine.mjs','login/src.jsx','login/build.mjs'];
const widgetDir=new URL('vendor/yeet-win/widget/',C);
if(existsSync(widgetDir))for(const f of readdirSync(widgetDir))files.push(`vendor/yeet-win/widget/${f}`);
for(const f of files)check(`connector/${f}`,readFileSync(new URL(f,C),'utf8'));

// 2. Rendered surfaces, as a person or the model receives them.
const {instructions,titles,descriptions}=await import(new URL('mcp/instructions.mjs',C));
const {widgetHtml,resourceMeta,WIDGET_VIEWS}=await import(new URL('mcp/widgets.mjs',C));
const {TOOL_ERRORS}=await import(new URL('contracts/errors.mjs',C));
const {toolError}=await import(new URL('mcp/errors.mjs',C));
const pages=await import(new URL('as/auth-pages.mjs',C));
const {consentForm}=await import(new URL('as/consent-selection.mjs',C));
check('rendered:instructions',instructions);
for(const [k,v] of Object.entries(titles))check(`rendered:title:${k}`,v);
for(const [k,v] of Object.entries(descriptions))check(`rendered:description:${k}`,v);
for(const [code,e] of Object.entries(TOOL_ERRORS)){check(`rendered:error:${code}`,e.message);check(`rendered:card:${code}`,e.title);check(`rendered:tool-error:${code}`,toolError({error:code}).content[0].text)}
for(const view of WIDGET_VIEWS){check(`rendered:card-html:${view}`,widgetHtml(view));check(`rendered:card-meta:${view}`,JSON.stringify(resourceMeta(view)))}
const prior=process.env.PRIVY_LOGIN;
for(const mode of ['1','0']){process.env.PRIVY_LOGIN=mode;for(const p of ['login','consent'])check(`rendered:page-title:${p}:${mode}`,pages.promptTitle(p))}
if(prior===undefined)delete process.env.PRIVY_LOGIN;else process.env.PRIVY_LOGIN=prior;
check('rendered:expired-page',pages.expiredAuthorizationBody);
check('rendered:renewal',pages.renewableConsentCopy(3600));
check('rendered:credentials',pages.credentials());
check('rendered:consent',consentForm({csrf:'x',accountId:'yeet-privy-a',clientId:'https://chatgpt.com/oauth/client.json',resource:'https://chatgpt.yeet.win',requested:['openid','offline_access','yeet:read','yeet:write','yeet:trade']}));
const contract=JSON.parse(readFileSync(new URL('vendor/yeet-win/contracts/yeet-tools.json',C),'utf8'));
check('rendered:contract-title',contract.title);
for(const [card,c] of Object.entries(contract['x-yeet-cards']))check(`rendered:card-spec:${card}`,c.title+'\n'+c.description);
for(const [scope,text] of Object.entries(contract['x-yeet-scopes']))check(`rendered:scope:${scope}`,text);

if(hits.length){console.error(`TEXT GATE FAIL (${hits.length})`);for(const h of hits)console.error('  '+h);process.exit(1)}
console.log(`TEXT GATE PASS: ${files.length} files and ${WIDGET_VIEWS.length} cards, ${Object.keys(TOOL_ERRORS).length} error codes, ${Object.keys(titles).length} tools checked; allow-list: ${ALLOW.map(a=>JSON.stringify(a)).join(', ')}`);

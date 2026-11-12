// ChatGPT cards: home (yeet_home), basket (yeet_propose, yeet_quote) and receipt (execute_trade, trade_status).
// Each view has its own versioned URI so a host never serves a cached older template. The real card runtime comes
// from the vendored yeet-win widget package (vendor/yeet-win/widget/<view>-v1.html); until that is vendored, a
// small built-in card shows the tool result as plain text. Rendering uses textContent only.
import {existsSync,readFileSync} from 'node:fs';
import {cards} from '#contracts/errors';

export const HOME_UI_URI = 'ui://yeet/home-v1.html';
export const BASKET_UI_URI = 'ui://yeet/basket-v1.html';
export const RECEIPT_UI_URI = 'ui://yeet/receipt-v1.html';
/** Card-only result `_meta` keys: the card reads these, the model reads structuredContent. */
export const CARD_META_KEY = 'yeet/card';
export const CONFIRM_META_KEY = 'yeet/confirm';
/** Protocol MIME type for app templates. */
export const TEMPLATE_MIME = 'text/html;profile=mcp-app';

const VIEWS = {
  home: {uri: HOME_UI_URI, title: 'YEET home', description: "YEET VIEWS.home.description."},
  basket: {uri: BASKET_UI_URI, title: 'YEET basket', description: 'The proposed coins, their parts and the quote, with the ⚡ YEET button.'},
  receipt: {uri: RECEIPT_UI_URI, title: 'YEET receipt', description: 'What was sent, the status of each coin and what you received.'},
};

const here = (file) => new URL(file, import.meta.url);
const vendored = (view) => new URL(`../vendor/yeet-win/widget/${view}-v1.html`, import.meta.url);
const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(here(`./viewer/brand/${file}`)).toString('base64')}`;
const scriptJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/** Built-in fallback card: shows the tool result as plain text, plus the catalogue card for an error. */
function builtinCard(view) {
  const spec = VIEWS[view];
  const style = `@font-face{font-family:Inter;src:url(${dataUri('inter.woff2', 'font/woff2')}) format('woff2')}body{margin:0;font:14px/1.45 Inter,system-ui,sans-serif;color:#111;background:#fff}main{padding:14px 16px}h1{font-size:15px;margin:0 0 8px}pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.4 ui-monospace,monospace}@media (prefers-color-scheme:dark){body{color:#eee;background:#141414}}`;
  const script = `(()=>{const PROBLEMS=${scriptJson(cards())};const title=document.getElementById('t'),out=document.getElementById('o');
function show(v){if(!v||typeof v!=='object')return;const data=v.structuredContent??v;let text;try{const e=typeof data.error==='string'?data:(v.isError&&v.content?.[0]?.text?JSON.parse(v.content[0].text):null);if(e&&PROBLEMS[e.error]){title.textContent=PROBLEMS[e.error][0];out.textContent=PROBLEMS[e.error][1];return}}catch{}
text=JSON.stringify(data,null,2);out.textContent=text}
function height(){try{window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:document.documentElement.scrollHeight}},'*')}catch{}}
window.addEventListener('message',m=>{const d=m.data;if(d&&d.jsonrpc==='2.0'&&d.method==='ui/notifications/tool-result'){show(d.params);height()}});
window.addEventListener('openai:set_globals',()=>{show(window.openai?.toolOutput);height()});
if(window.openai?.toolOutput)show(window.openai.toolOutput);height()})();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${spec.title}</title><style>${style}</style></head><body><main><h1 id="t">${spec.title}</h1><pre id="o">Loading…</pre></main><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

/** The complete, self-contained HTML for one view: 'home' | 'basket' | 'receipt'. */
export function widgetHtml(view) {
  if (!VIEWS[view]) throw new Error(`Unknown card view: ${view}`);
  return existsSync(vendored(view)) ? readFileSync(vendored(view), 'utf8') : builtinCard(view);
}

/** Resource `_meta` for every card: bordered, inline only, no network access from the frame. */
export function resourceMeta(view) {
  return {
    ui: {prefersBorder: true, csp: {connectDomains: [], resourceDomains: []}},
    'openai/ui': {availableDisplayModes: ['inline']},
    'openai/widgetDescription': VIEWS[view].description,
    'openai/widgetPrefersBorder': true,
  };
}

/** Tool `_meta` that attaches a card. `hidden` keeps the tool away from the model (card-only). */
export function toolMeta(view, {widgetAccessible, hidden = false}) {
  const {uri} = VIEWS[view];
  return {
    ui: {resourceUri: uri, ...(hidden ? {visibility: ['app']} : {})},
    'openai/outputTemplate': uri,
    'openai/widgetAccessible': widgetAccessible,
    ...(hidden ? {'openai/visibility': 'private'} : {}),
  };
}

/** Registers the card resources on a server (McpServer.registerResource). */
export function registerWidgets(server) {
  for (const [view, spec] of Object.entries(VIEWS)) {
    const html = widgetHtml(view);
    server.registerResource(`yeet-${view}-card`, spec.uri, {mimeType: TEMPLATE_MIME}, async () => ({
      contents: [{uri: spec.uri, mimeType: TEMPLATE_MIME, text: html, _meta: resourceMeta(view)}],
    }));
  }
}

export const WIDGET_VIEWS = Object.freeze(Object.keys(VIEWS));

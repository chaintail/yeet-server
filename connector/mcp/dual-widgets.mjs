// ChatGPT cards for the dual-account connector: portfolio (get_portfolio), saved report (save_research) and
// account choice (get_profile). One runtime (viewer/folio-dual.js) is stamped per view; each view has its own
// versioned URI so a host never serves a cached older template. Rendering uses textContent only.
import {readFileSync} from 'node:fs';
import {cards} from '#contracts/errors';

export const PORTFOLIO_UI_URI = 'ui://folio/portfolio-v1.html';
export const RESEARCH_UI_URI_V2 = 'ui://folio/research-report-v2.html';
export const ACCOUNT_CHOICE_UI_URI = 'ui://folio/account-choice-v1.html';
/** save_research puts the sanitized rich card (body, report v1, proposals without verbs, quote snapshot) here in result _meta. */
export const REPORT_META_KEY = 'folio/report';

const VIEWS = {
  portfolio: {uri: PORTFOLIO_UI_URI, title: 'Folio accounts', description: 'Your Folio Trial and Real accounts, shown separately with cash, holdings and update times.'},
  report: {uri: RESEARCH_UI_URI_V2, title: 'Folio research', description: 'A research report saved to one Folio account, with the prices used, the full report and Open in Folio.'},
  choice: {uri: ACCOUNT_CHOICE_UI_URI, title: 'Folio account choice', description: 'Asks which Folio account, Trial or Real, the current task is for.'},
};

const here = (file) => new URL(file, import.meta.url);
const read = (file) => readFileSync(here(file), 'utf8');
const dataUri = (file, mime) => `data:${mime};base64,${readFileSync(here(`./viewer/brand/${file}`)).toString('base64')}`;
const scriptJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

let cachedAssets;
function brandAssets() {
  if (cachedAssets) return cachedAssets;
  const logos = JSON.parse(read('./viewer/brand/logos.json'));
  cachedAssets = Object.fromEntries(Object.entries(logos).map(([symbol, asset]) => [symbol, {name: asset.name, src: dataUri(asset.file, asset.mime)}]));
  return cachedAssets;
}

/** The complete, self-contained HTML for one view: 'portfolio' | 'report' | 'choice'. */
export function dualWidgetHtml(view) {
  const spec = VIEWS[view];
  if (!spec) throw new Error(`Unknown Folio card view: ${view}`);
  const style = read('./viewer/folio-dual.css')
    .replace('__INTER__', dataUri('inter.woff2', 'font/woff2'))
    .replace('__NEWSREADER__', dataUri('newsreader.woff2', 'font/woff2'));
  const script = read('./viewer/folio-dual.js')
    .replace('__VIEW__', scriptJson(view))
    .replace('__BRAND_ASSETS__', scriptJson(brandAssets()))
    .replace('__PROBLEMS__', () => scriptJson(cards()));
  // Function replacers: the inserted text may contain `$` sequences that string replacement would expand.
  return read('./viewer/folio-dual.html')
    .replace('__TITLE__', () => spec.title)
    .replace('__VIEW_NAME__', () => view)
    .replace('__STYLE__', () => style)
    .replace('__SCRIPT__', () => script.replaceAll('</script', '<\\/script'));
}

/** Resource `_meta` for every card: bordered, inline only, no network access from the frame. */
export function dualResourceMeta(view) {
  return {
    ui: {prefersBorder: true, csp: {connectDomains: [], resourceDomains: []}},
    'openai/ui': {availableDisplayModes: ['inline']},
    'openai/widgetDescription': VIEWS[view].description,
    'openai/widgetPrefersBorder': true,
  };
}

/** Tool `_meta` that attaches a card to a tool: get_portfolio → 'portfolio', save_research → 'report', get_profile → 'choice'. */
export function dualToolMeta(view) {
  const {uri} = VIEWS[view];
  return {ui: {resourceUri: uri}, 'openai/outputTemplate': uri, 'openai/widgetAccessible': false};
}

/** Registers the three card resources on an MCP server (McpServer.registerResource). */
export function registerDualWidgets(server) {
  for (const [view, spec] of Object.entries(VIEWS)) {
    const html = dualWidgetHtml(view);
    server.registerResource(`folio-${view}-card`, spec.uri, {mimeType: 'text/html;profile=mcp-app'}, async () => ({
      contents: [{uri: spec.uri, mimeType: 'text/html;profile=mcp-app', text: html, _meta: dualResourceMeta(view)}],
    }));
  }
}

export const DUAL_VIEWS = Object.freeze(Object.keys(VIEWS));

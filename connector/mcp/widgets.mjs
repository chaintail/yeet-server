// ChatGPT cards from the vendored yeet-win widget package (vendor/yeet-win/widget/, commit in vendor/yeet-win/PINNED):
// home, basket, receipt, portfolio and leaderboard, one self-contained template each. Card ids, URIs, titles and
// descriptions come from the contract's `x-yeet-cards`; the template file per URI from the widget's templates.json.
import {readFileSync} from 'node:fs';
import {CARDS,META_KEYS,toolSpecs} from './tool-contract.mjs';

/** Card-only result `_meta` keys: the card reads these, the model reads structuredContent. */
export const CARD_META_KEY = META_KEYS.card;
export const CONFIRM_META_KEY = META_KEYS.confirm;
/** Protocol MIME type for app templates. */
export const TEMPLATE_MIME = 'text/html;profile=mcp-app';
export const HOME_UI_URI = CARDS.home.uri;
export const BASKET_UI_URI = CARDS.basket.uri;
export const RECEIPT_UI_URI = CARDS.receipt.uri;
export const PORTFOLIO_UI_URI = CARDS.portfolio.uri;
export const LEADERBOARD_UI_URI = CARDS.leaderboard.uri;

const widgetDir = new URL('../vendor/yeet-win/widget/', import.meta.url);
const templates = JSON.parse(readFileSync(new URL('templates.json', widgetDir), 'utf8'));
for (const [view, {uri}] of Object.entries(CARDS)) {
  if (uri !== `ui://yeet/${view}-v1.html`) throw Error(`Card ${view}: unexpected URI ${uri}`);
  if (typeof templates[uri] !== 'string' || !/^[a-z]+-v1\.html$/.test(templates[uri])) throw Error(`Card ${view}: no vendored template`);
}
const html = new Map(Object.entries(CARDS).map(([view, {uri}]) => [view, readFileSync(new URL(templates[uri], widgetDir), 'utf8')]));

/** The complete, self-contained HTML for one view. */
export function widgetHtml(view) {
  if (!html.has(view)) throw new Error(`Unknown card view: ${view}`);
  return html.get(view);
}

/** Resource `_meta` for every card: bordered, inline only, no network access from the frame. */
export function resourceMeta(view) {
  return {
    ui: {prefersBorder: true, csp: {connectDomains: [], resourceDomains: []}},
    'openai/ui': {availableDisplayModes: ['inline']},
    'openai/widgetDescription': CARDS[view].description,
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': {connect_domains: [], resource_domains: []},
  };
}

/** Tool `_meta` from the contract: card template, model visibility and whether the card may call the tool. A tool
 * the model may not see (execute_trade, daily_spin) is `openai/visibility: private` and `ui.visibility: ['app']`. */
export function toolMeta(name) {
  const t = toolSpecs[name];
  if (!t) throw new Error(`Unknown tool: ${name}`);
  const uri = t.card ? CARDS[t.card].uri : null;
  return {
    ...(uri ? {'openai/outputTemplate': uri} : {}),
    ui: {...(uri ? {resourceUri: uri} : {}), visibility: t.visible ? ['model', 'app'] : ['app']},
    'openai/widgetAccessible': t.widgetAccessible,
    ...(t.visible ? {} : {'openai/visibility': 'private'}),
  };
}

/** Registers the card resources on a server (McpServer.registerResource). */
export function registerWidgets(server) {
  for (const [view, spec] of Object.entries(CARDS)) {
    const text = widgetHtml(view);
    server.registerResource(`yeet-${view}-card`, spec.uri, {mimeType: TEMPLATE_MIME, title: spec.title, description: spec.description}, async () => ({
      contents: [{uri: spec.uri, mimeType: TEMPLATE_MIME, text, _meta: resourceMeta(view)}],
    }));
  }
}

export const WIDGET_VIEWS = Object.freeze(Object.keys(CARDS));

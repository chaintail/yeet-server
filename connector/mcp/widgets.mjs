// ChatGPT cards from the vendored yeet-win widget package (vendor/yeet-win/widget/, commit in vendor/yeet-win/PINNED):
// one self-contained template per card (overview, home, basket, receipt, portfolio, leaderboard, ...). Card ids, URIs, titles and
// descriptions come from the contract's `x-yeet-cards`; the template file per URI from the widget's templates.json.
import {readFileSync} from 'node:fs';
import {CARDS,META_KEYS,toolSpecs} from './tool-contract.mjs';
import {SIGNING_VIEWS,signingCsp} from '#shared/signing.mjs';
export {SIGNING_VIEWS};

/** Card-only result `_meta` keys: the card reads these, the model reads structuredContent. */
export const CARD_META_KEY = META_KEYS.card;
export const CONFIRM_META_KEY = META_KEYS.confirm;
/** Protocol MIME type for app templates. */
export const TEMPLATE_MIME = 'text/html;profile=mcp-app';
export const OVERVIEW_UI_URI = CARDS.overview.uri;
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

/**
 * Resource `_meta` for every card: bordered, inline only. Without `signOrigin`, or for a card that never signs (home,
 * leaderboard), no network access from the frame. With it, a signing card (basket, portfolio, receipt) declares the
 * signing domains (shared/signing.mjs signingCsp: Privy's auth and wallet API, the connector origin for the signer
 * script and the signing page, Privy's wallet iframe). `ui.domain` is never set: the card origin ChatGPT derives from
 * the connector URL is the one on the Privy allowed list.
 */
export function resourceMeta(view, {signOrigin = null} = {}) {
  const c = signOrigin && SIGNING_VIEWS.includes(view) ? signingCsp(signOrigin) : null;
  return {
    ui: {prefersBorder: true, csp: c ? {connectDomains: c.connect, resourceDomains: c.resource, frameDomains: c.frame} : {connectDomains: [], resourceDomains: []}},
    'openai/ui': {availableDisplayModes: ['inline']},
    'openai/widgetDescription': CARDS[view].description,
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': c ? {connect_domains: c.connect, resource_domains: c.resource, frame_domains: c.frame, redirect_domains: c.redirect} : {connect_domains: [], resource_domains: []},
  };
}

/** Tool `_meta` from the contract: card template, model visibility and whether the card may call the tool. A tool
 * the model may not see (execute_trade, daily_spin) is `openai/visibility: private` and `ui.visibility: ['app']`. */
export function toolMeta(name) {
  const t = toolSpecs[name];
  if (!t) throw new Error(`Unknown tool: ${name}`);
  const uri = t.visible && t.card ? CARDS[t.card].uri : null;
  return {
    ...(uri ? {'openai/outputTemplate': uri} : {}),
    ui: {...(uri ? {resourceUri: uri} : {}), visibility: t.visible ? ['model', 'app'] : ['app']},
    'openai/widgetAccessible': t.widgetAccessible,
    // The short status lines ChatGPT shows while a tool the model called runs, and after (contract tools.<name>.invocation).
    ...(t.visible && t.invocation ? {'openai/toolInvocation/invoking': t.invocation.invoking, 'openai/toolInvocation/invoked': t.invocation.invoked} : {}),
    ...(t.visible ? {} : {'openai/visibility': 'private'}),
  };
}

/** Registers the card resources on a server (McpServer.registerResource). `signOrigin`: see resourceMeta. */
export function registerWidgets(server, {signOrigin = null} = {}) {
  for (const [view, spec] of Object.entries(CARDS)) {
    const text = widgetHtml(view);
    server.registerResource(`yeet-${view}-card`, spec.uri, {mimeType: TEMPLATE_MIME, title: spec.title, description: spec.description}, async () => ({
      contents: [{uri: spec.uri, mimeType: TEMPLATE_MIME, text, _meta: resourceMeta(view, {signOrigin})}],
    }));
  }
}

export const WIDGET_VIEWS = Object.freeze(Object.keys(CARDS));

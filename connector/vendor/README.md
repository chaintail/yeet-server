# Vendored files from chaintail/yeet-win

`yeet-win/PINNED` records the yeet-win commit every file under `yeet-win/` was built from. Nothing here is edited by
hand; run `scripts/vendor-yeet-win.sh` again to update.

| File here | Source in yeet-win | Used by |
|---|---|---|
| `yeet-win/contracts/yeet-tools.json` | `contracts/yeet-tools.json` | `mcp/tool-contract.mjs` (schemas, titles, descriptions, annotations, scopes, cards, visibility), `contracts/errors.mjs` (`x-yeet-errors`) |
| `yeet-win/widget/*-v1.html`, `templates.json` | `packages/widget` (`node build.mjs`) | `mcp/widgets.mjs` (the five `ui://yeet/*-v1.html` templates) |
| `yeet-win/router/dist/src/**` | `packages/router` (`tsc -p tsconfig.json`) | `core/trade/*` (`buildYeetPlan`, `buildSkeetPlan`, `applyStatus`, `ReceiptSchema`, `OneClickClient`), `core/coins.mjs` (`catalog.json`) |

The router's only runtime dependency is `zod`, which resolves to the connector's own `zod`.

## Updating

```
scripts/vendor-yeet-win.sh ~/code/yeet-win main     # or any commit / branch
cd connector && npm test && npm run text-gate
```

The script copies the sources with `git archive` into the ignored `.build/yeet-win-<sha>/`, installs the router's
pinned toolchain there, builds the router and the widget, and copies the results here. It never writes into the
yeet-win checkout.

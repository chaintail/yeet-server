# Vendored files from chaintail/yeet-win

`yeet-win/PINNED` records the yeet-win commit every file under `yeet-win/` was copied from.

| File here | Source in yeet-win | Used by |
|---|---|---|
| `yeet-win/packages/router/src/catalog.json` | `packages/router/src/catalog.json` | `core/coins.mjs` (`yeet_coins`) |

## Tool contract

`connector/contracts/yeet-tools.json` is a local P0 contract written from the port plan (sections 2.1 and 2.2).
It is replaced by yeet-win `contracts/yeet-tools.json` once that file is committed there: copy it to
`connector/contracts/yeet-tools.json`, add its path to `PINNED`, and run `npm test` (the contract and
registration tests check the tool names, schemas and the `x-yeet-errors` catalogue).

## Card templates

`connector/mcp/widgets.mjs` serves `yeet-win/widget/{home,basket,receipt}-v1.html` from this directory when
those files exist. Until the yeet-win widget package is vendored here, a small built-in card shows the tool
result as plain text.

## Updating

1. `git -C ~/code/yeet-win show <sha>:<path> > connector/vendor/yeet-win/<path>` for each file.
2. Write the new sha into `PINNED`.
3. `npm test` in `connector/`.

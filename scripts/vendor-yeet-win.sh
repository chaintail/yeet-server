#!/usr/bin/env bash
# Vendor the public yeet-win pieces the connector needs, from a pinned commit, without writing into yeet-win.
#
#   scripts/vendor-yeet-win.sh <path-to-yeet-win> [ref, default main]
#
# 1. `git archive <ref>` of contracts/, packages/router/, packages/widget/, brand/, apps/landing/type-data.js (the
#    card build inlines the brand tokens, logo, mark and heading glyphs) and the workspace manifests is unpacked
#    into .build/yeet-win-<sha>/ (ignored by git; reused when it already exists).
# 2. The router is built there with its own pinned toolchain (npm ci of the router workspace, then tsc), and the
#    widget with `node build.mjs` (dist/*.html + dist/templates.json).
# 3. Results go to connector/vendor/yeet-win/:
#      contracts/yeet-tools.json   tool schemas, card list and the x-yeet-errors catalogue
#      widget/*.html, widget/templates.json
#      widget/yeet-signer.js        the card's Privy signer (packages/widget/scripts/build-signer.mjs), served by the
#                                   sign-in server at /cards/yeet-signer-<sha256:12>.js (as/sign-page.mjs)
#      router/dist/**               compiled @yeet/router (dist/src only: index, 1Click client, plan, receipt, catalogue)
#      router/test/fixtures/*.json  recorded 1Click quote/status payloads (the engine tests' fake 1Click answers from them)
#      PINNED                       the yeet-win commit every file above came from
set -euo pipefail
src="${1:?usage: vendor-yeet-win.sh <path-to-yeet-win> [ref]}"
ref="${2:-main}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sha="$(git -C "$src" rev-parse --verify "${ref}^{commit}")"
build="$root/.build/yeet-win-$sha"
dest="$root/connector/vendor/yeet-win"

mkdir -p "$root/.build"
if [ ! -f "$build/.unpacked" ]; then
  mkdir -p "$build"
  git -C "$src" archive --format=tar "$sha" contracts packages/router packages/widget brand apps/landing/type-data.js package.json package-lock.json | tar -x -C "$build"
  touch "$build/.unpacked"
fi

(
  cd "$build"
  if [ ! -x node_modules/.bin/tsc ]; then
    npm ci --workspace packages/router --include-workspace-root=false --ignore-scripts --no-audit --no-fund --prefer-offline >/dev/null
  fi
  (cd packages/router && ../../node_modules/.bin/tsc -p tsconfig.json)
  # The widget build also writes the landing page's wheel.js/wheel.css into apps/landing/ (not vendored).
  mkdir -p apps/landing
  # Every template carries the commit it is built from (cardBuild in packages/widget/index.mjs): a card sends it with
  # its tool calls, and the connector compares it with this pin (connector/mcp/refresh.mjs).
  (cd packages/widget && YEET_CARD_BUILD="$sha" node build.mjs)
  # The Privy signer the trade card loads by <script> (too big to inline: about 855 KB). esbuild and
  # @privy-io/js-sdk-core come from this repo's lock-pinned connector/login install (npm run build:login first).
  if [ -f packages/widget/scripts/build-signer.mjs ]; then
    (cd packages/widget && YEET_CONNECTOR_DIR="$root/connector" node scripts/build-signer.mjs)
  fi
)

mkdir -p "$dest/contracts" "$dest/widget" "$dest/router/dist" "$dest/router/test/fixtures"
cp "$build/contracts/yeet-tools.json" "$dest/contracts/yeet-tools.json"
rsync -a --delete --include='*.html' --include='templates.json' --include='yeet-signer.js' --exclude='*' "$build/packages/widget/dist/" "$dest/widget/"
rsync -a --delete "$build/packages/router/dist/src/" "$dest/router/dist/src/"
rsync -a --delete --include='*.json' --exclude='*' "$build/packages/router/test/fixtures/" "$dest/router/test/fixtures/"
cat >"$dest/PINNED" <<EOF
repo: chaintail/yeet-win
branch: $ref
commit: $sha
built: router (tsc $("$build/node_modules/.bin/tsc" --version | awk '{print $2}')), widget (node build.mjs)$(test -f "$dest/widget/yeet-signer.js" && echo ", signer (scripts/build-signer.mjs, esbuild $(node -p "require('$root/connector/login/node_modules/esbuild/package.json').version"), @privy-io/js-sdk-core $(node -p "require('$root/connector/login/node_modules/@privy-io/js-sdk-core/package.json').version"), sha256 $(sha256sum "$dest/widget/yeet-signer.js" | cut -c1-12))")
files:
  contracts/yeet-tools.json
  widget/$(cd "$dest/widget" && ls | tr '\n' ' ')
  router/dist/src/**
  router/test/fixtures/*.json
EOF
echo "vendored yeet-win $sha into $dest"

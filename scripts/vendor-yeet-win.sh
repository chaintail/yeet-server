#!/usr/bin/env bash
# Vendor the public yeet-win pieces the connector needs, from a pinned commit, without writing into yeet-win.
#
#   scripts/vendor-yeet-win.sh <path-to-yeet-win> [ref, default main]
#
# 1. `git archive <ref>` of contracts/, packages/router/, packages/widget/ and the workspace manifests is unpacked
#    into .build/yeet-win-<sha>/ (ignored by git; reused when it already exists).
# 2. The router is built there with its own pinned toolchain (npm ci of the router workspace, then tsc), and the
#    widget with `node build.mjs` (dist/*.html + dist/templates.json).
# 3. Results go to connector/vendor/yeet-win/:
#      contracts/yeet-tools.json   tool schemas, card list and the x-yeet-errors catalogue
#      widget/*.html, widget/templates.json
#      router/dist/**               compiled @yeet/router (dist/src only: index, 1Click client, plan, receipt, catalogue)
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
  git -C "$src" archive --format=tar "$sha" contracts packages/router packages/widget package.json package-lock.json | tar -x -C "$build"
  touch "$build/.unpacked"
fi

(
  cd "$build"
  if [ ! -x node_modules/.bin/tsc ]; then
    npm ci --workspace packages/router --include-workspace-root=false --ignore-scripts --no-audit --no-fund --prefer-offline >/dev/null
  fi
  (cd packages/router && ../../node_modules/.bin/tsc -p tsconfig.json)
  (cd packages/widget && node build.mjs)
)

mkdir -p "$dest/contracts" "$dest/widget" "$dest/router/dist"
cp "$build/contracts/yeet-tools.json" "$dest/contracts/yeet-tools.json"
rsync -a --delete --include='*.html' --include='templates.json' --exclude='*' "$build/packages/widget/dist/" "$dest/widget/"
rsync -a --delete "$build/packages/router/dist/src/" "$dest/router/dist/src/"
cat >"$dest/PINNED" <<EOF
repo: chaintail/yeet-win
branch: $ref
commit: $sha
built: router (tsc $("$build/node_modules/.bin/tsc" --version | awk '{print $2}')), widget (node build.mjs)
files:
  contracts/yeet-tools.json
  widget/$(cd "$dest/widget" && ls | tr '\n' ' ')
  router/dist/src/**
EOF
echo "vendored yeet-win $sha into $dest"

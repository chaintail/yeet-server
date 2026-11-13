#!/usr/bin/env bash
# Copy the YEET brand files the sign-in pages serve from a yeet-win commit, without writing into yeet-win.
#
#   tools/sync-brand.sh <path-to-yeet-win> [ref, default main]     copy, then write BRAND-PINNED
#   tools/sync-brand.sh --check <path-to-yeet-win>                  exit 1 when a copy differs from the pinned commit
#
# Source (in yeet-win)            -> connector/as/viewer/brand/
#   brand/tokens.css                 tokens.css     colour, type, shape and motion tokens
#   brand/logo.svg                   logo.svg       the wordmark in white
#   brand/mark.svg                   mark.svg       the Y that ends in a bolt
#   brand/app-icon.svg               app-icon.svg   the mark on blue; also the page icon (../icon.svg)
#   apps/landing/type-data.js        type-data.js   Archivo Italic outlines for the wide display headings
# BRAND-PINNED records the yeet-win commit every file came from. The files are served as they are: edit them in
# yeet-win and run this again.
set -euo pipefail
check=0
if [ "${1:-}" = "--check" ]; then check=1; shift; fi
src="${1:?usage: sync-brand.sh [--check] <path-to-yeet-win> [ref]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/connector/as/viewer/brand"
pin="$dest/BRAND-PINNED"
if [ "$check" = 1 ]; then
  ref="$(sed -n 's/^commit: //p' "$pin")"
else
  ref="${2:-main}"
fi
sha="$(git -C "$src" rev-parse --verify "${ref}^{commit}")"
files=(
  "brand/tokens.css:tokens.css"
  "brand/logo.svg:logo.svg"
  "brand/mark.svg:mark.svg"
  "brand/app-icon.svg:app-icon.svg"
  "apps/landing/type-data.js:type-data.js"
)
mkdir -p "$dest"
bad=0
for pair in "${files[@]}"; do
  from="${pair%%:*}" to="${pair##*:}"
  if [ "$check" = 1 ]; then
    if ! git -C "$src" show "$sha:$from" | cmp -s - "$dest/$to"; then echo "differs: $to (from $from @ ${sha:0:7})"; bad=1; fi
  else
    git -C "$src" show "$sha:$from" > "$dest/$to"
  fi
done
if [ "$check" = 1 ]; then
  if ! cmp -s "$dest/app-icon.svg" "$dest/../icon.svg"; then echo "differs: icon.svg (copy of brand/app-icon.svg)"; bad=1; fi
  [ "$bad" = 0 ] && echo "PASS brand copies match yeet-win ${sha:0:7}" || { echo "FAIL brand copies differ from yeet-win ${sha:0:7}"; exit 1; }
  exit 0
fi
cp "$dest/app-icon.svg" "$dest/../icon.svg"
printf 'repo: chaintail/yeet-win\ncommit: %s\nfiles:\n' "$sha" > "$pin"
for pair in "${files[@]}"; do printf '  %s -> %s\n' "${pair%%:*}" "${pair##*:}" >> "$pin"; done
printf '  brand/app-icon.svg -> ../icon.svg\n' >> "$pin"
echo "PASS brand synced from yeet-win ${sha:0:7}: ${#files[@]} files"

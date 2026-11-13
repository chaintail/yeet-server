#!/usr/bin/env bash
# Builds the image from a clean export of a commit (default HEAD) with only the repository's own files, the way a
# fresh checkout would, then checks the result inside a throwaway container. Uncommitted changes are not included.
# Uses the tag yeet-connector:clean-check and removes it at the end; the running stack's images are not touched.
# Usage: ops/scripts/clean-build-check.sh [commit]   (needs Docker; prints one PASS or FAIL line)
set -euo pipefail
repo="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
commit="$(git -C "$repo" rev-parse --short "${1:-HEAD}")"
log="$(mktemp --suffix=.clean-build.log)"
tag="yeet-connector:clean-check"
started=$(date +%s)
trap 'docker image rm -f "$tag" >/dev/null 2>&1 || true' EXIT
fail() { echo "FAIL clean build of $commit: $1 ($(( $(date +%s) - started ))s, log $log)"; exit 1; }
# The build context is the commit's tree streamed from git archive: nothing from the working directory gets in.
git -C "$repo" archive --format=tar "$commit" | docker build -f ops/Dockerfile -t "$tag" - >"$log" 2>&1 || fail "docker build"
# Every role's entry module loads its imports, and the sign-in bundle is in the image.
docker run --rm --network none --entrypoint sh "$tag" -c '
  test -s login/dist/login.js && test -s login/dist/fund.js &&
  node --input-type=module -e "await import(\"./as/security-policy.mjs\"); await import(\"./as/body-replay.mjs\"); await import(\"./core/trade/limits.mjs\"); await import(\"./scope-catalog.mjs\")"
' >>"$log" 2>&1 || fail "image check"
echo "PASS clean build of $commit: image built from git archive, bundles present, modules load ($(( $(date +%s) - started ))s, log $log)"

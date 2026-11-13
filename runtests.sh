#!/usr/bin/env bash
# The whole connector suite (connector/package.json "test": node:test files, then the script checks), one line out:
#   PASS connector tests 413/413 node:test, 10 script checks (log: /tmp/yeet-tests.XXXX)
# On failure: FAIL ... plus the failing test names and assertion lines. Exit code is npm test's.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log="$(mktemp "${TMPDIR:-/tmp}/yeet-tests.XXXXXX")"
(cd "$root/connector" && npm test) >"$log" 2>&1
status=$?
total=$(grep -E '^ℹ tests [0-9]+' "$log" | awk '{print $3}')
pass=$(grep -E '^ℹ pass [0-9]+' "$log" | awk '{print $3}')
scripts=$(grep -cE '^PASS ' "$log")
if [ "$status" -eq 0 ]; then
  echo "PASS connector tests ${pass:-0}/${total:-0} node:test, ${scripts} script checks (log: $log)"
else
  echo "FAIL connector tests ${pass:-0}/${total:-?} node:test, ${scripts} script checks passed before the stop (log: $log)"
  grep -E '^✖|AssertionError|^Error|FAIL' "$log" | head -40
fi
exit "$status"

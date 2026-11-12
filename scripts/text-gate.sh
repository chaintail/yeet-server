#!/usr/bin/env bash
# A-5 text gate: fails if a human-visible string contains the whole word "mcp" or "folio" (case-insensitive).
# Needs connector dependencies installed (npm ci in connector/). Allow-list and file list: scripts/text-gate.mjs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/text-gate.mjs"

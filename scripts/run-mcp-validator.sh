#!/usr/bin/env bash
# Run Janix MCP Validator (stdio) against a built mcp-grocy binary.
# https://github.com/Janix-ai/mcp-validator
#
# Env:
#   MCP_VALIDATOR_ROOT   — path to an existing mcp-validator clone (optional)
#   MCP_VALIDATOR_REF    — git ref when cloning (default: v0.3.1)
#   MCP_PROTOCOL_VERSION — if set, run only this version (e.g. 2025-06-18)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${MCP_VALIDATOR_REF:-v0.3.1}"
DEFAULT_CLONE="$ROOT/.cache/mcp-validator"
VALIDATOR="${MCP_VALIDATOR_ROOT:-$DEFAULT_CLONE}"

if [[ ! -f "$VALIDATOR/mcp_testing/scripts/compliance_report.py" ]]; then
  mkdir -p "$(dirname "$VALIDATOR")"
  rm -rf "$VALIDATOR"
  git clone --depth 1 --branch "$REF" https://github.com/Janix-ai/mcp-validator.git "$VALIDATOR"
fi

if [[ ! -f "$ROOT/build/main.js" ]]; then
  echo "run-mcp-validator: missing $ROOT/build/main.js — run npm run build first" >&2
  exit 1
fi

cd "$VALIDATOR"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate
pip install -q -r requirements.txt

# --dynamic-only: initialization + tool discovery (no full static suite).
run_one() {
  local ver="$1"
  shift
  echo "=== MCP validator: protocol $ver ===" >&2
  python -m mcp_testing.scripts.compliance_report \
    --server-command "node $ROOT/build/main.js" \
    --protocol-version "$ver" \
    --dynamic-only \
    "$@"
}

if [[ -n "${MCP_PROTOCOL_VERSION:-}" ]]; then
  run_one "$MCP_PROTOCOL_VERSION" "$@"
  exit $?
fi

status=0
for ver in 2024-11-05 2025-03-26 2025-06-18; do
  run_one "$ver" "$@" || status=1
done
exit "$status"

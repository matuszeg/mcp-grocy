#!/usr/bin/env bash
# Stop the background mcp-grocy HTTP test server.
# Uses MCP_PID if set; otherwise reads .cache/mcp-http-test.pid from repo root.
#
# Usage:
#   bash scripts/stop-mcp-http-for-tests.sh
#   MCP_PID=12345 bash scripts/stop-mcp-http-for-tests.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.cache/mcp-http-test.pid"

PID="${1:-${MCP_PID:-}}"
if [[ -z "$PID" && -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
fi

if [[ -n "$PID" && "$PID" != "0" ]]; then
  kill "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"

#!/usr/bin/env bash
# Start mcp-grocy in HTTP-only mode (background), wait until / health responds.
# For GitHub Actions: appends MCP_PID to GITHUB_ENV for later steps.
# For local use: writes PID to .cache/mcp-http-test.pid (gitignored) and prints stop hint.
#
# Env:
#   GITHUB_WORKSPACE — CI checkout root (defaults to repo root inferred from this script)
#   HTTP_SERVER_PORT — listen port (default: 8790)
#   MCP_MAIN         — path to built entry (default: <root>/build/main.js)
#   MCP_HTTP_TEST_HOST — health check host (default: 127.0.0.1)
#   MCP_HTTP_TEST_MAX_WAIT — seconds to poll (default: 30)
#
# Usage:
#   bash scripts/start-mcp-http-for-tests.sh
#   HTTP_SERVER_PORT=9000 bash scripts/start-mcp-http-for-tests.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${GITHUB_WORKSPACE:-$ROOT}"
PORT="${HTTP_SERVER_PORT:-8790}"
MAIN="${MCP_MAIN:-$WORKSPACE/build/main.js}"
HOST="${MCP_HTTP_TEST_HOST:-127.0.0.1}"
MAX_WAIT="${MCP_HTTP_TEST_MAX_WAIT:-30}"
PID_FILE="$ROOT/.cache/mcp-http-test.pid"

if [[ ! -f "$MAIN" ]]; then
  echo "start-mcp-http-for-tests: missing $MAIN — run npm run build first" >&2
  exit 1
fi

mkdir -p "$(dirname "$PID_FILE")"

export MCP_HTTP_TRANSPORT_ONLY=true
export ENABLE_HTTP_SERVER=true
export HTTP_SERVER_PORT="$PORT"

node "$MAIN" &
PID=$!

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "MCP_PID=$PID" >> "$GITHUB_ENV"
fi

# Local follow-up steps (stop script) when not using GITHUB_ENV
if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo "$PID" > "$PID_FILE"
fi

for _ in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "http://${HOST}:${PORT}/" >/dev/null; then
    echo "MCP HTTP ready at http://${HOST}:${PORT}/ (pid ${PID})"
    if [[ -z "${GITHUB_ENV:-}" ]]; then
      echo "Stop with: bash scripts/stop-mcp-http-for-tests.sh   or: kill ${PID}" >&2
    fi
    exit 0
  fi
  sleep 1
done

echo "start-mcp-http-for-tests: server failed to become ready (pid ${PID})" >&2
kill "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1

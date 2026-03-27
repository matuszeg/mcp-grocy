#!/usr/bin/env bash
# Run StacklokLabs mcp-tef locally (FastAPI + Ollama) for tool-description evaluation.
# https://github.com/StacklokLabs/mcp-tef
#
# Use when changing tool names, descriptions, or overlap between tools.
#
# Prerequisites:
#   - uv: https://docs.astral.sh/uv/
#   - Ollama running: ollama serve
#   - Model pulled: ollama pull <MCP_TEF_OLLAMA_MODEL> (default llama3.2:3b)
#
# Env:
#   MCP_TEF_ROOT           — existing mcp-tef clone (default: <repo>/.cache/mcp-tef)
#   MCP_TEF_REF            — git ref when cloning (default: main)
#   MCP_TEF_UPDATE         — if set (non-empty), git pull --ff-only in the clone before sync
#   MCP_TEF_PORT           — mcp-tef listen port (default: 8000)
#   MCP_TEF_OLLAMA_MODEL   — Ollama model id (default: llama3.2:3b)
#   DEFAULT_MODEL__BASE_URL — OpenAI-compatible base URL (default: http://localhost:11434/v1)
#   OLLAMA_BASE_URL        — alias read if DEFAULT_MODEL__BASE_URL unset
#
# Evaluate mcp-grocy (HTTP + SSE):
#   1. npm run build
#   2. MCP_HTTP_TRANSPORT_ONLY=true ENABLE_HTTP_SERVER=true HTTP_SERVER_PORT=8790 npm start
#   3. npm run dev:mcp-tef
#   4. Open http://127.0.0.1:8000/docs and use MCP server URL http://127.0.0.1:8790/mcp/sse
#
# Extra CLI args are passed through (e.g. --log-level DEBUG).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${MCP_TEF_REF:-main}"
DEFAULT_CLONE="$ROOT/.cache/mcp-tef"
TEF_ROOT="${MCP_TEF_ROOT:-$DEFAULT_CLONE}"
PORT="${MCP_TEF_PORT:-8000}"
MODEL="${MCP_TEF_OLLAMA_MODEL:-llama3.2:3b}"
BASE_URL="${DEFAULT_MODEL__BASE_URL:-${OLLAMA_BASE_URL:-http://localhost:11434/v1}}"
OLLAMA_ORIGIN="${BASE_URL%/v1}"

if ! command -v uv >/dev/null 2>&1; then
  echo "run-mcp-tef: uv is required. Install: https://docs.astral.sh/uv/" >&2
  exit 1
fi

if [[ ! -f "$TEF_ROOT/pyproject.toml" ]]; then
  mkdir -p "$(dirname "$TEF_ROOT")"
  rm -rf "$TEF_ROOT"
  git clone --depth 1 --branch "$REF" https://github.com/StacklokLabs/mcp-tef.git "$TEF_ROOT"
fi

if [[ -n "${MCP_TEF_UPDATE:-}" ]]; then
  git -C "$TEF_ROOT" pull --ff-only
fi

cd "$TEF_ROOT"
uv sync

if ! curl -sf "${OLLAMA_ORIGIN}/api/tags" >/dev/null 2>&1; then
  echo "run-mcp-tef: warning: Ollama not reachable at ${OLLAMA_ORIGIN} — start it and run: ollama pull ${MODEL}" >&2
fi

export DEFAULT_MODEL__PROVIDER=ollama
export DEFAULT_MODEL__NAME="$MODEL"
export DEFAULT_MODEL__BASE_URL="$BASE_URL"

echo "run-mcp-tef: starting mcp-tef at http://127.0.0.1:${PORT}/ (docs: /docs)" >&2
echo "run-mcp-tef: LLM=${MODEL} provider=ollama base=${BASE_URL}" >&2
echo "run-mcp-tef: example mcp-grocy SSE URL → http://127.0.0.1:8790/mcp/sse" >&2

exec uv run python -m mcp_tef --tls-enabled=false --port "$PORT" "$@"

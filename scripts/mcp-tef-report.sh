#!/usr/bin/env bash
# One-shot: build mcp-grocy, start HTTP+SSE, start mcp-tef, write JSON reports, shut down.
# https://github.com/StacklokLabs/mcp-tef
#
# Prerequisites: uv, curl, python3; Ollama running for --with-recommendations / --quality.
#
# Usage:
#   npm run report:mcp-tef
#   npm run report:mcp-tef -- --with-recommendations
#   npm run report:mcp-tef -- --quality
#
# Env (optional):
#   MCP_TEF_ROOT, MCP_TEF_REF, MCP_GROCY_HTTP_PORT (default 8792), MCP_TEF_REPORT_PORT (default 8020)
#   MCP_TEF_OLLAMA_MODEL, DEFAULT_MODEL__BASE_URL / OLLAMA_BASE_URL
#   SIMILARITY_THRESHOLD (default 0.9 — stricter; use 0.85 for more pairs flagged)
#   MCP_GROCY_YAML — optional; must be named mcp-grocy.yaml. Else example is copied with all tools enabled.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${MCP_TEF_REF:-main}"
TEF_ROOT="${MCP_TEF_ROOT:-$ROOT/.cache/mcp-tef}"
GROCY_PORT="${MCP_GROCY_HTTP_PORT:-8792}"
TEF_PORT="${MCP_TEF_REPORT_PORT:-8020}"
MODEL="${MCP_TEF_OLLAMA_MODEL:-llama3.2:3b}"
BASE_URL="${DEFAULT_MODEL__BASE_URL:-${OLLAMA_BASE_URL:-http://localhost:11434/v1}}"
THRESHOLD="${SIMILARITY_THRESHOLD:-0.9}"

INCLUDE_REC=false
RUN_QUALITY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-recommendations) INCLUDE_REC=true ;;
    --quality) RUN_QUALITY=true ;;
    -h | --help)
      echo "Usage: $0 [--with-recommendations] [--quality]" >&2
      echo "  --with-recommendations  LLM suggestions for similar pairs (needs Ollama)" >&2
      echo "  --quality               Per-tool quality scores (slow; needs Ollama)" >&2
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 1
      ;;
  esac
  shift
done

GROCY_PID=""
TEF_PID=""

cleanup() {
  if [[ -n "$TEF_PID" ]]; then
    kill "$TEF_PID" 2>/dev/null || true
    wait "$TEF_PID" 2>/dev/null || true
  fi
  if [[ -n "$GROCY_PID" ]]; then
    kill "$GROCY_PID" 2>/dev/null || true
    wait "$GROCY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

wait_http() {
  local url=$1
  local max=${2:-90}
  local i
  for ((i = 1; i <= max; i++)); do
    if curl -sf "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "mcp-tef-report: timed out waiting for $url" >&2
  return 1
}

if ! command -v uv >/dev/null 2>&1; then
  echo "mcp-tef-report: uv is required (https://docs.astral.sh/uv/)" >&2
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

if [[ "$INCLUDE_REC" == true || "$RUN_QUALITY" == true ]]; then
  OLLAMA_ORIGIN="${BASE_URL%/v1}"
  if ! curl -sf "${OLLAMA_ORIGIN}/api/tags" >/dev/null 2>&1; then
    echo "mcp-tef-report: Ollama not reachable at ${OLLAMA_ORIGIN} (needed for --with-recommendations / --quality)" >&2
    exit 1
  fi
fi

cd "$ROOT"

if [[ ! -f "$ROOT/build/main.js" ]]; then
  echo "mcp-tef-report: building mcp-grocy…" >&2
  npm run build --prefix "$ROOT"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/reports/mcp-tef/${STAMP}"
mkdir -p "$OUT"

YAML_TMP="${OUT}/mcp-grocy.yaml"
if [[ -n "${MCP_GROCY_YAML:-}" ]]; then
  YAML_TMP="$(cd "$(dirname "$MCP_GROCY_YAML")" && pwd)/$(basename "$MCP_GROCY_YAML")"
  if [[ ! -f "$YAML_TMP" ]]; then
    echo "mcp-tef-report: MCP_GROCY_YAML not found: $YAML_TMP" >&2
    exit 1
  fi
  if [[ "$(basename "$YAML_TMP")" != "mcp-grocy.yaml" ]]; then
    echo "mcp-tef-report: MCP_GROCY_YAML must be named mcp-grocy.yaml (resolved from cwd)" >&2
    exit 1
  fi
else
  if [[ ! -f "$ROOT/mcp-grocy.yaml.example" ]]; then
    echo "mcp-tef-report: missing $ROOT/mcp-grocy.yaml.example" >&2
    exit 1
  fi
  sed 's/enabled: false/enabled: true/g' "$ROOT/mcp-grocy.yaml.example" >"$YAML_TMP"
fi
GROCY_CWD="$(cd "$(dirname "$YAML_TMP")" && pwd)"

echo "mcp-tef-report: output directory $OUT" >&2
echo "mcp-tef-report: mcp-grocy config $YAML_TMP (cwd $GROCY_CWD)" >&2

export MCP_HTTP_TRANSPORT_ONLY=true
export ENABLE_HTTP_SERVER=true
export HTTP_SERVER_PORT="$GROCY_PORT"

pushd "$GROCY_CWD" >/dev/null
node "$ROOT/build/main.js" &
GROCY_PID=$!
popd >/dev/null

if ! wait_http "http://127.0.0.1:${GROCY_PORT}/" 90; then
  exit 1
fi

SSE_URL="http://127.0.0.1:${GROCY_PORT}/mcp/sse"
echo "mcp-tef-report: mcp-grocy SSE → $SSE_URL" >&2

export DEFAULT_MODEL__PROVIDER=ollama
export DEFAULT_MODEL__NAME="$MODEL"
export DEFAULT_MODEL__BASE_URL="$BASE_URL"

cd "$TEF_ROOT"
uv run python -m mcp_tef --tls-enabled=false --port "$TEF_PORT" --log-level WARNING &
TEF_PID=$!

if ! wait_http "http://127.0.0.1:${TEF_PORT}/docs" 120; then
  exit 1
fi

TEF_BASE="http://127.0.0.1:${TEF_PORT}"

export STAMP OUT SSE_URL THRESHOLD INCLUDE_REC
SIM_BODY=$(
  python3 <<'PY'
import json, os

print(
    json.dumps(
        {
            "mcp_servers": [
                {"url": os.environ["SSE_URL"], "transport": "sse"},
            ],
            "similarity_threshold": float(os.environ["THRESHOLD"]),
            "include_recommendations": os.environ.get("INCLUDE_REC", "false").lower() == "true",
        }
    )
)
PY
)

echo "mcp-tef-report: POST ${TEF_BASE}/similarity/analyze …" >&2
HTTP_CODE=$(curl -sS -o "$OUT/similarity.json" -w "%{http_code}" -X POST "${TEF_BASE}/similarity/analyze" \
  -H "Content-Type: application/json" \
  -d "$SIM_BODY")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "mcp-tef-report: similarity HTTP $HTTP_CODE" >&2
  head -c 2000 "$OUT/similarity.json" >&2 || true
  echo >&2
  exit 1
fi

if [[ "$RUN_QUALITY" == true ]]; then
  echo "mcp-tef-report: GET tools/quality (this can take several minutes)…" >&2
  export TEF_BASE MODEL
  Q_URL=$(
    python3 <<'PY'
import os
import urllib.parse

q = urllib.parse.urlencode(
    {
        "server_urls": os.environ["SSE_URL"],
        "model_provider": "ollama",
        "model_name": os.environ["MODEL"],
    }
)
print(f"{os.environ['TEF_BASE']}/mcp-servers/tools/quality?{q}")
PY
  )
  if ! curl -sf "$Q_URL" -o "$OUT/tool-quality.json"; then
    echo "mcp-tef-report: tool-quality request failed" >&2
    exit 1
  fi
fi

python3 <<'PY'
import html
import json
import os
import re
from pathlib import Path

out = Path(os.environ["OUT"])
stamp = os.environ["STAMP"]
sse = os.environ["SSE_URL"]
threshold = os.environ["THRESHOLD"]
sim = json.loads((out / "similarity.json").read_text())
pairs = list(sim.get("flagged_pairs") or [])
tool_ids = sim.get("tool_ids") or []


def short_tool_id(composite: str) -> str:
    for sep in ("/mcp/sse:", "/mcp:"):
        if sep in composite:
            return composite.split(sep, 1)[1]
    return composite


def domain(name: str) -> str:
    m = re.match(r"^([a-z]+)_", name)
    return m.group(1) if m else "other"


short_names = [short_tool_id(t) for t in tool_ids]
by_domain: dict[str, list[str]] = {}
for n in short_names:
    by_domain.setdefault(domain(n), []).append(n)
for k in by_domain:
    by_domain[k].sort()

pairs_sorted = sorted(
    pairs,
    key=lambda p: float(p.get("similarity_score") or 0),
    reverse=True,
)

# Short SUMMARY (entry point)
sum_lines = [
    f"# mcp-tef report ({stamp})",
    "",
    "**Read this in the editor:** [`REPORT.md`](REPORT.md) (tables + short tool names).",
    "Optional: open **`REPORT.html`** in a browser for the same content.",
    "",
    f"- Tools analyzed: **{len(tool_ids)}**",
    f"- Flagged pairs (≥ threshold {threshold}): **{len(pairs)}**",
    f"- Raw API JSON: `similarity.json`",
    "",
]
if (out / "tool-quality.json").exists():
    sum_lines.append("- `tool-quality.json` — per-tool quality scores")
(out / "SUMMARY.md").write_text("\n".join(sum_lines) + "\n")

# Human-readable REPORT.md
md: list[str] = [
    f"# mcp-tef similarity — readable report ({stamp})",
    "",
    f"- **MCP URL:** `{sse}`",
    f"- **Threshold:** {threshold}",
    f"- **Generated:** {sim.get('generated_at', '')}",
    "",
    "## Tools in this run",
    "",
    f"**{len(short_names)} tools** (short id, grouped by name prefix):",
    "",
]
for dom in sorted(by_domain.keys()):
    names = by_domain[dom]
    md.append(f"### `{dom}_*` ({len(names)})")
    md.append("")
    md.append(", ".join(f"`{n}`" for n in names))
    md.append("")

md.append("## Flagged similar pairs")
md.append("")
md.append(
    "Sorted by similarity (highest first). Values are embedding cosine similarity (1.0 = identical)."
)
md.append("")
if not pairs_sorted:
    md.append("*None above threshold.*")
else:
    md.append("| Similarity % | Tool A | Tool B |")
    md.append("| ---: | --- | --- |")
    for p in pairs_sorted:
        raw_a, raw_b = p.get("tool_a_id"), p.get("tool_b_id")
        sa, sb = short_tool_id(raw_a), short_tool_id(raw_b)
        pct = 100.0 * float(p.get("similarity_score") or 0)
        md.append(f"| {pct:.1f} | `{sa}` | `{sb}` |")
    md.append("")

recs = sim.get("recommendations")
if recs:
    md.append("## Recommendations (from mcp-tef)")
    md.append("")
    md.append("```json")
    md.append(json.dumps(recs, indent=2)[:20000])
    md.append("```")
    md.append("")

md.append("## Machine-readable")
md.append("")
md.append("- `similarity.json` — full matrix and original composite ids")
md.append("")
(out / "REPORT.md").write_text("\n".join(md) + "\n")

# Simple HTML for browser / print
rows_html = []
for p in pairs_sorted:
    raw_a, raw_b = p.get("tool_a_id"), p.get("tool_b_id")
    sa, sb = short_tool_id(raw_a), short_tool_id(raw_b)
    pct = 100.0 * float(p.get("similarity_score") or 0)
    rows_html.append(
        "<tr><td>{:.1f}</td><td><code>{}</code></td><td><code>{}</code></td></tr>".format(
            pct,
            html.escape(sa),
            html.escape(sb),
        )
    )

html_doc = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>mcp-tef report {stamp}</title>
<style>
  body {{ font-family: system-ui, sans-serif; margin: 1.5rem; max-width: 56rem; }}
  h1 {{ font-size: 1.25rem; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 0.9rem; }}
  th, td {{ border: 1px solid #ccc; padding: 0.35rem 0.5rem; text-align: left; }}
  th {{ background: #f4f4f4; }}
  td:first-child {{ text-align: right; width: 5rem; }}
  code {{ font-size: 0.85rem; }}
  .meta {{ color: #444; font-size: 0.9rem; margin-bottom: 1rem; }}
</style>
</head>
<body>
<h1>mcp-tef similarity report</h1>
<p class="meta">Run <strong>{stamp}</strong> · threshold {th} · {n_tools} tools · {n_pairs} flagged pairs</p>
<p class="meta">MCP: <code>{sse_esc}</code></p>
<h2>Flagged pairs (highest similarity first)</h2>
<table>
<thead><tr><th>%</th><th>Tool A</th><th>Tool B</th></tr></thead>
<tbody>
{rows}
</tbody>
</table>
<p class="meta">See also <code>REPORT.md</code> and <code>similarity.json</code> in the same folder.</p>
</body>
</html>
""".format(
    stamp=html.escape(stamp),
    th=html.escape(str(threshold)),
    n_tools=len(tool_ids),
    n_pairs=len(pairs_sorted),
    sse_esc=html.escape(sse),
    rows="\n".join(rows_html) if rows_html else "<tr><td colspan='3'>No pairs above threshold.</td></tr>",
)
(out / "REPORT.html").write_text(html_doc)
PY

if command -v jq >/dev/null 2>&1; then
  jq . "$OUT/similarity.json" >"$OUT/similarity.pretty.json" && mv "$OUT/similarity.pretty.json" "$OUT/similarity.json"
  [[ -f "$OUT/tool-quality.json" ]] && jq . "$OUT/tool-quality.json" >"$OUT/tq.tmp" && mv "$OUT/tq.tmp" "$OUT/tool-quality.json"
else
  python3 -m json.tool "$OUT/similarity.json" >"$OUT/similarity.pretty.json" && mv "$OUT/similarity.pretty.json" "$OUT/similarity.json"
  if [[ -f "$OUT/tool-quality.json" ]]; then
    python3 -m json.tool "$OUT/tool-quality.json" >"$OUT/tq.tmp" && mv "$OUT/tq.tmp" "$OUT/tool-quality.json"
  fi
fi

echo "mcp-tef-report: done → $OUT/REPORT.md (readable) · $OUT/REPORT.html · $OUT/SUMMARY.md" >&2

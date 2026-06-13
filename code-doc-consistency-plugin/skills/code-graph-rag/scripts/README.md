# Bundled Scripts — code-graph-rag

Self-contained adaptations of [Understand-Anything](https://github.com/anthropics/understand-anything)'s deterministic extraction pipeline. **Zero npm dependencies** — runs on bare Node.js ≥ 18 and Python ≥ 3.8 (stdlib only). Trades tree-sitter accuracy for portability; covers the common cases for the 12 supported code languages plus all non-code categories.

## Why these exist

The agent's pipeline (SCAN → BATCH → ANALYZE → MERGE → REVIEW) reaches into these scripts for every deterministic step. **Do not have the LLM re-implement them** — that's the failure mode this whole architecture exists to avoid.

## Scripts

| Script | Phase | Owner |
|--------|-------|-------|
| `scan-project.mjs` | A. SCAN | code-graph-builder |
| `extract-import-map.mjs` | A. SCAN (imports) | code-graph-builder |
| `compute-batches.mjs` | B. BATCH | code-graph-builder |
| `extract-structure.mjs` | C. ANALYZE (per file) | code-graph-builder |
| `merge-batch-graphs.mjs` | D. MERGE | code-graph-builder |

All are pure Node.js (no Python, no npm install). Tested on Node ≥ 18.

## Invocation order

```bash
WS="$PROJECT_ROOT/_workspace"
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts"

# A. SCAN
node $SKILL/scan-project.mjs "$PROJECT_ROOT" "$WS/01_code_scan.json"

# A. SCAN — imports (build input via Node so paths are correct on Windows)
node -e "
const fs=require('fs');
const s=JSON.parse(fs.readFileSync('$WS/01_code_scan.json','utf8'));
fs.writeFileSync('$WS/01_code_imp_in.json', JSON.stringify({projectRoot:'$PROJECT_ROOT', files:s.files}));
"
node $SKILL/extract-import-map.mjs "$WS/01_code_imp_in.json" "$WS/01_code_imp_out.json"

# B. BATCH
node $SKILL/compute-batches.mjs \
  "$WS/01_code_scan.json" "$WS/01_code_imp_out.json" "$WS/01_code_batches.json"

# C. ANALYZE — for each batch:
# (build per-batch input from batches.json[i], then call extract-structure.mjs;
#  LLM then synthesizes summaries → batch-<i>.json)

# D. MERGE — point at the directory containing batch-*.json files
node $SKILL/merge-batch-graphs.mjs "$WS/code-batches" "$WS/01_code_assembled.json" --side=code
```

## Differences vs Understand-Anything

| Aspect | UA | This lite version |
|--------|-----|-------------------|
| AST parsing | tree-sitter (WASM) | language-specific regex + brace-matching |
| Import resolution | `@understand-anything/core` resolvers | inline regex + path-existence probes |
| Batching | Louvain community detection | top-level directory grouping + size cap |
| Dependencies | `@understand-anything/core`, `web-tree-sitter`, `graphology` | none |
| Coverage | ~95% (10 languages tree-sitter + heuristic for the rest) | ~80% (regex covers canonical declaration forms across 12 languages) |
| Edge cases handled | multi-line imports, conditional `require()`, dynamic dispatch | best-effort with logged warnings |

When the result quality matters (e.g. a serious audit), install Understand-Anything and let the orchestrator detect + prefer it. These scripts are the always-available fallback.

## Failure modes

- **Regex misses a declaration form**: file shows up with empty `functions` / `classes`. The LLM's Phase C.2 will see this and may supplement by re-reading the source. Logged but not fatal.
- **Import resolution returns null**: that import becomes external (dropped from `importMap`). Reduces edge density, doesn't break the graph.
- **Brace-matching fails on weird formatting**: function endLine = startLine. Significance filter (≥10 lines) drops the node. No false data.
- **`git ls-files` unavailable**: falls back to recursive `readdirSync` walk. Slower on large repos but correct.

In all cases scripts emit `Warning: <script-name>: <path> — <reason>` to stderr; the agent collects these into the coverage report.

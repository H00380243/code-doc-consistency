# Bundled Scripts — graph-diff-analyzer

Two zero-dependency Node.js scripts that handle the deterministic prelude to multi-layer diff analysis. Both are pure stdlib — no Python, no npm install required.

## Scripts

| Script | Owner agent | Purpose |
|--------|-------------|---------|
| `validate-graph.mjs` | `graph-reviewer` | Schema validation + referential integrity + quality heuristics + cross-graph ID-style prediction. One invocation can audit both graphs and predict checker pitfalls. |
| `align-graphs.mjs` | `consistency-checker` | Three-tier node alignment (exact ID / same kind+name / user aliases). Outputs `matched` / `code_only` / `doc_only` / `ambiguous` for the LLM to pick up at Layer 1. |

## Invocation

```bash
WS="$PROJECT_ROOT/_workspace"
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/graph-diff-analyzer/scripts"

# graph-reviewer: validate both graphs in one call
node $SKILL/validate-graph.mjs \
  ignored \
  "$WS/02_5_review_report.json" \
  --code="$WS/01_code_graph.json" \
  --doc="$WS/02_doc_graph.json"

# consistency-checker: pre-compute Layer 1 alignment
node $SKILL/align-graphs.mjs \
  "$WS/01_code_graph.json" \
  "$WS/02_doc_graph.json" \
  "$WS/03_alignment.json" \
  --aliases="$WS/aliases.json"   # optional
```

## Output schemas

### `validate-graph.mjs`

```jsonc
{
  "schema_version": "1.0",
  "code_graph": { "side": "code", "decision": "pass|pass_with_warnings|reject", "schema_errors": [...], "dangling_edges": [...], "duplicate_nodes": [...], "duplicate_edges": [...], "quality_issues": [...] },
  "doc_graph":  { /* same shape */ },
  "cross_graph_warnings": [
    { "type": "id_case_mismatch",      "count": N, "examples": [{"code":"...","doc":"..."}], "hint": "..." },
    { "type": "id_separator_mismatch", "code_styles": [...], "doc_styles": [...],            "hint": "..." }
  ],
  "decision": "pass|pass_with_warnings|reject",
  "summary": "..."
}
```

### `align-graphs.mjs`

```jsonc
{
  "schema_version": "1.0",
  "matched":   [{"code_id": "...", "doc_id": "...", "tier": 1|2|3, "confidence": "high|medium|low"}],
  "code_only": ["function:...", ...],
  "doc_only":  ["endpoint:...", ...],
  "ambiguous": [{"name": "...", "kind": "class", "candidates_code": [...], "candidates_doc": [...]}],
  "stats":     { /* counts per tier + totals */ }
}
```

## Alias file format

Optional input to `align-graphs.mjs`. Map a code-side ID to one or more doc-side IDs:

```jsonc
{
  "class:src/models/user.ts:User":           "schema:User",
  "function:src/auth/login.ts:handler":      ["endpoint:POST:/api/login"],
  "class:src/db/users.py:User":              ["module:UserRepo"]
}
```

Aliases run as Tier 3 — applied AFTER exact-ID matches (Tier 1) but BEFORE same-name matches (Tier 2). Use them when:
- Code uses path-prefixed IDs and docs use bare names (`function:src/auth/login.py:handler` ↔ `endpoint:POST:/api/login`)
- An entity changed name across the boundary (`User` class is described as `UserRepo` in the design doc)
- Two entities have identical normalized names but represent different concepts (use aliases to force the right pairing)

## Failure modes

- **`validate-graph.mjs` finds > tolerance schema errors** → `decision: "reject"`. The orchestrator should re-run the corresponding builder once before proceeding.
- **`align-graphs.mjs` returns `ambiguous_count > 0`** → multiple candidates on either side. The LLM (consistency-checker) sees these as `ambiguous` entries; do not auto-pick a winner — surface them as alignment warnings in the final report and prompt the user to provide aliases.
- **0% Tier-1 matches + > 50% `code_only` / `doc_only`** → likely an ID convention mismatch the user must resolve via aliases. The cross-graph warnings from `validate-graph.mjs` should have caught this earlier.

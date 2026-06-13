# Bundled Scripts — doc-graph-rag

Self-contained scripts for the design-document side of the consistency harness. Mirrors `code-graph-rag/scripts/` in spirit: deterministic extraction that the LLM can rely on rather than re-derive.

## Scripts

| Script | Phase | Purpose |
|--------|-------|---------|
| `discover-docs.mjs` | A. DISCOVER | Walk project, classify doc files by docType (markdown/openapi/proto/mermaid/plantuml/graphql/jsonschema) |
| `extract-doc-structure.mjs` | B. STRUCTURED | Parse OpenAPI/Proto/GraphQL/Mermaid/PlantUML/JSON Schema (and embedded mermaid in markdown) into KnowledgeGraph nodes + edges |
| `merge-batch-graphs.mjs` (shared) | D. MERGE | Use `code-graph-rag/scripts/merge-batch-graphs.mjs --side=design` |

All pure Node.js (no Python, no npm install). Tested on Node ≥ 18.

## Invocation order

```bash
WS="$PROJECT_ROOT/_workspace"
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/doc-graph-rag/scripts"

# A. DISCOVER
node $SKILL/discover-docs.mjs "$PROJECT_ROOT" "$WS/02_doc_inventory.json"

# B. STRUCTURED — build input via Node so paths are correct on Windows
node -e "
const fs=require('fs');
const inv=JSON.parse(fs.readFileSync('$WS/02_doc_inventory.json','utf8'));
fs.writeFileSync('$WS/02_doc_extract_in.json', JSON.stringify({projectRoot:'$PROJECT_ROOT', documents:inv.documents}));
"
node $SKILL/extract-doc-structure.mjs "$WS/02_doc_extract_in.json" "$WS/02_doc_structured.json"

# C. FREETEXT — LLM-only; outputs $WS/02_doc_freetext_<doc>.json

# D. MERGE — same Node script as code side
node ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/merge-batch-graphs.mjs \
  "$WS/doc-batches" "$WS/02_doc_assembled.json" --side=design
```

## What `extract-doc-structure.mjs` covers

| docType | Supported nodes | Supported edges |
|---------|-----------------|-----------------|
| `openapi` | `endpoint`, `schema` | `defines_schema` (endpoint → schema) |
| `proto` | `service`, `function` (rpc), `schema` (message/enum) | `contains` (service → rpc), `defines_schema` (rpc → message) |
| `graphql` | `schema` (type/input/interface/enum), `endpoint` (Query/Mutation field) | `contains` (Query → endpoint) |
| `plantuml` | `class` | `inherits`, `contains`, `depends_on` |
| `mermaid` (classDiagram) | `class` | `inherits`, `depends_on` |
| `mermaid` (sequenceDiagram) | `module` (participants) | `calls` (messages, time-ordered) |
| `mermaid` (flowchart) | `concept` | `depends_on` |
| `jsonschema` | `schema` (root + $defs) | `contains` |
| `markdown` (embedded mermaid) | per the diagram type above | per the diagram type above |

Free-text markdown extraction is **not** in here — it's the LLM's Phase C job, where authorial intent and tone need judgment.

## Differences from Understand-Anything

UA doesn't have a parallel doc-graph pipeline; this is original to this harness. The schema is shared with the code side (same node types, same edge types, same ID conventions) so `consistency-checker` can align them.

## Failure modes

- **Non-canonical OpenAPI YAML formatting**: line-based parser misses paths. Coverage report logs which schemas/endpoints made it; the LLM's free-text pass may pick up the rest from descriptions.
- **PlantUML with skin params / themes**: the lookahead skips lines that don't match `class:` / `<|--` / `*--` / `-->`. Decorative syntax is harmlessly ignored.
- **Mermaid sequence with notes/loops**: notes and loop control don't generate nodes/edges; only `participant` and message arrows do.
- **JSON Schema with external `$ref`**: external refs are not resolved; only inline `definitions`/`$defs` produce nodes.

stderr warnings flow through to the doc-graph coverage report just like the code side.

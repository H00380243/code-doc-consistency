# Code-Doc Consistency

Detect inconsistencies between source code and design documents using parallel directed-graph RAG.

A Claude Code plugin that builds two graphs — one from your code (AST + import resolution), one from your design docs (OpenAPI + Mermaid + PlantUML + free-text Markdown) — then runs a four-layer diff analysis to find drift: missing implementations, undocumented APIs, signature mismatches, broken flow contracts.

## What it does

```
[Orchestrator]
    ├── code-graph-builder   ─┐
    │   (parallel subagent)   │
    │                          ├──→ [graph-reviewer] ──→ [consistency-checker] ──→ report
    └── doc-graph-builder    ─┘
        (parallel subagent)
```

- **`/cdc`** — single command, runs the whole pipeline
- **5-stage deterministic pipeline per side** — SCAN → BATCH → ANALYZE → MERGE → REVIEW. Inspired by [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything).
- **Confidence-aware** — design docs that say "should" / "may" / "future" become low-confidence nodes that get severity-downgraded in the diff
- **Self-contained** — zero npm dependencies, zero Python; pure Node.js ≥ 18 stdlib

## Installation

### Option 1 — Local plugin (development)

```bash
# Clone the repo somewhere Claude Code can read
git clone https://github.com/TBD/code-doc-consistency.git ~/code-doc-consistency

# Inside Claude Code, register as a local marketplace
/plugin marketplace add ~/code-doc-consistency

# Install
/plugin install code-doc-consistency
```

### Option 2 — From a Git remote (once published)

```bash
/plugin marketplace add https://github.com/TBD/code-doc-consistency
/plugin install code-doc-consistency
```

## Quick start

In any project's directory, just run:

```
/cdc
```

The plugin auto-discovers your code (current directory) and docs (`docs/`, `design/`, `specs/`, root `README.md`/`ARCHITECTURE.md`/`DESIGN.md`), then writes `consistency_report.md`.

For repeatable team usage, drop a `code-doc-consistency.json` at the project root:

```json
{
  "code": { "root": "src" },
  "docs": { "roots": ["docs/", "README.md"] },
  "output": { "path": "consistency_report.md" },
  "aliases": "code-doc-aliases.json"
}
```

See [`examples/`](./examples) for full configurations.

## How it decides what to compare

The orchestrator resolves the code path and doc paths via this priority chain:

1. **Explicit arguments** — `/cdc src/auth --docs=docs/api.yaml`
2. **Config file** — `code-doc-consistency.json` at project root (or `--config=<path>`)
3. **Auto-discovery** — `docs/`, `design/`, `specs/`, `doc/`, `documentation/`; falls back to root-level `README.md`, `ARCHITECTURE.md`, `DESIGN.md`
4. **Asking the user** — only when all the above produced nothing

A bundled `resolve-inputs.mjs` does this deterministically and validates every path before any subagent runs.

## What gets reported

The final `consistency_report.md` is structured by severity (critical / major / minor) across four layers:

| Layer | Detects |
|-------|---------|
| **Entity** | Code has it but docs don't (and vice versa) |
| **Relation** | Edge missing/extra (calls, inherits, routes_to, defines_schema) |
| **Attribute** | Same entity, different signature/fields (param order, return type, schema shape) |
| **Behavior** | Flow described in docs doesn't match the actual call chain |

Each finding includes:
- Source location (file + line for code; file + section for docs)
- Severity rationale (with confidence/tentative downgrades applied)
- Two suggested fixes: "update the docs" or "update the code"

## Component overview

| Component | Type | Role |
|-----------|------|------|
| `/cdc` | command | Single entry point users type |
| `code-doc-consistency-orchestrator` | skill | Coordinates the four subagents |
| `code-graph-builder` | agent | Source → directed graph |
| `doc-graph-builder` | agent | Docs → directed graph (same schema) |
| `graph-reviewer` | agent | Schema/integrity QA before diff |
| `consistency-checker` | agent | Four-layer diff analysis |
| `code-graph-rag` | skill | Bundled scripts: SCAN/BATCH/ANALYZE/MERGE for code |
| `doc-graph-rag` | skill | Bundled scripts: DISCOVER/STRUCTURED extraction for docs |
| `graph-diff-analyzer` | skill | Bundled scripts: validation + alignment |

Architecture details: see [`code-doc-consistency-plugin/skills/code-doc-consistency-orchestrator/SKILL.md`](./code-doc-consistency-plugin/skills/code-doc-consistency-orchestrator/SKILL.md).

## Supported sources

**Code (12 languages, regex + brace-matching):**
TypeScript, JavaScript, Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, C, C++

**Docs (deterministic parsers):**
OpenAPI/Swagger, Protocol Buffers, GraphQL Schema, JSON Schema, Mermaid (class/sequence/flowchart), PlantUML; free-text Markdown via LLM extraction.

## Requirements

- Claude Code (any recent version supporting `.claude-plugin/`)
- Node.js ≥ 18 (the bundled scripts use ESM + stdlib only)

## License

MIT

---
description: Detect inconsistencies between source code and design documents
argument-hint: "[code-path] [--docs=<path>] [--config=<path>] [--focus=<pattern>] [--aliases=<path>] [--model-tier=economy|standard|premium] [--full|--review|--checker-only]"
---

# /cdc — Code-Doc Consistency Check

Run the full code-vs-design-document consistency pipeline on the current project.

## Behavior

This command invokes the `code-doc-consistency-orchestrator` skill, which:

1. Resolves what to compare (code path + doc paths) via `resolve-inputs.mjs`
2. Builds two directed graphs in parallel (`code-graph-builder` + `doc-graph-builder` subagents)
3. Validates both graphs (`graph-reviewer` subagent)
4. Runs four-layer diff analysis (`consistency-checker` subagent)
5. Writes the final report

## Arguments

`$ARGUMENTS` may contain any combination of:

| Argument | Meaning |
|----------|---------|
| (positional path) | Code root to analyze. Default: current working directory. |
| `--docs=<path1>,<path2>` | Doc paths (comma-separated). Default: auto-discover `docs/`, `design/`, `specs/`, root README/ARCHITECTURE/DESIGN. |
| `--config=<path>` | Use this config file instead of looking for `code-doc-consistency.json` at project root. |
| `--focus=<pattern>` | Limit diff to these node/edge types (e.g. `endpoint,routes_to,defines_schema` for API-only). |
| `--aliases=<path>` | Path to alias map JSON for cross-graph node alignment. |
| `--scope=<sub-path>` | Further sub-path filter applied within the code root. |
| `--model-tier=<tier>` | Override model selection for all agents. Options: `economy` (all Sonnet), `standard` (default), `premium` (all Opus). Also supports per-role: `--model-tier=code-batch-analyzer=economy,consistency-checker=standard`. |
| `--full` | Force full rebuild, ignoring existing `_workspace/`. |
| `--review` | Re-run only `graph-reviewer` and `consistency-checker` against existing graphs. |
| `--checker-only` | Re-run only `consistency-checker`; preserves both graphs and the review. Useful with new `--focus` or `--aliases`. |

## Resolution priority

The orchestrator resolves inputs via this chain (first match wins):

1. Explicit arguments to this command
2. `code-doc-consistency.json` at project root
3. Auto-discovery (docs/, design/, specs/, doc/ + root README.md, ARCHITECTURE.md, DESIGN.md)
4. Asking the user (only if all the above produced nothing)

## Examples

```
/cdc
/cdc src/auth --docs=docs/api/openapi.yaml
/cdc --config=audit-config.json --focus=endpoint,defines_schema
/cdc --checker-only --aliases=my-aliases.json
/cdc --full
```

## What gets written

- `_workspace/00_input/inputs.json` — resolved configuration
- `_workspace/01_code_graph.json` — code-side directed graph
- `_workspace/02_doc_graph.json` — doc-side directed graph
- `_workspace/02_5_review_report.{json,md}` — graph QA report
- `_workspace/03_diff_report.{json,md}` — multi-layer diff
- `consistency_report.md` (or path from config) — final integrated report

`_workspace/` is preserved between runs to support partial re-runs and incremental updates.

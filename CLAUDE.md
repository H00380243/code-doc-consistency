# Code-Doc Consistency Plugin — Developer Notes

This file is loaded into Claude Code when working **on the plugin itself** (not when consumers use it). For end-user docs see [README.md](README.md).

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json              # Marketplace entry pointing at the plugin sub-dir
├── code-doc-consistency-plugin/      # The actual plugin
│   ├── .claude-plugin/plugin.json    # Plugin metadata (version, author, etc.)
│   ├── agents/                       # 6 subagent definitions (2 coordinators + 2 workers + reviewer + checker)
│   ├── skills/                       # 4 skills (1 orchestrator + 3 building blocks)
│   └── commands/cdc.md               # /cdc slash command
├── examples/                         # Drop-in configs users can copy to their projects
├── README.md                         # User-facing
├── LICENSE
└── CLAUDE.md                         # This file
```

## Path conventions inside plugin assets

- **Bundled scripts** are referenced as `${CLAUDE_PLUGIN_ROOT}/skills/<skill>/scripts/<script>.mjs`. Claude Code injects `CLAUDE_PLUGIN_ROOT` at runtime; never hard-code `.claude/skills/` paths.
- **User project paths** in agent prompts use `$PROJECT_ROOT` (the consumer's project, not the plugin), and `$WORKSPACE = $PROJECT_ROOT/_workspace`.

## Architecture summary

```
[/cdc command]
   ↓
[code-doc-consistency-orchestrator skill]
   ↓
   ├── [code-graph-builder coordinator]      ─┐ Phase 2a 并行（确定性）
   │     └── SCAN / BATCH / extract-structure │
   ├── [doc-graph-builder  coordinator]      ─┘ DISCOVER / STRUCTURED
   ↓
   ├── [code-batch-analyzer × N]   ─┐ Phase 2b fan-out（LLM 并行 N+M 个）
   ├── [doc-freetext-analyzer × M] ─┘
   ↓
   ├── [code-graph-builder coordinator]      ─┐ Phase 2c 并行（确定性）
   ├── [doc-graph-builder  coordinator]      ─┘ MERGE / REVIEW
   ↓
   ├── [graph-reviewer agent]      schema/integrity QA
   ↓
   └── [consistency-checker agent]  4-layer diff
```

确定性脚本（SCAN / BATCH / extract-structure / discover-docs / extract-doc-structure / MERGE / validate）由 coordinator 直接执行；LLM 语义合成（per-batch summary/tags/edges、per-markdown 实体抽取）拆给 N+M 个 worker subagent 并行处理，wall-clock 受限于最慢的单批/单文档 + 调度并发上限（≈ 16）。

| Component | Type | Role |
|-----------|------|------|
| `code-graph-builder` | coordinator agent | 跑代码侧确定性阶段 + 合并；不做 ANALYZE |
| `code-batch-analyzer` | worker agent | 单 batch 的 LLM 语义合成 |
| `doc-graph-builder` | coordinator agent | 跑文档侧确定性阶段 + 合并；不做 FREETEXT |
| `doc-freetext-analyzer` | worker agent | 单 markdown 的 LLM 抽取 |
| `graph-reviewer` | agent | schema / 引用 / 跨图 ID QA |
| `consistency-checker` | agent | 四层 diff |

## Versioning

Bump `code-doc-consistency-plugin/.claude-plugin/plugin.json` `version` field on every release. Also update the entry in `examples/` if a config schema changes.

## Testing

Smoke test: build a tiny fixture project (a few `.py` files + an OpenAPI YAML), run each script in pipeline order, verify the merged graph + alignment + diff report. The aliases mechanism is the cross-graph integration test — without aliases, schema names with different prefixes show up as `code_only` / `doc_only`; with aliases, they match as Tier 3.

## Hístory

| Date | Change |
|------|--------|
| 2026-06-12 | Initial plugin construction (4 agents + 4 skills + scripts) |
| 2026-06-12 | Borrowed Understand-Anything pipeline shape (SCAN→BATCH→ANALYZE→MERGE→REVIEW) |
| 2026-06-12 | Ported deterministic scripts as zero-dep Node lite versions |
| 2026-06-12 | Added input resolution mechanism (resolve-inputs.mjs + config schema + priority chain) |
| 2026-06-12 | Repackaged as standard Claude Code plugin (marketplace + sub-plugin layout, /cdc command, examples/) |
| 2026-06-14 | **v0.2** — Split each builder into coordinator + worker fan-out: `code-batch-analyzer` and `doc-freetext-analyzer` workers run in parallel (N+M subagents) so ANALYZE/FREETEXT wall-clock drops from serial-per-batch to single-batch + scheduling. Builders become coordinators that only run deterministic phases and merge results. |

# Code-Doc Consistency Plugin — Developer Notes

This file is loaded into Claude Code when working **on the plugin itself** (not when consumers use it). For end-user docs see [README.md](README.md).

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json              # Marketplace entry pointing at the plugin sub-dir
├── code-doc-consistency-plugin/      # The actual plugin
│   ├── .claude-plugin/plugin.json    # Plugin metadata (version, author, etc.)
│   ├── agents/                       # 4 subagent definitions
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
   ├── [code-graph-builder agent]   ─┐ parallel subagents
   ├── [doc-graph-builder agent]    ─┘
   ↓
   ├── [graph-reviewer agent]      schema/integrity QA
   ↓
   └── [consistency-checker agent]  4-layer diff
```

Each builder runs a 5-stage deterministic pipeline (SCAN → BATCH → ANALYZE → MERGE → REVIEW) where bundled `.mjs` scripts handle every formalizable step and the LLM only adds semantic judgments.

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

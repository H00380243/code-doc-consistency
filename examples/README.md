# Examples

Drop-in configurations for common project types. Copy the relevant `code-doc-consistency.json` into your project root and run `/cdc`.

## Files

| File | Project type | Notes |
|------|--------------|-------|
| `python-fastapi.json` | Python service with FastAPI + OpenAPI | Common API drift case |
| `node-typescript.json` | Node/TypeScript backend with embedded JSDoc + Markdown architecture docs | |
| `monorepo-microservices.json` | Multi-package repo with per-service docs | Uses `--scope` to focus one service at a time |
| `aliases.example.json` | Sample alias map for renamed entities |
| `api-only-focus.json` | Only check API contracts, ignore internal helpers | Useful when most code is intentionally undocumented |

## Usage

```bash
# Inside your project root:
cp ~/code-doc-consistency/examples/python-fastapi.json ./code-doc-consistency.json
# Then in Claude Code:
/cdc
```

To use a non-default config name:

```
/cdc --config=audit-config.json
```

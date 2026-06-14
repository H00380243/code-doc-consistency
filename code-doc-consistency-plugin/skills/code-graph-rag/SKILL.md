---
name: code-graph-rag
description: "从源代码构建有向图 RAG。两阶段流程：①确定性结构抽取（tree-sitter / 专用 parser，通过 Understand-Anything 风格的 bundled 脚本完成文件枚举、AST 解析、import 解析） ②LLM 语义合成 summary/tags/complexity 与 semantic edges（calls/related）。借鉴 SCAN→BATCH→ANALYZE→MERGE→REVIEW 五阶段流水线，输出统一 schema 的代码图谱。代码静态分析、AST 抽取、符号关系建图、代码侧 ground truth 构建任务时使用。"
---

# Code Graph RAG — 代码侧有向图构建技能（增强版）

将源代码库转化为可机器对比的有向图 JSON。本技能借鉴 [Understand-Anything](https://github.com/) 的成熟架构：**确定性脚本承担所有可形式化的工作；LLM 只做语义合成**。

## 何时使用

- 需要把代码"客观事实"提取为结构化数据
- 后续要与设计文档/规范/合同做对比
- 需要稳定可复现的代码图谱（同样代码 → 同样图）

## 核心架构: 五阶段流水线 + ANALYZE fan-out

```
[SCAN]   →   [BATCH]   →   [ANALYZE × N]   →   [MERGE]   →   [REVIEW]
 文件枚举      语义化分批     per-batch fan-out    归一去重     schema 校验
 import map   neighborMap   每 batch 一个 worker  dangling     悬挂边
                                                  drop
 ────确定性────  ────确定性────  ──worker LLM──    ────确定性────
                              （并行 N 个 subagent）
```

**架构变更（v0.2）**: ANALYZE 不再由单个 builder agent 内部串行处理 N 个 batch，而是由 orchestrator 在 fan-out 阶段拉起 N 个独立的 `code-batch-analyzer` worker 并行做 LLM 语义合成。本技能（`/code-graph-rag`）描述各阶段**逻辑**；具体调度由 `code-doc-consistency-orchestrator` 完成。

每阶段的产物文件：
- SCAN → `_workspace/01_code_scan.json`（文件清单 + importMap）
- BATCH → `_workspace/01_code_batches.json`（batches[] + neighborMap）
- ANALYZE-prep（确定性）→ `_workspace/01_code_extract_<i>.json`（per batch，functions/classes/exports/callGraph）
- ANALYZE-llm（fan-out worker）→ `_workspace/01_code_batch_<i>.json`（per batch，含 summary/tags/edges）
- MERGE → `_workspace/01_code_assembled.json`（合并归一后图）
- REVIEW → `_workspace/01_code_graph.json`（最终图）+ `_workspace/01_code_graph_coverage.md`

---

## 图谱 Schema（与 `/doc-graph-rag` 共享）

详见 `references/graph-schema.md`（**必读**）。要点：

- 16 种节点类型 + 29 种边类型
- 统一 ID 命名规范（前缀 + 相对路径 + 名称）
- 扩展字段：`confidence`、`abstraction_level`、`tentative`、`unresolved` — 用于代码-文档对比

代码侧节点默认 `abstraction_level: "concrete"`，`confidence: "high"`（除非动态/反射/跨文件无法静态确定，则降为 `"low"` + `unresolved: true`）。

---

## Phase A: SCAN — 项目级扫描（确定性）

### A.1 工具与脚本

本技能在 `scripts/` 下提供完整的自包含脚本（零依赖、纯 Node.js 实现），见 `scripts/README.md`。**直接调用，不要让 LLM 重写**：

| 阶段 | 脚本 | 入参 / 出参 |
|------|------|-----------|
| A. SCAN（枚举） | `scan-project.mjs <root> <out.json>` | 输出 files[] + 语言/分类/行计数 |
| A. SCAN（imports） | `extract-import-map.mjs <in.json> <out.json>` | 输入 {projectRoot, files[]}，输出 importMap |
| B. BATCH | `compute-batches.mjs <scan.json> <imports.json> <out.json>` | 输出 batches[] + neighborMap |
| C. ANALYZE（结构） | `extract-structure.mjs <in.json> <out.json>` | 输入 {projectRoot, batchFiles[]}，输出 functions/classes/exports |
| D. MERGE | `merge-batch-graphs.mjs <batch-dir> <out.json> --side=code` | 节点/边去重、ID 归一、悬挂边删除 |

**Understand-Anything 优先**: 若主机已装 UA 插件且 tree-sitter WASM 可用，优先用 UA 的脚本（更高 AST 精度）。否则用本技能的脚本——零依赖，跨 Windows/macOS/Linux 即装即跑。

### A.2 文件枚举

- 优先 `git ls-files`（保留 git 跟踪的真相）
- 否则递归 Glob，应用 `.understandignore`/`.gitignore` 默认排除规则
- 默认跳过：`node_modules/`、`vendor/`、`.venv/`、`venv/`、`target/`、`dist/`、`build/`、`out/`、`__pycache__/`、`.next/`、`coverage/`、`*.lock`、`*.min.{js,css}`、`*.map`

### A.3 语言识别 + fileCategory

每文件赋予两个属性：

**language**（按扩展名 + 文件名规则）

**fileCategory**（七选一）：
- `code` — `.ts`/`.js`/`.py`/`.go`/`.rs`/`.java`/`.kt`/`.rb`/`.php`/`.cs`/`.cpp`/`.c` 等代码文件（默认）
- `config` — `.json`/`.yaml`/`.toml`/`.xml`/`.cfg`/`.ini`/`.env`/`.properties` 等
- `docs` — `.md`/`.mdx`/`.rst`/`.txt`
- `infra` — `Dockerfile`、`docker-compose.*`、`.github/workflows/*`、`Jenkinsfile`、`*.tf`、k8s manifest
- `data` — `.sql`/`.graphql`/`.proto`/`.prisma`/`.csv`
- `script` — `.sh`/`.bash`/`.ps1`/`.bat`/`.cmd`
- `markup` — `.html`/`.css`/`.scss`

**优先级规则**: 文件名/路径规则 > 扩展名规则。例：`.github/workflows/ci.yml` 是 `infra`（**不是** `config`）；`docker-compose.yml` 是 `infra`；`LICENSE` 是 `code`（不是 docs）。

### A.4 import map（跨文件依赖解析）

对每个 `code` 文件提取 import 并解析为相对路径（项目内）：

| 语言 | import 解析规则 |
|------|----------------|
| TS/JS | `import x from "./y"` / `require("./y")` → 相对解析；`/`、`@/` 看 tsconfig paths |
| Python | `from .x import y` / `from a.b import c` → 解析包目录 + `__init__.py` |
| Go | `import "github.com/me/proj/internal/x"` → strip `go.mod` module 前缀 |
| Rust | `use crate::x` → `src/x.rs` 或 `src/x/mod.rs`；`mod x;` |
| Java/Kotlin | `import com.x.Y` → 按 package 目录解析 |
| Ruby | `require_relative "x"` / `require "x"` |
| PHP | composer.json 的 PSR-4 autoload 解析 |
| C/C++ | `#include "x.h"` → 相对 + `include/` 探测 |

外部包丢弃，**只**保留项目内可解析路径。每文件输出 `imports: string[]`（即使为空）。

### A.5 SCAN 输出

`_workspace/01_code_scan.json`:

```json
{
  "scriptCompleted": true,
  "project": { "name": "...", "languages": [...], "frameworks": [...], "description": "..." },
  "files": [
    { "path": "src/index.ts", "language": "typescript", "sizeLines": 150, "fileCategory": "code" },
    { "path": "README.md", "language": "markdown", "sizeLines": 45, "fileCategory": "docs" }
  ],
  "totalFiles": 42,
  "filteredByIgnore": 0,
  "estimatedComplexity": "moderate",
  "importMap": {
    "src/index.ts": ["src/utils.ts", "src/config.ts"],
    "src/utils.ts": []
  },
  "stats": {
    "byCategory": { "code": 28, "config": 6, "docs": 4 },
    "byLanguage": { "typescript": 22, "javascript": 6 }
  }
}
```

---

## Phase B: BATCH — 语义化分批（确定性）

避免一次让 LLM 处理整个项目。分批原则：

1. **粒度** — 每 batch 5–15 文件（小项目可能只 1 batch）
2. **语义聚合** — 优先按目录分批（同目录文件强相关）
3. **跨 batch import 解决** — 为每 batch 计算 `neighborMap`：列出 batch 内文件的所有"邻居"（导入方/被导入方），含其导出符号

### neighborMap 是关键创新

让 LLM 在 ANALYZE 阶段能可信地发出跨 batch 边（如 `calls` 到其他 batch 的函数）。

```json
{
  "batchIndex": 3,
  "batchFiles": [...],
  "batchImportData": {
    "src/auth/login.ts": ["src/auth/jwt.ts", "src/db/users.ts"]
  },
  "neighborMap": {
    "src/auth/login.ts": [
      { "path": "src/auth/jwt.ts", "batchIndex": 5, "symbols": ["signJWT", "verifyJWT"] },
      { "path": "src/db/users.ts", "batchIndex": 7, "symbols": ["findByEmail", "User"] }
    ]
  }
}
```

ANALYZE 阶段 LLM 在 `src/auth/login.ts` 中看到 `signJWT(...)` 调用，并在 neighborMap 中找到匹配，就发出：
```json
{ "source": "function:src/auth/login.ts:handler", "target": "function:src/auth/jwt.ts:signJWT", "type": "calls", "weight": 0.8, "confidence": "high" }
```

### BATCH 输出

`_workspace/01_code_batches.json`:

```json
{
  "totalBatches": 6,
  "batches": [
    {
      "batchIndex": 0,
      "batchFiles": [...],
      "batchImportData": {...},
      "neighborMap": {...}
    }
  ]
}
```

---

## Phase C: ANALYZE — 结构抽取 + LLM 语义合成

**执行者拆分（v0.2）**：
- **ANALYZE-prep（C.1，确定性）** 由 `code-graph-builder` coordinator 在 Phase 2a 完成：对每个 batch 调一次 `extract-structure.mjs`，写出 `01_code_extract_<i>.json`
- **ANALYZE-llm（C.2 之后，LLM）** 由 orchestrator 在 Phase 2b fan-out N 个 `code-batch-analyzer` worker 并行完成：每个 worker 读 `01_code_extract_<i>.json`（自己那一批）+ `neighborMap` 中跨 batch 的导出符号，写出 `01_code_batch_<i>.json`

每个 worker 的输入/输出契约见 `code-batch-analyzer` agent 定义。下面的 C.1–C.5 是**逻辑**层面的说明，不是单一 agent 顺序流程。

### C.1 结构抽取（确定性、per file）

对 batch 内每文件，按 fileCategory + language 选择 parser：

| fileCategory | 抽取内容 | 节点 type |
|--------------|---------|-----------|
| `code` | functions, classes, exports, callGraph | `file` + `function` + `class` |
| `config` | config 顶层键 | `config` |
| `docs` | sections（h1/h2/h3） | `document` |
| `infra` (Dockerfile / compose) | services（stages 或 compose services） | `service` |
| `infra` (CI/CD) | steps/jobs | `pipeline` + `step` |
| `infra` (Terraform) | resources | `resource` |
| `data` (sql) | tables (CREATE TABLE) | `table` |
| `data` (graphql/proto) | definitions（type/message） | `schema` |
| `data` (openapi) | endpoints + schemas | `endpoint` + `schema` |

**Tree-sitter 是首选** — 能用就用。语言不支持时回退到 Read + 关键字识别（不写一次性正则脚本）。

### C.2 LLM 语义合成（per node）

**输入**: 结构抽取结果 + 文件内容（首 ~300 行 + relevant chunks）+ neighborMap
**输出**: 每节点 `summary`/`tags`/`complexity`/`languageNotes`

#### Summary 写作要求

- 1–2 句话
- 描述**作用与角色**，不是文件名复述
- 坏例: `"The utils file contains utility functions."`
- 好例: `"Provides date formatting and string sanitization helpers used across the API layer."`

#### 各 fileCategory 的 summary 风格

- **code**: 描述目的与角色（"Provides date formatting helpers used across the API layer."）
- **config**: 描述配置范围（"TypeScript compiler configuration enabling strict mode with path aliases."）
- **docs**: 描述内容范围（"Comprehensive getting-started guide with 5 sections covering installation, configuration, and first API call."）
- **infra**: 描述部署/构建产物（"Multi-stage Docker build producing a minimal Node.js production image."）
- **data**: 描述 schema 结构（"Core user and orders tables with foreign key relationships."）
- **pipeline**: 描述 CI/CD 工作流（"GitHub Actions workflow running tests, building Docker image, and deploying on merge to main."）

#### Tags（3–5 个，小写连字符）

代码 tags: `entry-point`, `utility`, `api-handler`, `data-model`, `test`, `middleware`, `component`, `hook`, `service`, `type-definition`, `barrel`, `factory`, `singleton`, `event-handler`, `validation`, `serialization`

非代码 tags: `documentation`, `configuration`, `infrastructure`, `database`, `api-schema`, `ci-cd`, `deployment`, `migration`, `monitoring`, `security`, `containerization`, `orchestration`, `schema-definition`, `data-pipeline`, `build-system`

### C.3 显著性过滤（避免节点爆炸）

只为以下创建 `function:`/`class:` 节点：
- 函数 ≥ 10 行（跳过琐碎单行）
- 类 ≥ 2 方法或 ≥ 20 行
- 任何**导出**的函数/类（即使小）

跳过：trivial 单行、type aliases、简单 re-exports、自动生成的 boilerplate。

### C.4 边发出规则

#### 代码文件边

| Edge type | 何时发出 | weight | direction |
|-----------|----------|--------|-----------|
| `contains` | file 包含 function/class 节点 | 1.0 | forward |
| `imports` | 1:1 emission — 对 `batchImportData[path]` 中**每条**发出一个 imports 边 | 0.7 | forward |
| `calls` | 函数调用其他文件的函数（依据 neighborMap 匹配） | 0.8 | forward |
| `inherits` | 类继承项目内类 | 0.9 | forward |
| `implements` | 类实现项目内接口 | 0.9 | forward |
| `exports` | 文件导出 function/class 节点（与 `contains` 并存，不替代） | 0.8 | forward |
| `tested_by` | 生产文件被测试文件引用 | 0.5 | production → test |

**imports 边必须 1:1**：`batchImportData[file].length` = 该文件发出的 imports 边数。不能少（即使你觉得"不重要"）。

#### 非代码文件边

| Edge type | 何时发出 | weight |
|-----------|----------|--------|
| `configures` | config → 它影响的代码文件 | 0.6 |
| `documents` | doc → 它描述的代码组件 | 0.5 |
| `deploys` | Dockerfile/k8s → 应用代码 | 0.7 |
| `migrates` | SQL migration → table 节点 | 0.7 |
| `triggers` | CI/CD → 部署目标 | 0.6 |
| `defines_schema` | schema 文件 → 实现 resolver 的代码 | 0.8 |
| `routes` | 路由配置 → service | 0.6 |
| `provisions` | Terraform → 创建的资源 | 0.7 |
| `serves` | k8s service/deployment → endpoint | 0.7 |

### C.5 ANALYZE 输出（per batch）

`_workspace/01_code_batch_<batchIndex>.json`:

```json
{
  "batchIndex": 0,
  "nodes": [...],
  "edges": [...]
}
```

---

## Phase D: MERGE — 合并归一（确定性）

合并所有 `01_code_batch_*.json` → `01_code_assembled.json`：

### D.1 节点合并
- 按 `id` 去重；同 ID 合并 `source` 数组、属性以高置信度覆盖
- 项目名前缀去除（`my-project:file:foo.ts` → `file:foo.ts`）
- 缺前缀的裸路径补前缀（`src/foo.ts` → `file:src/foo.ts`）

### D.2 边合并
- 按 `(source, target, type)` 去重
- 同 key 合并：weight 取 max，confidence 取 highest

### D.3 复杂度归一
| 输入 | 归一为 |
|------|--------|
| `low`, `easy`, `trivial` | `simple` |
| `medium` | `moderate` |
| `high`, `hard` | `complex` |

### D.4 悬挂边删除
- 任一端引用不存在的节点 → 丢弃
- 数量记入 coverage 报告

### D.5 `tested_by` 方向修正
- 必须 `production → test`；反向时翻转
- 双方都是 test 或都是 prod → 丢弃（语义错误）

---

## Phase E: REVIEW — schema 校验（确定性）

将 `01_code_assembled.json` → `01_code_graph.json`。

校验项（详见 `graph-reviewer` agent）：
- 每节点必需字段非空
- 每边 source/target 引用存在节点
- type 在合法枚举内
- weight 在 0-1
- ID 前缀匹配 type

校验失败 → 写 `01_code_graph_coverage.md` 的 `validation_errors`，但**不**阻塞输出。

---

## 工作原则

- **确定性优先** — 凡是脚本能做的（枚举/AST/import 解析/合并）都不让 LLM 做
- **绝不写一次性脚本** — 不要在 Bash 里写正则提取代码；用 Read + 启发式或调用 bundled parser
- **静态分析的局限要诚实暴露** — 动态行为标 unresolved + low confidence
- **单文件失败不终止** — 单文件 30s 超时；其他继续
- **稳定 ID** — 同代码位置在两次运行间 ID 不变
- **import 1:1 emission** — 每条 batchImportData 都发出 imports 边

## 反模式

- ❌ 注释里的"设想"被当作实际节点抽取
- ❌ `# TODO: implement validate()` 被生成 `function:validate` 节点
- ❌ 因某文件慢而放弃整个目录
- ❌ 给低置信度边标 `confidence: "high"` 让数字好看
- ❌ 让 LLM 写 `bash` 中的一次性正则脚本来提取 import
- ❌ 跳过 `neighborMap`，让 LLM "自己想明白"跨 batch 边

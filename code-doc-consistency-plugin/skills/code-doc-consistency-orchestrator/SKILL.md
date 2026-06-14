---
name: code-doc-consistency-orchestrator
description: "代码与设计文档一致性检测的 orchestrator。借鉴 Understand-Anything 的五阶段流水线（SCAN→BATCH→ANALYZE→MERGE→REVIEW），采用 coordinator + worker fan-out 架构：code-graph-builder / doc-graph-builder 两个 coordinator 并行起跑确定性阶段，分别拉起 N 个 code-batch-analyzer / doc-freetext-analyzer worker 并行做 LLM 语义合成，再由 coordinator 合并归一；graph-reviewer 做 schema 校验，consistency-checker 做四层次差异分析。一致性检测、设计漂移分析、文档同步审计、代码-文档对账、API 契约比对、'代码和文档对得上吗'、再次执行/重跑/更新一致性报告/部分重检/补充扫描/聚焦某模块、增量审计、refresh consistency report 等任务时必须使用本技能。"
---

# Code-Doc Consistency Orchestrator（增强版）

代码与设计文档一致性检测的整体流程协调器。本技能调度六个子代理：

- **`code-graph-builder`**（coordinator，并行）— 跑代码侧确定性阶段（SCAN/BATCH/extract-structure），输出 batches 清单
- **`code-batch-analyzer`**（worker，fan-out 并行 N 个）— 每 worker 处理一个 batch 的 LLM 语义合成
- **`doc-graph-builder`**（coordinator，并行）— 跑文档侧确定性阶段（DISCOVER/STRUCTURED），输出 markdown 清单
- **`doc-freetext-analyzer`**（worker，fan-out 并行 N 个）— 每 worker 处理一份 markdown 的 LLM 抽取
- **`graph-reviewer`**（顺序）— 对两图做 schema 校验 + 跨图 ID 风格预检
- **`consistency-checker`**（顺序）— 多层次比较两图并生成差异报告

## 实行模式: coordinator + worker fan-out

理由：用户明确要求"图谱生成不能太慢，需要开多个 subagent"。两图 coordinator 之间天然并行（独立 ground truth）；coordinator 内部把 LLM 语义合成阶段拆成 N 个独立 worker（每 batch / 每 markdown 一个），通过 `run_in_background: true` 同时跑，wall-clock 从 ~分钟级 batch 串行降到 ~并发的并行时间。

并发上限受 Claude Code 同时拉起 subagent 数量限制（通常 min(16, cores-2)）；超出会自然排队。这对绝大多数项目（< 16 batches、< 16 markdown 文档）足够。

## 代理构成

| 代理 | subagent_type | 阶段 | 角色 | 输出 |
|------|--------------|------|------|------|
| code-graph-builder | code-graph-builder | Phase 2a 并行（与 doc 侧） | 代码侧 coordinator：SCAN/BATCH/extract-structure | `01_code_batches.json` + `01_code_extract_<i>.json[]` + 报告 batchTaskInputs |
| code-batch-analyzer × N | code-batch-analyzer | Phase 2b fan-out 并行 | 单 batch LLM 语义合成 | `01_code_batch_<i>.json` |
| code-graph-builder | code-graph-builder | Phase 2c 顺序 | 代码侧 coordinator：MERGE/REVIEW | `01_code_graph.json` + coverage |
| doc-graph-builder | doc-graph-builder | Phase 2a 并行（与 code 侧） | 文档侧 coordinator：DISCOVER/STRUCTURED | `02_doc_inventory.json` + `02_doc_structured_*.json` + 报告 freetextTaskInputs |
| doc-freetext-analyzer × M | doc-freetext-analyzer | Phase 2b fan-out 并行 | 单 markdown LLM 抽取 | `02_doc_freetext_<slug>.json` |
| doc-graph-builder | doc-graph-builder | Phase 2c 顺序 | 文档侧 coordinator：MERGE/REVIEW | `02_doc_graph.json` + coverage |
| graph-reviewer | graph-reviewer | Phase 3 顺序 | schema/引用/质量 QA | `02_5_review_report.{json,md}` |
| consistency-checker | consistency-checker | Phase 4 顺序 | 四层差异分析 | `03_diff_report.{json,md}` |

所有 Agent 调用必须指定 `model: "opus"`。

## 工作流程

### Phase 0: 上下文确认（后续作业支持）

确认是否已存在产物：

1. 检查 `_workspace/` 目录
2. 决定执行模式：

| 状态 | 用户请求 | 执行模式 |
|------|---------|---------|
| `_workspace/` 不存在 | — | **初次执行**：进 Phase 1 |
| 存在 + "只重新分析代码" | — | **部分重执行**：仅跑代码侧 Phase 2a→2b→2c + reviewer + checker |
| 存在 + "只重新分析文档" | — | **部分重执行**：仅跑文档侧 Phase 2a→2b→2c + reviewer + checker |
| 存在 + "只更新差异分析" / "聚焦 API" | — | **仅 checker**：保留两图，给 checker 传 focus 参数 |
| 存在 + 新输入 / "完整重跑" | — | **新执行**：将现有 `_workspace/` 移到 `_workspace_<YYYYMMDD_HHMMSS>/` 后进 Phase 1 |
| 存在 + reviewer 之前 reject | — | **coordinator 重跑 Phase 2c**：重新 MERGE/REVIEW；如根因在 ANALYZE 则触发对应 worker 局部重跑 |
| 存在 + 仅个别 batch / markdown 失败 | "续跑"/"补齐缺失批次" | **worker 局部重跑**：只对缺失的 batch/markdown 拉起 worker，coordinator 重跑 Phase 2c 合并 |

部分重执行时把已有产物路径明确传给 subagent。

询问最少信息（仅初次执行）：
- 项目根目录路径（默认：当前工作目录）
- 设计文档目录（默认：自动发现 `docs/`/`design/`/`specs/`/根 README）
- 输出报告路径（默认：`./consistency_report.md`）
- 可选：聚焦范围（特定模块/特定文档），别名词表

### Phase 1: 准备 — 解析输入路径

> **插件路径变量**: 本 SKILL.md 与下游 agent prompts 中所有 `${CLAUDE_PLUGIN_ROOT}` 由 Claude Code 在插件运行时自动注入，指向插件安装目录。本地开发时若变量未设定，回退到 `~/.claude/plugins/code-doc-consistency/code-doc-consistency-plugin`。
> 工作区路径 `$WORKSPACE` 由 orchestrator 设为 `$PROJECT_ROOT/_workspace`，`$PROJECT_ROOT` 是用户当前项目根目录（非插件目录）。

输入路径（要对比的代码 vs 文档）按**优先级链**解析：

| 优先级 | 来源 | 何时用 |
|-------|------|--------|
| 1 | 用户当前消息中的明确指定（"代码在 `src/`，文档在 `docs/api/`"） | 用户说了就听 |
| 2 | `--code=` / `--docs=` / `--config=` CLI 风格参数（如果用户用 slash command 触发并带参数） | 自动化场景 |
| 3 | 项目根的 `code-doc-consistency.json` 配置文件 | 长期复用，团队共享 |
| 4 | 自动发现：代码 = 项目根；文档 = `docs/` / `design/` / `specs/` / `doc/`（如有），否则根 README.md/ARCHITECTURE.md/DESIGN.md | 首次执行无配置 |
| 5 | 询问用户 | 上面都没结果时（如根本没文档目录） |

**优先用脚本而非 LLM 判断**：

```bash
# 把所有信号交给脚本一次解析；脚本输出供后续 phase 使用
node ${CLAUDE_PLUGIN_ROOT}/skills/code-doc-consistency-orchestrator/scripts/resolve-inputs.mjs \
  "$PROJECT_ROOT" \
  "$WORKSPACE/00_input/inputs.json" \
  --code="<from user/config>"           # 可选
  --docs="<comma-separated, from user/config>"  # 可选
  --config="<from user>"                # 可选; 默认自动找 code-doc-consistency.json
  --focus="<from user>"                 # 可选
  --aliases="<from user/config>"        # 可选
  --scope="<from user>"                 # 可选
```

脚本做了什么：
- 按上面的优先级链合并所有来源
- 验证每个路径**真实存在**（不存在直接 fail，附明确错误信息）
- 自动发现 docs 时，统计每个候选目录下的文档文件数 — 0 个 → 报警
- 输出 `00_input/inputs.json`，含 `code.root` / `docs.roots[]` / `output.path` / `focus` / `aliases` / `warnings[]`

**配置文件 `code-doc-consistency.json`**（推荐，团队可 git 跟踪）：

```json
{
  "code": { "root": "src", "scope": null },
  "docs": { "roots": ["docs/", "README.md"] },
  "output": { "path": "consistency_report.md" },
  "focus": null,
  "aliases": "code-doc-aliases.json"
}
```

完整示例: `examples/python-fastapi.json` 等（在插件仓库根的 `examples/` 目录）

**自然语言到参数的对应**（在确认输入时参考）：

| 用户说 | 对应字段 |
|--------|---------|
| "检查这个项目代码和文档是否一致" | 全部默认（自动发现） |
| "代码在 `src/auth`，文档在 `docs/api/`" | `--code=src/auth --docs=docs/api/` |
| "对比 `src/` 和 `README.md` 与 `ARCHITECTURE.md`" | `--code=src --docs=README.md,ARCHITECTURE.md` |
| "只看 API 层" | `--focus=endpoint,routes_to,defines_schema` |
| "用我准备的别名词表 `aliases.json`" | `--aliases=aliases.json` |
| "聚焦 `src/services/auth` 子模块" | `--scope=services/auth` |
| "用我的配置文件 `my-cdc.json`" | `--config=my-cdc.json` |

**Phase 1 步骤**：

1. 读取用户当前消息，提取任何明确的代码/文档路径指定
2. 调用 `resolve-inputs.mjs`，将解析任务交给脚本
3. 读取脚本输出 `00_input/inputs.json`：
   - 如果有 `warnings[]` → 复述给用户（特别是"自动发现的文档"和"找不到任何文档文件"）
   - 如果 `docs.fileCount === 0` → **询问用户**：是否要继续（仅生成代码图）或提供文档路径
   - 如果一切正常 → 直接进 Phase 2
4. 把解析后的路径用于 Phase 2 两个 builder 的 prompt（`<code_root>` = `inputs.code.root`，`<doc_root>` 是 `inputs.docs.roots[]` 的拼接说明）

**何时主动询问 vs 直接执行**：

| 状况 | 行为 |
|-----|------|
| 用户首次触发 + 已有 `code-doc-consistency.json` | 直接用配置，不询问 |
| 首次触发 + 无配置 + 自动发现成功（找到 ≥ 1 个文档） | 用自动发现的结果，**摘要告知用户用了哪些路径**，给 1 句话改主意机会，不阻塞 |
| 首次触发 + 无配置 + 自动发现失败 | 必须询问代码 + 文档路径 |
| 后续作业（"再跑一次"/"聚焦某模块"） | 复用上次 `00_input/inputs.json`，仅在用户提到新路径时询问差异 |

不要因为"想确认一下"就反复询问 — 默认 + 摘要告知 + 改主意机会，比反复来回更尊重用户时间。

### Phase 2: 并行构建两份图谱（coordinator + worker fan-out）

**实行模式：每侧 coordinator → fan-out N worker → coordinator 合并；两侧之间从头到尾并行。**

整体时序：

```
Phase 2a (并行起跑):
  Agent(code-graph-builder, run_in_background=true)   → 跑 SCAN/BATCH/extract-structure，回报 batchTaskInputs[]
  Agent(doc-graph-builder,  run_in_background=true)   → 跑 DISCOVER/STRUCTURED，回报 freetextTaskInputs[]

  ↓ 等两侧 coordinator 各自回报 ready

Phase 2b (fan-out 大并行):
  对 batchTaskInputs[] 中的每一项     → Agent(code-batch-analyzer,    run_in_background=true)
  对 freetextTaskInputs[] 中的每一项  → Agent(doc-freetext-analyzer,  run_in_background=true)

  全部 N+M 个 worker 在同一消息里发出，Claude Code 会按并发上限调度

  ↓ 等所有 worker 完成（或失败）

Phase 2c (并行收尾):
  Agent(code-graph-builder, run_in_background=true)   → 跑 MERGE/REVIEW，输出 01_code_graph.json
  Agent(doc-graph-builder,  run_in_background=true)   → 跑 MERGE/REVIEW，输出 02_doc_graph.json

  ↓ 两图就绪，进 Phase 3
```

#### Phase 2a — coordinator 起跑

在**单条消息**中同时发起两个 coordinator：

```
Agent(
  subagent_type: "code-graph-builder",
  model: "opus",
  run_in_background: true,
  description: "Code graph: SCAN + BATCH + extract-structure (deterministic)",
  prompt: """
    ROLE: coordinator (Phase 2a — deterministic prep only)
    PROJECT_ROOT: <code_root>
    WORKSPACE: $PROJECT_ROOT/_workspace
    PLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}
    生成时间戳: <generated_at>
    聚焦范围（可选）: <focus>

    本次只跑 Phase 1–3：SCAN、BATCH、ANALYZE-prep（per-batch extract-structure）。

    必须依次调用 bundled 脚本（不要写一次性正则、不要 Read 源码合成 summary）：
      1. ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/scan-project.mjs
      2. ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/extract-import-map.mjs
      3. ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/compute-batches.mjs
      4. 对每个 batch 调一次 ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/extract-structure.mjs

    完成后回报 JSON：
      { "phase": "analyze-ready",
        "batchCount": <N>,
        "batchTaskInputs": [
          { "batchIndex": 0,
            "batchInputPath":   "_workspace/01_code_batches.json",
            "batchExtractPath": "_workspace/01_code_extract_0.json",
            "outputPath":       "_workspace/01_code_batch_0.json" },
          ...
        ]
      }

    不要进入 ANALYZE 阶段（LLM 语义合成）—— 那由 orchestrator 拉起 N 个 code-batch-analyzer 处理。
    不要跑 MERGE/REVIEW —— 那由 Phase 2c 再次激活时跑。
  """
)

Agent(
  subagent_type: "doc-graph-builder",
  model: "opus",
  run_in_background: true,
  description: "Doc graph: DISCOVER + STRUCTURED (deterministic)",
  prompt: """
    ROLE: coordinator (Phase 2a — deterministic prep only)
    DOC_ROOTS: <doc_roots, comma-separated>
    WORKSPACE: $PROJECT_ROOT/_workspace
    PLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}
    生成时间戳: <generated_at>
    别名词表（可选）: _workspace/aliases.json

    本次只跑 Phase 1–2：DISCOVER、STRUCTURED。

    必须依次调用 bundled 脚本：
      1. ${CLAUDE_PLUGIN_ROOT}/skills/doc-graph-rag/scripts/discover-docs.mjs
      2. ${CLAUDE_PLUGIN_ROOT}/skills/doc-graph-rag/scripts/extract-doc-structure.mjs \
           _workspace/02_doc_inventory.json _workspace --split --output-prefix="02_doc_structured_"

    完成后从 02_doc_inventory.json 中筛出 docType=markdown 的文档，回报 JSON：
      { "phase": "freetext-ready",
        "markdownCount": <M>,
        "freetextTaskInputs": [
          { "docPath":       "docs/architecture.md",
            "inventoryPath": "_workspace/02_doc_inventory.json",
            "outputPath":    "_workspace/02_doc_freetext_docs_architecture.json",
            "aliasesPath":   "_workspace/aliases.json" },
          ...
        ]
      }

    outputPath 的 slug = docPath 的 / 替换为 _ 并去扩展名（与 doc-freetext-analyzer 约定一致）。

    不要进入 FREETEXT —— 那由 orchestrator 拉起 N 个 doc-freetext-analyzer 处理。
    不要跑 MERGE/REVIEW —— 那由 Phase 2c 再次激活时跑。
  """
)
```

**等待两侧都回报 ready**。如果某侧 coordinator 失败：1 次重试。仍失败 → 终止该侧（如代码侧失败则整体终止；文档侧失败则降级为只生成代码图）。

#### Phase 2b — worker fan-out

读取两侧 coordinator 的回报，得到 `batchTaskInputs[]` 和 `freetextTaskInputs[]`。

**在单条消息中**同时发出全部 N + M 个 worker（每个 `run_in_background: true`）：

```
// 对每个 batchTaskInputs[i]:
Agent(
  subagent_type: "code-batch-analyzer",
  model: "opus",
  run_in_background: true,
  description: "Code analyze batch <i>",
  prompt: """
    batchIndex: <i>
    batchInputPath:   <from batchTaskInputs[i].batchInputPath>
    batchExtractPath: <from batchTaskInputs[i].batchExtractPath>
    scanPath:         _workspace/01_code_scan.json
    outputPath:       <from batchTaskInputs[i].outputPath>
    projectRoot:      <code_root>

    只对 batchIndex=<i> 这一批做 LLM 语义合成（summary/tags/complexity + calls/related）。
    严格遵循 code-batch-analyzer agent 定义的工作流；不要跑 SCAN/BATCH/extract-structure；不要读其他 batch。
    产物写入 outputPath 即完成。
  """
)

// 对每个 freetextTaskInputs[j]:
Agent(
  subagent_type: "doc-freetext-analyzer",
  model: "opus",
  run_in_background: true,
  description: "Doc freetext <slug>",
  prompt: """
    docPath:       <from freetextTaskInputs[j].docPath>
    inventoryPath: <from freetextTaskInputs[j].inventoryPath>
    outputPath:    <from freetextTaskInputs[j].outputPath>
    aliasesPath:   <from freetextTaskInputs[j].aliasesPath>
    projectRoot:   $PROJECT_ROOT

    只对这一份 markdown 做章节切分 + 实体/关系/置信度抽取。
    严格遵循 doc-freetext-analyzer agent 定义的工作流；不要读其他 markdown。
    产物写入 outputPath 即完成。
  """
)
```

**完成判定**：
- 全部 worker 都完成（产物文件存在）→ 进 Phase 2c
- 个别 worker 失败：对失败的那个重跑 1 次。仍失败 → 在 coverage 中记 `missing_batches` / `missing_freetext_docs`，**不**整套重跑
- > 30% worker 失败 → 视作 coordinator 阶段问题，回 Phase 2a 重跑该侧 coordinator 一次

#### Phase 2c — coordinator 收尾合并

在**单条消息**中同时再次激活两个 coordinator：

```
Agent(
  subagent_type: "code-graph-builder",
  model: "opus",
  run_in_background: true,
  description: "Code graph: MERGE + REVIEW",
  prompt: """
    ROLE: coordinator (Phase 2c — merge + review)
    WORKSPACE: $PROJECT_ROOT/_workspace
    PLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}

    本次只跑 Phase 5–6：MERGE、REVIEW。

    1. 验证 _workspace/01_code_batch_*.json 是否齐全（按 01_code_batches.json 中的 batchCount）；
       缺失的 batch 在最终 coverage 中记 missing_batches，不要重跑。
    2. node ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/merge-batch-graphs.mjs \\
         _workspace _workspace/01_code_assembled.json \\
         --side=code --pattern="01_code_batch_*.json"
    3. 写最终 _workspace/01_code_graph.json 与 _workspace/01_code_graph_coverage.md。
  """
)

Agent(
  subagent_type: "doc-graph-builder",
  model: "opus",
  run_in_background: true,
  description: "Doc graph: MERGE + REVIEW",
  prompt: """
    ROLE: coordinator (Phase 2c — merge + review)
    WORKSPACE: $PROJECT_ROOT/_workspace
    PLUGIN_ROOT: ${CLAUDE_PLUGIN_ROOT}

    本次只跑 Phase 4–5：MERGE、REVIEW。

    1. 验证 _workspace/02_doc_freetext_*.json 是否齐全；缺失的记 missing_freetext_docs。
    2. node ${CLAUDE_PLUGIN_ROOT}/skills/code-graph-rag/scripts/merge-batch-graphs.mjs \\
         _workspace _workspace/02_doc_assembled.json \\
         --side=design --pattern="02_doc_structured_*.json,02_doc_freetext_*.json"
    3. 写最终 _workspace/02_doc_graph.json 与 _workspace/02_doc_graph_coverage.md。
  """
)
```

两个 coordinator 都完成且产物存在 → 进 Phase 3。

### Phase 3: 图谱质量审查

**实行模式：子代理顺序**

```
Agent(
  subagent_type: "graph-reviewer",
  model: "opus",
  run_in_background: false,
  description: "Validate both graphs (schema + integrity + cross-graph predict)",
  prompt: """
    输入图谱:
      - _workspace/01_code_graph.json
      - _workspace/02_doc_graph.json
    coverage:
      - _workspace/01_code_graph_coverage.md
      - _workspace/02_doc_graph_coverage.md
    输出:
      - _workspace/02_5_review_report.json
      - _workspace/02_5_review_report.md

    必须先调用 bundled 脚本完成确定性校验：
      node ${CLAUDE_PLUGIN_ROOT}/skills/graph-diff-analyzer/scripts/validate-graph.mjs \\
        ignored _workspace/02_5_review_report.json \\
        --code=_workspace/01_code_graph.json \\
        --doc=_workspace/02_doc_graph.json

    然后基于脚本输出转写人类可读 _workspace/02_5_review_report.md，
    根据 decision 字段（pass/pass_with_warnings/reject）决定是否需要 builder 重跑。
  """
)
```

**审查决策处理**：

| decision | 处理 |
|----------|------|
| `pass` | 直接进 Phase 4 |
| `pass_with_warnings` | 进 Phase 4，但在最终报告中纳入 warnings |
| `reject` | 读取 `02_5_review_report.json` 找出哪图 reject，对应 builder 重试 1 次。再 reject → 进 Phase 4 但在最终报告显著标注"图谱未通过审查，结果可能不可靠" |

### Phase 4: 多层次差异分析

```
Agent(
  subagent_type: "consistency-checker",
  model: "opus",
  run_in_background: false,
  description: "Multi-layer diff analysis (4 layers)",
  prompt: """
    输入图谱:
      - _workspace/01_code_graph.json
      - _workspace/02_doc_graph.json
    审查报告（用于过滤）:
      - _workspace/02_5_review_report.json
    coverage（用于过滤低置信度噪声）:
      - _workspace/01_code_graph_coverage.md
      - _workspace/02_doc_graph_coverage.md
    别名词表（如有）: _workspace/aliases.json
    输出:
      - _workspace/03_diff_report.json
      - _workspace/03_diff_report.md
    生成时间戳: <generated_at>
    聚焦范围（可选）: <focus>

    必须先调用 bundled 脚本预计算 Layer 1 节点对齐：
      node ${CLAUDE_PLUGIN_ROOT}/skills/graph-diff-analyzer/scripts/align-graphs.mjs \\
        _workspace/01_code_graph.json \\
        _workspace/02_doc_graph.json \\
        _workspace/03_alignment.json \\
        --aliases=_workspace/aliases.json    # 如有

    然后调用 /graph-diff-analyzer 技能，按 4 层（节点/关系/属性/行为）依次比较。
    Layer 1 直接读 03_alignment.json — 不要重新做字符串相似度匹配。
    考虑 confidence/tentative/unresolved 字段做严重度降级。
    输出分级（critical/major/minor）的差异报告。
  """
)
```

### Phase 5: 整合与最终报告

1. 读取 `03_diff_report.md` + `03_diff_report.json`
2. 读取 `02_5_review_report.md` 提取审查告警
3. 读取两份 coverage 报告提取关键限制
4. 合成最终报告至用户指定路径（默认 `consistency_report.md`）：

```markdown
# 代码-文档一致性检测报告

生成时间: <YYYY-MM-DD HH:MM:SS>
代码根目录: <code_root>
文档根目录: <doc_root>

## 执行摘要
- Critical: N
- Major: M
- Minor: K
- 代码侧: <node_count> 节点 / <edge_count> 边 / <files_scanned> 文件
- 文档侧: <node_count> 节点 / <edge_count> 边 / <docs_scanned> 文档

## 关键限制（先看这里）
- 代码侧解析失败: ...
- 文档侧不可解析: ...
- 行为层未追踪流程: ...
- 图谱审查告警: ...

## 多层次差异

### Layer 1 · 实体存在性
（来自 03_diff_report.md）

### Layer 2 · 关系
...

### Layer 3 · 属性
...

### Layer 4 · 行为/流程
...

## 对齐歧义
（需要人工确认的不明确对齐）

## 后续操作建议
- 必须修复（critical）: ...
- 应当修复（major）: ...
- 可选改进（minor）: ...

## 附件
- 代码图: `_workspace/01_code_graph.json`
- 文档图: `_workspace/02_doc_graph.json`
- 审查报告: `_workspace/02_5_review_report.md`
- 机器可读差异: `_workspace/03_diff_report.json`
```

### Phase 6: 收尾

1. 保留 `_workspace/`（事后审计、二次比对、增量更新都需要）
2. 向用户汇报：报告路径 + critical 数量 + 最关键 3 条 + 已知限制
3. 询问是否需要：
   - 聚焦某类问题深入分析
   - 提供别名词表后重跑 checker
   - 修改设计/代码后再次执行

## 数据流

```
用户输入
  ↓
[Phase 1: 准备 _workspace/00_input/]
  ↓
[Phase 2a · 双侧 coordinator 并行]
  ├─→ Agent(code-graph-builder)  ──→ SCAN/BATCH/extract-structure
  │                              ──→ 回报 batchTaskInputs[]
  └─→ Agent(doc-graph-builder)   ──→ DISCOVER/STRUCTURED
                                 ──→ 回报 freetextTaskInputs[]
  ↓
[Phase 2b · worker 大并行 fan-out（一条消息发 N + M 个）]
  ├─→ Agent(code-batch-analyzer #0..N-1)   → 01_code_batch_<i>.json
  └─→ Agent(doc-freetext-analyzer #0..M-1) → 02_doc_freetext_<slug>.json
  ↓
[Phase 2c · 双侧 coordinator 并行收尾]
  ├─→ Agent(code-graph-builder)  ──→ MERGE/REVIEW → 01_code_graph.json + coverage
  └─→ Agent(doc-graph-builder)   ──→ MERGE/REVIEW → 02_doc_graph.json + coverage
  ↓ (两图就绪)
[Phase 3 · 顺序]
   Agent(graph-reviewer) ← 读两图 → 02_5_review_report.{json,md}
                        decision: pass / pass_with_warnings / reject
                        reject → 对应 builder 重试 1 次 → 重审
  ↓
[Phase 4 · 顺序]
   Agent(consistency-checker) ← 两图 + reviewer 报告 → 03_diff_report.{json,md}
  ↓
[Phase 5: 整合 → consistency_report.md]
  ↓
[Phase 6: 报告 + 保留 _workspace/]
```

## 错误处理

| 状况 | 策略 |
|------|------|
| code-graph-builder Phase 2a 失败 | 1 次重试。再失败 → 终止 |
| doc-graph-builder Phase 2a 失败 | 1 次重试。再失败 → 提示用户提供文档；可选输出代码图 + "无文档可对比"报告 |
| 两 coordinator Phase 2a 同时失败 | 终止，向用户报告（很可能是输入路径错误） |
| 个别 batch-analyzer / freetext-analyzer 失败 | 仅对失败的那个 worker 重跑 1 次。再失败 → 在 coverage 中记 missing，不整套重跑 |
| > 30% worker 失败 | 视作 coordinator 阶段问题，回 Phase 2a 重跑该侧 coordinator 一次 |
| coordinator Phase 2c 失败 | 1 次重试。再失败 → 把 batch 产物当作半成品，向 reviewer 报告"图谱未合并完整" |
| graph-reviewer 决定 reject | 找出哪图 reject，对应 coordinator 重跑 Phase 2c 一次（重新 MERGE）；如确实是 ANALYZE 阶段问题，触发该侧 worker 部分重跑。仍 reject → 继续到 checker，但报告中显著标注 |
| consistency-checker 失败 | 1 次重试。再失败 → 输出两图 + reviewer 报告供人工对比 |
| 节点对齐歧义 > 20% | 不终止，但在最终报告显著位置提示"建议提供别名词表后重跑" |
| `_workspace/` 写入失败 | 检查权限，向用户报告并终止 |
| 任一 subagent 超时（coordinator 10 分钟、worker 5 分钟） | 视作失败处理 |

**原则**：单点失败不删除已有产物，记录到报告中。worker 失败优先局部重跑，避免整套返工。

## 测试场景

### 正常流程
1. 用户："检查我项目代码和 docs/ 下的设计文档是否一致"
2. Phase 0: `_workspace/` 不存在 → 初次执行
3. Phase 1: 确认输入（默认 cwd + docs/）
4. Phase 2: 并行调用两个 builder（五阶段流水线），两者均成功
5. Phase 3: graph-reviewer 决定 `pass_with_warnings`（ID 风格不完全一致）
6. Phase 4: checker 输出多层次差异报告
7. Phase 5: 整合为 `consistency_report.md`
8. 报告显示 3 critical / 12 major / 7 minor 差异

### 错误流程：图谱审查 reject
1. doc-graph-builder 输出有大量悬挂边（自由文本中提到的实体未规范化）
2. graph-reviewer 决定 `reject`
3. orchestrator 触发 doc-graph-builder 重跑（带 reviewer 报告作输入）
4. 重跑后审查通过 → 进 checker
5. 最终报告中说明图谱被修正一次

### 部分重执行流程：聚焦重跑
1. 初次执行后用户："只看 API 层的差异"
2. Phase 0: `_workspace/` 存在 + 仅 checker → 给 checker 传 `focus: "endpoint,routes_to,defines_schema"`
3. 输出更聚焦的差异报告

## 后续作业关键词

description 中已包含：再次执行、重跑、更新、部分重检、补充扫描、聚焦、改进、增量审计、refresh。后续作业请求触发本 orchestrator 而非另起新流程。

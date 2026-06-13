---
name: graph-diff-analyzer
description: "对代码图与文档图进行多层次差异分析。读取两份同 schema 的有向图 JSON，按节点层、关系层、属性层、行为层四个维度对比，输出分级（critical/major/minor）的差异报告。代码-文档一致性对比、设计漂移检测、API 契约对账时使用。"
---

# Graph Diff Analyzer — 多层次图谱差异分析技能

读取代码图与文档图，按四个层次系统化对比，输出分级差异报告。本技能定义对齐策略、四层比较算法、严重度评定与报告 schema。

## Bundled 脚本（确定性优先）

`scripts/` 下提供两个零依赖 Node.js 脚本，把对齐和 schema 校验从 LLM 工作里剥离：

| 脚本 | 用途 | 调用时机 |
|------|------|---------|
| `validate-graph.mjs` | schema 校验 + 引用完整性 + 跨图 ID 风格预检 | `graph-reviewer` agent 在 checker 之前调用 |
| `align-graphs.mjs` | 三档节点对齐（Tier 1 精确 / Tier 2 同 kind+name / Tier 3 用户别名） | `consistency-checker` agent 在 Layer 1 之前调用 |

**LLM 不重新实现这些** — 字符串距离启发式、引用完整性遍历、ID prefix 解析这类工作放在脚本里更准、更快、可审计。LLM 的工作是读取脚本的 JSON 输出，做"为什么不一致"的语义判断与严重度评级。

详见 `scripts/README.md`（如有）以及下文每层算法描述。

## 何时使用

- 已有两份同 schema 的有向图（一份来自 `/code-graph-rag`，一份来自 `/doc-graph-rag`）
- 需要发现"代码与设计文档不一致"的所有差异并分级
- 输出需同时支持机器处理（JSON）和人类阅读（Markdown）

## 比较的四个层次

层次按"由粗到细"递进，每层依赖前一层的对齐结果。

```
Layer 1: 节点层（实体存在性）
   ↓ 对齐成功的节点继续比较
Layer 2: 关系层（边存在性）
   ↓ 对齐成功的关系继续比较
Layer 3: 属性层（签名/字段等值性）
   ↓
Layer 4: 行为层（流程/调用链一致性）
```

## 对齐策略（前置）

在比较之前，需要对齐两图的节点。

### 一阶对齐：ID 完全匹配
两侧使用同一 ID 命名规范时，`code.nodes[i].id === doc.nodes[j].id` 即对齐。优先级最高。

### 二阶对齐：签名/属性相似度
ID 不匹配但 `(kind, name, qualified_name 末段)` 相同时，标记为候选对齐。需要的相似度阈值：
- `qualified_name` 完全相同：直接对齐
- `name` 相同 + `kind` 相同：候选对齐，标 `alignment_confidence: "medium"`
- 仅 `name` 相同：候选对齐，标 `alignment_confidence: "low"`，可能产生 ambiguous_alignment

### 三阶对齐：用户提供的别名词表
用户可在 `_workspace/aliases.json` 提供：
```json
{
  "function:auth.login.handler": ["function:authentication.login_endpoint"],
  "User": "class:domain.user.User"
}
```

### 对齐输出
```json
{
  "matched": [{"code_id": "...", "doc_id": "...", "confidence": "high"}],
  "code_only": ["function:..."],
  "doc_only": ["class:..."],
  "ambiguous": [{"name": "User", "candidates_code": [...], "candidates_doc": [...]}]
}
```

存到 `_workspace/03_alignment.json`。

## Layer 1: 节点层（Entity Existence）

### 比较内容
- `code_only` — 代码中存在但文档中没有的节点 → **可能的"未文档化实现"**
- `doc_only` — 文档中描述但代码中未实现的节点 → **可能的"未实现设计"或"已删除但文档未更新"**
- `matched` — 双方都有 → 进入 Layer 2

### 严重度评定

| Kind | code_only | doc_only |
|------|-----------|----------|
| api_endpoint | **critical**（公开 API 未文档化） | **critical**（设计 API 未实现） |
| class / data_model（public） | major | major |
| function（public） | major | major |
| field（public） | minor / major（取决于是否在 data_model 上） | major |
| internal/private | minor | minor |
| module | minor（取决于是否在文档列出） | major |

文档侧 `confidence: "low"` 或 `tentative: true` 的节点在 `doc_only` 中**降一级**严重度（避免噪声）。

## Layer 2: 关系层（Edge Existence）

对每对 matched 节点，比较其入边/出边集合。

### 比较算法

```
对每个 matched 节点 N:
  code_edges = code_graph.edges where from == N.code_id or to == N.code_id
  doc_edges  = doc_graph.edges  where from == N.doc_id  or to == N.doc_id

  对每条 code_edge：
    在 doc_edges 中查找 (from, to, kind) 都对齐的边
    找到 → matched_edge
    未找到 → code_only_edge

  对每条 doc_edge：同理
```

### 严重度评定

| Edge Kind | code_only | doc_only |
|-----------|-----------|----------|
| routes_to（API → handler） | **critical** | **critical** |
| inherits / implements | major | major |
| calls（公开方法间） | major | major |
| calls（私有内部） | minor | minor |
| imports / depends_on | minor | minor |
| reads / writes | minor | minor |
| `unresolved: true` 的代码边 | 不报告（已知静态分析局限） | — |

## Layer 3: 属性层（Attribute Equivalence）

对 matched 节点，逐属性比较 `code.attributes` vs `doc.attributes`。

### 重点属性

| Kind | 必比属性 |
|------|----------|
| function / method | `params`（顺序、name、type）, `return_type`, `visibility` |
| class | `extends`, `implements`, `fields`（集合差异）, `visibility` |
| api_endpoint | `http_method`, `http_path`, request schema, response schema |
| data_model | `fields`（每个 field 的 name + type + required） |
| field | `type`, `nullable`, `default` |

### 比较结果分类

- **identical** — 完全一致
- **type_mismatch** — 类型不同（`str` vs `int`）
- **shape_mismatch** — 字段集合不同（缺失/多余字段）
- **order_mismatch** — 顺序不同（参数顺序，重要！）
- **rename** — 名称不同但语义可能相同（标注，不自动判定为一致）

### 严重度

| 类型 | 严重度 |
|------|--------|
| type_mismatch（公开 API/data_model） | **critical** |
| shape_mismatch（data_model 字段缺失） | **critical** |
| shape_mismatch（多余字段） | major |
| order_mismatch（参数顺序） | major |
| rename | major（待人工确认） |
| visibility 不一致 | minor |

## Layer 4: 行为层（Behavioral / Flow）

文档中常用流程描述（"用户登录时，先验证密码，然后生成 JWT，最后写入 session"）；代码中对应的是调用链。

### 抽取流程

#### 4.1 文档侧流程
从文档图中识别"流程节点"：
- 文档章节标题包含"流程"/"flow"/"sequence"/"用例"/"场景"
- Mermaid sequenceDiagram / PlantUML sequence
- 文档章节内列出的有序步骤（编号列表 1./2./3.）

每个流程抽取为：
```json
{
  "flow_id": "flow:user_login",
  "name": "User Login",
  "source": "docs/flows.md#user-login",
  "steps": [
    {"order": 1, "actor": "class:UserService", "action": "calls", "target": "function:verify_password"},
    {"order": 2, "actor": "class:UserService", "action": "calls", "target": "function:generate_jwt"},
    {"order": 3, "actor": "class:SessionStore", "action": "writes", "target": "field:session.token"}
  ]
}
```

#### 4.2 代码侧调用链
对每个文档流程，找代码侧入口（流程的第一个 actor），用代码图追踪 BFS 调用链（最大深度 5）：
```
入口 function:UserService.login
  → calls verify_password
  → calls generate_jwt
  → writes session.token
```

#### 4.3 比较
- **缺失步骤** — 文档有但调用链中没有
- **多余步骤** — 调用链有但文档未描述（关键步骤如安全/审计）
- **顺序不一致** — 文档说先 A 后 B，代码先 B 后 A
- **目标不一致** — 文档说调用 X，代码调用 Y

### 严重度

| 类型 | 严重度 |
|------|--------|
| 缺失关键步骤（认证、授权、审计、加密） | **critical** |
| 缺失普通步骤 | major |
| 顺序不一致 | major |
| 多余的安全/审计步骤 | minor（实现更严格） |
| 多余的非安全步骤 | minor |

行为层无法追踪（动态分发、未找到入口、调用深度超过 5）：在报告中明确标注 `behavioral_analysis: "skipped"`，**不要**编造比较结果。

## 输出 Schema

### `_workspace/03_diff_report.json`

```json
{
  "schema_version": "1.0",
  "generated_at": "<orchestrator 注入>",
  "summary": {
    "critical": 0,
    "major": 0,
    "minor": 0,
    "total": 0
  },
  "alignment": { /* see 对齐输出 */ },
  "layer1_entity": [
    {
      "id": "diff:001",
      "layer": "entity",
      "type": "code_only | doc_only",
      "severity": "critical | major | minor",
      "node": { /* 完整节点对象 */ },
      "explanation": "...",
      "suggestion": "Update docs/api.md section 'Authentication' to add this endpoint OR remove the implementation if no longer needed."
    }
  ],
  "layer2_relation": [...],
  "layer3_attribute": [...],
  "layer4_behavior": [...]
}
```

### `_workspace/03_diff_report.md`

人类可读，结构如下：

```markdown
# 代码-文档一致性差异报告

## 概述
- 关键差异 (critical): N
- 重要差异 (major): M
- 次要差异 (minor): K

## Layer 1: 实体存在性差异

### Critical
1. **[code_only · api_endpoint]** `POST /api/admin/reset` — 代码已实现但文档未描述
   - 来源: `src/admin.py:88`
   - 建议: 在 `docs/api.md` 增补此端点说明，或下线该实现

### Major
...

## Layer 2: 关系差异
...

## Layer 3: 属性差异
...

## Layer 4: 行为/流程差异
...

## 对齐告警
- ambiguous: ...
- 文档中标 tentative 的节点未纳入差异...
```

## 严重度调整规则（综合）

- 任一节点/边来自文档侧 `tentative: true` → 该差异严重度降一级
- 任一节点/边来自代码侧 `unresolved: true` → 不报告关系层差异（已知静态分析局限）
- 严重度阈值由 orchestrator 通过参数控制（默认全部报告）

## 工作原则

- 不要急着下"代码错了"或"文档错了"的结论 — 报告事实，给"修代码 OR 修文档"两个选项
- 文档侧低置信度的差异要克制 — 噪声会淹没真问题
- 行为层是最有价值也最容易出错的层 — 静态追踪不到时**不**编造
- 对齐歧义不要悄悄"挑一个" — 全部列出由用户决定

## 反模式

- ❌ 看到名字相似就强行对齐（`UserService` vs `UserSvc`）然后报告"属性差异"
- ❌ 跳过 Layer 4 但不在报告里说明
- ❌ 把所有差异都标 critical 让数字"显得严重"
- ❌ 单方向对比（只看 code_only 不看 doc_only，或反之）

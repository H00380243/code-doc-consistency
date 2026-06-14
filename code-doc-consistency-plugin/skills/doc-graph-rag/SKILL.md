---
name: doc-graph-rag
description: "从设计文档构建有向图 RAG。两阶段流程：①确定性结构抽取（OpenAPI/Swagger 解析、Mermaid/PlantUML 解析、Proto/GraphQL schema 解析、markdown 章节切分） ②LLM 语义合成自由文本中的实体与关系，并标注措辞置信度。借鉴 SCAN→BATCH→ANALYZE→MERGE 流水线，输出与代码图同 schema 的 JSON。设计文档语义抽取、文档结构化、设计意图建图任务时使用。"
---

# Doc Graph RAG — 设计文档侧有向图构建技能（增强版）

将设计文档转化为可机器对比的有向图。借鉴 [Understand-Anything](https://github.com/) 的"非代码文件也参与图谱"理念，**结构化文档优先用 parser**，**自由文本依赖 LLM 语义抽取**。

## 何时使用

- 多份分散文档（README/architecture.md/openapi.yaml/UML/Proto）需汇总为图
- 后续要与代码图谱做对比
- 需要追溯每个实体来自哪份文档的哪一段

## 核心架构: 五阶段流水线 + FREETEXT fan-out

```
[DISCOVER]   →   [STRUCTURED]   →   [FREETEXT × M]   →   [MERGE]   →   [REVIEW]
 文档清单         OpenAPI/UML       per-doc fan-out      归一去重    schema 校验
                  /Proto/GraphQL    每 markdown 1 worker  多文档融合  悬挂边
                  parser
 ────确定性────  ────确定性────    ──worker LLM──      ────确定性────
                                  （并行 M 个 subagent）
```

**架构变更（v0.2）**: FREETEXT 不再由单个 builder agent 内部串行处理 M 份 markdown，而是由 orchestrator 在 fan-out 阶段拉起 M 个独立的 `doc-freetext-analyzer` worker 并行做 LLM 抽取。本技能描述各阶段**逻辑**；调度由 `code-doc-consistency-orchestrator` 完成。

每阶段产物：
- DISCOVER → `_workspace/02_doc_inventory.json`
- STRUCTURED → `_workspace/02_doc_structured_<source>.json`
- FREETEXT（fan-out worker）→ `_workspace/02_doc_freetext_<slug>.json`
- MERGE → `_workspace/02_doc_assembled.json`
- REVIEW → `_workspace/02_doc_graph.json` + `_workspace/02_doc_graph_coverage.md`

---

## 图谱 Schema（与代码图共享）

详见 `references/graph-schema.md`。**两图必须使用同一 ID 规范** — 命名漂移会让 checker 误判正常实体为"不一致"。

文档侧节点的特殊性：
- `kind` 顶层字段为 `"design"`
- `abstraction_level` 通常 `"logical"`；OpenAPI/Proto 等正式规范为 `"concrete"`
- 措辞模糊处 → `confidence: "low"` + `tentative: true`

---

## Phase A: DISCOVER — 文档发现与分类（确定性）

### A.0 工具与脚本

本技能在 `scripts/` 下提供完整的自包含脚本（零依赖、纯 Node.js 实现），见 `scripts/README.md`。**直接调用**：

| 阶段 | 脚本 | 入参 / 出参 |
|------|------|-----------|
| A. DISCOVER | `discover-docs.mjs <root> <out.json>` | 文档清单 + docType 分类 |
| B. STRUCTURED | `extract-doc-structure.mjs <in.json> <out.json>` | OpenAPI/Proto/GraphQL/Mermaid/PlantUML/JSON Schema 解析为图谱 |
| C. FREETEXT | （LLM 任务，无脚本） | 自由文本 markdown 的语义抽取 |
| D. MERGE | 复用 `code-graph-rag/scripts/merge-batch-graphs.mjs --side=design` | 节点/边去重、ID 归一 |

### A.1 文档清单

按以下优先级 Glob 扫描：

| 优先级 | 路径/模式 | 类型 |
|--------|-----------|------|
| 1 | `docs/`、`design/`、`specs/`、`doc/` 下所有内容 | 主文档 |
| 2 | 根目录 `README.md`、`ARCHITECTURE.md`、`DESIGN.md`、`CONTRIBUTING.md` | 概览 |
| 3 | `**/*.md`（排除 `node_modules`/`vendor`/`.venv` 等） | 散落文档 |
| 4 | `**/openapi.{yaml,yml,json}`、`**/swagger.{yaml,yml,json}` | API 规范 |
| 5 | `**/*.{puml,plantuml}`、markdown 中的 ` ```mermaid` 代码块、`**/*.mmd` | UML/图 |
| 6 | `**/*.proto` | gRPC/Protobuf |
| 7 | `**/*.graphql`、`**/*.gql` | GraphQL schema |
| 8 | `**/*.json-schema`、`**/*.schema.json` | JSON Schema |

### A.2 文档分类

| docType | 适用扩展/路径 | 抽取方式 |
|---------|--------------|---------|
| `markdown` | `.md`/`.mdx`/`.rst` | LLM 自由文本 |
| `openapi` | OpenAPI/Swagger spec | 结构化 parser |
| `mermaid` | `.mmd` 或 markdown 内 mermaid 代码块 | 结构化 parser |
| `plantuml` | `.puml`/`.plantuml` | 结构化 parser |
| `proto` | `.proto` | 结构化 parser |
| `graphql` | `.graphql`/`.gql` | 结构化 parser |
| `jsonschema` | `*.schema.json` | 结构化 parser |

### A.3 DISCOVER 输出

`_workspace/02_doc_inventory.json`:

```json
{
  "scriptCompleted": true,
  "documents": [
    { "path": "docs/architecture.md", "docType": "markdown", "sizeLines": 320 },
    { "path": "docs/api/openapi.yaml", "docType": "openapi", "sizeLines": 580 },
    { "path": "docs/diagrams/login.puml", "docType": "plantuml", "sizeLines": 45 },
    { "path": "docs/diagrams/architecture.png", "docType": "binary", "sizeLines": 0 }
  ],
  "totalDocuments": 8,
  "byType": { "markdown": 5, "openapi": 1, "plantuml": 1, "binary": 1 }
}
```

---

## Phase B: STRUCTURED — 结构化文档抽取（确定性）

**最高优先级，因为 schema 严格、`confidence: "high"` 直接给到。**

### B.1 OpenAPI / Swagger

```yaml
paths:
  /api/login:
    post:
      operationId: loginUser
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/LoginRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/LoginResponse'
components:
  schemas:
    LoginRequest:
      type: object
      properties:
        email: { type: string }
        password: { type: string }
      required: [email, password]
```

抽取规则：

| OpenAPI 元素 | 节点 type | ID |
|--------------|-----------|-----|
| `paths.<path>.<method>` | `endpoint` | `endpoint:<METHOD>:<path>` |
| `components.schemas.<name>` | `schema` | `schema:<name>` |
| `components.responses.<name>` | `schema` | `schema:<name>` |
| `tags` | `module`（按 tag 名分组） | `module:<tag>` |

边规则：

| 关系 | edge type |
|------|-----------|
| endpoint → schema (request) | `defines_schema`（reverse: schema 定义 endpoint 用的结构） |
| endpoint → schema (response) | `defines_schema` |
| endpoint → endpoint（同 tag） | `related` |
| tag → endpoints | `contains` |

`confidence: "high"`、`abstraction_level: "concrete"`。

### B.2 Proto

```proto
service AuthService {
  rpc Login(LoginRequest) returns (LoginResponse);
}
message LoginRequest {
  string email = 1;
  string password = 2;
}
```

| Proto 元素 | 节点 type | ID |
|-----------|-----------|-----|
| `service X` | `service` | `service:X` |
| `rpc Y(...)` | `function` | `function:X.Y` |
| `message Z` | `schema` | `schema:Z` |
| `enum E` | `schema` | `schema:E` |

边：
- service `contains` rpc
- rpc `defines_schema` request/response message

### B.3 Mermaid / PlantUML

#### 类图
```
class A {
  +method()
}
A <|-- B
A --> C : depends
```

| 元素 | 节点 type | edge |
|------|-----------|------|
| `class A` | `class` | — |
| `A <|-- B` | — | `inherits`（B → A） |
| `A *-- C` (composition) | — | `contains` |
| `A --> B` | — | `depends_on` |

#### 时序图
```
sequenceDiagram
  Client ->> AuthService: POST /login
  AuthService ->> DB: query user
  AuthService -->> Client: JWT
```

| 元素 | 节点 type |
|------|-----------|
| 参与者 (`Client`、`AuthService`) | `module` 或 `service` |
| 消息 | `calls` 边（按时序记 order） |

可选：将整个时序图作为 `flow` 节点，每条消息作 `step`，`flow_step` 边相连 — 这能让 checker 在 Layer 4（行为层）做精细对比。

### B.4 GraphQL Schema

```graphql
type User {
  id: ID!
  email: String!
}
type Query {
  user(id: ID!): User
}
```

| 元素 | 节点 type | ID |
|------|-----------|-----|
| `type X` | `schema` | `schema:X` |
| `Query/Mutation` 字段 | `endpoint` | `endpoint:GraphQL:<field>` |

### B.5 STRUCTURED 输出（per source）

`_workspace/02_doc_structured_<source>.json`:

```json
{
  "source": "docs/api/openapi.yaml",
  "docType": "openapi",
  "nodes": [...],
  "edges": [...]
}
```

---

## Phase C: FREETEXT — 自由文本 LLM 抽取

**执行者（v0.2）**：本阶段由 orchestrator 在 Phase 2b fan-out M 个 `doc-freetext-analyzer` worker 并行完成 —— **每份 markdown 一个 worker**，互不通信，各写各的产物。`doc-graph-builder` coordinator 不直接执行 FREETEXT，仅准备清单和事后合并。

每个 worker 的输入/输出契约见 `doc-freetext-analyzer` agent 定义。下面的 C.1–C.7 是**逻辑**层面的说明（每个 worker 内部按这个流程跑自己那一份文档）。

**只对 markdown 类型文档进行。** OpenAPI/UML 等已在 Phase B 处理完毕。

### C.1 章节切分

按 H2/H3 切分文档为 chunk，每 chunk ≤ 1000 tokens。每 chunk 是独立分析单元。

### C.2 实体识别

在每 chunk 中识别：

#### 候选实体
- **加粗或代码格式名词** — `**UserService**`、`` `validate_token` ``、`` `POST /api/login` ``
- **表格行** — API 表、组件表、模型表
- **列表项中的命名** — "本服务包含: UserService, AuthService, BillingService"
- **有序步骤中的角色** — "1. 客户端发起请求 2. 网关验证 3. 业务服务处理"

#### 节点类型推断

| 关键词/上下文 | 节点 type |
|--------------|-----------|
| 含 `Service`/`Controller` 后缀 + 句子语境是组件 | `module` 或 `service` |
| 类似 `class:UserService` 格式 + 提到方法 | `class` |
| 函数签名 `verify(...)` | `function` |
| HTTP 路径 `POST /api/X` | `endpoint`（id: `endpoint:POST:/api/X`） |
| 表/集合名（"users 表"、"orders collection"） | `table` |
| 数据模型（"LoginRequest 包含 email, password"） | `schema` |
| 章节标题包含 "流程"/"flow"/"用例" | `flow`（其下步骤为 `step`） |
| 抽象概念（"限流"/"rate limiting"/"事件总线"） | `concept` |

### C.3 关系识别

#### 动词关系
| 动词（中英）| edge type |
|-------------|-----------|
| 调用 / calls / invokes | `calls` |
| 继承 / inherits / extends | `inherits` |
| 实现 / implements | `implements` |
| 依赖 / depends on / requires | `depends_on` |
| 读取 / reads from / queries | `reads_from` |
| 写入 / writes to / persists | `writes_to` |
| 包含 / contains / has | `contains` |
| 路由 / routes to | `routes` |
| 触发 / triggers | `triggers` |
| 测试 / tested by | `tested_by` |
| 配置 / configures | `configures` |
| 部署 / deploys | `deploys` |
| 文档化 / documents / 描述 | `documents` |

### C.4 措辞置信度

| 措辞 | confidence | tentative |
|------|------------|-----------|
| "调用"/"calls"/"is"/"will"/"必须" | `high` | `false` |
| "应该"/"should"/"may"/"通常" | `medium` | `false` |
| "考虑"/"未来"/"TBD"/"future"/"可能"/"或许" | `low` | `true` |

低置信度节点/边**仍发出**（不丢弃），但 checker 会做严重度降级。

### C.5 实体规范化

不同文档对同一实体可能用不同称谓，规范化规则：

1. **大小写规范化**: `UserService` 和 `userservice` 视为同实体
2. **去除装饰**: `**UserService**`、`` `UserService` ``、`UserService()` → `UserService`
3. **同义词词表**（可扩展）:
   - `auth` ≡ `authentication` ≡ `认证`
   - `db` ≡ `database` ≡ `数据库`
4. **无法规范化保留原文**，coverage 报告标注

### C.6 来源记录

每节点必须有 `source.file` + 自由文本节点还应有 `source.section`：

```json
{
  "id": "concept:rate-limiting",
  "type": "concept",
  "name": "Rate Limiting",
  "summary": "Token-bucket based rate limiting applied at the API gateway, with per-user quotas.",
  "tags": ["security", "infrastructure"],
  "complexity": "moderate",
  "source": {
    "file": "docs/architecture.md",
    "section": "Rate Limiting",
    "line_start": 120,
    "line_end": 145
  },
  "confidence": "high",
  "abstraction_level": "logical",
  "tentative": false
}
```

### C.7 FREETEXT 输出（per doc）

`_workspace/02_doc_freetext_<doc>.json`:

```json
{
  "source": "docs/architecture.md",
  "nodes": [...],
  "edges": [...]
}
```

---

## Phase D: MERGE — 多文档融合 + 归一（确定性）

合并所有 STRUCTURED + FREETEXT 输出 → `02_doc_assembled.json`：

### D.1 节点融合规则

按 `id` 去重。同 ID 节点合并：

#### 来源合并
- `source` 字段变成数组
- 例: `[{"file": "docs/architecture.md", "section": "Auth"}, {"file": "openapi.yaml", "line_start": 42}]`

#### 属性合并
按文档类型优先级填充：
1. **OpenAPI / Proto / JSON Schema**（结构化、`high` 置信度）
2. **PlantUML / Mermaid**
3. **Markdown 自由文本**

冲突时（同字段两种文档给出不同值）保留双值并标 `conflict: true`：

```json
{
  "id": "schema:LoginRequest",
  "attributes": {
    "fields": {
      "openapi": ["email", "password"],
      "markdown": ["email", "password", "captcha"]
    }
  },
  "conflict": true
}
```

#### 置信度合并
取最高（多份文档都提到 → 比单文档可信）。

#### tentative 合并
任一来源 tentative 即为 tentative（除非有非 tentative 的源）。

### D.2 边去重
- key = `(source, target, type)`
- weight 取 max；confidence 取 highest

### D.3 ID 规范化
- 去除项目名前缀（`my-project:class:User` → `class:User`）
- 缺前缀的裸名补前缀（自由文本可能产出 `UserService` → `module:UserService` 或 `class:UserService` 看上下文）
- 大小写规范化路径

### D.4 悬挂边删除
- 任一端引用不存在的节点 → 丢弃
- 计入 coverage 的 `dropped_dangling_edges`

---

## Phase E: REVIEW — schema 校验

由 `graph-reviewer` agent 处理（与代码侧共用）。校验后输出最终 `02_doc_graph.json` + `02_doc_graph_coverage.md`。

---

## 工作原则

- **结构化优先** — OpenAPI/UML/Proto 直接 parser，不让 LLM 重新猜
- **文档说什么就是什么** — 不用代码反向补全文档遗漏
- **歧义透明** — 模糊措辞降置信度，**不**为图谱"完整度"强行解读
- **多文档不挑选** — 所有出处保留为 sources 数组
- **ID 与代码图严格一致** — 命名漂移 = checker 误判
- **来源必填** — 每节点都能追溯到文档+章节，便于人工核查

## 反模式

- ❌ 看到代码里有 `class Order` 就在文档图加推测节点
- ❌ 把"未来计划"段落里的实体当作当前设计
- ❌ 自行翻译/改写实体名（"UserService" 改成 "用户服务"）
- ❌ 多份冲突文档时只挑一份"看起来对的"
- ❌ OpenAPI 已经定义了 endpoint，markdown 用模糊语言又描述一次，结果生成两个不同 ID 的节点（必须按 ID 规范融合）
- ❌ 把整份 markdown 一次扔给 LLM 而不切分（精度低 + token 浪费）

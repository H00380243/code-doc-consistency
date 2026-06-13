# Graph Schema — 代码图与文档图共享数据模型

本文档定义代码侧（`/code-graph-rag`）与文档侧（`/doc-graph-rag`）**共享**的图谱 schema。两图必须严格遵守同一节点/边类型集合与同一 ID 命名规范，否则 `consistency-checker` 会误判正常实体为"不一致"。

> 本 schema 借鉴 Understand-Anything 的 KnowledgeGraph 设计，扩展了 `confidence` / `abstraction_level` / `tentative` 等字段以支持代码-文档对比场景。

## 目录

1. [整体结构](#1-整体结构)
2. [节点类型（16 种）](#2-节点类型16-种)
3. [边类型（29 种）](#3-边类型29-种)
4. [ID 命名规范](#4-id-命名规范)
5. [对比专用字段](#5-对比专用字段)
6. [合并归一规则](#6-合并归一规则)

---

## 1. 整体结构

```json
{
  "schema_version": "1.0",
  "kind": "codebase | design",
  "source_root": "<项目根 / 文档根>",
  "generated_at": "<orchestrator 注入>",
  "project": {
    "name": "...",
    "languages": ["typescript", "python"],
    "frameworks": ["FastAPI", "React"],
    "description": "..."
  },
  "nodes": [...],
  "edges": [...],
  "layers": [...],
  "stats": {
    "node_count": 0,
    "edge_count": 0,
    "files_scanned": 0,
    "files_failed": 0
  }
}
```

`layers` 是逻辑分层（layered architecture / component / MVC 等），可选；首次构建时只代码侧填充，文档侧为空。

## 2. 节点类型（16 种）

| Type | 适用 | 描述 |
|------|------|------|
| `file` | 代码 | 源代码文件 |
| `function` | 代码 | 函数/方法 |
| `class` | 代码 | 类/接口 |
| `module` | 双方 | 模块/包/组件（高抽象） |
| `concept` | 双方 | 抽象概念（如"认证"、"事件总线"） |
| `config` | 代码 | 配置文件（tsconfig.json、.env 等） |
| `document` | 双方 | 文档文件（README、设计文档） |
| `service` | 双方 | 服务（Dockerfile、k8s service、设计文档中的服务） |
| `table` | 数据 | 数据库表 |
| `endpoint` | 双方 | API 端点（HTTP 路由、gRPC method） |
| `pipeline` | 代码 | CI/CD 流水线（GitHub Actions、Jenkinsfile） |
| `schema` | 双方 | 数据 schema（GraphQL/Proto/JSON Schema） |
| `resource` | 代码 | 基础设施资源（Terraform、CloudFormation） |
| `domain` | 文档 | 业务领域 |
| `flow` | 文档 | 业务流程 / 用例 |
| `step` | 文档 | 流程步骤 |

**节点字段**:

```json
{
  "id": "function:src/auth/login.py:verify_password",
  "type": "function",
  "name": "verify_password",
  "qualified_name": "auth.login.verify_password",
  "filePath": "src/auth/login.py",
  "lineRange": [42, 58],
  "summary": "Compare a plaintext password against a bcrypt hash with constant-time comparison.",
  "tags": ["security", "authentication", "utility"],
  "complexity": "simple | moderate | complex",
  "languageNotes": "Uses bcrypt's constant-time compare to prevent timing attacks.",

  "attributes": {
    "signature": "verify_password(plain: str, hashed: str) -> bool",
    "params": [{"name": "plain", "type": "str"}, {"name": "hashed", "type": "str"}],
    "return_type": "bool",
    "visibility": "public | private | internal",
    "decorators": [],
    "extends": null,
    "implements": [],
    "fields": [],
    "http_method": null,
    "http_path": null
  },

  "source": {
    "file": "src/auth/login.py",
    "line_start": 42,
    "line_end": 58,
    "section": null
  },

  "confidence": "high | medium | low",
  "abstraction_level": "concrete | logical",
  "tentative": false,
  "conflict": false
}
```

`tags` 长度 ≥ 1。`complexity` 必须是三选一。`attributes` 中只填该 type 适用的字段；其他保持 null 或省略。

## 3. 边类型（29 种）

按类别组织：

### Structural（5）
- `imports`, `exports`, `contains`, `inherits`, `implements`

### Behavioral（4）
- `calls`, `subscribes`, `publishes`, `middleware`

### Data flow（4）
- `reads_from`, `writes_to`, `transforms`, `validates`

### Dependencies（3）
- `depends_on`, `tested_by`, `configures`

### Semantic（2）
- `related`, `similar_to`

### Infrastructure（4）
- `deploys`, `serves`, `provisions`, `triggers`

### Schema/Data（4）
- `migrates`, `documents`, `routes`, `defines_schema`

### Domain（3）
- `contains_flow`, `flow_step`, `cross_domain`

**边字段**:

```json
{
  "source": "function:src/auth/login.py:handler",
  "target": "function:src/auth/login.py:verify_password",
  "type": "calls",
  "direction": "forward | backward | bidirectional",
  "weight": 0.8,
  "description": "Login handler validates credentials before issuing JWT.",

  "source_location": {
    "file": "src/auth/login.py",
    "line": 30
  },

  "confidence": "high | medium | low",
  "unresolved": false
}
```

**weight 推荐值**:

| Edge type | Weight |
|-----------|--------|
| `imports` | 0.7 |
| `calls` | 0.8 |
| `inherits` / `implements` / `defines_schema` | 0.9 |
| `contains` | 1.0 |
| `tested_by` / `related` / `routes` / `triggers` / `documents` | 0.5–0.6 |
| 静态分析 unresolved | 0.3 |

**direction 默认 `forward`**。

## 4. ID 命名规范

**两图必须使用同样的 ID 格式**。这是 checker 能对齐的前提。

| Type | ID Format | 示例 |
|------|-----------|------|
| `file` | `file:<rel-path>` | `file:src/index.ts` |
| `function` | `function:<rel-path>:<name>` | `function:src/auth/login.py:verify_password` |
| `class` | `class:<rel-path>:<ClassName>` | `class:src/models/user.ts:User` |
| `module` | `module:<dotted-path>` | `module:auth.login` |
| `concept` | `concept:<kebab-name>` | `concept:rate-limiting` |
| `config` | `config:<rel-path>` | `config:tsconfig.json` |
| `document` | `document:<rel-path>` | `document:README.md` |
| `service` | `service:<rel-path>` 或 `service:<name>` | `service:Dockerfile` / `service:user-service` |
| `table` | `table:<rel-path>:<name>` | `table:migrations/001.sql:users` |
| `endpoint` | `endpoint:<METHOD>:<path>` | `endpoint:POST:/api/login` |
| `pipeline` | `pipeline:<rel-path>` | `pipeline:.github/workflows/ci.yml` |
| `schema` | `schema:<rel-path>` 或 `schema:<name>` | `schema:schema.graphql` / `schema:LoginRequest` |
| `resource` | `resource:<rel-path>` | `resource:main.tf` |
| `domain` | `domain:<kebab-name>` | `domain:billing` |
| `flow` | `flow:<kebab-name>` | `flow:user-login` |
| `step` | `step:<flow>:<order>` | `step:user-login:1` |

### 跨图对齐规则

- **代码图** 用源代码相对路径作 ID 主体
- **文档图** 用相同的相对路径（如果文档明确指代该路径），或用 qualified name（命名空间.类型名）
- 如果文档没指明文件路径但提到了类/函数名，文档图先用 `function:<name>` 这种 path-less 形式，由 checker 在二阶对齐时尝试匹配

### 路径规范化（避免漂移）

- 路径分隔符统一用 `/`，不用 `\`
- 路径相对 `source_root`，不带前导 `/` 或 `./`
- 大小写敏感（与文件系统一致）
- 不带后缀：禁止使用 `file:src/index.ts.js`，应用真实文件名

## 5. 对比专用字段

为了让两图能精确对比，**扩展**了 Understand-Anything 标准 schema：

### 节点扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `qualified_name` | string | 命名空间路径（用于跨图对齐时备选） |
| `attributes` | object | 类型特定属性（详见上） |
| `source` | object | 源位置（file + line / section） |
| `confidence` | enum | high/medium/low — 反映该节点的事实可信度 |
| `abstraction_level` | enum | concrete / logical — 代码=concrete；文档常=logical |
| `tentative` | boolean | 文档中"可能"/"未来"等措辞 → true |
| `conflict` | boolean | 多文档冲突时合并保留双值 |

### 边扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `source_location` | object | 该边来源（哪个 file / 哪段文档） |
| `confidence` | enum | high/medium/low |
| `unresolved` | boolean | 静态分析无法确定（动态分发等） |

### 用法

| 场景 | 该填什么 |
|------|----------|
| 代码 AST 抽出的精确边 | `confidence: "high"`, `unresolved: false` |
| 代码动态分发推断 | `confidence: "low"`, `unresolved: true`, `weight: 0.3` |
| OpenAPI/Proto 中明确的 endpoint/schema | `confidence: "high"`, `abstraction_level: "concrete"` |
| Markdown "用户服务调用认证模块" | `confidence: "high"`（措辞肯定）, `abstraction_level: "logical"` |
| Markdown "未来可能引入双因子认证" | `confidence: "low"`, `tentative: true` — checker 会**降一级严重度** |
| 多文档对同一类有冲突描述 | 节点 `conflict: true`, 双方属性都保留 |

## 6. 合并归一规则

每个 builder 的 Phase C（合并归一）必须执行：

### 节点去重
- key = `id`
- 同 ID 节点合并 `source` 数组（变成 `[source1, source2, ...]`）
- 属性合并优先级：高置信度文档 > 低置信度文档；冲突时保留双值并标 `conflict: true`

### 边去重
- key = `(source, target, type)`
- 同 key 的边只保留一条（weight 取最大值，confidence 取最高）

### 悬挂边删除
- 任一端引用的节点不存在 → 丢弃该边
- 写入 coverage 报告的 `dropped_dangling_edges` 列表

### ID 规范化
- 去除项目名前缀（`my-project:file:foo.ts` → `file:foo.ts`）
- 缺失前缀的裸路径补前缀（`src/foo.ts` → `file:src/foo.ts`）
- 大小写规范化：路径保留原大小写，类型前缀统一小写

### 复杂度归一化
| LLM 可能输出 | 归一为 |
|--------------|--------|
| `low`, `easy`, `trivial` | `simple` |
| `medium` | `moderate` |
| `high`, `hard` | `complex` |

### 边方向修正
- `tested_by` 必须 `production → test`，反向时翻转
- 其他边方向以 LLM 输出为准（不强行修正）

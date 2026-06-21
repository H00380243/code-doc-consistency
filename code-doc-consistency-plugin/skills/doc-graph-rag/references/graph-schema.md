# Graph Schema (shared)

> 与 `/code-graph-rag/references/graph-schema.md` 内容**完全相同**。文档侧 builder 必须遵守同一 schema。

请直接 Read `_workspace/../code-doc-consistency-plugin/skills/code-graph-rag/references/graph-schema.md` 或加载该文件。

如该文件不可访问（独立运行场景），**关键摘要**：

## 节点 ID 命名（必读）

文档图谱使用与代码图 **完全相同** 的 ID 前缀：

### 通用类型

| 节点类型 | 前缀 | 示例 |
|---------|------|------|
| `function` | `function:<rel-path>:<name>` | `function:src/main/java/com/example/UserService.java:getUser` |
| `class` | `class:<rel-path>:<ClassName>` | `class:src/main/java/com/example/User.java:User` |
| `endpoint` | `endpoint:<METHOD>:<path>` | `endpoint:GET:/api/users/{id}` |
| `schema` | `schema:<name>` 或 `schema:<rel-path>` | `schema:LoginRequest` |
| `service` | `service:<name>` | `service:user-service` |
| `module` | `module:<dotted-path>` | `module:com.example.service` |
| `concept` | `concept:<kebab-name>` | `concept:rate-limiting` |
| `domain` | `domain:<kebab-name>` | `domain:billing` |
| `flow` | `flow:<kebab-name>` | `flow:user-login` |
| `step` | `step:<flow>:<order>` | `step:user-login:1` |

### Java/Spring 专用类型

| 节点类型 | 前缀 | 示例 |
|---------|------|------|
| `interface` | `interface:<rel-path>:<Name>` | `interface:src/main/java/com/example/UserRepository.java:UserRepository` |
| `annotation` | `annotation:<fqn>` | `annotation:org.springframework.web.bind.annotation.RestController` |
| `enum` | `enum:<rel-path>:<Name>` | `enum:src/main/java/com/example/OrderStatus.java:OrderStatus` |
| `configuration` | `configuration:<rel-path>:<Name>` | `configuration:src/main/java/com/example/SecurityConfig.java:SecurityConfig` |
| `entity` | `entity:<rel-path>:<Name>` | `entity:src/main/java/com/example/User.java:User` |
| `mapper` | `mapper:<rel-path>:<Name>` | `mapper:src/main/java/com/example/UserMapper.java:UserMapper` |
| `test` | `test:<rel-path>:<Name>` | `test:src/test/java/com/example/UserServiceTest.java:UserServiceTest` |

**当文档没指明源文件路径时**：
- 用 qualified name 形式 `function:com.example.UserService.getUser`
- 这是路径未知时的备选格式；`consistency-checker` 会做二阶对齐尝试匹配代码图中的 `function:src/main/java/com/example/UserService.java:getUser`
- 如果文档**确实指明了**文件路径（如 markdown 写"在 `src/main/java/com/example/UserService.java` 中"），优先用代码侧的格式

## 文档侧专属约束

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `kind`（图谱级） | `"design"` | 区别于代码侧的 `"codebase"` |
| 节点 `abstraction_level` | `"logical"` | 仅 OpenAPI/Proto 等正式规范用 `"concrete"` |
| 节点 `confidence` | 与措辞挂钩 | 详见下表 |
| 节点 `tentative` | 与措辞挂钩 | "可能/未来/TBD" 时 `true` |

### 措辞 → 置信度映射

| 文档措辞 | confidence | tentative |
|----------|------------|-----------|
| "调用"/"calls"/"is"/"will" | `high` | `false` |
| "应该"/"should"/"may" | `medium` | `false` |
| "考虑"/"未来"/"TBD"/"future"/"可能" | `low` | `true` |
| OpenAPI/Proto 等结构化规范 | `high` | `false` |
| Mermaid/PlantUML 图 | `high` | `false` |

### 来源记录（强制）

每个节点必须有 `source.file`，自由文本提取还应记录 `source.section`（章节锚点），便于追溯：

```json
{
  "id": "endpoint:GET:/api/users/{id}",
  "source": {
    "file": "docs/api/openapi.yaml",
    "line_start": 42,
    "line_end": 58,
    "section": null
  }
}
```

```json
{
  "id": "concept:rate-limiting",
  "source": {
    "file": "docs/architecture.md",
    "section": "Rate Limiting",
    "line_start": 120
  }
}
```

### Java/Spring 文档中常见实体

设计文档（Markdown）中经常出现的 Java/Spring 实体类型：

| 文档提及 | 推荐节点类型 | 推荐 ID 格式 |
|----------|-------------|-------------|
| `UserService` 类 | `class` | `class:UserService`（路径未知时） |
| `UserRepository` 接口 | `interface` | `interface:UserRepository` |
| `GET /api/users` 端点 | `endpoint` | `endpoint:GET:/api/users` |
| `User` 实体 | `entity` | `entity:User` |
| Spring Security 配置 | `configuration` | `configuration:SecurityConfig` |
| `@Transactional` 注解 | `annotation` | `annotation:org.springframework.transaction.annotation.Transactional` |
| 数据库表 `t_user` | `table` | `table:t_user` |
| 消息队列 `order.created` | `concept` | `concept:order-created-event` |

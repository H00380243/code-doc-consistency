# Graph Schema — 代码图与文档图共享数据模型

本文档定义代码侧（`/code-graph-rag`）与文档侧（`/doc-graph-rag`）**共享**的图谱 schema。两图必须严格遵守同一节点/边类型集合与同一 ID 命名规范，否则 `consistency-checker` 会误判正常实体为"不一致"。

> 本 schema 借鉴 Understand-Anything 的 KnowledgeGraph 设计，扩展了 `confidence` / `abstraction_level` / `tentative` 等字段以支持代码-文档对比场景。v2.0 新增 Java/Spring 生态专用类型与字段。

## 目录

1. [整体结构](#1-整体结构)
2. [节点类型（29 种）](#2-节点类型29-种)
3. [边类型（44 种）](#3-边类型44-种)
4. [ID 命名规范](#4-id-命名规范)
5. [对比专用字段](#5-对比专用字段)
6. [Java/Spring 专属字段](#6-javaspring-专属字段)
7. [合并归一规则](#7-合并归一规则)

---

## 1. 整体结构

```json
{
  "schema_version": "2.0",
  "kind": "codebase | design",
  "source_root": "<项目根 / 文档根>",
  "generated_at": "<orchestrator 注入>",
  "project": {
    "name": "...",
    "languages": ["java", "kotlin"],
    "frameworks": ["Spring Boot", "MyBatis"],
    "build_tools": ["Maven"],
    "modules": ["module-a", "module-b"],
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

`project.build_tools` 和 `project.modules` 为 v2.0 新增字段，由 `parse-pom.mjs` 填充。

## 2. 节点类型（29 种）

### 通用类型（16 种，v1.0）

| Type | 适用 | 描述 |
|------|------|------|
| `file` | 代码 | 源代码文件 |
| `function` | 代码 | 函数/方法 |
| `class` | 代码 | 类（含抽象类） |
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

### Java/Spring 专用类型（13 种，v2.0）

| Type | 适用 | 描述 | 典型来源 |
|------|------|------|----------|
| `interface` | 代码 | Java 接口 | `interface UserRepository` |
| `annotation` | 代码 | Java 注解类型 | `@RestController`, `@Transactional` |
| `enum` | 代码 | Java 枚举 | `enum OrderStatus { ... }` |
| `configuration` | 代码 | Spring `@Configuration` 类 | `SecurityConfig`, `DataSourceConfig` |
| `test` | 代码 | 测试类/方法 | `UserServiceTest` |
| `entity` | 双方 | JPA `@Entity` 实体 | `@Entity class User` |
| `mapper` | 代码 | MyBatis Mapper 接口/XML | `UserMapper.xml`, `UserMapper.java` |
| `message_consumer` | 代码 | 消息消费者 | `@RabbitListener`, `@KafkaListener` |
| `message_producer` | 代码 | 消息生产者 | `RabbitTemplate.send()` |
| `cache_config` | 代码 | 缓存配置 | `@EnableCaching`, `RedisCacheManager` |
| `security_filter` | 代码 | Spring Security 过滤器/配置 | `OncePerRequestFilter`, `SecurityFilterChain` |
| `discovery_client` | 代码 | 服务发现客户端 | `@EnableDiscoveryClient`, Feign Client |
| `grpc_service` | 双方 | gRPC 服务定义 | `@GrpcService`, `.proto` service |

### 节点字段

```json
{
  "id": "function:src/main/java/com/example/UserService.java:getUser",
  "type": "function",
  "name": "getUser",
  "qualified_name": "com.example.UserService.getUser",
  "filePath": "src/main/java/com/example/UserService.java",
  "lineRange": [42, 58],
  "summary": "Retrieve a user by their unique identifier from the repository.",
  "tags": ["user", "query", "service"],
  "complexity": "simple | moderate | complex",
  "languageNotes": "",

  "attributes": {
    "signature": "User getUser(Long id)",
    "params": [{"name": "id", "type": "Long"}],
    "return_type": "User",
    "visibility": "public",
    "is_static": false,
    "is_final": false,
    "is_abstract": false,
    "annotations": ["@Transactional(readOnly = true)"],
    "decorators": [],
    "extends": null,
    "implements": [],
    "fields": [],
    "http_method": null,
    "http_path": null,
    "jpa_table": null,
    "jpa_columns": [],
    "spring_scope": null,
    "java_package": "com.example",
    "java_generics": [],
    "maven_module": null
  },

  "source": {
    "file": "src/main/java/com/example/UserService.java",
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

## 3. 边类型（44 种）

### Structural（6）
- `imports`, `exports`, `contains`, `inherits`, `implements` (v1.0)
- `implements_interface` (v2.0) — 类 → 接口，比 `implements` 更精确

### Behavioral（6）
- `calls`, `subscribes`, `publishes`, `middleware` (v1.0)
- `overrides` (v2.0) — 方法重写父类方法
- `throws_exception` (v2.0) — 方法 → 异常类型

### Data flow（4）
- `reads_from`, `writes_to`, `transforms`, `validates` (v1.0)

### Dependencies（4）
- `depends_on`, `tested_by`, `configures` (v1.0)
- `declares` (v2.0) — 类 → 内部类型（内部类、枚举、注解）

### Spring DI & Bean（4，v2.0）
- `autowires` — 字段/构造器注入关系（`@Autowired` 字段 → Bean 类型）
- `configures_bean` — `@Configuration` 类 → `@Bean` 方法 → 产出的 Bean 类型
- `injects` — 构造器注入参数 → Bean 类型（与 `autowires` 区分注入方式）

### Spring Web（2，v2.0）
- `exposes_endpoint` — `@Controller`/`@RestController` 类 → HTTP 端点
- `annotated_with` — 类/方法/字段 → 注解类型

### Spring Data & Persistence（3，v2.0）
- `maps_to_table` — `@Entity` 类 → 数据库表
- `maps_to_column` — 字段 → `@Column` 映射
- `defines_mapper` — Mapper 接口 → MyBatis XML 映射文件

### Spring Messaging（2，v2.0）
- `consumes_message` — `@RabbitListener`/`@KafkaListener` → 队列/Topic
- `produces_message` — `RabbitTemplate`/`KafkaTemplate` → 队列/Topic

### Spring Cache & Security（2，v2.0）
- `caches` — `@Cacheable`/`@CacheEvict` → 缓存 key
- `secures` — `SecurityFilterChain`/`@PreAuthorize` → 受保护资源

### Spring Cloud（1，v2.0）
- `discovers_service` — `@DiscoveryClient`/Feign → 服务名

### Schema/Data（4，v1.0）
- `migrates`, `documents`, `routes`, `defines_schema`

### Semantic（2，v1.0）
- `related`, `similar_to`

### Infrastructure（4，v1.0）
- `deploys`, `serves`, `provisions`, `triggers`

### Domain（3，v1.0）
- `contains_flow`, `flow_step`, `cross_domain`

### gRPC（1，v2.0）
- `implements_grpc` — Java 类 → `.proto` service 定义

### 边字段

```json
{
  "source": "class:src/main/java/com/example/UserController.java:UserController",
  "target": "endpoint:GET:/api/users/{id}",
  "type": "exposes_endpoint",
  "direction": "forward",
  "weight": 0.9,
  "description": "UserController exposes GET /api/users/{id} via @GetMapping.",

  "source_location": {
    "file": "src/main/java/com/example/UserController.java",
    "line": 35
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
| `inherits` / `implements` / `implements_interface` / `defines_schema` | 0.9 |
| `contains` | 1.0 |
| `autowires` / `injects` / `configures_bean` | 0.9 |
| `exposes_endpoint` | 1.0 |
| `annotated_with` | 0.8 |
| `maps_to_table` / `maps_to_column` | 0.9 |
| `overrides` | 0.85 |
| `throws_exception` | 0.6 |
| `tested_by` / `related` / `routes` / `triggers` / `documents` | 0.5–0.6 |
| `consumes_message` / `produces_message` | 0.8 |
| `caches` / `secures` | 0.7 |
| `discovers_service` | 0.6 |
| `defines_mapper` | 0.9 |
| 静态分析 unresolved | 0.3 |

**direction 默认 `forward`**。

## 4. ID 命名规范

**两图必须使用同样的 ID 格式**。这是 checker 能对齐的前提。

### 通用类型 ID

| Type | ID Format | 示例 |
|------|-----------|------|
| `file` | `file:<rel-path>` | `file:src/main/java/com/example/App.java` |
| `function` | `function:<rel-path>:<name>` | `function:src/main/java/com/example/UserService.java:getUser` |
| `class` | `class:<rel-path>:<ClassName>` | `class:src/main/java/com/example/User.java:User` |
| `module` | `module:<dotted-path>` | `module:com.example.service` |
| `concept` | `concept:<kebab-name>` | `concept:rate-limiting` |
| `config` | `config:<rel-path>` | `config:application.yml` |
| `document` | `document:<rel-path>` | `document:docs/architecture.md` |
| `service` | `service:<rel-path>` 或 `service:<name>` | `service:Dockerfile` / `service:user-service` |
| `table` | `table:<name>` | `table:t_user` |
| `endpoint` | `endpoint:<METHOD>:<path>` | `endpoint:GET:/api/users/{id}` |
| `pipeline` | `pipeline:<rel-path>` | `pipeline:.github/workflows/ci.yml` |
| `schema` | `schema:<rel-path>` 或 `schema:<name>` | `schema:openapi.yaml` / `schema:LoginRequest` |
| `resource` | `resource:<rel-path>` | `resource:main.tf` |
| `domain` | `domain:<kebab-name>` | `domain:billing` |
| `flow` | `flow:<kebab-name>` | `flow:user-login` |
| `step` | `step:<flow>:<order>` | `step:user-login:1` |

### Java/Spring 专用类型 ID

| Type | ID Format | 示例 |
|------|-----------|------|
| `interface` | `interface:<rel-path>:<Name>` | `interface:src/main/java/com/example/UserRepository.java:UserRepository` |
| `annotation` | `annotation:<fqn>` | `annotation:org.springframework.web.bind.annotation.RestController` |
| `enum` | `enum:<rel-path>:<Name>` | `enum:src/main/java/com/example/OrderStatus.java:OrderStatus` |
| `configuration` | `configuration:<rel-path>:<Name>` | `configuration:src/main/java/com/example/SecurityConfig.java:SecurityConfig` |
| `test` | `test:<rel-path>:<Name>` | `test:src/test/java/com/example/UserServiceTest.java:UserServiceTest` |
| `entity` | `entity:<rel-path>:<Name>` | `entity:src/main/java/com/example/User.java:User` |
| `mapper` | `mapper:<rel-path>:<Name>` | `mapper:src/main/java/com/example/UserMapper.java:UserMapper` |
| `message_consumer` | `message_consumer:<rel-path>:<method>` | `message_consumer:src/main/java/com/example/OrderListener.java:onOrderCreated` |
| `message_producer` | `message_producer:<rel-path>:<method>` | `message_producer:src/main/java/com/example/OrderService.java:publishOrder` |
| `cache_config` | `cache_config:<rel-path>:<Name>` | `cache_config:src/main/java/com/example/CacheConfig.java:CacheConfig` |
| `security_filter` | `security_filter:<rel-path>:<Name>` | `security_filter:src/main/java/com/example/JwtFilter.java:JwtAuthenticationFilter` |
| `discovery_client` | `discovery_client:<rel-path>:<Name>` | `discovery_client:src/main/java/com/example/UserClient.java:UserClient` |
| `grpc_service` | `grpc_service:<rel-path>:<Name>` | `grpc_service:src/main/java/com/example/GreeterImpl.java:GreeterGrpcImpl` |

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

## 6. Java/Spring 专属字段

以下字段仅对 Java/Spring 生态的节点有意义。非 Java 项目的节点可省略这些字段。

### 节点级字段

| 字段 | 类型 | 适用节点类型 | 说明 |
|------|------|-------------|------|
| `annotations` | `string[]` | 所有代码节点 | 注解列表，如 `["@RestController", "@RequestMapping(\"/api/users\")"]` |
| `java_package` | `string` | class/interface/enum/entity/configuration/mapper | 全限定包名，如 `com.example.service` |
| `java_generics` | `string[]` | class/interface/function | 泛型参数，如 `["T", "ID"]` |
| `http_mappings` | `object[]` | class/function (endpoint) | HTTP 映射 `{method:"GET", path:"/api/users/{id}", params:[{name:"id", source:"PathVariable"}]}` |
| `jpa_table` | `string` | entity | 数据库表名 `@Table(name="t_user")` |
| `jpa_columns` | `object[]` | entity 字段 | `{name:"user_name", type:"VARCHAR", nullable:false, length:50}` |
| `spring_scope` | `string` | configuration/service | Bean 作用域 `singleton`/`prototype`/`request`/`session` |
| `spring_profile` | `string[]` | 所有代码节点 | 关联的 Spring Profile `["dev", "prod"]` |
| `mybatis_result_map` | `string` | mapper | resultMap 引用 ID |
| `sql_query` | `string` | mapper 方法 | SQL 语句（`@Select`, `@Insert` 等值） |
| `maven_module` | `object` | module | `{groupId:"com.example", artifactId:"user-service", packaging:"jar"}` |
| `parent_pom` | `object` | config (pom.xml) | `{groupId:"com.example", artifactId:"parent", version:"1.0"}` |
| `security_rules` | `object[]` | security_filter | `{pattern:"/api/**", methods:["GET","POST"], roles:["ADMIN"]}` |
| `cache_keys` | `string[]` | function/class (cache_config) | 缓存 key 表达式 `["user::{id}", "users::all"]` |
| `grpc_method` | `object` | grpc_service | `{service:"Greeter", method:"SayHello", type:"unary"}` |
| `message_binding` | `object` | message_consumer/producer | `{destination:"order.created", group:"order-service", type:"queue"}` |

### attributes 内的 Java 字段

以下字段嵌套在 `attributes` 对象内：

| 字段 | 适用 | 说明 |
|------|------|------|
| `is_static` | function | 是否静态方法 |
| `is_final` | function/class | 是否 final |
| `is_abstract` | function/class | 是否 abstract |
| `annotations` | function/class/field | 注解数组 |
| `return_type` | function | 返回类型 |
| `visibility` | function/class/field | `public`/`private`/`protected`/`package-private` |
| `fields` | class/interface | 字段列表 `[{name, type, visibility, annotations}]` |
| `implements` | class | 实现的接口列表 |
| `extends` | class | 继承的父类 |
| `java_package` | class/interface/enum | 包名 |
| `java_generics` | class/interface | 泛型参数 |
| `http_method` | function | HTTP 方法（GET/POST/PUT/DELETE/PATCH） |
| `http_path` | function | HTTP 路径 |
| `jpa_table` | class | JPA 表名 |
| `jpa_columns` | 字段级 | JPA 列映射 |

## 7. 合并归一规则

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

### Java 注解归一

| LLM 可能输出 | 归一为 |
|--------------|--------|
| `@RestController` | `annotation:org.springframework.web.bind.annotation.RestController` |
| `@Service` | `annotation:org.springframework.stereotype.Service` |
| 简写 `@RestController` | 全限定名（优先）或简写（如果无法确定包名） |

# MiniOS 详设文档

## 1. 文档目标

本文档定义 MiniOS 的详细技术设计，用于指导后续实现、评审、测试与部署。MiniOS 的定位是基于 `pi-mono` 开发的企业级 AI Agent 执行平台，支持容器化部署、多 Agent、MQTT 消息交互、Redis 会话、文件型 Memory、QMD 检索、S3 兼容对象存储传输、可控工具调用链路，以及集群化运行。

本文档覆盖以下内容：

- 系统目标与非目标
- 总体架构与组件职责
- 集群调度与会话执行模型
- Agent/Template/Skill 数据模型
- MQTT/OSS/Redis 协议与存储设计
- Session/Memory/QMD 机制
- 工具白名单、参数注入与安全隔离
- CLI、运维命令、监控、日志与审计
- 部署、可靠性与后续演进方向

## 2. 设计目标

### 2.1 功能目标

MiniOS 需要满足以下功能目标：

1. 使用 TypeScript 开发。
2. 基于 `pi-mono` SDK 集成 Agent 能力，而非简单包裹外部 CLI。
3. 仅通过 MQTT 提供对外交互消息通道。
4. 入站消息至少包含 `sessionId`、`threadId`、`text`，允许扩展附加字段。
5. 出站消息至少包含 `sessionId`、`threadId`、`text`、`kind`，其中 `kind` 为 `final`、`block`、`thinking`、`tool`。
6. 支持多 Agent，按 topic 路由到不同 Agent。
7. Session 存储在 Redis。
8. Memory 存储在文件系统，通过 Tobi 的 QMD 进行索引与检索。
9. 支持 S3 标准接口对象存储，用于文件传输。
10. 支持命令、文件路径、网络访问三级白名单，并支持命令参数注入。
11. 提供 Agent CLI，支持 `list`、`add`、`delete`、`info`、`restore`、`restart`、`doctor`、`logs`。
12. 提供 Skill CLI，支持 `list`、`install`、`uninstall`，支持全局安装和按 Agent 安装。
13. 支持 Prometheus 监控与 ELK 日志分析。
14. 最终交付 Ubuntu 26 基础 Docker 镜像。
15. 支持集群化部署，一个 Gateway，多个 Worker。

### 2.2 约束

1. `threadId` 由业务应用决定，MiniOS 不参与分支创建或管理，只把其作为会话分支键。
2. `agentId` 由 MQTT topic 决定，一个 Agent 视为一个租户。
3. 不采用“一 Agent 一容器”部署模式，Worker 需要承载多个 Agent。
4. 不要求兼容 OpenClaw 的配置格式，但运行能力需要覆盖其在企业级 AI 工作台场景中的主要执行器职责。
5. 模型接入仅收敛到：
   - OpenAI 兼容接口：`openai-completions`
   - OpenAI 兼容接口：`openai-responses`
   - Anthropic 兼容接口：`anthropic-messages`

### 2.3 非目标

以下内容不作为第一阶段目标：

1. 不实现 Web Chat UI。
2. 不实现 OpenClaw 二进制兼容或配置兼容。
3. 不实现业务侧会话分支控制。
4. 不在同一应用容器内内嵌 Redis、MQTT Broker、对象存储。
5. 不在第一阶段支持任意远程 Skill 仓库市场。

## 3. 总体架构

### 3.1 逻辑架构

```text
MQTT Broker
   |
   v
Gateway
  |- Topic Binding
  |- Inbound Validation
  |- Worker Routing
  |- Control Plane
  |- Health / Metrics / Admin API
   |
   +--> Redis
   +--> Object Storage (S3 / MinIO)
   +--> Config / Registry
   |
   v
Workers (N)
  |- Agent Runtime Pool
  |- Session Executor
  |- Session Cache
  |- Memory Service
  |- QMD Index/Search
  |- Tool Policy Engine
  |- Safe Tool Executor
  |- Audit Emitter
```

### 3.2 部署架构

建议采用以下部署形态：

- `minios-gateway`
  - 负责 MQTT 连接、消息校验、路由、控制命令、管理接口、指标暴露。
- `minios-worker`
  - 多实例部署，负责具体 Agent 会话执行。
- 外部依赖
  - Redis
  - MQTT Broker
  - S3 兼容对象存储
  - 可选配置中心

### 3.3 架构原则

1. 控制面与执行面分离。
2. Gateway 无状态或弱状态，支持水平扩展。
3. Worker 尽量无状态，但允许使用本地缓存提升性能。
4. Redis 为 Session 真相源。
5. 文件系统为 Memory 真相源。
6. 所有跨组件消息与日志都必须带 `traceId`。
7. Agent 间通过目录、命名空间、策略和调度实现硬性隔离。

## 4. 组件设计

### 4.1 Gateway

Gateway 负责接入、治理与调度，不直接运行 Agent 推理主循环。

职责：

1. 建立 MQTT 连接并订阅 Agent 业务 topic 与控制 topic。
2. 根据 topic 解析 `agentId`。
3. 校验入站 payload。
4. 生成或透传 `traceId`、`messageId`。
5. 基于路由策略将消息分配给 Worker。
6. 管理 Worker 注册、心跳、负载信息。
7. 维护会话粘性映射。
8. 提供管理接口、健康检查、指标接口。
9. 处理控制命令，如 `restart`、`doctor`、`logs`。
10. 在 Worker 不可用时进行重试、摘流或进入死信队列。

### 4.2 Worker

Worker 负责具体执行 Agent 会话与工具调用。

职责：

1. 管理多个 Agent 的运行时上下文。
2. 按 `(agentId, sessionId, threadId)` 执行会话。
3. 从 Redis 回放 Session 事件。
4. 为当前 Agent 绑定独立 workspace、skills、memory 和 policy。
5. 基于 `pi-mono` SDK 创建和驱动 `AgentSession`。
6. 将运行事件转为规范化平台事件并写回 Redis。
7. 将用户可见事件回推给 Gateway，再由 Gateway 发布到 MQTT。
8. 调用 QMD 执行 memory 检索。
9. 管理对象存储文件下载和上传。
10. 拦截并执行受控工具调用。

### 4.3 Redis

Redis 用于：

1. Session 元数据与事件存储。
2. 会话锁与幂等去重。
3. Worker 注册表与心跳。
4. 路由粘性状态。
5. 轻量任务队列或控制信号。

### 4.4 Object Storage

对象存储用于：

1. 业务系统向 Agent 传递附件。
2. Agent 产出文件、报告、日志快照。
3. `doctor` 导出诊断包。
4. 会话相关的大体积工件归档。

### 4.5 本地文件系统

本地文件系统用于：

1. Agent workspace。
2. Memory 文件。
3. QMD 索引目录。
4. 模板与 Skills。
5. 临时附件下载目录。
6. 运行态缓存与诊断文件。

## 5. 进程与调度模型

### 5.1 Worker 注册

每个 Worker 启动后向 Gateway 注册，并周期性上报心跳。注册信息至少包括：

- `workerId`
- `version`
- `hostname`
- `startedAt`
- `capacity`
- `currentSessions`
- `currentAgents`
- `cpuLoad`
- `memoryLoad`
- `status`

Redis 示例键：

- `worker:registry:{workerId}`
- `worker:heartbeat:{workerId}`

### 5.2 会话粘性

同一 `(agentId, sessionId, threadId)` 应优先路由到同一 Worker，以减少：

- Redis 全量回放开销
- QMD 热缓存丢失
- 文件下载与工具上下文重复初始化

Redis 粘性映射示例：

- `route:sticky:{agentId}:{sessionId}:{threadId} -> workerId`

### 5.3 路由策略

Gateway 路由顺序：

1. 查询粘性映射。
2. 粘性 Worker 健康则直发。
3. 若粘性 Worker 不可用，则选择同 Agent 负载最低 Worker。
4. 写入新的粘性映射。

### 5.4 并发控制

同一 `(agentId, sessionId, threadId)` 同时只允许一个活跃执行。

Redis 锁键示例：

- `lock:session:{agentId}:{sessionId}:{threadId}`

锁需要：

1. 设置 TTL。
2. 带 fencing token。
3. Worker 心跳续租。
4. 异常退出自动释放或超时回收。

### 5.5 背压与队列

系统需要支持多级背压：

1. Agent 级并发上限
2. Worker 级并发上限
3. 全局入站速率限制

推荐队列模型：

- Gateway 维护轻量调度队列
- Worker 维护本地执行队列
- 超限消息可选：
  - 拒绝并返回 `block`
  - 延迟执行
  - 写入死信队列

## 6. Agent 隔离设计

### 6.1 隔离维度

每个 Agent 需要在以下维度隔离：

1. Workspace
2. Session 命名空间
3. Memory 文件
4. QMD 索引
5. Skill 目录
6. 模型配置与密钥
7. 工具执行策略
8. 附件对象存储前缀
9. 资源配额

### 6.2 目录结构

建议目录结构如下：

```text
/data/platform/
  config/
    gateway.json
    workers.json
  templates/
    <templateId>/
      manifest.json
      AGENTS.md
      SOUL.md
      USER.md
  skills/
    global/
      <skillId>/
        SKILL.md

/data/agents/
  <agentId>/
    manifest.json
    workspace/
      AGENTS.md
      SOUL.md
      USER.md
      MEMORY.md
      memory/
      sessions/
      inbox/
      outbox/
      tmp/
    state/
    qmd/
    skills/
```

### 6.3 共享 Worker 下的强隔离措施

由于不采用“一 Agent 一容器”，需要补充以下隔离措施：

1. 所有工具调用在独立子进程中执行。
2. 执行前绑定 Agent 专属工作目录。
3. 文件访问先做 realpath 校验。
4. 网络访问必须经过策略层与可选 egress 限制。
5. 单 Agent 配额与并发独立。
6. 单 Agent 异常不影响其他 Agent 调度。

## 7. Agent Runtime 设计

### 7.1 集成方式

MiniOS 直接集成 `@mariozechner/pi-coding-agent` SDK。

原因：

1. 更易接入自定义 Session 存储与事件回放。
2. 更易拦截 Tool 调用。
3. 更易插入 Memory、Skill、Template、Provider 配置。
4. 避免外部子进程协议耦合。

### 7.2 Runtime 组成

每个 Agent Runtime 包含：

1. `AgentContext`
2. `SessionExecutor`
3. `MemoryService`
4. `QmdAdapter`
5. `ToolPolicyEngine`
6. `ToolExecutor`
7. `OssTransferService`
8. `AuditEmitter`

### 7.3 AgentContext

`AgentContext` 是 Worker 内部缓存对象，保存：

- `agentId`
- Agent manifest
- 模型配置
- Skill 列表
- Template 元数据
- Policy 配置
- 目录路径
- QMD 句柄或封装器

### 7.4 会话启动流程

Worker 处理入站消息流程：

1. 解析 `agentId`、`sessionId`、`threadId`
2. 获取会话锁
3. 加载 `AgentContext`
4. 下载附件到 `workspace/inbox/`
5. 从 Redis 读取 Session 元数据和事件流
6. 构造 `AgentSession`
7. 注入 Agent 模板文件与 Skills
8. 执行 Memory 检索
9. 调用 `session.prompt()`
10. 监听运行事件并增量写回 Redis
11. 将用户可见事件发回 Gateway
12. 释放锁

## 8. Session 设计

### 8.1 Session 语义

MiniOS 中会话主键定义为：

- `agentId`
- `sessionId`
- `threadId`

语义如下：

- `sessionId` 代表业务层定义的会话树根标识
- `threadId` 代表业务层定义的某个分支
- MiniOS 不负责生成或 fork 分支
- MiniOS 仅对每个 `(sessionId, threadId)` 维护线性执行上下文

### 8.2 Session 事件模型

Redis 中存储规范化事件，而不是直接依赖 `pi` 默认 JSONL 文件格式。

事件类型建议包括：

- `user_message`
- `assistant_text_delta`
- `assistant_message_final`
- `assistant_thinking`
- `tool_call`
- `tool_result`
- `tool_block`
- `system_note`
- `session_summary`
- `error`

### 8.3 Redis Key 设计

建议键设计如下：

- `agent:{agentId}:session:{sessionId}:thread:{threadId}:meta`
- `agent:{agentId}:session:{sessionId}:thread:{threadId}:events`
- `agent:{agentId}:session:{sessionId}:thread:{threadId}:snapshot`
- `agent:{agentId}:session:{sessionId}:thread:{threadId}:dedupe`
- `agent:{agentId}:session:{sessionId}:thread:{threadId}:lock`

`meta` 示例字段：

- `agentId`
- `sessionId`
- `threadId`
- `status`
- `messageCount`
- `lastMessageAt`
- `lastWorkerId`
- `summary`
- `modelId`
- `thinkingLevel`
- `createdAt`
- `updatedAt`

### 8.4 Snapshot 机制

为避免长对话全量回放，系统需要支持快照。

快照触发条件建议：

1. 事件数超过阈值
2. Token 数超过阈值
3. 会话空闲后异步压缩

快照内容包括：

- 结构化消息列表
- 当前模型与思考级别
- 会话摘要
- 最近 Memory 命中摘要

### 8.5 幂等与去重

MQTT 可能重复投递，入站消息需带 `messageId`。

Redis 去重键示例：

- `dedupe:message:{agentId}:{sessionId}:{threadId}:{messageId}`

处理策略：

1. 首次处理写入去重键。
2. 重复消息直接返回最近结果或忽略。
3. 去重键设置合理 TTL。

## 9. Memory 与 QMD 设计

### 9.1 Memory 分层

每个 Agent 的 Memory 采用文件层次化设计：

1. `MEMORY.md`
   - 长期稳定事实
   - 偏好
   - 系统约束
   - 持久规则
2. `memory/*.md`
   - 日常记忆
   - 操作观察
   - 临时归纳
3. `sessions/*.md`
   - 导出的历史会话摘要或清洗记录

### 9.2 QMD 目录

每个 Agent 独立 QMD 根目录：

- `/data/agents/{agentId}/qmd`

QMD 索引源默认包括：

- `workspace/MEMORY.md`
- `workspace/memory/**/*.md`
- `workspace/sessions/**/*.md`

### 9.3 检索流程

检索流程建议：

1. 从用户输入构造检索 query。
2. 调用 QMD 检索 top-k 文档片段。
3. 合并为简洁上下文。
4. 注入本轮 prompt。

返回内容建议包含：

- `sourcePath`
- `title`
- `snippet`
- `score`

### 9.4 索引刷新

索引刷新策略：

1. Memory 文件变更后 debounce 刷新。
2. 会话结束后异步导出 `sessions/*.md` 并刷新。
3. Worker 启动时检查 QMD 索引完整性。
4. `doctor` 命令可触发重建索引。

### 9.5 Memory 写入策略

Memory 写入不建议由模型直接任意覆盖文件，应通过受控工具执行：

- `memory_append`
- `memory_update`
- `memory_note`

约束：

1. 只允许写入 Agent 自己的 Memory 根。
2. 所有写入行为记录审计日志。
3. 重要长期记忆建议先写临时区，再异步整理到 `MEMORY.md`。

## 10. MQTT 协议设计

### 10.1 Topic 设计

建议 topic 结构：

- 业务入站：`agents/{agentId}/in`
- 业务出站：`agents/{agentId}/out`
- 控制入站：`agents/{agentId}/control/in`
- 控制出站：`agents/{agentId}/control/out`

说明：

1. `agentId` 只从 topic 中解析，不信任 payload 中的同名字段。
2. Gateway 可配置 alias 或 binding，将多个 topic 映射到同一 Agent。

### 10.2 业务入站协议

示例：

```json
{
  "messageId": "msg-001",
  "sessionId": "sess-001",
  "threadId": "thread-main",
  "text": "帮我分析这份附件",
  "attachments": [
    {
      "bucket": "agents-in",
      "key": "agent-a/sess-001/thread-main/msg-001/input.csv",
      "name": "input.csv",
      "mediaType": "text/csv",
      "size": 10023,
      "sha256": "..."
    }
  ],
  "traceId": "trace-001",
  "metadata": {
    "sourceApp": "ai-workstation"
  }
}
```

字段要求：

- `messageId`：必填，幂等去重键
- `sessionId`：必填
- `threadId`：必填
- `text`：必填，可为空字符串但不建议
- `attachments`：可选
- `traceId`：可选，缺失时由 Gateway 生成
- `metadata`：可选扩展字段

### 10.3 业务出站协议

示例：

```json
{
  "messageId": "msg-out-001",
  "sessionId": "sess-001",
  "threadId": "thread-main",
  "text": "正在读取附件并分析",
  "kind": "tool",
  "traceId": "trace-001",
  "turnId": "turn-004",
  "attachments": []
}
```

`kind` 取值：

- `thinking`
- `tool`
- `block`
- `final`

### 10.4 控制协议

控制消息示例：

```json
{
  "command": "doctor",
  "requestId": "ctl-001",
  "traceId": "trace-ctl-001",
  "args": {
    "rebuildQmd": false
  }
}
```

支持命令：

- `restart`
- `doctor`
- `logs`

控制出站建议格式：

```json
{
  "requestId": "ctl-001",
  "success": true,
  "traceId": "trace-ctl-001",
  "data": {}
}
```

## 11. OSS 附件协议设计

### 11.1 传输原则

1. 大文件不通过 MQTT 直接传输。
2. 业务系统先上传对象存储，再通过 MQTT 发送对象引用。
3. Worker 下载后放入 Agent 专属 `inbox/`。
4. Agent 产出文件上传到 `agents-out`，再通过 MQTT 返回对象引用。

### 11.2 推荐对象路径

入站：

- `agents-in/{agentId}/{sessionId}/{threadId}/{messageId}/{filename}`

出站：

- `agents-out/{agentId}/{sessionId}/{threadId}/{turnId}/{filename}`

### 11.3 附件生命周期

1. 上游上传附件
2. 发送 MQTT 入站消息
3. Worker 下载并校验附件
4. Agent 使用附件
5. 可选上传产出文件
6. 按策略清理本地临时文件

### 11.4 附件安全检查

下载后需执行：

1. Bucket/prefix 校验
2. 大小限制校验
3. MIME 类型校验
4. SHA256 校验
5. 可选恶意文件扫描

## 12. Template 设计

### 12.1 Template 结构

每个 Template 目录：

```text
templates/<templateId>/
  manifest.json
  AGENTS.md
  SOUL.md
  USER.md
```

`manifest.json` 建议字段：

- `id`
- `name`
- `description`
- `version`
- `defaultModel`
- `defaultSkills`
- `defaultPolicy`

### 12.2 创建 Agent

创建 Agent 时：

1. 创建 Agent 目录
2. 复制模板中的 `AGENTS.md`、`SOUL.md`、`USER.md`
3. 初始化 `MEMORY.md`
4. 初始化 `memory/`、`sessions/`、`skills/`、`qmd/`、`state/`
5. 写入 Agent manifest

### 12.3 Restore 语义

`restore` 操作只覆盖：

- `AGENTS.md`
- `SOUL.md`
- `USER.md`

不覆盖：

- `MEMORY.md`
- `memory/`
- `sessions/`
- `skills/`
- `state/`

## 13. Skill 机制设计

### 13.1 技能来源

Skills 支持两类来源：

1. 全局 Skills
2. Agent 本地 Skills

### 13.2 技能目录

全局：

- `/data/platform/skills/global/{skillId}/`

Agent 本地：

- `/data/agents/{agentId}/skills/{skillId}/`

### 13.3 加载优先级

建议优先级：

1. Agent 本地 Skill
2. 全局 Skill
3. 模板默认 Skill

### 13.4 Skill 安装约束

安装时需要校验：

1. 是否包含 `SKILL.md`
2. Skill 名称是否合法
3. 是否与现有 Skill 冲突
4. 是否引用不允许的执行脚本或路径

## 14. CLI 设计

### 14.1 Agent CLI

支持：

- `minios agents list`
- `minios agents add --id <agentId> --template <templateId>`
- `minios agents delete --id <agentId>`
- `minios agents info --id <agentId>`
- `minios agents restore --id <agentId>`
- `minios agents restart --id <agentId>`
- `minios agents doctor --id <agentId>`
- `minios agents logs --id <agentId>`

### 14.2 Skill CLI

支持：

- `minios skills list`
- `minios skills install <path> -g`
- `minios skills install <path> -a <agentId>`
- `minios skills uninstall <skillId> -g`
- `minios skills uninstall <skillId> -a <agentId>`

### 14.3 CLI 实现原则

1. CLI 操作应直接读写本地 registry 或调用 Gateway 管理接口。
2. 只读命令尽量本地完成。
3. `restart`、`doctor`、`logs` 需要通过控制面下发到运行中的 Worker。

## 15. 模型与 Provider 设计

### 15.1 支持范围

MiniOS 仅支持以下 API 类型：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`

### 15.2 Provider 配置

建议 Provider 配置包含：

- `id`
- `api`
- `baseUrl`
- `apiKey`
- `headers`
- `models`
- `compat`

### 15.3 Agent 模型策略

每个 Agent 可配置：

- `primaryModel`
- `fallbackModels`
- `thinkingLevel`
- `maxInputTokens`
- `maxOutputTokens`

### 15.4 模型治理

企业场景建议支持：

1. 按 Agent 限制可用模型集合
2. Provider 熔断与自动回退
3. 请求级 trace 与 token 统计
4. 成本统计

## 16. 工具调用链路设计

### 16.1 基本原则

平台不直接暴露不受控 shell，而是提供受控工具执行层。

目标：

1. 对命令执行做白名单控制
2. 对文件访问做路径白名单控制
3. 对网络访问做目标白名单控制
4. 对特定命令注入 `--sessionId` 与 `--threadId`
5. 所有执行过程可审计

### 16.2 白名单维度

工具策略分为三层：

1. 命令白名单
2. 路径白名单
3. 网络白名单

### 16.3 策略 DSL

建议 Agent policy 示例：

```json
{
  "tools": {
    "bash": {
      "defaultAction": "block",
      "commands": [
        {
          "id": "mytool-run",
          "match": ["mytool"],
          "allowArgs": true,
          "inject": [
            "--sessionId",
            "${sessionId}",
            "--threadId",
            "${threadId}"
          ]
        },
        {
          "id": "opsctl-run",
          "match": ["opsctl", "run"],
          "allowArgs": true,
          "inject": [
            "--sessionId",
            "${sessionId}",
            "--threadId",
            "${threadId}"
          ]
        }
      ],
      "paths": {
        "read": [
          "/data/agents/${agentId}/workspace",
          "/data/shared/readonly"
        ],
        "write": [
          "/data/agents/${agentId}/workspace",
          "/tmp/minios/${agentId}"
        ]
      },
      "network": [
        {
          "host": "10.0.0.10",
          "ports": [443]
        },
        {
          "cidr": "10.10.0.0/16",
          "ports": [80, 443]
        }
      ]
    }
  }
}
```

### 16.4 参数注入

只有命中白名单规则的命令，才允许注入：

- `--sessionId <sessionId>`
- `--threadId <threadId>`

默认策略：

1. 未命中白名单命令直接阻断
2. 命中命令但路径违规阻断
3. 命中命令但网络目标违规阻断

### 16.5 工具执行事件

每次工具执行记录：

- `agentId`
- `sessionId`
- `threadId`
- `traceId`
- `toolName`
- `ruleId`
- `originalCommand`
- `rewrittenCommand`
- `paths`
- `networkTargets`
- `startedAt`
- `endedAt`
- `status`
- `exitCode`

## 17. 安全设计

### 17.1 鉴权

第一阶段可先聚焦机器到机器鉴权：

1. MQTT 用户名密码或证书鉴权
2. S3 访问密钥鉴权
3. Gateway/Worker 内部接口使用 mTLS 或私有网络

### 17.2 Secrets 管理

密钥不得长期明文放置在 Agent 工作目录。推荐来源：

1. 环境变量
2. Secret 文件挂载
3. 后续扩展 Vault/KMS

### 17.3 数据安全

建议支持：

1. Redis TLS
2. MQTT TLS
3. S3 TLS
4. 本地敏感文件权限控制
5. 可选 Memory 文件加密

### 17.4 DLP 与脱敏

企业场景建议在以下环节预留脱敏钩子：

1. 出站 MQTT 消息
2. 工具输出
3. Memory 写入
4. 运行日志

## 18. 监控、日志与审计

### 18.1 健康检查

Gateway 和 Worker 提供：

- `/healthz`
- `/readyz`

### 18.2 Prometheus 指标

建议至少暴露：

- `mqtt_inbound_messages_total`
- `mqtt_outbound_messages_total`
- `worker_registered_total`
- `worker_active_sessions`
- `agent_active_sessions`
- `agent_prompt_latency_seconds`
- `tool_calls_total`
- `tool_blocks_total`
- `tool_call_latency_seconds`
- `redis_operation_latency_seconds`
- `qmd_search_latency_seconds`
- `oss_transfer_total`
- `oss_transfer_bytes_total`
- `llm_tokens_total`
- `llm_cost_total`

### 18.3 结构化日志

日志使用 JSON 输出，字段至少包括：

- `timestamp`
- `level`
- `service`
- `workerId`
- `agentId`
- `sessionId`
- `threadId`
- `traceId`
- `turnId`
- `messageId`
- `toolName`
- `ruleId`
- `modelId`
- `latencyMs`
- `outcome`

### 18.4 审计日志

审计日志需要覆盖：

1. Agent 新增、删除、恢复
2. Template 变更
3. Skill 安装、卸载
4. Policy 变更
5. 工具执行与阻断
6. 诊断命令与重启命令
7. Memory 持久写入

## 19. 运维命令设计

### 19.1 restart

用途：

- 重启指定 Agent 的运行上下文
- 或重启承载该 Agent 的 Worker 中该 Agent 的本地缓存与活动会话

推荐行为：

1. 先摘除该 Agent 新流量
2. 等待执行中会话结束或超时中断
3. 清理本地缓存
4. 重建 AgentContext

### 19.2 doctor

诊断项建议包括：

1. Redis 连通性
2. MQTT 连通性
3. S3 连通性与读写
4. QMD 可执行与索引状态
5. Agent workspace 权限
6. 模型 Provider 连通性
7. Tool policy 可编译性
8. 最近错误摘要

### 19.3 logs

支持过滤：

- `agentId`
- `sessionId`
- `threadId`
- `traceId`
- `level`
- `tail`

输出：

1. CLI 直接读取日志后端或聚合接口
2. MQTT 控制面可返回简化结果或对象存储中的日志归档链接

## 20. 配额与限流

企业环境建议为每个 Agent 配置资源配额：

- 最大并发会话数
- 每分钟最大消息数
- 单条消息最大附件数
- 单附件最大大小
- 每日 token 上限
- 每日成本上限
- Memory 总容量上限
- QMD 索引容量上限

限流超限后的处理方式：

1. 立即阻断并返回 `block`
2. 进入排队
3. 触发告警

## 21. 可靠性设计

### 21.1 重试

不同依赖使用不同重试策略：

1. Redis：短时快速重试
2. MQTT：连接级自动重连
3. S3：指数退避重试
4. LLM：按 Provider 错误类型区分重试与回退
5. QMD：失败时降级到简单检索

### 21.2 死信队列

以下消息进入死信：

1. payload 非法
2. 路由失败
3. 多次重试后仍执行失败
4. 长时间超过排队窗口

建议 DLQ topic：

- `agents/{agentId}/dlq`

### 21.3 崩溃恢复

Worker 异常退出后：

1. 锁依赖 TTL 自动释放
2. Gateway 感知心跳丢失后重路由
3. 新 Worker 从 Redis 恢复 Session

## 22. Docker 与部署设计

### 22.1 镜像

统一镜像基于：

- `ubuntu:26.04`

镜像内包含：

1. Node.js LTS
2. MiniOS 编译产物
3. QMD 所需运行时
4. 最小 init 进程

### 22.2 运行模式

同一镜像支持：

- `gateway`
- `worker`
- `cli`

示例：

```bash
minios gateway
minios worker
minios agents list
```

### 22.3 挂载建议

容器挂载：

- `/data/platform`
- `/data/agents`
- `/tmp/minios`

## 23. 配置设计

建议配置分层：

1. 平台配置
2. Worker 配置
3. Agent manifest
4. Template manifest
5. Tool policy

### 23.1 平台配置建议字段

- MQTT 连接信息
- Redis 连接信息
- S3 连接信息
- 监听端口
- 指标配置
- 日志配置
- 默认超时
- 路由策略

### 23.2 Agent manifest 建议字段

- `id`
- `name`
- `templateId`
- `enabled`
- `workspace`
- `model`
- `provider`
- `policy`
- `skills`
- `quotas`
- `memory`
- `routing`

## 24. 后续扩展建议

第一阶段完成后，建议规划以下增强能力：

1. 管理 API 与管理控制台
2. RBAC
3. SSO/OIDC/SAML
4. 审批流
5. Secret Manager 集成
6. DLP 引擎
7. Webhook 事件推送
8. 多环境发布链路
9. 变更版本与回滚
10. 成本中心与计费对账

## 25. 实施建议

建议分阶段实现：

### 阶段一

1. Gateway/Worker 基础骨架
2. MQTT 入站与出站
3. Redis Session 持久化
4. 单 Worker 多 Agent 执行
5. 基础日志与指标

### 阶段二

1. Agent/Template/Skill CLI
2. S3 附件传输
3. QMD 检索与 Memory 文件体系
4. 控制命令 `restart/doctor/logs`

### 阶段三

1. 工具白名单 DSL
2. 参数注入
3. 路径与网络白名单校验
4. 审计日志

### 阶段四

1. 会话快照
2. 集群粘性路由
3. 限流、配额、死信队列
4. 模型回退与成本统计

## 26. 风险与关注点

1. 共享 Worker 下的隔离强度不如单 Agent 单容器，需要通过策略与调度补足。
2. 若 Memory 写入策略过松，容易造成知识污染和数据泄漏。
3. QMD 索引刷新频率过高会带来 I/O 与 CPU 压力。
4. MQTT 重复投递与 Worker 崩溃恢复必须尽早做幂等设计。
5. Tool policy 若只做字符串匹配，容易被命令拼接绕过，需要做 argv 级解析和文件/网络语义校验。
6. 长会话如果没有快照与压缩，会造成 Redis 与恢复延迟持续增长。

## 27. 结论

MiniOS 的核心不是“把 pi 接到 MQTT 上”，而是构建一个企业级可控执行平台：

1. 用 Gateway 管理接入、路由与控制面
2. 用 Worker 集群执行多 Agent 会话
3. 用 Redis 保存 Session 真相源
4. 用文件与 QMD 管理 Memory
5. 用 S3 兼容对象存储传递文件
6. 用三层白名单与参数注入控制工具调用
7. 用 Prometheus、ELK 和审计日志满足企业运维要求

该设计可作为后续模块拆分、接口定义、代码实现与测试设计的基线文档。

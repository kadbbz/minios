# MiniOS

MiniOS 是一个面向企业场景的 AI Agent 执行平台，目标是基于 `pi-mono` 构建一套可容器化部署、多 Agent、可控工具调用、可审计、可集群化的 AI 操作系统。

它的核心定位不是单纯“跑一个聊天机器人”，而是作为企业内的 Agent 执行层，负责：

- 接收业务系统发来的任务
- 维护 Agent 会话与分支上下文
- 管理 Agent 的模板、技能、Memory 和工作区
- 调用受控工具执行真实动作
- 通过 MQTT 与上层应用解耦
- 通过对象存储传递文件

当前仓库已经具备核心骨架：

- TypeScript 工程
- Agent / Template 管理
- Skill 管理
- Topic 路由
- Session Redis key 规范
- Tool policy 白名单与参数注入
- 本地文件型 Session Store
- 本地 Worker / Gateway runtime 闭环
- `platform doctor` 平台级依赖检查
- `restart` / `doctor` / `logs` 的本地 CLI 控制面
- Fast smoke test
- Docker image fast test

## 会话机制

MiniOS 的会话机制有一个固定约束，需要调用方严格遵守：

- `sessionId` 和 `threadId` 都由调用方提供
- `sessionId` 是长期会话标识，也是 Memory 隔离边界
- `threadId` 只是会话内部追踪标识

具体语义：

1. 同一个用户在同一个 Agent 下，应持续使用同一个 `sessionId`
2. 不同 `sessionId` 的 Memory 不能混用
3. `threadId` 不影响 Memory
4. 只有显式执行 `reset session` 时，才允许清空或重建某个 `sessionId` 的 Memory

可以这样理解：

- `sessionId` 决定“记住谁的长期上下文”
- `threadId` 决定“这一次调用链路怎么追踪”

当前已经具备“不暴露业务网络接口”的本地最小运行时，可用于开发阶段验证：

- `runtime publish`
- 本地 Worker Session 持久化
- `agents restart|doctor|logs`
- `platform doctor`

但完整 Gateway / Worker / Redis / MQTT / OSS 外部依赖接入仍在持续开发中。因此本文档包含两部分内容：

1. 目标架构与目标部署方式
2. 当前仓库可直接使用的开发、编译和测试方法

## 架构说明

MiniOS 的推荐架构由四类核心组件组成：

- `MiniOS`
- `Redis`
- `MQTT Broker`
- `OSS`

它们的关系如下：

```text
业务系统 / AI 工作台
         |
         | MQTT
         v
   +-------------+
   | MQTT Broker |
   +-------------+
         |
         v
   +-------------+
   |   MiniOS    |
   | Gateway     |
   | Worker(s)   |
   +-------------+
      |    |    |
      |    |    +--> OSS (S3 / MinIO)
      |    |
      |    +-------> Redis
      |
      +-------> LLM Providers
```

### 1. MiniOS

MiniOS 是平台本体，后续会拆成两个运行角色：

- `gateway`
  - 接入 MQTT
  - 按 topic 路由消息到 Agent
  - 管理 Worker
  - 提供健康检查、指标和控制面
- `worker`
  - 承载多个 Agent runtime
  - 执行具体会话
  - 加载模板、技能、Memory
  - 受控执行工具

### 2. Redis

Redis 是 Session 的真相源，负责存储：

- 会话元数据
- 会话事件流
- 幂等去重键
- 分布式锁
- Worker 心跳与注册信息

MiniOS 不把 Session 真相源放在本地文件里，而是以 Redis 为中心，以支持多 Worker 集群。

### 3. MQTT Broker

MQTT Broker 是唯一对外交互通道。

上层应用不直接调用 MiniOS 内部 API，而是通过 MQTT：

- 向某个 Agent 发送入站消息
- 接收该 Agent 的出站消息
- 下发控制命令，如 `restart`、`doctor`、`logs`

推荐 topic：

- `agents/{agentId}/in`
- `agents/{agentId}/out`
- `agents/{agentId}/control/in`
- `agents/{agentId}/control/out`

### 4. OSS

OSS 指 S3 兼容对象存储，例如：

- MinIO
- AWS S3
- 七牛 Kodo
- 其他兼容 S3 接口的对象存储

用途：

- 上层系统上传附件
- MiniOS 下载附件到 Agent 工作区
- Agent 执行后上传产出物
- 大文件不走 MQTT，只走对象引用

### 5. 一个典型工作流

一个典型执行流程如下：

1. 业务系统把文件上传到 OSS
2. 业务系统往 `agents/{agentId}/in` 发 MQTT 消息
3. MiniOS Gateway 收到消息并解析 `agentId`
4. Gateway 将消息路由到某个 Worker
5. Worker 从 Redis 恢复 `(sessionId, threadId)` 上下文
6. Worker 下载 OSS 附件到 Agent 的 `inbox/`
7. Worker 加载模板、Skill、Memory，并驱动 Agent 执行
8. 工具调用经过白名单和参数注入策略检查
9. Agent 产出结果，并将文件上传到 OSS
10. Worker 将 `thinking/tool/block/final` 事件回推到 MQTT

## 部署方案

MiniOS 推荐分离部署：

- MiniOS 自身单独部署
- Redis 单独部署
- MQTT Broker 单独部署
- OSS 单独部署

这样做的原因很直接：

- 更容易扩容
- 更容易隔离故障
- 更容易满足企业的网络与安全要求
- 更适合 DMZ / 内外网分层部署

### 裸机部署

裸机部署适合以下情况：

- 企业已有标准 Linux 服务器
- 需要和现有 Redis / MQTT / MinIO 集群打通
- 希望使用 systemd 管理进程
- 不希望先引入容器编排

#### 1. 准备环境

建议环境：

- Ubuntu 24+ 或 Ubuntu 26
- Node.js 24+
- npm 11+
- Python 3.10+

依赖服务：

- Redis
- MQTT Broker
- S3 兼容对象存储

## 测试

源码级快速测试：

```bash
npm run test:fast
```

当前已验证通过：

- `npm run build`
- `npm run test:fast`

基于已构建 image 的 Docker 测试：

```bash
docker build -f test/docker/Dockerfile.overlay -t minios-gateway:test-current .
npm run test:docker:fast
npm run test:docker:full
```

注意：

- `test:docker:fast` 与 `test:docker:full` 会验证真实 LLM 模板填充链路
- 运行前需要在宿主机环境中设置 `OC_OPENAI_API_KEY`
- 未设置该变量时，Docker 测试会在 `prepare_fixture` 步骤直接失败

只要在 `./data/config/` 下准备好这两个文件：

- `llm.json`
- `env.json`

直接执行 `docker compose up -d` 就能启动。compose 会先自动运行一个内部引导步骤，为第三方容器生成运行工件。

如果你想提前初始化目录，也可以执行 `compose:init`。它会在挂载卷目录 `./data/` 下初始化持久化配置与目录，包括：

- `data/config/llm.json` 作为 LLM 源配置
- `data/config/env.json` 作为运行环境源配置
- `data/gateway/` 下的 Agent root、模板、workspace、session、memory、测试输入输出
- `data/minio/` 下的对象存储数据
- `data/emqx/`、`data/redis/` 下的 broker / redis 持久化数据
- `data/runtime-env/` 下的容器启动工件由 compose 或初始化脚本自动生成，用户一般不需要关心，也不需要手工维护

这样在 `docker restart` 或再次 `docker compose up` 后，不需要重新配置，用户文件也不会丢失。

如果修改了 `data/config/env.json`，直接重新执行：

```bash
docker compose up -d
```

查询模型用量：

```bash
node dist/cli.js usage --start 20260503 --end 20260503
```

Docker 测试会复用当前仓库 `docker-compose.yml` 中的：

- `redis`
- `emqx`
- `minio`

#### 2. 获取代码

```bash
git clone <your-repo-url> minios
cd minios
```

#### 3. 安装依赖

```bash
npm install
```

#### 4. 编译

```bash
npm run build
```

#### 5. 准备运行目录

建议独立数据目录，例如：

```bash
sudo mkdir -p /var/minios/data
sudo chown $USER /var/minios/data -R
```

推荐后续目录结构：

```text
/var/minios/
  data/
    platform/
    agents/
```

#### 6. 准备模板

当前代码中的 Agent 创建依赖模板目录，至少需要：

```text
data/platform/templates/basic/
  manifest.json
  AGENTS.md
  SOUL.md
  USER.md
```

示例：

```bash
mkdir -p /var/minios/data/platform/templates/basic
cat > /var/minios/data/platform/templates/basic/manifest.json <<'EOF'
{
  "id": "basic",
  "name": "Basic Template"
}
EOF

cat > /var/minios/data/platform/templates/basic/AGENTS.md <<'EOF'
# Agents

Base agent instructions.
EOF

cat > /var/minios/data/platform/templates/basic/SOUL.md <<'EOF'
# Soul

Base soul instructions.
EOF

cat > /var/minios/data/platform/templates/basic/USER.md <<'EOF'
# User

Base user instructions.
EOF
```

#### 7. 使用 CLI 初始化 Agent

```bash
node dist/cli.js agents add \
  --root /var/minios \
  --id agent-alpha \
  --template basic
```

查看 Agent：

```bash
node dist/cli.js agents info \
  --root /var/minios \
  --id agent-alpha
```

#### 8. 以 systemd 方式运行

当前仓库还没有完整的 `gateway` / `worker` 可执行进程，因此现阶段还没有现成的 systemd 单元可以直接上线。

后续推荐的裸机进程模型会是：

- `minios gateway`
- `minios worker`

在这些角色落地后，再为其分别配置 systemd 服务：

- `minios-gateway.service`
- `minios-worker.service`

### Docker 部署

Docker 部署是 MiniOS 的主推荐方案。

适合以下情况：

- 希望快速复制环境
- 希望将 Gateway 与 Worker 分别部署
- 希望配合外部 Redis / MQTT / MinIO
- 希望后续接入 Kubernetes

#### 1. 目标部署关系

```text
+-------------------+       +-------------------+
|  minios-gateway   | ----> |   minios-worker   |
+-------------------+       +-------------------+
          |                            |
          +------------+---------------+
                       |
        +--------------+-------------+
        | Redis / MQTT / MinIO / LLM |
        +----------------------------+
```

#### 2. 当前状态说明

当前仓库已经有：

- TypeScript 核心模块
- CLI
- 测试骨架

当前仓库还没有：

- 完整 Dockerfile
- `gateway` / `worker` 运行进程
- 正式的 `docker-compose.yml`

因此，当前可以用 Docker 做“开发容器化构建”，但还不具备完整生产执行器镜像能力。

#### 3. 现阶段开发容器化方案

可以先用一个简单的 Node 容器完成编译和测试：

```bash
docker run --rm -it \
  -v "$PWD":/workspace \
  -w /workspace \
  node:24-bookworm \
  bash -lc "npm install && npm run build && python3 test/fast/run_smoke.py"
```

如果容器内没有 Python，可换成带 Python 的基础镜像，或者在容器里安装 Python。

#### 4. 目标 Docker 方案

后续目标是交付基于 `ubuntu:26.04` 的统一镜像，支持：

- `minios gateway`
- `minios worker`
- `minios agents ...`
- `minios skills ...`

目标镜像内包含：

- Node.js LTS
- MiniOS 编译产物
- QMD 运行时
- 最小 init

#### 5. 目标 docker-compose 思路

后续建议的组合方式是：

- `minios-gateway`
- `minios-worker-1`
- `minios-worker-2`
- 外部或本地 `redis`
- 外部或本地 `mqtt broker`
- 外部或本地 `minio`

如果是开发环境，也可以先用 docker-compose 一起拉起：

- `redis`
- `emqx` 或 `mosquitto`
- `minio`
- `minios gateway`
- `minios worker`

## 如何让 MiniOS 做事

这一部分分成“当前能做的事”和“目标完成态下怎么做事”两部分。

### 当前仓库能做的事

当前仓库还不是完整执行器，但已经可以做这些基础工作：

#### 1. 管理模板和 Agent

创建模板目录后，可以创建和恢复 Agent：

```bash
node dist/cli.js agents add --root /var/minios --id agent-alpha --template basic
node dist/cli.js agents info --root /var/minios --id agent-alpha
node dist/cli.js agents restore --root /var/minios --id agent-alpha
node dist/cli.js agents list --root /var/minios
```

删除 Agent：

```bash
node dist/cli.js agents delete --root /var/minios --id agent-alpha
```

#### 2. 安装 Skill

Skill 目录需要包含 `SKILL.md`。

安装为全局 Skill：

```bash
node dist/cli.js skills install --root /var/minios -g /path/to/sample-skill
```

安装到某个 Agent：

```bash
node dist/cli.js skills install --root /var/minios -a agent-alpha /path/to/sample-skill
```

列出 Skill：

```bash
node dist/cli.js skills list --root /var/minios
node dist/cli.js skills list --root /var/minios --agent agent-alpha
```

卸载 Skill：

```bash
node dist/cli.js skills uninstall --root /var/minios -g sample-skill
node dist/cli.js skills uninstall --root /var/minios -a agent-alpha sample-skill
```

#### 3. 校验策略文件

当前 CLI 提供了一个最基础的策略检查入口：

```bash
node dist/cli.js policy check /path/to/policy.json
```

这一步目前主要用于验证 JSON 能被加载，后续会扩展成完整 policy schema 校验和预编译。

### 目标完成态下如何让 MiniOS 做事

完整执行器接入后，让 MiniOS 做事的方式会是：

#### 1. 为某个 Agent 准备模板、Skill、Policy

每个 Agent 至少需要：

- 模板
- 工作区
- Memory
- Skill
- Tool policy
- 模型配置

#### 2. 通过 MQTT 给 Agent 发消息

示例 topic：

```text
agents/agent-alpha/in
```

示例消息体：

```json
{
  "messageId": "msg-001",
  "sessionId": "sess-001",
  "threadId": "thread-main",
  "text": "请分析附件中的告警信息，并给出处理建议。",
  "attachments": [
    {
      "bucket": "agents-in",
      "key": "agent-alpha/sess-001/thread-main/msg-001/alarm.txt",
      "name": "alarm.txt",
      "mediaType": "text/plain",
      "size": 1024,
      "sha256": "..."
    }
  ],
  "traceId": "trace-001"
}
```

#### 3. Worker 执行 Agent

Worker 会完成：

- 从 Redis 恢复上下文
- 从 OSS 下载附件
- 从 Memory 检索相关信息
- 驱动 Agent 推理
- 按策略调用工具
- 将结果写回 MQTT

#### 4. 接收 Agent 回应

业务系统订阅：

```text
agents/agent-alpha/out
```

MiniOS 会输出以下类型的消息：

- `thinking`
- `tool`
- `block`
- `final`

例如：

```json
{
  "messageId": "msg-out-001",
  "sessionId": "sess-001",
  "threadId": "thread-main",
  "text": "正在读取附件并分析告警上下文",
  "kind": "tool",
  "traceId": "trace-001"
}
```

最终完成时：

```json
{
  "messageId": "msg-out-002",
  "sessionId": "sess-001",
  "threadId": "thread-main",
  "text": "分析完成：告警来自数据库连接池耗尽，建议先扩容连接池并检查慢 SQL。",
  "kind": "final",
  "traceId": "trace-001"
}
```

#### 5. 让 Agent 真正“动手”

MiniOS 的关键能力不是“只回答问题”，而是“在受控条件下执行动作”。

例如：

- 读取工作区文件
- 调用白名单命令
- 访问白名单网络地址
- 写入 Agent Memory
- 上传结果文件到 OSS

但所有动作都必须经过 Tool policy：

- 命令是否在白名单内
- 访问路径是否在允许范围
- 目标 IP / 端口是否在白名单内
- 是否需要注入 `--sessionId` 和 `--threadId`

这就是企业场景里“让 MiniOS 做事”的真正含义：不是放任 LLM 任意执行，而是在你定义的边界内执行。

## 当前仓库的使用方法

### 1. 安装依赖

```bash
npm install
```

### 2. 编译

```bash
npm run build
```

### 3. 运行 fast 测试

```bash
python3 test/fast/run_smoke.py
```

测试输出在：

```text
.tmp/test-{timestamp}/
```

包括：

- `report.txt`
- `summary.json`

### 4. 查看最近一次测试报告

```bash
latest=$(ls -1 .tmp | sort | tail -n 1)
cat .tmp/$latest/report.txt
```

## 项目结构

```text
.
├── README.md
├── dev_guide.md
├── doc/
│   └── design/
│       └── minios-detailed-design.md
├── src/
│   ├── cli.ts
│   ├── index.ts
│   └── core/
│       ├── agent-manager.ts
│       ├── fs-utils.ts
│       ├── session-keys.ts
│       ├── skill-manager.ts
│       ├── tool-policy.ts
│       └── topic-router.ts
├── test/
│   └── fast/
│       ├── README.md
│       └── run_smoke.py
├── package.json
└── tsconfig.json
```

## 进一步阅读

- 开发指南：[dev_guide.md](/Users/ningwei/VSCodeProjects/minios/dev_guide.md)
- 详细设计：[minios-detailed-design.md](/Users/ningwei/VSCodeProjects/minios/doc/design/minios-detailed-design.md)

## 当前状态总结

如果你现在要使用这个仓库，应这样理解：

1. 它已经有平台核心骨架和测试基础
2. 它已经能管理 Agent、Template、Skill，并校验基础策略
3. 它还没有完成完整的 Gateway / Worker 执行器落地
4. 它当前最适合继续做核心功能开发，而不是直接作为生产执行器部署

因此，当前最推荐的日常动作是：

```bash
npm install
npm run build
python3 test/fast/run_smoke.py
```

在此基础上继续推进 Redis、MQTT、OSS、QMD 与 `pi-mono` 的完整集成。

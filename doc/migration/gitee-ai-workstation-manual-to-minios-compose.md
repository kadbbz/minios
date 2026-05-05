# 从 Gitee 方案迁移到 MiniOS Docker Compose

## 1. 目的

本文档说明如何从 `https://gitee.com/low-code-dev-lab/ai-workstation-manual/tree/dev` 对应的执行器方案，迁移到当前仓库里的 MiniOS `docker-compose` 方案。

对标时主要参考上游这些能力面：

- 容器化执行器
- MQTT 消息接入
- MinIO / S3 对象存储传文件
- Redis 作为外部依赖
- `doctor / restart / logs / agents`
- 基于 build 后镜像的 docker 测试

当前结论：

1. MiniOS 已经对齐了 `gateway + redis + emqx + minio` 的 compose 形态。
2. MiniOS 已支持模型 `primary + backups[]` 配置。
3. MiniOS 已把文本和文件消息拆成独立 topic。
4. MiniOS 已实现文件对象从 `agents-in` 下载到 Agent inbox，再把结果上传到 `agents-out` 的闭环。
5. 当前仍未实现真实 MQTT 常驻消费循环和 Redis 崩溃恢复，因此建议先灰度迁移。

## 2. 架构对标

### 2.1 Gitee 方案

参考方案本质上是：

- 单执行器容器
- 容器内带运维脚本
- 业务通过 MQTT 和执行器解耦
- 文件通过 S3 兼容对象存储传递
- 测试直接对 build 完的 image 做验证

### 2.2 当前 MiniOS 方案

当前 `docker-compose.yml` 中的目标拓扑是：

- `gateway`
- `redis`
- `emqx`
- `minio`

当前已落地的执行链路：

- `platform doctor`
- `agents add|info|doctor|logs|restart`
- `runtime publish`
- `agents/text/inbound/{agent-name}`
- `agents/file/inbound/{agent-name}`
- 文件入站对象下载到 workspace inbox
- 结果文件上传到 `agents-out`
- 基于 build 后镜像的 compose fast test

当前还没落地的部分：

- 真实 MQTT 常驻订阅消费
- Redis Session 崩溃恢复
- 集群化 Worker 调度

### 2.3 差异总览

| 维度 | Gitee 方案 | 当前 MiniOS |
| --- | --- | --- |
| 执行内核 | OpenClaw + mqtt-channel | 本地 runtime 骨架，后续接 `pi-mono` |
| 部署形态 | 单执行器容器 | `gateway + redis + emqx + minio` |
| 会话边界 | OpenClaw Session | `(agentId, sessionId, threadId)` |
| 文件传输 | S3 对象引用 | `agents/file/inbound/*` + MinIO 下载/上传 |
| 控制面 | shell 脚本 | Node CLI |
| 回归方式 | image-level docker test | image-level docker compose test |

## 3. 目录和命令映射

### 3.1 路径映射

| Gitee 方案 | MiniOS 当前方案 | 说明 |
| --- | --- | --- |
| `/var/platform_data/env.json` | `config/env.json` | 用户维护的运行环境配置；第三方容器启动工件在初始化时自动派生 |
| `/var/platform_data/config.json` | `config/llm.json` | 用户维护的模型配置；运行时直接读取 |
| `/var/platform_data/.openclaw/workspaces` | `data/agents/<agentId>/workspace` | 每个 Agent 独立工作区 |
| `platform_home/templates/*.template.md` | `data/platform/templates/<templateId>/*.md` | 模板改为平台目录 |
| `platform_home/scripts/doctor.sh` | `node dist/cli.js platform doctor` | Node CLI |
| `platform_home/scripts/restart.sh` | `node dist/cli.js agents restart --root <root> --id <agentId>` | Agent 粒度重启 |
| `platform_home/scripts/logs.sh` | `node dist/cli.js agents logs --root <root> --id <agentId>` | Session 事件日志 |

### 3.2 运维命令映射

| Gitee 方案 | MiniOS 当前命令 |
| --- | --- |
| `doctor` | `node dist/cli.js platform doctor` |
| `restart` | `node dist/cli.js agents restart --root <root> --id <agentId>` |
| `logs` | `node dist/cli.js agents logs --root <root> --id <agentId>` |
| `agents add` | `node dist/cli.js agents add --root <root> --id <agentId> --template <templateId>` |
| `agents info` | `node dist/cli.js agents info --root <root> --id <agentId>` |

## 4. 配置迁移

### 4.1 LLM 配置

Gitee 方案如果原来是单模型选择，迁到 MiniOS 后建议把模型配置收敛到 `llm.json`：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "corp-openai/qwen3.5-plus",
        "backups": []
      }
    }
  }
}
```

约束：

1. `primary` 只能有一个。
2. `backups` 可以为 `[]`，也可以为多个候补模型。
3. `primary` 和 `backups` 都必须引用 `models.providers.*.models` 中真实存在的模型。
4. provider 建议用 `apiKeyEnv` 引用环境变量名。
5. 运行时直接读取 `llm.json`，不再要求额外模型配置文件。

### 4.2 运行环境配置

建议把 MQTT、S3、QMD、Node、MinIO、EMQX 等环境变量统一放进 `env.json`。

`env.json` 推荐分成：

- `gateway`
- `node`
- `minio`
- `emqx`

其中 `gateway` 下可直接承载参考方案里的 MQTT、S3、模型密钥等变量。只有第三方容器需要的启动工件会在初始化时派生到 `runtime-env/`，不作为用户配置暴露。

启动约束：

1. 用户只需要准备 `llm.json` 和 `env.json`
2. `docker compose up -d` 会自动完成内部运行工件引导
3. `docker restart` 或后续再次 `docker compose up -d` 不会丢失 `data/` 下的持久化数据

### 4.3 MQTT 配置

参考方案常见字段：

- `OC_MQTT_CHANNEL_BROKER`
- `OC_MQTT_CHANNEL_USERNAME`
- `OC_MQTT_CHANNEL_PASSWORD`

MiniOS 当前对应字段：

- `MINIOS_MQTT_URL`
- `MINIOS_MQTT_USERNAME`
- `MINIOS_MQTT_PASSWORD`

topic 迁移建议：

- 文本入站：`agents/text/inbound/{agent-name}`
- 文件入站：`agents/file/inbound/{agent-name}`
- 控制入站：`agents/control/inbound/{agent-name}`

说明：

1. 文本和文件不要复用同一个业务 topic。
2. 文件消息只传对象引用，不直接塞二进制内容。

### 4.4 MinIO / S3 配置

参考方案常见字段：

- `S3_ENDPOINT_URL`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_REGION`

MiniOS 当前对应字段：

- `MINIOS_S3_ENDPOINT`
- `MINIOS_S3_ACCESS_KEY`
- `MINIOS_S3_SECRET_KEY`
- `MINIOS_S3_BUCKET_IN`
- `MINIOS_S3_BUCKET_OUT`

compose 默认值：

- endpoint: `http://minio:9000`
- in bucket: `agents-in`
- out bucket: `agents-out`

### 4.5 Agent 模板迁移

参考方案模板路径：

- `platform_home/templates/AGENTS.template.md`
- `platform_home/templates/SOUL.template.md`
- `platform_home/templates/USER.template.md`

MiniOS 当前模板路径：

- `data/platform/templates/<templateId>/AGENTS.md`
- `data/platform/templates/<templateId>/SOUL.md`
- `data/platform/templates/<templateId>/USER.md`
- `data/platform/templates/<templateId>/manifest.json`

## 5. 文件传输迁移

### 5.1 迁移原则

1. 业务系统先把文件上传到 `agents-in`。
2. 再往 `agents/file/inbound/{agent-name}` 发送对象引用消息。
3. Worker 把对象下载到 `data/agents/<agent>/workspace/sessions/<session>/inbox/...`。
4. Worker 产出的结果文件上传到 `agents-out`。
5. final 消息里返回新的对象引用。

### 5.2 推荐对象 key 结构

入站对象建议：

```text
{agentId}/{sessionId}/{threadId}/{messageId}/{filename}
```

出站对象建议：

```text
{agentId}/{sessionId}/{threadId}/{turnId}/{filename}
```

### 5.3 文件消息示例

```json
{
  "messageId": "msg-file-001",
  "sessionId": "sess-001",
  "threadId": "thread-file",
  "text": "请处理这个文件",
  "attachments": [
    {
      "bucket": "agents-in",
      "key": "agent-a/sess-001/thread-file/msg-file-001/input.csv",
      "name": "input.csv",
      "mediaType": "text/csv"
    }
  ],
  "traceId": "trace-file-001"
}
```

## 6. 测试体系迁移

### 6.1 对标原则

参考项目的 docker 测试脚本体现出几个关键点：

1. 测试对象必须是 build 完的 image。
2. 测试先等 compose 服务健康，再测 CLI 和运行链路。
3. 测试要覆盖 `doctor / restart / logs / agents`。
4. 文件链路要验证真实对象下载和上传。

### 6.2 当前 MiniOS 的测试做法

当前新增的脚本是：

- `test/docker/compose_image_fast_test.py`
- `test/docker/Dockerfile.overlay`

执行方式：

```bash
docker build -f test/docker/Dockerfile.overlay -t minios-gateway:test-current .
python3 test/docker/compose_image_fast_test.py --image minios-gateway:test-current
```

该测试会直接复用 `docker-compose.yml` 里的：

- `redis`
- `emqx`
- `minio`

当前已覆盖：

1. compose 依赖启动
2. built image 启动
3. `healthz`
4. `platform doctor`
5. 配置校验，包括模型 `primary + backups[]`
6. 镜像内 `agents add`
7. 文本消息发布
8. 文件消息发布
9. MinIO 入站对象下载到 inbox
10. 结果文件上传到 `agents-out`
11. 镜像内 `agents logs|restart`

## 7. 推荐迁移步骤

### 阶段一：迁基础设施

1. 准备 `redis`、`emqx`、`minio`。
2. 使用当前仓库的 `docker-compose.yml` 启动。
3. 通过 `platform doctor` 验证依赖和配置。
4. 先跑 build 后镜像的 compose fast test。

### 阶段二：迁模板和 Agent 清单

1. 把现有模板改造到 `data/platform/templates/*`。
2. 用 `agents add` 生成 Agent 工作区。
3. 用 `agents doctor`、`agents logs` 验证基础运行。

### 阶段三：迁消息协议

1. 文本消息切到 `agents/text/inbound/{agent-name}`。
2. 文件消息切到 `agents/file/inbound/{agent-name}`。
3. 业务侧改为“先传 MinIO，再发对象引用”。

### 阶段四：灰度切流

1. 先选少量 Agent 灰度。
2. 对照会话表现、文件回传和日志结果。
3. 再扩大到更多 Agent。

## 8. 当前不建议直接全量切换的部分

下面这些能力还没有完全达到参考方案的生产强度：

1. 真实 MQTT 常驻消费循环
2. Redis Session 真持久化与崩溃恢复
3. 基于 `pi-mono` 的真实 AgentSession 驱动
4. 集群化 Worker 调度

因此当前最稳妥的迁移方式是：

1. 先让 MiniOS 接管 compose、配置、模板、CLI 和 image-level 测试。
2. 再逐步把真实业务流量切进来。

# MiniOS

MiniOS 是一个面向企业场景的 AI Agent 执行平台。当前仓库提供了可运行的 `gateway`、基础管理 CLI、以及用于本地联调的依赖栈。

如果你只是想把环境跑起来，先看下面三种运行方式；开发细节、目录结构、测试说明都挪到了 [dev_guide.md](./dev_guide.md)。

## 运行方式

| 方式 | 适用场景 | 启动内容 |
| --- | --- | --- |
| `standalone compose` | 本机一把拉起完整联调环境 | `gateway + redis + emqx + minio` |
| `gateway compose` | 只跑 MiniOS gateway，外部依赖已存在 | `gateway` 容器 |
| `node gateway` | 本地调试 Node 代码、看日志、打断点 | 宿主机上的 `node dist/gateway/server.js` |

## 先准备什么

初始化运行目录：

```bash
npm run compose:init:standalone
npm run compose:init:gateway
npm run compose:init:node
```

这会准备三套独立运行目录，并在缺失时复制：

- `data/standalone/config/llm.json`
- `data/standalone/config/env.json`
- `data/gateway/config/llm.json`
- `data/gateway/config/env.json`
- `data/node/config/llm.json`
- `data/node/config/env.json`

每种模式都有自己独立的配置，不再共用同一份文件。

### `llm.json`

用于模型配置。

### `env.json`

用于运行环境变量配置。重点看 `gateway` 这一段：

- `MINIOS_REDIS_URL`
- `MINIOS_MQTT_URL`
- `MINIOS_S3_ENDPOINT`
- `MINIOS_S3_ACCESS_KEY`
- `MINIOS_S3_SECRET_KEY`
- `OC_OPENAI_API_KEY`

`standalone compose` 使用 `data/standalone/config/env.json`；`gateway compose` 使用 `data/gateway/config/env.json`；`node gateway` 使用 `data/node/config/env.json`。

## 最小配置集合

三种模式最少都需要这两个文件：

- `config/<mode>/llm.json`
- `config/<mode>/env.json`

### `llm.json` 的最小结构

三种模式通用，最少要有：

- `agents.defaults.model.primary`
- `agents.defaults.model.backups`
- `models.providers.<providerId>.api`
- `models.providers.<providerId>.baseUrl`
- `models.providers.<providerId>.apiKeyEnv`
- `models.providers.<providerId>.models[0].id`
- `models.providers.<providerId>.models[0].name`
- `models.providers.<providerId>.models[0].contextTokens`

仓库模板已经给了最小可用结构，通常只需要改模型供应商地址、模型名和 API Key 对应的环境变量名。

### 1. Standalone Compose 的最小配置

最少文件：

- `data/standalone/config/llm.json`
- `data/standalone/config/env.json`

通常至少要确认这些键：

- `gateway.OC_OPENAI_API_KEY`

一般不用改的键：

- `gateway.MINIOS_REDIS_URL`
- `gateway.MINIOS_MQTT_URL`
- `gateway.MINIOS_S3_ENDPOINT`
- `minio.*`
- `emqx.*`

原因：

- `standalone` 会自己拉起 `redis / emqx / minio`
- 模板里的默认地址就是给这套本地 compose 用的

### 2. Gateway Compose 的最小配置

最少文件：

- `data/gateway/config/llm.json`
- `data/gateway/config/env.json`

通常至少要改这些键：

- `gateway.MINIOS_REDIS_URL`
- `gateway.MINIOS_MQTT_URL`
- `gateway.MINIOS_S3_ENDPOINT`
- `gateway.MINIOS_S3_ACCESS_KEY`
- `gateway.MINIOS_S3_SECRET_KEY`
- `gateway.OC_OPENAI_API_KEY`

按你的基础设施情况决定是否要改：

- `gateway.MINIOS_MQTT_USERNAME`
- `gateway.MINIOS_MQTT_PASSWORD`
- `gateway.MINIOS_S3_BUCKET_IN`
- `gateway.MINIOS_S3_BUCKET_OUT`
- `gateway.MINIOS_PORT`

可以不关心的键：

- `minio.*`
- `emqx.*`

原因：

- `gateway compose` 不会启动第三方依赖
- 这里真正需要的是外部 `Redis / MQTT / S3 / LLM` 的连接信息

### 3. Node Gateway 的最小配置

最少文件：

- `data/node/config/llm.json`
- `data/node/config/env.json`

通常至少要改这些键：

- `gateway.MINIOS_REDIS_URL`
- `gateway.MINIOS_MQTT_URL`
- `gateway.MINIOS_S3_ENDPOINT`
- `gateway.MINIOS_S3_ACCESS_KEY`
- `gateway.MINIOS_S3_SECRET_KEY`
- `gateway.OC_OPENAI_API_KEY`

如果仓库路径不是当前模板里的 `E:/CODE/minios`，还要改：

- `gateway.QMD_MODELS_DIR`
- `gateway.QMD_EMBED_MODEL`
- `gateway.QMD_RERANK_MODEL`
- `gateway.QMD_GENERATE_MODEL`

按你的基础设施情况决定是否要改：

- `gateway.MINIOS_MQTT_USERNAME`
- `gateway.MINIOS_MQTT_PASSWORD`
- `gateway.MINIOS_S3_BUCKET_IN`
- `gateway.MINIOS_S3_BUCKET_OUT`
- `gateway.MINIOS_PORT`

可以不关心的键：

- `minio.*`
- `emqx.*`

## 1. Standalone Compose

适合第一次体验或本机联调。它会直接拉起完整依赖栈。

启动：

```bash
npm run compose:standalone:up
```

前台运行：

```bash
npm run compose:standalone:up:fg
```

停止：

```bash
docker compose -f docker-compose.standalone.yml down
```

对应配置目录：

- `data/standalone/config/`

默认暴露端口：

- Gateway: `http://localhost:8080`
- EMQX Dashboard: `http://localhost:18083`
- MinIO API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001`

健康检查：

```bash
curl http://localhost:8080/healthz
```

## 2. Gateway Compose

适合你已经有外部 `Redis / MQTT / S3`，只想把 MiniOS gateway 作为单独容器部署进去。

启动前先改 `data/gateway/config/env.json` 里的 `gateway` 配置，把依赖地址改成外部服务地址。

启动：

```bash
npm run compose:gateway:up
```

前台运行：

```bash
npm run compose:gateway:up:fg
```

停止：

```bash
docker compose -f docker-compose.gateway.yml down
```

说明：

- 这个模式不会帮你拉起 `redis / emqx / minio`
- 配置文件位于 `./data/gateway/config/`
- 适合部署到已有基础设施的环境里

## 3. Node Gateway

适合开发者本地调试 gateway 代码。MiniOS 进程直接跑在宿主机 Node 上，依赖服务走 `data/node/config/env.json`。

首次运行前建议先安装依赖：

```bash
npm install
```

启动：

```bash
npm run start:gateway:node
```

这个入口会自动：

- 初始化 `./data/`
- 执行 `npm run build`
- 用 `data/node/config/env.json` 启动本地 gateway

如果你已经手工构建过，想跳过编译：

```bash
node scripts/start-node-gateway.mjs --skip-build
```

说明：

- 这个模式不启动任何容器
- 适合本地打断点、看标准输出、做快速代码验证
- 外部依赖需要你自己准备好

## 三种方式怎么选

- 只想最快跑通整套环境：用 `standalone compose`
- 只想部署一个 gateway 容器到已有基础设施：用 `gateway compose`
- 正在开发 gateway 代码：用 `node gateway`

## 常用命令

重新生成运行目录但不启动：

```bash
npm run compose:init:standalone
```

不重新 build 镜像直接拉起 standalone：

```bash
npm run compose:standalone:up -- --no-build
```

使用自定义数据目录：

```bash
node scripts/compose-up.mjs --compose-file docker-compose.standalone.yml --data-dir /path/to/data
```

## 当前状态

当前仓库已经能支持：

- Gateway 启动与健康检查
- Agent / Template / Skill 管理 CLI
- 本地运行时闭环
- Fast smoke test
- Docker image test

完整的生产级 Gateway / Worker 体系仍在持续演进中，因此更适合作为开发、联调和集成验证环境。

## 进一步阅读

- 开发说明：[dev_guide.md](./dev_guide.md)
- 详细设计：[doc/design/minios-detailed-design.md](./doc/design/minios-detailed-design.md)

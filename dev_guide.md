# MiniOS Development Guide

这个文档面向开发者，补充 README 中不需要让普通使用者优先关心的内容：目录结构、运行时布局、测试方式、以及三种启动模式在仓库内部的实现关系。

## 当前范围

当前仓库已经具备：

- TypeScript 工程与 CLI
- Agent / Template / Skill 管理
- 本地 gateway / worker 最小闭环
- `platform doctor`
- Docker 化 gateway
- fast smoke test
- docker image test

当前仍在持续完善：

- 完整的 MQTT 接入
- Redis 作为正式 Session Store
- 对象存储上传下载全链路
- 多 worker / 集群执行模型

因此，这个仓库更适合开发、联调、回归验证，而不是直接当作最终生产方案说明书。

## 三种运行模式在仓库里的对应关系

### 1. Standalone Compose

对应文件：

- `docker-compose.standalone.yml`
- `Dockerfile`
- `scripts/compose-up.mjs`

特点：

- 拉起 `gateway + redis + emqx + minio`
- 适合本地完整联调
- Docker 测试默认复用这一套依赖定义

### 2. Gateway Compose

对应文件：

- `docker-compose.gateway.yml`
- `Dockerfile`
- `scripts/compose-up.mjs`

特点：

- 只拉起 `gateway`
- 依赖外部 `redis / mqtt / s3`
- 适合把 MiniOS 接到已有基础设施

### 3. Node Gateway

对应文件：

- `scripts/start-node-gateway.mjs`
- `src/gateway/server.ts`

特点：

- 直接在宿主机 Node 上跑 gateway
- 更适合调试和开发
- 依赖外部 `redis / mqtt / s3`

## 运行时数据布局

三种模式默认都复用 `./data/`。初始化入口是：

```bash
npm run compose:init:standalone
npm run compose:init:gateway
npm run compose:init:node
```

主要目录：

```text
data/
  standalone/
    config/
      llm.json
      env.json
    gateway/
      root/
        data/
          agents/
          platform/
            templates/
            skills/
      logs/
      test-runs/
    runtime-env/
  gateway/
    config/
      llm.json
      env.json
    gateway/
      root/
      logs/
      test-runs/
    runtime-env/
  node/
    config/
      llm.json
      env.json
    gateway/
      root/
      logs/
      test-runs/
    runtime-env/
  redis/
  emqx/
    data/
    log/
  minio/
    data/
    config/
```

说明：

- `data/<mode>/config/` 是各模式独立维护的配置
- `data/<mode>/runtime-env/` 是从该模式 `env.json` 自动渲染出来的容器启动工件
- `data/<mode>/gateway/root/` 是该模式的 gateway 运行时根目录
- `data/redis/`、`data/emqx/`、`data/minio/` 是 standalone 共享的第三方依赖持久化目录

## 配置加载关系

### `<mode>/config/env.json`

`src/runtime/env-config.ts` 会按以下顺序加载环境配置：

1. `MINIOS_ENV_PATH`
2. `MINIOS_DATA_DIR/config/env.json`
3. 当前工作目录下的 `config/<mode>/env.json` 仅作为模板源，不应作为运行时主入口

`gateway`、`node`、`minio`、`emqx` 四个 block 会被展开成环境变量。

### `scripts/render-runtime-env.mjs`

这个脚本会把 `env.json` 中的：

- `minio`
- `emqx`

渲染为：

- `data/<mode>/runtime-env/minio.env`
- `data/<mode>/runtime-env/emqx.env`

standalone compose 里的第三方容器就是靠这两个文件启动。

## Session 约束

当前会话模型有几个固定约束：

- `sessionId` 和 `threadId` 都由调用方提供
- `sessionId` 是长期会话标识，也是 Memory 隔离边界
- `threadId` 只负责链路追踪
- 只有显式 reset 才应该清理某个 `sessionId` 的状态

可以简单理解为：

- `sessionId` 决定“记住谁”
- `threadId` 决定“这次调用怎么追踪”

## 开发时常用命令

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

类型检查：

```bash
npm run check
```

本地 Node 模式启动 gateway：

```bash
npm run start:gateway:node
```

Standalone Compose 启动：

```bash
npm run compose:standalone:up
```

Gateway Compose 启动：

```bash
npm run compose:gateway:up
```

## 测试

### Fast smoke test

```bash
python3 test/fast/run_smoke.py
```

这个测试覆盖：

- 仓库基础结构
- `npm run build`
- Agent CLI 流程
- Skill CLI 流程
- topic router / session key / tool policy 的基础行为

输出目录：

- `.tmp/test-{timestamp}/report.txt`
- `.tmp/test-{timestamp}/summary.json`

### Docker image tests

```bash
python3 test/docker/compose_image_fast_test.py --image minios-gateway:latest
python3 test/docker/compose_image_full_test.py --image minios-gateway:latest
```

这些测试会：

- 初始化独立的 compose 数据目录
- 复用 `docker-compose.standalone.yml` 提供的 `redis / emqx / minio`
- 用目标镜像启动 `gateway`
- 验证 healthz、publish、附件、模板填充等链路

运行前需要：

- 本机已有相关 Docker image
- 设置 `OC_OPENAI_API_KEY`

## 目录结构

```text
.
├── README.md
├── dev_guide.md
├── docker-compose.gateway.yml
├── docker-compose.standalone.yml
├── Dockerfile
├── scripts/
├── src/
├── config/
├── test/
└── doc/
```

重点目录：

- `src/cli.ts`: CLI 入口
- `src/gateway/server.ts`: gateway 进程入口
- `src/runtime/`: 本地运行时与配置装配
- `src/core/`: Agent、Skill、Policy、Topic 等核心模块
- `scripts/init-compose-data.mjs`: 统一初始化 `./data/`
- `config/standalone/`, `config/gateway/`, `config/node/`: 三套配置模板
- `scripts/compose-up.mjs`: 通用 compose 启动器
- `scripts/start-node-gateway.mjs`: 本地 Node 模式启动器

## 参考文档

- 详细设计：[doc/design/minios-detailed-design.md](./doc/design/minios-detailed-design.md)
- Docker 测试说明：[test/docker/README.md](./test/docker/README.md)

# MiniOS Development Guide

## 项目简介

MiniOS 是一个基于 `pi-mono` 设计的企业级 AI Agent 平台，目标是提供：

- 多 Agent 执行能力
- MQTT 消息交互通道
- Redis Session 存储
- 文件型 Memory 与 QMD 检索
- S3 兼容对象存储附件传输
- 可控工具调用链路
- 集群化 Gateway / Worker 部署模型

当前仓库处于早期开发阶段，已经具备最小核心骨架：

- TypeScript 工程结构
- Agent / Template 管理
- Skill 管理
- MQTT topic 路由解析
- Session Redis key 生成
- Tool policy 白名单与参数注入
- 本地文件型 Session Store
- 本地 Worker / Gateway runtime
- `platform doctor`
- `restart` / `doctor` / `logs` CLI
- Python fast smoke test

## 当前范围

当前代码实现的范围主要是平台核心基础层，不包含完整运行时接入：

已实现：

- TypeScript 构建与模块导出
- CLI 基础入口
- Agent 管理器
- Skill 管理器
- Topic 路由器
- Session key 生成器
- Tool policy 引擎
- 本地文件型 Session Store
- 本地 Worker / Gateway runtime
- `platform doctor`
- `restart` / `doctor` / `logs` CLI
- Fast 冒烟测试

尚未实现：

- MQTT 实际连接
- Redis Session Store
- QMD 实际检索集成
- 对象存储上传下载
- 基于 `pi-mono` 的真实 `AgentSession` 驱动

因此，当前仓库已经具备“本地最小闭环 + 平台约束模型 + 开发起点”，但还不是最终的外部依赖集成版本。

## 项目结构

当前目录结构如下：

```text
.
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
├── tsconfig.json
└── .gitignore
```

### `doc/design/`

设计文档目录。

- `minios-detailed-design.md`
  MiniOS 当前的详细设计说明，覆盖架构、协议、隔离、存储、策略、运维等内容。

### `src/`

TypeScript 源码目录。

### `src/cli.ts`

CLI 入口，当前支持：

- `agents list`
- `agents add`
- `agents delete`
- `agents info`
- `agents restore`
- `agents restart`
- `agents doctor`
- `agents logs`
- `platform doctor`
- `skills list`
- `skills install`
- `skills uninstall`
- `runtime publish`
- `runtime control`
- `policy check`

### `src/core/agent-manager.ts`

负责：

- 管理 Agent 目录
- 从模板创建 Agent
- 读取 Agent manifest
- 恢复模板文件
- 删除 Agent

### `src/core/skill-manager.ts`

负责：

- 全局 Skill 安装、卸载、列举
- Agent 级 Skill 安装、卸载、列举

### `src/core/topic-router.ts`

负责：

- 解析 MQTT topic
- 识别 `agentId`
- 区分业务消息与控制消息
- 区分 `in/out`

### `src/core/session-keys.ts`

负责：

- 统一生成 Redis Session 相关 key
- 避免上层各处散落字符串拼接逻辑

### `src/runtime/`

负责当前阶段的本地最小运行时：

- `protocol.ts`
  业务消息、控制消息和事件模型
- `file-session-store.ts`
  文件型 Session 元数据、事件、去重与 transcript 持久化
- `local-worker.ts`
  本地 Worker 执行闭环与控制命令
- `local-gateway.ts`
  基于 topic 的进程内调度封装
- `platform-doctor.ts`
  平台级依赖检查，包括 Redis / MQTT / S3 / CLI 可用性

### `src/core/tool-policy.ts`

负责：

- 命令白名单匹配
- 参数注入
- 路径访问校验
- 网络访问校验

这是后续受控 `bash` 工具链的核心雏形。

### `src/core/fs-utils.ts`

负责：

- 文件系统辅助函数
- JSON 文件读写
- 目录创建、删除、列举
- 资源 ID 校验

### `test/fast/`

快速冒烟测试目录。

- `run_smoke.py`
  运行一组零依赖、快速完成的基础测试
- `README.md`
  简要使用说明

### `test/docker/`

基于已构建 image 的 Docker 测试目录。

- `compose_image_fast_test.py`
  复用仓库 `docker-compose.yml` 中的 `redis`、`emqx`、`minio`，再对 built image 做回归
- `Dockerfile.overlay`
  在本地已有 `minios-gateway:latest` 基础上覆盖最新 `dist/` 的测试镜像定义
- `README.md`
  使用说明

### `.tmp/`

测试输出目录，不提交到版本库。

fast 测试每次运行都会生成：

- `.tmp/test-{timestamp}/summary.json`
- `.tmp/test-{timestamp}/report.txt`

## 运行环境

推荐环境：

- Node.js 24+
- npm 11+
- Python 3.10+

当前验证过的环境：

- Node.js `v24.14.0`
- npm `11.12.1`
- Python `3.14.4`

## 安装依赖

在仓库根目录执行：

```bash
npm install
```

这会安装 TypeScript 编译所需的最小依赖。

## 编译方法

### 构建

执行：

```bash
npm run build
```

输出目录：

```text
dist/
```

其中会包含：

- `dist/cli.js`
- `dist/index.js`
- `dist/core/*.js`

### 仅做类型检查

执行：

```bash
npm run check
```

### 清理构建产物

执行：

```bash
npm run clean
```

## 测试方法

### Fast 冒烟测试

执行：

```bash
python3 test/fast/run_smoke.py
```

该脚本会：

1. 创建 `.tmp/test-{ts}` 输出目录
2. 检查仓库基础结构
3. 检查设计文档存在性
4. 检查 Python 运行时
5. 检查输出目录可写
6. 执行 `npm run build`
7. 验证 agent CLI 流程
8. 验证 skill CLI 流程
9. 验证 topic router、session key、tool policy 行为

输出文件包括：

- `summary.json`
- `report.txt`

### 查看最近一次测试结果

可以执行：

```bash
latest=$(ls -1 .tmp | sort | tail -n 1)
cat .tmp/$latest/report.txt
```

## CLI 使用示例

### 创建 Agent

```bash
node dist/cli.js agents add --root /path/to/runtime --id agent-alpha --template basic
```

### 查看 Agent

```bash
node dist/cli.js agents info --root /path/to/runtime --id agent-alpha
```

### 恢复模板文件

```bash
node dist/cli.js agents restore --root /path/to/runtime --id agent-alpha
```

### 安装全局 Skill

```bash
node dist/cli.js skills install --root /path/to/runtime -g /path/to/sample-skill
```

### 安装 Agent Skill

```bash
node dist/cli.js skills install --root /path/to/runtime -a agent-alpha /path/to/sample-skill
```

## 开发建议

### 代码组织建议

后续新增模块建议继续按职责拆分在 `src/core/` 或更细的子目录中，例如：

- `src/gateway/`
- `src/worker/`
- `src/session/`
- `src/memory/`
- `src/storage/`
- `src/monitoring/`

### 增量开发顺序建议

建议按以下顺序推进：

1. Redis Session Store
2. Gateway / Worker 基础运行模型
3. MQTT 接入层
4. 对象存储适配层
5. `pi-mono` AgentSession 集成
6. QMD Memory 检索
7. 运维控制命令
8. 监控与审计

### 测试扩展建议

当前 `fast` 测试只覆盖基础骨架。后续建议补充：

- Redis 集成测试
- MQTT 协议测试
- 对象存储测试
- Tool policy 边界测试
- AgentSession 运行流测试
- Gateway / Worker 路由测试

## 参考文档

- 详细设计文档：[minios-detailed-design.md](/Users/ningwei/VSCodeProjects/minios/doc/design/minios-detailed-design.md)

## 总结

当前仓库已经具备 MiniOS 的第一层核心框架与测试基础，可以在此之上继续实现：

- 集群执行能力
- 会话持久化
- Memory 与检索
- 受控工具链路
- 企业级运维与审计

日常开发建议先执行：

```bash
npm run build
python3 test/fast/run_smoke.py
```

确保构建和冒烟测试都通过后，再继续提交后续变更。

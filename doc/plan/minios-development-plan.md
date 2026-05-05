# MiniOS 开发计划

## 1. 目标

MiniOS 的最终目标是平替以下方案中的 Agent 执行器部分：

- `https://gitee.com/low-code-dev-lab/ai-workstation-manual`

这里的“平替”含义是：

1. 在企业级 AI 工作台方案中，MiniOS 可以承担原方案中 OpenClaw 执行器的职责。
2. 上层业务系统仍然通过 MQTT 与对象存储和执行器解耦。
3. 需要支持容器化部署、可运维、可诊断、可扩展、可集群。
4. 可以接受和 OpenClaw 的配置格式不同，但必须覆盖核心运行能力。

## 2. 范围定义

MiniOS 最终要覆盖的执行器能力包括：

1. Agent 生命周期管理
2. MQTT 入站与出站消息通道
3. Redis Session 机制
4. 文件型 Memory 与 QMD 检索
5. S3 兼容对象存储文件传输
6. 受控工具调用链路
7. Docker 运行与数据持久化
8. 运维命令与自检能力
9. 多 Worker 集群执行能力

不要求覆盖的内容：

1. 不要求兼容 OpenClaw 配置文件结构
2. 不要求兼容 OpenClaw 插件机制
3. 不要求兼容活字格应用内部实现方式
4. 不要求直接复刻 OpenClaw CLI 命令的实现细节

## 3. MiniOS 与参考方案的固定差异

以下差异是明确保留的，不需要为了兼容参考方案而改回去。

### 3.0 需要内置管理 CLI 组件

MiniOS 镜像除了平台主程序外，还需要内置一批管理型 CLI 组件。

当前明确需要内置：

1. `mqtt-bash-exec-channel`

定位：

1. 这是镜像内置管理组件，不是普通业务 Skill
2. 它用于管理、诊断或辅助 MQTT/bash 执行链路
3. 应在镜像构建阶段直接预装，避免运行后再在线安装

### 3.1 Session 机制固定

MiniOS 的 Session 机制固定，不需要暴露可配置项。

固定原则：

1. `sessionId` 与 `threadId` 都由调用方提供
2. 会话执行态唯一键为 `(agentId, sessionId, threadId)`
3. Memory 隔离键为 `(agentId, sessionId)`
4. `threadId` 仅用于会话内部追踪，不影响 Memory
5. Session 真相源固定为 Redis
6. 不提供类似 OpenClaw 中可切换的 `dmScope` 一类配置

这意味着：

- MiniOS 的 Session 行为是平台约束，不是租户自定义项
- 业务方只需要遵循协议，不需要配置 Session 模式
- 同一用户在同一 Agent 下应持续使用同一个 `sessionId`
- 只有显式 `reset session` 才允许清空或重建该 `sessionId` 对应的 Memory

### 3.2 文件传输是 bootstrap 级别内置 Skill

文件传输能力不是普通可选 Skill，而是内置 bootstrap Skill。

固定原则：

1. 文件传输相关能力作为平台内置 Skill 提供
2. 每个 Agent 的每个会话都必须自动加载
3. 不依赖用户手工安装
4. 不允许被业务方误卸载
5. bootstrap Skills 需要直接存放在仓库内，并独立于 bundled Skills 管理

职责包括：

1. 从对象存储下载 inbound 附件到会话隔离工作区
2. 将 Agent 产出的文件上传到对象存储
3. 为模型提供“读取文件”“上传结果”的统一工具接口
4. 将对象存储引用与本地工作区映射关系纳入审计

### 3.3 需要内置 bundled Skills

除了 bootstrap Skills 外，MiniOS 还需要预装一批 bundled Skills。

这些 Skill 的特征是：

1. 随镜像内置
2. 不要求每个会话强制加载
3. 可按 Agent 启用
4. 不依赖业务方在运行后手工安装

首批 bundled Skills 参考 gitee 方案，至少包括：

1. `agent-browser-clawdbot`
2. `excel-xlsx`
3. `word-docx`
4. `powerpoint-pptx`
5. `ocr-tesseract`

其中：

1. `agent-browser-clawdbot` 依赖浏览器运行时
2. Chrome for Testing 的本地离线包只对 `amd64` 镜像打包
3. `arm64` 镜像先不提供完整 Chrome 能力，相关 Skill 需要显式降级或禁用
4. `ocr-tesseract` 依赖镜像内预装：
   `tesseract-ocr`、`tesseract-ocr-chi-sim`、`tesseract-ocr-eng`

### 3.3 restart 不依赖 Docker restart

MiniOS 的 `restart` 必须在平台内部实现，不依赖 Docker 容器重启。

固定原则：

1. `restart` 用于重新加载 Agent 配置
2. `restart` 用于重置该 Agent 的运行时 Session 缓存
3. `restart` 不应重启整个容器
4. `restart` 应通过 Gateway / Worker 控制面完成

需要支持的行为：

1. 重新加载 Agent manifest
2. 重新加载模板、Skills、Policy
3. 清理 Worker 内该 Agent 的会话缓存
4. 保留 Redis 中的持久 Session 真相源
5. 可选中断或摘流正在运行的该 Agent 会话

## 4. 当前状态

当前仓库已经完成：

1. TypeScript 工程初始化
2. Agent 管理器
3. Skill 管理器
4. MQTT topic 路由解析
5. Session key 规则
6. Tool policy 白名单骨架
7. Gateway 最小健康检查进程
8. Dockerfile 与 docker-compose 基础骨架
9. Fast smoke test
10. 设计文档、开发指南、README

当前仓库尚未完成：

1. Worker 进程
2. Redis Session Store
3. MQTT 实际接入
4. OSS 实际接入
5. QMD 实际检索接入
6. `pi-mono` AgentSession 驱动
7. bootstrap 文件传输 Skill
8. 内部 restart 实现
9. doctor / logs / restart 控制面闭环
10. 集群调度与 Worker 注册机制
11. `reset session` 控制动作

## 5. 总体开发策略

总体策略分为四条主线并行推进：

1. 执行链路主线
   - Gateway
   - Worker
   - Redis
   - MQTT
   - AgentSession
2. 文件与 Memory 主线
   - OSS
   - bootstrap 文件传输 Skill
   - Memory
   - QMD
3. 可控工具主线
   - Tool policy
   - 命令/路径/网络白名单
   - 参数注入
   - 审计
4. 运维主线
   - restart
   - doctor
   - logs
   - metrics
   - health

开发顺序上，优先把“最小可跑通闭环”做出来，再逐步增强。

## 6. 阶段计划

## 6.1 阶段一：执行器最小闭环

目标：

让 MiniOS 真正处理一条 MQTT 消息，驱动一个 Agent 执行，并返回结果。

范围：

1. 实现 `gateway`
   - 连接 MQTT
   - 订阅 `agents/{agentId}/in`
   - 发布 `agents/{agentId}/out`
2. 实现 `worker`
   - 接收 Gateway 转发请求
   - 运行最小 Agent 会话
3. 实现 Redis Session Store
   - 会话元数据
   - 事件流
   - 锁与幂等
   - `sessionId` 级 Memory 关联
4. 集成 `pi-mono` AgentSession
   - 最小 prompt 执行
   - 事件订阅
5. 完成最小出站消息映射
   - `thinking`
   - `tool`
   - `block`
   - `final`

验收标准：

1. 可以通过 MQTT 向某个 Agent 发送一条文本消息
2. Agent 可以返回文本结果
3. Session 数据写入 Redis
4. Worker 重启后可以恢复上下文
5. 同一 `sessionId` 下不同 `threadId` 不会创建新的 Memory 隔离空间

## 6.2 阶段二：文件传输与内置 bootstrap Skill

目标：

补齐 OSS 文件传输闭环，并将其内置为每个会话自动加载的 bootstrap Skill。

范围：

1. 实现对象存储适配层
   - 下载 inbound 附件
   - 上传 outbound 结果
2. 实现 bootstrap 文件传输 Skill
   - 会话启动必加载
   - 非用户可卸载 Skill
3. 定义附件消息协议
   - `attachments[]`
   - bucket/key/name/mediaType/size/hash
4. 下载到会话隔离工作区
5. 输出结果对象引用

验收标准：

1. 业务系统可上传文件到 S3 兼容对象存储
2. Agent 可在当前会话读取该文件
3. Agent 产出结果文件后可回传到对象存储
4. bootstrap Skill 对所有会话默认生效

## 6.3 阶段三：Memory 与 QMD

目标：

让 Agent 具备会话外长期记忆能力，并通过 QMD 检索。

范围：

1. 完成 Memory 文件目录结构
2. 完成 Memory 写入工具
3. 完成 QMD 索引建立与刷新
4. 会话执行前做 Memory 检索
5. 会话结束后导出 `sessions/*.md`
6. 实现 `reset session`

验收标准：

1. Agent 可写入长期记忆
2. 新会话可通过 QMD 检索到旧记忆
3. 索引刷新可通过 `doctor` 触发重建
4. 同一 `sessionId` 下不同 `threadId` 可共享 Memory
5. `reset session` 后旧 Memory 不再自动参与检索

## 6.4 阶段四：可控工具调用链路

目标：

落地企业场景最关键的“受控执行”。

范围：

1. 完成 Tool policy schema
2. 实现命令白名单
3. 实现路径白名单
4. 实现网络白名单
5. 实现参数注入
6. 完成工具调用审计日志

验收标准：

1. 未授权命令无法执行
2. 未授权路径访问被阻断
3. 未授权网络访问被阻断
4. 白名单命令自动注入 `--sessionId` 和 `--threadId`
5. 所有执行过程可查询审计记录

## 6.5 阶段五：控制面与内部 restart

目标：

实现不依赖 Docker 重启的内部控制面。

范围：

1. 实现 `restart`
   - 重新加载 Agent 配置
   - 重置 Session 缓存
   - 摘流与恢复
2. 实现 `doctor`
   - Redis
   - MQTT
   - S3
   - QMD
   - Provider
   - 配置
3. 实现 `logs`
   - 过滤 agentId/sessionId/threadId/traceId
4. 实现控制 topic
   - `agents/{agentId}/control/in`
   - `agents/{agentId}/control/out`

验收标准：

1. 修改 Agent 配置后无需 Docker restart 即可生效
2. `restart` 可重载 AgentContext
3. `doctor` 可输出结构化检查结果
4. `logs` 可按 Agent 或 Session 检索

## 6.6 阶段六：集群与生产强化

目标：

将 MiniOS 从单实例执行器演进为可生产集群。

范围：

1. Worker 注册与心跳
2. 会话粘性路由
3. Agent 级并发和配额
4. 死信队列
5. metrics / audit / tracing
6. 非 root 用户、权限收敛、启动脚本
7. 版本化数据升级机制

验收标准：

1. 一个 Gateway + 多 Worker 可稳定运行
2. Worker 故障后会话可重路由恢复
3. `restart`、`doctor`、`logs` 在集群下仍可用
4. 升级镜像不会丢失数据

## 7. 与参考方案的能力对齐清单

最终需要对齐的能力包括：

1. 基于 MQTT 的业务消息交互
2. 基于 S3 的文件收发
3. 可管理的 Agent 生命周期
4. 容器化执行器部署
5. 诊断与日志查看
6. QMD Memory 能力
7. Python / npm 扩展能力
8. x64 与 arm64 支持

不要求完全对齐的部分：

1. OpenClaw 配置结构
2. OpenClaw 插件系统
3. OpenClaw 原生命令的内部实现

## 8. 里程碑

### M1：最小消息闭环

完成标志：

- MQTT 入站 -> Worker -> Agent -> MQTT 出站

### M2：文件闭环

完成标志：

- 附件上传 -> Agent 读取 -> 结果上传

### M3：记忆闭环

完成标志：

- Memory 写入、QMD 检索、跨会话召回

### M4：受控执行闭环

完成标志：

- 工具白名单、参数注入、审计

### M5：控制面闭环

完成标志：

- 内部 restart、doctor、logs

### M6：集群可生产

完成标志：

- Gateway + 多 Worker + 数据持久化 + 运维稳定

## 9. 测试计划

开发过程中需要同步建设测试，而不是等功能结束后补。

### 9.1 Fast

定位：

- 构建级
- 冒烟级
- 单机快速验证

覆盖：

1. 编译
2. CLI
3. topic 解析
4. session key
5. tool policy

### 9.2 Integration

后续新增目录建议：

- `test/integration`

覆盖：

1. Redis Session Store
2. MQTT 往返
3. S3 附件流
4. bootstrap Skill
5. QMD 检索
6. restart / doctor / logs

### 9.3 Docker

后续新增目录建议：

- `test/docker`

覆盖：

1. `docker compose up`
2. gateway 健康检查
3. 数据目录持久化
4. x64 / arm64 镜像构建

## 10. 风险

### 10.1 最大风险

1. 共享 Worker 下的 Agent 隔离不足
2. 文件传输 Skill 如果设计不当，容易和普通 Skill 混淆
3. restart 的正确性比表面看起来复杂，涉及运行中会话、缓存、路由和锁
4. QMD 模型与预热会增加镜像体积和构建时间
5. arm64 与 amd64 在浏览器能力上天然不完全一致

### 10.2 应对策略

1. bootstrap Skill 独立命名空间与独立加载路径
2. restart 先按 Agent 级局部重载实现，再考虑更细粒度热更新
3. Worker 内缓存和 Redis 真相源分离
4. 浏览器能力明确声明：
   - amd64 完整支持
   - arm64 先不支持 Chrome 能力

## 11. 推荐落库方式

建议后续开发中，所有任务都和本计划中的阶段与里程碑关联。

例如：

- `phase-1/gateway-mqtt-client`
- `phase-2/bootstrap-file-skill`
- `phase-5/internal-restart`

这样可以保证 MiniOS 的开发始终围绕“平替参考方案”推进，而不是陷入局部功能堆叠。

## 12. 结论

MiniOS 的最终目标不是复刻 OpenClaw，而是交付一个更适合企业级执行器场景的平台：

1. 平替参考方案的执行器职责
2. 保留 MiniOS 自己的固定 Session 机制
3. 将文件传输做成 bootstrap 内置 Skill
4. 将 restart 变成平台内部能力，而不是 Docker 重启行为

只要按本计划分阶段落地，MiniOS 可以在能力上完成平替，同时在架构控制力和企业治理能力上超过参考方案。

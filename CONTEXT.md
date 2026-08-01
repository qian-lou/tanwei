# 探微 JVM 诊断工作台

探微把桌面端对目标 JVM 的在线诊断组织为可取消、可审计、可恢复的会话与任务，并把需要跨会话保留的结果固化为制品和案例。

## Language

**目标（Target）**：
一个可被发现或显式配置、尚未承诺已建立诊断通道的 JVM 端点。
_Avoid_: JVM 实例、连接

**目标会话（Target Session）**：
目标从连接尝试到断开清理的唯一状态与资源所有者。
_Avoid_: Connection、Agent Client、Renderer 连接状态

**能力（Capability）**：
Agent 在当前 JVM 与协议版本下声明可执行性及不可用原因的版本化功能单元。
_Avoid_: 菜单项、页面、Action

**Action Contract**：
Host 与 Agent 对一个诊断操作的标识、版本、能力、风险、输入、输出和结构化错误的共同约束。
_Avoid_: command、字符串参数字典、IPC 方法

**诊断任务（Diagnostic Task）**：
一次有身份、有生命周期且至多允许一个在途轮询的长时诊断执行。
_Avoid_: 定时器、请求、job

**结果（Result）**：
当前会话内由 Action 或诊断任务产生的有界结构化数据。
_Avoid_: 制品、Generic values

**制品（Artifact）**：
经 Host 校验、哈希并原子落盘后可跨会话引用的不可变诊断证据。
_Avoid_: 临时文件、结果、报告窗口

**案例（Case）**：
引用一个或多个制品或审计记录、用于协作和归档的诊断调查单元。
_Avoid_: 任务、Workspace

**工作区（Workspace）**：
Host 管理案例、制品、审计、草稿和治理配置的一致性持久化边界。
_Avoid_: Repository、数据库、用户目录

**远程部署操作（Remote Deployment Operation）**：
一次带 operation identity 的 SSH 或 Kubernetes 预览、传输、启动和补偿清理流程。
_Avoid_: 远程连接、脚本执行

## Relationships

- 一个 **目标** 在任意时刻至多属于一个活动 **目标会话**
- 一个 **目标会话** 声明零个或多个 **能力**，并拥有零个或多个 **诊断任务**
- 一个 **Action Contract** 精确要求一个 **能力** 和一个风险级别
- 一个 **诊断任务** 产生零个或多个 **结果**，部分结果可固化为 **制品**
- 一个 **案例** 引用零个或多个 **制品** 或审计记录，但不拥有其物理文件
- 一个 **工作区** 是案例、制品元数据与治理数据的唯一 Host 持久化边界
- 一个 **远程部署操作** 只补偿清理带自身 identity 的资源，并最终建立或不建立一个 **目标会话**

## Example dialogue

> **开发者：** “SSH 已经上传 Agent，但握手协议不兼容，是否把这个目标显示为 READY？”
> **领域专家：** “不可以。远程部署操作可以完成传输，但目标会话只有在协议和所需能力校验通过后才能进入 READY；失败时只清理本次 operation identity 创建的资源。”
>
> **开发者：** “Profiler 页面刷新算新的任务吗？”
> **领域专家：** “不算。它是同一个诊断任务的轮询，同一任务最多一个 in-flight poll；只有经 Host 校验并落盘的输出才成为制品。”

## Flagged ambiguities

- “连接”曾同时指目标配置、gRPC 通道和完整生命周期；现统一由 **目标会话** 表达生命周期，Transport 仅是其实现细节。
- “任务”曾同时指一次 Action 请求和长时采集；现仅长时、有身份的执行称 **诊断任务**，短请求称 Action 调用。
- “结果”和“制品”曾混用；现 **结果** 属于会话内存，只有完成校验与原子落盘后才是 **制品**。
- “命令”容易暗示文本 Shell 或 Arthas wire protocol；产品边界统一使用 **Action Contract**，不开放任意命令执行。

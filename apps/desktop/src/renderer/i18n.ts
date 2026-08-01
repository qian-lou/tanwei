import { useSyncExternalStore } from "react";
import type { AppSettings } from "@shared/contracts";

export type Locale = AppSettings["locale"];
export type TranslationParameters = Readonly<Record<string, string | number>>;

const english: Readonly<Record<string, string>> = {
  探微: "Tanwei",
  目标: "Targets",
  概览: "Overview",
  线程: "Threads",
  类: "Classes",
  观测: "Observe",
  监控: "Monitor",
  追踪: "Trace",
  剖析: "Profile",
  运行时: "Runtime",
  计数器: "Counters",
  快照: "Snapshots",
  调用快照: "Invocation snapshots",
  "PerfCounter 检查器": "PerfCounter inspector",
  "MBean 检查器": "MBean inspector",
  MBean: "MBeans",
  日志: "Loggers",
  任务: "Tasks",
  任务中心: "Task center",
  审计: "Audit",
  诊断审计: "Diagnostic audit",
  控制台: "Console",
  制品: "Artifacts",
  案例: "Cases",
  设置: "Settings",
  工作台: "Workbench",
  全部能力: "All capabilities",
  "正在核对每个 JVM。": "Checking every JVM.",
  "退出会终止仍在运行的诊断。":
    "Quitting will stop diagnostics that are still running.",
  "退出影响尚未完全确认。": "The impact of quitting is not fully confirmed.",
  "正在只读扫描活动任务、字节码增强与可回收制品。":
    "Read-only scanning active tasks, bytecode enhancements, and recoverable artifacts.",
  "探微会在退出时撤销自己持有的增强并停止任务；尚未保存的 Profile 或 JFR 结果可能无法回收。":
    "Tanwei will remove the enhancements it owns and stop tasks when quitting. Unsaved Profile or JFR results may not be recoverable.",
  "至少一个连接没有返回可信预检结果。继续退出会按安全清理流程断开连接。":
    "At least one connection did not return a trusted preflight result. Continuing will disconnect it through the safe cleanup path.",
  "{count} 个未确认": "{count} unconfirmed",
  "观测 / Trace / Profile / JFR": "Observe / Trace / Profile / JFR",
  "{count} 条回滚记录": "{count} rollback records",
  可能尚未回收的制品: "Artifacts that may not be recovered yet",
  "{count} 个 JVM 未完成影响检查，探微不会把未知状态当作安全。":
    "{count} JVMs did not complete impact inspection. Tanwei does not treat unknown state as safe.",
  "未确认 · {message}": "Unconfirmed · {message}",
  未知错误: "Unknown error",
  "{taskCount} 任务 · {classCount} 增强类 · {artifactCount} 待回收结果":
    "{taskCount} tasks · {classCount} enhanced classes · {artifactCount} results to recover",
  "另有 {count} 个受影响目标": "{count} more affected targets",
  继续诊断: "Keep diagnosing",
  查看任务中心: "Review task center",
  "关闭窗口，任务后台继续": "Close window and keep tasks running",
  安全退出并清理: "Quit safely and clean up",
  无法完成退出操作: "Unable to complete the quit operation",
  无法确认退出对诊断会话的影响:
    "Unable to confirm the impact of quitting on diagnostic sessions",
  "全部诊断能力。": "All diagnostic capabilities.",
  关闭能力启动器: "Close capability launcher",
  "按能力、问题或参考术语搜索":
    "Search by capability, problem, or reference terminology",
  "例如 thread dump、vmoption、内存泄漏":
    "For example: thread dump, vmoption, or memory leak",
  "{count} 项匹配": "{count} matches",
  "↑↓ 选择 · Enter 打开 · Esc 关闭": "↑↓ Select · Enter open · Esc close",
  诊断能力搜索结果: "Diagnostic capability search results",
  需连接: "Connection required",
  可打开: "Ready to open",
  "没有匹配能力。": "No matching capability.",
  "尝试类、线程、Heap、JFR 或参考命令名称。":
    "Try classes, threads, Heap, JFR, or a reference command name.",
  "只导航到类型化桌面检查器，不执行未知文本命令。":
    "Navigates only to typed desktop inspectors; no unknown text command is executed.",
  目标与连接: "Targets and connections",
  类与对象: "Classes and objects",
  方法诊断: "Method diagnostics",
  性能与制品: "Performance and artifacts",
  工作流与治理: "Workflow and governance",
  诊断操作审计: "Diagnostic action audit",
  "跨桌面会话检索 Action、目标、风险、状态与稳定错误码。":
    "Search actions, targets, risk, status, and stable error codes across desktop sessions.",
  "跨桌面会话检索结构化诊断操作、风险、状态与稳定错误码。":
    "Search structured diagnostic operations, risk, status, and stable error codes across desktop sessions.",
  "每一次诊断，都能追溯。": "Every diagnostic action remains traceable.",
  "跨桌面会话检索 Host 已执行的结构化 Action；只保留目标、风险、状态、错误码和结果字段名，不保存业务值。":
    "Search structured actions executed by the Host across desktop sessions. Only targets, risk, status, error codes, and result field names are retained—never business values.",
  匹配记录: "Matching records",
  执行成功: "Succeeded",
  执行失败: "Failed",
  本地保留: "Retained locally",
  筛选审计记录: "Filter audit records",
  "搜索 Action ID、任务 ID、目标 ID 或稳定错误码。":
    "Search by Action ID, task ID, target ID, or stable error code.",
  重置: "Reset",
  搜索审计: "Search audit",
  "例如 mbean、session.reset 或错误码":
    "For example: mbean, session.reset, or an error code",
  风险等级: "Risk level",
  全部风险: "All risk levels",
  目标范围: "Target scope",
  全部目标: "All targets",
  当前没有目标: "No current target",
  无法检索诊断审计记录: "Unable to query diagnostic audit records",
  "Action 历史": "Action history",
  "按完成时间倒序；每页最多 {count} 条。":
    "Newest first; up to {count} records per page.",
  完成时间: "Completed",
  详情: "Details",
  "查看 {action} 审计详情": "View audit details for {action}",
  查看: "View",
  "没有匹配的审计记录。": "No audit records match.",
  "调整搜索、状态、风险或目标范围后重试。":
    "Adjust the search, status, risk, or target scope and try again.",
  "第 {page} 页": "Page {page}",
  "Host 权威摘要 · 不包含参数值和结果值":
    "Host-authoritative summary · no parameter or result values",
  加入案例证据: "Add to case evidence",
  "任务 ID": "Task ID",
  "目标 ID": "Target ID",
  状态与风险: "Status and risk",
  稳定错误码: "Stable error code",
  结果字段名: "Result field names",
  "没有记录结果字段。": "No result fields were recorded.",
  "已从诊断审计带入 Action {taskId}；打开任一案例的“证据与导出”即可固定。":
    "Action {taskId} was brought in from diagnostic audit. Open Evidence & Export on any case to pin it.",
  档案: "Archive",
  桌面调用档案: "Desktop invocation archive",
  跨会话调用档案: "Cross-session invocation archive",
  "离线检索显式固定、由 Host 核验并脱敏的调用上下文。":
    "Search explicitly pinned invocation context that the Host verified and redacted, even while offline.",
  "跨桌面会话检索显式固定、经 Host 脱敏的调用快照。":
    "Search explicitly pinned invocation snapshots redacted by the Host across desktop sessions.",
  打开桌面调用档案: "Open desktop invocation archive",
  "调用已经结束，证据仍然在。": "The invocation ended. Its evidence remains.",
  "跨桌面会话检索显式固定的调用快照；Host 重新读取并脱敏，断开目标后仍可检查。":
    "Search explicitly pinned invocation snapshots across desktop sessions. The Host rereads and redacts each snapshot so it remains inspectable after disconnecting.",
  返回会话快照: "Back to session snapshots",
  估算空间: "Estimated storage",
  筛选桌面调用档案: "Filter desktop invocation archive",
  "搜索类、方法、线程、参数、返回值或异常。":
    "Search classes, methods, threads, arguments, return values, or exceptions.",
  搜索档案: "Search archive",
  "例如类名、方法、线程或异常":
    "For example: a class, method, thread, or exception",
  调用时间索引: "Invocation timeline",
  "按捕获时间倒序；每页最多 {count} 条。":
    "Newest capture first; up to {count} records per page.",
  "查看 {method} 调用档案": "View invocation archive for {method}",
  "还没有匹配的桌面调用档案。": "No desktop invocation archives match.",
  "在会话快照详情中选择“固定到桌面”。":
    "Choose Pin to desktop from a session snapshot detail.",
  "选择一条档案查看完整上下文。":
    "Select an archive to inspect its complete context.",
  "档案不依赖当前目标连接。":
    "Archives do not depend on the current target connection.",
  固定时间: "Pinned",
  "保存时由 Host 再次遮罩疑似凭据；桌面档案始终只读，不直接用于重放。":
    "The Host masks suspected credentials again while saving. Desktop archives are always read-only and cannot be replayed directly.",
  "删除桌面调用档案？": "Delete desktop invocation archive?",
  "只删除本地副本，不影响原始调用、目标 JVM 或 Agent 会话。":
    "This removes only the local copy. It does not affect the original invocation, target JVM, or Agent session.",
  "我确认永久删除这条本地调用档案。":
    "I confirm that this local invocation archive should be permanently deleted.",
  删除档案: "Delete archive",
  "删除中…": "Deleting…",
  无法检索桌面调用档案: "Unable to query desktop invocation archives",
  无法读取桌面调用档案: "Unable to read the desktop invocation archive",
  无法删除桌面调用档案: "Unable to delete the desktop invocation archive",
  固定到桌面: "Pin to desktop",
  "Host 会重新读取这条精确快照、核对 JVM 启动周期并遮罩疑似凭据；之后断开目标也能查看。":
    "The Host rereads this exact snapshot, verifies its JVM lifecycle, and masks suspected credentials so it remains available after disconnecting.",
  "保存中…": "Saving…",
  无法把调用快照固定到桌面:
    "Unable to pin the invocation snapshot to the desktop",
  "已保存为跨会话只读档案。": "Saved as a read-only cross-session archive.",
  查看桌面档案: "View desktop archive",
  "本机 JVM 发现与 Attach": "Local JVM discovery and Attach",
  "发现进程、核对 JDK 与身份并建立本地诊断会话。":
    "Discover processes, verify JDK and identity, and establish a local diagnostic session.",
  "SSH 与 Kubernetes 目标": "SSH and Kubernetes targets",
  "预检远程组件、隧道、授权与临时 Relay 生命周期。":
    "Preflight remote components, tunnels, authorization, and temporary Relay lifecycle.",
  实时诊断概览: "Live diagnostic overview",
  "查看 CPU、线程、Heap、类加载和 GC 有界趋势。":
    "Inspect bounded CPU, thread, Heap, class-loading, and GC trends.",
  "JVM 事实与启动参数": "JVM facts and startup arguments",
  "检查 JVM、运行时参数、内存池和 GC Collector 摘要。":
    "Inspect JVM facts, runtime arguments, memory pools, and GC collector summaries.",
  "System Property Inspector": "System Property Inspector",
  "按名称和类别检索系统属性，安全值可进入修改预检。":
    "Search system properties by name and category, then send safe values to mutation preflight.",
  "Environment Explorer": "Environment Explorer",
  "检查启动环境变量，并在 Agent 内遮罩秘密值。":
    "Inspect startup environment variables while masking secret values inside the Agent.",
  "VM Option Inspector": "VM Option Inspector",
  "搜索 HotSpot 诊断选项、来源和可写性。":
    "Search HotSpot diagnostic options, origins, and writeability.",
  受控运行时修改: "Controlled runtime mutations",
  "对系统属性、VM Option、日志级别和 GC 执行风险预检。":
    "Risk-preflight system properties, VM Options, logger levels, and GC requests.",
  "PerfCounter 检查与趋势": "PerfCounter inspection and trends",
  "搜索 HotSpot 内部计数器，固定指标并比较变化速率。":
    "Search HotSpot internal counters, pin metrics, and compare change rates.",
  "JIT 编译器与 Code Cache": "JIT compiler and Code Cache",
  "聚合编译、OSR、失败、失效和分段代码缓存趋势。":
    "Aggregate compilation, OSR, failure, invalidation, and segmented code-cache trends.",
  "MBean Inspector": "MBean Inspector",
  "检索元数据、展开 OpenType 值并受控调用操作。":
    "Search metadata, expand OpenType values, and invoke controlled operations.",
  "检索元数据、展开并受控修改 OpenType 值，以及调用操作。":
    "Search metadata, expand and safely change OpenType values, and invoke operations.",
  "Logger Center": "Logger Center",
  "检查并漂移安全地修改 JUL、Logback、Log4j 1.x 与 Log4j2 级别。":
    "Inspect and drift-safely change JUL, Logback, Log4j 1.x, and Log4j2 levels.",
  "搜索并检查 JUL、Logback、Log4j 1.x 与 Log4j2 的上下文、级别和输出目标。":
    "Search and inspect JUL, Logback, Log4j 1.x, and Log4j2 contexts, levels, and output targets.",
  "线程 CPU 与完整堆栈": "Thread CPU and full stacks",
  "按名称、状态和 CPU 排序筛选线程并检查调用栈。":
    "Filter threads by name, state, and CPU order, then inspect call stacks.",
  热点线程差分排行: "Hot-thread interval ranking",
  "按相邻采样 CPU 增量定位热点线程、单核占用和栈顶。":
    "Rank threads by CPU delta between samples, with single-core usage and top-frame evidence.",
  "当前采样窗口的热点线程。": "Hot threads in the current sample window.",
  "按相邻样本 CPU 增量排序；百分比表示单线程占用一个逻辑核心的近似比例。":
    "Ranked by CPU delta between adjacent samples. Percent approximates one thread's share of a logical core.",
  "在线程列表中定位 #{id} · {name}": "Locate #{id} · {name} in the thread list",
  没有可用栈顶: "No top frame available",
  "这一窗口没有可比较的 CPU 增量；首个样本只建立基线。":
    "This window has no comparable CPU delta; the first sample only establishes a baseline.",
  线程连续趋势: "Continuous thread trends",
  "观察线程状态、生命周期、死锁和可用 CPU 速率。":
    "Observe thread states, lifecycle, deadlocks, and available CPU rates.",
  线程双快照差异: "Two-snapshot thread diff",
  "比较新增、退出、状态、锁持有者和 CPU 增量。":
    "Compare created and exited threads, states, lock owners, and CPU deltas.",
  锁关系与死锁: "Lock relationships and deadlocks",
  "沿等待者到持有者关系检查 Monitor 与 Synchronizer。":
    "Inspect monitors and synchronizers along waiter-to-owner relationships.",
  线程池检查器: "Thread-pool inspector",
  "识别 JDK 执行器、精确成员、线程组、队列和完成计数。":
    "Identify JDK executors and inspect exact members, thread groups, queues, and completion counts.",
  "Thread Dump 与自动差异": "Thread Dump and automatic diff",
  "采集校验制品，在应用内检查并比较两份线程转储。":
    "Collect a verified artifact, inspect it in-app, and compare two thread dumps.",
  线程中断预检: "Thread interruption preflight",
  "绑定精确线程身份，在双确认后请求中断。":
    "Bind an exact thread identity and request interruption after two confirmations.",
  已加载类与方法搜索: "Loaded class and method search",
  "按 Agent 分页搜索类、加载器、来源和方法签名。":
    "Search classes, loaders, origins, and method signatures with Agent-side paging.",
  "ClassLoader 树与 Metaspace": "ClassLoader tree and Metaspace",
  "检查父子关系、URL、类数量和元空间占用。":
    "Inspect parent relationships, URLs, class counts, and Metaspace use.",
  类资源来源冲突: "Class resource origin conflicts",
  "沿精确 ClassLoader 定位同名资源的全部可见来源。":
    "Locate every visible origin of a same-named resource along an exact ClassLoader.",
  静态字段检查器: "Static-field inspector",
  "先看字段元数据，再受控读取单个安全值。":
    "Inspect field metadata first, then read one safe value under control.",
  "Class Dump 与反编译": "Class Dump and decompilation",
  "捕获精确加载类并使用内置 CFR 生成可检查源码。":
    "Capture an exact loaded class and generate inspectable source with bundled CFR.",
  多类原子变更与回滚: "Atomic multi-class change and rollback",
  "联合编译 2—8 个类，整组预检后原子提交或恢复。":
    "Compile 2–8 classes together, then atomically apply or restore after group preflight.",
  "Heap 实例与对象关系": "Heap instances and object relationships",
  "按精确类扫描实例，并沿出向或入向引用继续检查。":
    "Scan instances of an exact class and continue along outgoing or incoming references.",
  "对象图与 GC Root 路径": "Object graphs and GC Root paths",
  "生成有界多层对象图，并回溯多条较短保留路径。":
    "Build bounded multi-level object graphs and trace several shorter retention paths.",
  "Retained Size 与支配分析": "Retained Size and dominator analysis",
  "计算单对象、批量和类级 retained size 与支配关系。":
    "Compute single-object, batch, and class-level retained sizes and domination.",
  "方法 Watch 与来源栈": "Method Watch and source stacks",
  "有界捕获参数、返回、异常、耗时和调用来源栈。":
    "Bounded capture of arguments, returns, exceptions, duration, and source stacks.",
  调用快照与安全重放: "Invocation snapshots and safe replay",
  "跨任务检索调用证据、精确删除并预检静态标量重放。":
    "Search invocation evidence across tasks, delete exactly, and preflight static scalar replay.",
  "跨类调用 Trace": "Cross-class invocation Trace",
  "按包和路径规则生成调用树，并聚合自耗时热点。":
    "Generate call trees by package and path rules, then aggregate self-time hotspots.",
  周期方法监控: "Periodic method monitoring",
  "观察调用量、成功率、异常率和 P95/P99 耗时趋势。":
    "Observe call volume, success and error rates, and P95/P99 latency trends.",
  "CPU 与 Wall Profiler": "CPU and Wall Profiler",
  "启动有界采样任务，并在隔离窗口检查火焰图。":
    "Start a bounded sampling task and inspect its flame graph in an isolated window.",
  "Allocation 与 Lock Profiler": "Allocation and Lock Profiler",
  "定位分配热点和锁竞争采样证据。":
    "Locate allocation hotspots and sampled lock-contention evidence.",
  "JFR 录制与事件检查": "JFR recording and event inspection",
  "录制 profile 事件并检查热点、分配、CPU、GC 与编译。":
    "Record profile events and inspect hotspots, allocation, CPU, GC, and compilation.",
  "Heap Dump": "Heap Dump",
  "以高风险预检生成受配额保护的 HPROF 制品。":
    "Generate a quota-protected HPROF artifact behind high-risk preflight.",
  "Heap 类直方图": "Heap class histogram",
  "Heap 双快照差分": "Heap two-snapshot diff",
  "比较同一 JVM 两次类直方图，定位实例与浅大小增长。":
    "Compare two class histograms from the same JVM to locate instance and shallow-byte growth.",
  "Heap 跨会话差分": "Cross-session Heap diff",
  "重新校验并比较两份持久化类直方图证据。":
    "Revalidate and compare two persisted class-histogram artifacts.",
  "按类名范围统计实例数量、浅大小和平均浅大小。":
    "Count instances, shallow size, and average shallow size within a class-name scope.",
  "Heap Dominator Tree": "Heap Dominator Tree",
  "从虚拟 GC Root 沿最大 retained 路径交互下钻。":
    "Interactively drill from the virtual GC Root along the largest retained paths.",
  "活动任务与会话 Reset": "Active tasks and session Reset",
  "统一取消观测任务并恢复探微持有的类定义。":
    "Cancel observation tasks together and restore class definitions owned by Tanwei.",
  "结构化 Expert Console": "Structured Expert Console",
  "通过 Action Schema 校验参数，不发送任意文本命令。":
    "Validate parameters with Action Schema and never send arbitrary text commands.",
  诊断制品管理: "Diagnostic artifact management",
  "校验、定位、检查和清理 JFR、Dump 与报告制品。":
    "Verify, locate, inspect, and clean JFR, dump, and report artifacts.",
  诊断案例与证据: "Diagnostic cases and evidence",
  "组织笔记、任务、证据和脱敏导入导出。":
    "Organize notes, tasks, evidence, and redacted import or export.",
  多目标运行时对比: "Multi-target runtime comparison",
  "并发采样 2—8 个 READY JVM 并比较相对基线。":
    "Concurrently sample 2–8 READY JVMs and compare relative baselines.",
  签名诊断模板与插件: "Signed diagnostic templates and plugins",
  "管理只允许 R0/R1 Action 的签名模板和声明式插件。":
    "Manage signed templates and declarative plugins limited to R0/R1 Actions.",
  团队策略包: "Team policy packages",
  "验证签名、有效期和只降权的组织级 Action 策略。":
    "Verify signatures, validity windows, and downgrade-only organizational Action policies.",
  "设置、更新与支持包": "Settings, updates, and support bundles",
  "管理语言、存储、更新通道和脱敏支持信息。":
    "Manage language, storage, update channels, and redacted support information.",
  主导航: "Primary navigation",
  工作模式: "Workspace mode",
  诊断: "Diagnostics",
  连接新目标: "Connect new target",
  添加连接: "Add connection",
  "从一个 JVM 开始。": "Start with a JVM.",
  "探微会在连接前确认目标身份与 Attach 能力，所有诊断动作都留在本机。":
    "Tanwei verifies target identity and Attach capability before connecting. All diagnostics remain on this machine.",
  "扫描当前设备上的 Java 进程": "Scan Java processes on this device",
  "适合第一次使用，也可以随时重新扫描。":
    "Ideal for first use, and available whenever you need to scan again.",
  扫描本机: "Scan this device",
  验证主机后部署临时组件: "Verify the host, then deploy temporary components",
  "定位 Pod 与容器中的 JVM": "Locate a JVM in a Pod and container",
  "通过 mTLS 连接常驻节点": "Connect to a persistent node over mTLS",
  治理功能: "Governance functions",
  治理中心: "Governance center",
  当前目标: "Current target",
  尚未选择目标: "No target selected",
  诊断模板列表: "Diagnostic template list",
  模板: "Templates",
  新建模板: "New template",
  创建诊断模板: "Create diagnostic template",
  还没有模板: "No templates yet",
  "创建一个经过签名的诊断动作。": "Create a signed diagnostic action.",
  "创建第一个安全诊断模板。": "Create your first safe diagnostic template.",
  "签名会绑定 Action、参数与来源，执行前仍受风险策略校验。":
    "The signature binds the Action, parameters, and source. Risk policy is still enforced before execution.",
  签名动作与安全默认值: "Signed Actions and safe defaults",
  "并发采集 JVM 快照": "Collect JVM snapshots concurrently",
  验证扩展清单: "Verify extension manifests",
  收紧组织级权限: "Tighten organization-level permissions",
  未选择目标: "No target selected",
  "PID {pid} · 已连接": "PID {pid} · Connected",
  "PID {pid} · 未连接": "PID {pid} · Disconnected",
  未知: "Unknown",
  选择目标: "Select target",
  取消: "Cancel",
  删除: "Delete",
  确认删除: "Confirm deletion",
  重新校验: "Verify again",
  校验通过: "Verified",
  上一页: "Previous",
  下一页: "Next",
  查询: "Query",
  搜索: "Search",
  无: "None",
  不可用: "Unavailable",
  待机: "Idle",
  进行中: "Open",
  已归档: "Archived",
  记录中: "Recording",
  需确认: "Confirmation required",
  不支持: "Unsupported",
  只读: "Read only",
  "边界清楚，默认安全。": "Clear boundaries, safe by default.",
  "设置只保存在本机 SQLite；不提供第二套主题，也不会上传目标数据、凭据或案例。":
    "Settings stay in local SQLite. Tanwei has one visual theme and never uploads target data, credentials, or cases.",
  界面语言: "Interface language",
  简体中文: "Simplified Chinese",
  应用字体: "Application font",
  系统默认: "System default",
  思源黑体: "Source Han Sans",
  现代中文黑体: "Modern Chinese sans",
  霞鹜文楷: "LXGW WenKai",
  思源宋体: "Source Han Serif",
  "探微 JVM 诊断工作台": "Tanwei JVM diagnostic workbench",
  "本机字体优先，同类字体自动回退。":
    "Uses locally installed fonts first, with automatic fallback to a similar family.",
  "标题、正文、表格、控件和代码区域统一使用所选字体。":
    "The selected font is applied consistently to headings, body text, tables, controls, and code areas.",
  默认采样间隔: "Default sampling interval",
  "1 秒": "1 second",
  "2 秒": "2 seconds",
  "5 秒": "5 seconds",
  "10 秒": "10 seconds",
  "本地配额（GiB）": "Local quota (GiB)",
  "保留天数（0 表示不自动清理）":
    "Retention days (0 disables automatic cleanup)",
  更新策略: "Update policy",
  允许的最高风险等级: "Maximum allowed risk level",
  "只读、采样与有界增强": "Read-only, sampling, and bounded enhancement",
  同时允许运行时修改: "Also allow runtime mutations",
  同时允许双确认进程级操作:
    "Also allow process-level actions with two confirmations",
  "主进程会拒绝高于此等级的 Action；页面确认或直接构造 IPC 都不能绕过。":
    "The main process rejects Actions above this level. UI confirmation or direct IPC construction cannot bypass it.",
  系统诊断提醒: "System diagnostic notifications",
  "仅严重事件（推荐）": "Critical events only (recommended)",
  警告与严重事件: "Warning and critical events",
  关闭系统提醒: "Disable system notifications",
  "只在窗口隐藏、最小化或失焦时发送系统通知；普通基线仍仅保留在应用内，点击通知会回到精确校验证据。":
    "System notifications are sent only while the window is hidden, minimized, or unfocused. Informational baselines remain in-app, and clicking a notification opens its exact verified evidence.",
  系统提醒已关闭: "System notifications disabled",
  仅严重事件: "Critical events only",
  发现签名更新时通知: "Notify when a signed update is available",
  仅手动检查: "Manual checks only",
  "更新只有在发布者签名、版本说明与组件清单校验全部通过后才可安装。":
    "An update can be installed only after its publisher signature, release notes, and component manifest are verified.",
  手动检查: "Check now",
  确认说明并下载: "Review and download",
  确认重启安装: "Restart and install",
  "支持包只包含版本、平台、设计基线、设置摘要和对象计数；不包含路径、环境值、系统属性值、凭据、密钥或实时对象。":
    "The support bundle contains only versions, platform details, the design baseline, a settings summary, and object counts. It excludes paths, environment and system-property values, credentials, secrets, and live objects.",
  生成本地支持包: "Generate local support bundle",
  "已生成 {name} · SHA-256 {sha256}": "Generated {name} · SHA-256 {sha256}",
  "设置已写入事务。": "Settings committed in a transaction.",
  保存设置: "Save settings",
  无法读取设置: "Unable to read settings",
  无法检查签名更新: "Unable to check for signed updates",
  无法下载更新: "Unable to download update",
  无法安装更新: "Unable to install update",
  无法保存设置: "Unable to save settings",
  无法生成本地支持包: "Unable to generate local support bundle",
  "选择目标。": "Choose a target.",
  "发现当前用户可见的 Java 进程。Attach 前会重新验证 PID、权限、运行时与协议身份。":
    "Discover Java processes visible to the current user. PID, permissions, runtime, and protocol identity are revalidated before Attach.",
  筛选进程: "Filter processes",
  "PID、主类、JAR 或参数": "PID, main class, JAR, or argument",
  刷新目标: "Refresh targets",
  发现失败: "Discovery failed",
  未命名Java进程: "Unnamed Java process",
  主类未知: "Main class unknown",
  用户未知: "User unknown",
  Java路径未知: "Java path unknown",
  启动时间未知: "Start time unknown",
  已连接: "Connected",
  可Attach: "Attach available",
  不可Attach: "Attach unavailable",
  断开: "Disconnect",
  连接: "Connect",
  "没有发现匹配的 Java 进程。": "No matching Java processes found.",
  "请启动目标 JVM，或检查当前用户是否拥有查看和 Attach 权限。":
    "Start the target JVM, or verify that the current user has process visibility and Attach permission.",
  "运行时事实。": "Runtime facts.",
  "JVM 内部计数器，不再藏在命令行。":
    "JVM internal counters, no longer hidden in the command line.",
  "搜索 HotSpot 暴露的类加载、编译器、GC 与运行时计数器；每次只读有界快照，不执行表达式，也不调用业务代码。":
    "Search class loading, compiler, GC, and runtime counters exposed by HotSpot. Every request is a bounded read-only snapshot that runs no expressions or application code.",
  "看清 JIT 编译器正在做什么。": "See what the JIT compiler is doing.",
  "聚合 CompilationMXBean、Code Cache 与 HotSpot 编译计数器；只保留最近 120 个内存样本，不执行命令或业务代码。":
    "Aggregate CompilationMXBean, Code Cache, and HotSpot compiler counters. Retain only the latest 120 in-memory samples without running commands or application code.",
  等待编译器快照: "Waiting for a compiler snapshot",
  "开始 JIT 连续采样": "Start continuous JIT sampling",
  "停止 JIT 连续采样": "Stop continuous JIT sampling",
  刷新编译器快照: "Refresh compiler snapshot",
  "清空 JIT 历史": "Clear JIT history",
  "无法读取 JIT 编译器状态": "Unable to read JIT compiler status",
  累计编译: "Total compilations",
  "{rate} 次/秒": "{rate} per second",
  "标准 / OSR": "Standard / OSR",
  常规编译与栈上替换: "Regular compilation and on-stack replacement",
  编译线程时间: "Compiler thread time",
  "窗口占比 {percent}%": "{percent}% of the sample window",
  "失败 / 失效速率": "Failure / invalidation rate",
  代码缓存: "Code cache",
  "{percent}% 已使用": "{percent}% used",
  累计编译趋势: "Cumulative compilation trend",
  "JIT 累计编译趋势": "JIT cumulative compilation trend",
  代码缓存使用趋势: "Code cache usage trend",
  "{rate}/秒": "{rate}/second",
  "每个 Code Heap 都有独立边界。":
    "Each Code Heap has an independent boundary.",
  "{count} 个内存池": "{count} memory pools",
  "峰值 {peak} · 已提交 {committed}": "Peak {peak} · committed {committed}",
  "当前 JVM 没有公开 Code Cache 内存池。":
    "The current JVM exposes no Code Cache memory pools.",
  最近成功编译: "Latest successful compilation",
  最近编译失败: "Latest failed compilation",
  最近失效编译: "Latest invalidated compilation",
  暂无内部计数器证据: "No internal-counter evidence yet",
  "类型 {type} · 大小 {size}": "Type {type} · size {size}",
  "JIT 快照为部分结果": "The JIT snapshot is partial",
  "内部计数器或 Code Cache 内存池达到有界读取上限；MXBean 指标仍然有效。":
    "Internal counters or Code Cache pools reached a bounded read limit; MXBean metrics remain valid.",
  "正在聚合编译器、Code Cache 与内部计数器…":
    "Aggregating the compiler, Code Cache, and internal counters…",
  "刷新后查看 JIT 编译器快照。": "Refresh to inspect a JIT compiler snapshot.",
  "JIT 深度证据检查器": "Deep JIT evidence inspector",
  "把实时异常接到 C1 / C2 录制证据。":
    "Connect live anomalies to recorded C1 / C2 evidence.",
  "PerfCounter 不提供编译层级和去优化原因；这里使用目标 JDK 的 JFR 事件，停止后校验并保存本地制品。":
    "PerfCounters do not expose compilation tiers or deoptimization reasons. This inspector uses JFR events from the target JDK, then verifies and saves a local artifact when recording stops.",
  处理中: "Working",
  "JFR 记录中": "JFR recording",
  录制证据已加载: "Recorded evidence loaded",
  等待录制: "Waiting to record",
  "开始 JIT 证据录制": "Start JIT evidence recording",
  "停止、保存并分析": "Stop, save, and inspect",
  "加载最近 JFR 证据": "Load latest JFR evidence",
  "打开完整 JFR 检查器": "Open full JFR inspector",
  "无法读取 JFR 录制状态": "Unable to read JFR recording status",
  "无法读取 JIT 录制证据": "Unable to read recorded JIT evidence",
  "无法启动 JIT 证据录制": "Unable to start JIT evidence recording",
  "无法停止 JIT 证据录制": "Unable to stop JIT evidence recording",
  "Agent 返回的 JFR 制品描述无效":
    "The Agent returned an invalid JFR artifact descriptor",
  "无法回收 JIT 录制证据": "Unable to collect recorded JIT evidence",
  "需要 JDK 11 或更高版本。": "JDK 11 or later is required.",
  "JIT 证据操作失败": "JIT evidence operation failed",
  编译耗时: "Compilation time",
  "C1 / C2 分层": "C1 / C2 tiers",
  录制期编译热点: "Recorded compilation hotspots",
  "前 {count} 组": "Top {count} groups",
  "总耗时 / 代码": "Total time / code",
  层级未知: "Unknown level",
  "Level {level}": "Level {level}",
  去优化原因与行动: "Deoptimization reasons and actions",
  "Host 已复验真实路径、文件类型、登记大小与 SHA-256；只解析受控 JFR 事件集合。":
    "The Host revalidated the real path, file type, registered size, and SHA-256, and parses only the controlled JFR event set.",
  "实时快照与录制证据各司其职。":
    "Live snapshots and recorded evidence serve different roles.",
  "已找到当前目标最近的 JFR 制品，可直接加载。":
    "The latest JFR artifact for this target is ready to load.",
  "开始录制，复现编译抖动后停止，即可检查 C1、C2 与去优化原因。":
    "Start recording, reproduce the compilation anomaly, then stop to inspect C1, C2, and deoptimization reasons.",
  "JIT 趋势基线与容量告警": "JIT trend baselines and capacity alerts",
  "把短时波动保存成可比较基线。":
    "Save short-term fluctuations as comparable baselines.",
  "保存当前最多 120 个样本；Host 会复验 JVM 周期、时间顺序、单调计数器、大小与 SHA-256。":
    "Save up to 120 current samples. The Host revalidates the JVM cycle, chronology, monotonic counters, size, and SHA-256.",
  最大容量已耗尽: "Maximum capacity exhausted",
  已提交容量已用尽: "Committed capacity consumed",
  高压力: "High pressure",
  压力升高: "Elevated pressure",
  容量正常: "Capacity normal",
  等待容量快照: "Waiting for a capacity snapshot",
  当前使用: "Current usage",
  最大容量: "Maximum capacity",
  已提交容量: "Committed capacity",
  剩余容量: "Remaining capacity",
  使用率: "Usage",
  "Code Cache 使用率": "Code Cache usage",
  "按最大容量判断：80% 压力升高，90% 高压力，100% 已耗尽。":
    "Against maximum capacity: 80% is elevated, 90% is high pressure, and 100% is exhausted.",
  "JVM 未公开完整最大值，当前按已提交容量判断；JVM 仍可能继续扩展 Code Cache。":
    "The JVM did not expose a complete maximum. Pressure is measured against committed capacity, which the JVM may still expand.",
  "刷新编译器快照后计算 Code Cache 压力。":
    "Refresh the compiler snapshot to calculate Code Cache pressure.",
  加入跨版本回归基线: "Add to cross-release regression baselines",
  "Host 将核对主类、JDK 与 JIT 编译器后写入可移植 v2 身份。":
    "The Host verifies the main class, JDK, and JIT compiler before writing a portable v2 identity.",
  工作负载键: "Workload key",
  "例如 checkout-steady-100rps": "For example: checkout-steady-100rps",
  发布标签: "Release label",
  "例如 2026.07.2": "For example: 2026.07.2",
  "保存 JIT 趋势制品": "Save JIT trend artifact",
  "当前 {count} / 120 个样本": "Current: {count} / 120 samples",
  检查并对比基线: "Inspect and compare baselines",
  "无法核对 JIT 趋势所属 JVM":
    "Unable to verify the JVM that owns this JIT trend",
  "至少需要两个同 JVM 周期的有效 JIT 样本":
    "At least two valid JIT samples from the same JVM cycle are required",
  "无法保存 JIT 趋势制品": "Unable to save the JIT trend artifact",
  "JIT 趋势保存失败": "Unable to save JIT trend",
  诊断通知: "Diagnostic alerts",
  "诊断通知，{count} 条未读": "Diagnostic alerts, {count} unread",
  全部标为已读: "Mark all as read",
  "事件由 Host 根据校验制品生成；只保留最近 200 条，本窗口显示最近 50 条。":
    "Events are generated by the Host from verified artifacts. The latest 200 are retained and the latest 50 are shown here.",
  无法读取诊断通知: "Unable to read diagnostic alerts",
  无法标记诊断通知: "Unable to mark the diagnostic alert",
  无法标记全部诊断通知: "Unable to mark all diagnostic alerts",
  "正在读取本地诊断事件…": "Reading local diagnostic events…",
  还没有诊断通知: "No diagnostic alerts yet",
  "保存 JIT 趋势后，基线或容量压力会出现在这里。":
    "After saving a JIT trend, its baseline or capacity pressure will appear here.",
  诊断事件: "Diagnostic events",
  "JIT 基线已保存": "JIT baseline saved",
  "Code Cache 最大容量已耗尽": "Code Cache maximum capacity exhausted",
  "Code Cache 已提交容量已用尽": "Code Cache committed capacity consumed",
  "Code Cache 进入高压力": "Code Cache entered high pressure",
  "Code Cache 压力升高": "Code Cache pressure elevated",
  "窗口峰值 {percent}% · {capacity}": "Window peak {percent}% · {capacity}",
  按最大容量: "against maximum capacity",
  按已提交容量: "against committed capacity",
  标为已读: "Mark as read",
  检查证据: "Inspect evidence",
  证据已删除: "Evidence deleted",
  已耗尽: "Exhausted",
  正常: "Normal",
  "JIT 趋势制品检查器": "JIT trend artifact inspector",
  "把编译与 Code Cache 压力放进长期基线。":
    "Put compilation and Code Cache pressure into long-term baselines.",
  编译速率: "Compilation rate",
  失败速率: "Failure rate",
  编译时间占比: "Compilation time share",
  "Code Cache 压力": "Code Cache pressure",
  窗口峰值压力: "Window peak pressure",
  "校验 JIT Code Cache 趋势图": "Verified JIT Code Cache trend",
  "结束 {ending}% · 峰值 {peak}%": "Ending {ending}% · peak {peak}%",
  "Host 已复验真实路径、普通 JSON、大小、SHA-256、目标、JVM 周期、时间顺序、单调计数器与 Code Cache 容量语义。":
    "The Host revalidated the real path, plain JSON, size, SHA-256, target, JVM cycle, chronology, monotonic counters, and Code Cache capacity semantics.",
  "窗口峰值 {peak}% · 净增长 {growth}":
    "Window peak {peak}% · net growth {growth}",
  "Host 复验的跨发布基线身份。":
    "Cross-release baseline identity verified by the Host.",
  可跨发布比较: "Ready for cross-release comparison",
  工作负载: "Workload",
  发布: "Release",
  目标主类: "Target main class",
  编译器: "Compiler",
  "这是兼容 v1 制品，只能在同一 JVM 周期内比较；新保存时启用“加入跨版本回归基线”即可生成 v2 身份。":
    "This compatible v1 artifact can only be compared within the same JVM cycle. Enable “Add to cross-release regression baselines” when saving to create a v2 identity.",
  "比较两个不重叠的 JIT 运行窗口。":
    "Compare two non-overlapping JIT runtime windows.",
  "比较两个发布版本的等价工作负载。":
    "Compare equivalent workloads across two releases.",
  "允许不同 JVM 与 JDK；Host 会复验工作负载、主类、发布标签、采样间隔、窗口长度和最大容量语义。":
    "Different JVMs and JDKs are allowed. The Host revalidates the workload, main class, release label, sampling interval, window duration, and maximum-capacity semantics.",
  "仅允许同一目标与同一 JVM 启动周期；Host 会重新读取并校验两份制品。":
    "Only the same target and JVM startup cycle are allowed. The Host rereads and verifies both artifacts.",
  "JIT 比较方式": "JIT comparison mode",
  "同 JVM 周期": "Same JVM cycle",
  跨发布回归: "Cross-release regression",
  "基线 JIT 趋势": "Baseline JIT trend",
  "选择较早的 JIT 趋势": "Choose an earlier JIT trend",
  "比较 JIT 窗口": "Compare JIT windows",
  运行回归比较: "Run regression comparison",
  "还需要同一 JVM 周期的一份较早趋势；返回计数器页再次采样并保存。":
    "Another earlier trend from the same JVM cycle is required. Return to Counters, sample again, and save it.",
  "没有兼容基线：需要较早的不同发布标签、不同 JVM 周期、相同工作负载与主类，并保持采样间隔和窗口长度可比。":
    "No compatible baseline was found. Use an earlier artifact from a different release and JVM cycle with the same workload and main class, plus comparable sampling interval and window duration.",
  基线发布: "Baseline release",
  当前发布: "Current release",
  "结束 Code Cache": "Ending Code Cache",
  "峰值 Code Cache": "Peak Code Cache",
  "Code Cache 净增长": "Code Cache net growth",
  压力等级: "Pressure level",
  已变化: "Changed",
  未变化: "Unchanged",
  "只有已就绪的 JIT 趋势制品可以检查":
    "Only ready JIT trend artifacts can be inspected",
  "无法检查 JIT 趋势制品": "Unable to inspect the JIT trend artifact",
  "无法对比 JIT 趋势制品": "Unable to compare JIT trend artifacts",
  "检查 JIT 趋势": "Inspect JIT trend",
  "连接目标后检查 JVM 内部计数器。":
    "Connect a target to inspect JVM internal counters.",
  "当前运行时不支持 PerfCounter 检查器。":
    "The current runtime does not support the PerfCounter inspector.",
  命名空间: "Namespace",
  全部命名空间: "All namespaces",
  其他: "Other",
  搜索计数器: "Search counters",
  "例如 java.cls": "For example, java.cls",
  刷新快照: "Refresh snapshot",
  计数器分类: "Counter categories",
  全部: "All",
  "无法读取 JVM 内部计数器": "Unable to read JVM internal counters",
  扫描已达到安全上限: "The scan reached its safety limit",
  "只检查前 20,000 个计数器；请缩小名称或命名空间范围。":
    "Only the first 20,000 counters were inspected. Narrow the name or namespace filter.",
  "PerfCounter 搜索结果": "PerfCounter search results",
  "正在读取 PerfCounter…": "Reading PerfCounters…",
  "没有匹配的 PerfCounter。": "No matching PerfCounters.",
  尚未采样: "Not sampled yet",
  "采样于 {time}": "Sampled at {time}",
  "JVM 内部": "JVM internal",
  公开计数器: "Public counter",
  "敏感值已在 Agent 内读取前遮罩。":
    "The sensitive value was masked before it was read inside the Agent.",
  "这是只读瞬时快照，不会持续采样。":
    "This is a read-only point-in-time snapshot, not continuous sampling.",
  取消固定: "Unpin",
  固定到趋势: "Pin to trends",
  "该计数器已固定到下方趋势工作区。":
    "This counter is pinned to the trend workspace below.",
  "固定后可进行有界连续采样与跨快照差异。":
    "Pin this counter for bounded continuous sampling and snapshot-to-snapshot differences.",
  "当前值不是可安全计算差异的标量数值。":
    "The current value is not a scalar number that can be compared safely.",
  "把内部计数器固定成时间序列。": "Turn internal counters into time series.",
  "一次读取最多 8 个精确名称，历史只保留最近 120 个内存样本；停止或离开页面会释放定时器。":
    "Each read accepts up to 8 exact names. Only the latest 120 in-memory samples are retained, and the timer is released when sampling stops or the page is left.",
  连续采样中: "Sampling continuously",
  "{count} 个已固定": "{count} pinned",
  采样间隔: "Sampling interval",
  开始连续采样: "Start continuous sampling",
  停止连续采样: "Stop continuous sampling",
  立即采样: "Sample now",
  清空历史: "Clear history",
  无法采样固定计数器: "Unable to sample pinned counters",
  "Agent返回了无效的 PerfCounter 快照":
    "The Agent returned an invalid PerfCounter snapshot",
  快照未覆盖全部固定指标: "The snapshot did not cover every pinned counter",
  "缺失 {missing} 个指标，扫描 {scanned} 个计数器；边界截断 {truncated}。":
    "{missing} counters were missing after scanning {scanned}; boundary truncated: {truncated}.",
  固定指标: "Pinned counters",
  样本窗口: "Sample window",
  采样周期: "Sampling period",
  最近采样: "Latest sample",
  "{seconds} 秒": "{seconds} seconds",
  移除: "Remove",
  当前值: "Current value",
  相邻差异: "Adjacent difference",
  每秒速率: "Rate per second",
  "{name} 最近 {count} 个样本趋势":
    "Trend of the latest {count} samples for {name}",
  "{count} 个数值样本": "{count} numeric samples",
  "先从上方详情固定一个数值计数器。":
    "Pin a numeric counter from the details above first.",
  "向量、遮罩值、非数值和超出 JavaScript 安全整数范围的值不会进入趋势计算。":
    "Vectors, masked values, non-numeric values, and integers beyond JavaScript's safe range are excluded from trend calculations.",
  单位: "Units",
  变化语义: "Variability",
  值类型: "Value type",
  向量长度: "Vector length",
  "只观察 JVM 自己维护的计数器。":
    "Observe only counters maintained by the JVM itself.",
  "不会执行 OGNL、脚本或任意命令；未知对象类型不会调用 toString，数组只展示前 64 项，单值最多 4,096 个字符。":
    "No OGNL, scripts, or arbitrary commands are executed. Unknown objects never receive toString calls; arrays show at most 64 elements and a single value at most 4,096 characters.",
  "选择一个计数器查看值与元数据。":
    "Select a counter to inspect its value and metadata.",
  "Agent 返回了无效的快照详情": "The Agent returned invalid snapshot details",
  "{count} 个参数": "{count} arguments",
  "{count} 层来源": "{count} source frames",
  高级筛选: "Advanced filters",
  "正在搜索…": "Searching…",
  精确缩小调用证据: "Narrow invocation evidence precisely",
  "任务与线程使用精确/包含匹配；耗时单位为毫秒，0 或留空表示不设边界。":
    "Task uses exact matching and thread uses substring matching; duration is in milliseconds, and 0 or empty means no boundary.",
  清除高级筛选: "Clear advanced filters",
  "精确任务 ID": "Exact task ID",
  线程名称包含: "Thread name contains",
  重放状态: "Replay state",
  全部重放状态: "All replay states",
  当前可重放: "Currently replayable",
  "最小耗时（ms）": "Minimum duration (ms)",
  "最大耗时（ms）": "Maximum duration (ms)",
  "0 = 不限": "0 = unlimited",
  耗时筛选必须是非负整数毫秒:
    "Duration filters must be non-negative integer milliseconds",
  "耗时筛选必须在 0 到 3600000 毫秒之间":
    "Duration filters must be between 0 and 3,600,000 milliseconds",
  "最大耗时必须为 0 或不小于最小耗时":
    "Maximum duration must be 0 or at least the minimum duration",
  "{count} 个标量字段": "{count} scalar fields",
  "扫描 {count} 个字段": "Scanned {count} fields",
  "{count} 个不可读取": "{count} unavailable",
  "实例状态不可读取。": "Instance state is unavailable.",
  "未发现可安全读取的实例标量字段。":
    "No safely readable instance scalar fields were found.",
  字段: "Field",
  捕获值: "Captured value",
  之前: "Before",
  之后: "After",
  捕获时实例状态: "Instance state at capture",
  "在目标方法退出时读取最多 16 个实例标量字段；敏感字段遮罩，不调用业务 toString()。":
    "Read at most 16 instance scalar fields when the target method exits; sensitive fields are masked and business toString() methods are never called.",
  捕获后的实例状态漂移: "Instance state drift since capture",
  "比较调用捕获现场与本次重放预检；这是当前标量字段证据，不会阻止并发业务继续修改实例。":
    "Compare the captured invocation with this replay preview. This is current scalar-field evidence and does not stop concurrent business code from modifying the instance.",
  "未发现捕获后标量字段变化。":
    "No scalar-field changes were found since capture.",
  本次重放前后实例变化: "Instance changes across this replay",
  "比较执行前后同一实例的有界标量字段；并发写入可能同时发生，因此只作为观测证据，不单独证明因果。":
    "Compare bounded scalar fields on the same instance before and after execution. Concurrent writes may also occur, so this is observational evidence and does not prove causality by itself.",
  "本次重放前后未发现标量字段变化。":
    "No scalar-field changes were found across this replay.",
  结构化调用上下文: "Structured invocation context",
  "在目标方法退出时展开参数、返回值与白名单 JDK 集合；最多 96 个节点、3 层深度和每节点 16 个子项，敏感字段及 Map 值遮罩且不调用业务 toString()。此证据只保留在当前 Agent 会话。":
    "Expand arguments, return values, and allowlisted JDK collections when the target method exits, bounded to 96 nodes, depth 3, and 16 children per node. Sensitive fields and Map values are masked, and business toString() methods are never called. This evidence remains only in the current Agent session.",
  "结构化调用上下文不可读取。": "Structured invocation context is unavailable.",
  "此调用没有可展开的参数或返回值。":
    "This invocation has no expandable arguments or return value.",
  "{count} 个结构节点": "{count} structured nodes",
  "{count} 个子项": "{count} children",
  设为比较基线: "Set as comparison baseline",
  替换比较基线: "Replace comparison baseline",
  当前比较基线: "Current comparison baseline",
  清除比较基线: "Clear comparison baseline",
  结构字段差异: "Structured field differences",
  "基线 #{baseline} → 当前 #{current}；仅比较同一精确类、ClassLoader 与方法签名，使用两份会话内安全结构树。":
    "Baseline #{baseline} → current #{current}. Only the same exact class, ClassLoader, and method signature are compared using two session-only safe trees.",
  "当前快照已固定为基线；请从左侧选择另一条快照进行比较。":
    "The current snapshot is the baseline. Select another snapshot on the left to compare.",
  "只能比较同一精确类、ClassLoader 与方法签名的调用快照。":
    "Only invocation snapshots from the same exact class, ClassLoader, and method signature can be compared.",
  "至少一条快照缺少结构化调用上下文，无法比较字段。":
    "At least one snapshot lacks structured invocation context, so fields cannot be compared.",
  "{count} 个变化": "{count} changed",
  "{count} 个新增": "{count} added",
  "{count} 个移除": "{count} removed",
  "{count} 个未变化": "{count} unchanged",
  部分比较: "Partial comparison",
  "两次调用未发现结构字段差异。":
    "No structured field differences were found between the invocations.",
  基线值: "Baseline value",
  节点: "Node",
  种类: "Kind",
  截断: "Truncated",
  对象: "Object",
  映射: "Map",
  键值项: "Entry",
  引用: "Reference",
  不可读取: "Unavailable",
  不展开: "Opaque",
  二次确认并执行快照重放: "Confirm twice and replay snapshot",
  "公开静态标量方法；执行前重新解析类与方法并生成指纹":
    "Public static scalar methods; resolve the class and method again and create a fingerprint before execution",
  "仅持有原实例的弱引用；执行前重新校验快照、接收者身份与方法指纹":
    "Only a weak reference to the original instance is retained; revalidate the snapshot, receiver identity, and method fingerprint before execution",
  仅根调用: "Root calls only",
  "从安全字符串参数重新调用。":
    "Invoke again from safely rendered string arguments.",
  "在原实例接收者上重新调用。":
    "Invoke again on the original instance receiver.",
  重放接收者: "Replay receiver",
  重放模式: "Replay mode",
  状态边界: "State boundary",
  原实例: "Original instance",
  原实例可用: "Original instance available",
  原实例已回收: "Original instance reclaimed",
  静态方法: "Static method",
  不可重放: "Not replayable",
  "实例状态可能已变化，弱引用也可能在执行前失效。":
    "Instance state may have changed, and the weak reference may expire before execution.",
  "静态方法不依赖实例接收者。":
    "Static methods do not depend on an instance receiver.",
  会话内存: "Session memory",
  全部结果: "All outcomes",
  "内存 / 淘汰": "Memory / evicted",
  删除此快照: "Delete this snapshot",
  包含内部调用: "Include internal calls",
  "只有公开方法、最多 8 个完整标量参数的根调用可以进入受控重放；实例方法还要求原接收者仍然存活。":
    "Controlled replay is available only for root calls to public methods with at most eight complete scalar arguments; instance methods also require the original receiver to remain alive.",
  "原实例已被目标 JVM 回收；请重新捕获一次调用快照。":
    "The target JVM reclaimed the original instance; capture a new invocation snapshot.",
  "当前 Agent 不支持调用快照索引。":
    "The current Agent does not support the invocation snapshot index.",
  当前保留: "Currently retained",
  "我再次确认接受业务副作用，超时或中断不保证目标代码停止。":
    "I confirm again that I accept business side effects and that timeout or interruption does not guarantee target code stops.",
  "我已核对快照、目标方法、参数和最终调用，并理解它会再次真实执行。":
    "I have verified the snapshot, target method, arguments, and final invocation, and understand that it will execute again.",
  "我确认从当前 Agent 会话中删除快照 #{id}；原始调用不会受到影响。":
    "I confirm deleting snapshot #{id} from the current Agent session; the original invocation is unaffected.",
  "把一次调用，变成可检索证据。":
    "Turn one invocation into searchable evidence.",
  抛出异常: "Threw exception",
  捕获时间: "Captured at",
  搜索快照: "Search snapshots",
  无法删除调用快照: "Unable to delete the invocation snapshot",
  无法读取快照详情: "Unable to read snapshot details",
  无法读取调用快照: "Unable to read invocation snapshots",
  校验指纹: "Verification fingerprint",
  "根 / 内部": "Root / internal",
  "正在读取快照详情…": "Reading snapshot details…",
  "正在读取调用快照…": "Reading invocation snapshots…",
  正常返回: "Returned normally",
  "此快照只用于检查。": "This snapshot is available for inspection only.",
  "此调用没有参数。": "This invocation has no arguments.",
  "没有可用的来源栈。": "No source call stack is available.",
  生成安全重放预检: "Create safe replay preview",
  管理此快照: "Manage this snapshot",
  "类、方法、线程、参数或异常": "Class, method, thread, argument, or exception",
  结果: "Result",
  调用层级: "Call depth",
  调用快照列表: "Invocation snapshot list",
  调用结果: "Invocation outcome",
  "跨观测任务检索调用时间、耗时、线程、参数、结果与来源栈；快照只保存安全字符串，并以弱引用关联可重放的原实例。":
    "Search captured time, duration, thread, arguments, outcome, and source stack across observation tasks. Snapshots keep safe strings and only weakly reference live replay receivers.",
  返回值: "Return value",
  "还没有匹配的调用快照。": "No matching invocation snapshots yet.",
  "连接目标后检查调用快照。":
    "Connect a target to inspect invocation snapshots.",
  "选择一个调用快照查看完整上下文。":
    "Select an invocation snapshot to inspect its full context.",
  "所有查询通过主进程 Action Policy 与 Agent allowlist 双重校验；Renderer 不拥有执行权限。":
    "Every query is checked by both the main-process Action Policy and the Agent allowlist. The Renderer has no execution authority.",
  "连接目标后读取运行时信息。":
    "Connect a target to inspect runtime information.",
  "管理接口，逐项检查。": "Inspect management interfaces one item at a time.",
  "搜索已注册 MBean，先检查元数据，再按需读取单个属性；不会批量触发未知 Getter。":
    "Search registered MBeans, inspect metadata first, then read one attribute on demand. Unknown getters are never invoked in bulk.",
  "搜索已注册 MBean，按需读取单个属性；操作调用必须经过精确预检、R4 双确认和结果留痕。":
    "Search registered MBeans and read one attribute on demand. Operation calls require an exact preview, two R4 confirmations, and result history.",
  "搜索已注册 MBean；属性修改和操作调用都必须经过精确预检、R4 双确认和结果留痕。":
    "Search registered MBeans. Attribute changes and operation calls both require an exact preview, two R4 confirmations, and result history.",
  "连接目标后检查 MBean。": "Connect a target to inspect MBeans.",
  "当前 Agent 不支持 MBean 检查器。":
    "The current Agent does not support the MBean inspector.",
  "请重新连接目标以加载最新 Agent。":
    "Reconnect the target to load the latest Agent.",
  "搜索 ObjectName": "Search ObjectName",
  "例如 java.lang:type=Memory": "For example, java.lang:type=Memory",
  "无法读取 MBean 列表": "Unable to read the MBean list",
  "无法读取 MBean 元数据": "Unable to read MBean metadata",
  "无法读取 MBean 属性": "Unable to read the MBean attribute",
  "{label} 超出安全边界。": "{label} exceeded its safety boundary.",
  "MBean 属性节点数": "MBean attribute node count",
  "MBean 属性节点索引": "MBean attribute node index",
  "MBean 属性父节点索引": "MBean attribute parent node index",
  "MBean 属性节点深度": "MBean attribute node depth",
  "MBean 属性子节点数": "MBean attribute child count",
  "MBean 属性已展示子节点数": "MBean attribute displayed child count",
  "MBean 属性结构响应无效。":
    "The structured MBean attribute response is invalid.",
  "MBean 属性结构层级无效。":
    "The structured MBean attribute hierarchy is invalid.",
  "MBean 属性结构子节点计数无效。":
    "The structured MBean attribute child count is invalid.",
  空值: "Null",
  标量: "Scalar",
  数组: "Array",
  集合: "Collection",
  不透明对象: "Opaque object",
  循环引用: "Cycle",
  深度上限: "Depth limit",
  集合项上限: "Collection entry limit",
  字符上限: "Character limit",
  "为保护目标 JVM，结果已触达：{boundaries}。":
    "To protect the target JVM, the result reached: {boundaries}.",
  "{count} 个有界结构节点": "{count} bounded structure nodes",
  有界文本值: "Bounded text value",
  文本: "Text",
  "{attribute} 结构化属性值": "Structured value for {attribute}",
  "展开 {key}": "Expand {key}",
  "折叠 {key}": "Collapse {key}",
  "{key} 没有子节点": "{key} has no child nodes",
  "展示 {shown} / {total} 个子节点": "Showing {shown} of {total} child nodes",
  原始有界文本: "Raw bounded text",
  "MBean 操作预检失败": "Unable to preview the MBean operation",
  "MBean 操作调用失败": "Unable to invoke the MBean operation",
  "MBean 属性修改预检失败": "Unable to preview the MBean attribute change",
  "MBean 属性修改失败": "Unable to change the MBean attribute",
  "MBean 搜索结果": "MBean search results",
  "{count} 个匹配": "{count} matches",
  "正在读取 MBean…": "Reading MBeans…",
  "没有匹配的 MBean。": "No matching MBeans.",
  "{start}–{end} / {total}": "{start}–{end} / {total}",
  "正在读取 MBean 元数据…": "Reading MBean metadata…",
  已注册: "Registered",
  "{count} 个属性": "{count} attributes",
  "只在点击时读取单个 Getter": "A single getter runs only when requested",
  可读: "Readable",
  不可读: "Not readable",
  可写: "Writeable",
  读取值: "Read value",
  配置修改: "Configure change",
  "只写属性无法核对旧值，受控修改已禁用。":
    "Controlled changes are disabled for write-only attributes because the old value cannot be verified.",
  "属性使用复杂对象类型，受控修改已禁用。":
    "Controlled changes are disabled because the attribute uses a complex object type.",
  "属性类型不属于可安全构造的标量或有界 JMX OpenType。":
    "The attribute is not a safely constructible scalar or bounded JMX OpenType.",
  "Agent 拒绝了此属性修改。": "The Agent denied this attribute change.",
  "先锁定旧值，再提交新值。":
    "Lock the old value before submitting a new value.",
  输入标量属性值: "Enter a scalar attribute value",
  "OpenType JSON 新值": "New OpenType JSON value",
  "输入符合下方 Schema 的 JSON": "Enter JSON matching the schema below",
  Schema: "Schema",
  值格式: "Value format",
  "最多 32 KiB、5 层、256 节点，每个容器 50 项。":
    "At most 32 KiB, 5 levels, 256 nodes, and 50 items per container.",
  "当前值超过复合 OpenType 编辑边界，无法安全生成写入预览。":
    "The current value exceeds the composite OpenType editing boundary, so a safe write preview cannot be generated.",
  读取旧值并生成预检: "Read old value and create preview",
  类型: "Type",
  恢复能力: "Restore capability",
  可生成恢复预览: "A restore preview can be generated",
  "旧值为空，无法自动恢复":
    "The old value is null and cannot be restored automatically",
  "Setter 可能产生不可逆副作用；Agent 会在写入前再次核对旧值，3 秒超时不保证 Setter 停止。":
    "The setter may have irreversible side effects. The Agent checks the old value again immediately before writing, and a 3-second timeout does not guarantee the setter stops.",
  "我确认将 {objectName} 的 {attribute} 从 {oldValue} 修改为 {newValue}，Setter 可能立即产生业务副作用。":
    "I confirm changing {attribute} on {objectName} from {oldValue} to {newValue}; the setter may immediately cause business side effects.",
  "我确认将 {objectName} 的 {attribute} 写入已预检的复合 OpenType 值，Setter 可能立即产生业务副作用。":
    "I confirm writing the previewed composite OpenType value to {attribute} on {objectName}; the setter may immediately cause business side effects.",
  "我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。":
    "I again confirm that I accept irreversible side effects and understand that an old-value change invalidates this preview.",
  二次确认并修改属性: "Confirm twice and change attribute",
  "最近 {count} 次属性修改": "{count} most recent attribute changes",
  每次恢复仍需重新预检和双确认:
    "Every restore still requires a fresh preview and two confirmations",
  已应用: "Applied",
  生成恢复预览: "Generate restore preview",
  "此 MBean 没有公开属性。": "This MBean exposes no attributes.",
  "{count} 个操作": "{count} operations",
  本页不执行可能改变目标状态的操作:
    "This page does not invoke operations that may change target state",
  "仅支持最多 8 个标量参数的精确调用":
    "Exact invocation supports at most 8 scalar arguments",
  "支持最多 8 个标量或有界 OpenType 参数":
    "Supports up to 8 scalar or bounded OpenType arguments",
  "检索元数据、展开并受控修改 OpenType 值，以及用标量或 OpenType 参数调用操作。":
    "Inspect metadata, expand and safely change OpenType values, and invoke operations with scalar or OpenType arguments.",
  已选择: "Selected",
  配置调用: "Configure invocation",
  "DiagnosticCommand 必须使用探微的专用类型化操作。":
    "DiagnosticCommand must use a dedicated typed Tanwei action.",
  "参数超过 8 个，受控调用已禁用。":
    "Controlled invocation is disabled because the operation has more than 8 arguments.",
  "参数包含不受支持的对象类型，受控调用已禁用。":
    "Controlled invocation is disabled because an argument uses an unsupported object type.",
  "进程终止、命令执行和 Agent 加载操作已被拒绝。":
    "Process termination, command execution, and agent loading operations are denied.",
  "Agent 拒绝了此操作。": "The Agent denied this operation.",
  "先核对调用，再决定是否执行。":
    "Verify the invocation before deciding whether to run it.",
  "R4 · 进程级影响": "R4 · Process-level impact",
  只读低成本: "Read-only, low cost",
  持续或中等成本: "Continuous or moderate cost",
  增强或大结果: "Enhancement or large result",
  标量参数值: "Scalar argument value",
  "按 Schema 输入 JSON": "Enter JSON matching the schema",
  "由 Agent 预检": "Validated by the Agent during preview",
  "复杂参数合计最多 32 KiB；每个 JSON 最多 5 层、256 节点、每个容器 50 项。":
    "Complex arguments total at most 32 KiB; each JSON value is limited to 5 levels, 256 nodes, and 50 items per container.",
  "AGENT 规范化参数": "AGENT NORMALIZED ARGUMENTS",
  "此操作没有参数。": "This operation has no arguments.",
  预检精确调用: "Preview exact invocation",
  返回类型: "Return type",
  边界: "Boundary",
  "MBean 代码可能产生不可逆副作用；3 秒超时无法保证目标操作终止。":
    "MBean code may cause irreversible side effects; a 3-second timeout cannot guarantee termination.",
  "我确认调用 {objectName} 的 {operation} 操作可能立即改变目标 JVM 状态。":
    "I confirm that invoking {operation} on {objectName} may immediately change target JVM state.",
  "我再次确认接受不可逆副作用；超时或中断不保证目标操作停止。":
    "I again confirm that I accept irreversible side effects; timeout or interruption does not guarantee the target operation stops.",
  二次确认并调用操作: "Confirm twice and invoke",
  "最近 {count} 次调用": "{count} most recent invocations",
  "仅保留当前连接的最近 20 条结果":
    "Only the 20 most recent results for this connection are retained",
  耗时: "Duration",
  "此 MBean 没有公开操作。": "This MBean exposes no operations.",
  "选择一个 MBean 查看属性与操作。":
    "Select an MBean to inspect its attributes and operations.",
  "日志配置，按上下文看清。":
    "Inspect logging configuration in its exact context.",
  "搜索 JUL、Logback、Log4j 1.x、Log4j2 的上下文、有效级别与输出目标，并通过框架专属预检安全修改级别；不会为探测而加载业务日志库。":
    "Inspect JUL, Logback, Log4j 1.x, and Log4j2 contexts, effective levels, and output targets, then safely change levels through framework-specific preflight checks. Discovery never loads an application logging library.",
  "连接目标后检查 Logger。": "Connect a target to inspect loggers.",
  "当前 Agent 不支持 Logger Center。":
    "The current Agent does not support Logger Center.",
  日志框架: "Logging framework",
  上下文: "Context",
  全部已加载框架: "All loaded frameworks",
  "搜索 Logger": "Search loggers",
  名称或日志上下文: "Name or logging context",
  日志框架状态: "Logging framework status",
  Agent返回了未知日志框架: "The Agent returned an unknown logging framework",
  "无法读取 Logger 列表": "Unable to read the logger list",
  "无法读取 Logger 详情": "Unable to read logger details",
  "无法预检 Logger 级别": "Unable to preview the logger level",
  "无法修改 Logger 级别": "Unable to change the logger level",
  "Logger 级别预检响应身份无效":
    "The logger-level preflight response has an invalid identity",
  "Logger 级别修改响应身份无效":
    "The logger-level mutation response has an invalid identity",
  "Logger 搜索结果": "Logger search results",
  "正在读取 Logger…": "Reading loggers…",
  "没有匹配的 Logger。": "No matching loggers.",
  "正在读取 Logger 详情…": "Reading logger details…",
  声明级别: "Declared level",
  有效级别: "Effective level",
  向父级传递: "Propagate to parent",
  是: "Yes",
  否: "No",
  "{count} 个输出目标": "{count} output targets",
  仅展示直接绑定项: "Direct bindings only",
  未命名输出: "Unnamed output",
  已绑定: "Bound",
  "此 Logger 没有直接绑定输出项。": "This logger has no directly bound output.",
  "修改精确 {framework} Logger。": "Change the exact {framework} logger.",
  "预检绑定框架、上下文、Logger 和当前级别指纹":
    "Preflight binds the framework, context, logger, and current-level fingerprint",
  新级别: "New level",
  生成级别变更预检: "Generate level-change preflight",
  "Logger 级别变更预检": "Logger level-change preflight",
  目标级别: "Target level",
  "精确框架、上下文、Logger 与当前级别共同形成指纹；预检后发生漂移将拒绝提交。":
    "The exact framework, context, logger, and current level form the fingerprint. Any drift after preflight rejects the commit.",
  "我确认修改 {name} 的日志级别，日志量和性能可能立即变化。":
    "I confirm changing the level of {name}; log volume and performance may change immediately.",
  确认修改级别: "Confirm level change",
  "目标级别与当前声明级别相同，无需提交。":
    "The target level matches the current declared level; no commit is needed.",
  "级别已从 {oldValue} 修改为 {newValue}":
    "Level changed from {oldValue} to {newValue}",
  准备回滚本次修改: "Prepare rollback for this change",
  回滚指纹: "Rollback fingerprint",
  "选择一个 Logger 查看上下文与输出目标。":
    "Select a logger to inspect its context and output targets.",
  "持续任务，一处收束。": "Bring every active task into one place.",
  "统一查看探微创建的观测、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。":
    "Inspect observation, profiling, and JFR tasks created by Tanwei. Cancellation binds to an exact task identity, and profiling or recording results are collected into the local artifact library.",
  "连接目标后管理活动任务。": "Connect a target to manage active tasks.",
  "当前 Agent 不支持统一任务中心。":
    "The current Agent does not support the unified task center.",
  无法读取活动任务: "Unable to read active tasks",
  无法停止活动任务: "Unable to stop the active task",
  "任务已停止：{taskId}": "Task stopped: {taskId}",
  活动任务列表: "Active task list",
  "{count} 个活动任务": "{count} active tasks",
  刷新: "Refresh",
  "正在读取活动任务…": "Reading active tasks…",
  "当前没有由探微创建的持续任务。":
    "No Tanwei-owned long-running task is currently active.",
  "可从观测或剖析页面启动一个有界任务。":
    "Start a bounded task from the Observe or Profile page.",
  "持续记录，停止后保存为本地制品":
    "Recording continuously; stopping saves a local artifact",
  "已捕获 {current} / {maximum} · 丢弃 {dropped}":
    "Captured {current} / {maximum} · Dropped {dropped}",
  "样本 {current} · 丢弃 {dropped}": "Samples {current} · Dropped {dropped}",
  手动停止: "Manual stop",
  "约 {seconds} 秒后自动结束": "Ends automatically in about {seconds} seconds",
  任务标识: "Task identity",
  开始时间: "Started",
  结束边界: "End boundary",
  当前进度: "Current progress",
  "只停止这个任务。": "Stop only this task.",
  "停止后会移除该任务对应的字节码增强，不影响其他观测。":
    "Stopping removes only this task's bytecode instrumentation and leaves other observations untouched.",
  "停止后会先完成报告或记录，再下载并校验本地制品。":
    "Stopping finalizes the report or recording, then downloads and verifies the local artifact.",
  "我确认停止任务 {taskId}": "I confirm stopping task {taskId}",
  停止所选任务: "Stop selected task",
  "选择一个活动任务查看生命周期。":
    "Select an active task to inspect its lifecycle.",
  "列表每秒刷新一次，仅包含探微自身创建且仍在运行的任务。":
    "The list refreshes every second and includes only still-running tasks created by Tanwei.",
  "把探微带来的运行时状态安全收回。":
    "Safely reclaim Tanwei-managed runtime state.",
  "先扫描当前任务、失败的增强回滚和类替换回滚链，再用同一份指纹执行；状态一旦变化，Agent 会拒绝旧预检。":
    "Scan active tasks, failed probe rollbacks, and class rollback chains first, then execute against the same fingerprint. The Agent rejects a stale preview.",
  "R4 · 双确认": "R4 · Two confirmations",
  扫描会话状态: "Scan session state",
  "已恢复到无探微增强状态。": "Tanwei-managed enhancements have been removed.",
  "恢复完成，但存在需要人工处理的冲突。":
    "Reset completed with conflicts that need review.",
  "{succeeded} 项成功 · {failed} 项冲突 · 剩余 {tasks} 个任务 / {claims} 个增强 claim / {classes} 个类回滚":
    "{succeeded} succeeded · {failed} conflicted · {tasks} tasks / {claims} probe claims / {classes} class rollbacks remain",
  活动任务: "Active tasks",
  待恢复类: "Classes to restore",
  失败增强回滚: "Failed probe rollbacks",
  回滚节点: "Rollback points",
  预计制品: "Expected artifacts",
  类替换: "Class replacement",
  增强回滚: "Probe rollback",
  "{count} 个回滚节点 · {loader}": "{count} rollback points · {loader}",
  纳入恢复: "Included",
  "当前没有需要恢复的探微状态。": "There is no Tanwei-managed state to reset.",
  "不会回滚系统属性、日志级别、VM Option、MBean 值或第三方增强；若类定义已被外部修改，只报告冲突，不覆盖。":
    "System properties, logger levels, VM options, MBean values, and third-party instrumentation are excluded. Externally changed class definitions are reported as conflicts and never overwritten.",
  "我确认停止预检中列出的全部探微任务，并回收 Profile / JFR 制品。":
    "I confirm stopping every listed Tanwei task and collecting Profile / JFR artifacts.",
  "我确认重试失败的增强回滚，并恢复探微仍持有回滚链的类；遇到指纹漂移或外部变更时保留现状。":
    "I confirm retrying failed probe rollbacks and restoring classes with retained Tanwei rollback chains. Fingerprint drift or external changes must preserve the current state.",
  执行统一恢复: "Run managed reset",
  "扫描后才会开放恢复操作。": "The reset action unlocks only after a scan.",
  "扫描是只读操作，会生成一次性状态指纹，不会停止任务或修改目标 JVM。":
    "Scanning is read-only. It creates a one-time state fingerprint without stopping tasks or changing the target JVM.",
  "已回收并校验 {count} 个诊断制品":
    "Collected and verified {count} diagnostic artifacts",
  "Agent 返回的会话恢复指纹无效":
    "The Agent returned an invalid session reset fingerprint",
  无法扫描探微会话状态: "Unable to scan Tanwei session state",
  无法恢复探微会话: "Unable to reset Tanwei session state",
  "探微会话恢复完成：{succeeded} 成功，{failed} 冲突":
    "Tanwei session reset completed: {succeeded} succeeded, {failed} conflicted",
  "会话已恢复，但有 {count} 个制品未能回收到本地":
    "The session was reset, but {count} artifacts could not be collected locally",
  目标连接已经断开: "The target connection has closed",
  "R0 · 只读低成本 · 5 秒截止时间":
    "R0 · Read-only, low cost · 5-second deadline",
  执行查询: "Run query",
  "任务 {taskId}": "Task {taskId}",
  "目标已声明此能力。": "The target declared this capability.",
  "修改目标 JVM 中已存在且非敏感的系统属性；业务代码可能立即读到新值。":
    "Change an existing non-sensitive system property in the target JVM. Application code may observe the new value immediately.",
  "修改 java.util.logging 精确 Logger 的级别；日志量和性能可能立即变化。":
    "Change the level of an exact java.util.logging Logger. Log volume and performance may change immediately.",
  "修改 HotSpot 声明为可写的诊断选项；影响由具体选项决定。":
    "Change a diagnostic option that HotSpot declares writeable. Impact depends on the selected option.",
  "向目标 JVM 请求一次全量垃圾回收；可能产生明显停顿，JVM 也可能忽略请求。":
    "Request a full garbage collection from the target JVM. This may cause a noticeable pause, and the JVM may ignore the request.",
  系统属性名: "System property name",
  "Logger 名称": "Logger name",
  "VM Option 名称": "VM Option name",
  "先读取旧值，再明确修改。":
    "Read the old value before making an explicit change.",
  进程级影响: "Process-level impact",
  运行时修改: "Runtime mutation",
  操作: "Action",
  新值: "New value",
  选择级别: "Select a level",
  读取旧值并生成影响预览: "Read old value and preview impact",
  无法读取修改前的值: "Unable to read the value before mutation",
  "目标中不存在该名称，请检查精确拼写。":
    "That exact name does not exist in the target.",
  "敏感值不可通过探微读取或修改。":
    "Sensitive values cannot be read or changed through Tanwei.",
  "该 VM Option 不可写。": "That VM Option is not writeable.",
  运行时修改失败: "Runtime mutation failed",
  不适用: "Not applicable",
  精确目标: "Exact target",
  旧值: "Old value",
  "GC 请求无法回滚。": "A GC request cannot be rolled back.",
  "成功后会返回可用于恢复的旧值和校验参数。":
    "A successful change returns the old value and verification parameters needed to restore it.",
  "我已核对精确目标、旧值、新值与影响。":
    "I reviewed the exact target, old value, new value, and impact.",
  "我再次确认允许目标 JVM 发生潜在停顿。":
    "I confirm again that the target JVM may pause.",
  确认执行受控修改: "Confirm controlled mutation",
  无法读取JVM信息: "Unable to read JVM information",
  "线程与锁。": "Threads and locks.",
  "Agent 端按名称过滤并分页，默认按累计 CPU 时间降序。完整堆栈只保留当前页。":
    "The Agent filters and paginates by name, ordering by cumulative CPU time by default. Full stacks are retained only for the current page.",
  "连接目标后读取线程。": "Connect a target to inspect threads.",
  "找到真实线程池，而不是猜线程名。":
    "Find real executors instead of guessing from thread names.",
  "识别 JDK 执行器的精确实例与真实 Worker 成员，并从成员直接定位线程堆栈。":
    "Find exact JDK executor instances and real Worker members, then locate each member directly in the thread stack inspector.",
  线程池上限: "Executor limit",
  成员返回上限: "Member return limit",
  "我确认执行一次有界的 JVMTI 线程池实例扫描。":
    "I confirm one bounded JVMTI executor-instance scan.",
  检查线程池: "Inspect executors",
  已识别: "Found",
  执行器类型: "Executor types",
  精确成员: "Exact members",
  线程枚举: "Threads enumerated",
  结果已到上限: "Result limit reached",
  扫描完整: "Scan complete",
  已完成: "Completed",
  已截断: "Truncated",
  并行度: "Parallelism",
  核心线程: "Core threads",
  当前线程: "Current threads",
  活跃线程: "Active threads",
  执行任务: "Executing tasks",
  运行线程: "Running threads",
  最大线程: "Maximum threads",
  队列任务: "Queued tasks",
  窃取任务: "Stolen tasks",
  "剩余容量 {count}": "{count} slots remaining",
  "外部提交 {count}": "{count} external submissions",
  线程工厂: "Thread factory",
  查看成员: "Inspect members",
  "{count} 个精确成员": "{count} exact members",
  成员访问不可用: "Member access unavailable",
  线程工厂类型: "Thread factory type",
  线程组: "Thread groups",
  返回覆盖: "Return coverage",
  本地业务别名: "Local business alias",
  "例如：订单异步池": "For example: Order async pool",
  保存别名: "Save alias",
  清除别名: "Clear alias",
  "仅保存在本机，并绑定当前目标、JVM 启动周期与精确池身份。":
    "Stored only on this device and bound to the current target, JVM startup cycle, and exact pool identity.",
  "请输入 1–64 个字符的业务别名。":
    "Enter a business alias between 1 and 64 characters.",
  "本地业务别名已保存。": "The local business alias was saved.",
  "本地业务别名已清除。": "The local business alias was cleared.",
  无法读取线程池别名: "Unable to read executor aliases",
  无法保存线程池别名: "Unable to save the executor alias",
  无法清除线程池别名: "Unable to clear the executor alias",
  "记录饱和、队列与吞吐变化。":
    "Record saturation, queue, and throughput changes.",
  "每次采样重新定位同一精确池对象；最多保留 120 点，停止后可保存为校验制品。":
    "Every sample relocates the same exact pool object. Up to 120 points are retained and can be saved as a verified artifact after stopping.",
  线程池采样中: "Sampling the executor",
  "{count} 个池样本": "{count} pool samples",
  池采样间隔: "Pool sampling interval",
  "我确认按所选间隔重复执行有界 R2 精确池扫描。":
    "I confirm repeated bounded R2 exact-pool scans at the selected interval.",
  开始池趋势: "Start pool trend",
  停止池趋势: "Stop pool trend",
  保存趋势制品: "Save trend artifact",
  当前队列: "Current queue",
  队列净变化: "Net queue change",
  "活跃 / 当前": "Active / current",
  累计完成: "Completed total",
  队列: "Queue",
  活跃: "Active",
  池大小: "Pool size",
  "最近 {count} 个精确线程池样本": "Latest {count} exact executor samples",
  已校验并写入本地制品: "Verified and written to local artifacts",
  打开趋势检查器: "Open trend inspector",
  无法采集线程池趋势: "Unable to sample the executor trend",
  "精确线程池已消失或超出扫描上限，趋势采样已停止。":
    "The exact executor disappeared or exceeded the scan limit, so trend sampling stopped.",
  "线程池趋势样本时间或指标无效。":
    "The executor trend sample has invalid time or metrics.",
  无法核对线程池所属JVM周期:
    "Unable to verify the executor's JVM startup cycle",
  无法启动线程池趋势: "Unable to start the executor trend",
  无法保存线程池趋势制品: "Unable to save the executor trend artifact",
  拒绝策略: "Rejection policy",
  "队列满且无法扩容时抛出 RejectedExecutionException。":
    "Throws RejectedExecutionException when the queue is full and the pool cannot grow.",
  "队列满时由提交线程执行任务，可能把背压传回请求线程。":
    "Runs the task on the submitting thread when the queue is full, potentially propagating backpressure to request threads.",
  "队列满时静默丢弃新任务，需要核对业务补偿与丢弃指标。":
    "Silently discards new tasks when the queue is full; verify business compensation and drop metrics.",
  "队列满时丢弃最旧排队任务并重试提交。":
    "Discards the oldest queued task and retries submission when the queue is full.",
  "ForkJoinPool 不使用 ThreadPoolExecutor 拒绝处理器。":
    "ForkJoinPool does not use a ThreadPoolExecutor rejection handler.",
  "没有返回拒绝策略证据。": "No rejection-policy evidence was returned.",
  "自定义拒绝策略；这里只展示精确类型，不执行处理器方法。":
    "Custom rejection policy; only the exact type is shown and no handler method is invoked.",
  "ForkJoinPool 的任务分散在工作队列中，本检查器不读取其内部任务对象。":
    "ForkJoinPool tasks are distributed across worker queues; this inspector does not read their internal task objects.",
  "自定义队列不会被迭代，避免执行未知实现代码。":
    "Custom queues are not iterated, avoiding execution of unknown implementation code.",
  "本次全局队列证据预算已用尽。":
    "The global queue-evidence budget was exhausted for this scan.",
  "目标队列在有界迭代期间发生变化，未返回任务类型。":
    "The target queue changed during bounded iteration, so no task types were returned.",
  "本次扫描没有请求队列任务证据。":
    "Queue task evidence was not requested for this scan.",
  "队列任务类型当前不可用。": "Queue task types are currently unavailable.",
  "任务堆积在哪里，成员又停在哪里。":
    "See where tasks accumulate and where members are currently stopped.",
  "只读取已知 JDK 队列中最多 100 个元素的类型，以及精确成员的当前栈位置；不执行任务方法或任意 toString()。":
    "Reads only the types of up to 100 elements from known JDK queues and current stack locations of exact members; it never invokes task methods or arbitrary toString().",
  "{count} 个队列任务样本": "{count} queued task samples",
  队列证据受限: "Queue evidence limited",
  排队任务类型: "Queued task types",
  "采样时队列为空。": "The queue was empty when sampled.",
  "队列任务类型只覆盖本次有界样本。":
    "Queued task types cover only this bounded sample.",
  成员业务栈位置: "Member application stack locations",
  "当前成员只停在平台调度栈，未发现业务栈帧。":
    "Current members are stopped only in platform scheduling frames; no application frame was found.",
  "Park / 等待对象类型": "Park / wait object types",
  "当前成员没有可见的 LockSupport blocker。":
    "Current members have no visible LockSupport blocker.",
  "这是精确池对象的一次现场证据，不把栈位置或队列元素类型直接宣称为根因。点击成员证据可重新查询完整线程栈。":
    "This is one point-in-time evidence set for the exact pool object; stack locations and queued element types are not asserted as root causes. Select member evidence to query the full thread stack again.",
  只有已就绪的线程池趋势制品可以检查:
    "Only ready executor trend artifacts can be inspected",
  无法检查线程池趋势制品: "Unable to inspect the executor trend artifact",
  无法对比线程池趋势制品: "Unable to compare executor trend artifacts",
  检查池趋势: "Inspect pool trend",
  线程池趋势制品检查器: "Executor trend artifact inspector",
  "把池饱和与队列增长留成证据。":
    "Preserve pool saturation and queue growth as evidence.",
  持续时间: "Duration",
  峰值队列: "Peak queue",
  平均利用率: "Average utilization",
  完成速率: "Completion rate",
  校验线程池趋势图: "Verified executor trend chart",
  "Host 已复验真实路径、普通 JSON、大小、SHA-256、目标、JVM 周期、精确池身份、时间顺序与单调计数器。":
    "The Host revalidated the real path, plain JSON, size, SHA-256, target, JVM cycle, exact pool identity, chronological order, and monotonic counters.",
  "此窗口同时出现持续饱和与队列增长，需要检查任务耗时或下游阻塞。":
    "This window shows sustained saturation together with queue growth. Inspect task duration or downstream blocking.",
  "比较两个不重叠的池运行窗口。":
    "Compare two non-overlapping pool runtime windows.",
  "仅允许同一目标、同一 JVM 启动周期、同一精确池对象与类型；不兼容制品会由 Host 拒绝。":
    "Only the same target, JVM startup cycle, exact pool object, and type are allowed. The Host rejects incompatible artifacts.",
  基线池趋势: "Baseline pool trend",
  选择较早的池趋势: "Select an earlier pool trend",
  比较池窗口: "Compare pool windows",
  "还需要同一精确池的一份较早趋势；返回线程页再次记录并保存。":
    "An earlier trend for the same exact pool is required. Return to Threads to record and save another window.",
  基线结束: "Baseline ended",
  当前开始: "Current started",
  窗口间隔: "Window interval",
  指标: "Metric",
  基线窗口: "Baseline window",
  当前窗口: "Current window",
  结束队列: "Ending queue",
  "定位线程 #{id} · {name}": "Locate thread #{id} · {name}",
  无线程组: "No thread group",
  定位堆栈: "Locate stack",
  "这个线程池当前没有存活成员。":
    "This executor currently has no live members.",
  "当前 JDK 不允许读取这个线程池的成员。":
    "The current JDK does not allow this executor's members to be read.",
  "热点线程已退出或不在当前结果页。":
    "The hot thread exited or is not on the current result page.",
  "成员线程已退出或不在当前结果页，请重新检查线程池。":
    "The member thread exited or is not on the current result page. Inspect the executors again.",
  "当前没有可见的精确 JDK 线程池；自定义子类不会被误报。":
    "No exact JDK executors are currently visible. Custom subclasses are not reported as false positives.",
  无法识别线程池: "Unable to inspect executors",
  "把线程变化留在有界时间窗里。":
    "Keep thread changes in a bounded time window.",
  "每次最多读取 1,000 个线程且只取一层栈，内存中保留最近 120 个样本；停止、断连、切换目标或离开页面都会释放定时器。":
    "Each sample reads at most 1,000 threads with one stack frame. Only the latest 120 samples are kept in memory, and the timer is released when sampling stops, the target disconnects or changes, or the page is left.",
  "{count} 个样本": "{count} samples",
  无法采集线程趋势: "Unable to capture the thread trend",
  线程总数: "Total threads",
  本次可见: "Visible now",
  "可见 CPU 速率": "Visible CPU rate",
  生命周期变化: "Lifecycle changes",
  可见死锁: "Visible deadlocks",
  "线程总数仍为目标快照总数；状态、死锁、生命周期和 CPU 只覆盖前 1,000 个可见线程。":
    "The total remains exact for the target snapshot. State, deadlock, lifecycle, and CPU metrics cover only the first 1,000 visible threads.",
  总数: "Total",
  "最近 {count} 个线程样本的总数与状态趋势":
    "Total and state trends across the latest {count} thread samples",
  "{count} / {maximum} 个内存样本": "{count} / {maximum} in-memory samples",
  "最近采样 {time}": "Last sampled {time}",
  "先采集一个线程趋势样本。": "Capture a thread trend sample to begin.",
  "首个样本建立基线；后续样本才计算线程新增、退出与可见累计 CPU 速率。":
    "The first sample establishes a baseline. Later samples calculate thread creation, exit, and visible cumulative CPU rate.",
  "两次采样之间，哪些线程真的变了。":
    "See what actually changed between two thread samples.",
  重置线程基线: "Reset thread baseline",
  固定线程基线: "Pin thread baseline",
  与当前对比: "Compare with current",
  "一次最多采集 1000 个线程；对比新增、退出、状态、锁持有者和累计 CPU 增量。":
    "Capture at most 1,000 threads and compare creation, exit, state, lock owner, and cumulative CPU growth.",
  "{count} 个线程": "{count} threads",
  等待第二次采样: "Waiting for the second sample",
  新增线程: "New threads",
  退出线程: "Exited threads",
  状态变化: "State changes",
  累计增量: "Cumulative growth",
  "当前采样间隔内没有可见 CPU 增量。":
    "No visible CPU growth occurred during this sampling interval.",
  "线程生命周期与锁关系保持稳定。":
    "Thread lifecycle and lock relationships remained stable.",
  "新线程 · {state}": "New thread · {state}",
  "等待 {lock} · 持有者 #{owner}": "Waiting for {lock} · owner #{owner}",
  已离开锁等待: "No longer waiting for a lock",
  "已退出 · 基线状态 {state}": "Exited · baseline state {state}",
  无法采集线程快照: "Unable to capture the thread snapshot",
  无法对比线程快照: "Unable to compare thread snapshots",
  "把线程现场固定成可校验证据。":
    "Preserve the thread state as verifiable evidence.",
  "生成单次 UTF-8 转储，最多 10000 个线程、每线程 512 层和 32 MiB；完成后进入制品与案例链路。":
    "Create one UTF-8 dump with at most 10,000 threads, 512 frames per thread, and 32 MiB, then add it to the artifact and case workflow.",
  堆栈深度: "Stack depth",
  "包含 Monitor 与 Synchronizer": "Include monitors and synchronizers",
  生成线程转储: "Create thread dump",
  无法生成线程转储: "Unable to create the thread dump",
  无法保存线程转储: "Unable to save the thread dump",
  "已校验并保存 · {size} 字节": "Verified and saved · {size} bytes",
  在线程转储检查器中打开: "Open in thread dump inspector",
  线程转储检查器: "Thread dump inspector",
  "线程现场，作为证据重新打开。":
    "Reopen the captured thread state as evidence.",
  未知时间: "Unknown time",
  状态类型: "State types",
  最大堆栈: "Maximum stack",
  "Host 已重新校验真实路径、普通文件、扩展名、大小与 SHA-256；Renderer 只接收最多 10000 个线程和每线程 512 层的结构化结果。":
    "The Host revalidated the real path, regular file, extension, size, and SHA-256. The Renderer receives only structured results capped at 10,000 threads and 512 frames per thread.",
  "目标线程数超过采集上限，结果已截断。":
    "The target exceeded the thread capture limit, so the result was truncated.",
  "线程、锁或堆栈": "Thread, lock, or stack",
  "例如 integration-lock-waiter": "For example, integration-lock-waiter",
  仅死锁: "Deadlocks only",
  筛选转储: "Filter dump",
  无可用堆栈: "No stack available",
  "再显示 100 个线程": "Show 100 more threads",
  "当前筛选没有匹配线程。": "No threads match the current filter.",
  "累计 CPU": "Cumulative CPU",
  只有已就绪的线程转储可以检查: "Only ready thread dumps can be inspected",
  无法检查线程转储: "Unable to inspect the thread dump",
  检查线程转储: "Inspect thread dump",
  无法对比线程转储: "Unable to compare thread dumps",
  "两个现场，自动标出变化。":
    "Automatically surface changes between two captures.",
  "选择较早的同一 JVM 转储作为基线；Host 会再次校验两份制品，并按线程 ID 与名称联合识别生命周期。":
    "Select an earlier dump from the same JVM as the baseline. The Host revalidates both artifacts and identifies lifecycle changes using thread ID and name together.",
  基线线程转储: "Baseline thread dump",
  选择较早的转储: "Select an earlier dump",
  生成差异: "Generate diff",
  "还需要同一目标的一份较早线程转储；返回线程页再次采集后即可自动对比。":
    "Another earlier dump from the same target is required. Return to Threads and capture again to enable automatic comparison.",
  新增: "Added",
  退出: "Removed",
  变化: "Changed",
  稳定: "Stable",
  新增死锁: "New deadlocks",
  "{persisted} 个线程持续存在 · 间隔 {duration} · CPU 增量仅在两次均可用且未回退时计算。":
    "{persisted} persisted threads · {duration} interval · CPU growth is calculated only when both samples are available and monotonic.",
  "至少一份转储被截断，新增与退出数量可能不完整。":
    "At least one dump was truncated, so added and removed counts may be incomplete.",
  "线程、状态或栈顶": "Thread, state, or top frame",
  变化类型: "Change type",
  全部变化: "All changes",
  筛选差异: "Filter diff",
  "再显示 100 个变化": "Show 100 more changes",
  "当前筛选没有匹配变化。": "No changes match the current filter.",
  "CPU 增量": "CPU growth",
  变化证据: "Change evidence",
  等待关系: "Wait relationship",
  堆栈: "Stack",
  死锁解除: "Deadlock recovered",
  结构稳定: "Structure stable",
  "选择一个线程变化查看前后证据。":
    "Select a thread change to inspect before-and-after evidence.",
  "等待者、持有者与锁，一次看清。":
    "Inspect waiters, owners, and locks together.",
  "默认只返回存在等待、持有关系或死锁的线程；结果有界且不会持续轮询目标。":
    "By default, only threads involved in waiting, ownership, or deadlock relationships are returned. Results are bounded and the target is not polled continuously.",
  节点上限: "Node limit",
  包含没有等待者的持有锁: "Include held locks without waiters",
  分析锁关系: "Analyze lock relationships",
  锁关系摘要: "Lock relationship summary",
  相关线程: "Related threads",
  等待锁: "Waiting for locks",
  持有锁: "Held locks",
  死锁线程: "Deadlocked threads",
  "{count} 个节点 · {edges} 条等待边": "{count} nodes · {edges} wait edges",
  "等待 #{owner}": "Waiting for #{owner}",
  "{count} 个持有锁": "{count} held locks",
  "展开剩余 {count} 个节点": "Render the remaining {count} nodes",
  持有者: "Owner",
  定位持有线程: "Show owner thread",
  未知位置: "Unknown location",
  "没有已记录的 Monitor。": "No monitors were recorded.",
  "没有已记录的 Ownable Synchronizer。":
    "No ownable synchronizers were recorded.",
  "当前没有匹配的锁等待或持有关系。":
    "No matching wait or ownership relationships were found.",
  无法分析线程锁关系: "Unable to analyze thread lock relationships",
  线程名称: "Thread name",
  状态: "State",
  全部状态: "All states",
  匹配: "Matches",
  当前页: "Current page",
  死锁: "Deadlock",
  "等待锁 {lock}": "Waiting for lock {lock}",
  "，持有线程 #{owner}": ", owned by thread #{owner}",
  "该线程没有可用堆栈。": "No stack is available for this thread.",
  "当前条件没有匹配线程。": "No threads match the current filters.",
  无法生成线程中断预览: "Unable to prepare the thread interrupt preview",
  线程中断失败: "Thread interruption failed",
  "已向线程 #{id} · {name} 发送中断信号":
    "Sent an interrupt signal to thread #{id} · {name}",
  "仅发送 Java 中断信号。": "Send only a Java interrupt signal.",
  生成中断预览: "Prepare interrupt preview",
  "目标代码可能忽略或清除中断状态；探微不会使用 Thread.stop。":
    "Target code may ignore or clear the interrupt state. Tanwei never uses Thread.stop.",
  精确线程: "Exact thread",
  预检状态: "Preview state",
  栈顶: "Top frame",
  "我已核对线程 ID、名称、状态和栈顶，并确认它是预期业务线程。":
    "I verified the thread ID, name, state, and top frame and confirm it is the intended application thread.",
  "我再次确认接受业务任务提前结束、回滚或状态不一致的风险。":
    "I confirm again that the application task may stop early, roll back, or enter an inconsistent state.",
  二次确认并发送中断信号: "Confirm again and send interrupt signal",
  线程分页: "Thread pagination",
  无法读取线程列表: "Unable to read thread list",
  "结构化，不猜测。": "Structured, never guessed.",
  "Console 只发送已声明 Action 与通过 Schema 校验的参数；不存在任意文本命令或 Renderer 绕过路径。":
    "The Console sends only declared Actions and schema-validated parameters. There is no arbitrary text command or Renderer bypass.",
  JVM基础信息: "JVM information",
  "Arthas 生态映射": "Arthas ecosystem mapping",
  增强生命周期: "Instrumentation lifecycle",
  "增强类的所有权可见、可恢复。":
    "Instrumentation ownership is visible and recoverable.",
  "活动增强按类身份互斥；若精确回滚失败，类会继续被 claim，直到显式重试成功。":
    "Active instrumentation is exclusive by class identity. If exact rollback fails, the class remains claimed until an explicit retry succeeds.",
  "{count} 个持有者": "{count} owners",
  确认重试精确回滚: "Confirm exact rollback retry",
  "重试并释放 claim": "Retry and release claim",
  "当前没有被诊断增强持有的类。":
    "No classes are currently owned by diagnostic instrumentation.",
  增强回滚重试失败: "Instrumentation rollback retry failed",
  "增强所有权已释放：{ownerId}":
    "Instrumentation ownership released: {ownerId}",
  启动参数: "Startup arguments",
  系统属性: "System properties",
  环境摘要: "Environment summary",
  运行时检查器: "Runtime inspectors",
  基础事实: "Runtime facts",
  环境变量: "Environment",
  受控修改: "Controlled mutations",
  目标能力矩阵: "Target capability matrix",
  "{count} 项": "{count} items",
  "检查 HotSpot 选项，再决定是否修改。":
    "Inspect HotSpot options before deciding whether to change them.",
  "按名称、运行时领域和可写性检查诊断选项；所有修改仍需进入独立 R3 旧值预检。":
    "Inspect diagnostic options by name, runtime domain, and writeability. Every mutation still enters a separate R3 old-value preview.",
  "{count} 个 VM Option": "{count} VM options",
  "例如 Heap、GC 或 Compile": "For example, Heap, GC, or Compile",
  选项类别: "Option category",
  "内存与 Heap": "Memory and heap",
  垃圾回收: "Garbage collection",
  "编译器与 Code Cache": "Compiler and code cache",
  诊断与故障处理: "Diagnostics and failure handling",
  日志与跟踪: "Logging and tracing",
  其他选项: "Other options",
  可写性: "Writeability",
  全部选项: "All options",
  仅可写: "Writeable only",
  仅只读: "Read-only only",
  搜索选项: "Search options",
  "VM Option 源超过安全上限，本次检查 {scanned} / {total} 项。":
    "The VM option source exceeded the safety limit; this run inspected {scanned} of {total} entries.",
  "跳过 {count} 个无效 VM Option。": "Skipped {count} invalid VM options.",
  "VM Option 列表": "VM option list",
  "正在读取 VM Option…": "Reading VM options…",
  "没有匹配的 VM Option。": "No VM options match.",
  可进入修改预检: "Mutation preview available",
  仅检查: "Inspect only",
  "命令型或敏感选项不可查看、复制或修改。":
    "Command-bearing or sensitive options cannot be viewed, copied, or changed.",
  "HotSpot 将该选项声明为只读；探微不会尝试写入。":
    "HotSpot declares this option read-only; Tanwei will not attempt to write it.",
  "旧值超过精确校验边界，因此只允许检查。":
    "The old value exceeds the exact-check boundary, so this option is inspect-only.",
  "修改前会重新读取旧值；并发漂移会使预检失效。":
    "The old value is read again before mutation; concurrent drift invalidates the preview.",
  "选择一个 VM Option 查看来源与修改边界。":
    "Select a VM option to inspect its origin and mutation boundary.",
  "VM Option 总数": "VM option total",
  "已扫描 VM Option 数量": "Scanned VM option count",
  "可写 VM Option 数量": "Writeable VM option count",
  "只读 VM Option 数量": "Read-only VM option count",
  "已遮罩 VM Option 数量": "Masked VM option count",
  "无效 VM Option 数量": "Invalid VM option count",
  "VM Option 源截断状态": "VM option source truncation state",
  "VM Option 汇总响应无效。": "The VM option summary response is invalid.",
  "VM Option 匹配数量": "VM option match count",
  "VM Option 分页偏移": "VM option page offset",
  "VM Option 分页上限": "VM option page limit",
  "VM Option 结果数量": "VM option result count",
  "VM Option 响应包含无效或重复名称。":
    "The VM option response contains an invalid or duplicate name.",
  "VM Option 来源": "VM option origin",
  "VM Option 可写状态": "VM option writeability state",
  "VM Option 截断状态": "VM option truncation state",
  "VM Option 修改状态": "VM option mutation state",
  "VM Option 分类或来源响应无效。":
    "The VM option category or origin response is invalid.",
  "VM Option 值": "VM option value",
  "VM Option 值长度": "VM option value length",
  "VM Option 值边界响应无效。":
    "The VM option value-boundary response is invalid.",
  "无法读取 VM Option 索引": "Unable to read the VM option index",
  "检查 JVM 配置，并精确进入修改预检。":
    "Inspect JVM configuration and enter an exact mutation preview.",
  "按名称检索 Java、JVM、操作系统、用户、路径与应用属性；敏感值在 Agent 内遮罩，长值保持明确返回边界。":
    "Search Java, JVM, operating-system, user, path, and application properties by name. Sensitive values are masked inside the Agent, and long values retain explicit response boundaries.",
  系统属性名称: "System property name",
  "例如 java、user 或 application": "For example, java, user, or application",
  属性类别: "Property category",
  "Java 平台": "Java platform",
  "JVM 实现": "JVM implementation",
  操作系统: "Operating system",
  用户与区域: "User and locale",
  应用属性: "Application properties",
  搜索属性: "Search properties",
  可检查: "Inspectable",
  "属性源超过安全上限，本次检查 {scanned} / {total} 项。":
    "The property source exceeded the safety limit; this run inspected {scanned} of {total} entries.",
  系统属性列表: "System property list",
  "正在读取系统属性…": "Reading system properties…",
  "没有匹配的系统属性。": "No system properties match.",
  "敏感属性不可查看、复制或进入修改流程。":
    "Sensitive properties cannot be viewed, copied, or sent to the mutation flow.",
  "该属性名称或值超出安全修改边界，仅允许检查。":
    "This property name or value exceeds the safe mutation boundary and is inspect-only.",
  "修改前仍会重新读取旧值，并执行 R3 精确值校验。":
    "The old value will be read again and checked exactly at R3 before mutation.",
  "带入 R3 修改预检": "Send to R3 mutation preview",
  "选择一个系统属性查看边界信息。":
    "Select a system property to inspect its boundary information.",
  系统属性总数: "System property total",
  已扫描属性数量: "Scanned property count",
  可见属性数量: "Visible property count",
  已遮罩属性数量: "Masked property count",
  无效属性数量: "Invalid property count",
  "系统属性汇总响应无效。": "The system-property summary response is invalid.",
  系统属性匹配数量: "System property match count",
  系统属性分页偏移: "System property page offset",
  系统属性分页上限: "System property page limit",
  系统属性结果数量: "System property result count",
  "系统属性响应包含重复名称。":
    "The system-property response contains duplicate names.",
  "系统属性分类或可见性响应无效。":
    "The system-property category or visibility response is invalid.",
  系统属性值: "System property value",
  系统属性值长度: "System property value length",
  "系统属性值边界响应无效。":
    "The system-property value boundary response is invalid.",
  无法读取系统属性索引: "Unable to read the system-property index",
  "检查进程环境，不暴露秘密。":
    "Inspect the process environment without exposing secrets.",
  "按名称搜索并分类目标 JVM 的启动环境；仅展示明确允许的运行时上下文值，其余变量只保留名称、类别和字符长度。":
    "Search and classify the target JVM startup environment by name. Only explicitly allowed runtime context values are shown; all other variables retain only their name, category, and character count.",
  "{count} 个变量": "{count} variables",
  环境变量名称: "Environment variable name",
  "例如 JAVA、PATH 或 LANG": "For example, JAVA, PATH, or LANG",
  变量类别: "Variable category",
  全部类别: "All categories",
  "Java 工具链": "Java toolchain",
  路径与目录: "Paths and directories",
  语言与时区: "Language and time zone",
  进程上下文: "Process context",
  其他变量: "Other variables",
  搜索环境: "Search environment",
  允许展示: "Allowed to display",
  安全遮罩: "Safely masked",
  无效跳过: "Invalid skipped",
  环境变量列表: "Environment variable list",
  已遮罩: "Masked",
  "正在读取环境变量…": "Reading environment variables…",
  "没有匹配的环境变量。": "No environment variables match.",
  类别: "Category",
  原始字符数: "Original character count",
  返回边界: "Response boundary",
  "值未离开 Agent": "Value never left the Agent",
  "已截断为 4,096 个字符": "Truncated to 4,096 characters",
  完整安全值: "Complete safe value",
  "探微不提供查看或复制此值的路径；需要确认变量内容时，请在目标所属的秘密管理系统中核对。":
    "Tanwei provides no path to view or copy this value. Verify it in the secret-management system that owns the target.",
  "选择一个环境变量查看边界信息。":
    "Select an environment variable to inspect its boundary information.",
  环境变量总数: "Environment variable total",
  可见变量数量: "Visible variable count",
  已遮罩变量数量: "Masked variable count",
  无效变量数量: "Invalid variable count",
  "环境变量汇总响应无效。":
    "The environment-variable summary response is invalid.",
  环境变量匹配数量: "Environment variable match count",
  环境变量分页偏移: "Environment variable page offset",
  环境变量分页上限: "Environment variable page limit",
  环境变量结果数量: "Environment variable result count",
  "环境变量响应包含重复名称。":
    "The environment-variable response contains duplicate names.",
  "环境变量分类或可见性响应无效。":
    "The environment-variable category or visibility response is invalid.",
  环境变量值: "Environment variable value",
  环境变量值长度: "Environment variable value length",
  "环境变量值边界响应无效。":
    "The environment-variable value boundary response is invalid.",
  无法读取环境变量索引: "Unable to read the environment index",
  内存池: "Memory pools",
  GC收集器: "GC collectors",
  MBean域: "MBean domains",
  日志级别: "Logging levels",
  操作预览: "Action preview",
  "R0 · 只读": "R0 · Read only",
  执行Action: "Run Action",
  "暂无事件。连接目标并执行一个 Action。":
    "No events yet. Connect a target and run an Action.",
  请先连接目标JVM: "Connect a target JVM first",
  Action执行失败: "Action execution failed",
  "运行正在发生。": "The runtime is live.",
  "CPU、内存、线程、GC 与类加载使用最多 300 点的固定窗口。缺失数据明确显示为“未知”。":
    "CPU, memory, threads, GC, and class loading use a fixed window of up to 300 points. Missing data is explicitly shown as “Unknown.”",
  系统: "System",
  等待目标数据: "Waiting for target data",
  上限: "Limit",
  上限未知: "Limit unknown",
  峰值: "Peak",
  "{count} 次收集": "{count} collections",
  "先连接一个目标 JVM。": "Connect a target JVM first.",
  "目标已选择，但 Agent 尚未建立握手。":
    "A target is selected, but the Agent handshake is not established.",
  "当前没有选择目标。": "No target is currently selected.",
  返回目标列表: "Back to targets",
  实时采样控制: "Live sampling controls",
  已暂停: "Paused",
  正在采样: "Sampling",
  实时采样: "Live sampling",
  "{count}/{maximum} 点": "{count}/{maximum} points",
  刷新间隔: "Refresh interval",
  恢复: "Resume",
  暂停: "Pause",
  立即刷新: "Refresh now",
  运行时摘要: "Runtime summary",
  已加载类: "Loaded classes",
  "{time} 更新": "Updated {time}",
  "从信号直接进入证据。": "Move directly from signal to evidence.",
  "CPU、Heap 与 RT 信号只负责指路；结论仍需进入对应检查器核对。":
    "CPU, Heap, and latency signals only provide direction; verify conclusions in the corresponding inspector.",
  "高 CPU → 线程排序 → 完整堆栈": "High CPU → Thread ranking → Full stacks",
  "Heap 增长 → 类列表 → 加载器证据":
    "Heap growth → Class list → ClassLoader evidence",
  "RT 异常 → 方法观测 → 调用树":
    "Latency anomaly → Method observation → Call tree",
  无法读取实时运行状态: "Unable to read live runtime state",
  "只观测你明确选择的方法。":
    "Observe only the method you explicitly selected.",
  "每个任务拥有精确类加载器身份、事件上限、超时和唯一增强所有权；达到终态后仅回滚该任务持有的类。":
    "Every task has an exact ClassLoader identity, event limit, timeout, and exclusive instrumentation ownership. On termination, only the classes owned by that task are reverted.",
  "连接目标后选择观测方法。":
    "Connect a target, then select a method to observe.",
  "观测任务需要一个已经完成 Attach 的目标 JVM。":
    "An observation task requires a target JVM with an active Attach connection.",
  "从类详情中的方法签名进入观测。":
    "Start observation from a method signature in class details.",
  "类、ClassLoader 与完整方法签名会共同绑定本次任务。":
    "The class, ClassLoader, and complete method signature jointly bind this task.",
  观测操作未完成: "Observation action did not complete",
  精确方法身份: "Exact method identity",
  "增强只绑定下面的类、加载器与方法签名。":
    "Instrumentation is bound only to the class, loader, and method signature below.",
  方法签名: "Method signature",
  采集边界: "Capture boundaries",
  "事件、时间与调用树均在固定预算内。":
    "Events, duration, and the call tree all remain within fixed budgets.",
  "记录同一增强类内部的父子调用关系。":
    "Record parent-child invocation relationships inside the same instrumented class.",
  观测时机: "Watch phases",
  进入前: "At entry",
  异常退出: "Exceptional exit",
  "进入前不提供耗时、返回值或异常；同时选择返回/异常与完成会为同一次调用生成独立事件。":
    "Before-entry events have no duration, return value, or exception. Selecting return/throw together with finish creates separate events for the same invocation.",
  "观测时机：{phases}": "Watch phases: {phases}",
  入参快照: "Argument snapshot",
  进入时不可用: "Unavailable at entry",
  事件上限或超时超出允许范围:
    "The event limit or timeout is outside the allowed range",
  浏览已加载类: "Browse loaded classes",
  最多事件: "Maximum events",
  "超时（秒）": "Timeout (seconds)",
  "安全条件（可选）": "Safe condition (optional)",
  '例如 arg0 contains "order-" 或 durationMs >= 10':
    'For example, arg0 contains "order-" or durationMs >= 10',
  安全事件条件: "Safe event conditions",
  "仅支持受限字段与 AND；不执行脚本、OGNL 或反射。":
    "Only bounded fields and AND are supported; no scripts, OGNL, or reflection are executed.",
  添加条件: "Add condition",
  当前捕获全部匹配调用: "All matching invocations are currently captured",
  "添加条件后，所有规则同时满足时才生成事件。":
    "After conditions are added, an event is created only when every rule matches.",
  执行耗时: "Duration",
  方法参数: "Method argument",
  异常类型: "Exception type",
  "且（AND）": "AND",
  序号: "Index",
  判断: "Operator",
  "条件 {index} 字段": "Condition {index} field",
  "条件 {index} 判断": "Condition {index} operator",
  "条件 {index} 值": "Condition {index} value",
  "删除条件 {index}": "Remove condition {index}",
  大于等于: "Greater than or equal to",
  大于: "Greater than",
  小于等于: "Less than or equal to",
  小于: "Less than",
  等于: "Equals",
  包含: "Contains",
  存在异常: "Exception exists",
  类型包含: "Type contains",
  类型等于: "Type equals",
  "将发送到 Agent 的受限表达式": "Bounded expression sent to the Agent",
  "无条件（捕获全部）": "No condition (capture all)",
  无需填写: "No value required",
  毫秒: "Milliseconds",
  "例如 http-nio": "For example, http-nio",
  "例如 order-": "For example, order-",
  "例如 IllegalArgumentException": "For example, IllegalArgumentException",
  "例如 accepted": "For example, accepted",
  "事件条件：{condition}": "Event condition: {condition}",
  "安全条件最多包含 4 条规则": "Safe conditions may contain at most four rules",
  耗时条件使用了不支持的操作符:
    "The duration condition uses an unsupported operator",
  "耗时必须是 0–60000 ms，最多 3 位小数":
    "Duration must be 0–60000 ms with at most three decimal places",
  "参数序号必须在 0–15 之间": "The argument index must be between 0 and 15",
  调用结果只能是正常返回或抛出异常: "The outcome must be returned or threw",
  文本条件使用了不支持的操作符:
    "The text condition uses an unsupported operator",
  "条件值必须是最多 {maximumLength} 字符的安全单行文本":
    "The condition value must be safe single-line text of at most {maximumLength} characters",
  "条件值必须是最多 128 字符的安全单行文本":
    "The condition value must be safe single-line text of at most 128 characters",
  "条件值必须是最多 256 字符的安全单行文本":
    "The condition value must be safe single-line text of at most 256 characters",
  "安全条件必须是最多 512 字符的单行表达式":
    "The safe condition must be a single-line expression of at most 512 characters",
  "安全条件仅支持最多 4 条 AND 规则":
    "Safe conditions support at most four AND rules",
  "安全条件包含不支持的字段、操作符或值":
    "The safe condition contains an unsupported field, operator, or value",
  捕获同类内部调用树: "Capture same-class internal call tree",
  预检匹配: "Preview match",
  "匹配 {count} 个方法": "{count} method matched",
  确认增强并开始: "Confirm instrumentation and start",
  观测任务: "Observation task",
  "已捕获 {captured}": "{captured} captured",
  "已丢弃 {dropped}": "{dropped} dropped",
  "已捕获 {captured} · 已丢弃 {dropped}":
    "{captured} captured · {dropped} dropped",
  取消并回滚增强: "Cancel and revert instrumentation",
  样本: "Samples",
  平均耗时: "Average duration",
  最大耗时: "Maximum duration",
  观测统计: "Observation metrics",
  有界调用事件: "Bounded invocation events",
  "按调用层级检查参数、结果、来源栈与安全重放入口。":
    "Inspect arguments, outcomes, caller stacks, and safe replay entry points by invocation depth.",
  等待匹配调用: "Waiting for a matching invocation",
  受控调用重放: "Controlled invocation replay",
  异常: "Exception",
  "深度 {depth} · {parent}": "Depth {depth} · {parent}",
  根调用: "Root call",
  "父事件 #{sequence}": "Parent event #{sequence}",
  方法: "Method",
  参数: "Arguments",
  返回: "Return value",
  时间: "Time",
  调用来源: "Caller stack",
  "等待目标方法被调用；实时对象值不会写入 SQLite。":
    "Waiting for the target method to be invoked. Live object values are never written to SQLite.",
  无法确认方法匹配: "Unable to confirm the method match",
  无法启动方法观测: "Unable to start method observation",
  Agent未返回观测任务标识:
    "The Agent did not return an observation task identifier",
  无法读取观测事件: "Unable to read observation events",
  无法取消观测任务: "Unable to cancel the observation task",
  "仅公开静态方法和完整标量参数可重放。目标代码可能产生不可逆业务副作用。":
    "Only public static methods with complete scalar arguments can be replayed. Target code may cause irreversible business side effects.",
  为此快照生成重放预览: "Create a replay preview for this snapshot",
  最终调用: "Final invocation",
  预检指纹: "Preview fingerprint",
  中断边界: "Interruption boundary",
  "我已核对目标、参数和最终调用，并理解该方法会再次真实执行。":
    "I reviewed the target, arguments, and final invocation, and understand that the method will execute again.",
  "我再次确认接受业务副作用，且超时或中断不保证目标代码停止。":
    "I confirm again that I accept business side effects and that timeout or interruption does not guarantee target code termination.",
  二次确认并执行重放: "Confirm again and execute replay",
  调用重放预检失败: "Invocation replay preview failed",
  调用重放失败: "Invocation replay failed",
  "留下可验证的性能证据。": "Create verifiable performance evidence.",
  "JFR 与 Heap Dump 在目标进程中生成临时文件，经回环加密令牌分块传回本机并校验后，Agent 立即清理临时副本。":
    "JFR and Heap Dump create temporary files in the target process. They are streamed to this machine through an authenticated loopback token, verified, and immediately removed by the Agent.",
  "连接目标后启动采集任务。": "Connect a target to start a collection task.",
  "Agent 以有界采样器生成自包含 HTML 报告。任务切换页面后继续运行，返回本页会恢复状态轮询。":
    "The Agent creates a self-contained HTML report with a bounded sampler. Tasks continue across navigation and polling resumes when you return.",
  "受支持平台优先按需加载 async-profiler 4.5；其他平台安全降级为 JDK 有界采样器。两种引擎都生成自包含 HTML，任务切换页面后继续运行。":
    "Supported platforms lazily load async-profiler 4.5. Other platforms safely fall back to the bounded JDK sampler. Both engines create self-contained HTML, and tasks continue across navigation.",
  "引擎：{engine}": "Engine: {engine}",
  事件: "Event",
  "时长（秒）": "Duration (seconds)",
  "间隔（ms）": "Interval (ms)",
  最大栈深: "Maximum stack depth",
  按线程拆分火焰图: "Split flame graph by thread",
  "Include（每行一个，首尾 * 通配）":
    "Include (one per line; * at either edge)",
  "Exclude（每行一个，首尾 * 通配）":
    "Exclude (one per line; * at either edge)",
  "样本 {samples} · 丢弃 {dropped} · {taskId}":
    "{samples} samples · {dropped} dropped · {taskId}",
  开始剖析: "Start profiling",
  停止并保存: "Stop and save",
  保存当前报告: "Save current report",
  "当前 JVM 不支持有界剖析。": "Bounded profiling is unavailable on this JVM.",
  低开销持续记录: "Low-overhead continuous recording",
  "使用目标 JDK 自带的 Flight Recorder。可限制磁盘保留窗口与容量；运行中快照不会停止录制。":
    "Uses the target JDK Flight Recorder. Disk retention and size can be bounded, and live snapshots do not stop recording.",
  配置: "Configuration",
  录制名称: "Recording name",
  "最大保留（分钟，0=不限）": "Maximum age (minutes; 0 = unlimited)",
  "最大容量（MiB，0=不限）": "Maximum size (MiB; 0 = unlimited)",
  保存运行中快照: "Save live snapshot",
  "使用目标 JDK 自带的 Flight Recorder。停止后自动下载为本地制品，并计算 SHA-256。":
    "Uses the target JDK's Flight Recorder. On stop, the recording is downloaded as a local artifact and hashed with SHA-256.",
  开始记录: "Start recording",
  "当前 JDK 不支持 JFR。": "JFR is unavailable on this JDK.",
  高影响内存快照: "High-impact memory snapshot",
  "生成期间可能触发长时间停顿并占用大量磁盘。主进程会在执行前校验能力、确认参数、配额和磁盘余量。":
    "Generation may cause a long pause and consume substantial disk space. Before execution, the main process verifies capability, confirmation parameters, quota, and free disk space.",
  准备HeapDump: "Prepare Heap Dump",
  "只保留存活对象（建议，可能触发 Full GC）":
    "Keep live objects only (recommended; may trigger Full GC)",
  "我理解目标 JVM 可能长时间停顿且制品可能包含敏感数据":
    "I understand the target JVM may pause for a long time and the artifact may contain sensitive data",
  确认生成并保存: "Confirm, generate, and save",
  "堆里是什么。": "What is in the heap.",
  "按类统计实例数量与浅大小，用于快速定位内存主体。它不是 retained size，也不替代离线 Heap Dump 分析。":
    "Count instances and shallow bytes by class to identify the main heap occupants quickly. This is not retained size and does not replace offline Heap Dump analysis.",
  已扫描: "Scanned",
  "类名扫描范围（可选）": "Class scan scope (optional)",
  "例如 dev.example 或 java.lang.String":
    "For example, dev.example or java.lang.String",
  结果行数: "Result rows",
  对象遍历预算: "Object scan budget",
  "我理解遍历 Heap 可能造成目标 JVM 短暂停顿。":
    "I understand that traversing the heap may briefly pause the target JVM.",
  扫描Heap直方图: "Scan heap histogram",
  保存跨会话快照: "Save cross-session snapshot",
  检查Heap快照: "Inspect Heap snapshot",
  "缺少可持久化的 Heap 直方图或 JVM 启动时间":
    "No persistable Heap histogram or JVM start time is available",
  "无法保存 Heap 直方图快照": "Unable to save the Heap histogram snapshot",
  "只有已就绪的 Heap 直方图快照可以检查":
    "Only ready Heap histogram snapshots can be inspected",
  "无法检查 Heap 直方图快照": "Unable to inspect the Heap histogram snapshot",
  "无法对比 Heap 直方图快照": "Unable to compare Heap histogram snapshots",
  "Heap 直方图制品检查器": "Heap histogram artifact inspector",
  "内存证据，跨会话重新比较。": "Memory evidence, comparable across sessions.",
  "Host 已重新校验真实路径、普通 JSON 文件、大小、SHA-256、目标身份和采集时间；文件只包含类聚合，不包含业务对象内容。":
    "The Host revalidated the real path, regular JSON file, size, SHA-256, target identity, and capture time. The file contains only class aggregates, never business object contents.",
  "两份持久证据，找出持续增长。":
    "Use two persisted records to find sustained growth.",
  "选择同一目标、同一 JVM 启动周期且扫描参数一致的较早快照；Host 重新读取并校验两份制品后再计算。":
    "Choose an earlier snapshot from the same target and JVM lifetime with identical scan parameters. The Host rereads and verifies both artifacts before computing the diff.",
  "基线 Heap 快照": "Baseline Heap snapshot",
  选择较早的快照: "Choose an earlier snapshot",
  生成跨会话差异: "Generate cross-session diff",
  "还需要同一目标的一份较早 Heap 快照；返回剖析页以相同参数再次扫描并保存。":
    "Another earlier Heap snapshot from the same target is required. Return to Profile, scan again with identical parameters, and save it.",
  采集间隔: "Capture interval",
  "至少一份快照不完整：全局净变化可能隐藏，Top N 未匹配行不会被误判为新增或释放。":
    "At least one snapshot is incomplete. Global deltas may be hidden, and unmatched Top N rows are not misclassified as additions or releases.",
  "差分按类名与精确 ClassLoader 身份联合匹配，时间和空间复杂度均为 O(B+C)；这不是 HPROF retained 差异。":
    "The diff matches class name plus exact ClassLoader identity in O(B+C) time and space. It is not an HPROF retained-size diff.",
  "当前 Agent 不支持 Heap 类直方图。":
    "The current Agent does not support the heap class histogram.",
  已遍历对象: "Objects scanned",
  已归类实例: "Instances classified",
  已归类浅大小: "Classified shallow bytes",
  结果类: "Result classes",
  "本次结果受安全边界限制：遍历截断 {truncated}，类集合截断 {classes}，跳过已有 JVMTI 标签的类 {skipped}。":
    "This result reached a safety boundary: scan truncated {truncated}, class set truncated {classes}, classes with existing JVMTI tags skipped {skipped}.",
  筛选类或ClassLoader: "Filter class or ClassLoader",
  输入类名或ClassLoader: "Enter a class or ClassLoader",
  排序: "Sort",
  浅大小: "Shallow bytes",
  实例数: "Instances",
  平均浅大小: "Average shallow bytes",
  ClassLoader: "ClassLoader",
  "没有匹配的 Heap 类。": "No heap classes match the filter.",
  "一次有界 JVMTI Heap 遍历；临时类标签在返回前清除，不保留业务对象。":
    "One bounded JVMTI heap iteration; temporary class tags are cleared before return and no application objects are retained.",
  不可比较: "Not comparable",
  "目标已切换，请重新固定基线。": "The target changed. Pin a new baseline.",
  "缺少 JVM 启动时间，无法安全比较两次扫描。":
    "The JVM start time is unavailable, so the two scans cannot be compared safely.",
  "目标 JVM 已重启，请重新固定基线。":
    "The target JVM restarted. Pin a new baseline.",
  "类名范围或结果行数已变化，请恢复基线参数或重新固定。":
    "The class scope or result-row limit changed. Restore the baseline settings or pin a new baseline.",
  "对象遍历预算已变化，请恢复基线参数或重新固定。":
    "The object scan budget changed. Restore the baseline settings or pin a new baseline.",
  "两次扫描之间，哪些类在增长。": "Which classes grew between two scans.",
  "固定当前扫描，再以完全相同的类范围与预算扫描一次；差分只在同一目标和 JVM 启动周期内成立。":
    "Pin the current scan, then scan again with exactly the same class scope and budget. A diff is valid only for the same target and JVM lifetime.",
  固定当前为基线: "Pin current as baseline",
  清除基线: "Clear baseline",
  "尚未固定基线。当前扫描只展示绝对值，不推断对象增长或释放。":
    "No baseline is pinned. The current scan shows absolute values only and does not infer growth or release.",
  类范围: "Class scope",
  等待扫描: "Waiting for scan",
  "间隔 {duration}": "{duration} interval",
  全部已加载类: "All loaded classes",
  遍历预算: "Scan budget",
  实例净变化: "Net instance change",
  浅大小净变化: "Net shallow-byte change",
  增长类: "Growing classes",
  释放类: "Released classes",
  "覆盖不完整：总量截断 {totals}；Top N 未覆盖的基线行 {baseline}、当前行 {current} 不参与新增或释放判定。":
    "Coverage is incomplete: aggregate traversal truncated {totals}; {baseline} baseline and {current} current rows outside Top N are excluded from new/released classification.",
  筛选差分类或ClassLoader: "Filter diff class or ClassLoader",
  差分排序: "Diff sort",
  绝对浅大小变化: "Absolute shallow-byte change",
  增长优先: "Growth first",
  释放优先: "Release first",
  绝对实例变化: "Absolute instance change",
  类与ClassLoader: "Class and ClassLoader",
  基线实例: "Baseline instances",
  当前实例: "Current instances",
  实例变化: "Instance change",
  浅大小变化: "Shallow-byte change",
  "没有可比较的 Heap 类。": "No comparable heap classes.",
  "差分使用类名与精确 ClassLoader 身份联合匹配，时间复杂度 O(B+C)，不会保留业务对象。":
    "The diff matches class name with exact ClassLoader identity in O(B+C) time and retains no application objects.",
  "谁真正占住了内存。": "What actually retains the memory.",
  "一次全堆支配分析，按类合并同类实例的支配子树；嵌套的同类实例只计算一次。":
    "One whole-heap dominator analysis unions dominated subtrees by class; nested instances of the same class are counted once.",
  精确类排行: "Exact class ranking",
  候选类排行: "Candidate class ranking",
  "结果筛选（可选）": "Result filter (optional)",
  "例如 dev.example 或 ClassLoader": "For example, dev.example or ClassLoader",
  "我确认执行一次有界全堆强引用扫描，并使用最多 {nodes} 个节点、{edges} 条边计算类级支配并集。":
    "I confirm one bounded whole-heap strong-reference scan using at most {nodes} nodes and {edges} edges to compute class-level retained unions.",
  "计算类 Retained 排行": "Calculate class retained ranking",
  强引用图: "Strong-reference graph",
  "{nodes} 节点 / {edges} 边": "{nodes} nodes / {edges} edges",
  可达内存: "Reachable memory",
  类型标签: "Class tags",
  "{tagged} 完成 / {skipped} 跳过": "{tagged} completed / {skipped} skipped",
  "预算或元数据边界已触顶，当前显示候选支配并集，不标记为精确 Retained。":
    "A graph or metadata boundary was reached. Candidate retained unions are shown and are not labeled as exact retained sizes.",
  排名: "Rank",
  "类 / ClassLoader": "Class / ClassLoader",
  钻取: "Inspect",
  检查实例: "Inspect instances",
  "当前筛选没有存活实例。": "No live instances match the current filter.",
  "类级值是该类最上层支配节点子树的并集；不会重复累计被同类祖先支配的实例。":
    "A class value is the union of subtrees rooted at its topmost dominator nodes; instances dominated by a same-class ancestor are not counted twice.",
  Agent返回了无效的类Retained排行:
    "The Agent returned an invalid class retained ranking",
  "沿着支配关系向下看。": "Follow the dominator hierarchy.",
  "从虚拟 GC Root 开始，优先保留 Retained 最大的直接支配子节点；折叠只影响当前视图，不会重新扫描 Heap。":
    "Start at the virtual GC Root and prioritize directly dominated children with the largest retained sizes. Collapsing changes only the current view and does not rescan the heap.",
  精确支配树: "Exact dominator tree",
  候选支配树: "Candidate dominator tree",
  视图深度: "View depth",
  视图节点: "View nodes",
  "GC Root 分支": "GC Root branches",
  每节点分支: "Branches per node",
  "我确认构建最多 {nodes} 个节点、{edges} 条边的全堆支配图，并仅展示最多 {view} 个关键节点。":
    "I confirm building a whole-heap dominator graph with at most {nodes} nodes and {edges} edges, while displaying at most {view} key nodes.",
  构建支配树: "Build dominator tree",
  完整强引用图: "Whole strong-reference graph",
  根可达内存: "Root-reachable memory",
  "GC Root 直接子节点": "Direct GC Root children",
  当前视图: "Current view",
  "{visible} 可见 / {total} 返回": "{visible} visible / {total} returned",
  "全堆图达到预算或元数据不完整；当前树用于候选定位，不显示精确 Retained。":
    "The whole-heap graph reached a budget or has incomplete metadata. This tree is for candidate discovery and does not show exact retained sizes.",
  "全堆 Retained 数值精确；当前树仅按深度、总节点和分支预算展示最大的支配路径。":
    "Whole-heap retained values are exact. This view shows only the largest dominator paths within its depth, node, and branch budgets.",
  "虚拟 GC Root": "Virtual GC Root",
  "{count} 个直接支配子节点": "{count} directly dominated children",
  展开支配子树: "Expand dominated subtree",
  折叠支配子树: "Collapse dominated subtree",
  直接子节点: "Direct children",
  "{shown}/{total}": "{shown}/{total}",
  检查对象: "Inspect object",
  "当前图没有可展示的根可达对象。":
    "This graph has no root-reachable objects to display.",
  Agent返回了无效的支配树: "The Agent returned an invalid dominator tree",
  打开交互报告: "Open interactive report",
  在应用内打开报告: "Open report in Tanwei",
  只有已就绪的性能报告可以在应用内打开:
    "Only ready performance reports can be opened in Tanwei",
  无法打开性能报告: "Unable to open the performance report",
  分析JFR: "Inspect JFR",
  "只有已就绪的 JFR 制品可以分析": "Only ready JFR artifacts can be inspected",
  "无法分析 JFR 制品": "Unable to inspect the JFR artifact",
  "JFR 事件检查器": "JFR event inspector",
  "录制内容，直接检查。": "Inspect the recording directly.",
  "{start} 至 {end}": "{start} to {end}",
  关闭检查器: "Close inspector",
  事件类型: "Event types",
  "峰值 JVM CPU": "Peak JVM CPU",
  "GC 停顿合计": "Total GC pause",
  "JIT 编译": "JIT compilations",
  "OSR / 失败": "OSR / failed",
  去优化: "Deoptimizations",
  生成代码: "Generated code",
  "Host 已重新校验真实路径、大小与 SHA-256；只解析选定事件，最多读取 32 MiB JSON 和 200,000 条事件。":
    "The Host reverified the canonical path, size, and SHA-256. Only selected events are parsed, up to 32 MiB of JSON and 200,000 events.",
  "结果已按安全上限截断。": "The result was truncated at the safety boundary.",
  编译热点: "Compilation hotspots",
  "{count} 组": "{count} groups",
  "编译器 / 层级": "Compiler / level",
  "次数 / OSR": "Count / OSR",
  "成功 / 失败 / 未知": "Succeeded / failed / unknown",
  "总耗时 / 最慢": "Total / slowest",
  "代码 / 内联": "Code / inlined",
  "这次录制没有达到 1 ms 阈值的 Compilation 事件。":
    "This recording contains no compilation event at or above the 1 ms threshold.",
  编译器分层: "Compiler tiers",
  失败: "failed",
  "这次录制没有编译分层数据。":
    "This recording contains no compiler-tier data.",
  去优化原因: "Deoptimization reasons",
  "这次录制没有 Deoptimization 事件。":
    "This recording contains no deoptimization events.",
  热点方法: "Hot methods",
  占比: "Share",
  "这次录制没有 Execution Sample。":
    "This recording contains no execution samples.",
  分配热点: "Allocation hotspots",
  估算大小: "Estimated bytes",
  "这次录制没有 Allocation Sample。":
    "This recording contains no allocation samples.",
  事件分布: "Event distribution",
  "GC 停顿": "GC pauses",
  原因: "Cause",
  查看制品: "View artifacts",
  诊断操作执行失败: "Diagnostic action failed",
  Agent未能完成操作: "The Agent could not complete the action",
  Agent未返回Profiler任务标识:
    "The Agent did not return a profiler task identifier",
  Agent返回的制品描述无效: "The Agent returned an invalid artifact descriptor",
  无法保存诊断制品: "Unable to save the diagnostic artifact",
  "证据成为文件。": "Turn evidence into files.",
  "文件先写入受控临时路径并同步落盘，完成 SHA-256 校验后原子重命名；Renderer 永远看不到绝对路径。":
    "Files are written and synced through a controlled temporary path, verified with SHA-256, then atomically renamed. The Renderer never sees absolute paths.",
  "{count} 个已登记制品 · 默认上限 2 GiB":
    "{count} registered artifacts · 2 GiB default limit",
  固定当前快照: "Pin current snapshot",
  "确认删除 {name}？": "Delete {name}?",
  "目标制品 ID：{id}。文件删除后不可从探微恢复。":
    "Artifact ID: {id}. Once deleted, the file cannot be recovered by Tanwei.",
  "在系统文件管理器中显示？": "Show in the system file manager?",
  "目标文件：{name} · {size}": "Target file: {name} · {size}",
  确认显示: "Confirm and show",
  在文件夹中显示: "Show in folder",
  删除制品: "Delete artifact",
  "还没有固定证据。": "No evidence has been pinned yet.",
  "连接目标后可把当前结构化快照保存为本地制品。":
    "Connect a target to save the current structured snapshot as a local artifact.",
  无法读取制品列表: "Unable to read the artifact list",
  请先选择并连接目标JVM: "Select and connect a target JVM first",
  无法创建诊断快照: "Unable to create a diagnostic snapshot",
  无法删除制品: "Unable to delete the artifact",
  制品校验失败: "Artifact verification failed",
  无法在系统中显示制品:
    "Unable to show the artifact in the system file manager",
  "诊断形成上下文。": "Build diagnostic context.",
  "案例元数据使用本地 SQLite 事务与版本迁移；会话密钥、凭据和未固定对象值不会写入数据库。":
    "Case metadata uses local SQLite transactions and versioned migrations. Session secrets, credentials, and unpinned object values are never written to the database.",
  导入案例: "Import case",
  "导入仅接受探微 schema v1 JSON；外部路径不会暴露给 Renderer。":
    "Import accepts only Tanwei schema v1 JSON. External paths are never exposed to the Renderer.",
  "建立一次可交接的诊断。": "Create a handoff-ready diagnosis.",
  标题: "Title",
  "标签（逗号分隔）": "Tags (comma-separated)",
  笔记: "Notes",
  创建案例: "Create case",
  搜索案例: "Search cases",
  "没有笔记。": "No notes.",
  案例标签: "Case tags",
  "更新于 {time}": "Updated {time}",
  证据与导出: "Evidence and export",
  归档: "Archive",
  "还没有可固定的制品。": "No artifacts are available to pin.",
  "还没有可固定的 Action 摘要。": "No Action summaries are available to pin.",
  固定所选证据: "Pin selected evidence",
  脱敏预览: "Redacted preview",
  "探微 {version} · {artifacts} 个制品摘要 · {actions} 个 Action 摘要 · {bytes} bytes":
    "Tanwei {version} · {artifacts} artifact summaries · {actions} Action summaries · {bytes} bytes",
  "已遮罩 {count} 处疑似敏感字段。":
    "{count} potentially sensitive fields redacted.",
  查看导出笔记: "View exported notes",
  确认导出为制品: "Confirm export as artifact",
  "没有匹配的诊断案例。": "No diagnostic cases match.",
  无法读取案例与证据: "Unable to read cases and evidence",
  无法读取案例证据: "Unable to read case evidence",
  无法固定案例证据: "Unable to pin case evidence",
  无法生成脱敏预览: "Unable to generate a redacted preview",
  无法导出案例: "Unable to export the case",
  无法导入案例: "Unable to import the case",
  无法删除案例: "Unable to delete the case",
  案例标题不能为空: "Case title cannot be empty",
  无法创建案例: "Unable to create the case",
  无法归档案例: "Unable to archive the case",
  "类与加载器。": "Classes and loaders.",
  "搜索在 Agent 内完成；每次仅返回一页，并保留相同类名在不同 ClassLoader 中的独立命中。":
    "Search runs inside the Agent. Each request returns one page and preserves separate matches for the same class name across ClassLoaders.",
  "连接目标后搜索已加载类。": "Connect a target to search loaded classes.",
  类名: "Class name",
  "例如 java.util.concurrent": "For example, java.util.concurrent",
  加载器树: "Loader tree",
  "Bootstrap · {count} 个已加载类": "Bootstrap · {count} loaded classes",
  "{count} 个加载器": "{count} loaders",
  "父级 {parent}": "Parent {parent}",
  "{classes} 类 · {urls} URL": "{classes} classes · {urls} URLs",
  "该加载器不公开 URL；这在 JDK 9+ 内置加载器中是正常情况。":
    "This loader exposes no URLs, which is expected for built-in loaders on JDK 9+.",
  "定位占用 Class Metadata 的加载器。":
    "Find the loaders consuming class metadata.",
  "临时启用 JFR ClassLoaderStatistics，只读取 ClassLoaderData 的 Metaspace 分配与使用；不会遍历业务对象，也不是 Java Heap retained size。":
    "Temporarily enable JFR ClassLoaderStatistics and read only ClassLoaderData metaspace allocation and usage. This does not traverse application objects and is not Java heap retained size.",
  "当前 JDK 不提供 ClassLoader Metaspace 事件。":
    "The current JDK does not provide ClassLoader metaspace events.",
  采样窗口: "Sampling window",
  展示上限: "Display limit",
  采集元空间占用: "Sample metaspace usage",
  等待采样: "Waiting for sample",
  "加载器 / 事件": "Loaders / events",
  普通类: "Regular classes",
  "已使用 / 已分配": "Used / allocated",
  "隐藏类 / 已使用": "Hidden classes / used",
  "列表只保留分配量最大的加载器，汇总仍覆盖本次已读取的全部最新事件。":
    "The table retains only the largest allocated loaders. Totals still cover every latest event read in this sample.",
  加载器: "ClassLoader",
  已使用: "Used",
  已分配: "Allocated",
  利用率: "Utilization",
  隐藏类: "Hidden classes",
  "本次窗口没有产生 ClassLoaderStatistics 事件。":
    "No ClassLoaderStatistics events were emitted in this window.",
  "尚未采集元空间样本。": "No metaspace sample has been collected.",
  "选择一个短窗口，结果按已分配 Metaspace 降序排列。":
    "Choose a short window. Results are sorted by allocated metaspace.",
  元空间结果数量: "Metaspace result count",
  "ClassLoader 总数": "ClassLoader total",
  "JFR 事件数量": "JFR event count",
  元空间采样时长: "Metaspace sampling duration",
  元空间采样周期: "Metaspace sampling period",
  采样开始时间: "Sampling start time",
  采样完成时间: "Sampling completion time",
  "元空间截断状态无效。": "The metaspace truncation state is invalid.",
  "加载器 ID": "ClassLoader ID",
  加载器名称: "ClassLoader name",
  加载器类型: "ClassLoader type",
  "父加载器 ID": "Parent ClassLoader ID",
  父加载器名称: "Parent ClassLoader name",
  已分配元空间: "Allocated metaspace",
  已使用元空间: "Used metaspace",
  隐藏类已分配元空间: "Allocated hidden-class metaspace",
  隐藏类已使用元空间: "Used hidden-class metaspace",
  已加载类数量: "Loaded class count",
  隐藏类数量: "Hidden class count",
  加载器采样时间: "ClassLoader sample time",
  类总数: "Class total",
  元空间分配总量: "Total allocated metaspace",
  元空间使用总量: "Total used metaspace",
  隐藏类总数: "Hidden class total",
  隐藏类元空间分配总量: "Total allocated hidden-class metaspace",
  隐藏类元空间使用总量: "Total used hidden-class metaspace",
  "元空间结果包含重复加载器。":
    "The metaspace result contains duplicate ClassLoaders.",
  "元空间容量或排序响应无效。":
    "The metaspace capacity or ordering response is invalid.",
  "元空间汇总响应无效。": "The metaspace totals are invalid.",
  "{label} 不是有效的非负整数。":
    "{label} is not a valid non-negative integer.",
  "{label} 无效。": "{label} is invalid.",
  "无法采集 ClassLoader 元空间": "Unable to sample ClassLoader metaspace",
  "匹配 {count}": "{count} matches",
  可转换: "Modifiable",
  "当前条件没有匹配类。": "No classes match the current filters.",
  "未知 / JDK 8": "Unknown / JDK 8",
  允许转换: "Transformation allowed",
  不可转换: "Transformation unavailable",
  "读取中…": "Loading…",
  "捕获 Class Dump": "Capture Class Dump",
  进入方法观测: "Open method observation",
  未命中: "No match",
  唯一来源: "Unique origin",
  "{count} 个可见来源": "{count} visible origins",
  资源来源数量: "Resource origin count",
  资源扫描数量: "Resource scan count",
  资源定位耗时: "Resource lookup duration",
  "ClassLoader 资源定位响应无效。":
    "The ClassLoader resource lookup response is invalid.",
  "ClassLoader 资源定位范围无效。":
    "The ClassLoader resource lookup scope is invalid.",
  "ClassLoader 资源定位身份不匹配。":
    "The ClassLoader resource lookup identity does not match.",
  "无法定位 ClassLoader 资源": "Unable to locate the ClassLoader resource",
  "沿精确加载器检查资源来源。":
    "Inspect resource origins through the exact loader.",
  "只定位资源 URL，不读取内容；最多返回 100 个唯一来源、扫描 1,000 项并等待 2 秒。自定义 ClassLoader 可能执行其资源查找代码。":
    "Locate resource URLs without reading content. Return at most 100 unique origins, scan 1,000 entries, and wait 2 seconds. A custom ClassLoader may execute its resource lookup code.",
  "ClassLoader 相对资源名": "ClassLoader-relative resource name",
  "例如 META-INF/services/java.sql.Driver":
    "For example, META-INF/services/java.sql.Driver",
  定位可见来源: "Locate visible origins",
  查找范围: "Lookup scope",
  "Bootstrap / 系统资源": "Bootstrap / system resources",
  选中加载器及其父级: "Selected loader and its parents",
  扫描: "Scanned",
  "{count} 项 · {duration} ms": "{count} entries · {duration} ms",
  "结果已触达扫描、来源或字符预算；缩小资源名后重试。":
    "The result reached a scan, origin, or character budget. Narrow the resource name and retry.",
  "当前加载器链没有找到该资源。":
    "The current loader chain did not find this resource.",
  "静态字段，先看元数据再读单值。":
    "Static fields: inspect metadata before reading one value.",
  "打开类时只枚举字段，不读取值；读取单个字段可能执行声明类的 <clinit>。":
    "Opening a class only enumerates fields. Reading one value may execute the declaring class's <clinit>.",
  生成读取预览: "Prepare read preview",
  "读取可能触发类初始化，并执行任意业务静态初始化代码。":
    "Reading may initialize the class and execute arbitrary application static-initializer code.",
  "我确认读取 {declaringClass}.{fieldName}；此操作可能触发类初始化和业务副作用。":
    "I confirm reading {declaringClass}.{fieldName}; this may initialize the class and cause application side effects.",
  确认并读取单值: "Confirm and read one value",
  "当前类没有静态字段。": "This class has no static fields.",
  "当前 Agent 不支持静态字段检查：{reason}":
    "Static field inspection is unavailable in the current Agent: {reason}",
  能力不可用: "Capability unavailable",
  无法读取静态字段元数据: "Unable to read static field metadata",
  无法生成静态字段读取预览: "Unable to prepare the static field read preview",
  无法读取静态字段: "Unable to read the static field",
  "按精确类扫描存活实例，再用会话弱句柄检查直接引用；字段值有界展示且不会自动写入磁盘。":
    "Scan live instances of the exact class, then inspect direct references through session-scoped weak handles. Field values are bounded and never written to disk automatically.",
  实例上限: "Instance limit",
  "我理解 JVMTI Heap 扫描可能暂停目标，并会在当前页面显示对象字段。":
    "I understand that a JVMTI heap scan may pause the target and display object fields on this page.",
  确认并查询实例: "Confirm and query instances",
  "当前目标不支持 Heap 实例查询：{reason}":
    "Heap instance queries are unavailable on this target: {reason}",
  未提供原生能力: "Native capability not provided",
  "实例 @{identity} · 浅大小 {size} bytes":
    "Instance @{identity} · {size} bytes shallow",
  "当前扫描未找到该精确类型的存活实例。":
    "No live instances of this exact type were found in the current scan.",
  Heap实例查询失败: "Heap instance query failed",
  "批量 Retained 排行": "Batch retained-size ranking",
  "一次强引用图扫描同时计算多个样本对象的支配子树；不会为每个对象重复扫描全堆。":
    "One strong-reference graph scan computes dominator subtrees for multiple sampled objects without rescanning the whole heap for each object.",
  样本实例数: "Sample instances",
  支配图节点预算: "Dominator graph node budget",
  支配图边预算: "Dominator graph edge budget",
  "我确认对 {className} 采样最多 {instances} 个实例，并构建最多 {nodes} 个节点、{edges} 条强引用边的全堆支配图。":
    "I confirm sampling at most {instances} instances of {className} and building a whole-heap dominator graph bounded to {nodes} nodes and {edges} strong-reference edges.",
  "计算样本 Retained 排行": "Calculate sampled retained ranking",
  精确排行: "Exact ranking",
  候选排行: "Candidate ranking",
  "共享分析 {nodes} 个图节点 / {edges} 条强引用边 · {count} 个样本":
    "Shared analysis of {nodes} graph nodes / {edges} strong-reference edges · {count} samples",
  "覆盖 {nodes} 个根可达节点 / {bytes} bytes":
    "Covered {nodes} root-reachable nodes / {bytes} bytes",
  节点预算触顶: "Node budget reached",
  边预算触顶: "Edge budget reached",
  标签冲突: "Tag conflicts",
  "支配图不完整；当前数值只用于候选排序，不会冒充精确 retained size。":
    "The dominator graph is incomplete. Current values are candidates for ranking and are never presented as exact retained sizes.",
  "排名 #{rank}": "Rank #{rank}",
  "精确 Retained": "Exact retained",
  "候选 Retained": "Candidate retained",
  支配对象: "Dominated objects",
  检查此对象: "Inspect this object",
  "当前精确类型没有可分析的存活实例。":
    "No analyzable live instances of this exact type were found.",
  批量Retained排行查询失败: "Batch retained ranking query failed",
  Agent返回了无效的批量Retained排行:
    "The Agent returned an invalid batch retained ranking",
  检查对象关系: "Inspect object relations",
  对象关系检查器: "Object relation inspector",
  返回上一对象: "Back to previous object",
  "浅大小 {size} bytes": "{size} bytes shallow",
  "弱句柄不会阻止 GC；新实例扫描会使当前关系导航失效。":
    "Weak handles do not prevent garbage collection. A new instance scan invalidates the current relation navigation.",
  引用方向: "Reference direction",
  出向引用: "Outgoing references",
  入向引用: "Incoming references",
  多层对象图: "Multi-layer object graph",
  "GC Root 路径": "GC Root path",
  "Retained / 支配": "Retained / dominator",
  关系上限: "Relation limit",
  图方向: "Graph direction",
  向下展开出向引用: "Expand outgoing references",
  向上合并保留路径: "Merge incoming retention paths",
  最大图深度: "Maximum graph depth",
  图节点上限: "Graph node limit",
  每节点分支上限: "Branch limit per node",
  出向: "outgoing ",
  入向: "incoming ",
  路径上限: "Path limit",
  扫描边预算: "Edge scan budget",
  最大路径深度: "Maximum path depth",
  临时标记对象预算: "Temporary tagged-object budget",
  当前对象字段: "Current object fields",
  "我确认检查对象 @{identity} 的直接引用；入向查询最多扫描 {budget} 条引用边。":
    "I confirm inspection of direct references for object @{identity}. Incoming traversal scans at most {budget} reference edges.",
  "我确认对对象 @{identity} 执行一次有界全堆引用扫描；最多临时标记 {nodes} 个对象、检查 {budget} 条边，返回前会清理临时标记。":
    "I confirm one bounded whole-heap reference scan for object @{identity}. It temporarily tags at most {nodes} objects, inspects {budget} edges, and removes temporary tags before returning.",
  "我确认对对象 @{identity} 执行一次有界全堆引用扫描；最多返回 {paths} 条路径、临时标记 {nodes} 个对象并检查 {budget} 条边，返回前会清理临时标记。":
    "I confirm one bounded whole-heap reference scan for object @{identity}. It returns at most {paths} paths, temporarily tags at most {nodes} objects, inspects {budget} edges, and removes temporary tags before returning.",
  "我确认对对象 @{identity} 执行两次有界强引用扫描；每次最多检查 {budget} 条边，闭包最多临时标记 {nodes} 个对象。只有两次扫描完整、弱引用语义完整且无标签冲突时才报告精确 retained size。":
    "I confirm two bounded strong-reference scans for object @{identity}. Each pass inspects at most {budget} edges and the closure temporarily tags at most {nodes} objects. An exact retained size is reported only when both passes complete, weak-reference semantics are complete, and no tag conflicts occur.",
  "我确认以对象 @{identity} 为中心按最大深度 {depth} 展开（起点深度为 0），最多返回 {nodes} 个节点、每节点 {branches} 条{direction}关系，并在 {budget} 条扫描边预算内停止。":
    "I confirm a graph centered on object @{identity}, expanded to maximum depth {depth} (the start object is depth 0), bounded to {nodes} nodes, {branches} {direction}references per node, and {budget} scanned edges.",
  开始关系检查: "Start relation inspection",
  生成多层对象图: "Generate multi-layer object graph",
  "回溯 GC Root": "Trace to GC Root",
  "回溯多条 GC Root 路径": "Trace multiple GC Root paths",
  "计算 Retained size": "Calculate retained size",
  "已检查 {scanned} 条边 · 返回 {count} 条关系":
    "Inspected {scanned} edges · returned {count} relations",
  "已检查 {scanned} 条边 · 临时标记 {tagged} 个对象 · 路径 {count} 个节点":
    "Inspected {scanned} edges · temporarily tagged {tagged} objects · {count} path nodes",
  "已检查 {scanned} 条边 · 临时标记 {tagged} 个对象 · 返回 {paths} 条路径 / {nodes} 个节点":
    "Inspected {scanned} edges · temporarily tagged {tagged} objects · returned {paths} paths / {nodes} nodes",
  "已检查 {scanned} 条边 · {nodes} 个节点 / {edges} 条图边 · {layers} 层":
    "Inspected {scanned} edges · {nodes} nodes / {edges} graph edges · {layers} layers",
  "精确 retained size {bytes} bytes · 支配 {objects} 个对象 · 双遍检查 {edges} 条边":
    "Exact retained size {bytes} bytes · dominates {objects} objects · {edges} edges across two passes",
  "候选支配集 {bytes} bytes / {objects} 个对象 · 双遍检查 {edges} 条边":
    "Candidate dominator set {bytes} bytes / {objects} objects · {edges} edges across two passes",
  精确结果: "Exact result",
  "仅候选值，不是精确结果": "Candidate only, not exact",
  "达到预算，结果已截断": "Budget reached; results truncated",
  结果完整: "Complete result",
  "已到达 GC Root": "GC Root reached",
  "全部路径到达 GC Root": "All paths reached a GC Root",
  "{reached}/{count} 条路径到达 GC Root · 结果有界":
    "{reached}/{count} paths reached a GC Root · bounded result",
  "预算内未到达 GC Root": "GC Root not reached within budget",
  沿此对象继续: "Continue with this object",
  多层对象引用图: "Multi-layer object reference graph",
  "出向图按对象字段逐层展开；重复对象合并为同一节点。":
    "The outgoing graph expands object fields layer by layer and merges repeated objects into one node.",
  "入向图合并多条保留路径；重复持有者合并为同一节点。":
    "The incoming graph merges multiple retention paths and collapses repeated retainers into one node.",
  "图已在所选预算处停止：节点 {nodes} · 深度 {depth} · 分支 {branches}。":
    "The graph stopped at the selected budget: nodes {nodes} · depth {depth} · branches {branches}.",
  "深度 {depth}": "Depth {depth}",
  "{count} 个对象": "{count} objects",
  起点对象: "Start object",
  "对象 #{index}": "Object #{index}",
  以此对象为中心: "Center on this object",
  未知对象: "Unknown object",
  "对象到 GC Root 的保留路径": "Retention path from object to GC Root",
  "对象到 GC Root 的多条保留路径":
    "Multiple retention paths from object to GC Root",
  "对象到 GC Root 的保留路径 {index}":
    "Retention path {index} from object to GC Root",
  "路径 {index}": "Path {index}",
  路径在预算处截断: "Path truncated at the selected budget",
  "GC Root": "GC Root",
  目标对象: "Target object",
  "持有者 {index}": "Retainer {index}",
  检查此持有者: "Inspect this retainer",
  "通过 {relation} 持有": "Retains through {relation}",
  "没有发现符合预算的对象关系。":
    "No object relations were found within the selected budget.",
  目标可达闭包: "Target reachable closure",
  候选支配集: "Candidate dominator set",
  "{bytes} bytes / {objects} 个对象": "{bytes} bytes / {objects} objects",
  "临时标记 / 标签冲突": "Temporary tags / tag conflicts",
  弱引用语义: "Weak-reference semantics",
  完整: "Complete",
  不完整: "Incomplete",
  "扫描达到预算、存在外部标签冲突或弱引用元数据不完整；候选值只用于缩小范围，不会冒充精确 retained size。":
    "A scan reached its budget, external tags conflicted, or weak-reference metadata was incomplete. The candidate only narrows the search and is never presented as an exact retained size.",
  "浅大小贡献 #{rank}": "Shallow-size contributor #{rank}",
  "{bytes} bytes": "{bytes} bytes",
  分析此对象: "Analyze this object",
  未知引用: "Unknown reference",
  对象关系查询失败: "Object relation query failed",
  Agent返回了无效的对象关系:
    "The Agent returned an invalid object relation response",
  多层对象图查询失败: "Multi-layer object graph query failed",
  Agent返回了无效的多层对象图:
    "The Agent returned an invalid multi-layer object graph",
  "GC Root路径查询失败": "GC Root path query failed",
  "Agent返回了无效的GC Root路径": "The Agent returned an invalid GC Root path",
  "多路径GC Root查询失败": "Multi-path GC Root query failed",
  "Agent返回了无效的多路径GC Root结果":
    "The Agent returned an invalid multi-path GC Root result",
  当前对象句柄已失效: "The current object handle has expired",
  "Retained size查询失败": "Retained size query failed",
  "Agent返回了无效的Retained size结果":
    "The Agent returned an invalid retained-size result",
  "将对该 ClassLoader 下的精确类执行一次受控重转换并保存运行中字节码。此操作为 R2。":
    "The exact class under this ClassLoader will be retransformed once under policy control and its live bytecode saved. This is an R2 action.",
  确认捕获: "Confirm capture",
  "已保存 {name} · SHA-256 {sha256}": "Saved {name} · SHA-256 {sha256}",
  "反编译源码 · CFR 0.152": "Decompiled source · CFR 0.152",
  可编辑类源码: "Editable class source",
  "源码在受限 Host 编译进程中临时编译；预检只允许修改方法体，不允许改变字段、方法签名、父类或接口。":
    "Source is compiled transiently in a bounded Host compiler process. Preflight permits method-body changes only; fields, method signatures, superclass, and interfaces must remain unchanged.",
  编译并预检类定义: "Compile and preflight class definition",
  "当前 SHA-256": "Current SHA-256",
  "候选 SHA-256": "Candidate SHA-256",
  结构兼容: "Structurally compatible",
  "我已核对精确类、ClassLoader、两个校验值和 R3 影响，并保留本次内存回滚。":
    "I reviewed the exact class, ClassLoader, both checksums, and R3 impact, and will retain this in-memory rollback.",
  确认替换方法体: "Confirm method-body replacement",
  "我确认仅在当前校验值仍匹配时恢复本次替换前的类定义。":
    "I confirm restoration only if the current checksum still matches.",
  恢复替换前定义: "Restore previous definition",
  无法编译编辑后的类: "Unable to compile the edited class",
  类替换兼容性预检失败: "Class replacement compatibility preflight failed",
  运行时类替换失败: "Runtime class replacement failed",
  无法恢复替换前的类定义: "Unable to restore the previous class definition",
  "把关联类作为一个变更集提交。": "Commit related classes as one change set.",
  "同一精确 ClassLoader 下选择 2—8 个类；Host 联合编译，Agent 绑定全部校验值并用一次 JVM 重定义整体提交或整体回滚。":
    "Select 2–8 classes from the same exact ClassLoader. The Host compiles them together, and the Agent binds every checksum before one JVM redefinition commits or restores the whole set.",
  "已提交，保留整体回滚": "Committed with whole-set rollback retained",
  "{count}/8 个类": "{count}/8 classes",
  更新当前类源码: "Update current class source",
  加入当前类: "Add current class",
  清空变更集: "Clear change set",
  打开源码: "Open source",
  "变更集还是空的。": "The change set is empty.",
  "编辑当前反编译源码后加入；再搜索、捕获并加入同一 ClassLoader 下的其他类。":
    "Edit and add the current decompiled source, then search, capture, and add other classes from the same ClassLoader.",
  源码预算: "Source budget",
  提交语义: "Commit semantics",
  "一次调用 · 全部成功或不提交": "One call · all succeed or none commit",
  联合编译并预检: "Compile together and preflight",
  变更集预检指纹: "Change-set preflight fingerprint",
  "我已核对全部精确类、ClassLoader、预检指纹和 R3 影响，并保留整体内存回滚。":
    "I reviewed every exact class, the ClassLoader, the preflight fingerprint, and the R3 impact, and will retain a whole-set in-memory rollback.",
  整体提交变更集: "Commit the whole change set",
  "我确认仅在全部当前校验值仍匹配时，通过一次 JVM 重定义整体恢复这组类。":
    "I confirm restoring the whole set with one JVM redefinition only if every current checksum still matches.",
  整体回滚变更集: "Restore the whole change set",
  "多类变更集只接受同一个精确 ClassLoader 下的类。":
    "A multi-class change set accepts classes from one exact ClassLoader only.",
  "多类变更集最多包含 8 个精确类。":
    "A multi-class change set accepts at most 8 exact classes.",
  "单类源码不得超过 1 MiB，变更集源码总量不得超过 2 MiB。":
    "Each source must not exceed 1 MiB, and total change-set source must not exceed 2 MiB.",
  "变更集中的精确类已不在当前目标中。":
    "An exact class in the change set is no longer present in the current target.",
  "没有可保存草稿的目标 JVM。":
    "There is no target JVM available for saving this draft.",
  无法保存类变更集草稿: "Unable to save the class change-set draft",
  无法恢复类变更集草稿: "Unable to restore the class change-set draft",
  正在恢复本地草稿: "Restoring local draft",
  正在保存本地草稿: "Saving local draft",
  本地草稿保存失败: "Local draft save failed",
  草稿范围: "Draft scope",
  "已保存 · 当前目标 JVM 启动周期": "Saved · current target JVM lifecycle",
  "此设备 · 当前目标 JVM 启动周期":
    "This device · current target JVM lifecycle",
  多类变更集编译失败: "Multi-class change-set compilation failed",
  多类变更集预检失败: "Multi-class change-set preflight failed",
  多类变更集提交失败: "Multi-class change-set commit failed",
  多类变更集回滚失败: "Multi-class change-set restore failed",
  Agent返回了无效的变更集回滚凭据:
    "The Agent returned invalid change-set rollback credentials",
  "全部类已通过一次 JVM 原子重定义提交。":
    "Every class was committed through one atomic JVM redefinition.",
  "全部类已通过一次 JVM 原子重定义恢复。":
    "Every class was restored through one atomic JVM redefinition.",
  "接口：{interfaces}": "Interfaces: {interfaces}",
  "注解：{annotations}": "Annotations: {annotations}",
  "选择一个类查看加载器身份。":
    "Select a class to inspect its loader identity.",
  类分页: "Class pagination",
  无法读取ClassLoader摘要: "Unable to read the ClassLoader summary",
  无法读取已加载类: "Unable to read loaded classes",
  无法读取类详情: "Unable to read class details",
  无法捕获运行中字节码: "Unable to capture live bytecode",
  Agent返回的ClassDump描述无效:
    "The Agent returned an invalid Class Dump descriptor",
  无法保存ClassDump: "Unable to save the Class Dump",
  ClassDump已保存但反编译失败:
    "The Class Dump was saved, but decompilation failed",
  "等待目标连接与能力协商。":
    "Waiting for target connection and capability negotiation.",
  "页面不会发送未知文本命令；操作入口由当前 Agent 的 Action Schema、能力清单和风险策略共同决定。":
    "Pages never send unknown text commands. Available actions are jointly determined by the current Agent Action Schema, capability list, and risk policy.",
  "{label}最近趋势：{points}": "{label} recent trend: {points}",
  无法发现Java进程: "Unable to discover Java processes",
  连接失败: "Connection failed",
  断开失败: "Disconnection failed",
  线程与锁: "Threads and locks",
  类与加载器: "Classes and loaders",
  方法观测: "Method observation",
  性能剖析: "Performance profiling",
  专家控制台: "Expert console",
  "搜索已加载类、定位来源、检查 ClassLoader 并进入方法观测。":
    "Search loaded classes, locate their source, inspect ClassLoaders, and open method observation.",
  "以有界任务捕获参数、返回值、异常、耗时和调用树。":
    "Capture arguments, return values, exceptions, duration, and call trees with bounded tasks.",
  "管理 CPU、Wall、Allocation、Lock、JFR 与 Heap Dump 任务。":
    "Manage CPU, Wall, Allocation, Lock, JFR, and Heap Dump tasks.",
  "检查 MBean、系统属性、VM Options、日志与受控运行时操作。":
    "Inspect MBeans, system properties, VM Options, logging, and controlled runtime actions.",
  "通过 Action Schema 补全、校验并执行结构化诊断操作。":
    "Complete, validate, and execute structured diagnostic operations through Action Schemas.",
  "统一管理 JFR、Heap Dump、火焰图和诊断快照。":
    "Manage JFR, Heap Dump, flame graphs, and diagnostic snapshots in one place.",
  "将任务、证据、制品和笔记组织为可脱敏的诊断案例。":
    "Organize tasks, evidence, artifacts, and notes into redactable diagnostic cases.",
  "管理策略、存储、远程、语言、更新与支持信息。":
    "Manage policy, storage, remote access, language, updates, and support information.",
  "连接目标。": "Connect a target.",
  "在同一个桌面工作台连接本机、SSH 主机或 Kubernetes Pod。每种路径都会先验证目标身份与运行时。":
    "Connect a local process, SSH host, or Kubernetes Pod from one desktop workbench. Every path verifies the target identity and runtime first.",
  目标连接方式: "Target connection method",
  本机: "Local",
  "通过 SSH 连接远程 JVM": "Connect to a remote JVM over SSH",
  "连接 Kubernetes Pod 内的 JVM": "Connect to a JVM inside a Kubernetes Pod",
  "探微使用内置客户端部署一次性 Relay；不会调用系统 ssh、scp 或 kubectl，也不会持久化本次凭据。":
    "Tanwei deploys an ephemeral Relay with built-in clients. It never invokes system ssh, scp, or kubectl, and it does not persist credentials from this session.",
  操作未完成: "Operation not completed",
  主机: "Host",
  端口: "Port",
  用户名: "Username",
  认证方式: "Authentication",
  密码: "Password",
  私钥: "Private key",
  "密码（仅本次会话）": "Password (this session only)",
  "OpenSSH 私钥（仅本次会话）": "OpenSSH private key (this session only)",
  "私钥口令（可选）": "Private-key passphrase (optional)",
  连接并生成部署预览: "Connect and generate deployment preview",
  当前: "Current",
  刷新集群目录: "Refresh cluster catalog",
  验证Pod并生成部署预览: "Validate Pod and generate deployment preview",
  "验证 Pod 并生成部署预览": "Validate Pod and generate deployment preview",
  远程部署预览: "Remote deployment preview",
  平台: "Platform",
  "SSH 主机密钥指纹": "SSH host-key fingerprint",
  一次性目录: "Ephemeral directory",
  将传输并校验的内置组件: "Bundled components to transfer and verify",
  将执行的步骤: "Steps to execute",
  "我已核对目标、平台、指纹、文件哈希和命令，并确认执行 R2 远程部署。":
    "I have reviewed the target, platform, fingerprint, file hashes, and commands, and confirm this R2 remote deployment.",
  取消并重新预检: "Cancel and run preflight again",
  确认部署并连接: "Confirm deployment and connect",
  "无法读取 Kubernetes Context": "Unable to read Kubernetes contexts",
  "无法读取 Namespace": "Unable to read namespaces",
  "无法读取 Pod": "Unable to read pods",
  "SSH 预检失败": "SSH preflight failed",
  "Kubernetes 预检失败": "Kubernetes preflight failed",
  远程部署失败: "Remote deployment failed",
  治理: "Governance",
  治理与扩展: "Governance and extensibility",
  "对比多个目标，管理签名模板、声明式插件与团队策略。":
    "Compare multiple targets and manage signed templates, declarative plugins, and team policies.",
  "持久 Relay": "Persistent Relay",
  "在同一个桌面工作台连接本机、SSH 主机、Kubernetes Pod 或 mTLS 持久 Relay。每种路径都会先验证目标身份与运行时。":
    "Connect a local process, SSH host, Kubernetes Pod, or persistent mTLS Relay from one desktop workbench. Every path verifies target identity and runtime first.",
  "连接已安装的持久 Relay": "Connect to an installed persistent Relay",
  "持久 Relay 只接受双向 TLS；证书、私钥与会话密钥仅用于本次连接，不写入 SQLite，断开不会停止远端服务。":
    "Persistent Relay accepts mutual TLS only. Certificates, private keys, and the session secret are used only for this connection, never written to SQLite, and disconnecting does not stop the remote service.",
  "TLS 服务名": "TLS server name",
  "目标显示名（可选）": "Target display name (optional)",
  "CA 证书 PEM（仅本次会话）": "CA certificate PEM (this session only)",
  "客户端证书 PEM（仅本次会话）": "Client certificate PEM (this session only)",
  "客户端私钥 PEM（仅本次会话）": "Client private key PEM (this session only)",
  "Relay 会话密钥（64 位十六进制）":
    "Relay session secret (64 hexadecimal characters)",
  "验证 mTLS 并生成连接预览": "Validate mTLS and generate a connection preview",
  "持久 Relay 预检失败": "Persistent Relay preflight failed",
  "持久 Relay 连接预览": "Persistent Relay connection preview",
  "CA 指纹": "CA fingerprint",
  客户端证书指纹: "Client certificate fingerprint",
  "我已核对目标、TLS 服务名、CA 与客户端证书指纹，并确认建立 R2 持久 Relay 连接。":
    "I reviewed the target, TLS server name, CA fingerprint, and client-certificate fingerprint, and confirm this R2 persistent Relay connection.",
  "确认 mTLS 连接": "Confirm mTLS connection",
  "把诊断能力变成可验证资产。":
    "Turn diagnostic capabilities into verifiable assets.",
  "多目标对比、签名模板、声明式插件与团队策略都在 Host 中验证；插件不执行任意 JavaScript，团队策略只能收紧本机权限。":
    "Multi-target comparisons, signed templates, declarative plugins, and team policies are verified by the Host. Plugins cannot execute arbitrary JavaScript, and team policies can only tighten local permissions.",
  完成: "Completed",
  "同一时刻，对比多个 JVM。": "Compare multiple JVMs at one moment.",
  个已连接目标: "connected targets",
  "至少连接两个 JVM 后才能生成对比快照。":
    "Connect at least two JVMs before creating a comparison snapshot.",
  并发采集并对比: "Capture concurrently and compare",
  无法生成多目标对比: "Unable to create the multi-target comparison",
  基线: "Baseline",
  堆内存: "Heap",
  "保存安全默认值，不保存绕过。": "Save safe defaults, never bypasses.",
  个模板: "templates",
  名称: "Name",
  说明: "Description",
  "参数 JSON（仅字符串值）": "Parameters JSON (string values only)",
  "参数必须是字符串值组成的 JSON 对象":
    "Parameters must be a JSON object containing string values",
  校验并签名模板: "Validate and sign template",
  "我确认执行所选 R1 持续或中等成本模板。":
    "I confirm execution of the selected R1 continuous or medium-cost template.",
  "没有说明。": "No description.",
  风险: "Risk",
  来源: "Source",
  签名指纹: "Signing fingerprint",
  对当前目标执行: "Run on current target",
  "确认永久删除这个本地模板？": "Permanently delete this local template?",
  无法创建签名诊断模板: "Unable to create the signed diagnostic template",
  "诊断模板已签名并保存。": "The diagnostic template was signed and saved.",
  诊断模板执行失败: "Diagnostic template execution failed",
  "模板已执行：{actionId} · {status}":
    "Template executed: {actionId} · {status}",
  无法删除诊断模板: "Unable to delete the diagnostic template",
  "扩展能力，不扩大执行面。":
    "Extend capabilities without expanding the execution surface.",
  导入签名插件清单: "Import signed plugin manifest",
  "Plugin API v1 只允许贡献经过 Action Schema 校验的 R0/R1 诊断模板；不加载插件 JavaScript、Native 库或任意命令。":
    "Plugin API v1 permits only R0/R1 diagnostic templates validated by Action Schema. Plugin JavaScript, native libraries, and arbitrary commands are never loaded.",
  插件导入预检失败: "Plugin import preflight failed",
  "我已核对发布者、版本、签名指纹与模板数量。":
    "I reviewed the publisher, version, signing fingerprint, and template count.",
  确认安装插件: "Confirm plugin installation",
  无法安装插件: "Unable to install the plugin",
  卸载插件: "Uninstall plugin",
  "卸载会同时移除该插件提供的模板。":
    "Uninstalling also removes templates contributed by this plugin.",
  确认卸载: "Confirm uninstall",
  无法卸载插件: "Unable to uninstall the plugin",
  "组织约束只能更严格。": "Organization controls can only be stricter.",
  导入签名团队策略: "Import signed team policy",
  "当前没有启用团队策略包。": "No team policy package is active.",
  团队策略导入预检失败: "Team policy import preflight failed",
  最高风险: "Maximum risk",
  "个禁用 Action": "disabled Actions",
  移除团队策略: "Remove team policy",
  "移除后仍受本机最高风险等级约束。":
    "The local maximum risk level remains enforced after removal.",
  确认移除: "Confirm removal",
  无法移除团队策略: "Unable to remove the team policy",
  "我已核对签名、有效期、风险上限和禁用 Action。":
    "I reviewed the signature, validity period, risk ceiling, and disabled Actions.",
  确认启用团队策略: "Confirm team policy activation",
  无法启用团队策略: "Unable to activate the team policy",
  方法监控: "Method monitor",
  方法监控摘要: "Method monitor summary",
  "让调用趋势持续可见。": "Keep method trends visible.",
  "对一个精确方法建立轻量周期窗口，只统计完成调用、异常和耗时；不采集参数、返回对象或调用树。":
    "Create lightweight periodic windows for one exact method. Only completed calls, failures, and latency are counted; arguments, returned objects, and call trees are never captured.",
  "连接目标后选择方法监控。":
    "Connect a target, then select a method to monitor.",
  "当前 Agent 不支持方法监控。":
    "The current Agent does not support method monitoring.",
  "先从类检查器选择一个方法。":
    "Select a method from the class inspector first.",
  "监控绑定类、ClassLoader 和完整方法签名，不接受模糊匹配或通配符。":
    "A monitor binds the class, ClassLoader, and complete method signature. Fuzzy matches and wildcards are not accepted.",
  打开类检查器: "Open class inspector",
  "配置周期与自动结束边界。":
    "Configure the window and automatic stop boundary.",
  "完成调用计入其结束时所在窗口；并发边界附近的调用可能归入相邻窗口。":
    "A completed call is counted in the window where it ends. Calls near a concurrent boundary may be attributed to an adjacent window.",
  窗口周期: "Window interval",
  "30 秒": "30 seconds",
  "60 秒": "60 seconds",
  "持续时长（分钟）": "Duration (minutes)",
  预检精确方法: "Preflight exact method",
  "只增强这一条完整方法签名。":
    "Only this complete method signature will be instrumented.",
  "我确认对该方法启用有界轻量计数，并理解热点方法仍会产生少量监控开销。":
    "I confirm bounded lightweight counting for this method and understand that a hot method still incurs a small monitoring overhead.",
  确认并开始监控: "Confirm and start monitoring",
  完成调用: "Completed calls",
  "{count} 次异常": "{count} failures",
  累计平均耗时: "Cumulative average latency",
  "累计 P95 尾延迟": "Cumulative P95 tail latency",
  "累计 P99 尾延迟": "Cumulative P99 tail latency",
  累计最大耗时: "Cumulative maximum latency",
  "调用量与平均耗时。": "Call volume and average latency.",
  "调用量与尾延迟。": "Call volume and tail latency.",
  "{count} 个窗口": "{count} windows",
  窗口平均耗时趋势: "Average latency by window",
  "窗口平均与 P95 耗时趋势": "Average and P95 latency by window",
  "第一个周期结束后显示趋势。":
    "The trend appears after the first interval ends.",
  "即使没有调用，也会保留一个零值窗口。":
    "A zero-value window is retained even when there are no calls.",
  "柱：调用量": "Bars: call volume",
  "线：平均耗时": "Line: average latency",
  "虚线：平均耗时": "Dashed: average latency",
  "实线：P95 耗时": "Solid: P95 latency",
  "自动结束：{time}": "Automatic stop: {time}",
  自动结束边界未知: "Automatic stop boundary unavailable",
  调用: "Calls",
  平均: "Average",
  最大: "Maximum",
  "暂无周期数据。": "No periodic data yet.",
  "停止并移除这一个增强。": "Stop and remove this one instrumentation.",
  "停止后保留当前页面的统计结果；统一任务中心也可以按同一任务标识停止。":
    "Statistics remain on this page after stopping. The unified task center can stop the same exact task identity.",
  "我确认停止当前方法监控任务。":
    "I confirm stopping the current method monitor task.",
  停止监控: "Stop monitor",
  无法确认监控方法: "Unable to confirm the monitor method",
  无法启动方法监控: "Unable to start method monitoring",
  Agent返回的监控任务无效: "The Agent returned an invalid monitor task",
  无法读取监控窗口: "Unable to read monitor windows",
  无法停止方法监控: "Unable to stop method monitoring",
  "监控已结束，结果保留在当前页面。":
    "Monitoring has ended; results remain on this page.",
  重新配置: "Configure again",
  "完成调用 {current} · 异常 {dropped}":
    "{current} completed calls · {dropped} failures",
  "统一查看探微创建的观测、监控、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。":
    "Inspect Tanwei-owned observation, monitor, sampling, and JFR tasks in one place. Cancellation binds an exact task identity; sampling and recording results are collected into the local artifact library first.",
  "可从观测、监控或剖析页面启动一个有界任务。":
    "Start a bounded task from the observation, monitor, or profile page.",
  "统一查看探微创建的观测、Trace、监控、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。":
    "Inspect Tanwei-owned observation, Trace, monitor, sampling, and JFR tasks in one place. Cancellation binds an exact task identity; sampling and recording results are collected into the local artifact library first.",
  "可从观测、Trace、监控或剖析页面启动一个有界任务。":
    "Start a bounded task from the observation, Trace, monitor, or profile page.",
  "停止后会移除该任务对应的字节码增强，不影响其他增强任务。":
    "Stopping removes the bytecode instrumentation owned by this task without affecting other instrumentation tasks.",
  跨类追踪: "Cross-class trace",
  "已捕获 {current} / {maximum} · 截断 {dropped}":
    "Captured {current} / {maximum} · truncated {dropped}",
  "沿着一次调用，看见跨类路径。":
    "Follow one invocation across class boundaries.",
  "从一个精确根方法开始，只追踪同一 ClassLoader、已加载且可修改的包内类；不采集参数和返回对象。":
    "Start from one exact root method and trace only already-loaded, modifiable classes in the same ClassLoader and package scope. Arguments and returned objects are not captured.",
  "连接目标后选择 Trace 根方法。":
    "Connect a target, then select a Trace root method.",
  "当前 Agent 不支持跨类 Trace。":
    "The current Agent does not support cross-class Trace.",
  "从类检查器选择根方法。": "Select a root method from the class inspector.",
  "Trace 不接受类或方法通配符，根方法必须唯一。":
    "Trace does not accept class or method wildcards; the root method must be unique.",
  "先限定范围，再生成调用树。":
    "Bound the scope before generating a call tree.",
  "包前缀必须包含根类；最多增强 64 个同 ClassLoader 的具体类。":
    "The package prefix must contain the root class. At most 64 concrete classes from the same ClassLoader can be instrumented.",
  包范围: "Package scope",
  "最多 Trace": "Maximum traces",
  最大深度: "Maximum depth",
  "每条最多 Span": "Maximum spans per trace",
  "根调用最小耗时（ms）": "Minimum root latency (ms)",
  "预检 Trace 范围": "Preflight Trace scope",
  "包含路径规则（可选）": "Include path rules (optional)",
  "排除路径规则（可选）": "Exclude path rules (optional)",
  "每行一条：package.*、完整类名或完整类名#方法名；各最多 16 条，排除优先，根方法始终保留。":
    "One rule per line: package.*, fully qualified class, or class#method. Up to 16 each; exclusions win and the root method is always retained.",
  范围内全部路径: "All paths in scope",
  未排除路径: "No excluded paths",
  "{classes} 个候选类 · {methods} 个可增强方法 · 上限 {limit}":
    "{classes} candidate classes · {methods} instrumented methods · limit {limit}",
  "{count} 个候选类 · 上限 {limit}":
    "{count} candidate classes · limit {limit}",
  范围可执行: "Scope accepted",
  范围超过上限: "Scope exceeds limit",
  "还有 {count} 个类": "{count} more classes",
  "我已核对根方法、包范围和类数量，并接受有界跨类字节码增强开销。":
    "I reviewed the root method, package scope, and class count, and accept the bounded cross-class instrumentation overhead.",
  "我已核对根方法、包范围、路径规则和类/方法数量，并接受有界跨类字节码增强开销。":
    "I reviewed the root method, package scope, path rules, and class/method counts, and accept the bounded cross-class instrumentation overhead.",
  "确认增强并开始 Trace": "Confirm instrumentation and start Trace",
  "跨类 Trace 摘要": "Cross-class Trace summary",
  已完成根调用: "Completed root calls",
  "{count} 个异常节点": "{count} exceptional spans",
  根调用平均耗时: "Average root latency",
  根调用最大耗时: "Maximum root latency",
  "运行中调整慢调用阈值。": "Adjust the slow-call threshold while running.",
  "无需重新增强类；新阈值在根调用完成时生效，已捕获的 Trace 保持不变。":
    "No retransformation is required. The new threshold applies when a root invocation completes, and captured traces remain unchanged.",
  "当前阈值：≥ {value} ms": "Current threshold: ≥ {value} ms",
  "运行中最小耗时（ms）": "Live minimum latency (ms)",
  应用实时阈值: "Apply live threshold",
  "已应用 {value} ms；未重新增强类。":
    "Applied {value} ms without retransformation.",
  "Trace 结果视图": "Trace result view",
  调用树: "Call tree",
  热点聚合: "Hotspot aggregation",
  "跨 Trace 热点聚合。": "Aggregate hotspots across traces.",
  "基于当前页面最多 20 条 Trace 计算；自耗时扣除直接子 Span，结果按累计自耗时排序。":
    "Calculated from up to 20 traces retained on this page. Self time excludes direct child spans, and results are sorted by cumulative self time.",
  累计自耗时: "Cumulative self time",
  累计总耗时: "Cumulative inclusive time",
  调用量: "Calls",
  异常量: "Errors",
  "捕获 Trace 后生成热点聚合。":
    "Capture a trace to generate hotspot aggregation.",
  "{count} 条本页 Trace": "{count} traces on this page",
  "截断 {count}": "Truncated {count}",
  "{count} Span": "{count} spans",
  "等待根方法完成一次调用。":
    "Waiting for the root method to complete an invocation.",
  "截断 {count} Span": "{count} spans truncated",
  调用树完整: "Call tree complete",
  守护线程: "Daemon thread",
  用户线程: "User thread",
  "无 ThreadGroup": "No ThreadGroup",
  "未知上下文 ClassLoader": "Unknown context ClassLoader",
  "方法源码位置：{file}:{line}": "Method source: {file}:{line}",
  "父方法调用点：{file}:{line}": "Parent call site: {file}:{line}",
  跨类调用树: "Cross-class call tree",
  "根 Span": "Root span",
  "父 Span #{sequence}": "Parent span #{sequence}",
  "还有 {count} 个 Span 未渲染": "{count} spans are not rendered yet",
  "展开剩余 Span": "Render remaining spans",
  "捕获后在这里检查跨类调用路径。":
    "Inspect the cross-class invocation path here after capture.",
  "停止并回滚这一组增强。": "Stop and roll back this instrumentation set.",
  "回滚仅覆盖此 Trace 任务选择的 Transformer；其他观测和监控任务保持独立。":
    "Rollback removes only the Transformer selected by this Trace task. Other observation and monitor tasks remain independent.",
  "我确认停止当前跨类 Trace。":
    "I confirm stopping the current cross-class Trace.",
  "停止 Trace": "Stop Trace",
  "Trace 已结束，调用树保留在当前页面。":
    "Trace has ended; the call tree remains on this page.",
  无法预检跨类追踪: "Unable to preflight cross-class Trace",
  无法启动跨类追踪: "Unable to start cross-class Trace",
  Agent返回的追踪任务无效: "The Agent returned an invalid Trace task",
  无法读取追踪事件: "Unable to read Trace events",
  "无法更新 Trace 实时阈值": "Unable to update the live Trace threshold",
  "Agent返回的 Trace 阈值无效": "The Agent returned an invalid Trace threshold",
  无法停止跨类追踪: "Unable to stop cross-class Trace",
  无法读取线程池时长归因: "Unable to read thread-pool latency attribution",
  "线程池时长归因身份发生变化。":
    "The thread-pool latency attribution identity changed.",
  无法启动线程池时长归因: "Unable to start thread-pool latency attribution",
  无法停止线程池时长归因: "Unable to stop thread-pool latency attribution",
  "测量任务等了多久，又执行了多久。":
    "Measure how long tasks waited and how long they ran.",
  "只增强当前精确 ThreadPoolExecutor；固定直方图、弱任务身份与自动超时限制目标开销。":
    "Instruments only the exact ThreadPoolExecutor. Fixed histograms, weak task identities, and an automatic timeout bound target overhead.",
  "测量 Worker 真正执行了多久。":
    "Measure how long workers actually execute tasks.",
  "拆开计划延迟、启动迟滞与执行耗时。":
    "Separate planned delay, start lateness, and worker execution time.",
  "只增强当前精确 ScheduledThreadPoolExecutor；分别记录任务计划等待、到期后启动迟滞和 Worker 执行区间。":
    "Instrument only this exact ScheduledThreadPoolExecutor and record planned task delay, start lateness after readiness, and worker execution separately.",
  "只测量当前精确 ScheduledThreadPoolExecutor 的 Worker 执行；定时延迟不冒充排队等待。":
    "Measure worker execution only for this exact ScheduledThreadPoolExecutor; scheduled delay is never presented as queue wait.",
  "只测量当前精确 ForkJoinPool 自有 Worker 的 doExec；外部协助执行不混入结果。":
    "Measure doExec only on workers owned by this exact ForkJoinPool; external helping execution is excluded.",
  时长归因中: "Attributing latency",
  "{count} 个已完成任务": "{count} completed tasks",
  个已完成任务: "completed tasks",
  尚未测量: "Not measured",
  "当前池类型不支持主动时长归因。":
    "This pool type does not support active latency attribution.",
  "首版只支持精确 java.util.concurrent.ThreadPoolExecutor；Scheduled 与 ForkJoin 不推断等待时长。":
    "The first release supports only an exact java.util.concurrent.ThreadPoolExecutor. Scheduled and ForkJoin pools do not infer wait time.",
  "当前 Agent 不支持线程池主动时长归因，或池类型超出精确支持边界。":
    "The current Agent does not support active thread-pool attribution, or the pool type is outside the exact supported boundary.",
  归因时长: "Attribution duration",
  "15 秒": "15 seconds",
  "120 秒": "120 seconds",
  "300 秒": "300 seconds",
  提交跟踪上限: "Tracked submission limit",
  调度跟踪上限: "Tracked scheduling limit",
  "我确认临时增强当前精确线程池，并在停止或超时后恢复。":
    "I confirm temporarily instrumenting this exact thread pool and restoring it after stop or timeout.",
  开始时长归因: "Start latency attribution",
  停止并恢复: "Stop and restore",
  平均排队: "Average queue wait",
  最长排队: "Longest queue wait",
  平均计划延迟: "Average planned delay",
  最大计划延迟: "Maximum planned delay",
  平均启动迟滞: "Average start lateness",
  最长启动迟滞: "Longest start lateness",
  最大启动迟滞: "Maximum start lateness",
  个到期样本: "ready samples",
  个匹配提交: "matched submissions",
  不测量排队: "Queue wait not measured",
  平均执行: "Average execution",
  最长执行: "Longest execution",
  "提交 / 启动": "Submitted / started",
  "调度 / 启动": "Scheduled / started",
  "启动 / 完成": "Started / completed",
  "执行中 / 待匹配": "In flight / pending",
  "执行中 / 待就绪": "In flight / awaiting readiness",
  "执行中 / 未捕获失败": "In flight / uncaught failures",
  "拒绝 / 未捕获失败": "Rejected / uncaught failures",
  "丢弃跟踪 / 未匹配": "Dropped tracking / unmatched",
  "计划样本 / 到期样本": "Planned / ready samples",
  "拒绝 / 未匹配": "Rejected / unmatched",
  任务运行时类型: "Runtime task type",
  最大排队: "Maximum queue wait",
  最大执行: "Maximum execution",
  "等待探针捕获由 Worker 执行的任务。":
    "Waiting for the probe to capture tasks executed by workers.",
  "排队时长只统计探针启动后匹配到的提交；CallerRuns 与启动前已在队列中的任务不会伪造等待时间。":
    "Queue wait includes only submissions matched after the probe starts. CallerRuns and tasks queued before start do not fabricate wait times.",
  "Scheduled 只归因 Worker 执行区间；调度延迟与队列等待均不推断，任务类型显示 JDK 定时任务包装类。":
    "Scheduled attribution covers worker execution only. Scheduling delay and queue wait are not inferred, and task types show the JDK scheduled-task wrapper.",
  "计划延迟取自 JDK Delayed 剩余时间；启动迟滞从任务到期时刻计算。探针启动前已排队的任务保持未匹配，不会伪造拥塞。":
    "Planned delay comes from the JDK Delayed remaining time; start lateness is measured from the task readiness deadline. Tasks already queued before probe start remain unmatched and never fabricate congestion.",
  "ForkJoin 只归因目标池自有 Worker 的 doExec；外部 help/join 与排队等待不计入结果。":
    "ForkJoin attribution covers doExec on workers owned by the target pool only. External help/join execution and queue wait are excluded.",
  线程池时长归因: "Thread-pool latency attribution",
  "完成任务 {current} · 跟踪上限 {maximum} · 丢弃 {dropped}":
    "Completed {current} · tracking limit {maximum} · dropped {dropped}",
  "统一查看探微创建的观测、Trace、监控、线程池归因、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。":
    "Review Tanwei observation, Trace, monitor, thread-pool attribution, profiling, and JFR tasks in one place. Stop operations bind to exact task identities, and profiling or recording results are recovered to the local artifact library first.",
  "可从观测、Trace、监控、线程池或剖析页面启动一个有界任务。":
    "Start a bounded task from Observe, Trace, Monitor, Threads, or Profile.",
  保存热点制品: "Save hotspot artifact",
  保存窗口制品: "Save window artifact",
  检查制品: "Inspect artifact",
  检查观测导出: "Inspect observation export",
  "无法保存 Trace 热点制品": "Unable to save the Trace hotspot artifact",
  "无法保存 Monitor 窗口制品": "Unable to save the Monitor window artifact",
  "热点聚合已进入制品中心：{name}":
    "The hotspot aggregate is now in Artifacts: {name}",
  "监控窗口已进入制品中心：{name}":
    "The monitor windows are now in Artifacts: {name}",
  "只有已就绪的 Trace/Monitor 导出可以检查":
    "Only ready Trace/Monitor exports can be inspected",
  "无法检查 Trace/Monitor 导出": "Unable to inspect the Trace/Monitor export",
  "跨 Trace 热点证据。": "Cross-Trace hotspot evidence.",
  "方法监控窗口证据。": "Method-monitor window evidence.",
  精确方法: "Exact method",
  任务状态: "Task state",
  "JVM 启动周期": "JVM lifecycle",
  "Trace 数": "Trace count",
  丢弃: "Dropped",
  "截断 Span": "Truncated spans",
  窗口数: "Window count",
  "窗口最大 P95": "Maximum window P95",
  结束时间: "End time",
  "再显示 100 个窗口": "Show 100 more windows",
  行探针: "Line probe",
  源码行探针: "Source-line probe",
  源码行局部变量探针: "Source-line local-variable probe",
  "绑定精确类、加载器、方法和源码行，捕获安全局部变量与调用栈。":
    "Bind an exact class, loader, method, and source line to capture safe local variables and the call stack.",
  "在精确源码行捕获有界局部变量与调用栈现场。":
    "Capture bounded local variables and call-stack context at an exact source line.",
  "在精确源码行冻结一份安全现场。":
    "Freeze a safe snapshot at an exact source line.",
  "探针绑定类、ClassLoader、完整方法签名与行号；局部变量不调用业务 toString，并自动脱敏敏感名称。":
    "The probe binds the class, ClassLoader, full method signature, and line number. Local values never call application toString and sensitive names are redacted.",
  "连接目标后设置源码行探针。":
    "Connect a target to configure a source-line probe.",
  "源码行探针需要一个已经完成 Attach 的目标 JVM。":
    "Source-line probes require an attached target JVM.",
  "当前目标不支持源码行探针。":
    "The current target does not support source-line probes.",
  "目标 JVM 不支持类重转换。":
    "The target JVM does not support class retransformation.",
  "先从类详情选择一个方法。": "Select a method from class details first.",
  "方法选择会保留精确 ClassLoader 与完整参数签名。":
    "The method selection preserves the exact ClassLoader and complete parameter signature.",
  源码行操作未完成: "The source-line operation did not complete",
  "只增强下面的方法与源码行。":
    "Instrument only the method and source line below.",
  探针边界: "Probe boundaries",
  "行号、事件和时间均有固定预算。":
    "Line number, events, and duration all have fixed budgets.",
  源码行: "Source line",
  预检源码行: "Preview source line",
  "已定位 {file}:{line}": "Located {file}:{line}",
  未知源码: "Unknown source",
  "字节码位置 {points} · 最多 {locals} 个局部变量":
    "{points} bytecode location(s) · up to {locals} local variable(s)",
  源码行探针任务: "Source-line probe task",
  源码行现场: "Source-line snapshots",
  "显示安全渲染的局部变量与最多 12 层调用栈。":
    "Shows safely rendered local variables and up to 12 call-stack frames.",
  等待源码行命中: "Waiting for the source line",
  "目标方法执行到所选行后，安全现场会显示在这里。":
    "A safe snapshot appears here when the target method reaches the selected line.",
  局部变量: "Local variables",
  调用栈: "Call stack",
  "该位置没有可用的局部变量表，仅保留调用栈。":
    "No local-variable table is available at this location; only the call stack is retained.",
  "Agent 返回的行探针任务标识无效":
    "The Agent returned an invalid source-line probe task identity",
  无法预检源码行探针: "Unable to preview the source-line probe",
  无法启动源码行探针: "Unable to start the source-line probe",
  无法读取源码行事件: "Unable to read source-line events",
  无法停止源码行探针: "Unable to stop the source-line probe",
  "统一查看探微创建的观测、行探针、Trace、监控、线程池归因、采样与 JFR 任务；停止操作绑定精确任务身份，采样与记录结果会先回收到本地制品库。":
    "Review Tanwei observation, line-probe, Trace, monitor, thread-pool attribution, profiling, and JFR tasks in one place. Stop operations bind to exact task identities, and profiling or recording results are recovered to the local artifact library first.",
  "可从观测、行探针、Trace、监控、线程池或剖析页面启动一个有界任务。":
    "Start a bounded task from Observe, Line Probe, Trace, Monitor, Threads, or Profile.",
};

let currentLocale: Locale = "zh-CN";
const localeListeners = new Set<() => void>();

function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

function interpolate(
  template: string,
  parameters?: TranslationParameters,
): string {
  if (!parameters) {
    return template;
  }
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (match, name) => {
    const value = parameters[name];
    return value === undefined ? match : String(value);
  });
}

export function t(
  key: string | null | undefined,
  parameters?: TranslationParameters,
): string {
  if (!key) {
    return "";
  }
  const template = currentLocale === "en-US" ? (english[key] ?? key) : key;
  return interpolate(template, parameters);
}

export function hasEnglishTranslation(key: string): boolean {
  return Object.hasOwn(english, key);
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) {
    document.documentElement.lang = locale;
    return;
  }
  currentLocale = locale;
  document.documentElement.lang = locale;
  for (const listener of localeListeners) {
    listener();
  }
}

export function formatDateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat(currentLocale, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(currentLocale, options).format(value);
}

/**
 * 订阅界面语言变化。
 * 语言切换时触发组件重渲染，使组件树内所有 t() 调用输出新语言。
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

export function useI18n() {
  const locale = useLocale();
  return {
    locale,
    t,
    setLocale,
    formatDateTime,
    formatNumber,
  } as const;
}

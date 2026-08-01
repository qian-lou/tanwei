export type CapabilityGroup =
  | "目标与连接"
  | "运行时"
  | "线程与锁"
  | "类与对象"
  | "方法诊断"
  | "性能与制品"
  | "工作流与治理";

export interface CapabilityCatalogItem {
  readonly id: string;
  readonly group: CapabilityGroup;
  readonly label: string;
  readonly description: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly keywords: readonly string[];
  readonly requiresConnection: boolean;
}

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  "目标与连接",
  "运行时",
  "线程与锁",
  "类与对象",
  "方法诊断",
  "性能与制品",
  "工作流与治理",
];

export const CAPABILITY_CATALOG: readonly CapabilityCatalogItem[] = [
  {
    id: "target.local",
    group: "目标与连接",
    label: "本机 JVM 发现与 Attach",
    description: "发现进程、核对 JDK 与身份并建立本地诊断会话。",
    path: "/targets",
    keywords: ["attach", "pid", "process", "target", "连接", "进程"],
    requiresConnection: false,
  },
  {
    id: "target.remote",
    group: "目标与连接",
    label: "SSH 与 Kubernetes 目标",
    description: "预检远程组件、隧道、授权与临时 Relay 生命周期。",
    path: "/targets",
    keywords: ["ssh", "kubernetes", "k8s", "relay", "remote", "远程"],
    requiresConnection: false,
  },
  {
    id: "target.overview",
    group: "目标与连接",
    label: "实时诊断概览",
    description: "查看 CPU、线程、Heap、类加载和 GC 有界趋势。",
    path: "/overview",
    keywords: ["dashboard", "overview", "cpu", "memory", "gc", "概览"],
    requiresConnection: true,
  },
  {
    id: "runtime.facts",
    group: "运行时",
    label: "JVM 事实与启动参数",
    description: "检查 JVM、运行时参数、内存池和 GC Collector 摘要。",
    path: "/runtime",
    query: { workspace: "facts" },
    keywords: ["jvm", "arguments", "memory", "gc", "runtime", "启动参数"],
    requiresConnection: true,
  },
  {
    id: "runtime.properties",
    group: "运行时",
    label: "System Property Inspector",
    description: "按名称和类别检索系统属性，安全值可进入修改预检。",
    path: "/runtime",
    query: { workspace: "properties" },
    keywords: ["sysprop", "system property", "property", "系统属性"],
    requiresConnection: true,
  },
  {
    id: "runtime.environment",
    group: "运行时",
    label: "Environment Explorer",
    description: "检查启动环境变量，并在 Agent 内遮罩秘密值。",
    path: "/runtime",
    query: { workspace: "environment" },
    keywords: ["sysenv", "environment", "env", "环境变量"],
    requiresConnection: true,
  },
  {
    id: "runtime.vm-options",
    group: "运行时",
    label: "VM Option Inspector",
    description: "搜索 HotSpot 诊断选项、来源和可写性。",
    path: "/runtime",
    query: { workspace: "vm-options" },
    keywords: ["vmoption", "vm option", "hotspot", "诊断选项"],
    requiresConnection: true,
  },
  {
    id: "runtime.mutation",
    group: "运行时",
    label: "受控运行时修改",
    description: "对系统属性、VM Option、日志级别和 GC 执行风险预检。",
    path: "/runtime",
    query: { workspace: "mutation" },
    keywords: ["set", "mutation", "gc", "修改", "预检"],
    requiresConnection: true,
  },
  {
    id: "runtime.perfcounters",
    group: "运行时",
    label: "PerfCounter 检查与趋势",
    description: "搜索 HotSpot 内部计数器，固定指标并比较变化速率。",
    path: "/perfcounters",
    keywords: ["perfcounter", "counter", "hotspot", "trend", "计数器"],
    requiresConnection: true,
  },
  {
    id: "runtime.jit",
    group: "运行时",
    label: "JIT 编译器与 Code Cache",
    description: "聚合编译、OSR、失败、失效和分段代码缓存趋势。",
    path: "/perfcounters",
    keywords: ["jit", "compiler", "osr", "code cache", "编译器"],
    requiresConnection: true,
  },
  {
    id: "runtime.mbeans",
    group: "运行时",
    label: "MBean Inspector",
    description:
      "检索元数据、展开并受控修改 OpenType 值，以及用标量或 OpenType 参数调用操作。",
    path: "/mbeans",
    keywords: ["mbean", "jmx", "opentype", "attribute", "operation"],
    requiresConnection: true,
  },
  {
    id: "runtime.loggers",
    group: "运行时",
    label: "Logger Center",
    description:
      "检查并漂移安全地修改 JUL、Logback、Log4j 1.x 与 Log4j2 级别。",
    path: "/loggers",
    keywords: [
      "logger",
      "logging",
      "jul",
      "logback",
      "log4j",
      "log4j2",
      "日志",
    ],
    requiresConnection: true,
  },
  {
    id: "threads.live",
    group: "线程与锁",
    label: "线程 CPU 与完整堆栈",
    description: "按名称、状态和 CPU 排序筛选线程并检查调用栈。",
    path: "/threads",
    keywords: ["thread", "cpu", "stack", "线程", "堆栈"],
    requiresConnection: true,
  },
  {
    id: "threads.hot-cpu",
    group: "线程与锁",
    label: "热点线程差分排行",
    description: "按相邻采样 CPU 增量定位热点线程、单核占用和栈顶。",
    path: "/threads",
    keywords: ["thread -n", "thread -i", "hot thread", "cpu delta", "热点线程"],
    requiresConnection: true,
  },
  {
    id: "threads.trend",
    group: "线程与锁",
    label: "线程连续趋势",
    description: "观察线程状态、生命周期、死锁和可用 CPU 速率。",
    path: "/threads",
    keywords: ["thread trend", "lifecycle", "deadlock", "rate", "线程趋势"],
    requiresConnection: true,
  },
  {
    id: "threads.diff",
    group: "线程与锁",
    label: "线程双快照差异",
    description: "比较新增、退出、状态、锁持有者和 CPU 增量。",
    path: "/threads",
    keywords: ["thread diff", "snapshot", "baseline", "线程快照"],
    requiresConnection: true,
  },
  {
    id: "threads.locks",
    group: "线程与锁",
    label: "锁关系与死锁",
    description: "沿等待者到持有者关系检查 Monitor 与 Synchronizer。",
    path: "/threads",
    keywords: ["lock", "deadlock", "monitor", "synchronizer", "锁", "死锁"],
    requiresConnection: true,
  },
  {
    id: "threads.pools",
    group: "线程与锁",
    label: "线程池检查器",
    description: "识别 JDK 执行器、精确成员、线程组、队列和完成计数。",
    path: "/threads",
    keywords: [
      "thread pool",
      "executor",
      "forkjoin",
      "worker",
      "thread group",
      "queue",
      "线程池",
      "线程组",
    ],
    requiresConnection: true,
  },
  {
    id: "threads.dump",
    group: "线程与锁",
    label: "Thread Dump 与自动差异",
    description: "采集校验制品，在应用内检查并比较两份线程转储。",
    path: "/threads",
    keywords: ["thread dump", "jstack", "artifact", "diff", "线程转储"],
    requiresConnection: true,
  },
  {
    id: "threads.interrupt",
    group: "线程与锁",
    label: "线程中断预检",
    description: "绑定精确线程身份，在双确认后请求中断。",
    path: "/threads",
    keywords: ["interrupt", "thread stop", "线程中断", "风险"],
    requiresConnection: true,
  },
  {
    id: "classes.search",
    group: "类与对象",
    label: "已加载类与方法搜索",
    description: "按 Agent 分页搜索类、加载器、来源和方法签名。",
    path: "/classes",
    keywords: ["sc", "sm", "class", "method", "类", "方法"],
    requiresConnection: true,
  },
  {
    id: "classes.loaders",
    group: "类与对象",
    label: "ClassLoader 树与 Metaspace",
    description: "检查父子关系、URL、类数量和元空间占用。",
    path: "/classes",
    keywords: ["classloader", "metaspace", "loader tree", "类加载器"],
    requiresConnection: true,
  },
  {
    id: "classes.resources",
    group: "类与对象",
    label: "类资源来源冲突",
    description: "沿精确 ClassLoader 定位同名资源的全部可见来源。",
    path: "/classes",
    keywords: ["classloader resource", "duplicate", "spi", "资源冲突"],
    requiresConnection: true,
  },
  {
    id: "classes.static-fields",
    group: "类与对象",
    label: "静态字段检查器",
    description: "先看字段元数据，再受控读取单个安全值。",
    path: "/classes",
    keywords: ["getstatic", "static field", "字段", "静态字段"],
    requiresConnection: true,
  },
  {
    id: "classes.dump-decompile",
    group: "类与对象",
    label: "Class Dump 与反编译",
    description: "捕获精确加载类并使用内置 CFR 生成可检查源码。",
    path: "/classes",
    keywords: ["dump", "jad", "decompile", "cfr", "反编译"],
    requiresConnection: true,
  },
  {
    id: "classes.redefine",
    group: "类与对象",
    label: "多类原子变更与回滚",
    description: "联合编译 2—8 个类，整组预检后原子提交或恢复。",
    path: "/classes",
    keywords: ["mc", "redefine", "retransform", "compile", "类替换", "回滚"],
    requiresConnection: true,
  },
  {
    id: "objects.instances",
    group: "类与对象",
    label: "Heap 实例与对象关系",
    description: "按精确类扫描实例，并沿出向或入向引用继续检查。",
    path: "/classes",
    keywords: ["vmtool", "getinstances", "object", "heap", "对象", "实例"],
    requiresConnection: true,
  },
  {
    id: "objects.graph",
    group: "类与对象",
    label: "对象图与 GC Root 路径",
    description: "生成有界多层对象图，并回溯多条较短保留路径。",
    path: "/classes",
    keywords: ["object graph", "gc root", "reference", "对象图", "保留路径"],
    requiresConnection: true,
  },
  {
    id: "objects.retained",
    group: "类与对象",
    label: "Retained Size 与支配分析",
    description: "计算单对象、批量和类级 retained size 与支配关系。",
    path: "/classes",
    keywords: [
      "retained size",
      "dominator",
      "memory leak",
      "支配树",
      "内存泄漏",
    ],
    requiresConnection: true,
  },
  {
    id: "observe.watch-stack",
    group: "方法诊断",
    label: "方法 Watch 与来源栈",
    description: "有界捕获参数、返回、异常、耗时和调用来源栈。",
    path: "/observe",
    keywords: ["watch", "stack", "observe", "parameters", "方法观测", "来源栈"],
    requiresConnection: true,
  },
  {
    id: "observe.line",
    group: "方法诊断",
    label: "源码行局部变量探针",
    description: "绑定精确类、加载器、方法和源码行，捕获安全局部变量与调用栈。",
    path: "/line",
    keywords: ["line", "local variables", "source line", "行探针", "局部变量"],
    requiresConnection: true,
  },
  {
    id: "observe.snapshots",
    group: "方法诊断",
    label: "调用快照与安全重放",
    description: "跨任务检索调用证据、精确删除并预检静态标量重放。",
    path: "/snapshots",
    keywords: ["tt", "time tunnel", "replay", "snapshot", "调用快照", "重放"],
    requiresConnection: true,
  },
  {
    id: "observe.snapshot-archive",
    group: "方法诊断",
    label: "跨会话调用档案",
    description: "离线检索显式固定、由 Host 核验并脱敏的调用上下文。",
    path: "/snapshot-library",
    keywords: [
      "tt",
      "time tunnel",
      "archive",
      "persistent snapshot",
      "调用档案",
      "跨会话",
    ],
    requiresConnection: false,
  },
  {
    id: "workflow.audit",
    group: "工作流与治理",
    label: "诊断操作审计",
    description: "跨桌面会话检索 Action、目标、风险、状态与稳定错误码。",
    path: "/audit",
    keywords: ["audit", "history", "action", "审计", "操作历史", "错误码"],
    requiresConnection: false,
  },
  {
    id: "observe.trace",
    group: "方法诊断",
    label: "跨类调用 Trace",
    description: "按包和路径规则生成调用树，并聚合自耗时热点。",
    path: "/trace",
    keywords: ["trace", "call tree", "self time", "调用树", "追踪"],
    requiresConnection: true,
  },
  {
    id: "observe.monitor",
    group: "方法诊断",
    label: "周期方法监控",
    description: "观察调用量、成功率、异常率和 P95/P99 耗时趋势。",
    path: "/monitor",
    keywords: ["monitor", "p95", "p99", "latency", "方法监控"],
    requiresConnection: true,
  },
  {
    id: "profile.cpu-wall",
    group: "性能与制品",
    label: "CPU 与 Wall Profiler",
    description: "启动有界采样任务，并在隔离窗口检查火焰图。",
    path: "/profile",
    keywords: ["profiler", "cpu", "wall", "flame graph", "火焰图"],
    requiresConnection: true,
  },
  {
    id: "profile.allocation-lock",
    group: "性能与制品",
    label: "Allocation 与 Lock Profiler",
    description: "定位分配热点和锁竞争采样证据。",
    path: "/profile",
    keywords: [
      "allocation",
      "lock profiler",
      "async-profiler",
      "分配",
      "锁竞争",
    ],
    requiresConnection: true,
  },
  {
    id: "profile.jfr",
    group: "性能与制品",
    label: "JFR 录制与事件检查",
    description: "录制 profile 事件并检查热点、分配、CPU、GC 与编译。",
    path: "/profile",
    keywords: ["jfr", "recording", "event", "flight recorder", "录制"],
    requiresConnection: true,
  },
  {
    id: "profile.heap-dump",
    group: "性能与制品",
    label: "Heap Dump",
    description: "以高风险预检生成受配额保护的 HPROF 制品。",
    path: "/profile",
    keywords: ["heapdump", "hprof", "heap dump", "堆转储"],
    requiresConnection: true,
  },
  {
    id: "profile.heap-histogram",
    group: "性能与制品",
    label: "Heap 类直方图",
    description: "按类名范围统计实例数量、浅大小和平均浅大小。",
    path: "/profile",
    keywords: ["heap histogram", "jmap histo", "class histogram", "类直方图"],
    requiresConnection: true,
  },
  {
    id: "profile.heap-histogram-diff",
    group: "性能与制品",
    label: "Heap 双快照差分",
    description: "比较同一 JVM 两次类直方图，定位实例与浅大小增长。",
    path: "/profile",
    keywords: [
      "heap diff",
      "jmap histo diff",
      "object growth",
      "memory leak",
      "对象增长",
      "内存泄漏",
    ],
    requiresConnection: true,
  },
  {
    id: "artifacts.heap-histogram-diff",
    group: "性能与制品",
    label: "Heap 跨会话差分",
    description: "重新校验并比较两份持久化类直方图证据。",
    path: "/artifacts",
    keywords: [
      "histogram artifact",
      "persistent heap snapshot",
      "memory evidence",
      "跨会话内存",
      "持久快照",
    ],
    requiresConnection: false,
  },
  {
    id: "profile.dominator",
    group: "性能与制品",
    label: "Heap Dominator Tree",
    description: "从虚拟 GC Root 沿最大 retained 路径交互下钻。",
    path: "/profile",
    keywords: ["dominator tree", "retained", "gc root", "支配树"],
    requiresConnection: true,
  },
  {
    id: "workflow.tasks",
    group: "工作流与治理",
    label: "活动任务与会话 Reset",
    description: "统一取消观测任务并恢复探微持有的类定义。",
    path: "/tasks",
    keywords: ["jobs", "tasks", "reset", "stop", "任务", "恢复"],
    requiresConnection: true,
  },
  {
    id: "workflow.console",
    group: "工作流与治理",
    label: "结构化 Expert Console",
    description: "通过 Action Schema 校验参数，不发送任意文本命令。",
    path: "/console",
    keywords: ["console", "action", "schema", "history", "控制台"],
    requiresConnection: true,
  },
  {
    id: "workflow.artifacts",
    group: "工作流与治理",
    label: "诊断制品管理",
    description: "校验、定位、检查和清理 JFR、Dump 与报告制品。",
    path: "/artifacts",
    keywords: ["artifact", "jfr", "dump", "report", "制品"],
    requiresConnection: false,
  },
  {
    id: "workflow.cases",
    group: "工作流与治理",
    label: "诊断案例与证据",
    description: "组织笔记、任务、证据和脱敏导入导出。",
    path: "/cases",
    keywords: ["case", "evidence", "export", "import", "案例", "证据"],
    requiresConnection: false,
  },
  {
    id: "governance.compare",
    group: "工作流与治理",
    label: "多目标运行时对比",
    description: "并发采样 2—8 个 READY JVM 并比较相对基线。",
    path: "/governance",
    keywords: ["multi target", "compare", "baseline", "多目标", "对比"],
    requiresConnection: false,
  },
  {
    id: "governance.templates",
    group: "工作流与治理",
    label: "签名诊断模板与插件",
    description: "管理只允许 R0/R1 Action 的签名模板和声明式插件。",
    path: "/governance",
    keywords: ["template", "plugin", "signed", "诊断模板", "插件"],
    requiresConnection: false,
  },
  {
    id: "governance.policy",
    group: "工作流与治理",
    label: "团队策略包",
    description: "验证签名、有效期和只降权的组织级 Action 策略。",
    path: "/governance",
    keywords: ["policy", "team", "governance", "团队策略", "治理"],
    requiresConnection: false,
  },
  {
    id: "workflow.settings",
    group: "工作流与治理",
    label: "设置、更新与支持包",
    description: "管理语言、存储、更新通道和脱敏支持信息。",
    path: "/settings",
    keywords: ["settings", "update", "support", "locale", "设置", "更新"],
    requiresConnection: false,
  },
];

function normalizeSearchValue(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function itemHaystack(item: CapabilityCatalogItem): string {
  return normalizeSearchValue(
    [item.id, item.group, item.label, item.description, ...item.keywords].join(
      " ",
    ),
  );
}

function itemScore(
  item: CapabilityCatalogItem,
  normalizedQuery: string,
  tokens: readonly string[],
): number | null {
  const haystack = itemHaystack(item);
  if (!tokens.every((token) => haystack.includes(token))) {
    return null;
  }
  const label = normalizeSearchValue(item.label);
  if (label === normalizedQuery) {
    return 0;
  }
  if (label.startsWith(normalizedQuery)) {
    return 1;
  }
  if (label.includes(normalizedQuery)) {
    return 2;
  }
  if (
    item.keywords.some(
      (keyword) => normalizeSearchValue(keyword) === normalizedQuery,
    )
  ) {
    return 3;
  }
  return 4;
}

export function searchCapabilityCatalog(
  rawQuery: string,
): readonly CapabilityCatalogItem[] {
  const normalizedQuery = normalizeSearchValue(rawQuery);
  if (!normalizedQuery) {
    return CAPABILITY_CATALOG;
  }
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  return CAPABILITY_CATALOG.map((item, index) => ({
    item,
    index,
    score: itemScore(item, normalizedQuery, tokens),
  }))
    .filter(
      (
        candidate,
      ): candidate is {
        readonly item: CapabilityCatalogItem;
        readonly index: number;
        readonly score: number;
      } => candidate.score !== null,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((candidate) => candidate.item);
}

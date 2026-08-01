import { createHashRouter, redirect } from "react-router";
import App from "./App";

export interface RouteMeta {
  readonly label: string;
  readonly eyebrow: string;
  readonly description?: string;
}

async function lazyView(
  loader: () => Promise<{ default: React.ComponentType }>,
) {
  const module = await loader();
  return { Component: module.default };
}

export const router = createHashRouter([
  {
    path: "/",
    Component: App,
    children: [
      { index: true, loader: () => redirect("/targets") },
      {
        path: "targets",
        lazy: () => lazyView(() => import("./views/TargetsView")),
        handle: { label: "目标", eyebrow: "DISCOVERY" } satisfies RouteMeta,
      },
      {
        path: "overview",
        lazy: () => lazyView(() => import("./views/OverviewView")),
        handle: { label: "概览", eyebrow: "LIVE RUNTIME" } satisfies RouteMeta,
      },
      {
        path: "threads",
        lazy: () => lazyView(() => import("./views/ThreadsView")),
        handle: { label: "线程与锁", eyebrow: "THREADS" } satisfies RouteMeta,
      },
      {
        path: "classes",
        lazy: () => lazyView(() => import("./views/ClassesView")),
        handle: {
          label: "类与加载器",
          eyebrow: "CLASSES",
          description:
            "搜索已加载类、定位来源、检查 ClassLoader 并进入方法观测。",
        } satisfies RouteMeta,
      },
      {
        path: "observe",
        lazy: () => lazyView(() => import("./views/ObserveView")),
        handle: {
          label: "方法观测",
          eyebrow: "OBSERVE",
          description: "以有界任务捕获参数、返回值、异常、耗时和调用树。",
        } satisfies RouteMeta,
      },
      {
        path: "line",
        lazy: () => lazyView(() => import("./views/LineView")),
        handle: {
          label: "源码行探针",
          eyebrow: "SOURCE LINE",
          description: "在精确源码行捕获有界局部变量与调用栈现场。",
        } satisfies RouteMeta,
      },
      {
        path: "snapshots",
        lazy: () => lazyView(() => import("./views/SnapshotsView")),
        handle: {
          label: "调用快照",
          eyebrow: "INVOCATION SNAPSHOTS",
          description: "跨观测任务检索调用上下文，并对安全快照执行受控重放。",
        } satisfies RouteMeta,
      },
      {
        path: "snapshot-library",
        lazy: () => lazyView(() => import("./views/PersistedSnapshotsView")),
        handle: {
          label: "桌面调用档案",
          eyebrow: "DESKTOP INVOCATION ARCHIVE",
          description: "跨桌面会话检索显式固定、经 Host 脱敏的调用快照。",
        } satisfies RouteMeta,
      },
      {
        path: "monitor",
        lazy: () => lazyView(() => import("./views/MonitorView")),
        handle: {
          label: "方法监控",
          eyebrow: "MONITOR",
          description: "按周期观察精确方法的调用量、异常率与耗时趋势。",
        } satisfies RouteMeta,
      },
      {
        path: "trace",
        lazy: () => lazyView(() => import("./views/TraceView")),
        handle: {
          label: "跨类 Trace",
          eyebrow: "TRACE",
          description: "在同一 ClassLoader 的有界包范围内检查跨类调用树。",
        } satisfies RouteMeta,
      },
      {
        path: "profile",
        lazy: () => lazyView(() => import("./views/ProfileView")),
        handle: {
          label: "性能剖析",
          eyebrow: "PROFILE",
          description:
            "管理 CPU、Wall、Allocation、Lock、JFR 与 Heap Dump 任务。",
        } satisfies RouteMeta,
      },
      {
        path: "runtime",
        lazy: () => lazyView(() => import("./views/RuntimeView")),
        handle: {
          label: "运行时",
          eyebrow: "RUNTIME",
          description:
            "检查 MBean、系统属性、VM Options、日志与受控运行时操作。",
        } satisfies RouteMeta,
      },
      {
        path: "perfcounters",
        lazy: () => lazyView(() => import("./views/PerfCountersView")),
        handle: {
          label: "PerfCounter 检查器",
          eyebrow: "PERFCOUNTERS",
          description:
            "搜索并检查 HotSpot 的类加载、编译器、GC 与运行时计数器。",
        } satisfies RouteMeta,
      },
      {
        path: "mbeans",
        lazy: () => lazyView(() => import("./views/MBeansView")),
        handle: {
          label: "MBean 检查器",
          eyebrow: "MANAGEMENT",
          description: "搜索管理接口、检查元数据并按需读取单个属性。",
        } satisfies RouteMeta,
      },
      {
        path: "loggers",
        lazy: () => lazyView(() => import("./views/LoggersView")),
        handle: {
          label: "Logger Center",
          eyebrow: "LOGGING",
          description:
            "搜索并检查 JUL、Logback、Log4j 1.x 与 Log4j2 的上下文、级别和输出目标。",
        } satisfies RouteMeta,
      },
      {
        path: "tasks",
        lazy: () => lazyView(() => import("./views/TasksView")),
        handle: {
          label: "任务中心",
          eyebrow: "ACTIVE TASKS",
          description: "统一查看并精确停止探微创建的观测、采样与 JFR 任务。",
        } satisfies RouteMeta,
      },
      {
        path: "audit",
        lazy: () => lazyView(() => import("./views/AuditView")),
        handle: {
          label: "诊断审计",
          eyebrow: "DIAGNOSTIC AUDIT",
          description: "跨桌面会话检索结构化诊断操作、风险、状态与稳定错误码。",
        } satisfies RouteMeta,
      },
      {
        path: "console",
        lazy: () => lazyView(() => import("./views/ConsoleView")),
        handle: {
          label: "专家控制台",
          eyebrow: "EXPERT CONSOLE",
          description: "通过 Action Schema 补全、校验并执行结构化诊断操作。",
        } satisfies RouteMeta,
      },
      {
        path: "artifacts",
        lazy: () => lazyView(() => import("./views/ArtifactsView")),
        handle: {
          label: "制品",
          eyebrow: "ARTIFACTS",
          description: "统一管理 JFR、Heap Dump、火焰图和诊断快照。",
        } satisfies RouteMeta,
      },
      {
        path: "cases",
        lazy: () => lazyView(() => import("./views/CasesView")),
        handle: {
          label: "案例",
          eyebrow: "CASES",
          description: "将任务、证据、制品和笔记组织为可脱敏的诊断案例。",
        } satisfies RouteMeta,
      },
      {
        path: "settings",
        lazy: () => lazyView(() => import("./views/SettingsView")),
        handle: {
          label: "设置",
          eyebrow: "SETTINGS",
          description: "管理策略、存储、远程、语言、更新与支持信息。",
        } satisfies RouteMeta,
      },
      {
        path: "governance",
        lazy: () => lazyView(() => import("./views/GovernanceView")),
        handle: {
          label: "治理与扩展",
          eyebrow: "GOVERNANCE",
          description: "对比多个目标，管理签名模板、声明式插件与团队策略。",
        } satisfies RouteMeta,
      },
    ],
  },
]);

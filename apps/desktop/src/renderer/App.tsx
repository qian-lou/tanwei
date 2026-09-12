import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  BarChart3,
  BookMarked,
  Boxes,
  BriefcaseBusiness,
  CircleGauge,
  Crosshair,
  Database,
  Eye,
  Flame,
  GitBranch,
  History,
  ListTodo,
  ListTree,
  Logs,
  MapPin,
  Plus,
  Search,
  ServerCog,
  Settings,
  ShieldCheck,
  ScrollText,
  SquareTerminal,
} from "lucide-react";
import {
  NavLink,
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
} from "react-router";
import type {
  AppExitMode,
  AppExitReason,
  ExitImpactSummary,
  RuntimeInfo,
} from "@shared/contracts";
import appIconUrl from "../../packaging/icon.png";
import { applyAppFontFamily } from "./font-preferences";
import CapabilityPalette from "./components/CapabilityPalette";
import DiagnosticAlertCenter from "./components/DiagnosticAlertCenter";
import ExitGuardDialog from "./components/ExitGuardDialog";
import StatusPill from "./components/StatusPill";
import { Button } from "./components/ui/button";
import { Kbd } from "./components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { setLocale, t, useLocale } from "./i18n";
import type { RouteMeta } from "./router";
import {
  selectConnection,
  selectSelectedTarget,
  useTargetsStore,
} from "./stores/targets";
import { DiagnosticTaskPoller } from "./utils/diagnostic-task-poller";

const CONNECTION_REFRESH_INTERVAL_MILLIS = 1_000;

const NAVIGATION_GROUPS = [
  {
    label: "目标",
    items: [
      { path: "/targets", label: "目标", icon: Crosshair },
      { path: "/overview", label: "概览", icon: CircleGauge },
    ],
  },
  {
    label: "诊断",
    items: [
      { path: "/threads", label: "线程", icon: ListTree },
      { path: "/classes", label: "类", icon: Boxes },
      { path: "/observe", label: "观测", icon: Eye },
      { path: "/line", label: "行探针", icon: MapPin },
      { path: "/snapshots", label: "快照", icon: History },
      { path: "/snapshot-library", label: "档案", icon: BookMarked },
      { path: "/trace", label: "追踪", icon: GitBranch },
      { path: "/monitor", label: "监控", icon: Activity },
      { path: "/profile", label: "剖析", icon: Flame },
      { path: "/runtime", label: "运行时", icon: ServerCog },
      { path: "/perfcounters", label: "计数器", icon: BarChart3 },
      { path: "/mbeans", label: "MBean", icon: Database },
      { path: "/loggers", label: "日志", icon: Logs },
      { path: "/tasks", label: "任务", icon: ListTodo },
      { path: "/audit", label: "审计", icon: ScrollText },
    ],
  },
  {
    label: "工作区",
    items: [
      { path: "/console", label: "控制台", icon: SquareTerminal },
      { path: "/artifacts", label: "制品", icon: Archive },
      { path: "/cases", label: "案例", icon: BriefcaseBusiness },
      { path: "/governance", label: "治理", icon: ShieldCheck },
    ],
  },
] as const;

type WorkspaceMode = "TARGETS" | "DIAGNOSTICS" | "GOVERNANCE";

function hasExitImpact(impact: ExitImpactSummary): boolean {
  return (
    impact.taskCount > 0 ||
    impact.classCount > 0 ||
    impact.rollbackCount > 0 ||
    impact.artifactPotentialCount > 0
  );
}

export default function App() {
  useLocale();
  const location = useLocation();
  const matches = useMatches();
  const navigate = useNavigate();
  const selectedTarget = useTargetsStore(selectSelectedTarget);
  const connection = useTargetsStore(selectConnection);
  const errorMessage = useTargetsStore((state) => state.errorMessage);
  const refreshTargets = useTargetsStore((state) => state.refresh);
  const refreshConnections = useTargetsStore((state) => state.refreshConnections);
  const selectTarget = useTargetsStore((state) => state.select);

  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [capabilityPaletteOpen, setCapabilityPaletteOpen] = useState(false);
  const [exitGuardOpen, setExitGuardOpen] = useState(false);
  const [exitGuardLoading, setExitGuardLoading] = useState(false);
  const [exitGuardReason, setExitGuardReason] = useState<AppExitReason | null>(
    null,
  );
  const [exitGuardImpact, setExitGuardImpact] =
    useState<ExitImpactSummary | null>(null);
  const [exitGuardError, setExitGuardError] = useState<string | null>(null);
  const exitRequestSequenceRef = useRef(0);
  const runtimeInfoRef = useRef<RuntimeInfo | null>(null);
  const workspaceContentRef = useRef<HTMLElement | null>(null);
  runtimeInfoRef.current = runtimeInfo;

  const routeMeta = useMemo(() => {
    const leaf = matches.at(-1);
    return (leaf?.handle ?? null) as RouteMeta | null;
  }, [matches]);

  const activeMode: WorkspaceMode =
    location.pathname === "/targets"
      ? "TARGETS"
      : location.pathname === "/governance"
        ? "GOVERNANCE"
        : "DIAGNOSTICS";

  const connectionLabel = !selectedTarget
    ? t("未选择目标")
    : connection?.state === "READY"
      ? t("PID {pid} · 已连接", { pid: selectedTarget.pid })
      : t("PID {pid} · 未连接", { pid: selectedTarget.pid });

  function openWorkspaceMode(mode: WorkspaceMode): void {
    const destination =
      mode === "TARGETS"
        ? "/targets"
        : mode === "GOVERNANCE"
          ? "/governance"
          : "/overview";
    void navigate(destination);
  }

  const clearExitGuard = useCallback(() => {
    exitRequestSequenceRef.current += 1;
    setExitGuardOpen(false);
    setExitGuardLoading(false);
    setExitGuardReason(null);
    setExitGuardImpact(null);
    setExitGuardError(null);
  }, []);

  const resolveExit = useCallback(
    async (mode: AppExitMode): Promise<void> => {
      const reason = exitGuardReason;
      if (!reason || exitGuardLoading) {
        return;
      }
      setExitGuardLoading(true);
      setExitGuardError(null);
      try {
        const result = await window.tanwei.resolveAppExit({ reason, mode });
        if (!result.ok) {
          setExitGuardError(result.errorMessage ?? t("无法完成退出操作"));
          setExitGuardLoading(false);
        }
      } catch (error) {
        setExitGuardError(
          error instanceof Error ? error.message : t("无法完成退出操作"),
        );
        setExitGuardLoading(false);
      }
    },
    [exitGuardReason, exitGuardLoading],
  );

  const resolveExitRef = useRef(resolveExit);
  resolveExitRef.current = resolveExit;

  const handleExitRequest = useCallback(
    async (reason: AppExitReason): Promise<void> => {
      const requestSequence = ++exitRequestSequenceRef.current;
      setExitGuardReason(reason);
      setExitGuardImpact(null);
      setExitGuardError(null);
      setExitGuardLoading(true);
      setExitGuardOpen(true);
      try {
        const [runtime, result] = await Promise.all([
          runtimeInfoRef.current
            ? Promise.resolve(runtimeInfoRef.current)
            : window.tanwei.getRuntimeInfo(),
          window.tanwei.inspectExitImpact(),
        ]);
        if (requestSequence !== exitRequestSequenceRef.current) {
          return;
        }
        setRuntimeInfo(runtime);
        setExitGuardLoading(false);
        if (!result.ok || !result.value) {
          setExitGuardError(
            result.errorMessage ?? t("无法确认退出对诊断会话的影响"),
          );
          return;
        }
        setExitGuardImpact(result.value);
        if (!hasExitImpact(result.value) && result.value.failedCount === 0) {
          const mode: AppExitMode =
            reason === "WINDOW_CLOSE" && runtime.platform === "darwin"
              ? "CLOSE_WINDOW"
              : "QUIT_APP";
          await resolveExitRef.current(mode);
        }
      } catch (error) {
        if (requestSequence !== exitRequestSequenceRef.current) {
          return;
        }
        setExitGuardLoading(false);
        setExitGuardError(
          error instanceof Error
            ? error.message
            : t("无法确认退出对诊断会话的影响"),
        );
      }
    },
    [],
  );

  const handleExitRequestRef = useRef(handleExitRequest);
  handleExitRequestRef.current = handleExitRequest;

  useEffect(() => {
    const poller = new DiagnosticTaskPoller({
      intervalMillis: CONNECTION_REFRESH_INTERVAL_MILLIS,
      poll: async (signal) => {
        await refreshConnections(signal);
        return "continue";
      },
    });
    poller.start();
    return () => poller.stop();
  }, [refreshConnections]);

  async function reviewExitTasks(): Promise<void> {
    const target = exitGuardImpact?.targets.find(
      (item) =>
        item.state === "INSPECTED" &&
        (item.taskCount > 0 ||
          item.classCount > 0 ||
          item.rollbackCount > 0 ||
          item.artifactPotentialCount > 0),
    );
    if (target) {
      selectTarget(target.targetId);
    }
    clearExitGuard();
    await navigate("/tasks");
  }

  useEffect(() => {
    const content = workspaceContentRef.current;
    if (content) {
      content.scrollTop = 0;
      content.scrollLeft = 0;
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent): void {
      if (
        event.defaultPrevented ||
        event.altKey ||
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLocaleLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      setCapabilityPaletteOpen(true);
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    const stopExitRequestListener = window.tanwei.onAppExitRequested(
      (reason) => {
        void handleExitRequestRef.current(reason);
      },
    );
    const stopDiagnosticEvidenceListener =
      window.tanwei.onOpenDiagnosticEvidence((artifactId) => {
        void navigate({
          pathname: "/artifacts",
          search: `?inspect=${encodeURIComponent(artifactId)}`,
        });
      });

    void (async () => {
      const [runtime, settings] = await Promise.all([
        window.tanwei.getRuntimeInfo(),
        window.tanwei.getSettings(),
      ]);
      setRuntimeInfo(runtime);
      if (settings.ok && settings.value) {
        setLocale(settings.value.locale);
        applyAppFontFamily(settings.value.fontFamily);
      }
      await refreshTargets();
    })();

    return () => {
      window.removeEventListener("keydown", handleGlobalShortcut);
      stopExitRequestListener?.();
      stopDiagnosticEvidenceListener?.();
    };
  }, [navigate, refreshTargets]);

  return (
    <div className="app-shell">
      <header className="desktop-bar">
        <div className="desktop-brand">
          <img src={appIconUrl} alt="" className="desktop-brand__icon" />
          <div>
            <strong>{t("探微")}</strong>
            <span>JVM WORKBENCH</span>
          </div>
        </div>

        <Tabs
          value={activeMode}
          onValueChange={(mode) => openWorkspaceMode(mode as WorkspaceMode)}
          className="justify-self-center gap-0"
        >
          <TabsList aria-label={t("工作模式")} className="h-auto">
            <TabsTrigger value="TARGETS" className="h-8 min-w-22">
              {t("目标")}
            </TabsTrigger>
            <TabsTrigger value="DIAGNOSTICS" className="h-8 min-w-22">
              {t("诊断")}
            </TabsTrigger>
            <TabsTrigger value="GOVERNANCE" className="h-8 min-w-22">
              {t("治理")}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="desktop-bar__actions">
          <DiagnosticAlertCenter />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="capability-trigger"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => setCapabilityPaletteOpen(true)}
          >
            <Search aria-hidden="true" />
            <span>{t("全部能力")}</span>
            <Kbd>⌘K</Kbd>
          </Button>
          <StatusPill
            state={
              connection?.state === "READY"
                ? "ready"
                : errorMessage
                  ? "error"
                  : "idle"
            }
            label={connectionLabel}
          />
        </div>
      </header>

      <aside className="sidebar">
        <Button type="button" asChild variant="outline" className="new-action">
          <NavLink to="/targets">
            <span>{t("添加连接")}</span>
            <Plus aria-hidden="true" />
          </NavLink>
        </Button>

        <nav aria-label={t("主导航")} className="navigation">
          {NAVIGATION_GROUPS.map((group) => (
            <section key={group.label} className="navigation__group">
              <p className="navigation__label">{t(group.label)}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) =>
                    isActive
                      ? "navigation__item router-link-active"
                      : "navigation__item"
                  }
                >
                  <span className="navigation__index" aria-hidden="true">
                    <item.icon />
                  </span>
                  <span>{t(item.label)}</span>
                </NavLink>
              ))}
            </section>
          ))}
        </nav>

        <footer className="sidebar__footer">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              isActive
                ? "navigation__item router-link-active"
                : "navigation__item"
            }
          >
            <span className="navigation__index" aria-hidden="true">
              <Settings />
            </span>
            <span>{t("设置")}</span>
          </NavLink>
        </footer>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="topbar__route">{t(routeMeta?.label ?? "工作台")}</p>
            <p className="topbar__eyebrow">{routeMeta?.eyebrow ?? "TANWEI"}</p>
          </div>
          {connection?.state === "READY" && (
            <p className="topbar__context">
              JDK {connection.javaVersion ?? t("未知")} · AGENT{" "}
              {connection.agentVersion ?? t("未知")} · PROTOCOL{" "}
              {connection.protocolVersion ?? t("未知")}
            </p>
          )}
        </header>

        <main ref={workspaceContentRef} className="workspace__content">
          <Outlet />
        </main>
      </section>

      <CapabilityPalette
        open={capabilityPaletteOpen}
        connected={connection?.state === "READY"}
        onOpenChange={setCapabilityPaletteOpen}
      />
      <ExitGuardDialog
        open={exitGuardOpen}
        loading={exitGuardLoading}
        reason={exitGuardReason}
        platform={runtimeInfo?.platform ?? null}
        impact={exitGuardImpact}
        errorMessage={exitGuardError}
        onContinue={clearExitGuard}
        onReview={() => void reviewExitTasks()}
        onBackground={() => void resolveExit("CLOSE_WINDOW")}
        onQuit={() => void resolveExit("QUIT_APP")}
      />
    </div>
  );
}

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Boxes,
  Cloud,
  Laptop,
  Network,
  PlugZap,
  RefreshCw,
  Search,
  Server,
  Unplug,
} from "lucide-react";
import { useNavigate } from "react-router";
import RemoteTargetPanel from "../components/RemoteTargetPanel";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { formatDateTime, t, useLocale } from "../i18n";
import { cn } from "../lib/utils";
import { useTargetsStore } from "../stores/targets";

type RemoteConnectionMode = "SSH" | "KUBERNETES" | "PERSISTENT";
type ConnectionMode = "LOCAL" | RemoteConnectionMode;

const remoteModes: readonly {
  readonly value: RemoteConnectionMode;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  { value: "SSH", label: "SSH", icon: Server },
  { value: "KUBERNETES", label: "Kubernetes", icon: Boxes },
  { value: "PERSISTENT", label: "持久 Relay", icon: Network },
];

const modes: readonly {
  readonly value: ConnectionMode;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [{ value: "LOCAL", label: "本机", icon: Laptop }, ...remoteModes];

export default function TargetsView() {
  useLocale();
  const navigate = useNavigate();
  const targets = useTargetsStore((s) => s.targets);
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connections = useTargetsStore((s) => s.connections);
  const loading = useTargetsStore((s) => s.loading);
  const connecting = useTargetsStore((s) => s.connecting);
  const errorMessage = useTargetsStore((s) => s.errorMessage);
  const refresh = useTargetsStore((s) => s.refresh);
  const select = useTargetsStore((s) => s.select);
  const connectTarget = useTargetsStore((s) => s.connect);
  const disconnectTarget = useTargetsStore((s) => s.disconnect);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ConnectionMode>("LOCAL");

  const filteredTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return targets;
    }
    return targets.filter((target) =>
      [
        target.pid.toString(),
        target.displayName,
        target.mainClass,
        ...target.arguments,
      ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
    );
  }, [query, targets]);

  async function connect(targetId: string): Promise<void> {
    select(targetId);
    const result = await connectTarget(targetId);
    if (result.ok) {
      await navigate("/overview");
    }
  }

  async function disconnect(targetId: string): Promise<void> {
    await disconnectTarget(targetId);
  }

  return (
    <section className="page targets-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">TARGET ACCESS</p>
          <h1>{t("连接目标。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "在同一个桌面工作台连接本机、SSH 主机、Kubernetes Pod 或 mTLS 持久 Relay。每种路径都会先验证目标身份与运行时。",
          )}
        </p>
      </header>

      <Tabs
        value={mode}
        onValueChange={(value) => setMode(value as ConnectionMode)}
        className="gap-6"
      >
        <TabsList
          aria-label={t("目标连接方式")}
          className="grid h-auto w-full grid-cols-2 p-1 md:max-w-2xl md:grid-cols-4"
        >
          {modes.map((option) => {
            const Icon = option.icon;
            return (
              <TabsTrigger
                key={option.value}
                value={option.value}
                className="h-9"
              >
                <Icon aria-hidden="true" />
                {t(option.label)}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="LOCAL" className="grid gap-6">
          {(targets.length > 0 || loading) && (
            <div className="grid items-end gap-4 md:grid-cols-[minmax(0,32rem)_auto] md:justify-between">
              <div className="grid gap-2">
                <Label htmlFor="target-filter">{t("筛选进程")}</Label>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                  />
                  <Input
                    id="target-filter"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    className="pl-9"
                    type="search"
                    placeholder={t("PID、主类、JAR 或参数")}
                    autoComplete="off"
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={loading}
                aria-busy={loading}
                onClick={() => void refresh()}
              >
                {loading ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                {t("刷新目标")}
              </Button>
            </div>
          )}

          {errorMessage && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{t("发现失败")}</AlertTitle>
              <AlertDescription>{t(errorMessage)}</AlertDescription>
            </Alert>
          )}

          {(targets.length > 0 || loading) && (
            <div className="grid gap-3" aria-live="polite">
              {loading && targets.length === 0
                ? Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-28 rounded-xl" />
                  ))
                : filteredTargets.map((target) => {
                    const ready = connections[target.id]?.state === "READY";
                    const selected = selectedTargetId === target.id;
                    const isConnecting = connecting && selected;
                    return (
                      <article key={target.id} className="target-row">
                        <Card
                          className={cn(
                            "gap-0 overflow-hidden py-0 transition-colors",
                            selected &&
                              "border-ring bg-accent/30 ring-1 ring-ring/30",
                          )}
                        >
                          <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                            <Button
                              type="button"
                              variant="ghost"
                              aria-pressed={selected}
                              onClick={() => select(target.id)}
                              className="h-auto min-w-0 justify-start px-5 py-5 text-left hover:bg-accent/40"
                            >
                              <Badge
                                variant="outline"
                                className="min-w-16 justify-center font-mono tabular-nums"
                              >
                                PID {target.pid}
                              </Badge>
                              <span className="grid min-w-0 gap-1">
                                <strong className="truncate text-sm font-medium">
                                  {target.displayName || t("未命名Java进程")}
                                </strong>
                                <span className="text-muted-foreground truncate text-xs font-normal">
                                  {target.mainClass || t("主类未知")}
                                </span>
                                <span className="text-muted-foreground truncate text-xs font-normal">
                                  {target.user ?? t("用户未知")} ·{" "}
                                  {target.javaPath ?? t("Java路径未知")} ·{" "}
                                  {target.startTime
                                    ? formatDateTime(target.startTime)
                                    : t("启动时间未知")}
                                </span>
                              </span>
                            </Button>

                            <div className="flex items-center gap-3 border-t px-5 py-4 lg:border-t-0 lg:border-l">
                              <Badge
                                variant={
                                  ready
                                    ? "secondary"
                                    : target.attachable
                                      ? "outline"
                                      : "destructive"
                                }
                              >
                                {ready
                                  ? t("已连接")
                                  : target.attachable
                                    ? t("可Attach")
                                    : t("不可Attach")}
                              </Badge>
                              {ready ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => void disconnect(target.id)}
                                >
                                  <Unplug aria-hidden="true" />
                                  {t("断开")}
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={!target.attachable || isConnecting}
                                  aria-busy={isConnecting}
                                  onClick={() => void connect(target.id)}
                                >
                                  {isConnecting ? (
                                    <Spinner />
                                  ) : (
                                    <PlugZap aria-hidden="true" />
                                  )}
                                  {t("连接")}
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      </article>
                    );
                  })}

              {!loading && filteredTargets.length === 0 && (
                <Card className="border-dashed">
                  <CardHeader className="items-center text-center">
                    <Cloud
                      aria-hidden="true"
                      className="text-muted-foreground size-8"
                    />
                    <CardTitle>{t("没有发现匹配的 Java 进程。")}</CardTitle>
                    <CardDescription>
                      {t(
                        "请启动目标 JVM，或检查当前用户是否拥有查看和 Attach 权限。",
                      )}
                    </CardDescription>
                  </CardHeader>
                </Card>
              )}
            </div>
          )}

          {!loading && targets.length === 0 && (
            <FirstConnection onSelectMode={setMode} onRefresh={refresh} />
          )}
        </TabsContent>

        {remoteModes.map((option) => (
          <TabsContent key={option.value} value={option.value}>
            <RemoteTargetPanel mode={option.value} />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}

interface FirstConnectionProps {
  readonly onSelectMode: (mode: ConnectionMode) => void;
  readonly onRefresh: () => Promise<void>;
}

function FirstConnection({ onSelectMode, onRefresh }: FirstConnectionProps) {
  return (
    <Card className="mx-auto w-full max-w-4xl overflow-hidden">
      <CardHeader className="items-center px-6 text-center md:px-10">
        <div className="bg-muted text-muted-foreground grid size-11 place-items-center rounded-xl border">
          <Laptop aria-hidden="true" className="size-5" />
        </div>
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          FIRST CONNECTION
        </p>
        <CardTitle className="text-xl">{t("从一个 JVM 开始。")}</CardTitle>
        <CardDescription className="max-w-xl">
          {t(
            "探微会在连接前确认目标身份与 Attach 能力，所有诊断动作都留在本机。",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 px-6 md:px-10">
        <div className="bg-muted/40 flex flex-col gap-4 rounded-xl border p-5 md:flex-row md:items-center md:justify-between">
          <div className="grid gap-1">
            <strong className="text-sm">
              {t("扫描当前设备上的 Java 进程")}
            </strong>
            <span className="text-muted-foreground text-sm">
              {t("适合第一次使用，也可以随时重新扫描。")}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void onRefresh()}
          >
            <RefreshCw aria-hidden="true" />
            {t("扫描本机")}
          </Button>
        </div>

        <Separator />

        <div className="grid gap-3 md:grid-cols-3">
          <ConnectionSuggestion
            icon={Server}
            title="SSH"
            description={t("验证主机后部署临时组件")}
            onClick={() => onSelectMode("SSH")}
          />
          <ConnectionSuggestion
            icon={Boxes}
            title="Kubernetes"
            description={t("定位 Pod 与容器中的 JVM")}
            onClick={() => onSelectMode("KUBERNETES")}
          />
          <ConnectionSuggestion
            icon={Network}
            title={t("持久 Relay")}
            description={t("通过 mTLS 连接常驻节点")}
            onClick={() => onSelectMode("PERSISTENT")}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface ConnectionSuggestionProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly onClick: () => void;
}

function ConnectionSuggestion({
  icon: Icon,
  title,
  description,
  onClick,
}: ConnectionSuggestionProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className="h-auto min-h-28 flex-col items-start justify-between gap-3 whitespace-normal p-4 text-left"
    >
      <span className="bg-muted grid size-8 place-items-center rounded-lg">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="grid gap-1">
        <strong className="font-medium">{title}</strong>
        <span className="text-muted-foreground text-xs font-normal">
          {description}
        </span>
      </span>
    </Button>
  );
}

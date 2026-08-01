import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Boxes,
  CalendarClock,
  FileCheck2,
  KeyRound,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useNavigate } from "react-router";
import type {
  KubernetesContextDescriptor,
  KubernetesPodDescriptor,
  PersistentRelayPreview,
  RemoteDeploymentPreview,
  SshRemotePreviewInput,
} from "@shared/contracts";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import { useTargetsStore } from "../stores/targets";
import RiskPill from "./RiskPill";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Separator } from "./ui/separator";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";

export interface RemoteTargetPanelProps {
  readonly mode: "SSH" | "KUBERNETES" | "PERSISTENT";
}

interface SshFormState {
  host: string;
  port: number;
  username: string;
  pid: number;
  authenticationKind: "PASSWORD" | "PRIVATE_KEY";
  password: string;
  privateKey: string;
  passphrase: string;
}

interface KubernetesFormState {
  context: string;
  namespace: string;
  pod: string;
  container: string;
  pid: number;
}

interface PersistentFormState {
  host: string;
  port: number;
  serverName: string;
  caCertificate: string;
  clientCertificate: string;
  clientPrivateKey: string;
  sessionSecret: string;
  pid: number;
  displayName: string;
}

export default function RemoteTargetPanel({ mode }: RemoteTargetPanelProps) {
  useLocale();
  const navigate = useNavigate();
  const registerRemoteConnection = useTargetsStore(
    (s) => s.registerRemoteConnection,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<
    RemoteDeploymentPreview | PersistentRelayPreview | null
  >(null);
  const [confirmed, setConfirmed] = useState(false);
  const [ssh, setSsh] = useState<SshFormState>({
    host: "",
    port: 22,
    username: "",
    pid: 1,
    authenticationKind: "PASSWORD",
    password: "",
    privateKey: "",
    passphrase: "",
  });
  const [contexts, setContexts] = useState<
    readonly KubernetesContextDescriptor[]
  >([]);
  const [namespaces, setNamespaces] = useState<readonly string[]>([]);
  const [pods, setPods] = useState<readonly KubernetesPodDescriptor[]>([]);
  const [kubernetes, setKubernetes] = useState<KubernetesFormState>({
    context: "",
    namespace: "",
    pod: "",
    container: "",
    pid: 1,
  });
  const [persistent, setPersistent] = useState<PersistentFormState>({
    host: "",
    port: 7443,
    serverName: "",
    caCertificate: "",
    clientCertificate: "",
    clientPrivateKey: "",
    sessionSecret: "",
    pid: 1,
    displayName: "",
  });

  // 镜像异步链路中需要实时读取的状态，与 Vue reactive 的读取语义对齐。
  // Mirror the states read inside async chains, matching Vue reactive semantics.
  const contextsRef = useRef(contexts);
  const podsRef = useRef(pods);
  const kubernetesRef = useRef(kubernetes);

  const updateContexts = useCallback(
    (next: readonly KubernetesContextDescriptor[]) => {
      contextsRef.current = next;
      setContexts(next);
    },
    [],
  );
  const updatePods = useCallback((next: readonly KubernetesPodDescriptor[]) => {
    podsRef.current = next;
    setPods(next);
  }, []);
  const patchKubernetes = useCallback((next: Partial<KubernetesFormState>) => {
    kubernetesRef.current = { ...kubernetesRef.current, ...next };
    setKubernetes(kubernetesRef.current);
  }, []);
  const patchSsh = useCallback((next: Partial<SshFormState>) => {
    setSsh((previous) => ({ ...previous, ...next }));
  }, []);
  const patchPersistent = useCallback((next: Partial<PersistentFormState>) => {
    setPersistent((previous) => ({ ...previous, ...next }));
  }, []);

  const selectedPod = pods.find((pod) => pod.name === kubernetes.pod) ?? null;

  async function loadContexts(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.listKubernetesContexts();
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("无法读取 Kubernetes Context"));
        return;
      }
      updateContexts(result.value);
      patchKubernetes({
        context:
          result.value.find((context) => context.current)?.name ??
          result.value[0]?.name ??
          "",
      });
      await loadNamespaces();
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("无法读取 Kubernetes Context"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadNamespaces(): Promise<void> {
    setNamespaces([]);
    updatePods([]);
    patchKubernetes({ namespace: "", pod: "", container: "" });
    const context = kubernetesRef.current.context;
    if (!context) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.listKubernetesNamespaces(context);
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("无法读取 Namespace"));
        return;
      }
      setNamespaces(result.value);
      patchKubernetes({
        namespace: result.value.includes("default")
          ? "default"
          : (result.value[0] ?? ""),
      });
      await loadPods();
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("无法读取 Namespace"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadPods(): Promise<void> {
    updatePods([]);
    patchKubernetes({ pod: "", container: "" });
    const { context, namespace } = kubernetesRef.current;
    if (!context || !namespace) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.listKubernetesPods(context, namespace);
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("无法读取 Pod"));
        return;
      }
      updatePods(result.value);
      const running = result.value.find((pod) => pod.phase === "Running");
      patchKubernetes({
        pod: running?.name ?? result.value[0]?.name ?? "",
      });
      selectPod();
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("无法读取 Pod"),
      );
    } finally {
      setBusy(false);
    }
  }

  function selectPod(): void {
    const selected =
      podsRef.current.find((pod) => pod.name === kubernetesRef.current.pod) ??
      null;
    patchKubernetes({ container: selected?.containers[0] ?? "" });
  }

  async function previewSsh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const authentication: SshRemotePreviewInput["authentication"] =
        ssh.authenticationKind === "PASSWORD"
          ? { kind: "PASSWORD", password: ssh.password }
          : {
              kind: "PRIVATE_KEY",
              privateKey: ssh.privateKey,
              passphrase: ssh.passphrase,
            };
      const result = await window.tanwei.previewSshRemote({
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        authentication,
        pid: ssh.pid,
      });
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("SSH 预检失败"));
        return;
      }
      setPreview(result.value);
      patchSsh({ password: "", privateKey: "", passphrase: "" });
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : t("SSH 预检失败"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function previewKubernetes(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.previewKubernetesRemote({
        context: kubernetes.context,
        namespace: kubernetes.namespace,
        pod: kubernetes.pod,
        container: kubernetes.container,
        pid: kubernetes.pid,
      });
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("Kubernetes 预检失败"));
        return;
      }
      setPreview(result.value);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : t("Kubernetes 预检失败"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function previewPersistent(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.previewPersistentRelay({
        ...persistent,
      });
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("持久 Relay 预检失败"));
        return;
      }
      setPreview(result.value);
      patchPersistent({
        caCertificate: "",
        clientCertificate: "",
        clientPrivateKey: "",
        sessionSecret: "",
      });
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : t("持久 Relay 预检失败"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function deploy(): Promise<void> {
    if (!preview || !confirmed) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.deployRemote(preview.id, confirmed);
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("远程部署失败"));
        return;
      }
      registerRemoteConnection(result.value);
      await navigate("/overview");
    } catch (deploymentError) {
      setError(
        deploymentError instanceof Error
          ? deploymentError.message
          : t("远程部署失败"),
      );
    } finally {
      setBusy(false);
    }
  }

  function discardPreview(): void {
    const previewId = preview?.id;
    setPreview(null);
    setConfirmed(false);
    setError(null);
    if (previewId) {
      void window.tanwei.cancelRemotePreview(previewId).catch(() => undefined);
    }
  }

  useEffect(() => {
    discardPreview();
    if (mode === "KUBERNETES" && contextsRef.current.length === 0) {
      void loadContexts();
    }
    // 仅在 mode 变化时触发，与 Vue watch(() => props.mode) 语义一致。
    // Mirrors Vue watch(() => props.mode); must run only when mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const presentation = remotePresentation(mode);
  const sshInputComplete =
    ssh.host.length > 0 &&
    ssh.username.length > 0 &&
    Number.isInteger(ssh.pid) &&
    ssh.pid > 0 &&
    (ssh.authenticationKind === "PASSWORD"
      ? ssh.password.length > 0
      : ssh.privateKey.length > 0);
  const kubernetesInputComplete =
    kubernetes.context.length > 0 &&
    kubernetes.namespace.length > 0 &&
    kubernetes.pod.length > 0 &&
    kubernetes.container.length > 0 &&
    Number.isInteger(kubernetes.pid) &&
    kubernetes.pid > 0;
  const persistentInputComplete =
    persistent.host.length > 0 &&
    persistent.serverName.length > 0 &&
    persistent.caCertificate.length > 0 &&
    persistent.clientCertificate.length > 0 &&
    persistent.clientPrivateKey.length > 0 &&
    persistent.sessionSecret.length === 64 &&
    Number.isInteger(persistent.pid) &&
    persistent.pid > 0;

  return (
    <div className="grid gap-6">
      <RemoteIntro {...presentation} />

      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{t("操作未完成")}</AlertTitle>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}

      {mode === "SSH" && !preview && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <KeyRound aria-hidden="true" className="size-4" />
              SSH
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-5 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void previewSsh();
              }}
            >
              <RemoteField id="ssh-host" label={t("主机")}>
                <Input
                  id="ssh-host"
                  value={ssh.host}
                  onChange={(event) =>
                    patchSsh({ host: event.target.value.trim() })
                  }
                  required
                  maxLength={253}
                  autoComplete="off"
                  placeholder="server.example.com"
                />
              </RemoteField>
              <RemoteField id="ssh-port" label={t("端口")}>
                <Input
                  id="ssh-port"
                  value={ssh.port}
                  onChange={(event) =>
                    patchSsh({ port: Number(event.target.value) })
                  }
                  required
                  type="number"
                  min="1"
                  max="65535"
                />
              </RemoteField>
              <RemoteField id="ssh-username" label={t("用户名")}>
                <Input
                  id="ssh-username"
                  value={ssh.username}
                  onChange={(event) =>
                    patchSsh({ username: event.target.value.trim() })
                  }
                  required
                  maxLength={128}
                  autoComplete="username"
                />
              </RemoteField>
              <RemoteField id="ssh-pid" label="PID">
                <Input
                  id="ssh-pid"
                  value={ssh.pid}
                  onChange={(event) =>
                    patchSsh({ pid: Number(event.target.value) })
                  }
                  required
                  type="number"
                  min="1"
                />
              </RemoteField>
              <RemoteField id="ssh-auth-kind" label={t("认证方式")} wide>
                <Select
                  value={ssh.authenticationKind}
                  onValueChange={(value) =>
                    patchSsh({
                      authenticationKind: value as "PASSWORD" | "PRIVATE_KEY",
                    })
                  }
                >
                  <SelectTrigger id="ssh-auth-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PASSWORD">{t("密码")}</SelectItem>
                    <SelectItem value="PRIVATE_KEY">{t("私钥")}</SelectItem>
                  </SelectContent>
                </Select>
              </RemoteField>
              {ssh.authenticationKind === "PASSWORD" ? (
                <RemoteField
                  id="ssh-password"
                  label={t("密码（仅本次会话）")}
                  wide
                >
                  <Input
                    id="ssh-password"
                    value={ssh.password}
                    onChange={(event) =>
                      patchSsh({ password: event.target.value })
                    }
                    required
                    type="password"
                    autoComplete="current-password"
                  />
                </RemoteField>
              ) : (
                <RemoteField
                  id="ssh-private-key"
                  label={t("OpenSSH 私钥（仅本次会话）")}
                  wide
                >
                  <Textarea
                    id="ssh-private-key"
                    value={ssh.privateKey}
                    onChange={(event) =>
                      patchSsh({ privateKey: event.target.value })
                    }
                    required
                    rows={7}
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-40 resize-y font-mono"
                  />
                </RemoteField>
              )}
              {ssh.authenticationKind === "PRIVATE_KEY" && (
                <RemoteField
                  id="ssh-passphrase"
                  label={t("私钥口令（可选）")}
                  wide
                >
                  <Input
                    id="ssh-passphrase"
                    value={ssh.passphrase}
                    onChange={(event) =>
                      patchSsh({ passphrase: event.target.value })
                    }
                    type="password"
                    autoComplete="off"
                  />
                </RemoteField>
              )}
              <div className="flex justify-end md:col-span-2">
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={busy || !sshInputComplete}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : <ShieldCheck aria-hidden="true" />}
                  {t("连接并生成部署预览")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {mode === "KUBERNETES" && !preview && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Boxes aria-hidden="true" className="size-4" />
              Kubernetes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-5 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void previewKubernetes();
              }}
            >
              <RemoteField id="kubernetes-context" label="Context">
                <Select
                  value={kubernetes.context}
                  onValueChange={(value) => {
                    patchKubernetes({ context: value });
                    void loadNamespaces();
                  }}
                >
                  <SelectTrigger id="kubernetes-context" className="w-full">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {contexts.map((context) => (
                      <SelectItem key={context.name} value={context.name}>
                        {context.name}
                        {context.current ? " · " + t("当前") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </RemoteField>
              <RemoteField id="kubernetes-namespace" label="Namespace">
                <Select
                  value={kubernetes.namespace}
                  onValueChange={(value) => {
                    patchKubernetes({ namespace: value });
                    void loadPods();
                  }}
                >
                  <SelectTrigger id="kubernetes-namespace" className="w-full">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {namespaces.map((namespace) => (
                      <SelectItem key={namespace} value={namespace}>
                        {namespace}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </RemoteField>
              <RemoteField id="kubernetes-pod" label="Pod">
                <Select
                  value={kubernetes.pod}
                  onValueChange={(value) => {
                    patchKubernetes({ pod: value });
                    selectPod();
                  }}
                >
                  <SelectTrigger id="kubernetes-pod" className="w-full">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {pods.map((pod) => (
                      <SelectItem key={pod.name} value={pod.name}>
                        {pod.name} · {pod.phase}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </RemoteField>
              <RemoteField id="kubernetes-container" label="Container">
                <Select
                  value={kubernetes.container}
                  onValueChange={(value) =>
                    patchKubernetes({ container: value })
                  }
                >
                  <SelectTrigger id="kubernetes-container" className="w-full">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {(selectedPod?.containers ?? []).map((container) => (
                      <SelectItem key={container} value={container}>
                        {container}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </RemoteField>
              <RemoteField id="kubernetes-pid" label="PID">
                <Input
                  id="kubernetes-pid"
                  value={kubernetes.pid}
                  onChange={(event) =>
                    patchKubernetes({ pid: Number(event.target.value) })
                  }
                  required
                  type="number"
                  min="1"
                />
              </RemoteField>
              <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => void loadContexts()}
                >
                  {busy ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                  {t("刷新集群目录")}
                </Button>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={busy || !kubernetesInputComplete}
                  aria-busy={busy}
                >
                  <ShieldCheck aria-hidden="true" />
                  {t("验证 Pod 并生成部署预览")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {mode === "PERSISTENT" && !preview && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Network aria-hidden="true" className="size-4" />
              mTLS Relay
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-5 md:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void previewPersistent();
              }}
            >
              <RemoteField id="relay-host" label={t("主机")}>
                <Input
                  id="relay-host"
                  value={persistent.host}
                  onChange={(event) =>
                    patchPersistent({ host: event.target.value.trim() })
                  }
                  required
                  maxLength={253}
                  autoComplete="off"
                  placeholder="relay.example.com"
                />
              </RemoteField>
              <RemoteField id="relay-port" label={t("端口")}>
                <Input
                  id="relay-port"
                  value={persistent.port}
                  onChange={(event) =>
                    patchPersistent({ port: Number(event.target.value) })
                  }
                  required
                  type="number"
                  min="1"
                  max="65535"
                />
              </RemoteField>
              <RemoteField id="relay-server-name" label={t("TLS 服务名")}>
                <Input
                  id="relay-server-name"
                  value={persistent.serverName}
                  onChange={(event) =>
                    patchPersistent({
                      serverName: event.target.value.trim(),
                    })
                  }
                  required
                  maxLength={253}
                  autoComplete="off"
                  placeholder="relay.example.com"
                />
              </RemoteField>
              <RemoteField id="relay-pid" label="PID">
                <Input
                  id="relay-pid"
                  value={persistent.pid}
                  onChange={(event) =>
                    patchPersistent({ pid: Number(event.target.value) })
                  }
                  required
                  type="number"
                  min="1"
                />
              </RemoteField>
              <RemoteField
                id="relay-display-name"
                label={t("目标显示名（可选）")}
                wide
              >
                <Input
                  id="relay-display-name"
                  value={persistent.displayName}
                  onChange={(event) =>
                    patchPersistent({
                      displayName: event.target.value.trim(),
                    })
                  }
                  maxLength={200}
                  autoComplete="off"
                />
              </RemoteField>
              <RemoteField
                id="relay-ca"
                label={t("CA 证书 PEM（仅本次会话）")}
                wide
              >
                <Textarea
                  id="relay-ca"
                  value={persistent.caCertificate}
                  onChange={(event) =>
                    patchPersistent({
                      caCertificate: event.target.value,
                    })
                  }
                  required
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-36 resize-y font-mono"
                />
              </RemoteField>
              <RemoteField
                id="relay-client-certificate"
                label={t("客户端证书 PEM（仅本次会话）")}
                wide
              >
                <Textarea
                  id="relay-client-certificate"
                  value={persistent.clientCertificate}
                  onChange={(event) =>
                    patchPersistent({
                      clientCertificate: event.target.value,
                    })
                  }
                  required
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-36 resize-y font-mono"
                />
              </RemoteField>
              <RemoteField
                id="relay-private-key"
                label={t("客户端私钥 PEM（仅本次会话）")}
                wide
              >
                <Textarea
                  id="relay-private-key"
                  value={persistent.clientPrivateKey}
                  onChange={(event) =>
                    patchPersistent({
                      clientPrivateKey: event.target.value,
                    })
                  }
                  required
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-h-36 resize-y font-mono"
                />
              </RemoteField>
              <RemoteField
                id="relay-session-secret"
                label={t("Relay 会话密钥（64 位十六进制）")}
                wide
              >
                <Input
                  id="relay-session-secret"
                  value={persistent.sessionSecret}
                  onChange={(event) =>
                    patchPersistent({
                      sessionSecret: event.target.value.trim(),
                    })
                  }
                  required
                  type="password"
                  minLength={64}
                  maxLength={64}
                  autoComplete="off"
                />
              </RemoteField>
              <div className="flex justify-end md:col-span-2">
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={busy || !persistentInputComplete}
                  aria-busy={busy}
                >
                  {busy ? <Spinner /> : <ShieldCheck aria-hidden="true" />}
                  {t("验证 mTLS 并生成连接预览")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {preview && (
        <DeploymentPreviewCard
          preview={preview}
          confirmed={confirmed}
          busy={busy}
          onConfirmedChange={setConfirmed}
          onDiscard={discardPreview}
          onDeploy={() => void deploy()}
        />
      )}
    </div>
  );
}

interface RemotePresentation {
  readonly icon: LucideIcon;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}

function remotePresentation(
  mode: RemoteTargetPanelProps["mode"],
): RemotePresentation {
  if (mode === "SSH") {
    return {
      icon: Server,
      eyebrow: "BUILT-IN SSH / SFTP",
      title: t("通过 SSH 连接远程 JVM"),
      description: t(
        "探微使用内置客户端部署一次性 Relay；不会调用系统 ssh、scp 或 kubectl，也不会持久化本次凭据。",
      ),
    };
  }
  if (mode === "KUBERNETES") {
    return {
      icon: Boxes,
      eyebrow: "KUBERNETES API",
      title: t("连接 Kubernetes Pod 内的 JVM"),
      description: t(
        "探微使用内置客户端部署一次性 Relay；不会调用系统 ssh、scp 或 kubectl，也不会持久化本次凭据。",
      ),
    };
  }
  return {
    icon: Network,
    eyebrow: "PERSISTENT RELAY / mTLS",
    title: t("连接已安装的持久 Relay"),
    description: t(
      "持久 Relay 只接受双向 TLS；证书、私钥与会话密钥仅用于本次连接，不写入 SQLite，断开不会停止远端服务。",
    ),
  };
}

function RemoteIntro({
  icon: Icon,
  eyebrow,
  title,
  description,
}: RemotePresentation) {
  return (
    <Card>
      <CardContent className="grid items-end gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex items-start gap-4">
          <div className="bg-muted grid size-10 shrink-0 place-items-center rounded-xl border">
            <Icon aria-hidden="true" className="size-5" />
          </div>
          <div className="grid gap-2">
            <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              {eyebrow}
            </p>
            <h2 className="text-lg font-semibold">{title}</h2>
          </div>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {description}
        </p>
      </CardContent>
    </Card>
  );
}

interface RemoteFieldProps {
  readonly id: string;
  readonly label: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}

function RemoteField({ id, label, wide = false, children }: RemoteFieldProps) {
  return (
    <div className={wide ? "grid gap-2 md:col-span-2" : "grid gap-2"}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

interface DeploymentPreviewCardProps {
  readonly preview: RemoteDeploymentPreview | PersistentRelayPreview;
  readonly confirmed: boolean;
  readonly busy: boolean;
  readonly onConfirmedChange: (confirmed: boolean) => void;
  readonly onDiscard: () => void;
  readonly onDeploy: () => void;
}

function DeploymentPreviewCard({
  preview,
  confirmed,
  busy,
  onConfirmedChange,
  onDiscard,
  onDeploy,
}: DeploymentPreviewCardProps) {
  const confirmationLabel =
    preview.mode === "PERSISTENT"
      ? t(
          "我已核对目标、TLS 服务名、CA 与客户端证书指纹，并确认建立 R2 持久 Relay 连接。",
        )
      : t("我已核对目标、平台、指纹、文件哈希和命令，并确认执行 R2 远程部署。");

  return (
    <Card className="overflow-hidden border-primary/30">
      <CardHeader className="border-b">
        <div className="flex items-center gap-2">
          <RiskPill level="R2" compact />
          <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            EXPLICIT CONFIRMATION
          </span>
        </div>
        <CardTitle>
          <h2 className="text-lg">
            {preview.mode === "PERSISTENT"
              ? t("持久 Relay 连接预览")
              : t("远程部署预览")}
          </h2>
        </CardTitle>
        <CardDescription>
          {t("预检指纹")} · {preview.id}
        </CardDescription>
        <CardAction>
          <Badge variant="secondary" className="gap-1">
            <CalendarClock aria-hidden="true" />
            {formatDateTime(preview.expiresAt)}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-6">
        <dl className="grid overflow-hidden rounded-lg border md:grid-cols-2">
          <PreviewFact label={t("目标")} value={preview.destination} />
          {preview.mode !== "PERSISTENT" && (
            <>
              <PreviewFact
                label={t("平台")}
                value={preview.platform + " / " + preview.architecture}
              />
              <PreviewFact label="Java" value={preview.javaVersion} />
              {preview.fingerprint && (
                <PreviewFact
                  label={t("SSH 主机密钥指纹")}
                  value={preview.fingerprint}
                  mono
                />
              )}
              <PreviewFact
                label={t("一次性目录")}
                value={preview.remoteDirectory}
                mono
              />
            </>
          )}
          {preview.mode === "PERSISTENT" && (
            <>
              <PreviewFact label={t("TLS 服务名")} value={preview.serverName} />
              <PreviewFact
                label={t("CA 指纹")}
                value={preview.caFingerprint}
                mono
              />
              <PreviewFact
                label={t("客户端证书指纹")}
                value={preview.clientFingerprint}
                mono
              />
              <PreviewFact label="PID" value={String(preview.pid)} />
            </>
          )}
        </dl>

        {preview.mode !== "PERSISTENT" && (
          <>
            <PreviewEvidenceSection
              title={t("将传输并校验的内置组件")}
              icon={FileCheck2}
            >
              <ul className="grid gap-2">
                {preview.files.map((file) => (
                  <li
                    key={file.name}
                    className="bg-muted/30 grid gap-1 rounded-lg border p-3"
                  >
                    <strong className="text-sm font-medium">{file.name}</strong>
                    <span className="text-muted-foreground break-all font-mono text-xs">
                      {formatNumber(file.size)} B · SHA-256 {file.sha256}
                    </span>
                  </li>
                ))}
              </ul>
            </PreviewEvidenceSection>

            <PreviewEvidenceSection
              title={t("将执行的步骤")}
              icon={ShieldCheck}
            >
              <ScrollArea className="h-56 rounded-lg border">
                <ol className="grid gap-2 p-3">
                  {preview.commands.map((command, index) => (
                    <li
                      key={command}
                      className="bg-muted/30 grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-lg p-3"
                    >
                      <Badge
                        variant="outline"
                        className="size-6 justify-center p-0 font-mono"
                      >
                        {index + 1}
                      </Badge>
                      <code className="text-muted-foreground break-all text-xs">
                        {command}
                      </code>
                    </li>
                  ))}
                </ol>
              </ScrollArea>
            </PreviewEvidenceSection>
          </>
        )}

        <Separator />

        <div className="bg-muted/30 flex items-start gap-3 rounded-lg border p-4">
          <Checkbox
            id="remote-deployment-confirmation"
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(checked) => onConfirmedChange(checked === true)}
            className="mt-0.5"
          />
          <Label
            htmlFor="remote-deployment-confirmation"
            className="text-muted-foreground cursor-pointer leading-relaxed"
          >
            {confirmationLabel}
          </Label>
        </div>
      </CardContent>

      <CardFooter className="justify-end gap-3 border-t">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={onDiscard}
        >
          {t("取消并重新预检")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !confirmed}
          aria-busy={busy}
          onClick={onDeploy}
        >
          {busy ? <Spinner /> : <ShieldCheck aria-hidden="true" />}
          {preview.mode === "PERSISTENT"
            ? t("确认 mTLS 连接")
            : t("确认部署并连接")}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface PreviewFactProps {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

function PreviewFact({ label, value, mono = false }: PreviewFactProps) {
  return (
    <div className="min-w-0 border-b p-4 last:border-b-0 md:border-r md:nth-[2n]:border-r-0">
      <dt className="text-muted-foreground mb-1 text-xs font-medium uppercase">
        {label}
      </dt>
      <dd
        className={
          mono
            ? "break-all font-mono text-xs"
            : "break-words text-sm font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}

interface PreviewEvidenceSectionProps {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly children: ReactNode;
}

function PreviewEvidenceSection({
  title,
  icon: Icon,
  children,
}: PreviewEvidenceSectionProps) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden="true" className="size-4" />
        {title}
      </h3>
      {children}
    </section>
  );
}

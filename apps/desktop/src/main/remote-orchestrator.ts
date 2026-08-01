import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { createReadStream } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  PortForward,
  type Context,
  type V1Status,
} from "@kubernetes/client-node";
import {
  Client,
  type ConnectConfig,
  type SFTPWrapper,
} from "ssh2";
import type {
  KubernetesContextDescriptor,
  KubernetesPodDescriptor,
  KubernetesRemotePreviewInput,
  OperationResult,
  PersistentRelayPreview,
  PersistentRelayPreviewInput,
  RemoteDeploymentFile,
  RemoteDeploymentPreview,
  SshRemotePreviewInput,
  TargetConnection,
  TargetDescriptor,
} from "../shared/contracts.js";
import {
  describeJvmComponent,
  type JvmComponentDescriptor,
} from "./component-resolver.js";
import type { TargetService } from "./target-service.js";
import {
  isSafeRemoteDirectory,
  normalizeRemotePlatform,
  quotePosixShell,
  stableRemoteTargetId,
  type NormalizedRemotePlatform,
} from "./remote-security.js";
import { LimitedBuffer } from "./limited-buffer.js";

const PREVIEW_TTL_MILLIS = 5 * 60_000;
const MAX_PENDING_PREVIEWS = 20;
const REMOTE_COMMAND_TIMEOUT_MILLIS = 15_000;
const DEPLOYMENT_TIMEOUT_MILLIS = 60_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const COMPONENT_IDS = [
  "attach-helper",
  "bootstrap",
  "agent",
  "relay",
] as const;

type RemotePlatform = NormalizedRemotePlatform;

interface PendingSshPreview {
  readonly mode: "SSH";
  readonly input: SshRemotePreviewInput;
  readonly fingerprint: string;
  readonly preview: RemoteDeploymentPreview;
}

interface PendingKubernetesPreview {
  readonly mode: "KUBERNETES";
  readonly input: KubernetesRemotePreviewInput;
  readonly preview: RemoteDeploymentPreview;
}

interface PendingPersistentPreview {
  readonly mode: "PERSISTENT";
  readonly input: PersistentRelayPreviewInput;
  readonly preview: PersistentRelayPreview;
}

type PendingPreview =
  | PendingSshPreview
  | PendingKubernetesPreview
  | PendingPersistentPreview;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface SshConnection {
  readonly client: Client;
  readonly fingerprint: string;
}

interface ForwardingServer {
  readonly server: Server;
  readonly port: number;
  readonly sockets: Set<Socket>;
}

function success<T>(value: T): OperationResult<T> {
  return {
    ok: true,
    value,
    errorCode: null,
    errorMessage: null,
  };
}

function failure<T>(
  errorCode: string,
  errorMessage: string,
): OperationResult<T> {
  return {
    ok: false,
    value: null,
    errorCode,
    errorMessage,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export class RemoteOrchestrator {
  readonly #targetService: TargetService;
  readonly #pending = new Map<string, PendingPreview>();

  constructor(targetService: TargetService) {
    this.#targetService = targetService;
  }

  async previewSsh(
    input: SshRemotePreviewInput,
  ): Promise<OperationResult<RemoteDeploymentPreview>> {
    let connection: SshConnection | null = null;
    try {
      connection = await connectSsh(input);
      const platform = await probeSshPlatform(connection.client);
      const preview = await createPreview(
        "SSH",
        `${input.username}@${input.host}:${input.port} / PID ${input.pid}`,
        platform,
        formatFingerprint(connection.fingerprint),
        input.pid,
      );
      this.#remember(preview.id, {
        mode: "SSH",
        input,
        fingerprint: connection.fingerprint,
        preview,
      });
      return success(preview);
    } catch (error) {
      return failure(
        "SSH_PREVIEW_FAILED",
        errorMessage(error, "无法完成 SSH 远程部署预检"),
      );
    } finally {
      connection?.client.end();
    }
  }

  listKubernetesContexts(): OperationResult<
    readonly KubernetesContextDescriptor[]
  > {
    try {
      const config = loadKubeConfig();
      const currentContext = config.getCurrentContext();
      return success(
        config
          .getContexts()
          .map((context) => contextDescriptor(context, currentContext))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (error) {
      return failure(
        "KUBERNETES_CONTEXTS_FAILED",
        errorMessage(error, "无法读取 Kubernetes Context"),
      );
    }
  }

  async listKubernetesNamespaces(
    context: string,
  ): Promise<OperationResult<readonly string[]>> {
    try {
      const config = loadKubeConfig(context);
      const response = await config.makeApiClient(CoreV1Api).listNamespace();
      return success(
        response.items
          .map((item) => item.metadata?.name ?? "")
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right)),
      );
    } catch (error) {
      return failure(
        "KUBERNETES_NAMESPACES_FAILED",
        errorMessage(error, "无法读取 Kubernetes Namespace"),
      );
    }
  }

  async listKubernetesPods(
    context: string,
    namespace: string,
  ): Promise<OperationResult<readonly KubernetesPodDescriptor[]>> {
    try {
      const config = loadKubeConfig(context);
      const response = await config
        .makeApiClient(CoreV1Api)
        .listNamespacedPod({ namespace });
      return success(
        response.items
          .map((pod): KubernetesPodDescriptor => ({
            name: pod.metadata?.name ?? "",
            phase: pod.status?.phase ?? "Unknown",
            nodeName: pod.spec?.nodeName ?? null,
            containers:
              pod.spec?.containers.map((container) => container.name) ?? [],
          }))
          .filter((pod) => Boolean(pod.name))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (error) {
      return failure(
        "KUBERNETES_PODS_FAILED",
        errorMessage(error, "无法读取 Kubernetes Pod"),
      );
    }
  }

  async previewKubernetes(
    input: KubernetesRemotePreviewInput,
  ): Promise<OperationResult<RemoteDeploymentPreview>> {
    try {
      const config = loadKubeConfig(input.context);
      await requirePodContainer(config, input);
      const platform = await probeKubernetesPlatform(config, input);
      const preview = await createPreview(
        "KUBERNETES",
        `${input.context} / ${input.namespace} / ${input.pod} / ${input.container} / PID ${input.pid}`,
        platform,
        null,
        input.pid,
      );
      this.#remember(preview.id, {
        mode: "KUBERNETES",
        input,
        preview,
      });
      return success(preview);
    } catch (error) {
      return failure(
        "KUBERNETES_PREVIEW_FAILED",
        errorMessage(error, "无法完成 Kubernetes 远程部署预检"),
      );
    }
  }

  previewPersistent(
    input: PersistentRelayPreviewInput,
  ): OperationResult<PersistentRelayPreview> {
    try {
      const credentials = validatePersistentCredentials(input);
      const preview: PersistentRelayPreview = {
        id: randomUUID(),
        mode: "PERSISTENT",
        destination: `${input.host}:${input.port} / PID ${input.pid}`,
        serverName: input.serverName,
        pid: input.pid,
        caFingerprint: credentials.caFingerprint,
        clientFingerprint: credentials.clientFingerprint,
        riskLevel: "R2",
        expiresAt: new Date(
          Date.now() + PREVIEW_TTL_MILLIS,
        ).toISOString(),
      };
      this.#remember(preview.id, {
        mode: "PERSISTENT",
        input,
        preview,
      });
      return success(preview);
    } catch (error) {
      return failure(
        "PERSISTENT_RELAY_PREVIEW_FAILED",
        errorMessage(error, "无法验证持久 Relay mTLS 凭据"),
      );
    }
  }

  async deploy(
    previewId: string,
    confirmed: boolean,
  ): Promise<OperationResult<TargetConnection>> {
    this.#prune();
    if (!confirmed) {
      return failure(
        "CONFIRMATION_REQUIRED",
        "远程部署属于 R2 操作，必须确认预览后才能继续",
      );
    }
    const pending = this.#pending.get(previewId);
    if (!pending) {
      return failure(
        "REMOTE_PREVIEW_EXPIRED",
        "远程部署预览不存在、已过期或已经使用",
      );
    }
    this.#pending.delete(previewId);
    if (Date.parse(pending.preview.expiresAt) <= Date.now()) {
      return failure("REMOTE_PREVIEW_EXPIRED", "远程部署预览已过期，请重新预检");
    }
    try {
      if (pending.mode === "SSH") {
        return await this.#deploySsh(pending);
      }
      if (pending.mode === "KUBERNETES") {
        return await this.#deployKubernetes(pending);
      }
      return await this.#deployPersistent(pending);
    } catch (error) {
      return failure(
        "REMOTE_DEPLOYMENT_FAILED",
        errorMessage(error, "远程组件部署失败"),
      );
    }
  }

  discard(previewId: string): OperationResult<null> {
    this.#pending.delete(previewId);
    return success(null);
  }

  async #deploySsh(
    pending: PendingSshPreview,
  ): Promise<OperationResult<TargetConnection>> {
    const { input, preview } = pending;
    let client: Client | null = null;
    let relayProcessId: number | null = null;
    let forwarding: ForwardingServer | null = null;
    let cleanupTransferred = false;
    try {
      const connection = await connectSsh(input, pending.fingerprint);
      client = connection.client;
      const currentPlatform = await probeSshPlatform(client);
      assertPlatformUnchanged(preview, currentPlatform);
      const components = await verifiedComponents(preview.files);

      await execSsh(
        client,
        `umask 077; mkdir -p -- ${quotePosixShell(preview.remoteDirectory)} && chmod 700 -- ${quotePosixShell(preview.remoteDirectory)}`,
      );
      const sftp = await openSftp(client);
      try {
        for (const component of components) {
          const remotePath = `${preview.remoteDirectory}/${component.file}`;
          await sftpFastPut(sftp, component.path, remotePath);
          await verifySshFile(client, remotePath, component.sha256);
        }
      } finally {
        sftp.end();
      }

      const upstreamPort = randomRemotePort();
      let relayPort = randomRemotePort();
      while (relayPort === upstreamPort) {
        relayPort = randomRemotePort();
      }
      const upstreamSecret = randomBytes(32).toString("hex");
      const relaySecret = randomBytes(32).toString("hex");
      const descriptorPath = `${preview.remoteDirectory}/relay.properties`;
      const attach = componentPath(components, "attach-helper", preview);
      const bootstrap = componentPath(components, "bootstrap", preview);
      const agent = componentPath(components, "agent", preview);
      const relay = componentPath(components, "relay", preview);

      await execSsh(
        client,
        [
          "java",
          "-jar",
          quotePosixShell(attach),
          "attach",
          "--pid",
          String(input.pid),
          "--bootstrap",
          quotePosixShell(bootstrap),
          "--agent",
          quotePosixShell(agent),
          "--port",
          String(upstreamPort),
          "--secret",
          upstreamSecret,
        ].join(" "),
        DEPLOYMENT_TIMEOUT_MILLIS,
      );
      const descriptor = relayDescriptor(
        relayPort,
        upstreamPort,
        relaySecret,
        upstreamSecret,
      );
      const descriptorSftp = await openSftp(client);
      try {
        await sftpWriteFile(
          descriptorSftp,
          descriptorPath,
          descriptor,
          0o600,
        );
      } finally {
        descriptorSftp.end();
      }
      const relayLog = `${preview.remoteDirectory}/relay.log`;
      const started = await execSsh(
        client,
        `nohup java -jar ${quotePosixShell(relay)} --descriptor ${quotePosixShell(descriptorPath)} > ${quotePosixShell(relayLog)} 2>&1 < /dev/null & echo $!`,
      );
      relayProcessId = parseProcessId(started.stdout);
      await waitForSshRelay(client, relayLog);

      forwarding = await startSshForwarding(client, relayPort);
      const target = remoteTarget(
        "ssh",
        `${input.host} / PID ${input.pid}`,
        input.pid,
        `${input.username}@${input.host}:${input.port}`,
        currentPlatform,
      );
      const cleanup = oneShotCleanup(async () => {
        await closeForwarding(forwarding);
        if (client) {
          await cleanupSshDeployment(
            client,
            preview.remoteDirectory,
            relayProcessId,
          );
          client.end();
        }
      });
      const result = await this.#targetService.connectRemoteTarget(target, {
        localPort: forwarding.port,
        secret: relaySecret,
        cleanup,
      });
      cleanupTransferred = result.ok;
      if (!result.ok) {
        await cleanup();
      }
      return result;
    } finally {
      if (!cleanupTransferred) {
        await closeForwarding(forwarding);
        if (client) {
          await cleanupSshDeployment(
            client,
            preview.remoteDirectory,
            relayProcessId,
          );
          client.end();
        }
      }
    }
  }

  async #deployKubernetes(
    pending: PendingKubernetesPreview,
  ): Promise<OperationResult<TargetConnection>> {
    const { input, preview } = pending;
    const config = loadKubeConfig(input.context);
    let relayProcessId: number | null = null;
    let forwarding: ForwardingServer | null = null;
    let cleanupTransferred = false;
    try {
      await requirePodContainer(config, input);
      const currentPlatform = await probeKubernetesPlatform(config, input);
      assertPlatformUnchanged(preview, currentPlatform);
      const components = await verifiedComponents(preview.files);
      await execKubernetes(
        config,
        input,
        [
          "/bin/sh",
          "-c",
          `umask 077; mkdir -p -- ${quotePosixShell(preview.remoteDirectory)} && chmod 700 -- ${quotePosixShell(preview.remoteDirectory)}`,
        ],
      );
      for (const component of components) {
        const remotePath = `${preview.remoteDirectory}/${component.file}`;
        await uploadKubernetesFile(config, input, component.path, remotePath);
        await verifyKubernetesFile(
          config,
          input,
          remotePath,
          component.sha256,
        );
      }

      const upstreamPort = randomRemotePort();
      let relayPort = randomRemotePort();
      while (relayPort === upstreamPort) {
        relayPort = randomRemotePort();
      }
      const upstreamSecret = randomBytes(32).toString("hex");
      const relaySecret = randomBytes(32).toString("hex");
      const descriptorPath = `${preview.remoteDirectory}/relay.properties`;
      const attach = componentPath(components, "attach-helper", preview);
      const bootstrap = componentPath(components, "bootstrap", preview);
      const agent = componentPath(components, "agent", preview);
      const relay = componentPath(components, "relay", preview);
      await execKubernetes(
        config,
        input,
        [
          "java",
          "-jar",
          attach,
          "attach",
          "--pid",
          String(input.pid),
          "--bootstrap",
          bootstrap,
          "--agent",
          agent,
          "--port",
          String(upstreamPort),
          "--secret",
          upstreamSecret,
        ],
        null,
        DEPLOYMENT_TIMEOUT_MILLIS,
      );
      await writeKubernetesFile(
        config,
        input,
        descriptorPath,
        relayDescriptor(
          relayPort,
          upstreamPort,
          relaySecret,
          upstreamSecret,
        ),
      );
      const relayLog = `${preview.remoteDirectory}/relay.log`;
      const started = await execKubernetes(
        config,
        input,
        [
          "/bin/sh",
          "-c",
          `nohup java -jar ${quotePosixShell(relay)} --descriptor ${quotePosixShell(descriptorPath)} > ${quotePosixShell(relayLog)} 2>&1 < /dev/null & echo $!`,
        ],
      );
      relayProcessId = parseProcessId(started.stdout);
      await waitForKubernetesRelay(config, input, relayLog);

      forwarding = await startKubernetesForwarding(
        config,
        input,
        relayPort,
      );
      const target = remoteTarget(
        "kubernetes",
        `${input.pod}/${input.container} / PID ${input.pid}`,
        input.pid,
        `${input.context}/${input.namespace}/${input.pod}/${input.container}`,
        currentPlatform,
      );
      const cleanup = oneShotCleanup(async () => {
        await closeForwarding(forwarding);
        await cleanupKubernetesDeployment(
          config,
          input,
          preview.remoteDirectory,
          relayProcessId,
        );
      });
      const result = await this.#targetService.connectRemoteTarget(target, {
        localPort: forwarding.port,
        secret: relaySecret,
        cleanup,
      });
      cleanupTransferred = result.ok;
      if (!result.ok) {
        await cleanup();
      }
      return result;
    } finally {
      if (!cleanupTransferred) {
        await closeForwarding(forwarding);
        await cleanupKubernetesDeployment(
          config,
          input,
          preview.remoteDirectory,
          relayProcessId,
        );
      }
    }
  }

  async #deployPersistent(
    pending: PendingPersistentPreview,
  ): Promise<OperationResult<TargetConnection>> {
    const { input } = pending;
    validatePersistentCredentials(input);
    const identity = `${input.host}:${input.port}/${input.serverName}`;
    const target: TargetDescriptor = {
      id: stableRemoteTargetId("persistent", identity, input.pid),
      pid: input.pid,
      displayName:
        input.displayName.trim() ||
        `${input.host} / PID ${input.pid}`,
      mainClass: "Persistent Relay JVM",
      arguments: [],
      javaPath: null,
      javaVersion: null,
      user: null,
      startTime: null,
      attachable: true,
      attachReason: null,
    };
    return this.#targetService.connectPersistentTarget(target, {
      host: input.host,
      port: input.port,
      serverName: input.serverName,
      rootCertificates: Buffer.from(input.caCertificate, "utf8"),
      clientPrivateKey: Buffer.from(input.clientPrivateKey, "utf8"),
      clientCertificate: Buffer.from(
        input.clientCertificate,
        "utf8",
      ),
      secret: input.sessionSecret,
    });
  }

  #remember(id: string, pending: PendingPreview): void {
    this.#prune();
    while (this.#pending.size >= MAX_PENDING_PREVIEWS) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.#pending.delete(oldest);
    }
    this.#pending.set(id, pending);
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (Date.parse(pending.preview.expiresAt) <= now) {
        this.#pending.delete(id);
      }
    }
  }
}

async function createPreview(
  mode: RemoteDeploymentPreview["mode"],
  destination: string,
  platform: RemotePlatform,
  fingerprint: string | null,
  pid: number,
): Promise<RemoteDeploymentPreview> {
  const id = randomUUID();
  const remoteDirectory = `/tmp/tanwei-${id}`;
  const components = await Promise.all(
    COMPONENT_IDS.map((component) => describeJvmComponent(component)),
  );
  return {
    id,
    mode,
    destination,
    platform: platform.platform,
    architecture: platform.architecture,
    javaVersion: platform.javaVersion,
    fingerprint,
    files: components.map(componentPreview),
    commands: [
      `umask 077; mkdir -p -- ${remoteDirectory}; chmod 700 -- ${remoteDirectory}`,
      `upload and verify ${components.length} bundled JVM components by SHA-256`,
      `java -jar <attach-helper> attach --pid ${pid} --bootstrap <bootstrap> --agent <agent> --port <ephemeral> --secret <redacted>`,
      "java -jar <relay> --descriptor <0600-one-time-descriptor>",
      "forward a loopback-only ephemeral Relay port",
      `disconnect cleanup: stop Relay and remove ${remoteDirectory}`,
    ],
    remoteDirectory,
    riskLevel: "R2",
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MILLIS).toISOString(),
  };
}

function componentPreview(
  component: JvmComponentDescriptor,
): RemoteDeploymentFile {
  return {
    name: component.file,
    size: component.size,
    sha256: component.sha256,
  };
}

async function verifiedComponents(
  expected: readonly RemoteDeploymentFile[],
): Promise<readonly JvmComponentDescriptor[]> {
  const components = await Promise.all(
    COMPONENT_IDS.map((component) => describeJvmComponent(component)),
  );
  for (const component of components) {
    const preview = expected.find((item) => item.name === component.file);
    if (
      !preview ||
      preview.size !== component.size ||
      preview.sha256 !== component.sha256
    ) {
      throw new Error(`组件 ${component.id} 在预览后发生变化，已拒绝部署`);
    }
  }
  return components;
}

function componentPath(
  components: readonly JvmComponentDescriptor[],
  id: JvmComponentDescriptor["id"],
  preview: RemoteDeploymentPreview,
): string {
  const component = components.find((item) => item.id === id);
  if (!component) {
    throw new Error(`组件 ${id} 不存在`);
  }
  return `${preview.remoteDirectory}/${component.file}`;
}

async function connectSsh(
  input: SshRemotePreviewInput,
  expectedFingerprint?: string,
): Promise<SshConnection> {
  const client = new Client();
  client.on("error", () => {
    // Connection and forwarding failures are surfaced by the active operation
    // or Agent heartbeat; retain a listener so late socket errors cannot crash
    // the Electron main process.
  });
  let fingerprint = "";
  const authentication: Partial<ConnectConfig> =
    input.authentication.kind === "PASSWORD"
      ? { password: input.authentication.password }
      : {
          privateKey: input.authentication.privateKey,
          ...(input.authentication.passphrase
            ? { passphrase: input.authentication.passphrase }
            : {}),
        };
  const config: ConnectConfig = {
    host: input.host,
    port: input.port,
    username: input.username,
    hostHash: "sha256",
    hostVerifier: (hash: string) => {
      fingerprint = hash;
      return expectedFingerprint === undefined || hash === expectedFingerprint;
    },
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    readyTimeout: REMOTE_COMMAND_TIMEOUT_MILLIS,
    ...authentication,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      client.connect(config);
    });
  } catch (error) {
    client.destroy();
    if (
      expectedFingerprint !== undefined &&
      fingerprint &&
      fingerprint !== expectedFingerprint
    ) {
      throw new Error("SSH 主机密钥指纹与预览不一致，已拒绝连接", {
        cause: error,
      });
    }
    throw error;
  }
  if (!fingerprint) {
    client.destroy();
    throw new Error("SSH 服务端未提供可验证的主机密钥指纹");
  }
  return { client, fingerprint };
}

async function probeSshPlatform(client: Client): Promise<RemotePlatform> {
  const [system, architecture, java] = await Promise.all([
    execSsh(client, "uname -s"),
    execSsh(client, "uname -m"),
    execSsh(client, "java -version"),
  ]);
  return normalizeRemotePlatform(
    system.stdout,
    architecture.stdout,
    java.stderr || java.stdout,
  );
}

function assertPlatformUnchanged(
  preview: RemoteDeploymentPreview,
  current: RemotePlatform,
): void {
  if (
    preview.platform !== current.platform ||
    preview.architecture !== current.architecture ||
    preview.javaVersion !== current.javaVersion
  ) {
    throw new Error("远程运行时身份在预览后发生变化，已拒绝部署");
  }
}

async function execSsh(
  client: Client,
  command: string,
  timeoutMillis = REMOTE_COMMAND_TIMEOUT_MILLIS,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const stdout = new LimitedBuffer(OUTPUT_LIMIT_BYTES);
    const stderr = new LimitedBuffer(OUTPUT_LIMIT_BYTES);
    let activeStream: { destroy(error?: Error): void } | null = null;
    let settled = false;
    const finish = (
      error: Error | null,
      result?: CommandResult,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      const timeoutError = new Error(
        `SSH 命令执行超时（${timeoutMillis} ms）`,
      );
      activeStream?.destroy(timeoutError);
      finish(timeoutError);
    }, timeoutMillis);
    client.exec(command, (error, stream) => {
      if (error) {
        finish(error);
        return;
      }
      activeStream = stream;
      stream.on("data", (chunk: Buffer) => {
        try {
          stdout.append(chunk);
        } catch (outputError) {
          stream.destroy();
          finish(
            outputError instanceof Error
              ? outputError
              : new Error("SSH 标准输出读取失败"),
          );
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        try {
          stderr.append(chunk);
        } catch (outputError) {
          stream.destroy();
          finish(
            outputError instanceof Error
              ? outputError
              : new Error("SSH 标准错误读取失败"),
          );
        }
      });
      stream.once("error", (streamError: Error) => finish(streamError));
      stream.once("close", (code: number | undefined) => {
        const result = {
          stdout: stdout.value().toString("utf8"),
          stderr: stderr.value().toString("utf8"),
        };
        if (code === 0) {
          finish(null, result);
        } else {
          finish(
            new Error(
              `SSH 命令退出码 ${String(code)}：${result.stderr.trim() || result.stdout.trim()}`,
            ),
          );
        }
      });
    });
  });
}

async function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
      } else {
        resolve(sftp);
      }
    });
  });
}

async function sftpFastPut(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function sftpWriteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  data: string,
  mode: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.writeFile(remotePath, data, { mode }, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function verifySshFile(
  client: Client,
  remotePath: string,
  expectedHash: string,
): Promise<void> {
  const result = await execSsh(
    client,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${quotePosixShell(remotePath)}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- ${quotePosixShell(remotePath)}; else echo 'SHA-256 tool unavailable' >&2; exit 127; fi`,
  );
  if (result.stdout.trim().split(/\s+/u)[0] !== expectedHash) {
    throw new Error(`远程文件 ${remotePath} SHA-256 校验失败`);
  }
}

function relayDescriptor(
  relayPort: number,
  upstreamPort: number,
  relaySecret: string,
  upstreamSecret: string,
): string {
  return [
    `listen.port=${relayPort}`,
    `upstream.port=${upstreamPort}`,
    `session.secret=${relaySecret}`,
    `upstream.secret=${upstreamSecret}`,
    "",
  ].join("\n");
}

async function waitForSshRelay(
  client: Client,
  logPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await execSsh(
      client,
      `test -f ${quotePosixShell(logPath)} && tail -n 20 -- ${quotePosixShell(logPath)} || true`,
    );
    if (result.stdout.includes("TANWEI_RELAY_READY")) {
      return;
    }
    if (/(Exception|Error|failed)/iu.test(result.stdout)) {
      throw new Error(`Relay 启动失败：${result.stdout.trim()}`);
    }
    await delay(250);
  }
  throw new Error("等待远程 Relay 就绪超时");
}

async function startSshForwarding(
  client: Client,
  relayPort: number,
): Promise<ForwardingServer> {
  return startLoopbackServer((socket) => {
    client.forwardOut(
      "127.0.0.1",
      socket.localPort ?? 0,
      "127.0.0.1",
      relayPort,
      (error, stream) => {
        if (error) {
          socket.destroy(error);
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.once("error", (streamError: Error) =>
          socket.destroy(streamError),
        );
      },
    );
  });
}

async function cleanupSshDeployment(
  client: Client,
  remoteDirectory: string,
  relayProcessId: number | null,
): Promise<void> {
  if (!isSafeRemoteDirectory(remoteDirectory)) {
    return;
  }
  const kill =
    relayProcessId && Number.isSafeInteger(relayProcessId)
      ? `kill ${relayProcessId} >/dev/null 2>&1 || true; `
      : "";
  await execSsh(
    client,
    `${kill}rm -rf -- ${quotePosixShell(remoteDirectory)}`,
  ).catch(() => undefined);
}

function loadKubeConfig(context?: string): KubeConfig {
  const config = new KubeConfig();
  config.loadFromDefault();
  if (context) {
    if (!config.getContexts().some((candidate) => candidate.name === context)) {
      throw new Error(`Kubernetes Context ${context} 不存在`);
    }
    config.setCurrentContext(context);
  }
  if (!config.getCurrentContext()) {
    throw new Error("未配置 Kubernetes 当前 Context");
  }
  return config;
}

function contextDescriptor(
  context: Context,
  currentContext: string,
): KubernetesContextDescriptor {
  return {
    name: context.name,
    cluster: context.cluster,
    user: context.user,
    current: context.name === currentContext,
  };
}

async function requirePodContainer(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
): Promise<void> {
  const pod = await config
    .makeApiClient(CoreV1Api)
    .readNamespacedPod({ name: input.pod, namespace: input.namespace });
  if (pod.status?.phase !== "Running") {
    throw new Error(`Pod 当前状态为 ${pod.status?.phase ?? "Unknown"}，必须为 Running`);
  }
  if (
    !pod.spec?.containers.some(
      (container) => container.name === input.container,
    )
  ) {
    throw new Error(`Pod 中不存在容器 ${input.container}`);
  }
}

async function probeKubernetesPlatform(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
): Promise<RemotePlatform> {
  const [system, architecture, java] = await Promise.all([
    execKubernetes(config, input, ["uname", "-s"]),
    execKubernetes(config, input, ["uname", "-m"]),
    execKubernetes(config, input, ["java", "-version"]),
  ]);
  return normalizeRemotePlatform(
    system.stdout,
    architecture.stdout,
    java.stderr || java.stdout,
  );
}

async function execKubernetes(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  command: readonly string[],
  stdin: Readable | null = null,
  timeoutMillis = REMOTE_COMMAND_TIMEOUT_MILLIS,
): Promise<CommandResult> {
  const stdout = new LimitedWritable();
  const stderr = new LimitedWritable();
  const executor = new Exec(config);
  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let socket: Awaited<ReturnType<Exec["exec"]>> | null = null;
    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve({
          stdout: stdout.value(),
          stderr: stderr.value(),
        });
      }
    };
    const timer = setTimeout(() => {
      socket?.close();
      finish(new Error(`Kubernetes Exec 超时（${timeoutMillis} ms）`));
    }, timeoutMillis);
    const statusCallback = (status: V1Status): void => {
      if (status.status === "Success") {
        finish(null);
      } else {
        finish(
          new Error(
            status.message ||
              stderr.value().trim() ||
              `Kubernetes Exec 状态 ${status.status ?? "Unknown"}`,
          ),
        );
      }
    };
    void executor
      .exec(
        input.namespace,
        input.pod,
        input.container,
        [...command],
        stdout,
        stderr,
        stdin,
        false,
        statusCallback,
      )
      .then((webSocket) => {
        socket = webSocket;
        webSocket.once("error", (event) => {
          finish(new Error(`Kubernetes Exec WebSocket 失败：${String(event)}`));
        });
      })
      .catch((error: unknown) => {
        finish(
          error instanceof Error
            ? error
            : new Error("Kubernetes Exec 建立失败"),
        );
      });
  });
}

class LimitedWritable extends Writable {
  readonly #buffer = new LimitedBuffer(OUTPUT_LIMIT_BYTES);

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const next = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, encoding);
      this.#buffer.append(next);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error("远程输出读取失败"));
    }
  }

  value(): string {
    return this.#buffer.value().toString("utf8");
  }
}

async function uploadKubernetesFile(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await execKubernetes(
    config,
    input,
    [
      "/bin/sh",
      "-c",
      `umask 077; cat > ${quotePosixShell(remotePath)}`,
    ],
    createReadStream(localPath),
    DEPLOYMENT_TIMEOUT_MILLIS,
  );
}

async function writeKubernetesFile(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  remotePath: string,
  content: string,
): Promise<void> {
  await execKubernetes(
    config,
    input,
    [
      "/bin/sh",
      "-c",
      `umask 077; cat > ${quotePosixShell(remotePath)}`,
    ],
    Readable.from([content]),
  );
}

async function verifyKubernetesFile(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  remotePath: string,
  expectedHash: string,
): Promise<void> {
  const result = await execKubernetes(config, input, [
    "/bin/sh",
    "-c",
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${quotePosixShell(remotePath)}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- ${quotePosixShell(remotePath)}; else echo 'SHA-256 tool unavailable' >&2; exit 127; fi`,
  ]);
  if (result.stdout.trim().split(/\s+/u)[0] !== expectedHash) {
    throw new Error(`Pod 文件 ${remotePath} SHA-256 校验失败`);
  }
}

async function waitForKubernetesRelay(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  logPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await execKubernetes(config, input, [
      "/bin/sh",
      "-c",
      `test -f ${quotePosixShell(logPath)} && tail -n 20 -- ${quotePosixShell(logPath)} || true`,
    ]);
    if (result.stdout.includes("TANWEI_RELAY_READY")) {
      return;
    }
    if (/(Exception|Error|failed)/iu.test(result.stdout)) {
      throw new Error(`Relay 启动失败：${result.stdout.trim()}`);
    }
    await delay(250);
  }
  throw new Error("等待 Pod Relay 就绪超时");
}

async function startKubernetesForwarding(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  relayPort: number,
): Promise<ForwardingServer> {
  const portForward = new PortForward(config);
  return startLoopbackServer((socket) => {
    void portForward
      .portForward(
        input.namespace,
        input.pod,
        [relayPort],
        socket,
        null,
        socket,
      )
      .then((forward) => {
        const webSocket =
          typeof forward === "function" ? forward() : forward;
        socket.once("close", () => webSocket?.close());
      })
      .catch((error: unknown) => {
        socket.destroy(
          error instanceof Error
            ? error
            : new Error("Kubernetes 端口转发失败"),
        );
      });
  });
}

async function cleanupKubernetesDeployment(
  config: KubeConfig,
  input: KubernetesRemotePreviewInput,
  remoteDirectory: string,
  relayProcessId: number | null,
): Promise<void> {
  if (!isSafeRemoteDirectory(remoteDirectory)) {
    return;
  }
  const kill =
    relayProcessId && Number.isSafeInteger(relayProcessId)
      ? `kill ${relayProcessId} >/dev/null 2>&1 || true; `
      : "";
  await execKubernetes(config, input, [
    "/bin/sh",
    "-c",
    `${kill}rm -rf -- ${quotePosixShell(remoteDirectory)}`,
  ]).catch(() => undefined);
}

async function startLoopbackServer(
  onConnection: (socket: Socket) => void,
): Promise<ForwardingServer> {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {
    for (const socket of sockets) {
      socket.destroy();
    }
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法分配本机回环转发端口");
  }
  return { server, port: address.port, sockets };
}

async function closeForwarding(
  forwarding: ForwardingServer | null,
): Promise<void> {
  if (!forwarding) {
    return;
  }
  for (const socket of forwarding.sockets) {
    socket.destroy();
  }
  if (!forwarding.server.listening) {
    return;
  }
  await new Promise<void>((resolve) => forwarding.server.close(() => resolve()));
}

function remoteTarget(
  mode: "ssh" | "kubernetes",
  displayName: string,
  pid: number,
  identity: string,
  platform: RemotePlatform,
): TargetDescriptor {
  return {
    id: stableRemoteTargetId(mode, identity, pid),
    pid,
    displayName,
    mainClass: "Remote JVM",
    arguments: [],
    javaPath: null,
    javaVersion: platform.javaVersion,
    user: mode === "ssh" ? identity.split("@", 1)[0] ?? null : null,
    startTime: null,
    attachable: true,
    attachReason: null,
  };
}

function parseProcessId(value: string): number {
  const processId = Number.parseInt(value.trim(), 10);
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Relay 未返回有效进程标识");
  }
  return processId;
}

function formatFingerprint(fingerprint: string): string {
  return `SHA256:${fingerprint}`;
}

function validatePersistentCredentials(
  input: PersistentRelayPreviewInput,
): {
  readonly caFingerprint: string;
  readonly clientFingerprint: string;
} {
  const caCertificate = new X509Certificate(input.caCertificate);
  const clientCertificate = new X509Certificate(input.clientCertificate);
  const now = Date.now();
  const validFrom = Date.parse(clientCertificate.validFrom);
  const validTo = Date.parse(clientCertificate.validTo);
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    validFrom > now ||
    validTo <= now
  ) {
    throw new Error("客户端证书尚未生效或已经过期");
  }
  const privateKey = createPrivateKey(input.clientPrivateKey);
  const privatePublicKey = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const certificatePublicKey = clientCertificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  if (
    privatePublicKey.length !== certificatePublicKey.length ||
    !timingSafeEqual(privatePublicKey, certificatePublicKey)
  ) {
    throw new Error("客户端证书与私钥不匹配");
  }
  return {
    caFingerprint: caCertificate.fingerprint256,
    clientFingerprint: clientCertificate.fingerprint256,
  };
}

function randomRemotePort(): number {
  return randomInt(30_000, 60_001);
}

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

function oneShotCleanup(
  cleanup: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => (pending ??= cleanup());
}

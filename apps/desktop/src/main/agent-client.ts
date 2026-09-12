import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { promisify } from "node:util";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { z } from "zod";
import type {
  ActionResult,
  CapabilityDescriptor,
  ClassDetails,
  ClassPage,
  ObservationBatch,
  PageRequest,
  TargetConnection,
  TargetDescriptor,
  TargetSnapshot,
  ThreadPage,
  ThreadQuery,
} from "../shared/contracts.js";
import { resolveAttachHelperInvocation } from "./attach-helper-invocation.js";
import {
  resolveJavaExecutable,
  resolveJvmComponent,
} from "./component-resolver.js";
import {
  CURRENT_PROTOCOL_VERSION,
  protocolCompatibilityError,
} from "./protocol-compatibility.js";
import { HeartbeatMonitor } from "./heartbeat-monitor.js";
import {
  TargetSessionCancelledError,
  TargetSessionRegistry,
  type TargetSessionResource,
} from "./target-session.js";

const execFileAsync = promisify(execFile);
const HANDSHAKE_TIMEOUT_MILLIS = 5_000;
const ATTACH_TIMEOUT_MILLIS = 15_000;
const ARTIFACT_DOWNLOAD_TIMEOUT_MILLIS = 10 * 60_000;
const ACTION_TIMEOUT_MILLIS = 30_000;
const HIGH_IMPACT_ACTION_TIMEOUT_MILLIS = 10 * 60_000;
const HEARTBEAT_INTERVAL_MILLIS = 5_000;

const capabilityResponseSchema = z.object({
  protocolVersion: z.string(),
  agentVersion: z.string(),
  processId: z.number().int().positive(),
  javaVersion: z.string(),
  capabilities: z.array(
    z.object({
      id: z.string().min(1),
      state: z.enum(["AVAILABLE", "UNSUPPORTED", "RESTRICTED"]),
      reason: z.string(),
    }),
  ),
});

const snapshotResponseSchema = z.object({
  capturedAtEpochMillis: z.number().int().nonnegative(),
  uptimeMillis: z.number().int().nonnegative(),
  jvmStartTimeEpochMillis: z.number().int().nonnegative(),
  processCpuLoad: z.number(),
  hasProcessCpuLoad: z.boolean(),
  systemCpuLoad: z.number(),
  hasSystemCpuLoad: z.boolean(),
  heapUsedBytes: z.number().int().nonnegative(),
  heapMaxBytes: z.number().int().nonnegative(),
  nonHeapUsedBytes: z.number().int().nonnegative(),
  liveThreads: z.number().int().nonnegative(),
  peakThreads: z.number().int().nonnegative(),
  loadedClasses: z.number().int().nonnegative(),
  gcCount: z.number().int().nonnegative(),
  gcTimeMillis: z.number().int().nonnegative(),
});

const threadListResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  threads: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      state: z.string(),
      daemon: z.boolean(),
      priority: z.number().int(),
      cpuTimeNanos: z.number().int(),
      hasCpuTime: z.boolean(),
      deadlocked: z.boolean(),
      lockName: z.string(),
      lockOwnerId: z.number().int(),
      stack: z.array(z.string()),
    }),
  ),
});

const classListResponseSchema = z.object({
  totalMatches: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  classes: z.array(
    z.object({
      name: z.string(),
      classLoader: z.string(),
      module: z.string(),
      modifiable: z.boolean(),
    }),
  ),
});

const classDetailsResponseSchema = z.object({
  found: z.boolean(),
  errorCode: z.string(),
  name: z.string(),
  classLoader: z.string(),
  codeSource: z.string(),
  modifiers: z.string(),
  superClass: z.string(),
  interfaces: z.array(z.string()),
  annotations: z.array(z.string()),
  methods: z.array(
    z.object({
      name: z.string(),
      returnType: z.string(),
      parameterTypes: z.array(z.string()),
      exceptionTypes: z.array(z.string()),
      modifiers: z.string(),
      annotations: z.array(z.string()),
    }),
  ),
});

const actionResponseSchema = z.object({
  status: z.enum(["SUCCEEDED", "FAILED"]),
  errorCode: z.string(),
  message: z.string(),
  values: z.record(z.string(), z.string()),
});

const artifactChunkSchema = z.object({
  sequence: z.number().int().nonnegative(),
  data: z.instanceof(Buffer),
});

const remoteArtifactResponseSchema = z.object({
  deleted: z.boolean(),
});
const observationEventsResponseSchema = z.object({
  taskId: z.string().uuid(),
  state: z.enum([
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "UNKNOWN",
  ]),
  captured: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      parentSequence: z.number().int(),
      depth: z.number().int().nonnegative(),
      method: z.string(),
      phase: z.enum(["BEFORE", "RETURN", "THROW", "FINISH"]).default("FINISH"),
      eventId: z.number().int().nonnegative().optional(),
      capturedAtEpochMillis: z.number().int().nonnegative(),
      durationNanos: z.number().int().nonnegative(),
      threadName: z.string(),
      arguments: z.array(z.string()),
      callStack: z.array(z.string()),
      returnValue: z.string(),
      exceptionType: z.string(),
      exceptionMessage: z.string(),
    }),
  ),
});
const observationTaskResponseSchema = z.object({
  taskId: z.string().uuid(),
  state: observationEventsResponseSchema.shape.state,
});

export interface AgentArtifactChunk {
  readonly sequence: number;
  readonly data: Buffer;
}

interface DiagnosticClient {
  getCapabilities(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  getSnapshot(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  listThreads(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  listClasses(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  getClassDetails(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  executeAction(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  downloadArtifact(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): grpc.ClientReadableStream<unknown>;
  deleteArtifact(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  getObservationEvents(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  cancelObservation(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  shutdown(
    request: Readonly<Record<string, unknown>>,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ): grpc.ClientUnaryCall;
  close(): void;
}

interface DiagnosticClientConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ChannelOptions,
  ): DiagnosticClient;
}

interface ActiveAgent extends TargetSessionResource {
  readonly target: TargetDescriptor;
  readonly client: DiagnosticClient;
  readonly metadata: grpc.Metadata;
  readonly connection: TargetConnection;
  readonly shutdownOnDisconnect: boolean;
  readonly cleanup?: () => Promise<void>;
  startHeartbeat(): void;
  close(): Promise<void>;
}

export interface RemoteAgentEndpoint {
  readonly localPort: number;
  readonly secret: string;
  readonly cleanup: () => Promise<void>;
}

export interface PersistentAgentEndpoint {
  readonly host: string;
  readonly port: number;
  readonly serverName: string;
  readonly rootCertificates: Buffer;
  readonly clientPrivateKey: Buffer;
  readonly clientCertificate: Buffer;
  readonly secret: string;
}

interface DiagnosticPackage {
  readonly tanwei: {
    readonly protocol: {
      readonly v1: {
        readonly DiagnosticService: DiagnosticClientConstructor;
      };
    };
  };
}

export class AgentConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentConnectionError";
    this.code = code;
  }
}

export class AgentClientManager {
  readonly #sessions = new TargetSessionRegistry<ActiveAgent>();

  connection(targetId: string): TargetConnection | null {
    return this.#sessions.connection(targetId);
  }

  listConnections(): readonly TargetConnection[] {
    return this.#sessions.listConnections();
  }

  async connect(target: TargetDescriptor): Promise<TargetConnection> {
    const active = await this.#sessions.connect(target, (signal) =>
      this.#connectInternal(target, signal),
    );
    active.startHeartbeat();
    return this.#sessions.connection(target.id) ?? active.connection;
  }

  async connectRemote(
    target: TargetDescriptor,
    endpoint: RemoteAgentEndpoint,
  ): Promise<TargetConnection> {
    const active = await this.#sessions.connect(target, (signal) =>
      this.#activateEndpoint(
        target,
        endpoint.localPort,
        endpoint.secret,
        signal,
        endpoint.cleanup,
      ),
    );
    active.startHeartbeat();
    return this.#sessions.connection(target.id) ?? active.connection;
  }

  async connectPersistent(
    target: TargetDescriptor,
    endpoint: PersistentAgentEndpoint,
  ): Promise<TargetConnection> {
    const active = await this.#sessions.connect(target, (signal) =>
      this.#activatePersistentEndpoint(target, endpoint, signal),
    );
    active.startHeartbeat();
    return this.#sessions.connection(target.id) ?? active.connection;
  }

  async disconnect(targetId: string): Promise<void> {
    await this.#sessions.disconnect(targetId);
  }

  async getSnapshot(targetId: string): Promise<TargetSnapshot> {
    const active = this.#requireActive(targetId);
    const rawSnapshot = await unaryCall(
      active.client,
      "getSnapshot",
      requestContext(),
      active.metadata,
    );
    const snapshot = snapshotResponseSchema.parse(rawSnapshot);
    return {
      targetId,
      capturedAt: new Date(snapshot.capturedAtEpochMillis).toISOString(),
      uptimeMillis: snapshot.uptimeMillis,
      jvmStartTimeEpochMillis: snapshot.jvmStartTimeEpochMillis,
      processCpuLoad: snapshot.hasProcessCpuLoad
        ? snapshot.processCpuLoad
        : null,
      systemCpuLoad: snapshot.hasSystemCpuLoad ? snapshot.systemCpuLoad : null,
      heapUsedBytes: snapshot.heapUsedBytes,
      heapMaxBytes: snapshot.heapMaxBytes,
      nonHeapUsedBytes: snapshot.nonHeapUsedBytes,
      liveThreads: snapshot.liveThreads,
      peakThreads: snapshot.peakThreads,
      loadedClasses: snapshot.loadedClasses,
      gcCount: snapshot.gcCount,
      gcTimeMillis: snapshot.gcTimeMillis,
    };
  }

  async listThreads(targetId: string, query: ThreadQuery): Promise<ThreadPage> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "listThreads",
      {
        ...requestContext(),
        offset: query.offset,
        limit: query.limit,
        stackDepth: query.stackDepth,
        nameQuery: query.query,
        stateFilter: query.state,
      },
      active.metadata,
    );
    const response = threadListResponseSchema.parse(raw);
    return {
      total: response.total,
      offset: response.offset,
      items: response.threads.map((thread) => ({
        id: thread.id,
        name: thread.name,
        state: thread.state,
        daemon: thread.daemon,
        priority: thread.priority,
        cpuTimeNanos: thread.hasCpuTime ? thread.cpuTimeNanos : null,
        deadlocked: thread.deadlocked,
        lockName: thread.lockName || null,
        lockOwnerId: thread.lockOwnerId >= 0 ? thread.lockOwnerId : null,
        stack: thread.stack,
      })),
    };
  }

  async listClasses(targetId: string, query: PageRequest): Promise<ClassPage> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "listClasses",
      {
        ...requestContext(),
        offset: query.offset,
        limit: query.limit,
        nameQuery: query.query,
      },
      active.metadata,
    );
    const response = classListResponseSchema.parse(raw);
    return {
      total: response.totalMatches,
      offset: response.offset,
      items: response.classes.map((item) => ({
        name: item.name,
        classLoader: item.classLoader,
        module: item.module || null,
        modifiable: item.modifiable,
      })),
    };
  }

  async getClassDetails(
    targetId: string,
    name: string,
    classLoader: string,
  ): Promise<ClassDetails> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "getClassDetails",
      {
        ...requestContext(),
        name,
        classLoader,
      },
      active.metadata,
    );
    const response = classDetailsResponseSchema.parse(raw);
    if (!response.found) {
      throw new AgentConnectionError(
        response.errorCode || "CLASS_NOT_FOUND",
        "目标类已卸载或类加载器身份发生变化",
      );
    }
    return {
      name: response.name,
      classLoader: response.classLoader,
      codeSource: response.codeSource || null,
      modifiers: response.modifiers,
      superClass: response.superClass || null,
      interfaces: response.interfaces,
      annotations: response.annotations,
      methods: response.methods,
    };
  }

  async executeAction(
    targetId: string,
    actionId: string,
    parameters: Readonly<Record<string, string>>,
    riskLevel: ActionResult["riskLevel"],
  ): Promise<ActionResult> {
    const active = this.#requireActive(targetId);
    const taskId = randomUUID();
    const raw = await unaryCall(
      active.client,
      "executeAction",
      {
        ...requestContext(taskId),
        actionId,
        parameters,
      },
      active.metadata,
      riskLevel === "R0" || riskLevel === "R1"
        ? ACTION_TIMEOUT_MILLIS
        : HIGH_IMPACT_ACTION_TIMEOUT_MILLIS,
    );
    const response = actionResponseSchema.parse(raw);
    return {
      actionId,
      taskId,
      targetId,
      riskLevel,
      status: response.status,
      errorCode: response.errorCode || null,
      message: response.message || null,
      values: response.values,
      completedAt: new Date().toISOString(),
    };
  }

  async *downloadArtifact(
    targetId: string,
    token: string,
  ): AsyncGenerator<AgentArtifactChunk> {
    const active = this.#requireActive(targetId);
    const stream = active.client.downloadArtifact(
      {
        ...requestContext(),
        token,
      },
      active.metadata,
      { deadline: Date.now() + ARTIFACT_DOWNLOAD_TIMEOUT_MILLIS },
    );
    try {
      for await (const rawChunk of stream) {
        const chunk = artifactChunkSchema.parse(rawChunk);
        yield {
          sequence: chunk.sequence,
          data: chunk.data,
        };
      }
    } catch (error) {
      throw new AgentConnectionError(
        "ARTIFACT_DOWNLOAD_FAILED",
        error instanceof Error ? error.message : "无法从 Agent 下载制品",
        { cause: error },
      );
    }
  }

  async deleteRemoteArtifact(
    targetId: string,
    token: string,
  ): Promise<boolean> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "deleteArtifact",
      {
        ...requestContext(),
        token,
      },
      active.metadata,
    );
    return remoteArtifactResponseSchema.parse(raw).deleted;
  }

  async getObservationEvents(
    targetId: string,
    taskId: string,
  ): Promise<ObservationBatch> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "getObservationEvents",
      {
        ...requestContext(taskId),
        taskId,
        limit: 100,
      },
      active.metadata,
    );
    const response = observationEventsResponseSchema.parse(raw);
    return {
      taskId: response.taskId,
      state: response.state,
      captured: response.captured,
      dropped: response.dropped,
      events: response.events.map((event) => ({
        eventId: event.eventId ?? event.sequence,
        sequence: event.sequence,
        parentSequence:
          event.parentSequence < 0 ? null : event.parentSequence,
        depth: event.depth,
        method: event.method,
        phase: event.phase,
        capturedAt: new Date(
          event.capturedAtEpochMillis,
        ).toISOString(),
        durationNanos: event.durationNanos,
        threadName: event.threadName,
        arguments: event.arguments,
        callStack: event.callStack,
        returnValue: event.returnValue || null,
        exceptionType: event.exceptionType || null,
        exceptionMessage: event.exceptionMessage || null,
      })),
    };
  }

  async cancelObservation(
    targetId: string,
    taskId: string,
  ): Promise<ObservationBatch["state"]> {
    const active = this.#requireActive(targetId);
    const raw = await unaryCall(
      active.client,
      "cancelObservation",
      {
        ...requestContext(taskId),
        taskId,
      },
      active.metadata,
    );
    return observationTaskResponseSchema.parse(raw).state;
  }

  async closeAll(): Promise<void> {
    await this.#sessions.closeAll();
  }

  async #connectInternal(
    target: TargetDescriptor,
    signal: AbortSignal,
  ): Promise<ActiveAgent> {
    throwIfAborted(signal);
    const [helperJar, bootstrapJar, agentJar, port] = await Promise.all([
      resolveJvmComponent("attach-helper"),
      resolveJvmComponent("bootstrap"),
      resolveJvmComponent("agent"),
      reserveLoopbackPort(),
    ]);
    throwIfAborted(signal);
    const secret = randomBytes(32).toString("hex");
    const helperInvocation = await resolveAttachHelperInvocation(
      resolveJavaExecutable(),
      target.javaPath,
      helperJar,
    );

    try {
      await execFileAsync(
        helperInvocation.executable,
        [
          ...helperInvocation.prefixArguments,
          "attach",
          "--pid",
          String(target.pid),
          "--bootstrap",
          bootstrapJar,
          "--agent",
          agentJar,
          "--port",
          String(port),
          "--secret",
          secret,
        ],
        {
          timeout: ATTACH_TIMEOUT_MILLIS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          signal,
        },
      );
    } catch (error) {
      throw new AgentConnectionError(
        "ATTACH_FAILED",
        error instanceof Error ? error.message : "Attach Helper 执行失败",
        { cause: error },
      );
    }

    throwIfAborted(signal);
    return this.#activateEndpoint(target, port, secret, signal);
  }

  async #activateEndpoint(
    target: TargetDescriptor,
    port: number,
    secret: string,
    signal: AbortSignal,
    cleanup?: () => Promise<void>,
  ): Promise<ActiveAgent> {
    throwIfAborted(signal);
    const protocolPath = await resolveJvmComponent("protocol");
    throwIfAborted(signal);
    const client = createClient(
      protocolPath,
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    );
    return this.#activateClient(
      target,
      client,
      secret,
      true,
      signal,
      cleanup,
    );
  }

  async #activatePersistentEndpoint(
    target: TargetDescriptor,
    endpoint: PersistentAgentEndpoint,
    signal: AbortSignal,
  ): Promise<ActiveAgent> {
    throwIfAborted(signal);
    const protocolPath = await resolveJvmComponent("protocol");
    throwIfAborted(signal);
    const credentials = grpc.credentials.createSsl(
      endpoint.rootCertificates,
      endpoint.clientPrivateKey,
      endpoint.clientCertificate,
    );
    const client = createClient(
      protocolPath,
      `${endpoint.host}:${endpoint.port}`,
      credentials,
      {
        "grpc.ssl_target_name_override": endpoint.serverName,
        "grpc.default_authority": endpoint.serverName,
      },
    );
    return this.#activateClient(
      target,
      client,
      endpoint.secret,
      false,
      signal,
    );
  }

  async #activateClient(
    target: TargetDescriptor,
    client: DiagnosticClient,
    secret: string,
    shutdownOnDisconnect: boolean,
    signal: AbortSignal,
    cleanup?: () => Promise<void>,
  ): Promise<ActiveAgent> {
    const metadata = new grpc.Metadata();
    metadata.set("x-tanwei-secret", secret);
    try {
      const rawCapabilities = await unaryCall(
        client,
        "getCapabilities",
        {
          ...requestContext(),
          clientProtocolVersion: CURRENT_PROTOCOL_VERSION,
        },
        metadata,
        HANDSHAKE_TIMEOUT_MILLIS,
        signal,
      );
      const capabilities = capabilityResponseSchema.parse(rawCapabilities);
      throwIfAborted(signal);
      const protocolError = protocolCompatibilityError(
        CURRENT_PROTOCOL_VERSION,
        capabilities.protocolVersion,
      );
      if (protocolError) {
        throw new AgentConnectionError(
          protocolError,
          "Host 协议 " +
            CURRENT_PROTOCOL_VERSION +
            " 与 Agent 协议 " +
            capabilities.protocolVersion +
            " 不兼容",
        );
      }
      if (capabilities.processId !== target.pid) {
        throw new AgentConnectionError(
          "TARGET_IDENTITY_MISMATCH",
          `Agent 返回 PID ${capabilities.processId}，预期 ${target.pid}`,
        );
      }
      const connection: TargetConnection = {
        target,
        state: "READY",
        protocolVersion: capabilities.protocolVersion,
        agentVersion: capabilities.agentVersion,
        javaVersion: capabilities.javaVersion,
        capabilities: capabilities.capabilities.map(
          (capability): CapabilityDescriptor => ({
            id: capability.id,
            state: capability.state,
            reason: capability.reason || null,
          }),
        ),
        connectedAt: new Date().toISOString(),
        errorCode: null,
        errorMessage: null,
      };
      let closed = false;
      let active: ActiveAgent | null = null;
      const heartbeat = new HeartbeatMonitor({
        intervalMillis: HEARTBEAT_INTERVAL_MILLIS,
        probe: async (heartbeatSignal) => {
          const rawHeartbeat = await unaryCall(
            client,
            "getCapabilities",
            {
              ...requestContext(),
              clientProtocolVersion: CURRENT_PROTOCOL_VERSION,
            },
            metadata,
            HANDSHAKE_TIMEOUT_MILLIS,
            heartbeatSignal,
          );
          const heartbeatCapabilities =
            capabilityResponseSchema.parse(rawHeartbeat);
          const heartbeatProtocolError = protocolCompatibilityError(
            CURRENT_PROTOCOL_VERSION,
            heartbeatCapabilities.protocolVersion,
          );
          if (heartbeatProtocolError) {
            throw new AgentConnectionError(
              heartbeatProtocolError,
              "Heartbeat 返回了不兼容的 Agent 协议",
            );
          }
          if (heartbeatCapabilities.processId !== target.pid) {
            throw new AgentConnectionError(
              "TARGET_IDENTITY_MISMATCH",
              "Heartbeat 返回了不匹配的目标进程",
            );
          }
        },
        onStateChange: (state, error) => {
          if (!active) {
            return;
          }
          const nextConnection: TargetConnection = {
            ...connection,
            state,
            errorCode:
              state === "READY" ? null : "AGENT_HEARTBEAT_FAILED",
            errorMessage:
              state === "READY"
                ? null
                : error instanceof Error
                  ? error.message
                  : "Agent 心跳失败",
          };
          if (state === "DISCONNECTED") {
            void this.#sessions
              .deactivateResource(target.id, active, nextConnection)
              .catch(() => undefined);
            return;
          }
          this.#sessions.updateConnection(
            target.id,
            active,
            nextConnection,
          );
        },
      });
      active = {
        target,
        client,
        metadata,
        connection,
        shutdownOnDisconnect,
        ...(cleanup ? { cleanup } : {}),
        startHeartbeat: () => {
          if (!closed) {
            heartbeat.start();
          }
        },
        close: async () => {
          if (closed) {
            return;
          }
          closed = true;
          heartbeat.stop();
          if (shutdownOnDisconnect) {
            try {
              await unaryCall(
                client,
                "shutdown",
                requestContext(),
                metadata,
              );
            } catch {
              // Target may already be exiting; channel closure is still deterministic.
            }
          }
          client.close();
          await cleanup?.();
        },
      };
      return active;
    } catch (error) {
      client.close();
      await cleanup?.().catch(() => undefined);
      if (
        error instanceof AgentConnectionError ||
        error instanceof TargetSessionCancelledError
      ) {
        throw error;
      }
      throw new AgentConnectionError(
        "HANDSHAKE_FAILED",
        error instanceof Error ? error.message : "Agent 握手失败",
        { cause: error },
      );
    }
  }

  #requireActive(targetId: string): ActiveAgent {
    const active = this.#sessions.resource(targetId);
    if (!active) {
      throw new AgentConnectionError(
        "TARGET_NOT_CONNECTED",
        "请先连接目标 JVM，再执行诊断操作",
      );
    }
    const connection = this.#sessions.connection(targetId);
    if (connection?.state !== "READY") {
      throw new AgentConnectionError(
        "TARGET_NOT_READY",
        "目标 JVM 连接暂时不可用，请等待心跳恢复或重新连接",
      );
    }
    return active;
  }
}

function createClient(
  protocolPath: string,
  address: string,
  credentials: grpc.ChannelCredentials,
  options: grpc.ChannelOptions = {},
): DiagnosticClient {
  const definition = loadSync(protocolPath, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as DiagnosticPackage;
  return new loaded.tanwei.protocol.v1.DiagnosticService(
    address,
    credentials,
    options,
  );
}

function requestContext(
  taskId: string = randomUUID(),
): Readonly<Record<string, unknown>> {
  return {
    context: {
      requestId: randomUUID(),
      taskId,
      timestampEpochMillis: Date.now(),
    },
  };
}

function unaryCall(
  client: DiagnosticClient,
  method:
    | "getCapabilities"
    | "getSnapshot"
    | "listThreads"
    | "listClasses"
    | "getClassDetails"
    | "executeAction"
    | "deleteArtifact"
    | "getObservationEvents"
    | "cancelObservation"
    | "shutdown",
  request: Readonly<Record<string, unknown>>,
  metadata: grpc.Metadata,
  timeoutMillis = HANDSHAKE_TIMEOUT_MILLIS,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TargetSessionCancelledError());
      return;
    }
    let call: grpc.ClientUnaryCall | null = null;
    const abort = (): void => {
      call?.cancel();
      reject(new TargetSessionCancelledError());
    };
    call = client[method](
      request,
      metadata,
      { deadline: Date.now() + timeoutMillis },
      (error, response) => {
        signal?.removeEventListener("abort", abort);
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      },
    );
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TargetSessionCancelledError();
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配回环端口"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

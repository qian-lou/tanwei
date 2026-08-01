import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ActionRequest,
  ActionResult,
  ClassDetails,
  ClassPage,
  ExitImpactSummary,
  ObservationBatch,
  OperationResult,
  PageRequest,
  RiskLevel,
  TargetConnection,
  TargetDescriptor,
  TargetSnapshot,
  ThreadPage,
  ThreadQuery,
} from "../shared/contracts.js";
import {
  exitImpactTargetFromAction,
  summarizeExitImpact,
} from "./exit-impact.js";
import {
  AgentClientManager,
  AgentConnectionError,
  type PersistentAgentEndpoint,
} from "./agent-client.js";
import {
  resolveJavaExecutable,
  resolveJvmComponent,
} from "./component-resolver.js";
import {
  authorizeAction,
  enforceTeamPolicy,
  PolicyError,
} from "./policy-engine.js";
import type { LocalStore } from "./local-store.js";

const execFileAsync = promisify(execFile);
const TARGET_ID_PATTERN = /^local:(\d+)$/;
const targetSchema = z.object({
  id: z.string(),
  pid: z.number().int().positive(),
  displayName: z.string(),
  mainClass: z.string(),
  arguments: z.array(z.string()),
  javaPath: z.string().nullable(),
  javaVersion: z.string().nullable(),
  user: z.string().nullable(),
  startTime: z.string().datetime().nullable(),
  attachable: z.boolean(),
  attachReason: z.string().nullable(),
});

const targetListSchema = z.array(targetSchema);

function success<T>(value: T): OperationResult<T> {
  return {
    ok: true,
    value,
    errorCode: null,
    errorMessage: null,
  };
}

function failure<T>(errorCode: string, errorMessage: string): OperationResult<T> {
  return {
    ok: false,
    value: null,
    errorCode,
    errorMessage,
  };
}

export class TargetService {
  readonly #agentClients = new AgentClientManager();
  #localStore: LocalStore | null = null;

  setLocalStore(store: LocalStore | null): void {
    this.#localStore = store;
  }

  connection(targetId: string): TargetConnection | null {
    return this.#agentClients.connection(targetId);
  }

  listConnections(): readonly TargetConnection[] {
    return this.#agentClients.listConnections();
  }

  async listTargets(): Promise<OperationResult<readonly TargetDescriptor[]>> {
    try {
      const helperJar = await resolveJvmComponent("attach-helper");
      const { stdout } = await execFileAsync(
        resolveJavaExecutable(),
        ["-jar", helperJar, "list", "--json"],
        {
          timeout: 10_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      const targets = targetListSchema.parse(JSON.parse(stdout));
      return success(targets);
    } catch (error) {
      return failure(
        "TARGET_DISCOVERY_FAILED",
        error instanceof Error ? error.message : "无法发现本机 Java 进程",
      );
    }
  }

  async connectTarget(
    targetId: string,
  ): Promise<OperationResult<TargetConnection>> {
    const pid = this.#parseTargetId(targetId);

    if (pid === null) {
      return failure("INVALID_TARGET", "目标标识无效");
    }

    const existing = this.connection(targetId);
    if (existing?.state === "READY") {
      return success(existing);
    }

    const targetsResult = await this.listTargets();
    const target = targetsResult.value?.find((item) => item.id === targetId);

    if (!target) {
      return failure("TARGET_NOT_FOUND", `Java 进程 ${pid} 已退出或不可见`);
    }

    if (!target.attachable) {
      return failure(
        "TARGET_NOT_ATTACHABLE",
        target.attachReason ?? "当前进程不可 Attach",
      );
    }

    try {
      const ready = await this.#agentClients.connect(target);
      return success(ready);
    } catch (error) {
      const errorCode =
        error instanceof AgentConnectionError ? error.code : "CONNECTION_FAILED";
      const errorMessage =
        error instanceof Error ? error.message : "目标 JVM 连接失败";
      return failure(errorCode, errorMessage);
    }
  }

  async disconnectTarget(targetId: string): Promise<OperationResult<null>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }

    try {
      await this.#agentClients.disconnect(targetId);
      return success(null);
    } catch (error) {
      return failure(
        "DISCONNECT_FAILED",
        error instanceof Error ? error.message : "断开目标失败",
      );
    }
  }

  async getSnapshot(
    targetId: string,
  ): Promise<OperationResult<TargetSnapshot>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }

    try {
      return success(await this.#agentClients.getSnapshot(targetId));
    } catch (error) {
      return failure(
        error instanceof AgentConnectionError
          ? error.code
          : "SNAPSHOT_FAILED",
        error instanceof Error ? error.message : "无法读取运行状态",
      );
    }
  }

  async listThreads(
    targetId: string,
    query: ThreadQuery,
  ): Promise<OperationResult<ThreadPage>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      return success(await this.#agentClients.listThreads(targetId, query));
    } catch (error) {
      return this.#diagnosticFailure(error, "THREAD_LIST_FAILED", "无法读取线程列表");
    }
  }

  async listClasses(
    targetId: string,
    query: PageRequest,
  ): Promise<OperationResult<ClassPage>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      return success(await this.#agentClients.listClasses(targetId, query));
    } catch (error) {
      return this.#diagnosticFailure(error, "CLASS_LIST_FAILED", "无法读取类列表");
    }
  }

  async getClassDetails(
    targetId: string,
    name: string,
    classLoader: string,
  ): Promise<OperationResult<ClassDetails>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      return success(
        await this.#agentClients.getClassDetails(
          targetId,
          name,
          classLoader,
        ),
      );
    } catch (error) {
      return this.#diagnosticFailure(
        error,
        "CLASS_DETAILS_FAILED",
        "无法读取类详情",
      );
    }
  }

  async executeAction(
    request: ActionRequest,
  ): Promise<OperationResult<ActionResult>> {
    if (!this.#isKnownTargetId(request.targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      const localMaximum =
        this.#localStore?.getSettings().maximumRiskLevel ?? "R2";
      const teamPolicy = this.#localStore?.getActiveTeamPolicy() ?? null;
      const maximumRiskLevel: RiskLevel = enforceTeamPolicy(
        request.actionId,
        localMaximum,
        teamPolicy,
      );
      const action = authorizeAction(
        this.connection(request.targetId),
        request.actionId,
        request.parameters,
        maximumRiskLevel,
        request.contractVersion,
      );
      const result = await this.#agentClients.executeAction(
        request.targetId,
        action.actionId,
        action.parameters,
        action.riskLevel,
      );
      if (!action.actionId.endsWith(".status")) {
        this.#localStore?.insertActionAudit(result);
      }
      return success(result);
    } catch (error) {
      if (error instanceof PolicyError) {
        return failure(error.code, error.message);
      }
      return this.#diagnosticFailure(error, "ACTION_FAILED", "诊断操作执行失败");
    }
  }

  downloadArtifact(
    targetId: string,
    token: string,
  ): ReturnType<AgentClientManager["downloadArtifact"]> {
    if (!this.#isKnownTargetId(targetId)) {
      throw new AgentConnectionError("INVALID_TARGET", "目标标识无效");
    }
    return this.#agentClients.downloadArtifact(targetId, token);
  }

  async deleteRemoteArtifact(
    targetId: string,
    token: string,
  ): Promise<void> {
    if (!this.#isKnownTargetId(targetId)) {
      throw new AgentConnectionError("INVALID_TARGET", "目标标识无效");
    }
    await this.#agentClients.deleteRemoteArtifact(targetId, token);
  }

  async getObservationEvents(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ObservationBatch>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      return success(
        await this.#agentClients.getObservationEvents(targetId, taskId),
      );
    } catch (error) {
      return this.#diagnosticFailure(
        error,
        "OBSERVATION_EVENTS_FAILED",
        "无法读取方法观测事件",
      );
    }
  }

  async cancelObservation(
    targetId: string,
    taskId: string,
  ): Promise<OperationResult<ObservationBatch["state"]>> {
    if (!this.#isKnownTargetId(targetId)) {
      return failure("INVALID_TARGET", "目标标识无效");
    }
    try {
      return success(
        await this.#agentClients.cancelObservation(targetId, taskId),
      );
    } catch (error) {
      return this.#diagnosticFailure(
        error,
        "OBSERVATION_CANCEL_FAILED",
        "无法取消方法观测任务",
      );
    }
  }

  async inspectExitImpact(): Promise<OperationResult<ExitImpactSummary>> {
    const connections = this.listConnections().filter(
      (connection) =>
        connection.state !== "DISCONNECTED" &&
        connection.state !== "CLOSING",
    );
    const targets = await Promise.all(
      connections.map(async (connection) => {
        const result = await this.executeAction({
          targetId: connection.target.id,
          actionId: "session.reset.preview",
          parameters: {},
        });
        return exitImpactTargetFromAction(connection, result);
      }),
    );
    return success(summarizeExitImpact(targets));
  }

  async closeAll(): Promise<void> {
    await this.#agentClients.closeAll();
  }

  async connectRemoteTarget(
    target: TargetDescriptor,
    endpoint: {
      readonly localPort: number;
      readonly secret: string;
      readonly cleanup: () => Promise<void>;
    },
  ): Promise<OperationResult<TargetConnection>> {
    if (
      !/^remote:(?:ssh|kubernetes):[a-zA-Z0-9._:-]{1,512}$/u.test(
        target.id,
      )
    ) {
      return failure("INVALID_REMOTE_TARGET", "远程目标标识无效");
    }
    try {
      const ready = await this.#agentClients.connectRemote(target, endpoint);
      return success(ready);
    } catch (error) {
      await this.#agentClients.disconnect(target.id).catch(() => undefined);
      return failure(
        error instanceof AgentConnectionError
          ? error.code
          : "REMOTE_CONNECTION_FAILED",
        error instanceof Error ? error.message : "远程目标连接失败",
      );
    }
  }

  async connectPersistentTarget(
    target: TargetDescriptor,
    endpoint: PersistentAgentEndpoint,
  ): Promise<OperationResult<TargetConnection>> {
    if (!/^remote:persistent:[a-f0-9]{24}$/u.test(target.id)) {
      return failure("INVALID_REMOTE_TARGET", "持久 Relay 目标标识无效");
    }
    try {
      const ready = await this.#agentClients.connectPersistent(
        target,
        endpoint,
      );
      return success(ready);
    } catch (error) {
      await this.#agentClients.disconnect(target.id).catch(() => undefined);
      return failure(
        error instanceof AgentConnectionError
          ? error.code
          : "PERSISTENT_RELAY_CONNECTION_FAILED",
        error instanceof Error
          ? error.message
          : "持久 Relay 连接失败",
      );
    }
  }

  #parseTargetId(targetId: string): number | null {
    const match = TARGET_ID_PATTERN.exec(targetId);
    if (!match?.[1]) {
      return null;
    }

    const pid = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  #isKnownTargetId(targetId: string): boolean {
    return (
      this.#parseTargetId(targetId) !== null ||
      this.connection(targetId) !== null
    );
  }

  #diagnosticFailure<T>(
    error: unknown,
    fallbackCode: string,
    fallbackMessage: string,
  ): OperationResult<T> {
    return failure(
      error instanceof AgentConnectionError ? error.code : fallbackCode,
      error instanceof Error ? error.message : fallbackMessage,
    );
  }
}

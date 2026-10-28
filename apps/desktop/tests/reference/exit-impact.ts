import type {
  ActionResult,
  ExitImpactSummary,
  ExitImpactTarget,
  OperationResult,
  TargetConnection,
} from "../../src/shared/contracts.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_COUNT_PATTERN = /^(?:0|[1-9]\d{0,6})$/u;
const MAXIMUM_MANAGED_COUNT = 1_000_000;

function failedTarget(
  connection: TargetConnection,
  errorMessage: string,
): ExitImpactTarget {
  return {
    targetId: connection.target.id,
    displayName: connection.target.displayName,
    pid: connection.target.pid,
    state: "FAILED",
    taskCount: 0,
    classCount: 0,
    rollbackCount: 0,
    artifactPotentialCount: 0,
    errorMessage,
  };
}

function parseManagedCount(
  values: Readonly<Record<string, string>>,
  key: string,
): number | null {
  const raw = values[key];
  if (!raw || !DECIMAL_COUNT_PATTERN.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= MAXIMUM_MANAGED_COUNT
    ? parsed
    : null;
}

export function exitImpactTargetFromAction(
  connection: TargetConnection,
  result: OperationResult<ActionResult>,
): ExitImpactTarget {
  if (!result.ok || !result.value) {
    return failedTarget(
      connection,
      result.errorMessage ?? "无法检查目标会话状态",
    );
  }

  const action = result.value;
  if (
    action.actionId !== "session.reset.preview" ||
    action.targetId !== connection.target.id ||
    action.status !== "SUCCEEDED"
  ) {
    return failedTarget(connection, "Agent 返回了不匹配的会话预检结果");
  }

  const taskCount = parseManagedCount(action.values, "task.total");
  const classCount = parseManagedCount(action.values, "class.total");
  const rollbackCount = parseManagedCount(
    action.values,
    "rollback.total",
  );
  const artifactPotentialCount = parseManagedCount(
    action.values,
    "artifactPotential.total",
  );
  if (
    taskCount === null ||
    classCount === null ||
    rollbackCount === null ||
    artifactPotentialCount === null ||
    !SHA256_PATTERN.test(action.values.fingerprint ?? "")
  ) {
    return failedTarget(connection, "Agent 返回了无效的会话预检数据");
  }

  return {
    targetId: connection.target.id,
    displayName: connection.target.displayName,
    pid: connection.target.pid,
    state: "INSPECTED",
    taskCount,
    classCount,
    rollbackCount,
    artifactPotentialCount,
    errorMessage: null,
  };
}

export function summarizeExitImpact(
  targets: readonly ExitImpactTarget[],
  inspectedAt = new Date().toISOString(),
): ExitImpactSummary {
  let inspectedCount = 0;
  let failedCount = 0;
  let taskCount = 0;
  let classCount = 0;
  let rollbackCount = 0;
  let artifactPotentialCount = 0;

  for (const target of targets) {
    if (target.state === "FAILED") {
      failedCount += 1;
      continue;
    }
    inspectedCount += 1;
    taskCount += target.taskCount;
    classCount += target.classCount;
    rollbackCount += target.rollbackCount;
    artifactPotentialCount += target.artifactPotentialCount;
  }

  return {
    inspectedAt,
    connectionCount: targets.length,
    inspectedCount,
    failedCount,
    taskCount,
    classCount,
    rollbackCount,
    artifactPotentialCount,
    targets,
  };
}

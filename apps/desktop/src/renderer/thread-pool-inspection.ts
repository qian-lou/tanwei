const MAXIMUM_POOLS = 20;
const MAXIMUM_RETURNED_MEMBERS = 200;
const MAXIMUM_QUEUE_TASK_TYPES = 200;
const MAXIMUM_TEXT_LENGTH = 512;

export interface ThreadPoolMember {
  readonly threadId: number;
  readonly name: string;
  readonly groupName: string;
  readonly state: string;
  readonly daemon: boolean;
  readonly priority: number;
  readonly topFrame: string;
  readonly applicationFrame: string;
  readonly blockerType: string;
}

export interface ThreadPoolQueueTaskType {
  readonly className: string;
  readonly count: number;
}

export interface ThreadPool {
  readonly kind: string;
  readonly className: string;
  readonly identity: string;
  readonly state: string;
  readonly configuredSize: string | null;
  readonly poolSize: string | null;
  readonly activeCount: string | null;
  readonly maximumSize: string | null;
  readonly largestSize: string | null;
  readonly completedTasks: string | null;
  readonly queuedTasks: string | null;
  readonly remainingQueueCapacity: string | null;
  readonly queueType: string;
  readonly queuedSubmissions: string | null;
  readonly runningCount: string | null;
  readonly stealCount: string | null;
  readonly threadFactoryType: string;
  readonly rejectionHandlerType: string;
  readonly queueInspectionAvailable: boolean;
  readonly queueInspectionIssue: string;
  readonly queueTasksScanned: number;
  readonly queueTasksTruncated: boolean;
  readonly queueTaskTypes: readonly ThreadPoolQueueTaskType[];
  readonly membershipAvailable: boolean;
  readonly membershipIssue: string;
  readonly memberCount: number;
  readonly membersTruncated: boolean;
  readonly members: readonly ThreadPoolMember[];
}

export interface ThreadPoolSummary {
  readonly queriedTypes: number;
  readonly truncated: boolean;
  readonly boundary: string;
  readonly requestedMemberLimit: number;
  readonly includeEvidence: boolean;
  readonly requestedQueueTaskLimit: number;
  readonly scannedThreads: number;
  readonly threadEnumerationTruncated: boolean;
  readonly discoveredMembers: number;
  readonly returnedMembers: number;
}

export interface ThreadPoolInspection {
  readonly pools: readonly ThreadPool[];
  readonly summary: ThreadPoolSummary;
}

function safeCount(
  values: Readonly<Record<string, string>>,
  key: string,
  maximum: number,
): number {
  const parsed = Number(values[key] ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(maximum, parsed)
    : 0;
}

function safeMetric(
  values: Readonly<Record<string, string>>,
  key: string,
): string | null {
  const raw = values[key] ?? "";
  return /^(?:0|[1-9]\d{0,18})$/u.test(raw) ? raw : null;
}

function safeText(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  return (values[key] ?? "").slice(0, MAXIMUM_TEXT_LENGTH);
}

function safeThreadId(raw: string): number | null {
  if (!/^[1-9]\d{0,18}$/u.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeBoundedInteger(
  raw: string,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseMember(
  values: Readonly<Record<string, string>>,
  prefix: string,
): ThreadPoolMember | null {
  const threadId = safeThreadId(values[`${prefix}threadId`] ?? "");
  const name = safeText(values, `${prefix}name`);
  const priority = safeBoundedInteger(
    values[`${prefix}priority`] ?? "",
    1,
    10,
  );
  if (threadId === null || !name || priority === null) {
    return null;
  }
  return {
    threadId,
    name,
    groupName: safeText(values, `${prefix}groupName`),
    state: safeText(values, `${prefix}state`) || "UNKNOWN",
    daemon: values[`${prefix}daemon`] === "true",
    priority,
    topFrame: safeText(values, `${prefix}topFrame`),
    applicationFrame: safeText(values, `${prefix}applicationFrame`),
    blockerType: safeText(values, `${prefix}blockerType`),
  };
}

function parseQueueTaskTypes(
  values: Readonly<Record<string, string>>,
  prefix: string,
  maximumSamples: number,
): readonly ThreadPoolQueueTaskType[] {
  const count = safeCount(
    values,
    `${prefix}queueTaskTypeCount`,
    MAXIMUM_QUEUE_TASK_TYPES,
  );
  const taskTypes: ThreadPoolQueueTaskType[] = [];
  const seen = new Set<string>();
  let remainingSamples = maximumSamples;
  for (let index = 0; index < count; index += 1) {
    const taskPrefix = `${prefix}queueTaskType.${String(index).padStart(3, "0")}.`;
    const className = safeText(values, `${taskPrefix}className`);
    const taskCount = safeBoundedInteger(
      values[`${taskPrefix}count`] ?? "",
      1,
      MAXIMUM_QUEUE_TASK_TYPES,
    );
    if (
      className &&
      taskCount !== null &&
      taskCount <= remainingSamples &&
      !seen.has(className)
    ) {
      taskTypes.push({ className, count: taskCount });
      seen.add(className);
      remainingSamples -= taskCount;
    }
  }
  return taskTypes;
}

function parsePool(
  values: Readonly<Record<string, string>>,
  index: number,
): ThreadPool | null {
  const prefix = `pool.${String(index).padStart(4, "0")}.`;
  const className = safeText(values, `${prefix}className`);
  const identity = safeText(values, `${prefix}identity`);
  if (!className || !identity) {
    return null;
  }
  const returnedMemberCount = safeCount(
    values,
    `${prefix}returnedMemberCount`,
    MAXIMUM_RETURNED_MEMBERS,
  );
  const members: ThreadPoolMember[] = [];
  for (let memberIndex = 0; memberIndex < returnedMemberCount; memberIndex += 1) {
    const member = parseMember(
      values,
      `${prefix}member.${String(memberIndex).padStart(3, "0")}.`,
    );
    if (member !== null) {
      members.push(member);
    }
  }
  const queueTasksScanned = safeCount(
    values,
    `${prefix}queueTasksScanned`,
    MAXIMUM_QUEUE_TASK_TYPES,
  );
  return {
    kind: safeText(values, `${prefix}kind`) || "UNKNOWN",
    className,
    identity,
    state: safeText(values, `${prefix}state`) || "UNKNOWN",
    configuredSize: safeMetric(values, `${prefix}configuredSize`),
    poolSize: safeMetric(values, `${prefix}poolSize`),
    activeCount: safeMetric(values, `${prefix}activeCount`),
    maximumSize: safeMetric(values, `${prefix}maximumSize`),
    largestSize: safeMetric(values, `${prefix}largestSize`),
    completedTasks: safeMetric(values, `${prefix}completedTasks`),
    queuedTasks: safeMetric(values, `${prefix}queuedTasks`),
    remainingQueueCapacity: safeMetric(
      values,
      `${prefix}remainingQueueCapacity`,
    ),
    queueType: safeText(values, `${prefix}queueType`),
    queuedSubmissions: safeMetric(values, `${prefix}queuedSubmissions`),
    runningCount: safeMetric(values, `${prefix}runningCount`),
    stealCount: safeMetric(values, `${prefix}stealCount`),
    threadFactoryType: safeText(values, `${prefix}threadFactoryType`),
    rejectionHandlerType: safeText(
      values,
      `${prefix}rejectionHandlerType`,
    ),
    queueInspectionAvailable:
      values[`${prefix}queueInspectionAvailable`] === "true",
    queueInspectionIssue: safeText(
      values,
      `${prefix}queueInspectionIssue`,
    ),
    queueTasksScanned,
    queueTasksTruncated:
      values[`${prefix}queueTasksTruncated`] === "true",
    queueTaskTypes: parseQueueTaskTypes(
      values,
      prefix,
      queueTasksScanned,
    ),
    membershipAvailable: values[`${prefix}membershipAvailable`] === "true",
    membershipIssue: safeText(values, `${prefix}membershipIssue`),
    memberCount: safeCount(values, `${prefix}memberCount`, Number.MAX_SAFE_INTEGER),
    membersTruncated: values[`${prefix}membersTruncated`] === "true",
    members,
  };
}

export function parseThreadPoolInspection(
  values: Readonly<Record<string, string>>,
): ThreadPoolInspection {
  const poolCount = safeCount(values, "count", MAXIMUM_POOLS);
  const pools: ThreadPool[] = [];
  for (let index = 0; index < poolCount; index += 1) {
    const pool = parsePool(values, index);
    if (pool !== null) {
      pools.push(pool);
    }
  }
  return {
    pools,
    summary: {
      queriedTypes: safeCount(values, "queriedTypes", 3),
      truncated: values.truncated === "true",
      boundary: safeText(values, "boundary"),
      requestedMemberLimit: safeCount(values, "requestedMemberLimit", 200),
      includeEvidence: values.includeEvidence === "true",
      requestedQueueTaskLimit: safeCount(
        values,
        "requestedQueueTaskLimit",
        200,
      ),
      scannedThreads: safeCount(values, "scannedThreads", 10_000),
      threadEnumerationTruncated: values.threadEnumerationTruncated === "true",
      discoveredMembers: safeCount(
        values,
        "discoveredMembers",
        Number.MAX_SAFE_INTEGER,
      ),
      returnedMembers: safeCount(values, "returnedMembers", 200),
    },
  };
}

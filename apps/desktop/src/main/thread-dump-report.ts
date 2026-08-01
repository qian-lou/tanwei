import type {
  ThreadDumpInspectionReport,
  ThreadDumpThread,
} from "../shared/contracts.js";

const MAXIMUM_REPORT_CHARACTERS = 32 * 1024 * 1024;
const MAXIMUM_LINES = 1_000_000;
const MAXIMUM_LINE_CHARACTERS = 4_096;
const MAXIMUM_THREADS = 10_000;
const MAXIMUM_FRAMES_PER_THREAD = 512;
const MAXIMUM_LOCKS_PER_THREAD = 256;
const THREAD_HEADER =
  /^"([^"]*)" #([1-9]\d{0,18}) state=([A-Z_]+) cpuTimeNanos=(-1|0|[1-9]\d{0,18}) deadlocked=(true|false)$/u;
const WAITING_WITH_OWNER =
  /^  waitingOn=(.+?) owner=#([1-9]\d{0,18}) "([^"]*)"$/u;
const WAITING_WITHOUT_OWNER = /^  waitingOn=(.+)$/u;

interface MutableThread {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly cpuTimeNanos: string | null;
  readonly deadlocked: boolean;
  waitingOn: string | null;
  lockOwnerId: string | null;
  lockOwnerName: string | null;
  readonly stack: string[];
  readonly monitors: string[];
  readonly synchronizers: string[];
}

export function parseThreadDumpReport(
  source: string,
  artifactId: string,
): ThreadDumpInspectionReport {
  if (!artifactId.trim()) {
    throw new Error("Thread dump artifact id is required");
  }
  if (
    source.length <= 0 ||
    source.length > MAXIMUM_REPORT_CHARACTERS
  ) {
    throw new Error("Thread dump text is empty or exceeds 32 MiB");
  }
  const lines = source.split(/\r?\n/u);
  if (lines.length > MAXIMUM_LINES) {
    throw new Error("Thread dump contains too many lines");
  }
  if (lines[0] !== "Tanwei Thread Dump") {
    throw new Error("Thread dump signature is invalid");
  }
  const metadata = new Map<string, string>();
  let lineIndex = 1;
  for (; lineIndex < lines.length; lineIndex++) {
    const line = boundedLine(lines[lineIndex] ?? "");
    if (!line) {
      lineIndex++;
      break;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("Thread dump metadata is malformed");
    }
    metadata.set(
      line.slice(0, separator),
      line.slice(separator + 1),
    );
  }
  if (metadata.get("formatVersion") !== "1") {
    throw new Error("Thread dump format version is unsupported");
  }

  const threads: ThreadDumpThread[] = [];
  let current: MutableThread | null = null;
  let readingSynchronizers = false;
  for (; lineIndex < lines.length; lineIndex++) {
    const line = boundedLine(lines[lineIndex] ?? "");
    const header = THREAD_HEADER.exec(line);
    if (header) {
      if (threads.length >= MAXIMUM_THREADS) {
        throw new Error("Thread dump exceeds the 10000 thread limit");
      }
      current = {
        name: header[1] ?? "",
        id: header[2] ?? "",
        state: header[3] ?? "UNKNOWN",
        cpuTimeNanos:
          header[4] === "-1" ? null : (header[4] ?? null),
        deadlocked: header[5] === "true",
        waitingOn: null,
        lockOwnerId: null,
        lockOwnerName: null,
        stack: [],
        monitors: [],
        synchronizers: [],
      };
      threads.push(current);
      readingSynchronizers = false;
      continue;
    }
    if (!current) {
      continue;
    }
    const waitingWithOwner = WAITING_WITH_OWNER.exec(line);
    if (waitingWithOwner) {
      current.waitingOn = waitingWithOwner[1] ?? null;
      current.lockOwnerId = waitingWithOwner[2] ?? null;
      current.lockOwnerName = waitingWithOwner[3] ?? null;
      continue;
    }
    const waitingWithoutOwner = WAITING_WITHOUT_OWNER.exec(line);
    if (waitingWithoutOwner) {
      current.waitingOn = waitingWithoutOwner[1] ?? null;
      continue;
    }
    if (line === "    Locked ownable synchronizers:") {
      readingSynchronizers = true;
      continue;
    }
    if (line.startsWith("    at ")) {
      if (current.stack.length < MAXIMUM_FRAMES_PER_THREAD) {
        current.stack.push(line.slice(7));
      }
      continue;
    }
    if (line.startsWith("      - locked ")) {
      if (current.monitors.length < MAXIMUM_LOCKS_PER_THREAD) {
        current.monitors.push(line.slice(15));
      }
      continue;
    }
    if (readingSynchronizers && line.startsWith("      - ")) {
      if (
        current.synchronizers.length <
        MAXIMUM_LOCKS_PER_THREAD
      ) {
        current.synchronizers.push(line.slice(8));
      }
    }
  }

  const stateCounts: Record<string, number> = {};
  for (const thread of threads) {
    stateCounts[thread.state] =
      (stateCounts[thread.state] ?? 0) + 1;
  }
  return {
    artifactId,
    capturedAt: validDate(metadata.get("capturedAt")),
    processId: validInteger(metadata.get("processId"), true),
    jvmStartTimeMillis: validLong(metadata.get("jvmStartTimeMillis")),
    javaVersion: metadata.get("javaVersion") ?? "unknown",
    threadsSeen:
      validInteger(metadata.get("threadsSeen"), false) ?? 0,
    threadsSelected:
      validInteger(metadata.get("threadsSelected"), false) ??
      threads.length,
    maximumStackDepth:
      validInteger(metadata.get("maximumStackDepth"), false) ?? 0,
    truncated: metadata.get("truncated") === "true",
    monitorsIncluded:
      metadata.get("monitorsIncluded") === "true",
    synchronizersIncluded:
      metadata.get("synchronizersIncluded") === "true",
    deadlockedThreads:
      validInteger(metadata.get("deadlockedThreads"), false) ??
      threads.filter((thread) => thread.deadlocked).length,
    stateCounts,
    threads,
  };
}

function boundedLine(line: string): string {
  if (line.length > MAXIMUM_LINE_CHARACTERS) {
    throw new Error("Thread dump line exceeds 4096 characters");
  }
  return line;
}

function validDate(value: string | undefined): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function validInteger(
  value: string | undefined,
  allowNegative: boolean,
): number | null {
  if (
    !value ||
    !(allowNegative ? /^-?\d{1,18}$/u : /^\d{1,18}$/u).test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validLong(value: string | undefined): string | null {
  return value && /^(?:0|[1-9]\d{0,18})$/u.test(value)
    ? value
    : null;
}

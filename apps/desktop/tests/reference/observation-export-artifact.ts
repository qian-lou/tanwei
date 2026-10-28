import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  CreateMonitorWindowsArtifactInput,
  CreateTraceHotspotArtifactInput,
  MonitorWindowSample,
  MonitorWindowSummary,
  MonitorWindowsInspectionReport,
  ObservationExportInspectionReport,
  TraceHotspotInspectionReport,
} from "../../src/shared/contracts.js";
import { aggregateTraceHotspots } from "../../src/shared/trace-aggregation.js";

export const MAXIMUM_OBSERVATION_EXPORT_ARTIFACT_BYTES = 512 * 1024;
const MAXIMUM_TRACE_EXPORT_INPUT_BYTES = 8 * 1024 * 1024;

const safeCount = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const targetIdSchema = z
  .string()
  .min(1)
  .max(560)
  .regex(
    /^(?:local:\d+|remote:(?:ssh|kubernetes|persistent):[a-f0-9]{24})$/u,
  );
const taskStateSchema = z.enum([
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "UNKNOWN",
]);
const classNameSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$/u);
const methodTargetSchema = z
  .object({
    className: classNameSchema,
    classLoader: z.string().min(1).max(4_096),
    methodName: z.string().min(1).max(512),
    parameterTypes: z.array(z.string().min(1).max(1_024)).max(256),
  })
  .strict();
const ruleSchema = z.string().min(1).max(512);

const traceSpanSchema = z
  .object({
    sequence: safeCount,
    parentSequence: safeCount.nullable(),
    method: z.string().trim().min(1).max(1_024),
    durationNanos: safeCount,
    exceptionType: z.string().min(1).max(1_024).nullable(),
  })
  .strict();
const traceSchema = z
  .object({
    traceId: safeCount.min(1),
    capturedAtEpochMillis: safeCount.min(1),
    durationNanos: safeCount,
    truncatedSpans: safeCount.max(100_000),
    spans: z.array(traceSpanSchema).min(1).max(512),
  })
  .strict()
  .superRefine((trace, context) => {
    const sequences = new Set<number>();
    for (const [index, span] of trace.spans.entries()) {
      if (sequences.has(span.sequence)) {
        context.addIssue({
          code: "custom",
          path: ["spans", index, "sequence"],
          message: "Trace span sequences must be unique",
        });
        return;
      }
      sequences.add(span.sequence);
    }
  });

export const createTraceHotspotArtifactInputSchema = z
  .object({
    targetId: targetIdSchema,
    taskId: z.string().uuid(),
    taskState: taskStateSchema,
    target: methodTargetSchema,
    rootMethod: z.string().min(1).max(2_048),
    scopePrefix: z.string().min(1).max(1_024),
    includeRules: z.array(ruleSchema).max(16),
    excludeRules: z.array(ruleSchema).max(16),
    dropped: safeCount,
    traces: z.array(traceSchema).min(1).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      Buffer.byteLength(JSON.stringify(input), "utf8") >
      MAXIMUM_TRACE_EXPORT_INPUT_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["traces"],
        message: "Trace export input exceeds the 8 MiB boundary",
      });
    }
    const traceIds = new Set<number>();
    let previousCapturedAt = 0;
    for (const [index, trace] of input.traces.entries()) {
      if (traceIds.has(trace.traceId)) {
        context.addIssue({
          code: "custom",
          path: ["traces", index, "traceId"],
          message: "Trace ids must be unique",
        });
        return;
      }
      if (trace.capturedAtEpochMillis < previousCapturedAt) {
        context.addIssue({
          code: "custom",
          path: ["traces", index, "capturedAtEpochMillis"],
          message: "Traces must be chronological",
        });
        return;
      }
      traceIds.add(trace.traceId);
      previousCapturedAt = trace.capturedAtEpochMillis;
    }
  });

const monitorWindowSchema = z
  .object({
    sequence: safeCount.min(1),
    startedAtEpochMillis: safeCount.min(1),
    endedAtEpochMillis: safeCount.min(1),
    minimumDurationMillis: z.number().int().min(0).max(60_000).default(0),
    calls: safeCount,
    failures: safeCount,
    durationNanos: safeCount,
    maximumDurationNanos: safeCount,
    p95DurationNanos: safeCount,
    p99DurationNanos: safeCount,
  })
  .strict()
  .superRefine((window, context) => {
    if (window.startedAtEpochMillis > window.endedAtEpochMillis) {
      context.addIssue({
        code: "custom",
        path: ["endedAtEpochMillis"],
        message: "Monitor window ends before it starts",
      });
    }
    if (window.failures > window.calls) {
      context.addIssue({
        code: "custom",
        path: ["failures"],
        message: "Monitor failures exceed completed calls",
      });
    }
    if (window.p95DurationNanos > window.p99DurationNanos) {
      context.addIssue({
        code: "custom",
        path: ["p95DurationNanos"],
        message: "Monitor P95 exceeds P99",
      });
    }
  });

export const createMonitorWindowsArtifactInputSchema = z
  .object({
    targetId: targetIdSchema,
    taskId: z.string().uuid(),
    taskState: taskStateSchema,
    target: methodTargetSchema,
    method: z.string().min(1).max(2_048),
    intervalMillis: z.number().int().min(1_000).max(60_000),
    windows: z.array(monitorWindowSchema).min(1).max(300),
  })
  .strict()
  .superRefine((input, context) => {
    let previous: MonitorWindowSample | null = null;
    for (const [index, window] of input.windows.entries()) {
      if (
        previous &&
        (window.sequence <= previous.sequence ||
          window.startedAtEpochMillis < previous.startedAtEpochMillis ||
          window.endedAtEpochMillis <= previous.endedAtEpochMillis)
      ) {
        context.addIssue({
          code: "custom",
          path: ["windows", index],
          message: "Monitor windows must be strictly chronological",
        });
        return;
      }
      previous = window;
    }
  });

const traceHotspotRowSchema = z
  .object({
    method: z.string().min(1).max(1_024),
    calls: safeCount.min(1),
    errors: safeCount,
    totalDurationNanos: safeCount,
    selfDurationNanos: safeCount,
    averageDurationNanos: z.number().finite().min(0),
    maximumDurationNanos: safeCount,
    selfSharePercent: z.number().finite().min(0).max(100),
  })
  .strict();
const traceRecordingSchema = z
  .object({
    targetId: targetIdSchema,
    jvmStartTimeEpochMillis: safeCount.min(1),
    exportedAtEpochMillis: safeCount.min(1),
    taskId: z.string().uuid(),
    taskState: taskStateSchema,
    target: methodTargetSchema,
    rootMethod: z.string().min(1).max(2_048),
    scopePrefix: z.string().min(1).max(1_024),
    includeRules: z.array(ruleSchema).max(16),
    excludeRules: z.array(ruleSchema).max(16),
    firstCapturedAtEpochMillis: safeCount.min(1),
    lastCapturedAtEpochMillis: safeCount.min(1),
    traceCount: safeCount.min(1).max(20),
    spanCount: safeCount.min(1).max(10_240),
    dropped: safeCount,
    truncatedSpans: safeCount,
    hotspots: z.array(traceHotspotRowSchema).min(1).max(100),
  })
  .strict();
const monitorSummarySchema = z
  .object({
    windowCount: safeCount.min(1).max(300),
    totalCalls: safeCount,
    totalFailures: safeCount,
    totalDurationNanos: safeCount,
    averageDurationNanos: z.number().finite().min(0),
    maximumDurationNanos: safeCount,
    maximumP95DurationNanos: safeCount,
    maximumP99DurationNanos: safeCount,
  })
  .strict();
const monitorRecordingSchema = z
  .object({
    targetId: targetIdSchema,
    jvmStartTimeEpochMillis: safeCount.min(1),
    exportedAtEpochMillis: safeCount.min(1),
    taskId: z.string().uuid(),
    taskState: taskStateSchema,
    target: methodTargetSchema,
    method: z.string().min(1).max(2_048),
    intervalMillis: z.number().int().min(1_000).max(60_000),
    windows: z.array(monitorWindowSchema).min(1).max(300),
    summary: monitorSummarySchema,
  })
  .strict();
const traceArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    kind: z.literal("trace-hotspots"),
    recording: traceRecordingSchema,
  })
  .strict();
const monitorArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    kind: z.literal("monitor-windows"),
    recording: monitorRecordingSchema,
  })
  .strict();

export function serializeTraceHotspotArtifact(
  input: CreateTraceHotspotArtifactInput,
  jvmStartTimeEpochMillis: number,
  exportedAtEpochMillis: number,
): Buffer {
  const validated = createTraceHotspotArtifactInputSchema.parse(input);
  validateJVMTimeBoundary(
    validated.traces.map((trace) => trace.capturedAtEpochMillis),
    jvmStartTimeEpochMillis,
    exportedAtEpochMillis,
  );
  const hotspots = aggregateTraceHotspots(validated.traces);
  if (hotspots.length === 0) {
    throw new Error("Trace export does not contain any valid hotspot");
  }
  const first = validated.traces[0];
  const last = validated.traces.at(-1);
  if (!first || !last) {
    throw new Error("Trace export requires at least one trace");
  }
  const recording = traceRecordingSchema.parse({
    targetId: validated.targetId,
    jvmStartTimeEpochMillis,
    exportedAtEpochMillis,
    taskId: validated.taskId,
    taskState: validated.taskState,
    target: validated.target,
    rootMethod: validated.rootMethod,
    scopePrefix: validated.scopePrefix,
    includeRules: validated.includeRules,
    excludeRules: validated.excludeRules,
    firstCapturedAtEpochMillis: first.capturedAtEpochMillis,
    lastCapturedAtEpochMillis: last.capturedAtEpochMillis,
    traceCount: validated.traces.length,
    spanCount: sumSafeIntegers(
      validated.traces.map((trace) => trace.spans.length),
    ),
    dropped: validated.dropped,
    truncatedSpans: sumSafeIntegers(
      validated.traces.map((trace) => trace.truncatedSpans),
    ),
    hotspots,
  });
  return serializeBounded({
    schemaVersion: 1,
    product: "tanwei",
    kind: "trace-hotspots",
    recording,
  });
}

export function serializeMonitorWindowsArtifact(
  input: CreateMonitorWindowsArtifactInput,
  jvmStartTimeEpochMillis: number,
  exportedAtEpochMillis: number,
): Buffer {
  const validated = createMonitorWindowsArtifactInputSchema.parse(input);
  validateJVMTimeBoundary(
    validated.windows.flatMap((window) => [
      window.startedAtEpochMillis,
      window.endedAtEpochMillis,
    ]),
    jvmStartTimeEpochMillis,
    exportedAtEpochMillis,
  );
  const recording = monitorRecordingSchema.parse({
    ...validated,
    jvmStartTimeEpochMillis,
    exportedAtEpochMillis,
    summary: summarizeMonitorWindows(validated.windows),
  });
  return serializeBounded({
    schemaVersion: 1,
    product: "tanwei",
    kind: "monitor-windows",
    recording,
  });
}

export function parseObservationExportArtifact(
  content: string,
  artifactId: string,
): ObservationExportInspectionReport {
  if (!artifactId.trim() || artifactId.length > 128) {
    throw new Error("Observation export artifact id is invalid");
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (
    contentBytes <= 0 ||
    contentBytes > MAXIMUM_OBSERVATION_EXPORT_ARTIFACT_BYTES
  ) {
    throw new Error("Observation export exceeds the artifact size boundary");
  }
  const raw = JSON.parse(content) as { kind?: unknown };
  if (raw.kind === "trace-hotspots") {
    const parsed = traceArtifactSchema.parse(raw);
    return {
      kind: "TRACE_HOTSPOTS",
      artifactId,
      schemaVersion: 1,
      recording: parsed.recording,
    } satisfies TraceHotspotInspectionReport;
  }
  if (raw.kind === "monitor-windows") {
    const parsed = monitorArtifactSchema.parse(raw);
    return {
      kind: "MONITOR_WINDOWS",
      artifactId,
      schemaVersion: 1,
      recording: parsed.recording,
    } satisfies MonitorWindowsInspectionReport;
  }
  throw new Error("Observation export kind is unsupported");
}

export function summarizeMonitorWindows(
  windows: readonly MonitorWindowSample[],
): MonitorWindowSummary {
  const validated = z.array(monitorWindowSchema).min(1).max(300).parse(windows);
  const totalCalls = sumSafeIntegers(validated.map((window) => window.calls));
  const totalFailures = sumSafeIntegers(
    validated.map((window) => window.failures),
  );
  const totalDurationNanos = sumSafeIntegers(
    validated.map((window) => window.durationNanos),
  );
  return {
    windowCount: validated.length,
    totalCalls,
    totalFailures,
    totalDurationNanos,
    averageDurationNanos:
      totalCalls > 0 ? totalDurationNanos / totalCalls : 0,
    maximumDurationNanos: Math.max(
      0,
      ...validated.map((window) => window.maximumDurationNanos),
    ),
    maximumP95DurationNanos: Math.max(
      0,
      ...validated.map((window) => window.p95DurationNanos),
    ),
    maximumP99DurationNanos: Math.max(
      0,
      ...validated.map((window) => window.p99DurationNanos),
    ),
  };
}

function validateJVMTimeBoundary(
  timestamps: readonly number[],
  jvmStartTimeEpochMillis: number,
  exportedAtEpochMillis: number,
): void {
  if (
    !Number.isSafeInteger(jvmStartTimeEpochMillis) ||
    jvmStartTimeEpochMillis <= 0 ||
    !Number.isSafeInteger(exportedAtEpochMillis) ||
    exportedAtEpochMillis < jvmStartTimeEpochMillis ||
    timestamps.some(
      (timestamp) =>
        timestamp < jvmStartTimeEpochMillis ||
        timestamp > exportedAtEpochMillis + 5_000,
    )
  ) {
    throw new Error("Observation export timestamps do not belong to this JVM cycle");
  }
}

function sumSafeIntegers(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Observation export counters exceed safe integer bounds");
    }
  }
  return total;
}

function serializeBounded(value: unknown): Buffer {
  const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (content.byteLength > MAXIMUM_OBSERVATION_EXPORT_ARTIFACT_BYTES) {
    throw new Error("Observation export exceeds the 512 KiB artifact boundary");
  }
  return content;
}

import { Buffer } from "node:buffer";
import { z } from "zod";
import type {
  HeapHistogramComparison,
  HeapHistogramInspectionReport,
  HeapHistogramSnapshot,
} from "../../src/shared/contracts.js";
import {
  buildHeapHistogramDiff,
  heapHistogramCompatibilityIssue,
} from "../../src/shared/heap-histogram-diff.js";

export const MAXIMUM_HEAP_HISTOGRAM_ARTIFACT_BYTES = 512 * 1024;

const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value, "Text must be trimmed");
const safeCount = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const heapHistogramRowSchema = z
  .object({
    className: boundedText(1_024),
    classLoader: boundedText(4_096),
    instanceCount: safeCount.min(1),
    shallowBytes: safeCount,
    averageShallowBytes: safeCount,
  })
  .strict();

export const heapHistogramSnapshotSchema = z
  .object({
    targetId: boundedText(560),
    targetStartTime: boundedText(128),
    capturedAt: safeCount.min(1),
    query: z
      .string()
      .max(256)
      .refine((value) => value.trim() === value, "Query must be trimmed"),
    limit: z.number().int().min(1).max(100),
    scanLimit: z.number().int().min(10_000).max(5_000_000),
    scanComplete: z.boolean(),
    rowsComplete: z.boolean(),
    accountedObjects: safeCount,
    accountedBytes: safeCount,
    rows: z.array(heapHistogramRowSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.rows.length > snapshot.limit) {
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Rows exceed the declared result limit",
      });
    }
    const identities = new Set<string>();
    let rowObjects = 0;
    let rowBytes = 0;
    for (const [index, row] of snapshot.rows.entries()) {
      const identity = `${row.className.length}:${row.className}${row.classLoader}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "Duplicate class and ClassLoader identity",
        });
      }
      identities.add(identity);
      rowObjects += row.instanceCount;
      rowBytes += row.shallowBytes;
      if (
        row.averageShallowBytes !==
        Math.floor(row.shallowBytes / row.instanceCount)
      ) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "averageShallowBytes"],
          message: "Average shallow size does not match the row totals",
        });
      }
    }
    if (!Number.isSafeInteger(rowObjects) || !Number.isSafeInteger(rowBytes)) {
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Row totals exceed the safe integer boundary",
      });
      return;
    }
    if (
      rowObjects > snapshot.accountedObjects ||
      rowBytes > snapshot.accountedBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Rows exceed the declared accounted totals",
      });
    }
    if (
      snapshot.rowsComplete &&
      (rowObjects !== snapshot.accountedObjects ||
        rowBytes !== snapshot.accountedBytes)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rowsComplete"],
        message: "Complete rows must equal the accounted totals",
      });
    }
  });

const heapHistogramArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("tanwei"),
    kind: z.literal("heap-histogram"),
    snapshot: heapHistogramSnapshotSchema,
  })
  .strict();

export function serializeHeapHistogramArtifact(
  snapshot: HeapHistogramSnapshot,
): Buffer {
  const validated = heapHistogramSnapshotSchema.parse(snapshot);
  return Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: "tanwei",
        kind: "heap-histogram",
        snapshot: validated,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function parseHeapHistogramArtifact(
  content: string,
  artifactId: string,
): HeapHistogramInspectionReport {
  if (!artifactId.trim() || artifactId.length > 128) {
    throw new Error("Heap histogram artifact id is invalid");
  }
  if (
    Buffer.byteLength(content, "utf8") <= 0 ||
    Buffer.byteLength(content, "utf8") >
      MAXIMUM_HEAP_HISTOGRAM_ARTIFACT_BYTES
  ) {
    throw new Error("Heap histogram artifact exceeds the size boundary");
  }
  const parsed = heapHistogramArtifactSchema.parse(JSON.parse(content));
  return {
    artifactId,
    schemaVersion: 1,
    snapshot: parsed.snapshot,
  };
}

interface HeapHistogramComparisonContext {
  readonly targetId: string;
  readonly baselineArtifactId: string;
  readonly currentArtifactId: string;
}

export function compareHeapHistogramReports(
  baseline: HeapHistogramInspectionReport,
  current: HeapHistogramInspectionReport,
  context: HeapHistogramComparisonContext,
): HeapHistogramComparison {
  if (
    !context.targetId.trim() ||
    !context.baselineArtifactId.trim() ||
    !context.currentArtifactId.trim()
  ) {
    throw new Error("Heap histogram comparison context is incomplete");
  }
  if (context.baselineArtifactId === context.currentArtifactId) {
    throw new Error("Heap histogram comparison requires two artifacts");
  }
  if (
    baseline.artifactId !== context.baselineArtifactId ||
    current.artifactId !== context.currentArtifactId
  ) {
    throw new Error("Heap histogram artifact identity does not match");
  }
  if (
    baseline.snapshot.targetId !== context.targetId ||
    current.snapshot.targetId !== context.targetId
  ) {
    throw new Error("Heap histogram target identity does not match");
  }
  const compatibilityIssue = heapHistogramCompatibilityIssue(
    baseline.snapshot,
    current.snapshot,
  );
  if (compatibilityIssue !== null) {
    throw new Error(
      `Incompatible heap histogram artifacts: ${compatibilityIssue}`,
    );
  }
  if (
    baseline.snapshot.targetStartTime === null ||
    current.snapshot.targetStartTime === null
  ) {
    throw new Error("Heap histogram JVM lifetime is unavailable");
  }
  if (baseline.snapshot.capturedAt > current.snapshot.capturedAt) {
    throw new Error("Heap histogram baseline must be captured first");
  }
  const diff = buildHeapHistogramDiff(
    baseline.snapshot,
    current.snapshot,
  );
  return {
    baselineArtifactId: baseline.artifactId,
    currentArtifactId: current.artifactId,
    targetId: context.targetId,
    targetStartTime: baseline.snapshot.targetStartTime,
    baselineCapturedAt: baseline.snapshot.capturedAt,
    currentCapturedAt: current.snapshot.capturedAt,
    intervalMillis:
      current.snapshot.capturedAt - baseline.snapshot.capturedAt,
    query: baseline.snapshot.query,
    limit: baseline.snapshot.limit,
    scanLimit: baseline.snapshot.scanLimit,
    ...diff,
  };
}

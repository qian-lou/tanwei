import type { CodeCachePressureState } from "./contracts.js";

export interface CodeCachePressure {
  readonly percent: number;
  readonly state: CodeCachePressureState;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function codeCachePressure(
  usedBytes: number,
  capacityBytes: number,
): CodeCachePressure {
  if (
    !Number.isSafeInteger(usedBytes) ||
    !Number.isSafeInteger(capacityBytes) ||
    usedBytes < 0 ||
    capacityBytes <= 0 ||
    usedBytes > capacityBytes
  ) {
    throw new Error("Code Cache usage is outside its validated boundary");
  }
  const percent = roundMetric((usedBytes / capacityBytes) * 100);
  const state: CodeCachePressureState =
    percent >= 100
      ? "EXHAUSTED"
      : percent >= 90
        ? "HIGH"
        : percent >= 80
          ? "ELEVATED"
          : "NORMAL";
  return { percent, state };
}

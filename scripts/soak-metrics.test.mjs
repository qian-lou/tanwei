import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSoakSamples, MEBIBYTE } from "./soak-metrics.mjs";

const options = {
  warmupSamples: 1,
  analysisWindowSamples: 2,
  minimumSamples: 4,
  maxWorkingSetGrowthBytes: 64 * MEBIBYTE,
  maxWorkingSetSlopeBytesPerHour: 32 * MEBIBYTE,
  minimumSlopeDurationMillis: 10 * 60_000,
  maxAdditionalProcesses: 2,
  maxWindowCount: 1,
  minimumVisibleWindowCount: 1,
};

test("stable bounded samples pass with an O(N) summary", () => {
  const result = evaluateSoakSamples(
    [100, 120, 118, 122, 121].map((memoryMiB, index) =>
      sample(index * 5 * 60_000, memoryMiB),
    ),
    options,
  );

  assert.equal(result.passed, true);
  assert.equal(result.sampleCount, 5);
  assert.equal(result.warmupSampleCount, 1);
  assert.equal(result.baselineWorkingSetBytes, 119 * MEBIBYTE);
  assert.equal(result.endingWorkingSetBytes, 121.5 * MEBIBYTE);
  assert.deepEqual(result.violations, []);
});

test("sustained memory growth fails both growth and slope budgets", () => {
  const result = evaluateSoakSamples(
    [100, 120, 160, 200, 240].map((memoryMiB, index) =>
      sample(index * 15 * 60_000, memoryMiB),
    ),
    options,
  );

  assert.equal(result.passed, false);
  assert.match(result.violations.join("\n"), /稳态工作集增长/u);
  assert.match(result.violations.join("\n"), /工作集线性斜率/u);
});

test("short smoke ignores slope noise but still enforces absolute growth", () => {
  const result = evaluateSoakSamples(
    [100, 102, 104, 106].map((memoryMiB, index) =>
      sample(index * 1_000, memoryMiB),
    ),
    {
      ...options,
      maxWorkingSetGrowthBytes: 16 * MEBIBYTE,
      maxWorkingSetSlopeBytesPerHour: 1,
    },
  );

  assert.equal(result.passed, true);
  assert.ok(result.workingSetSlopeBytesPerHour > 1);
});

test("window and lazy-process budgets are enforced independently", () => {
  const samples = [
    sample(0, 100),
    sample(1_000, 101, { processCount: 7 }),
    sample(2_000, 101, { windowCount: 2 }),
    sample(3_000, 101, { visibleWindowCount: 0 }),
  ];
  const result = evaluateSoakSamples(samples, {
    ...options,
    warmupSamples: 0,
  });

  assert.equal(result.passed, false);
  assert.match(result.violations.join("\n"), /进程数峰值 7/u);
  assert.match(result.violations.join("\n"), /桌面窗口 峰值 2/u);
  assert.match(result.violations.join("\n"), /可见 桌面窗口 最低 0/u);
});

test("invalid and empty samples fail closed", () => {
  assert.throws(
    () => evaluateSoakSamples([], options),
    /At least one soak sample/u,
  );
  assert.throws(
    () =>
      evaluateSoakSamples(
        [sample(0, 100), { ...sample(1_000, 100), processCount: -1 }],
        options,
      ),
    /processCount/u,
  );
});

function sample(
  elapsedMillis,
  memoryMiB,
  {
    processCount = 4,
    windowCount = 1,
    visibleWindowCount = 1,
  } = {},
) {
  return {
    elapsedMillis,
    totalWorkingSetBytes: memoryMiB * MEBIBYTE,
    processCount,
    windowCount,
    visibleWindowCount,
  };
}

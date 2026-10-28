const DEFAULT_ANALYSIS_WINDOW_SAMPLES = 20;

export const MEBIBYTE = 1_048_576;

/**
 * Evaluate bounded desktop process samples in one linear pass.
 *
 * The first warm-up samples are excluded from memory-growth and slope checks,
 * but all samples remain subject to the window/process-count budgets.
 */
export function evaluateSoakSamples(samples, options) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError("At least one soak sample is required");
  }

  const config = normalizeOptions(options);
  const normalized = samples.map(normalizeSample);
  const warmupSampleCount = Math.min(
    config.warmupSamples,
    Math.max(0, normalized.length - 1),
  );
  const analyzedSampleCount = normalized.length - warmupSampleCount;
  const windowSize = Math.min(
    config.analysisWindowSamples,
    analyzedSampleCount,
  );
  const analysisStart = warmupSampleCount;
  const analysisEnd = normalized.length - windowSize;

  let firstWindowBytes = 0;
  let lastWindowBytes = 0;
  let peakWorkingSetBytes = 0;
  let maximumProcessCount = 0;
  let maximumWindowCount = 0;
  let minimumVisibleWindowCount = Number.POSITIVE_INFINITY;

  let regressionCount = 0;
  let sumHours = 0;
  let sumBytes = 0;
  let sumHoursSquared = 0;
  let sumHoursBytes = 0;
  const regressionOriginMillis = normalized[analysisStart].elapsedMillis;

  for (let index = 0; index < normalized.length; index += 1) {
    const sample = normalized[index];
    peakWorkingSetBytes = Math.max(
      peakWorkingSetBytes,
      sample.totalWorkingSetBytes,
    );
    maximumProcessCount = Math.max(maximumProcessCount, sample.processCount);
    maximumWindowCount = Math.max(maximumWindowCount, sample.windowCount);
    minimumVisibleWindowCount = Math.min(
      minimumVisibleWindowCount,
      sample.visibleWindowCount,
    );

    if (index < analysisStart) {
      continue;
    }
    if (index < analysisStart + windowSize) {
      firstWindowBytes += sample.totalWorkingSetBytes;
    }
    if (index >= analysisEnd) {
      lastWindowBytes += sample.totalWorkingSetBytes;
    }

    const elapsedHours =
      (sample.elapsedMillis - regressionOriginMillis) / 3_600_000;
    regressionCount += 1;
    sumHours += elapsedHours;
    sumBytes += sample.totalWorkingSetBytes;
    sumHoursSquared += elapsedHours * elapsedHours;
    sumHoursBytes += elapsedHours * sample.totalWorkingSetBytes;
  }

  const baselineWorkingSetBytes = Math.round(firstWindowBytes / windowSize);
  const endingWorkingSetBytes = Math.round(lastWindowBytes / windowSize);
  const workingSetGrowthBytes =
    endingWorkingSetBytes - baselineWorkingSetBytes;
  const regressionDenominator =
    regressionCount * sumHoursSquared - sumHours * sumHours;
  const workingSetSlopeBytesPerHour =
    regressionDenominator > 0
      ? (regressionCount * sumHoursBytes - sumHours * sumBytes) /
        regressionDenominator
      : 0;
  const analyzedDurationMillis =
    normalized.at(-1).elapsedMillis - normalized[analysisStart].elapsedMillis;
  const allowedProcessCount =
    normalized[0].processCount + config.maxAdditionalProcesses;
  const violations = [];

  if (normalized.length < config.minimumSamples) {
    violations.push(
      `只采集到 ${normalized.length} 个样本，最低要求 ${config.minimumSamples} 个`,
    );
  }
  if (workingSetGrowthBytes > config.maxWorkingSetGrowthBytes) {
    violations.push(
      `稳态工作集增长 ${formatMebibytes(workingSetGrowthBytes)}，预算 ${formatMebibytes(config.maxWorkingSetGrowthBytes)}`,
    );
  }
  if (
    analyzedDurationMillis >= config.minimumSlopeDurationMillis &&
    workingSetSlopeBytesPerHour > config.maxWorkingSetSlopeBytesPerHour
  ) {
    violations.push(
      `工作集线性斜率 ${formatMebibytes(workingSetSlopeBytesPerHour)}/h，预算 ${formatMebibytes(config.maxWorkingSetSlopeBytesPerHour)}/h`,
    );
  }
  if (maximumProcessCount > allowedProcessCount) {
    violations.push(
      `桌面应用进程数峰值 ${maximumProcessCount}，初始 ${normalized[0].processCount}，最多允许新增 ${config.maxAdditionalProcesses}`,
    );
  }
  if (maximumWindowCount > config.maxWindowCount) {
    violations.push(
      `桌面窗口 峰值 ${maximumWindowCount}，预算 ${config.maxWindowCount}`,
    );
  }
  if (minimumVisibleWindowCount < config.minimumVisibleWindowCount) {
    violations.push(
      `可见 桌面窗口 最低 ${minimumVisibleWindowCount}，要求至少 ${config.minimumVisibleWindowCount}`,
    );
  }

  return {
    sampleCount: normalized.length,
    warmupSampleCount,
    analyzedSampleCount,
    analyzedDurationMillis,
    analysisWindowSamples: windowSize,
    baselineWorkingSetBytes,
    endingWorkingSetBytes,
    peakWorkingSetBytes,
    workingSetGrowthBytes,
    workingSetSlopeBytesPerHour: Math.round(workingSetSlopeBytesPerHour),
    initialProcessCount: normalized[0].processCount,
    maximumProcessCount,
    allowedProcessCount,
    maximumWindowCount,
    minimumVisibleWindowCount,
    passed: violations.length === 0,
    violations,
  };
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Soak evaluation options are required");
  }
  return {
    warmupSamples: nonNegativeInteger(options.warmupSamples, "warmupSamples"),
    analysisWindowSamples: positiveInteger(
      options.analysisWindowSamples ?? DEFAULT_ANALYSIS_WINDOW_SAMPLES,
      "analysisWindowSamples",
    ),
    minimumSamples: positiveInteger(options.minimumSamples, "minimumSamples"),
    maxWorkingSetGrowthBytes: nonNegativeNumber(
      options.maxWorkingSetGrowthBytes,
      "maxWorkingSetGrowthBytes",
    ),
    maxWorkingSetSlopeBytesPerHour: nonNegativeNumber(
      options.maxWorkingSetSlopeBytesPerHour,
      "maxWorkingSetSlopeBytesPerHour",
    ),
    minimumSlopeDurationMillis: nonNegativeNumber(
      options.minimumSlopeDurationMillis,
      "minimumSlopeDurationMillis",
    ),
    maxAdditionalProcesses: nonNegativeInteger(
      options.maxAdditionalProcesses,
      "maxAdditionalProcesses",
    ),
    maxWindowCount: positiveInteger(options.maxWindowCount, "maxWindowCount"),
    minimumVisibleWindowCount: nonNegativeInteger(
      options.minimumVisibleWindowCount,
      "minimumVisibleWindowCount",
    ),
  };
}

function normalizeSample(sample, index) {
  if (!sample || typeof sample !== "object") {
    throw new TypeError(`Sample ${index} must be an object`);
  }
  return {
    elapsedMillis: nonNegativeNumber(
      sample.elapsedMillis,
      `samples[${index}].elapsedMillis`,
    ),
    totalWorkingSetBytes: nonNegativeNumber(
      sample.totalWorkingSetBytes,
      `samples[${index}].totalWorkingSetBytes`,
    ),
    processCount: nonNegativeInteger(
      sample.processCount,
      `samples[${index}].processCount`,
    ),
    windowCount: nonNegativeInteger(
      sample.windowCount,
      `samples[${index}].windowCount`,
    ),
    visibleWindowCount: nonNegativeInteger(
      sample.visibleWindowCount,
      `samples[${index}].visibleWindowCount`,
    ),
  };
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function formatMebibytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

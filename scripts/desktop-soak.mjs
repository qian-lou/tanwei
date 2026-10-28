import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { desktopPaths, launchTauri } from "./tauri-driver.mjs";
import { applicationProcesses, readProcessSnapshot } from "./desktop-process-metrics.mjs";
import { evaluateSoakSamples, MEBIBYTE } from "./soak-metrics.mjs";

const TARGET_MAIN_CLASS = "dev.tanwei.integration.TestTargetMain";
const MAX_RECORDED_FAILURES = 100;
const MAX_RECORDED_RENDERER_ERRORS = 100;

const projectRoot = process.cwd();
const { executablePath: defaultExecutablePath, resourcesPath } = desktopPaths(projectRoot);

const config = readConfig();
const startedAt = new Date();
const report = {
  schemaVersion: 1,
  product: "tanwei",
  kind: "desktop-soak",
  engine: "tauri",
  resourceAccounting: process.platform === "darwin"
    ? "Host descendants plus all post-launch WebKit XPC helpers; conservative when other WebKit apps launch concurrently"
    : "Host process and operating-system descendants",
  mode: config.durationSeconds <= 300 ? "smoke" : "soak",
  platform: process.platform,
  architecture: process.arch,
  startedAt: startedAt.toISOString(),
  endedAt: null,
  elapsedMillis: 0,
  config: publicConfig(config),
  target: null,
  cycles: {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    rendererReloads: 0,
    windowLifecycleCycles: 0,
  },
  samples: [],
  failures: [],
  rendererErrors: [],
  metrics: null,
  fatalError: null,
  cleanupErrors: [],
  passed: false,
};

try {
  await runSoak(config, report);
} catch (error) {
  report.fatalError = errorMessage(error);
} finally {
  report.endedAt = new Date().toISOString();
  report.elapsedMillis = Date.now() - startedAt.getTime();
  if (report.samples.length > 0) {
    try {
      report.metrics = evaluateSoakSamples(report.samples, {
        warmupSamples: config.warmupSamples,
        analysisWindowSamples: config.analysisWindowSamples,
        minimumSamples: config.minimumSamples,
        maxWorkingSetGrowthBytes: config.maxWorkingSetGrowthBytes,
        maxWorkingSetSlopeBytesPerHour:
          config.maxWorkingSetSlopeBytesPerHour,
        minimumSlopeDurationMillis: config.minimumSlopeDurationMillis,
        maxAdditionalProcesses: config.maxAdditionalProcesses,
        maxWindowCount: 1,
        minimumVisibleWindowCount: 1,
      });
    } catch (error) {
      report.fatalError ??= `无法评估 Soak 指标：${errorMessage(error)}`;
    }
  }
  report.passed = Boolean(
    !report.fatalError &&
      report.cleanupErrors.length === 0 &&
      report.rendererErrors.length === 0 &&
      report.cycles.failed <= config.maxOperationFailures &&
      report.cycles.succeeded >= config.minimumSamples &&
      report.metrics?.passed,
  );
  await writeReport(config.reportPath, report);
}

const resultLabel = report.passed ? "PASS" : "FAIL";
process.stdout.write(
  `[tanwei-soak] ${resultLabel} · ${report.cycles.succeeded}/${report.cycles.attempted} cycles · report ${config.reportPath}\n`,
);
if (!report.passed) {
  const reasons = [
    report.fatalError,
    ...report.failures.map((failure) => failure.message),
    ...(report.metrics?.violations ?? []),
    ...report.cleanupErrors,
  ].filter(Boolean);
  process.stderr.write(`${reasons.slice(0, 12).join("\n")}\n`);
  process.exitCode = 1;
}

async function runSoak(runConfig, runReport) {
  await verifyInputs(runConfig);
  const javaExecutable = path.join(
    resourcesPath,
    "runtime",
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  const targetClasses = path.join(
    projectRoot,
    "jvm",
    "integration-tests",
    "target",
    "test-classes",
  );
  const targetLog4jRuntime = path.join(
    projectRoot,
    "jvm",
    "integration-tests",
    "target",
    "e2e-libs",
    "log4j-1.2.17.jar",
  );

  let targetProcess = null;
  let desktopApplication = null;
  let userDataDirectory = null;
  let closingApplication = false;
  let applicationClosed = false;
  let targetExited = false;
  let targetOutput = null;
  let processBaseline = new Set();

  try {
    targetProcess = spawn(
      javaExecutable,
      [
        "-cp",
        [targetClasses, targetLog4jRuntime].join(path.delimiter),
        TARGET_MAIN_CLASS,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LANG: "en_US.UTF-8",
          TANWEI_E2E_TOKEN: "never-return-this-secret",
        },
      },
    );
    targetOutput = collectChildOutput(targetProcess);
    targetProcess.once("exit", () => {
      targetExited = true;
    });
    await waitForOutput(targetProcess, "TANWEI_TEST_TARGET_READY", 20_000);
    if (!targetProcess.pid) {
      throw new Error("测试 JVM 未获得有效 PID");
    }

    userDataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "tanwei-desktop-soak-"),
    );
    processBaseline = new Set((await readProcessSnapshot()).map((row) => row.pid));
    desktopApplication = await launchTauri({
      executablePath: runConfig.executablePath,
      env: {
        ...process.env,
        TANWEI_E2E: "1",
        TANWEI_USER_DATA_DIR: userDataDirectory,
        TANWEI_RESOURCES_DIR: resourcesPath,
      },
    });
    desktopApplication.process.on("exit", () => {
      if (!closingApplication) applicationClosed = true;
    });
    const browser = desktopApplication.browser;
    const page = {
      evaluate: (fn, arg) => browser.execute(fn, arg),
      reload: () => browser.refresh(),
      async waitForFunction(fn, _arg, { timeout = 30_000 } = {}) {
        const deadline = Date.now() + timeout;
        let lastError = "条件尚未满足";
        while (Date.now() < deadline) {
          try {
            if (await browser.execute(fn)) return;
          } catch (error) {
            // A refresh can replace WKWebView's JavaScript context before the
            // first condition probe runs; keep the original bounded wait.
            lastError = errorMessage(error);
          }
          await delay(100);
        }
        throw new Error(`等待 Tauri 前端条件超时：${lastError}`);
      },
    };
    await waitForDesktopApi(page);
    await installRendererErrorCapture(page);

    const target = await waitForTarget(page, targetProcess.pid, 30_000);
    const connection = await withTimeout(
      page.evaluate(async (targetId) => {
        const result = await window.tanwei.connectTarget(targetId);
        if (!result.ok || !result.value) {
          throw new Error(
            `connectTarget failed: ${result.errorCode ?? "UNKNOWN"} ${result.errorMessage ?? ""}`,
          );
        }
        return result.value;
      }, target.id),
      45_000,
      "连接测试 JVM 超时",
    );
    if (connection.state !== "READY") {
      throw new Error(`测试 JVM 连接状态不是 READY：${connection.state}`);
    }
    runReport.target = {
      pid: target.pid,
      id: target.id,
      mainClass: target.mainClass,
      javaVersion: connection.javaVersion,
      protocolVersion: connection.protocolVersion,
      agentVersion: connection.agentVersion,
    };

    const runStartedAt = performance.now();
    for (let cycle = 1; cycle <= runConfig.maximumCycles; cycle += 1) {
      if (
        applicationClosed ||
        targetExited ||
        performance.now() - runStartedAt >= runConfig.durationMillis
      ) {
        break;
      }
      runReport.cycles.attempted += 1;
      const cycleStartedAt = performance.now();
      let operationSummary = null;
      try {
        operationSummary = await runDiagnosticCycle(
          page,
          target.id,
          cycle,
          runConfig,
        );
        runReport.cycles.succeeded += 1;
      } catch (error) {
        runReport.cycles.failed += 1;
        appendBounded(
          runReport.failures,
          {
            cycle,
            elapsedMillis: Math.round(performance.now() - runStartedAt),
            message: errorMessage(error),
          },
          MAX_RECORDED_FAILURES,
        );
      }

      const errors = await page.evaluate(() => window.__tanweiSoakErrors?.splice(0) ?? []);
      for (const error of errors) appendBounded(runReport.rendererErrors, error, MAX_RECORDED_RENDERER_ERRORS);

      if (
        runConfig.windowLifecycleEvery > 0 &&
        cycle % runConfig.windowLifecycleEvery === 0
      ) {
        await cycleWindowVisibility(desktopApplication);
        runReport.cycles.windowLifecycleCycles += 1;
      }
      if (
        runConfig.rendererReloadEvery > 0 &&
        cycle % runConfig.rendererReloadEvery === 0
      ) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await waitForDesktopApi(page);
        await installRendererErrorCapture(page);
        await assertReadyConnection(page, target.id);
        runReport.cycles.rendererReloads += 1;
      }

      const applicationSample = await collectApplicationSample(desktopApplication, processBaseline);
      runReport.samples.push({
        cycle,
        capturedAt: new Date().toISOString(),
        elapsedMillis: Math.round(performance.now() - runStartedAt),
        cycleDurationMillis: Math.round(performance.now() - cycleStartedAt),
        operationSummary,
        ...applicationSample,
      });

      if (cycle === 1 || cycle % runConfig.progressEvery === 0) {
        process.stdout.write(
          `[tanwei-soak] cycle ${cycle}/${runConfig.maximumCycles} · ${(applicationSample.totalWorkingSetBytes / MEBIBYTE).toFixed(1)} MiB · ${applicationSample.processCount} processes\n`,
        );
      }
      const nextCycleAt =
        runStartedAt + Math.min(runConfig.durationMillis, cycle * runConfig.intervalMillis);
      const remainingMillis = nextCycleAt - performance.now();
      if (remainingMillis > 0) {
        await delay(remainingMillis);
      }
    }

    if (applicationClosed) {
      throw new Error("Tauri 应用在 Soak 期间意外退出");
    }
    if (targetExited) {
      throw new Error(
        `测试 JVM 在 Soak 期间意外退出：${targetOutput?.tail() ?? "无输出"}`,
      );
    }
  } finally {
    closingApplication = true;
    if (desktopApplication) {
      try {
        if (runReport.target?.id) {
          const result = await desktopApplication.browser.execute((id) => window.tanwei.disconnectTarget(id), runReport.target.id);
          if (!result.ok) throw new Error(result.errorMessage ?? "断开 Soak JVM 失败");
        }
      } catch (error) {
        runReport.cleanupErrors.push(
          `关闭 Tauri 失败：${errorMessage(error)}`,
        );
      } finally {
        try { await desktopApplication.close(); } catch (error) {
          runReport.cleanupErrors.push(`关闭 Tauri WebDriver 会话失败：${errorMessage(error)}`);
        }
      }
    }
    if (targetProcess) {
      try {
        await terminateChild(targetProcess);
      } catch (error) {
        runReport.cleanupErrors.push(
          `关闭测试 JVM 失败：${errorMessage(error)}`,
        );
      }
    }
    if (userDataDirectory) {
      try {
        await rm(userDataDirectory, { recursive: true, force: true });
      } catch (error) {
        runReport.cleanupErrors.push(
          `清理临时用户目录失败：${errorMessage(error)}`,
        );
      }
    }
  }
}

async function runDiagnosticCycle(page, targetId, cycle, runConfig) {
  return withTimeout(
    page.evaluate(
      async ({ id, includeJit, includeRepository }) => {
        const durations = {};
        const invoke = async (name, operation) => {
          const startedAt = performance.now();
          const result = await operation();
          durations[name] = Math.round(performance.now() - startedAt);
          if (!result?.ok || result.value === null) {
            throw new Error(
              `${name} failed: ${result?.errorCode ?? "UNKNOWN"} ${result?.errorMessage ?? ""}`,
            );
          }
          return result.value;
        };

        const connections = await invoke("listConnections", () =>
          window.tanwei.listConnections(),
        );
        const connection = connections.find((candidate) => candidate.target.id === id);
        if (connection?.state !== "READY") {
          throw new Error(
            `connection is ${connection?.state ?? "MISSING"}, expected READY`,
          );
        }
        const snapshot = await invoke("getSnapshot", () =>
          window.tanwei.getSnapshot(id),
        );
        if (snapshot.targetId !== id || snapshot.uptimeMillis < 0) {
          throw new Error("snapshot identity or uptime is invalid");
        }
        const threads = await invoke("listThreads", () =>
          window.tanwei.listThreads(id, {
            offset: 0,
            limit: 50,
            query: "",
            stackDepth: 0,
            state: "",
          }),
        );
        if (threads.total < 1 || threads.items.length > 50) {
          throw new Error("thread page violated its bounded contract");
        }

        let jitStatus = null;
        if (includeJit) {
          const jit = await invoke("jitCompilerSummary", () =>
            window.tanwei.executeAction({
              targetId: id,
              actionId: "jit.compiler.summary",
              parameters: {},
            }),
          );
          if (jit.status !== "SUCCEEDED") {
            throw new Error(
              `jit.compiler.summary returned ${jit.status}: ${jit.message ?? ""}`,
            );
          }
          jitStatus = jit.status;
        }

        let artifactCount = null;
        let alertCount = null;
        if (includeRepository) {
          const artifacts = await invoke("listArtifacts", () =>
            window.tanwei.listArtifacts(),
          );
          const alerts = await invoke("listDiagnosticAlerts", () =>
            window.tanwei.listDiagnosticAlerts(),
          );
          artifactCount = artifacts.length;
          alertCount = alerts.length;
        }
        return {
          durations,
          liveThreads: snapshot.liveThreads,
          returnedThreads: threads.items.length,
          jitStatus,
          artifactCount,
          alertCount,
        };
      },
      {
        id: targetId,
        includeJit: cycle % runConfig.jitEvery === 0,
        includeRepository: cycle % runConfig.repositoryEvery === 0,
      },
    ),
    runConfig.operationTimeoutMillis,
    `第 ${cycle} 轮诊断超时`,
  );
}

async function waitForTarget(page, expectedPid, timeoutMillis) {
  const deadline = Date.now() + timeoutMillis;
  let lastError = "目标尚未出现";
  while (Date.now() < deadline) {
    try {
      const result = await page.evaluate(() => window.tanwei.listTargets());
      if (!result.ok || !result.value) {
        lastError = `${result.errorCode ?? "UNKNOWN"} ${result.errorMessage ?? ""}`;
      } else {
        const target = result.value.find(
          (candidate) => candidate.pid === expectedPid,
        );
        if (target) {
          return target;
        }
      }
    } catch (error) {
      lastError = errorMessage(error);
    }
    await delay(250);
  }
  throw new Error(`未发现测试 JVM PID ${expectedPid}：${lastError}`);
}

async function waitForDesktopApi(page) {
  await page.waitForFunction(
    () =>
      Boolean(
        window.tanwei?.listConnections && window.tanwei?.getSnapshot,
      ),
    undefined,
    { timeout: 30_000 },
  );
}

async function assertReadyConnection(page, targetId) {
  await withTimeout(
    page.evaluate(async (id) => {
      const result = await window.tanwei.listConnections();
      if (!result.ok || !result.value) {
        throw new Error(
          `listConnections failed after reload: ${result.errorCode ?? "UNKNOWN"} ${result.errorMessage ?? ""}`,
        );
      }
      const connection = result.value.find(
        (candidate) => candidate.target.id === id,
      );
      if (connection?.state !== "READY") {
        throw new Error(
          `connection after reload is ${connection?.state ?? "MISSING"}`,
        );
      }
    }, targetId),
    30_000,
    "Renderer 重载后连接校验超时",
  );
}

async function cycleWindowVisibility(application) {
  await application.browser.execute(async () => {
    const result = await window.__TAURI_INTERNALS__.invoke("host_call", { method: "__testWindowLifecycle", args: [] });
    if (result?.ok === false) throw new Error(result.errorMessage ?? "窗口生命周期检查失败");
  });
}

async function installRendererErrorCapture(page) {
  await page.evaluate(() => {
    if (window.__tanweiSoakErrors) return;
    window.__tanweiSoakErrors = [];
    const record = (value) => {
      if (window.__tanweiSoakErrors.length < 100) window.__tanweiSoakErrors.push(String(value));
    };
    window.addEventListener("error", (event) => record(event.error?.stack ?? event.message));
    window.addEventListener("unhandledrejection", (event) => record(event.reason?.stack ?? event.reason));
  });
}

async function collectApplicationSample(application, baselinePids) {
  const rows = await readProcessSnapshot();
  const processes = applicationProcesses(rows, application.process.pid, baselinePids);
  const windows = await application.browser.execute(async () => {
    const result = await window.__TAURI_INTERNALS__.invoke("host_call", { method: "__testWindows", args: [] });
    if (!result?.ok || !result.value) throw new Error(result?.errorMessage ?? "无法采样 Tauri 窗口状态");
    return result.value;
  });
  return {
    windowCount: windows.windowCount,
    visibleWindowCount: windows.visibleWindowCount,
    processCount: processes.length,
    totalWorkingSetBytes: processes.reduce((sum, item) => sum + item.workingSetBytes, 0),
    processes,
  };
}

async function verifyInputs(runConfig) {
  const javaExecutable = path.join(
    resourcesPath,
    "runtime",
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  const requiredPaths = [
    runConfig.executablePath,
    javaExecutable,
    path.join(
      projectRoot,
      "jvm",
      "integration-tests",
      "target",
      "test-classes",
      ...TARGET_MAIN_CLASS.split("."),
    ) + ".class",
    path.join(
      projectRoot,
      "jvm",
      "integration-tests",
      "target",
      "e2e-libs",
      "log4j-1.2.17.jar",
    ),
  ];
  try {
    await Promise.all(requiredPaths.map((requiredPath) => access(requiredPath)));
  } catch (error) {
    throw new Error(
      `Soak 输入不完整，请先运行 npm run package:test：${errorMessage(error)}`,
    );
  }
}

function readConfig() {
  const durationSeconds = integerEnv(
    "TANWEI_SOAK_DURATION_SECONDS",
    28_800,
    30,
    43_200,
  );
  const intervalMillis = integerEnv(
    "TANWEI_SOAK_INTERVAL_MS",
    5_000,
    500,
    60_000,
  );
  const maximumCycles = Math.ceil((durationSeconds * 1_000) / intervalMillis);
  if (maximumCycles > 20_000) {
    throw new RangeError(
      `Soak 循环 ${maximumCycles} 超过 20,000 上限，请增大采样间隔`,
    );
  }
  const warmupSeconds = integerEnv(
    "TANWEI_SOAK_WARMUP_SECONDS",
    300,
    0,
    Math.max(300, durationSeconds),
  );
  const executableOverride = process.env.TANWEI_SOAK_EXECUTABLE?.trim();
  const reportOverride = process.env.TANWEI_SOAK_REPORT?.trim();
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return {
    durationSeconds,
    durationMillis: durationSeconds * 1_000,
    intervalMillis,
    maximumCycles,
    minimumSamples: Math.min(10, maximumCycles),
    warmupSamples: Math.ceil((warmupSeconds * 1_000) / intervalMillis),
    analysisWindowSamples: integerEnv(
      "TANWEI_SOAK_ANALYSIS_WINDOW_SAMPLES",
      20,
      1,
      1_000,
    ),
    rendererReloadEvery: integerEnv(
      "TANWEI_SOAK_RELOAD_EVERY",
      120,
      0,
      20_000,
    ),
    windowLifecycleEvery: integerEnv(
      "TANWEI_SOAK_LIFECYCLE_EVERY",
      60,
      0,
      20_000,
    ),
    jitEvery: integerEnv("TANWEI_SOAK_JIT_EVERY", 6, 1, 20_000),
    repositoryEvery: integerEnv(
      "TANWEI_SOAK_REPOSITORY_EVERY",
      12,
      1,
      20_000,
    ),
    progressEvery: integerEnv(
      "TANWEI_SOAK_PROGRESS_EVERY",
      60,
      1,
      20_000,
    ),
    operationTimeoutMillis: integerEnv(
      "TANWEI_SOAK_OPERATION_TIMEOUT_MS",
      30_000,
      5_000,
      60_000,
    ),
    maxOperationFailures: integerEnv(
      "TANWEI_SOAK_MAX_OPERATION_FAILURES",
      0,
      0,
      100,
    ),
    maxWorkingSetGrowthBytes:
      integerEnv("TANWEI_SOAK_MAX_MEMORY_GROWTH_MIB", 256, 16, 4_096) *
      MEBIBYTE,
    maxWorkingSetSlopeBytesPerHour:
      integerEnv("TANWEI_SOAK_MAX_MEMORY_SLOPE_MIB_HOUR", 96, 1, 2_048) *
      MEBIBYTE,
    minimumSlopeDurationMillis:
      integerEnv(
        "TANWEI_SOAK_MIN_SLOPE_DURATION_SECONDS",
        600,
        60,
        7_200,
      ) * 1_000,
    maxAdditionalProcesses: integerEnv(
      "TANWEI_SOAK_MAX_ADDITIONAL_PROCESSES",
      3,
      0,
      20,
    ),
    executablePath: path.resolve(executableOverride || defaultExecutablePath),
    reportPath: path.resolve(
      reportOverride ||
        path.join(projectRoot, "output", "soak", `desktop-soak-${timestamp}.json`),
    ),
  };
}

function publicConfig(runConfig) {
  return {
    durationSeconds: runConfig.durationSeconds,
    intervalMillis: runConfig.intervalMillis,
    maximumCycles: runConfig.maximumCycles,
    minimumSamples: runConfig.minimumSamples,
    warmupSamples: runConfig.warmupSamples,
    analysisWindowSamples: runConfig.analysisWindowSamples,
    rendererReloadEvery: runConfig.rendererReloadEvery,
    windowLifecycleEvery: runConfig.windowLifecycleEvery,
    jitEvery: runConfig.jitEvery,
    repositoryEvery: runConfig.repositoryEvery,
    operationTimeoutMillis: runConfig.operationTimeoutMillis,
    maxOperationFailures: runConfig.maxOperationFailures,
    maxWorkingSetGrowthBytes: runConfig.maxWorkingSetGrowthBytes,
    maxWorkingSetSlopeBytesPerHour:
      runConfig.maxWorkingSetSlopeBytesPerHour,
    minimumSlopeDurationMillis: runConfig.minimumSlopeDurationMillis,
    maxAdditionalProcesses: runConfig.maxAdditionalProcesses,
    executablePath: runConfig.executablePath,
    reportPath: runConfig.reportPath,
  };
}

function integerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} 必须是 ${minimum}—${maximum} 的整数，收到 ${raw ?? "空值"}`,
    );
  }
  return value;
}

function collectChildOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-65_536);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { tail: () => output };
}

function waitForOutput(child, marker, timeoutMillis) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let timeout;
    const inspect = (chunk) => {
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(
        -(marker.length + 1_024),
      );
      if (buffered.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `测试 JVM 在就绪前退出：code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", inspect);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`测试 JVM 未在时限内输出 ${marker}`));
    }, timeoutMillis);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", inspect);
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function writeReport(reportPath, value) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, reportPath);
}

function withTimeout(promise, timeoutMillis, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMillis);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function appendBounded(values, value, maximum) {
  if (values.length < maximum) {
    values.push(value);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

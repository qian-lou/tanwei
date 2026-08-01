import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

const projectRoot = process.cwd();
const packagedRoot = path.join(
  projectRoot,
  "apps",
  "desktop",
  "release",
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? "mac-arm64"
      : "mac"
    : process.platform === "win32"
      ? "win-unpacked"
      : "linux-unpacked",
);
const executablePath =
  process.env.TANWEI_E2E_EXECUTABLE?.trim() ??
  (process.platform === "darwin"
    ? path.join(packagedRoot, "探微.app", "Contents", "MacOS", "探微")
    : process.platform === "win32"
      ? path.join(packagedRoot, "探微.exe")
      : path.join(packagedRoot, "tanwei"));
const resourcesPath =
  process.platform === "darwin"
    ? path.join(packagedRoot, "探微.app", "Contents", "Resources")
    : path.join(packagedRoot, "resources");

let targetProcess: ChildProcess | null = null;
let electronApplication: ElectronApplication | null = null;
let page: Page | null = null;
let userDataDirectory: string | null = null;

test.beforeAll(async () => {
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
  targetProcess = spawn(
    javaExecutable,
    [
      "-cp",
      [targetClasses, targetLog4jRuntime].join(path.delimiter),
      "dev.tanwei.integration.TestTargetMain",
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
  await waitForOutput(targetProcess, "TANWEI_TEST_TARGET_READY");

  userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "tanwei-desktop-e2e-"),
  );
  electronApplication = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      TANWEI_E2E: "1",
      TANWEI_USER_DATA_DIR: userDataDirectory,
    },
  });
  page = await electronApplication.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await electronApplication
    ?.evaluate(({ app }) => {
      setImmediate(() => app.exit(0));
    })
    .catch(() => undefined);
  await electronApplication?.close().catch(() => undefined);
  targetProcess?.kill();
  targetProcess = null;
  if (userDataDirectory) {
    await rm(userDataDirectory, { recursive: true, force: true });
    userDataDirectory = null;
  }
});

test("main window becomes visible after the renderer loads", async () => {
  const application = requiredElectronApplication();
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await mkdir(path.join(projectRoot, "output", "playwright"), {
    recursive: true,
  });
  await requiredPage().screenshot({
    path: path.join(projectRoot, "output", "playwright", "shadcn-shell.png"),
    fullPage: true,
  });
});

test("main window keeps native chrome consistent with the dark renderer", async () => {
  const appearance = await requiredElectronApplication().evaluate(
    ({ BrowserWindow, nativeTheme }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) {
        throw new Error("Main BrowserWindow is unavailable");
      }
      return {
        backgroundColor: mainWindow.getBackgroundColor().toLowerCase(),
        shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
        shouldUseDarkColorsForSystemIntegratedUI:
          nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
        themeSource: nativeTheme.themeSource,
      };
    },
  );

  expect(appearance).toEqual({
    backgroundColor: "#0a0a0a",
    shouldUseDarkColors: true,
    shouldUseDarkColorsForSystemIntegratedUI: true,
    themeSource: "dark",
  });
});

test("packaged app discovers, attaches and renders real diagnostics", async () => {
  test.setTimeout(240_000);
  const window = requiredPage();
  await expect(window).toHaveTitle(/探微/);
  await expect(
    window.getByRole("heading", { name: "连接目标。" }),
  ).toBeVisible();
  const connectionTabs = window.getByRole("tablist", {
    name: "目标连接方式",
  });
  await expect(connectionTabs).toBeVisible();
  await expect(connectionTabs.getByRole("tab")).toHaveCount(4);
  await connectionTabs.getByRole("tab", { name: "SSH", exact: true }).click();
  await expect(
    connectionTabs.getByRole("tab", { name: "SSH", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    window.getByRole("heading", { name: "通过 SSH 连接远程 JVM" }),
  ).toBeVisible();
  await expect(window.getByLabel("主机")).toBeVisible();
  await mkdir(path.join(projectRoot, "output", "playwright"), {
    recursive: true,
  });
  await window.locator("section.targets-view").screenshot({
    path: path.join(projectRoot, "output", "playwright", "remote-targets.png"),
    animations: "disabled",
  });
  await connectionTabs
    .getByRole("tab", { name: "Kubernetes", exact: true })
    .click();
  await expect(
    window.getByRole("heading", { name: "连接 Kubernetes Pod 内的 JVM" }),
  ).toBeVisible();
  await connectionTabs
    .getByRole("tab", { name: "持久 Relay", exact: true })
    .click();
  await expect(
    window.getByRole("heading", { name: "连接已安装的持久 Relay" }),
  ).toBeVisible();
  await expect(window.getByLabel("TLS 服务名")).toBeVisible();
  await connectionTabs.getByRole("tab", { name: "本机", exact: true }).click();
  const targetRow = window
    .locator("article.target-row")
    .filter({ hasText: "dev.tanwei.integration.TestTargetMain" });
  await expect(targetRow).toBeVisible();
  const targetActionStyles = await window
    .locator(
      "section.targets-view button[data-slot=button]:visible:not([aria-pressed])",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          variant: element.getAttribute("data-variant"),
          borderRadius: style.borderRadius,
          backgroundColor: style.backgroundColor,
        };
      }),
    );
  expect(targetActionStyles.length).toBeGreaterThan(1);
  expect(targetActionStyles.every(({ variant }) => variant === "outline")).toBe(
    true,
  );
  expect(
    new Set(targetActionStyles.map(({ borderRadius }) => borderRadius)),
  ).toEqual(new Set(["8px"]));
  const statusBadgeRadii = await window
    .locator(
      ".status-pill:visible, article.target-row [data-slot=badge]:visible",
    )
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderRadius),
    );
  expect(statusBadgeRadii.length).toBeGreaterThan(1);
  expect(new Set(statusBadgeRadii)).toEqual(new Set(["8px"]));
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "target-shadcn-local.png",
    ),
    fullPage: true,
    animations: "disabled",
  });

  const targetDesktopViewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await window.setViewportSize({ width: 767, height: 720 });
  await expect
    .poll(() =>
      window.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "target-shadcn-narrow.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await window.setViewportSize(targetDesktopViewport);
  await expect
    .poll(() => window.evaluate(() => window.innerWidth))
    .toBe(targetDesktopViewport.width);

  await window.getByRole("link", { name: /设置/ }).click();
  await selectShadcnValue(window.getByLabel("允许的最高风险等级"), "R4");
  const systemNotificationPolicy = window.getByTestId(
    "system-notification-policy",
  );
  await expect(systemNotificationPolicy).toContainText("仅严重事件（推荐）");
  await systemNotificationPolicy.click();
  await window.getByRole("option", { name: "警告与严重事件" }).click();
  await window.getByRole("button", { name: "保存设置" }).click();
  await expect(window.getByText("设置已写入事务。")).toBeVisible();
  await window.getByRole("link", { name: /目标/ }).click();

  await expect(targetRow).toBeVisible();
  await targetRow.getByRole("button", { name: "连接" }).click();

  await expect(
    window.getByRole("heading", { name: "运行正在发生。" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(window.getByText(/AGENT 0\.1\.0/)).toBeVisible();
  await expect(window.getByText("HEAP USED")).toBeVisible();
  await expect(window.getByText("等待目标数据")).toHaveCount(0, {
    timeout: 15_000,
  });
  const refreshOverview = window.getByRole("button", { name: "立即刷新" });
  await refreshOverview.click();
  const runtimeCorrelation = window.getByTestId("runtime-correlation");
  await expect(
    runtimeCorrelation.getByRole("heading", {
      name: "运行时关联",
    }),
  ).toBeVisible();
  const runtimeSignalCharts = runtimeCorrelation.locator(
    '[data-slot="chart"]',
  );
  await expect(runtimeSignalCharts).toHaveCount(4, { timeout: 10_000 });
  await expect(runtimeSignalCharts.first()).toBeVisible();
  await expect(runtimeCorrelation).toContainText(/1 个有效区间/u);
  for (let expectedIntervals = 2; expectedIntervals <= 5; expectedIntervals += 1) {
    await refreshOverview.click();
    await expect(runtimeCorrelation).toContainText(
      `${expectedIntervals} 个有效区间`,
    );
  }
  await screenshotVisiblePanel(
    window,
    runtimeCorrelation,
    "runtime-correlation.png",
  );
  await window.locator(".workspace__content").evaluate((element) => {
    element.scrollTo({ top: 0, left: 0 });
  });
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "overview-shadcn.png"),
    animations: "disabled",
  });

  const overviewDesktopViewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await window.setViewportSize({ width: 767, height: 720 });
  const overviewMetricCards = window
    .getByTestId("overview-metrics")
    .locator("[data-runtime-metric]");
  await expect(overviewMetricCards).toHaveCount(4);
  const firstMetricBox = await overviewMetricCards.nth(0).boundingBox();
  const secondMetricBox = await overviewMetricCards.nth(1).boundingBox();
  expect(firstMetricBox).not.toBeNull();
  expect(secondMetricBox).not.toBeNull();
  expect(secondMetricBox?.y ?? 0).toBeGreaterThan(
    (firstMetricBox?.y ?? 0) + (firstMetricBox?.height ?? 0) - 1,
  );
  await window.locator("section.overview-view").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "overview-shadcn-narrow.png",
    ),
    animations: "disabled",
  });
  await window.setViewportSize(overviewDesktopViewport);
  await expect
    .poll(() => window.evaluate(() => window.innerWidth))
    .toBe(overviewDesktopViewport.width);

  await window.keyboard.press("Meta+K");
  const capabilityPalette = window.getByRole("dialog", {
    name: "全部诊断能力。",
  });
  await expect(capabilityPalette).toBeVisible();
  await expect(capabilityPalette).toHaveAttribute(
    "data-slot",
    "dialog-content",
  );
  const capabilitySearch = capabilityPalette.getByRole("combobox", {
    name: "按能力、问题或参考术语搜索",
  });
  await expect(capabilitySearch).toHaveAttribute("data-slot", "command-input");
  await capabilitySearch.fill("vmoption");
  const vmOptionCapability = capabilityPalette.getByRole("option", {
    name: /VM Option Inspector/,
  });
  await expect(vmOptionCapability).toBeVisible();
  await expect(vmOptionCapability).toHaveAttribute("data-slot", "command-item");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "capability-launcher.png",
    ),
  });
  await vmOptionCapability.click();
  await expect(
    window.getByRole("heading", {
      name: "检查 HotSpot 选项，再决定是否修改。",
    }),
  ).toBeVisible();

  await window.getByRole("link", { name: /线程/ }).click();
  await expect(
    window.getByRole("heading", { name: "线程与锁。" }),
  ).toBeVisible();
  await expect(window.locator(".thread-row").first()).toBeVisible();
  const threadPoolConfirmation = window.getByLabel(
    "我确认执行一次有界的 JVMTI 线程池实例扫描。",
  );
  await threadPoolConfirmation.check();
  await window.getByRole("button", { name: "检查线程池" }).click();
  await expect(threadPoolConfirmation).not.toBeChecked();
  await expect(window.locator(".thread-pool-card").first()).toBeVisible();
  await expect(
    window
      .locator(".thread-pool-card")
      .filter({
        hasText: "ThreadPoolExecutor",
      })
      .first(),
  ).toBeVisible();
  const businessExecutorCard = window
    .locator(".thread-pool-card")
    .filter({ hasText: "TestTargetMain$$Lambda" })
    .filter({
      has: window.locator(".eyebrow", {
        hasText: "ThreadPoolExecutor",
      }),
    });
  const latencyExecutorCard = window
    .locator(".thread-pool-card")
    .filter({ hasText: "LatencyThreadFactory" })
    .filter({
      has: window.locator(".eyebrow", {
        hasText: "ThreadPoolExecutor",
      }),
    });
  const scheduledExecutorCard = window
    .locator(".thread-pool-card")
    .filter({ hasText: "TestTargetMain$$Lambda" })
    .filter({
      has: window.locator(".eyebrow", {
        hasText: "ScheduledThreadPool",
      }),
    });
  const forkJoinPoolCard = window
    .locator(".thread-pool-card")
    .filter({ hasText: "IntegrationForkJoinWorkerFactory" })
    .filter({
      has: window.locator(".eyebrow", {
        hasText: "ForkJoinPool",
      }),
    });
  await expect(businessExecutorCard).toBeVisible();
  await expect(latencyExecutorCard).toBeVisible();
  await expect(scheduledExecutorCard).toBeVisible();
  await expect(forkJoinPoolCard).toBeVisible();
  await businessExecutorCard.getByRole("button", { name: "查看成员" }).click();
  const poolMemberInspector = window.locator(".thread-pool-member-inspector");
  await expect(poolMemberInspector).toBeVisible();
  const exactBusinessPoolIdentity =
    (
      await poolMemberInspector
        .locator("#thread-pool-member-title")
        .textContent()
    )?.trim() ?? "";
  expect(exactBusinessPoolIdentity).toMatch(/^ThreadPoolExecutor@[0-9a-f]+$/u);
  await poolMemberInspector
    .getByTestId("thread-pool-alias-input")
    .fill("订单异步池");
  await poolMemberInspector.getByTestId("thread-pool-alias-save").click();
  await expect(poolMemberInspector).toContainText("本地业务别名已保存。");
  await expect(
    poolMemberInspector.getByRole("heading", {
      name: "订单异步池",
      level: 3,
    }),
  ).toBeVisible();
  await expect(poolMemberInspector).toContainText(exactBusinessPoolIdentity);
  await threadPoolConfirmation.check();
  await window.getByRole("button", { name: "检查线程池" }).click();
  await expect(threadPoolConfirmation).not.toBeChecked();
  await expect(
    poolMemberInspector.getByRole("heading", {
      name: "订单异步池",
      level: 3,
    }),
  ).toBeVisible();
  await expect(poolMemberInspector).toContainText(exactBusinessPoolIdentity);
  const poolTaskEvidence = poolMemberInspector.locator(
    ".thread-pool-task-evidence",
  );
  await expect(
    poolTaskEvidence.getByRole("heading", {
      name: "任务堆积在哪里，成员又停在哪里。",
    }),
  ).toBeVisible();
  await expect(poolTaskEvidence).toContainText(
    "ThreadPoolExecutor$AbortPolicy",
  );
  await expect(poolTaskEvidence).toContainText("DatabaseBacklogTask");
  await expect(poolTaskEvidence).toContainText(
    "ThreadPoolEvidenceTasks#holdWorkerForDownstreamDependency",
  );
  await screenshotVisiblePanel(
    window,
    poolTaskEvidence,
    "thread-pool-task-evidence.png",
  );
  const workerPoolMember = poolMemberInspector
    .locator("button.thread-pool-member-row")
    .filter({ hasText: "integration-worker-pool-1" });
  await expect(workerPoolMember).toBeVisible();
  await expect(workerPoolMember).toContainText("main");
  await poolMemberInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-pool-alias-members.png",
    ),
  });
  const poolTrendRecorder = poolMemberInspector.locator(
    ".thread-pool-trend-recorder",
  );
  await selectShadcnValue(poolTrendRecorder.getByLabel("池采样间隔"), "2000");
  for (let windowIndex = 0; windowIndex < 2; windowIndex += 1) {
    await poolTrendRecorder
      .getByTestId("thread-pool-trend-confirmation")
      .check();
    await poolTrendRecorder.getByTestId("thread-pool-trend-start").click();
    await expect(poolTrendRecorder.getByRole("img")).toHaveAttribute(
      "aria-label",
      /最近 (?:[2-9]|[1-9]\d|1[01]\d|120) 个精确线程池样本/u,
      { timeout: 30_000 },
    );
    await poolTrendRecorder.getByTestId("thread-pool-trend-stop").click();
    await poolTrendRecorder.getByTestId("thread-pool-trend-save").click();
    await expect(poolTrendRecorder).toContainText("已校验并写入本地制品");
  }
  await latencyExecutorCard.getByRole("button", { name: "查看成员" }).click();
  await expect(poolMemberInspector).toContainText("LatencyThreadFactory");
  const latencyProbe = poolMemberInspector.locator(
    ".thread-pool-latency-probe",
  );
  await expect(
    latencyProbe.getByRole("heading", {
      name: "测量任务等了多久，又执行了多久。",
    }),
  ).toBeVisible();
  await latencyProbe.getByTestId("thread-pool-latency-confirmation").check();
  await latencyProbe.getByTestId("thread-pool-latency-start").click();
  await expect(latencyProbe).toContainText("时长归因中");
  await expect(latencyProbe).toContainText("MeasuredLatencyTask", {
    timeout: 10_000,
  });
  await expect(latencyProbe).toContainText("个匹配提交");
  await screenshotVisiblePanel(
    window,
    latencyProbe,
    "thread-pool-latency-attribution.png",
  );
  await latencyProbe.getByTestId("thread-pool-latency-stop").click();
  await expect(latencyProbe).toContainText(/\d+ 个已完成任务/u);
  await expect(
    latencyProbe.getByTestId("thread-pool-latency-start"),
  ).toBeVisible();
  await scheduledExecutorCard.getByRole("button", { name: "查看成员" }).click();
  await expect(
    latencyProbe.getByRole("heading", {
      name: "拆开计划延迟、启动迟滞与执行耗时。",
    }),
  ).toBeVisible();
  await expect(latencyProbe).toContainText("计划延迟");
  await expect(latencyProbe).toContainText("启动迟滞");
  await latencyProbe.getByTestId("thread-pool-latency-confirmation").check();
  await latencyProbe.getByTestId("thread-pool-latency-start").click();
  await expect(latencyProbe).toContainText("ScheduledFutureTask", {
    timeout: 10_000,
  });
  await expect(latencyProbe).toContainText("个到期样本");
  await screenshotVisiblePanel(
    window,
    latencyProbe,
    "scheduled-thread-pool-delay-attribution.png",
  );
  await latencyProbe.getByTestId("thread-pool-latency-stop").click();
  await forkJoinPoolCard.getByRole("button", { name: "查看成员" }).click();
  await expect(latencyProbe).toContainText("外部协助执行不混入结果");
  await latencyProbe.getByTestId("thread-pool-latency-confirmation").check();
  await latencyProbe.getByTestId("thread-pool-latency-start").click();
  await expect(latencyProbe).toContainText("MeasuredForkJoinTask", {
    timeout: 10_000,
  });
  await expect(latencyProbe).toContainText("排队等待不计入结果");
  await screenshotVisiblePanel(
    window,
    latencyProbe,
    "forkjoin-execution-attribution.png",
  );
  await latencyProbe.getByTestId("thread-pool-latency-stop").click();
  await threadPoolConfirmation.check();
  await window.getByRole("button", { name: "检查线程池" }).click();
  await expect(threadPoolConfirmation).not.toBeChecked();
  await businessExecutorCard.getByRole("button", { name: "查看成员" }).click();
  await expect(poolMemberInspector).toContainText(exactBusinessPoolIdentity);
  const refreshedWorkerPoolMember = poolMemberInspector
    .locator("button.thread-pool-member-row")
    .filter({ hasText: /integration-worker-pool-\d+/u })
    .first();
  await expect(refreshedWorkerPoolMember).toBeVisible({ timeout: 30_000 });
  const selectedPoolMemberName =
    (await refreshedWorkerPoolMember.locator("strong").textContent())?.trim() ??
    "";
  expect(selectedPoolMemberName).toMatch(/^integration-worker-pool-\d+$/u);
  await refreshedWorkerPoolMember.click();
  const locatedPoolMember = window
    .locator(".thread-row")
    .filter({ hasText: selectedPoolMemberName });
  await expect(locatedPoolMember).toBeVisible();
  await expect(locatedPoolMember).toHaveAttribute("data-state", "open");
  const threadTrends = window.locator(".thread-trends");
  await expect(
    threadTrends.getByRole("heading", {
      name: "把线程变化留在有界时间窗里。",
    }),
  ).toBeVisible();
  await selectShadcnValue(threadTrends.getByLabel("采样间隔"), "1000");
  await threadTrends.getByRole("button", { name: "立即采样" }).click();
  await expect(threadTrends).toContainText("1 / 120 个内存样本");
  await threadTrends.getByRole("button", { name: "开始连续采样" }).click();
  await expect(threadTrends).toContainText("连续采样中");
  await expect(threadTrends).toContainText("2 / 120 个内存样本");
  await threadTrends.getByRole("button", { name: "停止连续采样" }).click();
  await expect(threadTrends).toContainText("2 个样本");
  const hotThreadInspector = threadTrends.locator("section.thread-hot-cpu");
  await expect(
    hotThreadInspector.getByRole("heading", {
      name: "当前采样窗口的热点线程。",
    }),
  ).toBeVisible();
  const cpuProbeThread = hotThreadInspector
    .locator("button.thread-hot-cpu__row")
    .filter({ hasText: "integration-cpu-probe" });
  await expect(cpuProbeThread).toBeVisible();
  await expect(cpuProbeThread).toContainText("%");
  await expect(cpuProbeThread).toContainText("ms/s");
  const hotThreadRowLayout = await hotThreadInspector
    .locator("button.thread-hot-cpu__row")
    .evaluateAll((rows) =>
      rows.map((row, index) => {
        const bounds = row.getBoundingClientRect();
        const nextBounds = rows[index + 1]?.getBoundingClientRect();
        const contentFits = Array.from(row.children).every((child) => {
          const childBounds = child.getBoundingClientRect();
          return (
            childBounds.top >= bounds.top && childBounds.bottom <= bounds.bottom
          );
        });
        return {
          contentFits,
          doesNotOverlapNext: !nextBounds || bounds.bottom <= nextBounds.top,
        };
      }),
    );
  expect(hotThreadRowLayout.length).toBeGreaterThan(0);
  expect(
    hotThreadRowLayout.every(
      ({ contentFits, doesNotOverlapNext }) =>
        contentFits && doesNotOverlapNext,
    ),
  ).toBe(true);
  await screenshotVisiblePanel(
    window,
    hotThreadInspector,
    "thread-hot-cpu-inspector.png",
    120,
  );
  await cpuProbeThread.click();
  const locatedCpuProbe = window
    .locator(".thread-row")
    .filter({ hasText: "integration-cpu-probe" });
  await expect(locatedCpuProbe).toBeVisible();
  await expect(locatedCpuProbe).toHaveAttribute("data-state", "open");
  await threadTrends.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-long-trends.png",
    ),
  });
  await window.getByRole("button", { name: "固定线程基线" }).click();
  await expect(window.getByText("BASELINE", { exact: true })).toBeVisible();
  await window.waitForTimeout(750);
  await window.getByRole("button", { name: "与当前对比" }).click();
  await expect(window.locator(".snapshot-kpis")).toBeVisible();
  await expect(
    window.getByText("TOP CPU GROWTH", { exact: true }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-pool-history-inspector.png",
    ),
    fullPage: true,
  });
  await window.getByRole("button", { name: "生成线程转储" }).click();
  await expect(
    window.getByRole("button", {
      name: "在线程转储检查器中打开",
    }),
  ).toBeVisible();
  await window.getByRole("button", { name: "生成线程转储" }).click();
  await expect(
    window.getByRole("button", {
      name: "在线程转储检查器中打开",
    }),
  ).toBeVisible();
  await window
    .getByRole("button", {
      name: "在线程转储检查器中打开",
    })
    .click();
  await expect(
    window.getByRole("heading", {
      name: "线程现场，作为证据重新打开。",
    }),
  ).toBeVisible();
  await expect(window.getByLabel("基线线程转储")).toBeEnabled();
  await window.getByRole("button", { name: "生成差异" }).click();
  await expect(
    window.locator(".thread-dump-comparison__metrics"),
  ).toBeVisible();
  await window.getByLabel("线程、状态或栈顶").fill("integration-lock-waiter");
  await window.getByRole("button", { name: "筛选差异" }).click();
  const comparedLockWaiter = window
    .locator("button.thread-dump-change")
    .filter({ hasText: "integration-lock-waiter" });
  await expect(comparedLockWaiter).toBeVisible();
  await comparedLockWaiter.click();
  await expect(window.locator(".thread-dump-change-detail")).toContainText(
    "integration-lock-waiter",
  );
  await window.locator(".thread-dump-comparison").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-dump-comparison.png",
    ),
  });
  await window.getByLabel("线程、锁或堆栈").fill("integration-lock-waiter");
  await window.getByRole("button", { name: "筛选转储" }).click();
  const dumpedLockWaiter = window
    .locator("button.thread-dump-thread")
    .filter({ hasText: "integration-lock-waiter" });
  await expect(dumpedLockWaiter).toBeVisible();
  await dumpedLockWaiter.click();
  await expect(window.locator(".thread-dump-detail")).toContainText(
    "integration-lock-waiter",
  );
  await expect(window.locator(".thread-dump-detail")).toContainText(
    "java.lang.Object@",
  );
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-dump-inspector.png",
    ),
    fullPage: true,
  });
  await window.getByRole("link", { name: /线程/ }).click();
  await expect(
    window.getByRole("heading", { name: "线程与锁。" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "分析锁关系" }).click();
  const lockWaiter = window
    .locator("button.lock-node")
    .filter({ hasText: "integration-lock-waiter" });
  await expect(lockWaiter).toBeVisible();
  await lockWaiter.click();
  await expect(
    window.locator(".lock-detail").getByRole("heading", {
      name: "integration-lock-waiter",
    }),
  ).toBeVisible();
  await window.getByRole("button", { name: "定位持有线程" }).click();
  await expect(
    window.locator(".lock-detail").getByRole("heading", {
      name: "integration-lock-holder",
    }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-lock-inspector.png",
    ),
    fullPage: true,
  });
  await window.getByLabel("线程名称").fill("integration-interruptible-worker");
  await window.getByRole("button", { name: "查询", exact: true }).click();
  const interruptibleThread = window.locator(".thread-row").first();
  await expect(interruptibleThread).toContainText(
    "integration-interruptible-worker",
  );
  await interruptibleThread
    .locator("[data-slot='collapsible-trigger']")
    .click();
  await interruptibleThread
    .getByRole("button", { name: "生成中断预览" })
    .click();
  await interruptibleThread
    .getByLabel("我已核对线程 ID、名称、状态和栈顶，并确认它是预期业务线程。")
    .check();
  await interruptibleThread
    .getByLabel("我再次确认接受业务任务提前结束、回滚或状态不一致的风险。")
    .check();
  await interruptibleThread
    .getByRole("button", { name: "二次确认并发送中断信号" })
    .click();
  await expect(
    window.getByText(
      /已向线程 #\d+ · integration-interruptible-worker 发送中断信号/u,
    ),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "thread-interrupt.png",
    ),
    fullPage: true,
  });

  await window.getByRole("link", { name: /MBean/ }).click();
  await expect(
    window.getByRole("heading", { name: "管理接口，逐项检查。" }),
  ).toBeVisible();
  await window
    .getByPlaceholder("例如 java.lang:type=Memory")
    .fill("java.lang:type=Memory");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const memoryMBean = window.locator("button.mbean-row").filter({
    has: window.getByText("Memory", { exact: true }),
  });
  await expect(memoryMBean).toBeVisible();
  await memoryMBean.click();
  await expect(
    window.getByRole("heading", { name: "java.lang:type=Memory" }),
  ).toBeVisible();
  const heapMemoryAttribute = window.locator("article.attribute-row").filter({
    has: window.getByText("HeapMemoryUsage", { exact: true }),
  });
  await expect(heapMemoryAttribute).toBeVisible();
  await heapMemoryAttribute.getByRole("button", { name: "读取值" }).click();
  const openTypeTree = heapMemoryAttribute.locator(".attribute-value__tree");
  await expect(openTypeTree).toBeVisible();
  await expect(
    openTypeTree.getByText("CompositeData", { exact: true }),
  ).toBeVisible();
  await expect(openTypeTree.getByText("used", { exact: true })).toBeVisible();
  await expect(
    openTypeTree.getByText("committed", { exact: true }),
  ).toBeVisible();
  await heapMemoryAttribute
    .getByRole("button", { name: "折叠 HeapMemoryUsage" })
    .click();
  await expect(
    openTypeTree.getByText("used", { exact: true }),
  ).not.toBeVisible();
  await heapMemoryAttribute
    .getByRole("button", { name: "展开 HeapMemoryUsage" })
    .click();
  await expect(openTypeTree.getByText("used", { exact: true })).toBeVisible();
  await heapMemoryAttribute
    .getByRole("button", { name: "原始有界文本" })
    .click();
  await expect(heapMemoryAttribute.locator("pre")).toContainText("used=");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "open-type-mbean-inspector.png",
    ),
    fullPage: true,
  });
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "mbean-inspector.png"),
    fullPage: true,
  });
  await window
    .getByPlaceholder("例如 java.lang:type=Memory")
    .fill("dev.tanwei.integration:type=Control");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const integrationMBean = window
    .locator("button.mbean-row")
    .filter({ hasText: "Control" });
  await expect(integrationMBean).toBeVisible();
  await integrationMBean.click();
  await expect(
    window.getByRole("heading", {
      name: "dev.tanwei.integration:type=Control",
    }),
  ).toBeVisible();
  const pingOperation = window
    .locator(".operation-list article")
    .filter({ hasText: "ping" });
  await expect(pingOperation).toBeVisible();
  await pingOperation.getByRole("button", { name: "配置调用" }).click();
  await window.locator(".operation-arguments input").first().fill("desktop");
  await window.getByRole("button", { name: "预检精确调用" }).click();
  await expect(window.locator(".operation-preview")).toContainText(
    'ping("desktop")',
  );
  await window
    .getByLabel(
      "我确认调用 dev.tanwei.integration:type=Control 的 ping 操作可能立即改变目标 JVM 状态。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用；超时或中断不保证目标操作停止。")
    .check();
  await window.getByRole("button", { name: "二次确认并调用操作" }).click();
  const invocationRecord = window
    .locator("article.invocation-record")
    .filter({ hasText: "ping" })
    .first();
  await expect(invocationRecord).toContainText("pong:desktop");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "mbean-operation-invoker.png",
    ),
    fullPage: true,
  });
  await window
    .getByPlaceholder("例如 java.lang:type=Memory")
    .fill("dev.tanwei.integration:type=OpenControl");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const openIntegrationMBean = window
    .locator("button.mbean-row")
    .filter({ hasText: "OpenControl" });
  await expect(openIntegrationMBean).toBeVisible();
  await openIntegrationMBean.click();
  await expect(
    window.getByRole("heading", {
      name: "dev.tanwei.integration:type=OpenControl",
    }),
  ).toBeVisible();
  const applySettingsOperation = window
    .locator(".operation-list article")
    .filter({ hasText: "applySettings" });
  await expect(applySettingsOperation).toBeVisible();
  await applySettingsOperation
    .getByRole("button", { name: "配置调用" })
    .click();
  const settingsArgument = window.getByLabel(
    "settings · javax.management.openmbean.CompositeData · OpenType JSON",
  );
  await expect(settingsArgument).toBeVisible();
  await expect(window.locator(".operation-argument__schema")).toContainText(
    "labels:array<string>",
  );
  await settingsArgument.fill(
    '{\n  "threshold": 42,\n  "labels": ["desktop", "safe"],\n  "enabled": false\n}',
  );
  await window.getByRole("button", { name: "预检精确调用" }).click();
  const openOperationPreview = window.locator(".operation-preview");
  await expect(openOperationPreview).toContainText("AGENT 规范化参数");
  await expect(openOperationPreview.locator("pre")).toContainText(
    '{"enabled":false,"labels":["desktop","safe"],"threshold":42}',
  );
  await openOperationPreview.scrollIntoViewIfNeeded();
  await openOperationPreview.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "mbean-open-type-operation-preview.png",
    ),
  });
  await window
    .getByLabel(
      "我确认调用 dev.tanwei.integration:type=OpenControl 的 applySettings 操作可能立即改变目标 JVM 状态。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用；超时或中断不保证目标操作停止。")
    .check();
  await window.getByRole("button", { name: "二次确认并调用操作" }).click();
  const openInvocationRecord = window
    .locator("article.invocation-record")
    .filter({ hasText: "applySettings" })
    .first();
  await expect(openInvocationRecord).toContainText("accepted:false:42:2");
  await window
    .getByPlaceholder("例如 java.lang:type=Memory")
    .fill("dev.tanwei.integration:type=Control");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(integrationMBean).toBeVisible();
  await integrationMBean.click();
  const modeAttribute = window
    .locator("article.attribute-row")
    .filter({ has: window.getByText("Mode", { exact: true }) });
  await expect(modeAttribute).toBeVisible();
  await modeAttribute.getByRole("button", { name: "配置修改" }).click();
  await window.getByLabel("Mode 新值").fill("desktop");
  await window.getByRole("button", { name: "读取旧值并生成预检" }).click();
  await expect(window.locator(".attribute-write-preview")).toContainText(
    "before",
  );
  await expect(window.locator(".attribute-write-preview")).toContainText(
    "desktop",
  );
  await window
    .getByLabel(
      "我确认将 dev.tanwei.integration:type=Control 的 Mode 从 before 修改为 desktop，Setter 可能立即产生业务副作用。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。")
    .check();
  await window.getByRole("button", { name: "二次确认并修改属性" }).click();
  const attributeChange = window
    .locator("article.attribute-write-record")
    .filter({ hasText: "Mode" })
    .first();
  await expect(attributeChange).toContainText("before");
  await expect(attributeChange).toContainText("desktop");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "mbean-attribute-editor.png",
    ),
    fullPage: true,
  });
  await attributeChange.getByRole("button", { name: "生成恢复预览" }).click();
  await expect(window.locator(".attribute-write-preview")).toContainText(
    "desktop",
  );
  await expect(window.locator(".attribute-write-preview")).toContainText(
    "before",
  );
  await window
    .getByLabel(
      "我确认将 dev.tanwei.integration:type=Control 的 Mode 从 desktop 修改为 before，Setter 可能立即产生业务副作用。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。")
    .check();
  await window.getByRole("button", { name: "二次确认并修改属性" }).click();
  await expect(
    window.locator("article.attribute-write-record").first(),
  ).toContainText("before");

  const settingsAttribute = window
    .locator("article.attribute-row")
    .filter({ has: window.getByText("Settings", { exact: true }) });
  await expect(settingsAttribute).toBeVisible();
  await settingsAttribute.getByRole("button", { name: "配置修改" }).click();
  const openTypeEditor = window.getByLabel("Settings OpenType JSON 新值");
  await expect(openTypeEditor).toBeVisible();
  await expect(openTypeEditor).toHaveValue(/baseline/u);
  await openTypeEditor.fill(
    JSON.stringify(
      {
        enabled: false,
        labels: ["desktop", "safe"],
        threshold: 42,
      },
      null,
      2,
    ),
  );
  await window.getByRole("button", { name: "读取旧值并生成预检" }).click();
  const openTypeWritePreview = window.locator(".attribute-write-preview");
  await expect(openTypeWritePreview).toContainText("OPEN_TYPE_JSON");
  await expect(openTypeWritePreview).toContainText('"threshold": 42');
  await window
    .getByLabel(
      "我确认将 dev.tanwei.integration:type=Control 的 Settings 写入已预检的复合 OpenType 值，Setter 可能立即产生业务副作用。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。")
    .check();
  await window.getByRole("button", { name: "二次确认并修改属性" }).click();
  const openTypeAttributeChange = window
    .locator("article.attribute-write-record")
    .filter({ hasText: "Settings" })
    .first();
  await expect(openTypeAttributeChange).toContainText("desktop");
  const settingsTree = settingsAttribute.locator(".attribute-value__tree");
  await settingsTree.getByRole("button", { name: "展开 labels" }).click();
  await expect(settingsTree).toContainText("desktop");
  await window.locator(".attribute-write-composer").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "mbean-open-type-attribute-editor.png",
    ),
    animations: "disabled",
  });
  await openTypeAttributeChange
    .getByRole("button", { name: "生成恢复预览" })
    .click();
  await expect(openTypeWritePreview).toContainText("baseline");
  await window
    .getByLabel(
      "我确认将 dev.tanwei.integration:type=Control 的 Settings 写入已预检的复合 OpenType 值，Setter 可能立即产生业务副作用。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受不可逆副作用，并理解旧值变化会使本次预检失效。")
    .check();
  await window.getByRole("button", { name: "二次确认并修改属性" }).click();
  await expect(
    window
      .locator("article.attribute-write-record")
      .filter({ hasText: "Settings" })
      .first(),
  ).toContainText("baseline");

  await window.getByRole("link", { name: /日志/ }).click();
  await expect(
    window.getByRole("heading", { name: "日志配置，按上下文看清。" }),
  ).toBeVisible();
  await window
    .getByPlaceholder("名称或日志上下文")
    .fill("dev.tanwei.integration");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const integrationLogger = window
    .locator("button.logger-row")
    .filter({ hasText: "dev.tanwei.integration" });
  await expect(integrationLogger).toBeVisible();
  await integrationLogger.click();
  await expect(
    window.getByRole("heading", {
      name: "dev.tanwei.integration",
      exact: true,
    }),
  ).toBeVisible();
  await expect(window.locator(".logger-facts")).toContainText("INFO");
  await selectShadcnValue(window.getByLabel("新级别"), "FINE");
  await window.getByRole("button", { name: "生成级别变更预检" }).click();
  const loggerLevelPreview = window.getByLabel("Logger 级别变更预检");
  await expect(loggerLevelPreview).toContainText("INFO");
  await expect(loggerLevelPreview).toContainText("FINE");
  await window
    .getByLabel(
      "我确认修改 dev.tanwei.integration 的日志级别，日志量和性能可能立即变化。",
    )
    .check();
  await window.getByRole("button", { name: "确认修改级别" }).click();
  await expect(window.getByText("级别已从 INFO 修改为 FINE")).toBeVisible();
  await window.getByRole("button", { name: "准备回滚本次修改" }).click();
  await expect(window.getByLabel("新级别")).toContainText("INFO");
  await window.getByRole("button", { name: "生成级别变更预检" }).click();
  await window
    .getByLabel(
      "我确认修改 dev.tanwei.integration 的日志级别，日志量和性能可能立即变化。",
    )
    .check();
  await window.getByRole("button", { name: "确认修改级别" }).click();
  await expect(window.getByText("级别已从 FINE 修改为 INFO")).toBeVisible();
  await window.locator("section.logger-mutation").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "logger-level-change-inspector.png",
    ),
    animations: "disabled",
  });

  await selectShadcnValue(
    window.locator(".logger-toolbar [data-slot='select-trigger']").first(),
    "LOG4J",
  );
  await window
    .getByPlaceholder("名称或日志上下文")
    .fill("legacy.tanwei.logger");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const legacyLogger = window
    .locator("button.logger-row")
    .filter({ hasText: "legacy.tanwei.logger" });
  await expect(legacyLogger).toBeVisible();
  await expect(legacyLogger).toContainText("LOG4J");
  await legacyLogger.click();
  await expect(
    window.getByRole("heading", {
      name: "legacy.tanwei.logger",
      exact: true,
    }),
  ).toBeVisible();
  await expect(window.locator(".logger-facts")).toContainText("INFO");
  await selectShadcnValue(window.getByLabel("新级别"), "DEBUG");
  await window.getByRole("button", { name: "生成级别变更预检" }).click();
  await expect(window.getByLabel("Logger 级别变更预检")).toContainText("DEBUG");
  await window
    .getByLabel(
      "我确认修改 legacy.tanwei.logger 的日志级别，日志量和性能可能立即变化。",
    )
    .check();
  await window.getByRole("button", { name: "确认修改级别" }).click();
  await expect(window.getByText("级别已从 INFO 修改为 DEBUG")).toBeVisible();
  await window.locator("section.logger-mutation").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "log4j1-level-change-inspector.png",
    ),
    animations: "disabled",
  });
  await window.getByRole("button", { name: "准备回滚本次修改" }).click();
  await window.getByRole("button", { name: "生成级别变更预检" }).click();
  await window
    .getByLabel(
      "我确认修改 legacy.tanwei.logger 的日志级别，日志量和性能可能立即变化。",
    )
    .check();
  await window.getByRole("button", { name: "确认修改级别" }).click();
  await expect(window.getByText("级别已从 DEBUG 修改为 INFO")).toBeVisible();

  await window.getByRole("link", { name: /计数器/ }).click();
  await expect(
    window.getByRole("heading", {
      name: "JVM 内部计数器，不再藏在命令行。",
    }),
  ).toBeVisible();
  const jitCompiler = window.locator("section.jit-compiler");
  await expect(
    jitCompiler.getByRole("heading", {
      name: "看清 JIT 编译器正在做什么。",
    }),
  ).toBeVisible();
  await expect(jitCompiler).toContainText("累计编译");
  await expect(jitCompiler).toContainText("代码缓存");
  await selectShadcnValue(jitCompiler.getByLabel("采样间隔"), "1000");
  await jitCompiler.getByRole("button", { name: "开始 JIT 连续采样" }).click();
  await expect(jitCompiler).toContainText("2/120", {
    timeout: 10_000,
  });
  await jitCompiler.getByRole("button", { name: "停止 JIT 连续采样" }).click();
  const jitTrendPanel = jitCompiler.locator("section.jit-trend-panel");
  await expect(
    jitTrendPanel.getByRole("heading", {
      name: "把短时波动保存成可比较基线。",
    }),
  ).toBeVisible();
  await expect(jitTrendPanel).toContainText("最大容量");
  await jitTrendPanel
    .getByRole("checkbox", { name: /加入跨版本回归基线/u })
    .click();
  await jitTrendPanel.getByLabel("工作负载键").fill("e2e-steady-jit-workload");
  await jitTrendPanel.getByLabel("发布标签").fill("e2e-release-a");
  await jitTrendPanel
    .getByRole("button", { name: "保存 JIT 趋势制品" })
    .click();
  await expect(
    jitTrendPanel.getByRole("button", { name: "检查并对比基线" }),
  ).toBeEnabled();
  const diagnosticAlertTrigger = window.getByRole("button", {
    name: "诊断通知，1 条未读",
  });
  await expect(diagnosticAlertTrigger).toBeVisible();
  await diagnosticAlertTrigger.click();
  const diagnosticAlertCenter = window.getByTestId("diagnostic-alert-center");
  await expect(
    diagnosticAlertCenter.getByRole("heading", { name: "诊断通知" }),
  ).toBeVisible();
  await expect(diagnosticAlertCenter).toContainText("JIT 基线已保存");
  await expect(diagnosticAlertCenter).toContainText("按最大容量");
  await diagnosticAlertCenter.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "diagnostic-alert-center.png",
    ),
    animations: "disabled",
  });
  await diagnosticAlertCenter
    .getByRole("button", { name: "全部标为已读" })
    .click();
  await expect(
    diagnosticAlertCenter.getByRole("button", { name: "全部标为已读" }),
  ).toBeDisabled();
  await window.keyboard.press("Escape");
  await expect(diagnosticAlertCenter).not.toBeVisible();
  await jitTrendPanel.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "jit-code-cache-pressure.png",
    ),
    animations: "disabled",
  });
  await screenshotVisiblePanel(
    window,
    jitCompiler,
    "jit-compiler-inspector.png",
  );
  const jitEvidence = jitCompiler.locator("section.jit-evidence");
  await expect(
    jitEvidence.getByRole("heading", {
      name: "把实时异常接到 C1 / C2 录制证据。",
    }),
  ).toBeVisible();
  await jitEvidence.getByRole("button", { name: "开始 JIT 证据录制" }).click();
  await expect(jitEvidence).toContainText("JFR 记录中");
  await window.waitForTimeout(1_500);
  await jitEvidence.getByRole("button", { name: "停止、保存并分析" }).click();
  await expect(
    jitEvidence.getByRole("heading", { name: "C1 / C2 分层" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    jitEvidence.getByRole("heading", { name: "录制期编译热点" }),
  ).toBeVisible();
  await expect(
    jitEvidence.getByRole("heading", { name: "去优化原因与行动" }),
  ).toBeVisible();
  await expect(
    jitEvidence.getByRole("button", { name: "打开完整 JFR 检查器" }),
  ).toBeEnabled();
  await screenshotVisiblePanel(window, jitEvidence, "jit-deep-evidence.png");
  await jitCompiler.getByRole("button", { name: "清空 JIT 历史" }).click();
  await jitCompiler.getByRole("button", { name: "开始 JIT 连续采样" }).click();
  await expect(jitCompiler).toContainText("2/120", { timeout: 10_000 });
  await jitCompiler.getByRole("button", { name: "停止 JIT 连续采样" }).click();
  await jitTrendPanel.getByLabel("发布标签").fill("e2e-release-b");
  await jitTrendPanel
    .getByRole("button", { name: "保存 JIT 趋势制品" })
    .click();
  await expect(
    window.getByRole("button", { name: "诊断通知，1 条未读" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "诊断通知，1 条未读" }).click();
  await window
    .getByTestId("diagnostic-alert-center")
    .locator(".diagnostic-alert-card")
    .first()
    .getByRole("button", { name: "检查证据" })
    .click();
  const jitTrendArtifactInspector = window.getByTestId(
    "jit-trend-artifact-inspector",
  );
  await expect(
    jitTrendArtifactInspector.getByRole("heading", {
      name: "把编译与 Code Cache 压力放进长期基线。",
    }),
  ).toBeVisible();
  await expect(
    jitTrendArtifactInspector.getByTestId("compare-jit-trends"),
  ).toBeEnabled();
  await jitTrendArtifactInspector.getByTestId("compare-jit-trends").click();
  await expect(jitTrendArtifactInspector).toContainText("基线窗口");
  await expect(jitTrendArtifactInspector).toContainText("当前窗口");
  await expect(jitTrendArtifactInspector).toContainText("Code Cache 净增长");
  await expect(jitTrendArtifactInspector).toContainText(
    "Host 复验的跨发布基线身份。",
  );
  await expect(jitTrendArtifactInspector).toContainText(
    "e2e-steady-jit-workload",
  );
  await expect(jitTrendArtifactInspector).toContainText("e2e-release-b");
  await screenshotVisiblePanel(
    window,
    jitTrendArtifactInspector,
    "jit-trend-baseline-comparison.png",
  );
  await jitTrendArtifactInspector.getByTestId("jit-mode-cross-release").click();
  await expect(jitTrendArtifactInspector).toContainText(
    "没有兼容基线：需要较早的不同发布标签、不同 JVM 周期",
  );
  const crossReleaseComparison = jitTrendArtifactInspector.locator(
    "section.pool-trend-artifact-comparison",
  );
  await crossReleaseComparison.scrollIntoViewIfNeeded();
  await crossReleaseComparison.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "jit-cross-release-baseline.png",
    ),
    animations: "disabled",
  });
  const inspectedArtifactMatch = /[?&]inspect=([0-9a-f-]{36})(?:&|$)/iu.exec(
    window.url(),
  );
  const inspectedArtifactId = inspectedArtifactMatch?.[1];
  if (!inspectedArtifactId) {
    throw new Error("JIT evidence route did not expose its artifact UUID");
  }
  await window.getByRole("link", { name: /计数器/ }).click();
  await requiredElectronApplication().evaluate(
    ({ BrowserWindow }, input) => {
      const owner = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      owner?.webContents.send(input.channel, input.artifactId);
    },
    {
      channel: "tanwei:open-diagnostic-evidence",
      artifactId: inspectedArtifactId,
    },
  );
  await expect(
    window.getByTestId("jit-trend-artifact-inspector"),
  ).toBeVisible();
  await expect(window).toHaveURL(
    new RegExp(`inspect=${inspectedArtifactId}`, "u"),
  );
  await window.getByRole("link", { name: /计数器/ }).click();
  await window.getByPlaceholder("例如 java.cls").fill("java.cls");
  await window.getByRole("button", { name: "刷新快照" }).click();
  const classCounter = window
    .locator("button.counter-row")
    .filter({ hasText: "java.cls." })
    .first();
  await expect(classCounter).toBeVisible();
  await classCounter.click();
  await expect(window.locator(".counter-detail h2")).toContainText("java.cls.");
  await expect(window.locator(".counter-value code")).not.toBeEmpty();
  await expect(window.locator(".counter-facts")).toContainText("变化语义");
  await expectNoLargePrimarySurfaces(
    window.locator("section.perfcounters-view"),
  );
  await window.locator(".workspace__content").evaluate((element) => {
    element.scrollTo({ top: 0, left: 0 });
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "perfcounters-dark-surfaces.png",
    ),
    animations: "disabled",
  });
  await screenshotVisiblePanel(
    window,
    window.locator(".counter-inspector"),
    "perfcounters-selected-dark.png",
  );
  await window
    .locator(".counter-detail")
    .getByRole("button", { name: "固定到趋势" })
    .click();
  const counterTrends = window.locator("section.counter-trends");
  await expect(
    counterTrends.getByRole("heading", {
      name: "把内部计数器固定成时间序列。",
    }),
  ).toBeVisible();
  await selectShadcnValue(counterTrends.getByLabel("采样间隔"), "1000");
  await counterTrends.getByRole("button", { name: "开始连续采样" }).click();
  await expect(
    counterTrends.getByText("连续采样中", { exact: true }),
  ).toBeVisible();
  const counterTrendCard = counterTrends.locator("article.counter-trend-card");
  await expect(counterTrendCard).toHaveCount(1);
  await expect(
    counterTrendCard.getByText("2 个数值样本", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(counterTrendCard).toContainText("相邻差异");
  await expect(counterTrendCard).toContainText("每秒速率");
  await counterTrends.getByRole("button", { name: "停止连续采样" }).click();
  await expect(
    counterTrends.getByRole("button", { name: "开始连续采样" }),
  ).toBeVisible();
  await counterTrends.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "perfcounter-trends.png",
    ),
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "perfcounter-inspector.png",
    ),
    fullPage: true,
  });

  await window.getByRole("link", { name: /类/ }).click();
  await expect(
    window.getByRole("heading", { name: "类与加载器。" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "加载器树" }).click();
  await expect(window.getByText("CLASSLOADER TREE")).toBeVisible();
  const metaspaceInspector = window.locator("section.metaspace-inspector");
  await expect(
    metaspaceInspector.getByRole("heading", {
      name: "定位占用 Class Metadata 的加载器。",
    }),
  ).toBeVisible();
  await metaspaceInspector
    .getByRole("button", { name: "采集元空间占用" })
    .click();
  await expect(
    metaspaceInspector.locator(".metaspace-inspector__summary"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(metaspaceInspector.locator("tbody tr").first()).toBeVisible();
  await expect(metaspaceInspector).toContainText(/[KM]iB/u);
  await metaspaceInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "classloader-metaspace-inspector.png",
    ),
  });
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await expect(
    window.getByText("dev.tanwei.integration.TestTargetMain", {
      exact: true,
    }),
  ).toBeVisible();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  const staticProbe = window
    .locator("article.static-field")
    .filter({ hasText: "STATIC_PROBE" });
  await expect(staticProbe).toBeVisible();
  await staticProbe.getByRole("button", { name: "生成读取预览" }).click();
  await staticProbe
    .getByLabel(
      "我确认读取 dev.tanwei.integration.TestTargetMain.STATIC_PROBE；此操作可能触发类初始化和业务副作用。",
    )
    .check();
  await staticProbe.getByRole("button", { name: "确认并读取单值" }).click();
  await expect(staticProbe.locator("pre")).toHaveText("tanwei-static-probe");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "static-field-inspector.png",
    ),
    fullPage: true,
  });
  const heartbeatMethod = window.locator("li").filter({
    has: window.getByText("heartbeat", { exact: true }),
  });
  await expect(heartbeatMethod).toBeVisible();
  await heartbeatMethod.getByRole("button", { name: "观测" }).click();

  await expect(
    window.getByRole("heading", { name: "只观测你明确选择的方法。" }),
  ).toBeVisible();
  const conditionBuilder = window.getByTestId("observation-condition-builder");
  await conditionBuilder.getByRole("button", { name: "添加条件" }).click();
  await conditionBuilder.getByLabel("毫秒").fill("0");
  await conditionBuilder.getByRole("button", { name: "添加条件" }).click();
  await conditionBuilder.getByLabel("条件 2 字段").click();
  await window.getByRole("option", { name: "调用结果" }).click();
  await expect(
    conditionBuilder.getByTestId("observation-condition-expression"),
  ).toHaveText('durationMs >= 0 && outcome == "RETURNED"');
  await conditionBuilder.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "safe-condition-builder.png",
    ),
    animations: "disabled",
  });
  await window.locator(".workspace__content").evaluate((element) => {
    element.scrollTo({ top: 0 });
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "observe-shadcn-config.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  const observationDesktopViewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await window.setViewportSize({ width: 767, height: 720 });
  const methodIdentityBox = await window
    .locator(".selection-card")
    .boundingBox();
  const captureBoundaryBox = await window
    .locator(".observe-config")
    .boundingBox();
  expect(methodIdentityBox).not.toBeNull();
  expect(captureBoundaryBox).not.toBeNull();
  expect(captureBoundaryBox?.y ?? 0).toBeGreaterThan(
    (methodIdentityBox?.y ?? 0) + (methodIdentityBox?.height ?? 0) - 1,
  );
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "observe-shadcn-narrow.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await window.setViewportSize(observationDesktopViewport);
  await expect
    .poll(() => window.evaluate(() => window.innerWidth))
    .toBe(observationDesktopViewport.width);
  await window.getByRole("button", { name: "预检匹配" }).click();
  await expect(window.getByText("匹配 1 个方法")).toBeVisible();
  await window.getByRole("button", { name: "确认增强并开始" }).click();
  const observationEvent = window.locator(".event-row").first();
  await expect(observationEvent).toBeVisible({
    timeout: 10_000,
  });
  await observationEvent.locator("[data-slot='collapsible-trigger']").click();
  await expect(observationEvent.getByText(/tick-\d+/u)).toBeVisible();
  await observationEvent
    .getByRole("button", { name: "为此快照生成重放预览" })
    .click();
  await expect(
    observationEvent.getByText("最终调用", { exact: true }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "observe-shadcn-inspector.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await observationEvent
    .getByLabel("我已核对目标、参数和最终调用，并理解该方法会再次真实执行。")
    .check();
  await observationEvent
    .getByLabel("我再次确认接受业务副作用，且超时或中断不保证目标代码停止。")
    .check();
  await observationEvent
    .getByRole("button", { name: "二次确认并执行重放" })
    .click();
  await expect(
    observationEvent.getByText("RETURNED", { exact: true }),
  ).toBeVisible();
  const cancelObservation = window.getByRole("button", {
    name: "取消并回滚增强",
  });
  if (await cancelObservation.isVisible()) {
    await cancelObservation.click({ timeout: 2_000 }).catch(() => {
      // A bounded observation may complete and remove its cancel button
      // between the visibility check and click.
    });
  }

  await window.getByRole("link", { name: /快照/ }).click();
  await expect(
    window.getByRole("heading", {
      name: "把一次调用，变成可检索证据。",
    }),
  ).toBeVisible();
  await window
    .getByPlaceholder("类、方法、线程、参数或异常")
    .fill("TestTargetMain");
  await window.getByRole("button", { name: /高级筛选/u }).click();
  await window.getByLabel("重放状态").click();
  await window.getByRole("option", { name: "静态方法" }).click();
  await window.getByLabel("最大耗时（ms）").fill("1000");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const archivedSnapshot = window.locator("button.snapshot-row").first();
  await expect(archivedSnapshot).toContainText(
    "dev.tanwei.integration.TestTargetMain",
  );
  await expect(archivedSnapshot).toContainText("heartbeat");
  const archivedSnapshotMarker = (
    await archivedSnapshot.locator(".snapshot-row__index").innerText()
  ).trim();
  const exactArchivedSnapshot = window.locator("button.snapshot-row").filter({
    has: window.getByText(archivedSnapshotMarker, { exact: true }),
  });
  await expect(
    window.getByRole("heading", {
      name: "dev.tanwei.integration.TestTargetMain",
    }),
  ).toBeVisible();
  await expect(window.locator(".snapshot-result code")).toContainText(
    /TICK-\d+/u,
  );
  await expect(window.locator(".stack-list li").first()).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "snapshot-advanced-filters.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await window.getByRole("button", { name: "生成安全重放预检" }).click();
  await expect(window.locator(".replay-preview")).toContainText("heartbeat");
  await window
    .getByLabel(
      "我已核对快照、目标方法、参数和最终调用，并理解它会再次真实执行。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受业务副作用，超时或中断不保证目标代码停止。")
    .check();
  await window.getByRole("button", { name: "二次确认并执行快照重放" }).click();
  await expect(window.locator(".replay-result")).toContainText("RETURNED");
  const snapshotPersistCard = window.getByTestId("snapshot-persist-card");
  await snapshotPersistCard.getByRole("button", { name: "固定到桌面" }).click();
  await expect(snapshotPersistCard).toContainText("已保存为跨会话只读档案。");
  await snapshotPersistCard
    .getByRole("button", { name: "查看桌面档案" })
    .click();
  const desktopArchiveHeading = window.getByRole("heading", {
    name: "调用已经结束，证据仍然在。",
  });
  await expect(desktopArchiveHeading).toBeVisible();
  await expect
    .poll(async () => (await desktopArchiveHeading.boundingBox())?.y ?? 9999)
    .toBeLessThan(260);
  await expect(window.getByTestId("archive-retained")).not.toContainText("0");
  const persistedSnapshotDetail = window.getByTestId("snapshot-archive-detail");
  await expect(persistedSnapshotDetail).toContainText(
    "dev.tanwei.integration.TestTargetMain",
  );
  await expect(persistedSnapshotDetail).toContainText(/TICK-\d+/u);
  await expect(
    window.locator(
      'button[data-slot="button"][data-variant="default"]:visible',
    ),
  ).toHaveCount(0);
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "desktop-invocation-archive.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await window.reload();
  await expect(desktopArchiveHeading).toBeVisible();
  await expect(persistedSnapshotDetail).toContainText(/TICK-\d+/u);
  await window.getByRole("button", { name: "返回会话快照" }).click();
  await expect(
    window.getByRole("heading", { name: "把一次调用，变成可检索证据。" }),
  ).toBeVisible();
  await window
    .getByPlaceholder("类、方法、线程、参数或异常")
    .fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  await exactArchivedSnapshot.click();
  await expect(window.locator(".snapshot-result code")).toContainText(
    /TICK-\d+/u,
  );
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "invocation-snapshot-replay.png",
    ),
    fullPage: true,
  });
  await window.locator(".workspace__content").evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "invocation-snapshots.png",
    ),
    fullPage: true,
  });
  const snapshotDelete = window.locator(".snapshot-delete");
  await snapshotDelete.locator("[data-slot='collapsible-trigger']").click();
  await snapshotDelete.getByRole("checkbox").check();
  await snapshotDelete.getByRole("button", { name: "删除此快照" }).click();
  await expect(exactArchivedSnapshot).toHaveCount(0);

  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  const instanceHeartbeatMethod = window.locator("li").filter({
    has: window.getByText("instanceHeartbeat", { exact: true }),
  });
  await expect(instanceHeartbeatMethod).toBeVisible();
  await instanceHeartbeatMethod.getByRole("button", { name: "观测" }).click();
  await window.getByLabel("最多事件").fill("1");
  await window.getByRole("button", { name: "预检匹配" }).click();
  await expect(window.getByText("匹配 1 个方法")).toBeVisible();
  await window.getByRole("button", { name: "确认增强并开始" }).click();
  const instanceObservationEvent = window.locator(".event-row").filter({
    hasText: "instanceHeartbeat",
  });
  await expect(instanceObservationEvent).toBeVisible({ timeout: 10_000 });

  await window.getByRole("link", { name: /快照/ }).click();
  await window
    .getByPlaceholder("类、方法、线程、参数或异常")
    .fill("instanceHeartbeat");
  await window.getByRole("button", { name: /高级筛选/u }).click();
  await window.getByLabel("重放状态").click();
  await window.getByRole("option", { name: "原实例" }).click();
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const instanceSnapshot = window.locator("button.snapshot-row").first();
  await expect(instanceSnapshot).toContainText("instanceHeartbeat");
  await instanceSnapshot.click();
  await expect(window.locator(".snapshot-receiver")).toContainText(
    "原实例可用",
  );
  await expect(window.locator(".snapshot-receiver")).toContainText(
    "dev.tanwei.integration.TestTargetMain",
  );
  const capturedReceiverState = window.getByTestId("captured-receiver-state");
  await expect(capturedReceiverState).toContainText("捕获时实例状态");
  await expect(capturedReceiverState).toContainText("instanceReplaySequence");
  await window.getByRole("button", { name: "生成安全重放预检" }).click();
  await expect(window.locator(".replay-preview")).toContainText("原实例");
  await expect(window.locator(".replay-preview")).toContainText("<receiver:");
  const receiverStateDrift = window.getByTestId("receiver-state-drift");
  await expect(receiverStateDrift).toContainText("捕获后的实例状态漂移");
  await expect(receiverStateDrift).toContainText("instanceReplaySequence");
  await window
    .getByLabel(
      "我已核对快照、目标方法、参数和最终调用，并理解它会再次真实执行。",
    )
    .check();
  await window
    .getByLabel("我再次确认接受业务副作用，超时或中断不保证目标代码停止。")
    .check();
  await window.getByRole("button", { name: "二次确认并执行快照重放" }).click();
  await expect(window.locator(".replay-result")).toContainText("RETURNED");
  const receiverStateChange = window.getByTestId("receiver-state-change");
  await expect(receiverStateChange).toContainText("本次重放前后实例变化");
  await expect(receiverStateChange).toContainText("instanceReplaySequence");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "instance-invocation-replay.png",
    ),
    fullPage: true,
    animations: "disabled",
  });

  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  const structuredHeartbeatMethod = window.locator("li").filter({
    has: window.getByText("structuredHeartbeat", { exact: true }),
  });
  await expect(structuredHeartbeatMethod).toBeVisible();
  await structuredHeartbeatMethod.getByRole("button", { name: "观测" }).click();
  await window.getByLabel("最多事件").fill("2");
  await window.getByRole("button", { name: "预检匹配" }).click();
  await expect(window.getByText("匹配 1 个方法")).toBeVisible();
  await window.getByRole("button", { name: "确认增强并开始" }).click();
  const structuredObservationEvent = window.locator(".event-row").filter({
    hasText: "structuredHeartbeat",
  });
  await expect(structuredObservationEvent).toHaveCount(2, { timeout: 10_000 });

  await window.getByRole("link", { name: /快照/ }).click();
  await window
    .getByPlaceholder("类、方法、线程、参数或异常")
    .fill("structuredHeartbeat");
  await window.getByRole("button", { name: "搜索", exact: true }).click();
  const structuredSnapshots = window.locator("button.snapshot-row");
  await expect(structuredSnapshots).toHaveCount(2);
  const structuredSnapshot = structuredSnapshots.first();
  await expect(structuredSnapshot).toContainText("structuredHeartbeat");
  await structuredSnapshot.click();
  const invocationValueTree = window.getByTestId("invocation-value-tree");
  await expect(invocationValueTree).toContainText("结构化调用上下文");
  await expect(invocationValueTree).toContainText("apiToken");
  await expect(invocationValueTree).toContainText("<masked>");
  await expect(invocationValueTree).toContainText("region");
  await expect(invocationValueTree).toContainText("us-west");
  await expect(invocationValueTree).toContainText("samples");
  await expect(invocationValueTree).toContainText("attributes");
  await expect(invocationValueTree).toContainText("映射");
  await expect(invocationValueTree).toContainText("键值项");
  await expect(invocationValueTree).toContainText("tags");
  await expect(invocationValueTree).toContainText("集合");
  await expect(invocationValueTree).toContainText("checkout");
  await expect(invocationValueTree).toContainText("引用");
  await invocationValueTree.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "structured-invocation-values-card.png",
    ),
    animations: "disabled",
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "structured-invocation-values.png",
    ),
    fullPage: true,
    animations: "disabled",
  });

  await structuredSnapshots.nth(1).click();
  await window.getByRole("button", { name: "设为比较基线" }).click();
  await expect(window.getByTestId("invocation-value-diff")).toContainText(
    "当前快照已固定为基线",
  );
  await structuredSnapshots.first().click();
  const invocationValueDiff = window.getByTestId("invocation-value-diff");
  await expect(invocationValueDiff).toContainText("结构字段差异");
  await expect(invocationValueDiff).toContainText("sequence");
  const sequenceChange = invocationValueDiff.getByRole("row", {
    name: /^sequence 变化/u,
  });
  await expect(sequenceChange).toHaveCount(1);
  await expect(sequenceChange).toContainText("sequence");
  await invocationValueDiff.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "structured-invocation-diff-card.png",
    ),
    animations: "disabled",
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "structured-invocation-diff.png",
    ),
    fullPage: true,
    animations: "disabled",
  });

  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  const monitoredHeartbeat = window.locator("li").filter({
    has: window.getByText("heartbeat", { exact: true }),
  });
  await monitoredHeartbeat.getByRole("button", { name: "监控" }).click();
  await expect(
    window.getByRole("heading", { name: "让调用趋势持续可见。" }),
  ).toBeVisible();
  await selectShadcnValue(window.getByLabel("窗口周期"), "1");
  await window.getByLabel("最小计入耗时（ms）").fill("60000");
  await window.getByRole("button", { name: "预检精确方法" }).click();
  await expect(window.getByText("MATCHED / 1")).toBeVisible();
  await window
    .getByLabel(
      "我确认对该方法启用有界轻量计数，并理解热点方法仍会产生少量监控开销。",
    )
    .check();
  await window.getByRole("button", { name: "确认并开始监控" }).click();
  const monitorThreshold = window.locator("section.monitor-threshold");
  await expect(
    monitorThreshold.getByRole("heading", {
      name: "运行中调整计入阈值。",
    }),
  ).toBeVisible();
  await expect(monitorThreshold).toContainText("当前阈值：≥ 60000 ms");
  await monitorThreshold.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "monitor-live-threshold.png",
    ),
  });
  await monitorThreshold.getByLabel("运行中最小耗时（ms）").fill("0");
  await monitorThreshold.getByRole("button", { name: "应用监控阈值" }).click();
  await expect(monitorThreshold).toContainText(
    "已应用 0 ms；旧窗口保持原阈值。",
  );
  const firstMonitorWindow = window
    .locator(".monitor-window-list__rows article")
    .first();
  await expect(firstMonitorWindow).toBeVisible({ timeout: 10_000 });
  await expect(firstMonitorWindow).toContainText("≥ 0 ms");
  await expect(
    window.locator(".monitor-kpis article").first().locator("strong"),
  ).not.toHaveText("0");
  const p95Card = window
    .locator(".monitor-kpis article")
    .filter({ hasText: "P95" });
  const p99Card = window
    .locator(".monitor-kpis article")
    .filter({ hasText: "P99" });
  await expect(p95Card.locator("strong")).toContainText("ms");
  await expect(p99Card.locator("strong")).toContainText("ms");
  await expect(
    window.getByRole("img", {
      name: "窗口平均与 P95 耗时趋势",
    }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "method-monitor.png"),
    fullPage: true,
  });
  await window.getByRole("button", { name: "保存窗口制品" }).click();
  await expect(window.getByText(/监控窗口已进入制品中心：/u)).toBeVisible({
    timeout: 15_000,
  });
  await window.getByRole("button", { name: "检查制品" }).click();
  const monitorExportInspector = window.locator(
    "section.observation-export-inspector",
  );
  await expect(
    monitorExportInspector.getByRole("heading", {
      name: "方法监控窗口证据。",
    }),
  ).toBeVisible();
  await expect(monitorExportInspector).toContainText("TestTargetMain");
  await expect(monitorExportInspector).toContainText("MONITOR WINDOW ARTIFACT");
  await expect(monitorExportInspector).toContainText("≥ 0 ms");
  await screenshotVisiblePanel(
    window,
    monitorExportInspector,
    "monitor-window-artifact.png",
  );
  await window.getByRole("link", { name: /任务/ }).click();
  const monitorTask = window
    .locator("button.task-row")
    .filter({ hasText: "TestTargetMain" });
  await expect(monitorTask).toBeVisible();
  await monitorTask.click();
  await window.locator(".task-cancel").getByRole("checkbox").check();
  await window.getByRole("button", { name: "停止所选任务" }).click();
  await expect(monitorTask).toHaveCount(0);

  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  const classLoaderResourceInspector = window.locator(
    "section.classloader-resources",
  );
  await expect(
    classLoaderResourceInspector.getByLabel("ClassLoader 相对资源名"),
  ).toHaveValue("dev/tanwei/integration/TestTargetMain.class");
  await classLoaderResourceInspector
    .getByRole("button", { name: "定位可见来源" })
    .click();
  await expect(
    classLoaderResourceInspector.getByText("唯一来源", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    classLoaderResourceInspector.locator(
      ".classloader-resources__locations code",
    ),
  ).toContainText("TestTargetMain.class");
  await classLoaderResourceInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "classloader-resource-inspector.png",
    ),
  });
  const tracedHeartbeat = window.locator("li").filter({
    has: window.getByText("heartbeat", { exact: true }),
  });
  await tracedHeartbeat.getByRole("button", { name: "Trace" }).click();
  await expect(
    window.getByRole("heading", { name: "沿着一次调用，看见跨类路径。" }),
  ).toBeVisible();
  await window.getByLabel("最多 Trace").fill("1");
  await window.getByLabel("根调用最小耗时（ms）").fill("60000");
  await window
    .getByLabel("包含路径规则（可选）")
    .fill("dev.tanwei.integration.TraceSupport");
  await window
    .getByLabel("排除路径规则（可选）")
    .fill("dev.tanwei.integration.TraceSupport#normalize");
  await window.getByRole("button", { name: "预检 Trace 范围" }).click();
  await expect(
    window.getByText("2 个候选类 · 2 个可增强方法 · 上限 64"),
  ).toBeVisible();
  await expect(
    window
      .locator(".trace-preview__classes")
      .getByText("dev.tanwei.integration.TraceSupport", {
        exact: true,
      }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "trace-path-filter-preview.png",
    ),
    fullPage: true,
  });
  await window
    .getByLabel(
      "我已核对根方法、包范围、路径规则和类/方法数量，并接受有界跨类字节码增强开销。",
    )
    .check();
  await window.getByRole("button", { name: "确认增强并开始 Trace" }).click();
  const liveTraceThreshold = window.locator("section.trace-threshold");
  await expect(
    liveTraceThreshold.getByRole("heading", {
      name: "运行中调整慢调用阈值。",
    }),
  ).toBeVisible();
  await expect(liveTraceThreshold).toContainText("当前阈值：≥ 60000 ms");
  await liveTraceThreshold.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "trace-live-threshold.png",
    ),
  });
  await liveTraceThreshold.getByLabel("运行中最小耗时（ms）").fill("0");
  await liveTraceThreshold
    .getByRole("button", { name: "应用实时阈值" })
    .click();
  await expect(
    liveTraceThreshold.getByText("已应用 0 ms；未重新增强类。"),
  ).toBeVisible();
  await expect(
    window.locator(".trace-span").filter({ hasText: "TraceSupport#decorate" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    window.locator(".trace-span").filter({ hasText: "TraceSupport#normalize" }),
  ).toHaveCount(0);
  await expect(
    window.getByRole("heading", {
      name: "Trace 已结束，调用树保留在当前页面。",
    }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "cross-class-trace.png",
    ),
    fullPage: true,
  });
  await window.getByRole("tab", { name: "热点聚合" }).click();
  await expect(
    window.getByRole("heading", { name: "跨 Trace 热点聚合。" }),
  ).toBeVisible();
  const traceSupportHotspot = window
    .locator(".trace-hotspot-table tbody tr")
    .filter({ hasText: "TraceSupport#decorate" });
  await expect(traceSupportHotspot).toBeVisible();
  await expect(
    window.getByRole("columnheader", { name: "累计自耗时" }),
  ).toBeVisible();
  await expect(
    window.getByRole("columnheader", { name: "累计总耗时" }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "cross-class-trace-hotspots.png",
    ),
    fullPage: true,
  });
  await window.getByRole("button", { name: "保存热点制品" }).click();
  await expect(window.getByText(/热点聚合已进入制品中心：/u)).toBeVisible({
    timeout: 15_000,
  });
  await window.getByRole("button", { name: "检查制品" }).click();
  const traceExportInspector = window.locator(
    "section.observation-export-inspector",
  );
  await expect(
    traceExportInspector.getByRole("heading", {
      name: "跨 Trace 热点证据。",
    }),
  ).toBeVisible();
  await expect(traceExportInspector).toContainText("TraceSupport#decorate");
  await expect(traceExportInspector).toContainText("TRACE HOTSPOT ARTIFACT");
  await screenshotVisiblePanel(
    window,
    traceExportInspector,
    "trace-hotspot-artifact.png",
  );
  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("TestTargetMain");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.TestTargetMain", {
        exact: true,
      }),
    })
    .click();
  await window.getByRole("button", { name: "捕获 Class Dump" }).click();
  await window.getByRole("button", { name: "确认捕获" }).click();
  await expect(window.getByText("反编译源码 · CFR 0.152")).toBeVisible({
    timeout: 15_000,
  });
  const sourceEditor = window.getByLabel("可编辑类源码");
  await expect(sourceEditor).toHaveValue(/public static String heartbeat/u);
  const source = await sourceEditor.inputValue();
  expect(source).toContain('return "before";');
  await sourceEditor.fill(
    source.replace('return "before";', 'return "after-e2e";'),
  );
  await window.getByRole("button", { name: "编译并预检类定义" }).click();
  await expect(window.getByText("true", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await window
    .getByLabel(
      "我已核对精确类、ClassLoader、两个校验值和 R3 影响，并保留本次内存回滚。",
    )
    .check();
  const redefinedOutput = waitForOutput(
    requiredTargetProcess(),
    "TANWEI_REDEFINE=after-e2e",
    15_000,
  );
  await window.getByRole("button", { name: "确认替换方法体" }).click();
  await redefinedOutput;
  await expect(
    window.getByText("rollbackToken", { exact: true }),
  ).toBeVisible();
  await window
    .getByLabel("我确认仅在当前校验值仍匹配时恢复本次替换前的类定义。")
    .check();
  const restoredOutput = waitForOutput(
    requiredTargetProcess(),
    "TANWEI_REDEFINE=before",
    15_000,
  );
  await window.getByRole("button", { name: "恢复替换前定义" }).click();
  await restoredOutput;

  await sourceEditor.fill(
    source.replace('return "before";', 'return "batch-main";'),
  );
  await window.getByRole("button", { name: "加入当前类" }).click();
  await window.getByRole("searchbox").fill("ChangeSetSupport");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.ChangeSetSupport", {
        exact: true,
      }),
    })
    .click();
  await window.getByRole("button", { name: "捕获 Class Dump" }).click();
  await window.getByRole("button", { name: "确认捕获" }).click();
  const supportSourceEditor = window.getByLabel("可编辑类源码");
  await expect(supportSourceEditor).toHaveValue(/return "support-before";/u, {
    timeout: 15_000,
  });
  const supportSource = await supportSourceEditor.inputValue();
  await supportSourceEditor.fill(
    supportSource.replace(
      'return "support-before";',
      'return "support-after";',
    ),
  );
  await window.getByRole("button", { name: "加入当前类" }).click();
  const classChangeSet = window.locator(".class-change-set");
  await expect(classChangeSet).toContainText("2/8 个类");
  await expect(classChangeSet).toContainText("已保存 · 当前目标 JVM 启动周期");
  await window.getByRole("link", { name: /线程/ }).click();
  await window.getByRole("link", { name: /类/ }).click();
  await window.getByRole("searchbox").fill("ChangeSetSupport");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.ChangeSetSupport", {
        exact: true,
      }),
    })
    .click();
  await window.getByRole("button", { name: "捕获 Class Dump" }).click();
  await window.getByRole("button", { name: "确认捕获" }).click();
  await expect(classChangeSet).toContainText("2/8 个类", {
    timeout: 15_000,
  });
  await expect(classChangeSet).toContainText(
    "dev.tanwei.integration.TestTargetMain",
  );
  await expect(classChangeSet).toContainText(
    "dev.tanwei.integration.ChangeSetSupport",
  );
  await classChangeSet.getByRole("button", { name: "联合编译并预检" }).click();
  await expect(classChangeSet).toContainText("变更集预检指纹", {
    timeout: 15_000,
  });
  await classChangeSet
    .getByLabel(
      "我已核对全部精确类、ClassLoader、预检指纹和 R3 影响，并保留整体内存回滚。",
    )
    .check();
  const changeSetOutput = waitForOutput(
    requiredTargetProcess(),
    "TANWEI_CHANGE_SET=batch-main/support-after",
    15_000,
  );
  await classChangeSet.getByRole("button", { name: "整体提交变更集" }).click();
  await changeSetOutput;
  await expect(classChangeSet).toContainText(
    "全部类已通过一次 JVM 原子重定义提交。",
  );
  await screenshotVisiblePanel(
    window,
    classChangeSet,
    "atomic-class-change-set.png",
  );
  await classChangeSet
    .getByLabel(
      "我确认仅在全部当前校验值仍匹配时，通过一次 JVM 重定义整体恢复这组类。",
    )
    .check();
  const changeSetRestoredOutput = waitForOutput(
    requiredTargetProcess(),
    "TANWEI_CHANGE_SET=before/support-before",
    15_000,
  );
  await classChangeSet.getByRole("button", { name: "整体回滚变更集" }).click();
  await changeSetRestoredOutput;
  await expect(classChangeSet).toContainText(
    "全部类已通过一次 JVM 原子重定义恢复。",
  );

  await window.getByRole("searchbox").fill("HeapProbe");
  await window.getByRole("button", { name: "搜索" }).click();
  await window
    .locator("button.class-row")
    .filter({
      has: window.getByText("dev.tanwei.integration.HeapProbe", {
        exact: true,
      }),
    })
    .click();
  await window
    .getByLabel(
      "我理解 JVMTI Heap 扫描可能暂停目标，并会在当前页面显示对象字段。",
    )
    .check();
  await window.getByRole("button", { name: "确认并查询实例" }).click();
  const heapInstanceRows = window.locator(
    ".heap-query__results [data-slot='collapsible']",
  );
  await expect(heapInstanceRows).toHaveCount(3, { timeout: 15_000 });
  for (let index = 0; index < 3; index += 1) {
    await heapInstanceRows
      .nth(index)
      .locator("[data-slot='collapsible-trigger']")
      .click();
  }
  await expect(window.getByText("alpha", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  await expect(window.getByText("33", { exact: true })).toBeVisible();
  await heapInstanceRows
    .first()
    .getByRole("button", { name: "检查对象关系" })
    .click();
  const objectRelationInspector = window.locator(".heap-relations");
  await expect(
    objectRelationInspector.getByRole("heading", {
      name: "对象关系检查器",
    }),
  ).toBeVisible();
  await objectRelationInspector
    .getByLabel(/我确认检查对象 @.* 的直接引用/u)
    .check();
  await objectRelationInspector
    .getByRole("button", { name: "开始关系检查" })
    .click();
  const heapLeafRelation = objectRelationInspector
    .locator(".heap-relation-card")
    .filter({ hasText: "dev.tanwei.integration.HeapLeaf" });
  await expect(heapLeafRelation).toBeVisible({ timeout: 15_000 });
  await heapLeafRelation.getByRole("button", { name: "沿此对象继续" }).click();
  await objectRelationInspector.getByRole("tab", { name: "入向引用" }).click();
  await selectShadcnValue(
    objectRelationInspector.getByLabel("扫描边预算"),
    "1000000",
  );
  await objectRelationInspector
    .getByLabel(/我确认检查对象 @.* 的直接引用/u)
    .check();
  await objectRelationInspector
    .getByRole("button", { name: "开始关系检查" })
    .click();
  await expect(
    objectRelationInspector
      .locator(".heap-relation-card")
      .filter({ hasText: "dev.tanwei.integration.HeapProbe" }),
  ).toBeVisible({ timeout: 30_000 });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "object-relation-inspector.png",
    ),
    fullPage: true,
  });
  await objectRelationInspector
    .getByRole("tab", { name: "多层对象图" })
    .click();
  await selectShadcnValue(
    objectRelationInspector.getByLabel("图方向"),
    "INCOMING",
  );
  await selectShadcnValue(
    objectRelationInspector.getByLabel("最大图深度"),
    "4",
  );
  await selectShadcnValue(
    objectRelationInspector.getByLabel("图节点上限"),
    "40",
  );
  await selectShadcnValue(
    objectRelationInspector.getByLabel("每节点分支上限"),
    "4",
  );
  await objectRelationInspector
    .getByLabel(
      /我确认以对象 @.* 为中心按最大深度 4 展开.*最多返回 40 个节点、每节点 4 条入向关系/u,
    )
    .check();
  await objectRelationInspector
    .getByRole("button", { name: "生成多层对象图" })
    .click();
  await expect
    .poll(() =>
      objectRelationInspector.locator(".heap-object-graph__layer").count(),
    )
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() =>
      objectRelationInspector.locator(".heap-object-graph__node").count(),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(
    objectRelationInspector.getByText(
      "入向图合并多条保留路径；重复持有者合并为同一节点。",
      { exact: true },
    ),
  ).toBeVisible();
  await objectRelationInspector
    .locator(".heap-object-graph__layer")
    .first()
    .scrollIntoViewIfNeeded();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "object-graph-inspector.png",
    ),
    fullPage: true,
  });
  await objectRelationInspector
    .getByRole("tab", { name: "GC Root 路径" })
    .click();
  await objectRelationInspector.getByLabel("最大路径深度").fill("16");
  await selectShadcnValue(objectRelationInspector.getByLabel("路径上限"), "4");
  await selectShadcnValue(
    objectRelationInspector.getByLabel("临时标记对象预算"),
    "100000",
  );
  await objectRelationInspector
    .getByLabel(/我确认对对象 @.* 执行一次有界全堆引用扫描.*最多返回 4 条路径/u)
    .check();
  await objectRelationInspector
    .getByRole("button", { name: "回溯多条 GC Root 路径" })
    .click();
  await expect
    .poll(() =>
      objectRelationInspector.locator(".heap-root-path-group").count(),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(objectRelationInspector).toContainText(
    /\d+\/\d+ 条路径到达 GC Root · 结果有界/u,
  );
  await expect(
    objectRelationInspector
      .getByText("dev.tanwei.integration.HeapLeaf", { exact: true })
      .first(),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "gc-root-paths-inspector.png",
    ),
    fullPage: true,
  });
  await objectRelationInspector
    .getByRole("button", { name: "返回上一对象" })
    .click();
  await objectRelationInspector
    .getByRole("tab", { name: "Retained / 支配" })
    .click();
  await selectShadcnValue(
    objectRelationInspector.getByLabel("临时标记对象预算"),
    "100000",
  );
  await objectRelationInspector
    .getByLabel(/我确认对对象 @.* 执行两次有界强引用扫描/u)
    .check();
  await objectRelationInspector
    .getByRole("button", { name: "计算 Retained size" })
    .click();
  await expect(
    objectRelationInspector.getByText("精确结果", { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    objectRelationInspector
      .locator(".heap-relation-card")
      .filter({ hasText: "dev.tanwei.integration.HeapLeaf" }),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "retained-size-inspector.png",
    ),
    fullPage: true,
  });
  const retainedRankingInspector = window.locator(".heap-ranking");
  await selectShadcnValue(
    retainedRankingInspector.getByLabel("样本实例数"),
    "3",
  );
  await selectShadcnValue(
    retainedRankingInspector.getByLabel("支配图节点预算"),
    "500000",
  );
  await selectShadcnValue(
    retainedRankingInspector.getByLabel("支配图边预算"),
    "2000000",
  );
  await retainedRankingInspector
    .getByLabel(
      /我确认对 dev\.tanwei\.integration\.HeapProbe 采样最多 3 个实例.*500,000 个节点、2,000,000 条强引用边/u,
    )
    .check();
  await retainedRankingInspector
    .getByRole("button", { name: "计算样本 Retained 排行" })
    .click();
  await expect(
    retainedRankingInspector.getByText("精确排行", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    retainedRankingInspector.locator(".heap-ranking-card"),
  ).toHaveCount(3);
  await expect(
    retainedRankingInspector
      .getByText("精确 Retained", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await retainedRankingInspector
    .locator(".heap-ranking-card")
    .first()
    .scrollIntoViewIfNeeded();
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "retained-ranking-inspector.png",
    ),
    fullPage: true,
  });
  await retainedRankingInspector
    .locator(".heap-ranking-card")
    .first()
    .getByRole("button", { name: "检查此对象" })
    .click();
  await expect(
    window.getByRole("heading", { name: "对象关系检查器" }),
  ).toBeVisible();

  await window.getByRole("link", { name: /运行时/ }).click();
  await expect(
    window.getByRole("heading", { name: "运行时事实。" }),
  ).toBeVisible();
  await expect(
    window
      .locator(".runtime-result")
      .first()
      .getByText("java.version", { exact: true }),
  ).toBeVisible();
  await window.getByRole("tab", { name: "系统属性", exact: true }).click();
  const propertyInspector = window.locator("section.property-inspector");
  await expect(
    propertyInspector.getByRole("heading", {
      name: "检查 JVM 配置，并精确进入修改预检。",
    }),
  ).toBeVisible();
  await propertyInspector
    .getByLabel("系统属性名称")
    .fill("tanwei.integration.visible");
  const propertySearchButton = propertyInspector.getByRole("button", {
    name: "搜索属性",
  });
  await propertySearchButton.click();
  const visibleProperty = propertyInspector.getByRole("button", {
    name: /^tanwei\.integration\.visible\s/,
  });
  await expect(visibleProperty).toBeVisible();
  await propertySearchButton.focus();
  await window.keyboard.press("Tab");
  await expect(visibleProperty).toBeFocused();
  await expect(visibleProperty).toHaveCSS("border-radius", "8px");
  await expect(visibleProperty).toHaveCSS("box-shadow", /^(?!.*inset).*3px/u);
  expect(
    await visibleProperty.evaluate((element) =>
      element.matches(":focus-visible"),
    ),
  ).toBe(true);
  await propertyInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "system-property-focus.png",
    ),
    animations: "disabled",
  });
  await visibleProperty.click();
  await expect(
    propertyInspector.locator(".property-inspector__detail pre"),
  ).toHaveText("desktop-property");

  await propertyInspector
    .getByLabel("系统属性名称")
    .fill("tanwei.integration.password");
  await propertyInspector.getByRole("button", { name: "搜索属性" }).click();
  const maskedProperty = propertyInspector.getByRole("button", {
    name: /^tanwei\.integration\.password\s/,
  });
  await expect(maskedProperty).toBeVisible();
  await maskedProperty.click();
  await expect(
    propertyInspector.locator(".property-inspector__detail pre"),
  ).toHaveText("<masked>");
  await expect(propertyInspector).toContainText("值未离开 Agent");
  await expect(window.getByText("never-return-property-secret")).toHaveCount(0);
  await propertyInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "system-property-inspector.png",
    ),
  });
  const systemPropertyViewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  await window.setViewportSize({ width: 1920, height: 1080 });
  await expectPageToFillWorkspace(window);
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "system-property-full-width.png",
    ),
    animations: "disabled",
  });
  await window.setViewportSize(systemPropertyViewport);

  await window.getByRole("tab", { name: "环境变量", exact: true }).click();
  const environmentExplorer = window.locator("section.environment-explorer");
  await expect(
    environmentExplorer.getByRole("heading", {
      name: "检查进程环境，不暴露秘密。",
    }),
  ).toBeVisible();
  await environmentExplorer.getByLabel("环境变量名称").fill("LANG");
  await environmentExplorer.getByRole("button", { name: "搜索环境" }).click();
  const languageEnvironment = environmentExplorer.getByRole("button", {
    name: /^LANG\s/,
  });
  await expect(languageEnvironment).toBeVisible();
  await languageEnvironment.click();
  await expect(
    environmentExplorer.locator(".environment-explorer__detail pre"),
  ).toHaveText("en_US.UTF-8");

  await environmentExplorer.getByLabel("环境变量名称").fill("TANWEI_E2E_TOKEN");
  await environmentExplorer.getByRole("button", { name: "搜索环境" }).click();
  const maskedEnvironment = environmentExplorer.getByRole("button", {
    name: /^TANWEI_E2E_TOKEN\s/,
  });
  await expect(maskedEnvironment).toBeVisible();
  await maskedEnvironment.click();
  await expect(
    environmentExplorer.locator(".environment-explorer__detail pre"),
  ).toHaveText("<masked>");
  await expect(environmentExplorer).toContainText("值未离开 Agent");
  await expect(window.getByText("never-return-this-secret")).toHaveCount(0);
  await environmentExplorer.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "environment-explorer.png",
    ),
  });

  await window.getByRole("tab", { name: "VM Options", exact: true }).click();
  const vmOptionInspector = window.locator("section.vm-option-inspector");
  await expect(
    vmOptionInspector.getByRole("heading", {
      name: "检查 HotSpot 选项，再决定是否修改。",
    }),
  ).toBeVisible();
  await vmOptionInspector
    .getByLabel("VM Option 名称")
    .fill("HeapDumpOnOutOfMemoryError");
  await vmOptionInspector.getByRole("button", { name: "搜索选项" }).click();
  const heapDumpOption = vmOptionInspector.getByRole("button", {
    name: /^HeapDumpOnOutOfMemoryError\s/,
  });
  await expect(heapDumpOption).toBeVisible();
  await heapDumpOption.click();
  await expect(
    vmOptionInspector.locator(".vm-option-inspector__detail pre"),
  ).toHaveText(/^(true|false)$/u);
  await expect(
    vmOptionInspector.getByRole("button", { name: "带入 R3 修改预检" }),
  ).toBeVisible();
  await vmOptionInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "vm-option-inspector.png",
    ),
  });
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "runtime-vm-options-workspace.png",
    ),
    fullPage: true,
  });

  await window.getByRole("tab", { name: "系统属性", exact: true }).click();
  await propertyInspector
    .getByLabel("系统属性名称")
    .fill("tanwei.integration.mutable");
  await propertyInspector.getByRole("button", { name: "搜索属性" }).click();
  await propertyInspector
    .getByRole("button", { name: /^tanwei\.integration\.mutable\s/ })
    .click();
  await propertyInspector
    .getByRole("button", { name: "带入 R3 修改预检" })
    .click();
  const mutationPropertyName = window.getByRole("textbox", {
    name: "系统属性名",
    exact: true,
  });
  await expect(mutationPropertyName).toHaveValue("tanwei.integration.mutable");
  await window.getByLabel("新值").fill("after-e2e");
  await window.getByRole("button", { name: "读取旧值并生成影响预览" }).click();
  const mutationPreview = window.locator(".mutation-preview");
  await expect(
    mutationPreview.getByText("before", { exact: true }),
  ).toBeVisible();
  await mutationPreview
    .getByLabel("我已核对精确目标、旧值、新值与影响。")
    .check();
  await mutationPreview
    .getByRole("button", { name: "确认执行受控修改" })
    .click();
  const mutationResult = window.locator(".runtime-result").last();
  await expect(
    mutationResult.getByText("after-e2e", { exact: true }).first(),
  ).toBeVisible();

  await window.getByLabel("新值").fill("before");
  await window.getByRole("button", { name: "读取旧值并生成影响预览" }).click();
  await expect(
    mutationPreview.getByText("after-e2e", { exact: true }),
  ).toBeVisible();
  await mutationPreview
    .getByLabel("我已核对精确目标、旧值、新值与影响。")
    .check();
  await mutationPreview
    .getByRole("button", { name: "确认执行受控修改" })
    .click();

  await window.getByRole("link", { name: /剖析/ }).click();
  await expect(
    window.getByRole("heading", { name: "留下可验证的性能证据。" }),
  ).toBeVisible();
  const heapHistogramInspector = window.locator("section.heap-histogram");
  await heapHistogramInspector
    .getByPlaceholder("例如 dev.example 或 java.lang.String")
    .fill("dev.tanwei.integration.Heap");
  await heapHistogramInspector
    .getByLabel("我理解遍历 Heap 可能造成目标 JVM 短暂停顿。")
    .check();
  await heapHistogramInspector
    .getByRole("button", { name: "扫描Heap直方图" })
    .click();
  const heapProbeHistogramCell = heapHistogramInspector.getByRole("cell", {
    name: "dev.tanwei.integration.HeapProbe",
    exact: true,
  });
  await expect(heapProbeHistogramCell).toBeVisible({ timeout: 30_000 });
  const heapProbeHistogramRow = heapProbeHistogramCell.locator("..");
  await expect(
    heapProbeHistogramRow.getByText("3", { exact: true }),
  ).toBeVisible();
  await expect(
    heapHistogramInspector.getByText("已扫描", { exact: true }),
  ).toBeVisible();
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await heapHistogramInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "heap-class-histogram.png",
    ),
  });
  const heapHistogramDiff = heapHistogramInspector.locator(
    "section.heap-histogram-diff",
  );
  await heapHistogramDiff
    .getByRole("button", { name: "保存跨会话快照" })
    .click();
  await expect(window.locator(".artifact-result__name")).toContainText(
    "tanwei-heap-histogram-",
  );
  await heapHistogramDiff
    .getByRole("button", { name: "固定当前为基线" })
    .click();
  await expect(
    heapHistogramDiff.getByText("基线", { exact: true }),
  ).toBeVisible();
  const targetPid = requiredTargetProcess().pid;
  if (typeof targetPid !== "number") {
    throw new Error("The E2E target PID is unavailable");
  }
  const retainedHeapProbes = await window.evaluate(async (pid) => {
    const targets = await window.tanwei.listTargets();
    const target = targets.value?.find((item) => item.pid === pid);
    if (!targets.ok || !target) {
      throw new Error("Unable to resolve the E2E target");
    }
    const parameters = {
      objectName: "dev.tanwei.integration:type=Control",
      operation: "retainHeapProbes",
      parameterTypes: "int",
      argumentCount: "1",
      argument0: "12",
      argument1: "",
      argument2: "",
      argument3: "",
      argument4: "",
      argument5: "",
      argument6: "",
      argument7: "",
    };
    const preview = await window.tanwei.executeAction({
      targetId: target.id,
      actionId: "mbean.operation.preview",
      parameters,
    });
    const fingerprint = preview.value?.values.fingerprint;
    if (!preview.ok || preview.value?.status !== "SUCCEEDED" || !fingerprint) {
      throw new Error(preview.errorMessage ?? "Heap growth preview failed");
    }
    const invocation = await window.tanwei.executeAction({
      targetId: target.id,
      actionId: "mbean.operation.invoke",
      parameters: {
        ...parameters,
        expectedFingerprint: fingerprint,
        confirmed: "true",
        confirmedSecondary: "true",
      },
    });
    if (!invocation.ok || invocation.value?.status !== "SUCCEEDED") {
      throw new Error(
        invocation.errorMessage ?? "Heap growth invocation failed",
      );
    }
    return Number(invocation.value.values.returnValue);
  }, targetPid);
  expect(retainedHeapProbes).toBe(12);
  await heapHistogramInspector
    .getByLabel("我理解遍历 Heap 可能造成目标 JVM 短暂停顿。")
    .check();
  await heapHistogramInspector
    .getByRole("button", { name: "扫描Heap直方图" })
    .click();
  const heapProbeDiffRow = heapHistogramDiff
    .getByText("dev.tanwei.integration.HeapProbe", { exact: true })
    .locator("../..");
  await expect(heapProbeDiffRow).toBeVisible({ timeout: 30_000 });
  await expect(heapProbeDiffRow.locator("td").nth(3)).toHaveText(
    /^\+[1-9]\d*$/u,
  );
  await expect(heapProbeDiffRow.locator("td").nth(4)).toHaveText(/^\+/u);
  await heapHistogramDiff
    .getByRole("button", { name: "保存跨会话快照" })
    .click();
  await expect(window.locator(".artifact-result__name")).toContainText(
    "tanwei-heap-histogram-",
  );
  await screenshotVisiblePanel(
    window,
    heapHistogramDiff,
    "heap-histogram-diff-inspector.png",
  );
  const classRetainedInspector = window.locator("section.class-retained");
  await classRetainedInspector
    .getByPlaceholder("例如 dev.example 或 ClassLoader")
    .fill("dev.tanwei.integration.Heap");
  await selectShadcnValue(classRetainedInspector.getByLabel("结果行数"), "20");
  await selectShadcnValue(
    classRetainedInspector.getByLabel("支配图节点预算"),
    "500000",
  );
  await selectShadcnValue(
    classRetainedInspector.getByLabel("支配图边预算"),
    "2000000",
  );
  await classRetainedInspector
    .getByLabel(
      /我确认执行一次有界全堆强引用扫描.*500,000 个节点、2,000,000 条边/u,
    )
    .check();
  await classRetainedInspector
    .getByRole("button", { name: "计算类 Retained 排行" })
    .click();
  await expect(
    classRetainedInspector.getByText("精确类排行", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  const retainedHeapProbeRow = classRetainedInspector
    .getByRole("cell", {
      name: /^dev\.tanwei\.integration\.HeapProbe(?:\s|$)/u,
    })
    .locator("..");
  await expect(retainedHeapProbeRow).toBeVisible();
  await expect(
    retainedHeapProbeRow.getByRole("button", {
      name: "检查实例",
    }),
  ).toBeVisible();
  await classRetainedInspector.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "class-retained-ranking.png",
    ),
  });
  await retainedHeapProbeRow.getByRole("button", { name: "检查实例" }).click();
  await expect(
    window.getByRole("heading", { name: "类与加载器。" }),
  ).toBeVisible();
  await expect(
    window.getByRole("heading", {
      name: "dev.tanwei.integration.HeapProbe",
    }),
  ).toBeVisible();
  await window.getByRole("link", { name: /剖析/ }).click();
  const dominatorTreeInspector = window.locator("section.dominator-tree");
  await selectShadcnValue(dominatorTreeInspector.getByLabel("视图深度"), "4");
  await selectShadcnValue(dominatorTreeInspector.getByLabel("视图节点"), "80");
  await selectShadcnValue(
    dominatorTreeInspector.getByLabel("GC Root 分支"),
    "10",
  );
  await selectShadcnValue(dominatorTreeInspector.getByLabel("每节点分支"), "5");
  await selectShadcnValue(
    dominatorTreeInspector.getByLabel("支配图节点预算"),
    "500000",
  );
  await selectShadcnValue(
    dominatorTreeInspector.getByLabel("支配图边预算"),
    "2000000",
  );
  await dominatorTreeInspector
    .getByLabel(
      /我确认构建最多 500,000 个节点、2,000,000 条边的全堆支配图，并仅展示最多 80 个关键节点/u,
    )
    .check();
  await dominatorTreeInspector
    .getByRole("button", { name: "构建支配树" })
    .click();
  await expect(
    dominatorTreeInspector.getByText("精确支配树", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  const dominatorTreeNodes = dominatorTreeInspector.locator(
    "article.dominator-tree__node",
  );
  await expect(dominatorTreeNodes.first()).toBeVisible();
  let collapsibleNodeIndex = -1;
  const dominatorTreeNodeCount = await dominatorTreeNodes.count();
  for (let index = 0; index < dominatorTreeNodeCount; index += 1) {
    if (
      (await dominatorTreeNodes
        .nth(index)
        .getByRole("button", { name: "折叠支配子树" })
        .count()) > 0
    ) {
      collapsibleNodeIndex = index;
      break;
    }
  }
  expect(collapsibleNodeIndex).toBeGreaterThanOrEqual(0);
  const collapsibleDominatorNode = dominatorTreeNodes.nth(collapsibleNodeIndex);
  const expandedNodeCount = await dominatorTreeNodes.count();
  await collapsibleDominatorNode
    .getByRole("button", { name: "折叠支配子树" })
    .click();
  await expect(
    collapsibleDominatorNode.getByRole("button", {
      name: "展开支配子树",
    }),
  ).toBeVisible();
  await expect
    .poll(() => dominatorTreeNodes.count())
    .toBeLessThan(expandedNodeCount);
  await collapsibleDominatorNode
    .getByRole("button", { name: "展开支配子树" })
    .click();
  await expect(dominatorTreeNodes).toHaveCount(expandedNodeCount);
  await dominatorTreeInspector.locator(".dominator-tree__canvas").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "dominator-tree-inspector.png",
    ),
  });
  await dominatorTreeNodes
    .first()
    .getByRole("button", { name: "检查对象" })
    .click();
  await expect(
    window.getByRole("heading", { name: "类与加载器。" }),
  ).toBeVisible();
  await expect(
    window.getByRole("heading", { name: "对象关系检查器" }),
  ).toBeVisible();
  await window.getByRole("link", { name: /剖析/ }).click();
  await window.getByRole("button", { name: "开始剖析" }).click();
  await expect(window.getByText(/RUNNING/u)).toBeVisible();
  await requiredElectronApplication().evaluate(({ app }) => {
    app.quit();
  });
  const exitGuard = window.getByRole("dialog", {
    name: "退出会终止仍在运行的诊断。",
  });
  await expect(exitGuard).toBeVisible();
  await expect(
    exitGuard
      .locator(".exit-guard__metrics article")
      .filter({ hasText: "ACTIVE TASKS" })
      .locator("strong"),
  ).toHaveText(/[1-9]\d*/u);
  await expect(exitGuard).toContainText(
    "dev.tanwei.integration.TestTargetMain",
  );
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "exit-guard.png"),
  });
  await exitGuard.getByRole("button", { name: "查看任务中心" }).click();
  await expect(
    window.getByRole("heading", { name: "持续任务，一处收束。" }),
  ).toBeVisible();
  const managedProfileTask = window
    .locator("button.task-row")
    .filter({ hasText: "CPU Profile" });
  await expect(managedProfileTask).toBeVisible();
  await window.getByRole("button", { name: "扫描会话状态" }).click();
  const resetInspector = window.locator("section.session-reset");
  await expect(
    resetInspector
      .locator(".session-reset__items article")
      .filter({ hasText: "性能剖析" }),
  ).toBeVisible();
  await resetInspector
    .getByLabel(
      "我确认停止预检中列出的全部探微任务，并回收 Profile / JFR 制品。",
    )
    .check();
  await resetInspector
    .getByLabel(
      "我确认重试失败的增强回滚，并恢复探微仍持有回滚链的类；遇到指纹漂移或外部变更时保留现状。",
    )
    .check();
  await resetInspector.getByRole("button", { name: "执行统一恢复" }).click();
  await expect(
    resetInspector.getByRole("heading", {
      name: "已恢复到无探微增强状态。",
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(window.getByText("RESET ARTIFACTS")).toBeVisible({
    timeout: 15_000,
  });
  await expect(managedProfileTask).toHaveCount(0);
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "session-reset.png"),
    fullPage: true,
  });

  await window.getByRole("link", { name: /剖析/ }).click();
  await window.getByLabel("时长（秒）").fill("1");
  await window.getByRole("button", { name: "开始剖析" }).click();
  await expect(window.getByText(/RUNNING/u)).toBeVisible();
  await expect(window.getByText("ARTIFACT READY")).toBeVisible({
    timeout: 15_000,
  });
  const profileReportWindowPromise =
    requiredElectronApplication().waitForEvent("window");
  await window.getByRole("button", { name: "打开交互报告" }).click();
  const profileReportWindow = await profileReportWindowPromise;
  await profileReportWindow.waitForLoadState("domcontentloaded");
  await expect(profileReportWindow).toHaveTitle(/探微 · 性能报告/u);
  const profilePalette = profileReportWindow.getByRole("button", {
    name: "原生彩色",
  });
  await expect(profilePalette).toHaveAttribute("aria-pressed", "true");
  await profilePalette.click();
  await expect(profilePalette).toHaveAttribute("aria-pressed", "false");
  await profilePalette.click();
  await expect(profilePalette).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const text = await profileReportWindow.locator("body").textContent();
      return text?.trim().length ?? 0;
    })
    .toBeGreaterThan(20);
  await profileReportWindow
    .getByRole("searchbox", { name: "筛选方法" })
    .fill("DiagnosticService");
  await profileReportWindow.getByRole("button", { name: "筛选" }).click();
  await expect(profileReportWindow.locator("#match")).toContainText("Matched:");
  await profileReportWindow.getByRole("button", { name: "清除" }).click();
  await expect(profileReportWindow.locator("#match")).toBeHidden();
  await profileReportWindow.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "profile-report-viewer.png",
    ),
    fullPage: true,
  });
  await profileReportWindow.close();
  await window.getByRole("button", { name: "开始记录" }).click();
  await expect(window.getByText("记录中")).toBeVisible();
  await window.waitForTimeout(1_500);
  await window.getByRole("button", { name: "停止并保存" }).click();
  await expect(window.getByText("ARTIFACT READY")).toBeVisible({
    timeout: 15_000,
  });
  await window.getByRole("button", { name: "分析JFR" }).click();
  await expect(
    window.getByRole("heading", { name: "证据成为文件。" }),
  ).toBeVisible();
  const jfrInspector = window.locator("section.jfr-inspector");
  await expect(
    jfrInspector.getByRole("heading", { name: "录制内容，直接检查。" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      const value = await jfrInspector
        .locator(".jfr-metrics dd")
        .first()
        .textContent();
      return Number(value?.replaceAll(",", "") ?? 0);
    })
    .toBeGreaterThan(0);
  await expect(
    jfrInspector.getByRole("heading", { name: "编译热点" }),
  ).toBeVisible();
  await expect(
    jfrInspector.getByRole("heading", { name: "编译器分层" }),
  ).toBeVisible();
  await expect(
    jfrInspector.getByRole("heading", { name: "去优化原因" }),
  ).toBeVisible();
  await expect(
    jfrInspector.locator(".jfr-event-types li").first(),
  ).toBeVisible();
  await screenshotVisiblePanel(
    window,
    jfrInspector,
    "jfr-compilation-inspector.png",
  );
  const threadPoolTrendArtifacts = window
    .locator(".artifact-list article")
    .filter({ hasText: "THREAD_POOL_TREND" });
  await expect(threadPoolTrendArtifacts).toHaveCount(2);
  await threadPoolTrendArtifacts
    .first()
    .getByRole("button", { name: "检查池趋势" })
    .click();
  const persistedPoolTrend = window.getByTestId(
    "pool-trend-artifact-inspector",
  );
  await expect(
    persistedPoolTrend.getByRole("heading", {
      name: "把池饱和与队列增长留成证据。",
    }),
  ).toBeVisible();
  await expect(persistedPoolTrend.getByLabel("基线池趋势")).toHaveText(/\S/u);
  await persistedPoolTrend.getByTestId("compare-thread-pool-trends").click();
  await expect(
    persistedPoolTrend.locator(".pool-trend-artifact-comparison__table-wrap"),
  ).toBeVisible();
  await screenshotVisiblePanel(
    window,
    persistedPoolTrend,
    "thread-pool-trend-comparison.png",
  );
  await persistedPoolTrend.getByRole("button", { name: "关闭检查器" }).click();
  const heapHistogramArtifacts = window
    .locator(".artifact-list article")
    .filter({ hasText: "HEAP_HISTOGRAM" });
  await expect(heapHistogramArtifacts).toHaveCount(2);
  await heapHistogramArtifacts
    .first()
    .getByRole("button", { name: "检查Heap快照" })
    .click();
  const persistedHeapDiff = window.locator("section.heap-artifact-inspector");
  await expect(
    persistedHeapDiff.getByRole("heading", {
      name: "内存证据，跨会话重新比较。",
    }),
  ).toBeVisible();
  await expect(persistedHeapDiff.getByLabel("基线 Heap 快照")).toHaveText(
    /\S/u,
  );
  await persistedHeapDiff
    .getByRole("button", { name: "生成跨会话差异" })
    .click();
  const persistedHeapProbeRow = persistedHeapDiff
    .getByText("dev.tanwei.integration.HeapProbe", { exact: true })
    .locator("../..");
  await expect(persistedHeapProbeRow).toBeVisible();
  await expect(persistedHeapProbeRow.locator("td").nth(3)).toHaveText("+12");
  await expect(persistedHeapProbeRow.locator("td").nth(4)).toHaveText("+288 B");
  await screenshotVisiblePanel(
    window,
    persistedHeapDiff,
    "heap-histogram-artifact-diff.png",
  );
  await persistedHeapDiff.getByRole("button", { name: "关闭检查器" }).click();
  await window.getByRole("button", { name: "固定当前快照" }).click();
  await expect(window.getByText(/tanwei-snapshot-/)).toBeVisible();
  await expect(window.getByText("READY").first()).toBeVisible();

  await window.getByRole("link", { name: /案例/ }).click();
  await expect(
    window.getByRole("heading", { name: "诊断形成上下文。" }),
  ).toBeVisible();
  await window.getByLabel("标题").fill("E2E CPU 诊断");
  await window.getByLabel("标签（逗号分隔）").fill("cpu, e2e");
  await window.getByLabel("笔记").fill("由打包 App 创建并持久化。");
  await window.getByRole("button", { name: "创建案例" }).click();
  await expect(
    window.getByRole("heading", { name: "E2E CPU 诊断" }),
  ).toBeVisible();
  await window.reload();
  await expect(
    window.getByRole("heading", { name: "E2E CPU 诊断" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "证据与导出" }).click();
  const evidenceCheckboxes = window.getByRole("checkbox");
  if ((await evidenceCheckboxes.count()) > 0) {
    await evidenceCheckboxes.first().check();
  }
  await window.getByRole("button", { name: "固定所选证据" }).click();
  await window.getByRole("button", { name: "脱敏预览" }).click();
  await expect(window.getByText("EXPORT PREVIEW / SCHEMA 1")).toBeVisible();
  await window.getByRole("button", { name: "确认导出为制品" }).click();
  await window.getByRole("button", { name: "归档" }).click();
  await expect(window.getByText("已归档")).toBeVisible();

  await window.getByRole("link", { name: /治理/ }).click();
  await expect(
    window.getByRole("heading", { name: "把诊断能力变成可验证资产。" }),
  ).toBeVisible();
  await window.getByRole("button", { name: "新建模板" }).first().click();
  await window.getByLabel("名称").fill("E2E JVM 信息");
  await window.getByLabel("参数 JSON（仅字符串值）").fill("{}");
  await window.getByRole("button", { name: "校验并签名模板" }).click();
  await expect(window.getByText("诊断模板已签名并保存。")).toBeVisible();
  const signedTemplate = window
    .locator("article.asset-card")
    .filter({ hasText: "E2E JVM 信息" });
  await expect(signedTemplate.getByText("SIGNED")).toBeVisible();
  await signedTemplate.getByRole("button", { name: "对当前目标执行" }).click();
  await expect(
    window.getByText("模板已执行：jvm.info · SUCCEEDED"),
  ).toBeVisible();
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "governance.png"),
    fullPage: true,
  });

  await window.getByRole("link", { name: /审计/ }).click();
  await expect(
    window.getByRole("heading", { name: "每一次诊断，都能追溯。" }),
  ).toBeVisible();
  await expect(
    window.getByTestId("audit-retained").locator("strong"),
  ).not.toHaveText("0");
  await window.getByLabel("搜索审计").fill("jvm.info");
  await window.getByRole("button", { name: "查询" }).click();
  const jvmInfoAuditRow = window
    .locator('[data-slot="table-row"]')
    .filter({ hasText: "jvm.info" })
    .first();
  await expect(jvmInfoAuditRow).toBeVisible();
  await expect(jvmInfoAuditRow).toContainText("SUCCEEDED");
  await jvmInfoAuditRow
    .getByRole("button", { name: "查看 jvm.info 审计详情" })
    .click();
  const auditDetail = window.getByTestId("audit-detail");
  await expect(auditDetail).toContainText("Host 权威摘要");
  await expect(auditDetail).toContainText("java.version");
  await window.screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "diagnostic-audit.png",
    ),
    fullPage: true,
    animations: "disabled",
  });
  await window.reload();
  await expect(
    window.getByRole("heading", { name: "每一次诊断，都能追溯。" }),
  ).toBeVisible();
  await expect(
    window
      .locator('[data-slot="table-row"]')
      .filter({ hasText: "jvm.info" })
      .first(),
  ).toBeVisible();
  await window
    .getByRole("button", { name: "查看 jvm.info 审计详情" })
    .first()
    .click();
  await window.getByRole("button", { name: "加入案例证据" }).click();
  await expect(window.locator(".case-notice")).toContainText(
    "已从诊断审计带入 Action",
  );
  await window.getByRole("button", { name: "证据与导出" }).click();
  const requestedAuditEvidence = window
    .locator(".case-evidence label[data-task-id]")
    .filter({ hasText: "jvm.info" })
    .first();
  await expect(requestedAuditEvidence.getByRole("checkbox")).toBeChecked();

  await window.getByRole("link", { name: /设置/ }).click();
  await expect(window.getByTestId("system-notification-policy")).toContainText(
    "警告与严重事件",
  );
  await window.getByTestId("system-notification-settings").screenshot({
    path: path.join(
      projectRoot,
      "output",
      "playwright",
      "system-notification-settings.png",
    ),
    animations: "disabled",
  });
  await window.getByRole("button", { name: "生成本地支持包" }).click();
  await expect(window.getByText(/tanwei-support-/u)).toBeVisible();

  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", "runtime.png"),
    fullPage: true,
  });
});

test("shadcn neutral dark contract holds across desktop widths", async () => {
  const window = requiredPage();
  await window.setViewportSize({ width: 767, height: 720 });
  expect(await gridColumnCount(window)).toBe(1);

  await window.setViewportSize({ width: 768, height: 720 });
  expect(await gridColumnCount(window)).toBe(2);

  const workspaceModeTabs = window.getByRole("tablist", {
    name: "工作模式",
  });
  const representativePages = [
    { mode: "目标", heading: "连接目标。" },
    { mode: "诊断", heading: "运行正在发生。" },
    { mode: "治理", heading: "把诊断能力变成可验证资产。" },
  ] as const;
  for (const { mode, heading } of representativePages) {
    await workspaceModeTabs.getByRole("tab", { name: mode }).click();
    await expect(window.getByRole("heading", { name: heading })).toBeVisible();
    for (const width of [1024, 1440, 1920]) {
      await window.setViewportSize({ width, height: 900 });
      await expectPageToFillWorkspace(window);
    }
  }

  await window.setViewportSize({ width: 1920, height: 900 });
  const routeLinks = window.locator(
    ".navigation a[href], .sidebar__footer a[href]",
  );
  const routeCount = await routeLinks.count();
  expect(routeCount).toBeGreaterThan(15);
  for (let index = 0; index < routeCount; index += 1) {
    const routeLink = routeLinks.nth(index);
    await routeLink.click();
    await expect(routeLink).toHaveClass(/router-link-active/u);
    await expectPageToFillWorkspace(window);
    await expectNoLargePrimarySurfaces(
      window.locator(".workspace__content > .page"),
    );
  }

  const designValues = await window.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const defaultBorderProbe = document.createElement("div");
    defaultBorderProbe.className = "border text-foreground";
    const tokenBorderProbe = document.createElement("div");
    tokenBorderProbe.style.border = "1px solid var(--border)";
    document.body.append(defaultBorderProbe, tokenBorderProbe);
    const defaultBorderColor =
      getComputedStyle(defaultBorderProbe).borderTopColor;
    const tokenBorderColor = getComputedStyle(tokenBorderProbe).borderTopColor;
    defaultBorderProbe.remove();
    tokenBorderProbe.remove();
    return {
      background: root.getPropertyValue("--background").trim(),
      card: root.getPropertyValue("--card").trim(),
      primary: root.getPropertyValue("--primary").trim(),
      sidebar: root.getPropertyValue("--sidebar").trim(),
      breakpoint: root.getPropertyValue("--tw-breakpoint").trim(),
      defaultBorderColor,
      tokenBorderColor,
      externalResources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /^https?:/u.test(name)),
    };
  });
  expect(designValues).toEqual({
    background: "oklch(14.5% 0 0)",
    card: "oklch(20.5% 0 0)",
    primary: "oklch(92.2% 0 0)",
    sidebar: "oklch(20.5% 0 0)",
    breakpoint: "768px",
    defaultBorderColor: "oklch(1 0 0 / 0.1)",
    tokenBorderColor: "oklch(1 0 0 / 0.1)",
    externalResources: [],
  });

  const undersizedTargets = await window
    .locator("button:visible, a:visible, input:visible")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label:
              element.getAttribute("aria-label") ?? element.textContent?.trim(),
            width: rect.width,
            height: rect.height,
            minimum: element.matches(
              '[data-slot="checkbox"], [data-slot="radio-group-item"], [data-slot="switch"], input[type="checkbox"], input[type="radio"]',
            )
              ? 16
              : 32,
          };
        })
        .filter(
          (item) => item.width < item.minimum || item.height < item.minimum,
        ),
    );
  expect(undersizedTargets).toEqual([]);
});

function requiredPage(): Page {
  if (!page) {
    throw new Error("Electron window was not initialized");
  }
  return page;
}

function requiredElectronApplication(): ElectronApplication {
  if (!electronApplication) {
    throw new Error("Electron application was not initialized");
  }
  return electronApplication;
}

function requiredTargetProcess(): ChildProcess {
  if (!targetProcess) {
    throw new Error("Target JVM was not initialized");
  }
  return targetProcess;
}

async function gridColumnCount(window: Page): Promise<number> {
  return window.locator(".app-shell").evaluate((element) => {
    const columns = getComputedStyle(element).gridTemplateColumns.trim();
    return columns ? columns.split(/\s+/u).length : 0;
  });
}

async function expectPageToFillWorkspace(window: Page): Promise<void> {
  const page = window.locator(".workspace__content > .page");
  await expect(page).toBeVisible();
  const geometry = await page.evaluate((element) => {
    const workspace = element.parentElement;
    if (!workspace) {
      throw new Error("Page is not mounted directly inside the workspace");
    }
    const workspaceStyle = getComputedStyle(workspace);
    const workspaceRect = workspace.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(workspaceStyle.paddingLeft);
    const paddingRight = Number.parseFloat(workspaceStyle.paddingRight);
    return {
      actualWidth: pageRect.width,
      expectedWidth: workspace.clientWidth - paddingLeft - paddingRight,
      leftInset: pageRect.left - workspaceRect.left,
      rightInset: workspaceRect.left + workspace.clientWidth - pageRect.right,
      expectedLeftInset: paddingLeft,
      expectedRightInset: paddingRight,
    };
  });
  expect(
    Math.abs(geometry.actualWidth - geometry.expectedWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.leftInset - geometry.expectedLeftInset),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.rightInset - geometry.expectedRightInset),
  ).toBeLessThanOrEqual(1);
}

async function expectNoLargePrimarySurfaces(scope: Locator): Promise<void> {
  const surfaces = await scope.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--primary)";
    document.body.append(probe);
    const primaryColor = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [element, ...element.querySelectorAll("*")]
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return {
          tag: candidate.tagName.toLowerCase(),
          className:
            typeof candidate.className === "string" ? candidate.className : "",
          backgroundColor: style.backgroundColor,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0,
        };
      })
      .filter(
        (candidate) =>
          candidate.visible &&
          candidate.width >= 24 &&
          candidate.height >= 24 &&
          candidate.backgroundColor === primaryColor,
      );
  });
  expect(surfaces).toEqual([]);
}

async function selectShadcnValue(
  trigger: Locator,
  value: string,
): Promise<void> {
  const encodedValue = `tanwei-select-value:${value}`;
  await trigger.click();
  const option = trigger
    .page()
    .locator(
      `[data-slot="select-item"][data-value=${JSON.stringify(encodedValue)}]`,
    )
    .last();
  await expect(option).toBeVisible();
  const selectedLabel = (await option.textContent())?.trim();
  if (!selectedLabel) {
    throw new Error(`Select option ${value} has no accessible label`);
  }
  await option.click();
  await expect(trigger).toContainText(selectedLabel);
}

async function screenshotVisiblePanel(
  window: Page,
  panel: Locator,
  fileName: string,
  minimumHeight = 320,
): Promise<void> {
  await panel.evaluate((element) => {
    element.scrollIntoView({ block: "start", inline: "nearest" });
    let ancestor = element.parentElement;
    let verticalScroller: HTMLElement | null = null;
    while (ancestor) {
      const style = window.getComputedStyle(ancestor);
      if (
        ancestor.scrollWidth > ancestor.clientWidth &&
        (style.overflowX === "auto" || style.overflowX === "scroll")
      ) {
        ancestor.scrollLeft = 0;
      }
      if (
        !verticalScroller &&
        ancestor.scrollHeight > ancestor.clientHeight &&
        (style.overflowY === "auto" || style.overflowY === "scroll")
      ) {
        verticalScroller = ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    if (verticalScroller) {
      verticalScroller.scrollTop = Math.max(0, verticalScroller.scrollTop - 96);
    }
    window.scrollTo({ left: 0 });
  });
  const bounds = await panel.boundingBox();
  const viewport = await window.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  if (!bounds) {
    throw new Error(`${fileName} panel has no visible bounds`);
  }
  const clip = {
    x: Math.max(0, bounds.x),
    y: Math.max(0, bounds.y),
    width: Math.min(bounds.width, viewport.width - Math.max(0, bounds.x)),
    height: Math.min(bounds.height, viewport.height - Math.max(0, bounds.y)),
  };
  if (clip.width < 320 || clip.height < minimumHeight) {
    throw new Error(
      `${fileName} panel clip is too small: ${JSON.stringify(clip)}`,
    );
  }
  await window.screenshot({
    path: path.join(projectRoot, "output", "playwright", fileName),
    clip,
    animations: "disabled",
  });
}

function waitForOutput(
  child: ChildProcess,
  marker: string,
  timeoutMillis = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let timeout: ReturnType<typeof setTimeout>;
    const inspect = (chunk: Buffer): void => {
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(
        -(marker.length + 1_024),
      );
      if (!buffered.includes(marker)) {
        return;
      }
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", inspect);
      child.off("error", onError);
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Target JVM did not emit ${marker}`));
    }, timeoutMillis);
    child.once("error", onError);
    child.stdout?.on("data", inspect);
  });
}

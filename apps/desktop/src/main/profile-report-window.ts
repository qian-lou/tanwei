import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";
import {
  DEFAULT_APP_FONT_FAMILY,
  getAppFontStack,
  type AppFontFamily,
} from "../shared/app-fonts.js";
import type { ResolvedProfileReport } from "./workspace-service.js";
import {
  isProfileReportNavigationAllowed,
  isProfileReportRequestAllowed,
} from "./profile-report-policy.js";

const reportWindows = new Set<BrowserWindow>();

export function profileReportAdapterScript(
  reportTitle: string,
  reportName: string,
  fontFamily: AppFontFamily = DEFAULT_APP_FONT_FAMILY,
): string {
  const fontStack = getAppFontStack(fontFamily);
  return `(() => {
    const reportTitle = ${JSON.stringify(reportTitle)};
    const reportName = ${JSON.stringify(reportName)};
    document.title = reportTitle;
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";

    const style = document.createElement("style");
    style.id = "tanwei-profile-report-style";
    style.textContent = \`
      :root,
      :root.dark {
        --bg: #faf9f5 !important;
        --fg: #141413 !important;
        --hl-bg: #141413 !important;
        --hl-border: #141413 !important;
        --link: #141413 !important;
        --legend-bg: #faf9f5 !important;
        --legend-border: #141413 !important;
      }
      body {
        box-sizing: border-box;
        background: #faf9f5 !important;
        color: #141413 !important;
        font: 12px/1.4 ${fontStack} !important;
      }
      #tanwei-report-shell {
        min-height: 68px;
        margin: -10px -10px 22px;
        padding: 12px 22px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        box-sizing: border-box;
        color: #ffffff;
        background: #141413;
      }
      .tanwei-report-identity {
        min-width: 0;
        display: grid;
        gap: 2px;
      }
      .tanwei-report-eyebrow {
        font-weight: 700;
        letter-spacing: .08em;
      }
      .tanwei-report-name {
        overflow: hidden;
        font: 400 16px/1.4 ${fontStack};
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tanwei-report-boundary {
        opacity: .72;
      }
      .tanwei-report-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tanwei-report-controls input,
      .tanwei-report-controls button,
      .tanwei-report-controls select {
        min-height: 44px;
        box-sizing: border-box;
        border: 2px solid #ffffff;
        border-radius: 8px;
        color: #ffffff;
        background: #141413;
        font: 12px/1.4 ${fontStack};
      }
      .tanwei-report-controls input {
        min-width: 220px;
        padding: 0 12px;
      }
      .tanwei-report-controls select {
        max-width: 260px;
        padding: 0 10px;
      }
      .tanwei-report-controls button {
        width: auto;
        min-width: 44px;
        margin: 0;
        padding: 0 12px;
      }
      .tanwei-report-controls button:hover,
      .tanwei-report-controls input:focus,
      .tanwei-report-controls select:focus {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }
      .tanwei-report-controls button svg * {
        fill: #ffffff !important;
        stroke: #ffffff !important;
      }
      body > h1 {
        margin: 22px 0;
        color: #141413;
        font: 700 58px/1.1 ${fontStack};
        text-align: left;
      }
      body > header[style*="right"] {
        margin: -58px 0 22px;
      }
      body > header a {
        color: #141413 !important;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      #canvas {
        border: 2px solid #141413;
        border-radius: 8px;
      }
      #legend {
        border: 2px solid #141413 !important;
        border-radius: 8px !important;
        box-shadow:
          rgba(0, 0, 0, .01) 0 2px 2px,
          rgba(0, 0, 0, .02) 0 4px 4px,
          rgba(0, 0, 0, .04) 0 16px 24px;
      }
      body:not(.tanwei-native-profile-colors) #legend dd {
        border: 1px solid #141413;
        color: #ffffff !important;
        background: #141413 !important;
      }
      #hl {
        height: 15px;
        outline: 2px solid #141413 !important;
        color: #141413 !important;
        background: #faf9f5 !important;
      }
      #status,
      #match {
        outline: 2px solid #141413 !important;
        color: #ffffff !important;
        background: #141413 !important;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 12px;
        border: 2px solid #141413;
        text-align: left;
      }
      thead {
        color: #ffffff;
        background: #141413;
      }
      code {
        font: 400 16px/1.4 ${fontStack};
      }
      @media (max-width: 767px) {
        #tanwei-report-shell {
          align-items: stretch;
          flex-direction: column;
        }
        .tanwei-report-controls {
          flex-wrap: wrap;
        }
        .tanwei-report-controls input {
          min-width: 0;
          flex: 1 1 100%;
        }
        body > h1 {
          font-size: 40px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation-duration: 100ms !important;
          transition-duration: 100ms !important;
        }
      }
    \`;
    document.head.append(style);

    const supportsFlameGraph =
      typeof levels !== "undefined" &&
      typeof c !== "undefined" &&
      typeof root !== "undefined" &&
      typeof render === "function";
    const fullGraphRoot = supportsFlameGraph ? root : null;
    const splitThreadFrames =
      supportsFlameGraph && Array.isArray(levels[1])
        ? levels[1].filter(
            (frame) =>
              typeof frame?.title === "string" &&
              frame.title.startsWith("[") &&
              frame.title.includes(" tid=") &&
              frame.title.endsWith("]"),
          )
        : [];
    let useNativeColors = true;
    let paletteControl = null;

    const shell = document.createElement("div");
    shell.id = "tanwei-report-shell";
    const identity = document.createElement("div");
    identity.className = "tanwei-report-identity";
    const eyebrow = document.createElement("span");
    eyebrow.className = "tanwei-report-eyebrow";
    eyebrow.textContent = "PERFORMANCE EVIDENCE / VERIFIED LOCAL";
    const name = document.createElement("strong");
    name.className = "tanwei-report-name";
    name.textContent = reportName;
    const boundary = document.createElement("span");
    boundary.className = "tanwei-report-boundary";
    boundary.textContent = "SHA-256 已校验 · 隔离会话 · 网络已阻断";
    identity.append(eyebrow, name, boundary);
    shell.append(identity);

    const controls = document.createElement("div");
    controls.className = "tanwei-report-controls";
    if (typeof search === "function") {
      const query = document.createElement("input");
      query.type = "search";
      query.placeholder = "筛选方法（正则）";
      query.setAttribute("aria-label", "筛选方法");
      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = "筛选";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清除";
      const runSearch = () => search(query.value);
      submit.addEventListener("click", runSearch);
      clear.addEventListener("click", () => {
        query.value = "";
        search(false);
      });
      query.addEventListener("keydown", (event) => {
        if (event.key === "Enter") runSearch();
      });
      controls.append(query, submit, clear);
    }
    if (splitThreadFrames.length > 1 && fullGraphRoot) {
      const threadControl = document.createElement("select");
      threadControl.setAttribute("aria-label", "线程视图");
      threadControl.title = "线程过多、帧标签不可见时，可选择单个线程放大查看";
      const allThreads = document.createElement("option");
      allThreads.value = "";
      allThreads.textContent = "全部线程（选择线程查看标签）";
      threadControl.append(allThreads);
      for (let index = 0; index < splitThreadFrames.length; index += 1) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = splitThreadFrames[index].title;
        threadControl.append(option);
      }
      threadControl.addEventListener("change", () => {
        const selectedIndex = Number.parseInt(threadControl.value, 10);
        const selectedRoot = Number.isInteger(selectedIndex)
          ? splitThreadFrames[selectedIndex]
          : fullGraphRoot;
        if (selectedRoot) render(selectedRoot);
      });
      controls.append(threadControl);
    }
    if (supportsFlameGraph) {
      paletteControl = document.createElement("button");
      paletteControl.type = "button";
      paletteControl.setAttribute("aria-label", "原生彩色");
      controls.append(paletteControl);
    }
    for (const id of ["inverted", "info"]) {
      const control = document.getElementById(id);
      if (control) {
        control.textContent = id === "inverted" ? "反转" : "说明";
        control.setAttribute(
          "aria-label",
          id === "inverted" ? "反转火焰图" : "查看图例与快捷键",
        );
        controls.append(control);
      }
    }
    document.getElementById("search")?.remove();
    document.getElementById("darkmode")?.remove();
    if (controls.childElementCount > 0) shell.append(controls);
    document.body.prepend(shell);

    for (const header of document.querySelectorAll("body > header")) {
      if (header.childElementCount === 0 && !header.textContent?.trim()) {
        header.remove();
      }
    }
    const attribution = document.querySelector(
      'body > header[style*="right"] a',
    );
    if (attribution) {
      attribution.removeAttribute("href");
      attribution.setAttribute("title", "外部导航已禁用");
    }

    if (supportsFlameGraph) {
      const nativeFrameColors = new WeakMap();
      for (let depth = 0; depth < levels.length; depth += 1) {
        for (const frame of levels[depth]) {
          nativeFrameColors.set(frame, frame.color);
        }
      }

      const updatePaletteControl = () => {
        if (!paletteControl) return;
        document.body.classList.toggle(
          "tanwei-native-profile-colors",
          useNativeColors,
        );
        paletteControl.textContent = useNativeColors
          ? "配色：原生彩色"
          : "配色：单色";
        paletteControl.setAttribute("aria-pressed", String(useNativeColors));
        paletteControl.title = useNativeColors
          ? "切换为单色火焰图"
          : "切换为原生彩色火焰图";
      };

      const applyPalette = () => {
        for (let depth = 0; depth < levels.length; depth += 1) {
          const opacity = [0.68, 0.78, 0.88, 0.96][depth % 4];
          for (const frame of levels[depth]) {
            if (!nativeFrameColors.has(frame)) {
              nativeFrameColors.set(frame, frame.color);
            }
            if (useNativeColors) {
              const nativeColor = nativeFrameColors.get(frame);
              if (typeof nativeColor === "string") frame.color = nativeColor;
            } else {
              frame.color = \`rgba(20, 20, 19, \${opacity})\`;
            }
          }
        }
        updatePaletteControl();
        render(root);
      };

      const contextPrototype = Object.getPrototypeOf(c);
      const fillStyleDescriptor = Object.getOwnPropertyDescriptor(
        contextPrototype,
        "fillStyle",
      );
      if (fillStyleDescriptor?.get && fillStyleDescriptor.set) {
        let pendingTextColor = null;
        Object.defineProperty(c, "fillStyle", {
          configurable: true,
          get() {
            return fillStyleDescriptor.get.call(c);
          },
          set(value) {
            let mappedValue = value;
            if (!useNativeColors && value === "#ee00ee") {
              mappedValue = "#faf9f5";
              pendingTextColor = "#141413";
            } else if (
              !useNativeColors &&
              typeof value === "string" &&
              value.startsWith("rgba(20, 20, 19,")
            ) {
              pendingTextColor = "#ffffff";
            } else if (
              !useNativeColors &&
              value === "#000000" &&
              pendingTextColor
            ) {
              mappedValue = pendingTextColor;
              pendingTextColor = null;
            } else {
              pendingTextColor = null;
            }
            fillStyleDescriptor.set.call(c, mappedValue);
          },
        });
      }
      paletteControl?.addEventListener("click", () => {
        useNativeColors = !useNativeColors;
        applyPalette();
      });
      applyPalette();
    }
  })();`;
}

export async function openProfileReportWindow(
  report: ResolvedProfileReport,
  owner: BrowserWindow | null,
  fontFamily: AppFontFamily = DEFAULT_APP_FONT_FAMILY,
): Promise<void> {
  const reportUrl = pathToFileURL(report.absolutePath).href;
  const title = `探微 · 性能报告 — ${report.name}`;
  const reportWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#faf9f5",
    title,
    show: false,
    ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
    webPreferences: {
      partition: `tanwei-profile-report-${randomUUID()}`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
    },
  });
  reportWindows.add(reportWindow);

  const reportSession = reportWindow.webContents.session;
  reportSession.setPermissionCheckHandler(() => false);
  reportSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  reportSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) =>
      callback({
        cancel: !isProfileReportRequestAllowed(details.url, reportUrl),
      }),
  );

  reportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  reportWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  reportWindow.webContents.on("will-navigate", (event, url) => {
    if (!isProfileReportNavigationAllowed(url, reportUrl)) {
      event.preventDefault();
    }
  });
  reportWindow.webContents.on("will-redirect", (event, url) => {
    if (!isProfileReportNavigationAllowed(url, reportUrl)) {
      event.preventDefault();
    }
  });
  reportWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    reportWindow.setTitle(title);
  });
  reportWindow.once("closed", () => {
    reportWindows.delete(reportWindow);
  });
  reportWindow.once("ready-to-show", () => {
    if (!reportWindow.isDestroyed()) {
      reportWindow.show();
    }
  });

  try {
    await reportWindow.loadURL(reportUrl);
    await reportWindow.webContents.executeJavaScript(
      profileReportAdapterScript(title, report.name, fontFamily),
    );
    reportWindow.setTitle(title);
    if (!reportWindow.isDestroyed() && !reportWindow.isVisible()) {
      reportWindow.show();
    }
  } catch (error) {
    if (!reportWindow.isDestroyed()) {
      reportWindow.destroy();
    }
    throw error;
  }
}

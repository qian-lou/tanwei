import { access } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type {
  OperationResult,
  UpdateStatus,
} from "../shared/contracts.js";

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value, errorCode: null, errorMessage: null };
}

function failure<T>(
  errorCode: string,
  errorMessage: string,
): OperationResult<T> {
  return { ok: false, value: null, errorCode, errorMessage };
}

type AutoUpdater = typeof import("electron-updater")["autoUpdater"];

export class UpdateService {
  #updater: AutoUpdater | null = null;
  #status: UpdateStatus = {
    state: "NOT_CONFIGURED",
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseName: null,
    releaseNotes: null,
    progressPercent: null,
    errorMessage: null,
  };

  async initialize(): Promise<void> {
    if (!app.isPackaged) {
      return;
    }
    const configuration = path.join(
      process.resourcesPath,
      "app-update.yml",
    );
    if (!(await access(configuration).then(() => true).catch(() => false))) {
      return;
    }
    const module = await import("electron-updater");
    const updater = module.autoUpdater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.on("checking-for-update", () => {
      this.#status = { ...this.#status, state: "CHECKING", errorMessage: null };
    });
    updater.on("update-available", (info) => {
      this.#status = {
        ...this.#status,
        state: "AVAILABLE",
        availableVersion: info.version,
        releaseName: info.releaseName ?? null,
        releaseNotes:
          typeof info.releaseNotes === "string"
            ? info.releaseNotes
            : info.releaseNotes
              ? JSON.stringify(info.releaseNotes)
              : null,
        progressPercent: null,
        errorMessage: null,
      };
    });
    updater.on("update-not-available", () => {
      this.#status = { ...this.#status, state: "UP_TO_DATE" };
    });
    updater.on("download-progress", (progress) => {
      this.#status = {
        ...this.#status,
        state: "DOWNLOADING",
        progressPercent: progress.percent,
      };
    });
    updater.on("update-downloaded", () => {
      this.#status = {
        ...this.#status,
        state: "DOWNLOADED",
        progressPercent: 100,
      };
    });
    updater.on("error", (error) => {
      this.#status = {
        ...this.#status,
        state: "FAILED",
        errorMessage: error.message,
      };
    });
    this.#updater = updater;
    this.#status = { ...this.#status, state: "IDLE" };
  }

  status(): UpdateStatus {
    return this.#status;
  }

  async check(): Promise<OperationResult<UpdateStatus>> {
    if (!this.#updater) {
      return failure(
        "UPDATE_NOT_CONFIGURED",
        "当前构建不含签名发布源元数据",
      );
    }
    try {
      await this.#updater.checkForUpdates();
      return success(this.#status);
    } catch (error) {
      return failure(
        "UPDATE_CHECK_FAILED",
        error instanceof Error ? error.message : "更新检查失败",
      );
    }
  }

  async download(
    confirmed: boolean,
  ): Promise<OperationResult<UpdateStatus>> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "下载更新需要确认版本说明");
    }
    if (!this.#updater || this.#status.state !== "AVAILABLE") {
      return failure("UPDATE_NOT_AVAILABLE", "当前没有可下载的签名更新");
    }
    try {
      await this.#updater.downloadUpdate();
      return success(this.#status);
    } catch (error) {
      return failure(
        "UPDATE_DOWNLOAD_FAILED",
        error instanceof Error ? error.message : "更新下载失败",
      );
    }
  }

  install(confirmed: boolean): OperationResult<null> {
    if (!confirmed) {
      return failure("CONFIRMATION_REQUIRED", "安装更新需要明确确认");
    }
    if (!this.#updater || this.#status.state !== "DOWNLOADED") {
      return failure("UPDATE_NOT_DOWNLOADED", "更新尚未完成下载与签名校验");
    }
    this.#updater.quitAndInstall(false, true);
    return success(null);
  }
}

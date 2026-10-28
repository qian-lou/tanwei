import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useState } from "react";
import type {
  AppSettings,
  ArtifactDescriptor,
  RuntimeInfo,
  UpdateStatus,
} from "@shared/contracts";
import {
  APP_FONT_OPTIONS,
  DEFAULT_APP_FONT_FAMILY,
  getAppFontStack,
} from "@shared/app-fonts";
import StatusPill from "../components/StatusPill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { setLocale, t, useLocale } from "../i18n";
import { applyAppFontFamily } from "../font-preferences";
import type { RouteMeta } from "../router";
import {
  selectConnection,
  selectSelectedTarget,
  useTargetsStore,
} from "../stores/targets";
import "./SettingsView.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

const DESIGN_BASELINE = {
  name: "shadcn/ui",
  version: "1.0",
  source: "New York · neutral dark",
} as const;

export default function SettingsView() {
  useLocale();
  const [locale, setLocaleValue] = useState<AppSettings["locale"]>("zh-CN");
  const [fontFamily, setFontFamily] =
    useState<AppSettings["fontFamily"]>(DEFAULT_APP_FONT_FAMILY);
  const [samplingInterval, setSamplingInterval] =
    useState<AppSettings["defaultSamplingIntervalMillis"]>(2_000);
  const [quotaGiB, setQuotaGiB] = useState(2);
  const [retentionDays, setRetentionDays] = useState(0);
  const [updatePolicy, setUpdatePolicy] =
    useState<AppSettings["updatePolicy"]>("NOTIFY");
  const [maximumRiskLevel, setMaximumRiskLevel] =
    useState<AppSettings["maximumRiskLevel"]>("R2");
  const [systemNotificationPolicy, setSystemNotificationPolicy] =
    useState<AppSettings["systemNotificationPolicy"]>("CRITICAL_ONLY");
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [supportArtifact, setSupportArtifact] =
    useState<ArtifactDescriptor | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [settings, runtimeInfo, updater] = await Promise.all([
        window.tanwei.getSettings(),
        window.tanwei.getRuntimeInfo(),
        window.tanwei.getUpdateStatus(),
      ]);
      setRuntime(runtimeInfo);
      setUpdateStatus(updater);
      if (!settings.ok || !settings.value) {
        setErrorMessage(settings.errorMessage ?? t("无法读取设置"));
        return;
      }
      setLocaleValue(settings.value.locale);
      setFontFamily(settings.value.fontFamily);
      setSamplingInterval(settings.value.defaultSamplingIntervalMillis);
      setQuotaGiB(settings.value.artifactQuotaBytes / 1024 / 1024 / 1024);
      setRetentionDays(settings.value.retentionDays);
      setUpdatePolicy(settings.value.updatePolicy);
      setMaximumRiskLevel(settings.value.maximumRiskLevel);
      setSystemNotificationPolicy(settings.value.systemNotificationPolicy);
      setLocale(settings.value.locale);
    } finally {
      setLoading(false);
    }
  }

  async function checkForUpdates(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.checkForUpdates();
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法检查签名更新"));
        setUpdateStatus(await window.tanwei.getUpdateStatus());
        return;
      }
      setUpdateStatus(result.value);
    } finally {
      setLoading(false);
    }
  }

  async function downloadUpdate(): Promise<void> {
    setLoading(true);
    const result = await window.tanwei.downloadUpdate(true);
    setLoading(false);
    if (!result.ok || !result.value) {
      setErrorMessage(result.errorMessage ?? t("无法下载更新"));
      return;
    }
    setUpdateStatus(result.value);
  }

  async function installUpdate(): Promise<void> {
    const result = await window.tanwei.installUpdate(true);
    if (!result.ok) {
      setErrorMessage(result.errorMessage ?? t("无法安装更新"));
    }
  }

  async function save(): Promise<void> {
    setLoading(true);
    setSaved(false);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.updateSettings({
        locale,
        fontFamily,
        defaultSamplingIntervalMillis: samplingInterval,
        artifactQuotaBytes: Math.round(quotaGiB * 1024 * 1024 * 1024),
        retentionDays,
        updatePolicy,
        maximumRiskLevel,
        systemNotificationPolicy,
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法保存设置"));
        return;
      }
      setLocale(result.value.locale);
      setFontFamily(result.value.fontFamily);
      applyAppFontFamily(result.value.fontFamily);
      setSaved(true);
    } catch (saveError) {
      setErrorMessage(
        saveError instanceof Error ? saveError.message : t("无法保存设置"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function generateSupportBundle(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    setSupportArtifact(null);
    try {
      const result = await window.tanwei.generateSupportBundle();
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法生成本地支持包"));
        return;
      }
      setSupportArtifact(result.value);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // 仅挂载时加载一次，与 Vue onMounted 语义一致。
    // Runs once on mount, matching Vue onMounted semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  useEffect(() => {
    applyAppFontFamily(fontFamily);
  }, [fontFamily]);

  const selectedFont =
    APP_FONT_OPTIONS.find((option) => option.value === fontFamily) ??
    APP_FONT_OPTIONS[0];

  return (
    <section className="page settings-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>{t("边界清楚，默认安全。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "设置只保存在本机 SQLite；不提供第二套主题，也不会上传目标数据、凭据或案例。",
          )}
        </p>
      </header>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessage)}</AlertDescription>
        </Alert>
      )}

      <section className="settings-grid">
        <article className="settings-font-card">
          <p className="eyebrow">APPEARANCE</p>
          <Label>
            <span>{t("应用字体")}</span>
            <SelectControl
              value={fontFamily}
              onValueChange={(value) =>
                setFontFamily(value as AppSettings["fontFamily"])
              }
            >
              {APP_FONT_OPTIONS.map((option) => (
                <SelectControlItem key={option.value} value={option.value}>
                  <span style={{ fontFamily: getAppFontStack(option.value) }}>
                    {t(option.label)}
                  </span>
                </SelectControlItem>
              ))}
            </SelectControl>
          </Label>
          <div
            className="settings-font-preview"
            style={{ fontFamily: getAppFontStack(fontFamily) }}
          >
            <strong>{t("探微 JVM 诊断工作台")}</strong>
            <span>Tanwei · JVM Runtime Workbench · 0123456789</span>
          </div>
          <p>
            {selectedFont.detail} · {t("本机字体优先，同类字体自动回退。")}
          </p>
          <p>
            {t("标题、正文、表格、控件和代码区域统一使用所选字体。")}
          </p>
        </article>

        <article>
          <p className="eyebrow">RUNTIME DEFAULTS</p>
          <Label>
            <span>{t("界面语言")}</span>
            <SelectControl
              value={locale}
              onValueChange={(value) =>
                setLocaleValue(value as AppSettings["locale"])
              }
            >
              <SelectControlItem value="zh-CN">
                {t("简体中文")}
              </SelectControlItem>
              <SelectControlItem value="en-US">English</SelectControlItem>
            </SelectControl>
          </Label>
          <Label>
            <span>{t("默认采样间隔")}</span>
            <SelectControl
              value={samplingInterval}
              onValueChange={(value) =>
                setSamplingInterval(
                  Number(
                    value,
                  ) as AppSettings["defaultSamplingIntervalMillis"],
                )
              }
            >
              <SelectControlItem value={1000}>{t("1 秒")}</SelectControlItem>
              <SelectControlItem value={2000}>{t("2 秒")}</SelectControlItem>
              <SelectControlItem value={5000}>{t("5 秒")}</SelectControlItem>
              <SelectControlItem value={10000}>
                {t("10 秒")}
              </SelectControlItem>
            </SelectControl>
          </Label>
        </article>

        <article>
          <p className="eyebrow">ARTIFACT STORAGE</p>
          <Label>
            <span>{t("本地配额（GiB）")}</span>
            <Input
              value={quotaGiB}
              onChange={(event) => setQuotaGiB(Number(event.target.value))}
              type="number"
              min="1"
              max="1024"
            />
          </Label>
          <Label>
            <span>{t("保留天数（0 表示不自动清理）")}</span>
            <Input
              value={retentionDays}
              onChange={(event) => setRetentionDays(Number(event.target.value))}
              type="number"
              min="0"
              max="3650"
            />
          </Label>
        </article>

        <article>
          <p className="eyebrow">HOST POLICY</p>
          <Label>
            <span>{t("允许的最高风险等级")}</span>
            <SelectControl
              value={maximumRiskLevel}
              onValueChange={(value) =>
                setMaximumRiskLevel(
                  value as AppSettings["maximumRiskLevel"],
                )
              }
            >
              <SelectControlItem value="R2">
                R2 · {t("只读、采样与有界增强")}
              </SelectControlItem>
              <SelectControlItem value="R3">
                R3 · {t("同时允许运行时修改")}
              </SelectControlItem>
              <SelectControlItem value="R4">
                R4 · {t("同时允许双确认进程级操作")}
              </SelectControlItem>
            </SelectControl>
          </Label>
          <p>
            {t(
              "主进程会拒绝高于此等级的 Action；页面确认或直接构造 IPC 都不能绕过。",
            )}
          </p>
        </article>

        <article data-testid="system-notification-settings">
          <p className="eyebrow">BACKGROUND ALERTS</p>
          <div className="settings-field">
            <span id="system-notification-policy-label">
              {t("系统诊断提醒")}
            </span>
            <Select
              value={systemNotificationPolicy}
              onValueChange={(value) => {
                if (
                  value === "OFF" ||
                  value === "CRITICAL_ONLY" ||
                  value === "WARNING_AND_CRITICAL"
                ) {
                  setSystemNotificationPolicy(value);
                }
              }}
            >
              <SelectTrigger
                aria-labelledby="system-notification-policy-label"
                data-testid="system-notification-policy"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CRITICAL_ONLY">
                  {t("仅严重事件（推荐）")}
                </SelectItem>
                <SelectItem value="WARNING_AND_CRITICAL">
                  {t("警告与严重事件")}
                </SelectItem>
                <SelectItem value="OFF">{t("关闭系统提醒")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p>
            {t(
              "只在窗口隐藏、最小化或失焦时发送系统通知；普通基线仍仅保留在应用内，点击通知会回到精确校验证据。",
            )}
          </p>
          <StatusPill
            state={systemNotificationPolicy === "OFF" ? "idle" : "ready"}
            label={
              systemNotificationPolicy === "OFF"
                ? t("系统提醒已关闭")
                : systemNotificationPolicy === "CRITICAL_ONLY"
                  ? t("仅严重事件")
                  : t("警告与严重事件")
            }
          />
        </article>

        <article>
          <p className="eyebrow">SIGNED UPDATE</p>
          <Label>
            <span>{t("更新策略")}</span>
            <SelectControl
              value={updatePolicy}
              onValueChange={(value) =>
                setUpdatePolicy(
                  value as AppSettings["updatePolicy"],
                )
              }
            >
              <SelectControlItem value="NOTIFY">
                {t("发现签名更新时通知")}
              </SelectControlItem>
              <SelectControlItem value="MANUAL">
                {t("仅手动检查")}
              </SelectControlItem>
            </SelectControl>
          </Label>
          <p>
            {t(
              "更新只有在发布者签名、版本说明与组件清单校验全部通过后才可安装。",
            )}
          </p>
          <StatusPill
            state={
              updateStatus?.state === "FAILED"
                ? "error"
                : updateStatus?.state === "DOWNLOADED"
                  ? "ready"
                  : "idle"
            }
            label={updateStatus?.state ?? "UNKNOWN"}
          />
          {updateStatus?.availableVersion && (
            <p>
              {updateStatus.releaseName ?? `v${updateStatus.availableVersion}`}
            </p>
          )}
          {updateStatus?.releaseNotes && <p>{updateStatus.releaseNotes}</p>}
          <div className="update-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => void checkForUpdates()}
              aria-busy={Boolean(loading)}
              disabled={Boolean(loading)}
            >
              {Boolean(loading) && <Spinner />}
              {t("手动检查")}
            </Button>
            {updateStatus?.state === "AVAILABLE" && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void downloadUpdate()}
                aria-busy={Boolean(loading)}
                disabled={Boolean(loading)}
              >
                {Boolean(loading) && <Spinner />}
                {t("确认说明并下载")}
              </Button>
            )}
            {updateStatus?.state === "DOWNLOADED" && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void installUpdate()}
              >
                {t("确认重启安装")}
              </Button>
            )}
          </div>
        </article>

        <article>
          <p className="eyebrow">ABOUT / COMPONENTS</p>
          {runtime && (
            <dl>
              <div>
                <dt>Desktop</dt>
                <dd>v{runtime.appVersion}</dd>
              </div>
              <div>
                <dt>Tauri</dt>
                <dd>{runtime.tauriVersion}</dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd>
                  {runtime.platform}/{runtime.architecture}
                </dd>
              </div>
              <div>
                <dt>Design</dt>
                <dd>
                  {DESIGN_BASELINE.name} {DESIGN_BASELINE.version}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{DESIGN_BASELINE.source}</dd>
              </div>
              {Object.entries(runtime.components).map(
                ([component, version]) => (
                  <div key={component}>
                    <dt>{component}</dt>
                    <dd>{version}</dd>
                  </div>
                ),
              )}
            </dl>
          )}
          <StatusPill state="ready" label="LOCAL FIRST" />
        </article>

        <article>
          <p className="eyebrow">SANITIZED SUPPORT</p>
          <p>
            {t(
              "支持包只包含版本、平台、设计基线、设置摘要和对象计数；不包含路径、环境值、系统属性值、凭据、密钥或实时对象。",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void generateSupportBundle()}
            aria-busy={Boolean(loading)}
            disabled={Boolean(loading)}
          >
            {Boolean(loading) && <Spinner />}
            {t("生成本地支持包")}
          </Button>
          {supportArtifact && (
            <p>
              {t("已生成 {name} · SHA-256 {sha256}", {
                name: supportArtifact.name,
                sha256: supportArtifact.sha256,
              })}
            </p>
          )}
        </article>
      </section>

      <footer className="settings-actions">
        {saved && <p>{t("设置已写入事务。")}</p>}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void save()}
          aria-busy={Boolean(loading)}
          disabled={Boolean(loading)}
        >
          {Boolean(loading) && <Spinner />}
          {t("保存设置")}
        </Button>
      </footer>
    </section>
  );
}

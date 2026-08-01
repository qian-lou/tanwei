import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEffect, useMemo, useState } from "react";
import type {
  DiagnosticTemplate,
  ImportPreview,
  MultiTargetComparison,
  PluginDescriptor,
  TeamPolicyDescriptor,
} from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import { formatDateTime, formatNumber, t, useLocale } from "../i18n";
import { selectSelectedTarget, useTargetsStore } from "../stores/targets";
import "./GovernanceView.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

type GovernanceSection = "TEMPLATES" | "COMPARE" | "PLUGINS" | "POLICY";

const governanceSections: readonly {
  readonly id: GovernanceSection;
  readonly index: string;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "TEMPLATES",
    index: "01",
    label: "诊断模板",
    description: "签名动作与安全默认值",
  },
  {
    id: "COMPARE",
    index: "02",
    label: "多目标对比",
    description: "并发采集 JVM 快照",
  },
  {
    id: "PLUGINS",
    index: "03",
    label: "声明式插件",
    description: "验证扩展清单",
  },
  {
    id: "POLICY",
    index: "04",
    label: "团队策略",
    description: "收紧组织级权限",
  },
];

interface TemplateFormState {
  name: string;
  description: string;
  actionId: string;
  parameters: string;
}

export default function GovernanceView() {
  useLocale();
  const connections = useTargetsStore((s) => s.connections);
  const selectedTarget = useTargetsStore(selectSelectedTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comparisonTargetIds, setComparisonTargetIds] = useState<
    readonly string[]
  >([]);
  const [comparison, setComparison] = useState<MultiTargetComparison | null>(
    null,
  );
  const [templates, setTemplates] = useState<readonly DiagnosticTemplate[]>([]);
  const [plugins, setPlugins] = useState<readonly PluginDescriptor[]>([]);
  const [activePolicy, setActivePolicy] = useState<TeamPolicyDescriptor | null>(
    null,
  );
  const [pluginPreview, setPluginPreview] =
    useState<ImportPreview<PluginDescriptor> | null>(null);
  const [policyPreview, setPolicyPreview] =
    useState<ImportPreview<TeamPolicyDescriptor> | null>(null);
  const [templateExecutionConfirmed, setTemplateExecutionConfirmed] =
    useState(false);
  const [pluginInstallConfirmed, setPluginInstallConfirmed] = useState(false);
  const [policyActivationConfirmed, setPolicyActivationConfirmed] =
    useState(false);
  const [pendingTemplateDelete, setPendingTemplateDelete] = useState<
    string | null
  >(null);
  const [pendingPluginDelete, setPendingPluginDelete] = useState<string | null>(
    null,
  );
  const [pendingPolicyRemoval, setPendingPolicyRemoval] = useState(false);
  const [activeSection, setActiveSection] =
    useState<GovernanceSection>("TEMPLATES");
  const [templateFormOpen, setTemplateFormOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [templateForm, setTemplateForm] = useState<TemplateFormState>({
    name: "",
    description: "",
    actionId: "jvm.info",
    parameters: "{}",
  });

  const connectedTargets = useMemo(
    () =>
      Object.values(connections).filter(
        (connection) => connection.state === "READY",
      ),
    [connections],
  );

  const selectedTemplate =
    templates.find((template) => template.id === selectedTemplateId) ??
    templates[0] ??
    null;

  function selectGovernanceSection(section: GovernanceSection): void {
    setActiveSection(section);
  }

  function openTemplateForm(): void {
    setTemplateFormOpen(true);
  }

  function selectTemplate(templateId: string): void {
    setSelectedTemplateId(templateId);
    setTemplateFormOpen(false);
  }

  function toggleComparisonTarget(targetId: string, checked: boolean): void {
    setComparisonTargetIds((previous) =>
      checked
        ? [...new Set([...previous, targetId])]
        : previous.filter((value) => value !== targetId),
    );
  }

  function patchTemplateForm(next: Partial<TemplateFormState>): void {
    setTemplateForm((previous) => ({ ...previous, ...next }));
  }

  async function refreshGovernance(): Promise<void> {
    const [templateResult, pluginResult, policyResult] = await Promise.all([
      window.tanwei.listDiagnosticTemplates(),
      window.tanwei.listPlugins(),
      window.tanwei.getActiveTeamPolicy(),
    ]);
    const nextTemplates = templateResult.value ?? [];
    setTemplates(nextTemplates);
    setPlugins(pluginResult.value ?? []);
    setActivePolicy(policyResult.value);
    setSelectedTemplateId((previous) =>
      previous && !nextTemplates.some((template) => template.id === previous)
        ? (nextTemplates[0]?.id ?? null)
        : previous,
    );
    setError(
      templateResult.errorMessage ??
        pluginResult.errorMessage ??
        policyResult.errorMessage,
    );
  }

  async function runComparison(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.compareTargets(comparisonTargetIds);
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("无法生成多目标对比"));
        return;
      }
      setComparison(result.value);
    } finally {
      setBusy(false);
    }
  }

  async function createTemplate(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = JSON.parse(templateForm.parameters) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      ) {
        throw new Error(t("参数必须是字符串值组成的 JSON 对象"));
      }
      const result = await window.tanwei.createSignedDiagnosticTemplate({
        name: templateForm.name,
        description: templateForm.description,
        actionId: templateForm.actionId,
        parameters: parsed as Readonly<Record<string, string>>,
      });
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法创建签名诊断模板"));
        return;
      }
      setSelectedTemplateId(result.value?.id ?? null);
      setTemplateForm((previous) => ({
        ...previous,
        name: "",
        description: "",
        parameters: "{}",
      }));
      setTemplateFormOpen(false);
      setNotice(t("诊断模板已签名并保存。"));
      await refreshGovernance();
    } catch (creationError) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : t("无法创建签名诊断模板"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function executeTemplate(template: DiagnosticTemplate): Promise<void> {
    let targetId = useTargetsStore.getState().selectedTargetId;
    if (
      !targetId ||
      useTargetsStore.getState().connections[targetId]?.state !== "READY"
    ) {
      await useTargetsStore.getState().refresh();
      targetId = useTargetsStore.getState().selectedTargetId;
    }
    if (
      !targetId ||
      useTargetsStore.getState().connections[targetId]?.state !== "READY"
    ) {
      setError(t("请先选择并连接目标JVM"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.tanwei.executeDiagnosticTemplate(
        template.id,
        targetId,
        template.riskLevel === "R0" || templateExecutionConfirmed,
      );
      if (!result.ok || !result.value) {
        setError(result.errorMessage ?? t("诊断模板执行失败"));
        return;
      }
      setNotice(
        t("模板已执行：{actionId} · {status}", {
          actionId: result.value.actionId,
          status: result.value.status,
        }),
      );
      setTemplateExecutionConfirmed(false);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(templateId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await window.tanwei.deleteDiagnosticTemplate(
        templateId,
        true,
      );
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法删除诊断模板"));
        return;
      }
      setPendingTemplateDelete(null);
      await refreshGovernance();
    } finally {
      setBusy(false);
    }
  }

  async function previewPlugin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.previewPluginImport();
      if (!result.ok) {
        setError(result.errorMessage ?? t("插件导入预检失败"));
        return;
      }
      setPluginPreview(result.value);
    } finally {
      setBusy(false);
    }
  }

  async function installPlugin(): Promise<void> {
    if (!pluginPreview) {
      return;
    }
    setBusy(true);
    try {
      const result = await window.tanwei.installPlugin(
        pluginPreview.previewId,
        pluginInstallConfirmed,
      );
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法安装插件"));
        return;
      }
      setPluginPreview(null);
      setPluginInstallConfirmed(false);
      await refreshGovernance();
    } finally {
      setBusy(false);
    }
  }

  async function deletePlugin(pluginId: string): Promise<void> {
    setBusy(true);
    try {
      const result = await window.tanwei.deletePlugin(pluginId, true);
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法卸载插件"));
        return;
      }
      setPendingPluginDelete(null);
      await refreshGovernance();
    } finally {
      setBusy(false);
    }
  }

  async function previewPolicy(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.tanwei.previewTeamPolicyImport();
      if (!result.ok) {
        setError(result.errorMessage ?? t("团队策略导入预检失败"));
        return;
      }
      setPolicyPreview(result.value);
    } finally {
      setBusy(false);
    }
  }

  async function activatePolicy(): Promise<void> {
    if (!policyPreview) {
      return;
    }
    setBusy(true);
    try {
      const result = await window.tanwei.activateTeamPolicy(
        policyPreview.previewId,
        policyActivationConfirmed,
      );
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法启用团队策略"));
        return;
      }
      setPolicyPreview(null);
      setPolicyActivationConfirmed(false);
      await refreshGovernance();
    } finally {
      setBusy(false);
    }
  }

  async function removePolicy(): Promise<void> {
    setBusy(true);
    try {
      const result = await window.tanwei.removeTeamPolicy(true);
      if (!result.ok) {
        setError(result.errorMessage ?? t("无法移除团队策略"));
        return;
      }
      setPendingPolicyRemoval(false);
      await refreshGovernance();
    } finally {
      setBusy(false);
    }
  }

  function formatBytes(value: number): string {
    const absolute = Math.abs(value);
    const sign = value < 0 ? "−" : value > 0 ? "+" : "";
    if (absolute >= 1024 * 1024 * 1024) {
      return `${sign}${formatNumber(absolute / (1024 * 1024 * 1024), {
        maximumFractionDigits: 2,
      })} GiB`;
    }
    return `${sign}${formatNumber(absolute / (1024 * 1024), {
      maximumFractionDigits: 1,
    })} MiB`;
  }

  function formatDelta(value: number | null, percent = false): string {
    if (value === null) {
      return t("未知");
    }
    const prefix = value > 0 ? "+" : "";
    return percent
      ? `${prefix}${formatNumber(value * 100, {
          maximumFractionDigits: 1,
        })}%`
      : `${prefix}${formatNumber(value)}`;
  }

  useEffect(() => {
    void refreshGovernance();
    // 仅挂载时刷新一次，与 Vue onMounted 语义一致。
    // Runs once on mount, matching Vue onMounted semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page governance-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">GOVERNANCE / EXTENSIBILITY</p>
          <h1>{t("把诊断能力变成可验证资产。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "多目标对比、签名模板、声明式插件与团队策略都在 Host 中验证；插件不执行任意 JavaScript，团队策略只能收紧本机权限。",
          )}
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("操作未完成")}</AlertTitle>
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert className="governance-notice" role="status">
          <AlertTitle>{t("完成")}</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Tabs
        className="governance-workbench"
        orientation="vertical"
        value={activeSection}
        onValueChange={(value) =>
          selectGovernanceSection(value as GovernanceSection)
        }
      >
        <aside className="governance-tree" aria-label={t("治理功能")}>
          <header>
            <p className="eyebrow">ASSET CONTROL</p>
            <strong>{t("治理中心")}</strong>
          </header>
          <TabsList className="governance-tree__tabs">
            {governanceSections.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                <span className="governance-tree__index">{section.index}</span>
                <span>
                  <strong>{t(section.label)}</strong>
                  <small>{t(section.description)}</small>
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <footer>
            <span>{t("当前目标")}</span>
            <strong>{selectedTarget?.displayName ?? t("尚未选择目标")}</strong>
            {selectedTarget && <small>PID {selectedTarget.pid}</small>}
          </footer>
        </aside>

        <main className="governance-stage">
          <TabsContent value="COMPARE" asChild>
            <section className="governance-section">
              <header className="section-heading">
                <div>
                  <p className="eyebrow">MULTI-TARGET COMPARISON</p>
                  <h2>{t("同一时刻，对比多个 JVM。")}</h2>
                </div>
                <span>
                  {connectedTargets.length} {t("个已连接目标")}
                </span>
              </header>
              <div className="target-options">
                {connectedTargets.map((connection) => (
                  <Label key={connection.target.id} className="choice-card">
                    <Checkbox
                      checked={comparisonTargetIds.includes(
                        connection.target.id,
                      )}
                      onCheckedChange={(event) =>
                        toggleComparisonTarget(
                          connection.target.id,
                          event === true,
                        )
                      }
                    />
                    <span>
                      <strong>{connection.target.displayName}</strong>
                      <small>
                        PID {connection.target.pid} · JDK{" "}
                        {connection.javaVersion}
                      </small>
                    </span>
                  </Label>
                ))}
              </div>
              {connectedTargets.length < 2 && (
                <p>{t("至少连接两个 JVM 后才能生成对比快照。")}</p>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={
                  Boolean(comparisonTargetIds.length < 2) || Boolean(busy)
                }
                onClick={() => void runComparison()}
                aria-busy={Boolean(busy)}
              >
                {Boolean(busy) && <Spinner />}
                {t("并发采集并对比")}
              </Button>

              {comparison && (
                <div className="comparison-table-wrapper">
                  <Table className="comparison-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("目标")}</TableHead>
                        <TableHead>CPU</TableHead>
                        <TableHead>{t("堆内存")}</TableHead>
                        <TableHead>{t("线程")}</TableHead>
                        <TableHead>{t("已加载类")}</TableHead>
                        <TableHead>GC</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {comparison.rows.map((row) => (
                        <TableRow key={row.targetId}>
                          <TableHead>
                            {row.displayName}
                            {row.targetId === comparison.baselineTargetId && (
                              <small>{t("基线")}</small>
                            )}
                          </TableHead>
                          <TableCell>
                            {formatDelta(row.snapshot.processCpuLoad, true)}
                            <small>
                              {formatDelta(
                                row.deltaFromBaseline.processCpuLoad,
                                true,
                              )}
                            </small>
                          </TableCell>
                          <TableCell>
                            {formatBytes(row.snapshot.heapUsedBytes)}
                            <small>
                              {formatBytes(row.deltaFromBaseline.heapUsedBytes)}
                            </small>
                          </TableCell>
                          <TableCell>
                            {formatNumber(row.snapshot.liveThreads)}
                            <small>
                              {formatDelta(row.deltaFromBaseline.liveThreads)}
                            </small>
                          </TableCell>
                          <TableCell>
                            {formatNumber(row.snapshot.loadedClasses)}
                            <small>
                              {formatDelta(row.deltaFromBaseline.loadedClasses)}
                            </small>
                          </TableCell>
                          <TableCell>
                            {formatNumber(row.snapshot.gcCount)}
                            <small>
                              {formatDelta(row.deltaFromBaseline.gcCount)}
                            </small>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p>{formatDateTime(comparison.capturedAt)}</p>
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="TEMPLATES" asChild>
            <section className="governance-section">
              <header className="section-heading">
                <div>
                  <p className="eyebrow">SIGNED DIAGNOSTIC TEMPLATES</p>
                  <h2>{t("保存安全默认值，不保存绕过。")}</h2>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={openTemplateForm}
                >
                  {t("新建模板")}
                </Button>
              </header>

              <div className="template-workbench">
                <section
                  className="template-list"
                  aria-label={t("诊断模板列表")}
                >
                  <header>
                    <strong>{t("模板")}</strong>
                    <span>{templates.length}</span>
                  </header>
                  {templates.map((template) => (
                    <Button
                      variant={
                        selectedTemplate?.id === template.id &&
                        !templateFormOpen
                          ? "secondary"
                          : "ghost"
                      }
                      key={template.id}
                      type="button"
                      aria-pressed={
                        selectedTemplate?.id === template.id &&
                        !templateFormOpen
                      }
                      onClick={() => selectTemplate(template.id)}
                    >
                      <span>
                        <strong>{template.name}</strong>
                        <small>{template.actionId}</small>
                      </span>
                      <span className="template-list__meta">
                        {template.riskLevel}
                      </span>
                    </Button>
                  ))}
                  {templates.length === 0 && (
                    <div className="template-list__empty">
                      <span>{t("还没有模板")}</span>
                      <small>{t("创建一个经过签名的诊断动作。")}</small>
                    </div>
                  )}
                </section>

                {templateFormOpen ? (
                  <form
                    className="template-form template-inspector"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createTemplate();
                    }}
                  >
                    <header className="template-inspector__heading">
                      <div>
                        <p className="eyebrow">NEW SIGNED TEMPLATE</p>
                        <h3>{t("创建诊断模板")}</h3>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setTemplateFormOpen(false)}
                      >
                        {t("取消")}
                      </Button>
                    </header>
                    <Label>
                      <span>{t("名称")}</span>
                      <Input
                        value={templateForm.name}
                        onChange={(event) =>
                          patchTemplateForm({
                            name: event.target.value.trim(),
                          })
                        }
                        required
                        maxLength={120}
                      />
                    </Label>
                    <Label>
                      <span>Action ID</span>
                      <Input
                        value={templateForm.actionId}
                        onChange={(event) =>
                          patchTemplateForm({
                            actionId: event.target.value.trim(),
                          })
                        }
                        required
                        maxLength={128}
                        spellCheck={false}
                      />
                    </Label>
                    <Label className="template-form__wide">
                      <span>{t("说明")}</span>
                      <Input
                        value={templateForm.description}
                        onChange={(event) =>
                          patchTemplateForm({
                            description: event.target.value.trim(),
                          })
                        }
                        maxLength={1000}
                      />
                    </Label>
                    <Label className="template-form__wide">
                      <span>{t("参数 JSON（仅字符串值）")}</span>
                      <Textarea
                        value={templateForm.parameters}
                        onChange={(event) =>
                          patchTemplateForm({
                            parameters: event.target.value,
                          })
                        }
                        required
                        rows={5}
                        spellCheck={false}
                      />
                    </Label>
                    <div className="template-form__wide actions">
                      <Button
                        variant="secondary"
                        type="submit"
                        aria-busy={Boolean(busy)}
                        disabled={Boolean(busy)}
                      >
                        {Boolean(busy) && <Spinner />}
                        {t("校验并签名模板")}
                      </Button>
                    </div>
                  </form>
                ) : selectedTemplate ? (
                  <article className="asset-card template-inspector">
                    <header>
                      <div>
                        <p className="eyebrow">{selectedTemplate.actionId}</p>
                        <h3>{selectedTemplate.name}</h3>
                      </div>
                      <StatusPill
                        state={selectedTemplate.verified ? "ready" : "error"}
                        label={selectedTemplate.verified ? "SIGNED" : "INVALID"}
                      />
                    </header>
                    <p>{selectedTemplate.description || t("没有说明。")}</p>
                    <dl>
                      <div>
                        <dt>{t("风险")}</dt>
                        <dd>{selectedTemplate.riskLevel}</dd>
                      </div>
                      <div>
                        <dt>{t("来源")}</dt>
                        <dd>{selectedTemplate.source}</dd>
                      </div>
                      <div>
                        <dt>{t("签名指纹")}</dt>
                        <dd className="mono">
                          {selectedTemplate.publicKeyFingerprint}
                        </dd>
                      </div>
                    </dl>
                    <Label className="inline-confirmation">
                      <Checkbox
                        checked={templateExecutionConfirmed}
                        onCheckedChange={(event) =>
                          setTemplateExecutionConfirmed(event === true)
                        }
                      />
                      <span>{t("我确认执行所选 R1 持续或中等成本模板。")}</span>
                    </Label>
                    <div className="actions">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={
                          Boolean(
                            !selectedTemplate.verified ||
                              (selectedTemplate.riskLevel === "R1" &&
                                !templateExecutionConfirmed),
                          ) || Boolean(busy)
                        }
                        onClick={() => void executeTemplate(selectedTemplate)}
                        aria-busy={Boolean(busy)}
                      >
                        {Boolean(busy) && <Spinner />}
                        {t("对当前目标执行")}
                      </Button>
                      {selectedTemplate.source === "LOCAL" && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            setPendingTemplateDelete(selectedTemplate.id)
                          }
                        >
                          {t("删除")}
                        </Button>
                      )}
                    </div>
                    {pendingTemplateDelete === selectedTemplate.id && (
                      <div className="inline-confirmation">
                        <span>{t("确认永久删除这个本地模板？")}</span>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            void deleteTemplate(selectedTemplate.id)
                          }
                          aria-busy={Boolean(busy)}
                          disabled={Boolean(busy)}
                        >
                          {Boolean(busy) && <Spinner />}
                          {t("确认删除")}
                        </Button>
                      </div>
                    )}
                  </article>
                ) : (
                  <section className="template-inspector template-inspector--empty">
                    <span
                      className="connection-canvas__mark"
                      aria-hidden="true"
                    >
                      01
                    </span>
                    <p className="eyebrow">NO TEMPLATE SELECTED</p>
                    <h3>{t("创建第一个安全诊断模板。")}</h3>
                    <p>
                      {t(
                        "签名会绑定 Action、参数与来源，执行前仍受风险策略校验。",
                      )}
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={openTemplateForm}
                    >
                      {t("新建模板")}
                    </Button>
                  </section>
                )}
              </div>
            </section>
          </TabsContent>

          <TabsContent value="PLUGINS" asChild>
            <section className="governance-section">
              <header className="section-heading">
                <div>
                  <p className="eyebrow">DECLARATIVE PLUGIN SDK</p>
                  <h2>{t("扩展能力，不扩大执行面。")}</h2>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void previewPlugin()}
                  aria-busy={Boolean(busy)}
                  disabled={Boolean(busy)}
                >
                  {Boolean(busy) && <Spinner />}
                  {t("导入签名插件清单")}
                </Button>
              </header>
              <p>
                {t(
                  "Plugin API v1 只允许贡献经过 Action Schema 校验的 R0/R1 诊断模板；不加载插件 JavaScript、Native 库或任意命令。",
                )}
              </p>
              {pluginPreview && (
                <article className="signature-preview">
                  <div>
                    <p className="eyebrow">VERIFIED IMPORT</p>
                    <h3>
                      {pluginPreview.value.name} · {pluginPreview.value.version}
                    </h3>
                    <p>{pluginPreview.value.description}</p>
                    <p className="mono">
                      {pluginPreview.value.publicKeyFingerprint}
                    </p>
                  </div>
                  <Label className="inline-confirmation">
                    <Checkbox
                      checked={pluginInstallConfirmed}
                      onCheckedChange={(event) =>
                        setPluginInstallConfirmed(event === true)
                      }
                    />
                    <span>
                      {t("我已核对发布者、版本、签名指纹与模板数量。")}
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={Boolean(!pluginInstallConfirmed) || Boolean(busy)}
                    onClick={() => void installPlugin()}
                    aria-busy={Boolean(busy)}
                  >
                    {Boolean(busy) && <Spinner />}
                    {t("确认安装插件")}
                  </Button>
                </article>
              )}
              <div className="asset-grid">
                {plugins.map((plugin) => (
                  <article key={plugin.id} className="asset-card">
                    <header>
                      <div>
                        <p className="eyebrow">{plugin.publisher}</p>
                        <h3>
                          {plugin.name} · {plugin.version}
                        </h3>
                      </div>
                      <StatusPill state="ready" label="VERIFIED" />
                    </header>
                    <p>{plugin.description}</p>
                    <p>
                      {plugin.templateCount} {t("个模板")}
                    </p>
                    <p className="mono">{plugin.publicKeyFingerprint}</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPendingPluginDelete(plugin.id)}
                    >
                      {t("卸载插件")}
                    </Button>
                    {pendingPluginDelete === plugin.id && (
                      <div className="inline-confirmation">
                        <span>{t("卸载会同时移除该插件提供的模板。")}</span>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void deletePlugin(plugin.id)}
                          aria-busy={Boolean(busy)}
                          disabled={Boolean(busy)}
                        >
                          {Boolean(busy) && <Spinner />}
                          {t("确认卸载")}
                        </Button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </TabsContent>

          <TabsContent value="POLICY" asChild>
            <section className="governance-section">
              <header className="section-heading">
                <div>
                  <p className="eyebrow">OPTIONAL TEAM POLICY</p>
                  <h2>{t("组织约束只能更严格。")}</h2>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void previewPolicy()}
                  aria-busy={Boolean(busy)}
                  disabled={Boolean(busy)}
                >
                  {Boolean(busy) && <Spinner />}
                  {t("导入签名团队策略")}
                </Button>
              </header>
              {activePolicy ? (
                <article className="policy-card">
                  <header>
                    <div>
                      <p className="eyebrow">ACTIVE POLICY</p>
                      <h3>
                        {activePolicy.name} · {activePolicy.version}
                      </h3>
                    </div>
                    <StatusPill
                      state={activePolicy.verified ? "ready" : "error"}
                      label={activePolicy.verified ? "ENFORCED" : "INVALID"}
                    />
                  </header>
                  <p>
                    {t("最高风险")} {activePolicy.maximumRiskLevel} ·{" "}
                    {activePolicy.deniedActions.length} {t("个禁用 Action")}
                  </p>
                  <p className="mono">{activePolicy.publicKeyFingerprint}</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPendingPolicyRemoval(true)}
                  >
                    {t("移除团队策略")}
                  </Button>
                  {pendingPolicyRemoval && (
                    <div className="inline-confirmation">
                      <span>{t("移除后仍受本机最高风险等级约束。")}</span>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void removePolicy()}
                        aria-busy={Boolean(busy)}
                        disabled={Boolean(busy)}
                      >
                        {Boolean(busy) && <Spinner />}
                        {t("确认移除")}
                      </Button>
                    </div>
                  )}
                </article>
              ) : (
                <p>{t("当前没有启用团队策略包。")}</p>
              )}

              {policyPreview && (
                <article className="signature-preview">
                  <div>
                    <p className="eyebrow">POLICY PREVIEW</p>
                    <h3>
                      {policyPreview.value.name} · {policyPreview.value.version}
                    </h3>
                    <p>
                      {t("最高风险")} {policyPreview.value.maximumRiskLevel} ·{" "}
                      {policyPreview.value.deniedActions.join(", ") || t("无")}
                    </p>
                    <p className="mono">
                      {policyPreview.value.publicKeyFingerprint}
                    </p>
                  </div>
                  <Label className="inline-confirmation">
                    <Checkbox
                      checked={policyActivationConfirmed}
                      onCheckedChange={(event) =>
                        setPolicyActivationConfirmed(event === true)
                      }
                    />
                    <span>
                      {t("我已核对签名、有效期、风险上限和禁用 Action。")}
                    </span>
                  </Label>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      Boolean(!policyActivationConfirmed) || Boolean(busy)
                    }
                    onClick={() => void activatePolicy()}
                    aria-busy={Boolean(busy)}
                  >
                    {Boolean(busy) && <Spinner />}
                    {t("确认启用团队策略")}
                  </Button>
                </article>
              )}
            </section>
          </TabsContent>
        </main>
      </Tabs>
    </section>
  );
}

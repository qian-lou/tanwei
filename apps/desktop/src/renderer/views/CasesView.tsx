import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty } from "@/components/ui/empty";
import { Disclosure } from "@/components/ui/disclosure";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type {
  ActionAuditDescriptor,
  ArtifactDescriptor,
  CaseExportPreview,
  DiagnosticCase,
} from "@shared/contracts";
import StatusPill from "../components/StatusPill";
import { formatDateTime, t, useLocale } from "../i18n";
import "./CasesView.css";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

export default function CasesView() {
  useLocale();
  const [searchParams] = useSearchParams();
  const requestedActionId = searchParams.get("action") ?? "";
  const pendingActionId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      requestedActionId,
    )
      ? requestedActionId
      : "";
  const [cases, setCases] = useState<readonly DiagnosticCase[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactDescriptor[]>([]);
  const [actionAudits, setActionAudits] = useState<
    readonly ActionAuditDescriptor[]
  >([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [evidenceCaseId, setEvidenceCaseId] = useState<string | null>(null);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<
    readonly string[]
  >([]);
  const [selectedActionIds, setSelectedActionIds] = useState<readonly string[]>(
    [],
  );
  const [exportPreview, setExportPreview] = useState<CaseExportPreview | null>(
    null,
  );
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<
    string | null
  >(null);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredCases = !normalizedQuery
    ? cases
    : cases.filter((diagnosticCase) =>
        [
          diagnosticCase.title,
          diagnosticCase.notes,
          ...diagnosticCase.tags,
        ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
      );

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [result, artifactResult, auditResult, requestedAuditResult] =
        await Promise.all([
          window.tanwei.listCases(),
          window.tanwei.listArtifacts(),
          window.tanwei.listActionAudits(),
          pendingActionId
            ? window.tanwei.queryActionAudits({
                offset: 0,
                limit: 1,
                query: pendingActionId,
                targetId: "",
                status: "ALL",
                riskLevel: "ALL",
              })
            : Promise.resolve(null),
        ]);
      setCases(result.value ?? []);
      setArtifacts(artifactResult.value ?? []);
      const recentAudits = auditResult.value ?? [];
      const requestedAudit = requestedAuditResult?.value?.items.find(
        (audit) => audit.taskId === pendingActionId,
      );
      setActionAudits(
        requestedAudit &&
          !recentAudits.some((audit) => audit.taskId === requestedAudit.taskId)
          ? [requestedAudit, ...recentAudits]
          : recentAudits,
      );
      setErrorMessage(
        result.ok &&
          artifactResult.ok &&
          auditResult.ok &&
          (!requestedAuditResult || requestedAuditResult.ok)
          ? null
          : (result.errorMessage ??
              artifactResult.errorMessage ??
              auditResult.errorMessage ??
              requestedAuditResult?.errorMessage ??
              t("无法读取案例与证据")),
      );
    } finally {
      setLoading(false);
    }
  }

  async function openEvidence(diagnosticCase: DiagnosticCase): Promise<void> {
    if (evidenceCaseId === diagnosticCase.id) {
      setEvidenceCaseId(null);
      setExportPreview(null);
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    setExportPreview(null);
    try {
      const result = await window.tanwei.getCaseEvidence(diagnosticCase.id);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法读取案例证据"));
        return;
      }
      setEvidenceCaseId(diagnosticCase.id);
      setSelectedArtifactIds(
        result.value.artifacts.map((artifact) => artifact.id),
      );
      setSelectedActionIds(
        [
          ...result.value.actions.map((action) => action.taskId),
          ...(pendingActionId &&
          actionAudits.some((action) => action.taskId === pendingActionId)
            ? [pendingActionId]
            : []),
        ].filter((value, index, values) => values.indexOf(value) === index),
      );
    } finally {
      setLoading(false);
    }
  }

  function toggleSelection(
    collection: "artifact" | "action",
    id: string,
    checked: boolean,
  ): void {
    const values = new Set(
      collection === "artifact" ? selectedArtifactIds : selectedActionIds,
    );
    if (checked) {
      values.add(id);
    } else {
      values.delete(id);
    }
    if (collection === "artifact") {
      setSelectedArtifactIds([...values]);
    } else {
      setSelectedActionIds([...values]);
    }
  }

  async function saveEvidence(caseId: string): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.updateCaseEvidence({
        caseId,
        artifactIds: selectedArtifactIds,
        actionTaskIds: selectedActionIds,
      });
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法固定案例证据"));
        return;
      }
      setExportPreview(null);
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function previewExport(caseId: string): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.previewCaseExport(caseId);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法生成脱敏预览"));
        return;
      }
      setExportPreview(result.value);
    } finally {
      setLoading(false);
    }
  }

  async function exportCase(caseId: string): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.exportCase(caseId, true);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法导出案例"));
        return;
      }
      setExportPreview(null);
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function importCase(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.importCase();
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法导入案例"));
        return;
      }
      if (result.value) {
        await load();
      }
    } finally {
      setLoading(false);
    }
  }

  async function deleteCase(caseId: string): Promise<void> {
    if (deleteConfirmationId !== caseId) {
      setDeleteConfirmationId(caseId);
      return;
    }
    setLoading(true);
    try {
      const result = await window.tanwei.deleteCase(caseId, true);
      if (!result.ok) {
        setErrorMessage(result.errorMessage ?? t("无法删除案例"));
        return;
      }
      setDeleteConfirmationId(null);
      setEvidenceCaseId(null);
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function createCase(): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setErrorMessage(t("案例标题不能为空"));
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await window.tanwei.createCase({
        title: normalizedTitle,
        notes: notes.trim(),
        tags: tagsText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法创建案例"));
        return;
      }
      setCases([result.value, ...cases]);
      setTitle("");
      setNotes("");
      setTagsText("");
    } finally {
      setLoading(false);
    }
  }

  async function archiveCase(diagnosticCase: DiagnosticCase): Promise<void> {
    setLoading(true);
    try {
      const result = await window.tanwei.archiveCase(diagnosticCase.id);
      if (!result.ok || !result.value) {
        setErrorMessage(result.errorMessage ?? t("无法归档案例"));
        return;
      }
      setCases(
        cases.map((item) =>
          item.id === diagnosticCase.id
            ? (result.value as DiagnosticCase)
            : item,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="page cases-view">
      <header className="page-heading">
        <div>
          <p className="eyebrow">CASES</p>
          <h1>{t("诊断形成上下文。")}</h1>
        </div>
        <p className="page-heading__summary">
          {t(
            "案例元数据使用本地 SQLite 事务与版本迁移；会话密钥、凭据和未固定对象值不会写入数据库。",
          )}
        </p>
      </header>

      {pendingActionId &&
        actionAudits.some((action) => action.taskId === pendingActionId) && (
          <Alert className="case-notice" role="status">
            <AlertDescription>
              {t(
                "已从诊断审计带入 Action {taskId}；打开任一案例的“证据与导出”即可固定。",
                { taskId: pendingActionId },
              )}
            </AlertDescription>
          </Alert>
        )}

      <div className="case-global-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => void importCase()}
          aria-busy={Boolean(loading)}
          disabled={Boolean(loading)}
        >
          {Boolean(loading) && <Spinner />}
          {t("导入案例")}
        </Button>
        <p>
          {t("导入仅接受探微 schema v1 JSON；外部路径不会暴露给 Renderer。")}
        </p>
      </div>

      <section className="case-create">
        <div>
          <p className="eyebrow">NEW CASE</p>
          <p className="case-create__title">{t("建立一次可交接的诊断。")}</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createCase();
          }}
        >
          <Label>
            <span>{t("标题")}</span>
            <Input
              value={title}
              maxLength={200}
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </Label>
          <Label>
            <span>{t("标签（逗号分隔）")}</span>
            <Input
              value={tagsText}
              maxLength={400}
              onChange={(event) => setTagsText(event.target.value)}
            />
          </Label>
          <Label className="case-create__notes">
            <span>{t("笔记")}</span>
            <Textarea
              value={notes}
              maxLength={20000}
              rows={4}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Label>
          <Button
            variant="secondary"
            type="submit"
            aria-busy={Boolean(loading)}
            disabled={Boolean(loading)}
          >
            {Boolean(loading) && <Spinner />}
            {t("创建案例")}
          </Button>
        </form>
      </section>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessage)}</AlertDescription>
        </Alert>
      )}

      <Label className="case-search">
        <span>{t("搜索案例")}</span>
        <Input
          value={query}
          type="search"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Label>

      <div className="case-list" aria-live="polite">
        {filteredCases.map((diagnosticCase) => (
          <article key={diagnosticCase.id}>
            <header>
              <div>
                <p className="eyebrow">{diagnosticCase.id}</p>
                <h2>{diagnosticCase.title}</h2>
              </div>
              <StatusPill
                state={diagnosticCase.status === "OPEN" ? "ready" : "idle"}
                label={
                  diagnosticCase.status === "OPEN" ? t("进行中") : t("已归档")
                }
              />
            </header>
            <p>{diagnosticCase.notes || t("没有笔记。")}</p>
            {diagnosticCase.tags.length > 0 && (
              <ul aria-label={t("案例标签")}>
                {diagnosticCase.tags.map((tag) => (
                  <li key={tag}># {tag}</li>
                ))}
              </ul>
            )}
            <footer>
              <time dateTime={diagnosticCase.updatedAt}>
                {t("更新于 {time}", {
                  time: formatDateTime(diagnosticCase.updatedAt),
                })}
              </time>
              <div className="case-actions">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void openEvidence(diagnosticCase)}
                  aria-busy={Boolean(loading)}
                  disabled={Boolean(loading)}
                >
                  {Boolean(loading) && <Spinner />}
                  {t("证据与导出")}
                </Button>
                {diagnosticCase.status === "OPEN" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void archiveCase(diagnosticCase)}
                    aria-busy={Boolean(loading)}
                    disabled={Boolean(loading)}
                  >
                    {Boolean(loading) && <Spinner />}
                    {t("归档")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void deleteCase(diagnosticCase.id)}
                  aria-busy={Boolean(loading)}
                  disabled={Boolean(loading)}
                >
                  {Boolean(loading) && <Spinner />}
                  {deleteConfirmationId === diagnosticCase.id
                    ? t("确认删除")
                    : t("删除")}
                </Button>
              </div>
            </footer>

            {evidenceCaseId === diagnosticCase.id && (
              <section className="case-evidence">
                <div>
                  <p className="eyebrow">PINNED ARTIFACTS</p>
                  {artifacts.map((artifact) => (
                    <Label key={artifact.id}>
                      <Checkbox
                        checked={selectedArtifactIds.includes(artifact.id)}
                        onCheckedChange={(event) =>
                          toggleSelection(
                            "artifact",
                            artifact.id,
                            event === true,
                          )
                        }
                      />
                      <span>
                        {artifact.type} · {artifact.name}
                      </span>
                    </Label>
                  ))}
                  {artifacts.length === 0 && <p>{t("还没有可固定的制品。")}</p>}
                </div>
                <div>
                  <p className="eyebrow">PINNED ACTIONS</p>
                  {actionAudits.map((action) => (
                    <Label key={action.taskId} data-task-id={action.taskId}>
                      <Checkbox
                        checked={selectedActionIds.includes(action.taskId)}
                        onCheckedChange={(event) =>
                          toggleSelection(
                            "action",
                            action.taskId,
                            event === true,
                          )
                        }
                      />
                      <span>
                        {action.actionId} · {action.riskLevel} · {action.status}
                      </span>
                    </Label>
                  ))}
                  {actionAudits.length === 0 && (
                    <p>{t("还没有可固定的 Action 摘要。")}</p>
                  )}
                </div>
                <div className="case-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void saveEvidence(diagnosticCase.id)}
                    aria-busy={Boolean(loading)}
                    disabled={Boolean(loading)}
                  >
                    {Boolean(loading) && <Spinner />}
                    {t("固定所选证据")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void previewExport(diagnosticCase.id)}
                    aria-busy={Boolean(loading)}
                    disabled={Boolean(loading)}
                  >
                    {Boolean(loading) && <Spinner />}
                    {t("脱敏预览")}
                  </Button>
                </div>
                {exportPreview && (
                  <div className="export-preview">
                    <p className="eyebrow">EXPORT PREVIEW / SCHEMA 1</p>
                    <p>
                      {t(
                        "探微 {version} · {artifacts} 个制品摘要 · {actions} 个 Action 摘要 · {bytes} bytes",
                        {
                          version: exportPreview.productVersion,
                          artifacts: exportPreview.evidence.artifacts.length,
                          actions: exportPreview.evidence.actions.length,
                          bytes: exportPreview.manifestBytes,
                        },
                      )}
                    </p>
                    <p>
                      {t("已遮罩 {count} 处疑似敏感字段。", {
                        count: exportPreview.redactionCount,
                      })}
                    </p>
                    <Disclosure trigger={t("查看导出笔记")}>
                      <pre>
                        {exportPreview.redactedNotes || t("没有笔记。")}
                      </pre>
                    </Disclosure>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void exportCase(diagnosticCase.id)}
                      aria-busy={Boolean(loading)}
                      disabled={Boolean(loading)}
                    >
                      {Boolean(loading) && <Spinner />}
                      {t("确认导出为制品")}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </article>
        ))}

        {!loading && filteredCases.length === 0 && (
          <Empty className="empty-panel">
            <p className="eyebrow">NO CASES</p>
            <p className="empty-panel__title">{t("没有匹配的诊断案例。")}</p>
          </Empty>
        )}
      </div>
    </section>
  );
}

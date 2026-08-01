import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import StatusPill from "./StatusPill";
import StatePagination from "./StatePagination";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./SystemPropertyInspector.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type PropertyCategory =
  | "ALL"
  | "JAVA"
  | "VM"
  | "OS"
  | "USER"
  | "PATH"
  | "APPLICATION";
type PropertyVisibility = "VISIBLE" | "MASKED";
interface PropertyEntry {
  readonly key: string;
  readonly value: string;
  readonly category: Exclude<PropertyCategory, "ALL">;
  readonly visibility: PropertyVisibility;
  readonly valueLength: number;
  readonly truncated: boolean;
  readonly mutable: boolean;
}

export interface SystemPropertyInspectorProps {
  readonly onPrepareMutation: (propertyName: string) => void;
}

const PAGE_SIZE = 50;
const PROPERTY_CATEGORIES = new Set<PropertyEntry["category"]>([
  "JAVA",
  "VM",
  "OS",
  "USER",
  "PATH",
  "APPLICATION",
]);
const SAFE_MUTATION_KEY = /^[A-Za-z0-9_.-]{1,256}$/u;

function parseInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(t("{label} 超出安全边界。", { label }));
  }
  return parsed;
}

function parseText(
  value: string | undefined,
  maximumLength: number,
  label: string,
  allowEmpty = false,
): string {
  if (
    value === undefined ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new Error(t("{label} 无效。", { label }));
  }
  return value;
}

function parseResponse(values: Readonly<Record<string, string>>): {
  readonly propertyCount: number;
  readonly scannedCount: number;
  readonly visibleCount: number;
  readonly maskedCount: number;
  readonly invalidCount: number;
  readonly sourceTruncated: boolean;
  readonly total: number;
  readonly offset: number;
  readonly entries: readonly PropertyEntry[];
} {
  const sourceCount = parseInteger(
    values.propertyCount,
    0,
    1_000_000,
    t("系统属性总数"),
  );
  const scanned = parseInteger(
    values.scannedCount,
    0,
    Math.min(sourceCount, 20_000),
    t("已扫描属性数量"),
  );
  const visible = parseInteger(
    values.visibleCount,
    0,
    scanned,
    t("可见属性数量"),
  );
  const masked = parseInteger(
    values.maskedCount,
    0,
    scanned,
    t("已遮罩属性数量"),
  );
  const invalid = parseInteger(
    values.invalidCount,
    0,
    scanned,
    t("无效属性数量"),
  );
  const truncatedSource = values.sourceTruncated;
  if (
    visible + masked + invalid !== scanned ||
    (truncatedSource !== "true" && truncatedSource !== "false") ||
    (truncatedSource === "true") !== sourceCount > scanned
  ) {
    throw new Error(t("系统属性汇总响应无效。"));
  }
  const matched = parseInteger(
    values.total,
    0,
    visible + masked,
    t("系统属性匹配数量"),
  );
  const pageOffset = parseInteger(
    values.offset,
    0,
    matched,
    t("系统属性分页偏移"),
  );
  const limit = parseInteger(values.limit, 1, 200, t("系统属性分页上限"));
  const count = parseInteger(
    values.count,
    0,
    Math.min(limit, matched - pageOffset),
    t("系统属性结果数量"),
  );
  const keys = new Set<string>();
  const parsedEntries = Array.from(
    { length: count },
    (_, index): PropertyEntry => {
      const prefix = `property.${String(index).padStart(4, "0")}.`;
      const key = parseText(values[`${prefix}key`], 512, t("系统属性名"));
      if (keys.has(key)) {
        throw new Error(t("系统属性响应包含重复名称。"));
      }
      keys.add(key);
      const entryCategory = values[`${prefix}category`];
      const visibility = values[`${prefix}visibility`];
      const truncated = values[`${prefix}truncated`];
      const mutable = values[`${prefix}mutable`];
      if (
        !PROPERTY_CATEGORIES.has(entryCategory as PropertyEntry["category"]) ||
        (visibility !== "VISIBLE" && visibility !== "MASKED") ||
        (truncated !== "true" && truncated !== "false") ||
        (mutable !== "true" && mutable !== "false")
      ) {
        throw new Error(t("系统属性分类或可见性响应无效。"));
      }
      const value = parseText(
        values[`${prefix}value`],
        4_097,
        t("系统属性值"),
        true,
      );
      const valueLength = parseInteger(
        values[`${prefix}valueLength`],
        0,
        10_000_000,
        t("系统属性值长度"),
      );
      const isTruncated = truncated === "true";
      const isMutable = mutable === "true";
      if (
        (visibility === "MASKED" &&
          (value !== "<masked>" || isTruncated || isMutable)) ||
        (visibility === "VISIBLE" &&
          ((isTruncated &&
            (valueLength <= 4_096 ||
              value.length !== 4_097 ||
              !value.endsWith("…") ||
              isMutable)) ||
            (!isTruncated && value.length !== valueLength))) ||
        (isMutable && !SAFE_MUTATION_KEY.test(key))
      ) {
        throw new Error(t("系统属性值边界响应无效。"));
      }
      return {
        key,
        value,
        category: entryCategory as PropertyEntry["category"],
        visibility,
        valueLength,
        truncated: isTruncated,
        mutable: isMutable,
      };
    },
  );
  return {
    propertyCount: sourceCount,
    scannedCount: scanned,
    visibleCount: visible,
    maskedCount: masked,
    invalidCount: invalid,
    sourceTruncated: truncatedSource === "true",
    total: matched,
    offset: pageOffset,
    entries: parsedEntries,
  };
}

function categoryLabel(value: PropertyEntry["category"]): string {
  switch (value) {
    case "JAVA":
      return t("Java 平台");
    case "VM":
      return t("JVM 实现");
    case "OS":
      return t("操作系统");
    case "USER":
      return t("用户与区域");
    case "PATH":
      return t("路径与目录");
    case "APPLICATION":
      return t("应用属性");
  }
}

export default function SystemPropertyInspector({
  onPrepareMutation,
}: SystemPropertyInspectorProps) {
  useLocale();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PropertyCategory>("ALL");
  const [entries, setEntries] = useState<readonly PropertyEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [propertyCount, setPropertyCount] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);
  const [maskedCount, setMaskedCount] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const categoryFirstRunRef = useRef(true);
  const targetFirstRunRef = useRef(true);

  const selectedProperty =
    entries.find((entry) => entry.key === selectedKey) ?? null;

  async function load(nextOffset = 0): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
      setEntries([]);
      setSelectedKey(null);
      return;
    }
    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: "system.property.list",
        parameters: {
          query: query.trim(),
          category,
          offset: String(Math.max(0, nextOffset)),
          limit: String(PAGE_SIZE),
        },
      });
      if (currentRequestId !== requestIdRef.current) {
        return;
      }
      if (!response.ok || response.value?.status !== "SUCCEEDED") {
        setError(
          response.errorMessage ??
            response.value?.message ??
            t("无法读取系统属性索引"),
        );
        return;
      }
      const parsed = parseResponse(response.value.values);
      setPropertyCount(parsed.propertyCount);
      setScannedCount(parsed.scannedCount);
      setVisibleCount(parsed.visibleCount);
      setMaskedCount(parsed.maskedCount);
      setInvalidCount(parsed.invalidCount);
      setSourceTruncated(parsed.sourceTruncated);
      setTotal(parsed.total);
      setOffset(parsed.offset);
      setEntries(parsed.entries);
      setSelectedKey(
        (previousKey) =>
          parsed.entries.find((entry) => entry.key === previousKey)?.key ??
          parsed.entries[0]?.key ??
          null,
      );
    } catch (cause) {
      if (currentRequestId === requestIdRef.current) {
        setError(
          cause instanceof Error ? cause.message : t("无法读取系统属性索引"),
        );
      }
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }

  function reset(): void {
    requestIdRef.current++;
    setEntries([]);
    setSelectedKey(null);
    setPropertyCount(0);
    setScannedCount(0);
    setVisibleCount(0);
    setMaskedCount(0);
    setInvalidCount(0);
    setSourceTruncated(false);
    setTotal(0);
    setOffset(0);
    setError(null);
    setLoading(false);
  }

  useEffect(() => {
    if (categoryFirstRunRef.current) {
      categoryFirstRunRef.current = false;
      return;
    }
    setSelectedKey(null);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  useEffect(() => {
    if (targetFirstRunRef.current) {
      targetFirstRunRef.current = false;
      return;
    }
    reset();
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTargetId]);

  useEffect(() => {
    void load(0);
    return () => {
      requestIdRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="property-inspector">
      <header>
        <div>
          <p className="eyebrow">SYSTEM PROPERTY INSPECTOR / R0</p>
          <h2>{t("检查 JVM 配置，并精确进入修改预检。")}</h2>
        </div>
        <StatusPill
          state="ready"
          label={t("{count} 个属性", { count: propertyCount })}
        />
      </header>
      <p>
        {t(
          "按名称检索 Java、JVM、操作系统、用户、路径与应用属性；敏感值在 Agent 内遮罩，长值保持明确返回边界。",
        )}
      </p>

      <form
        className="property-inspector__toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void load(0);
        }}
      >
        <Label>
          <span>{t("系统属性名称")}</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            maxLength={128}
            autoComplete="off"
            placeholder={t("例如 java、user 或 application")}
          />
        </Label>
        <Label>
          <span>{t("属性类别")}</span>
          <SelectControl
            value={category}
            onValueChange={(value) =>
              setCategory(value as PropertyCategory)
            }
          >
            <SelectControlItem value="ALL">{t("全部类别")}</SelectControlItem>
            <SelectControlItem value="JAVA">
              {t("Java 平台")}
            </SelectControlItem>
            <SelectControlItem value="VM">{t("JVM 实现")}</SelectControlItem>
            <SelectControlItem value="OS">{t("操作系统")}</SelectControlItem>
            <SelectControlItem value="USER">
              {t("用户与区域")}
            </SelectControlItem>
            <SelectControlItem value="PATH">
              {t("路径与目录")}
            </SelectControlItem>
            <SelectControlItem value="APPLICATION">
              {t("应用属性")}
            </SelectControlItem>
          </SelectControl>
        </Label>
        <Button
          variant="secondary"
          type="submit"
          aria-busy={Boolean(loading)}
          disabled={Boolean(loading)}
        >
          {Boolean(loading) && <Spinner />}
          {t("搜索属性")}
        </Button>
      </form>

      <dl className="property-inspector__stats">
        <div>
          <dt>{t("匹配")}</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>{t("可检查")}</dt>
          <dd>{visibleCount}</dd>
        </div>
        <div>
          <dt>{t("安全遮罩")}</dt>
          <dd>{maskedCount}</dd>
        </div>
        <div>
          <dt>{t("无效跳过")}</dt>
          <dd>{invalidCount}</dd>
        </div>
      </dl>

      {sourceTruncated && (
        <Alert className="property-inspector__notice" role="status">
          <AlertDescription>
            {t("属性源超过安全上限，本次检查 {scanned} / {total} 项。", {
              scanned: scannedCount,
              total: propertyCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}

      <div className="property-inspector__workspace">
        <section
          className="property-inspector__list"
          aria-label={t("系统属性列表")}
        >
          <header>
            <p className="eyebrow">BOUNDED INDEX</p>
            <span>
              {t("{start}–{end} / {total}", {
                start: total === 0 ? 0 : offset + 1,
                end: Math.min(offset + entries.length, total),
                total,
              })}
            </span>
          </header>
          {entries.length > 0 ? (
            <div className="property-inspector__rows">
              {entries.map((entry) => (
                <Button
                  variant="ghost"
                  key={entry.key}
                  type="button"
                  aria-pressed={entry.key === selectedKey}
                  className="property-row aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  onClick={() => setSelectedKey(entry.key)}
                >
                  <span>
                    <strong>{entry.key}</strong>
                    <small>{categoryLabel(entry.category)}</small>
                  </span>
                  <StatusPill
                    state={entry.visibility === "VISIBLE" ? "ready" : "idle"}
                    label={
                      entry.visibility === "VISIBLE" ? t("可检查") : t("已遮罩")
                    }
                  />
                </Button>
              ))}
            </div>
          ) : (
            <div className="property-inspector__empty">
              {loading ? t("正在读取系统属性…") : t("没有匹配的系统属性。")}
            </div>
          )}
          <footer>
            <StatePagination
              ariaLabel={t("系统属性分页")}
              previousLabel={t("上一页")}
              nextLabel={t("下一页")}
              previousDisabled={offset === 0 || loading}
              nextDisabled={offset + PAGE_SIZE >= total || loading}
              onPrevious={() => void load(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => void load(offset + PAGE_SIZE)}
            />
          </footer>
        </section>

        <aside className="property-inspector__detail">
          {selectedProperty ? (
            <>
              <header>
                <div>
                  <p className="eyebrow">EXACT PROPERTY KEY</p>
                  <h3>{selectedProperty.key}</h3>
                </div>
                <StatusPill
                  state={
                    selectedProperty.visibility === "VISIBLE" ? "ready" : "idle"
                  }
                  label={
                    selectedProperty.visibility === "VISIBLE"
                      ? t("允许展示")
                      : t("安全遮罩")
                  }
                />
              </header>
              <dl>
                <div>
                  <dt>{t("类别")}</dt>
                  <dd>{categoryLabel(selectedProperty.category)}</dd>
                </div>
                <div>
                  <dt>{t("原始字符数")}</dt>
                  <dd>{selectedProperty.valueLength}</dd>
                </div>
                <div>
                  <dt>{t("返回边界")}</dt>
                  <dd>
                    {selectedProperty.visibility === "MASKED"
                      ? t("值未离开 Agent")
                      : selectedProperty.truncated
                        ? t("已截断为 4,096 个字符")
                        : t("完整安全值")}
                  </dd>
                </div>
              </dl>
              <pre>
                <code>{selectedProperty.value}</code>
              </pre>
              <div className="property-inspector__actions">
                {selectedProperty.visibility === "MASKED" ? (
                  <p>{t("敏感属性不可查看、复制或进入修改流程。")}</p>
                ) : !selectedProperty.mutable ? (
                  <p>{t("该属性名称或值超出安全修改边界，仅允许检查。")}</p>
                ) : (
                  <p>{t("修改前仍会重新读取旧值，并执行 R3 精确值校验。")}</p>
                )}
                {selectedProperty.mutable && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onPrepareMutation(selectedProperty.key)}
                  >
                    {t("带入 R3 修改预检")}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="property-inspector__empty">
              {t("选择一个系统属性查看边界信息。")}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import StatusPill from "./StatusPill";
import StatePagination from "./StatePagination";
import { t, useLocale } from "../i18n";
import { selectConnection, useTargetsStore } from "../stores/targets";
import "./VmOptionInspector.css";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  SelectControl,
  SelectControlItem,
} from "@/components/SelectControl";

type OptionCategory =
  | "ALL"
  | "MEMORY"
  | "GC"
  | "COMPILER"
  | "DIAGNOSTIC"
  | "LOGGING"
  | "OTHER";
type OptionMutability = "ALL" | "WRITEABLE" | "READ_ONLY";
type OptionVisibility = "VISIBLE" | "MASKED";
interface OptionEntry {
  readonly name: string;
  readonly value: string;
  readonly category: Exclude<OptionCategory, "ALL">;
  readonly origin: string;
  readonly visibility: OptionVisibility;
  readonly writeable: boolean;
  readonly valueLength: number;
  readonly truncated: boolean;
  readonly mutable: boolean;
}

export interface VmOptionInspectorProps {
  readonly onPrepareMutation: (optionName: string) => void;
}

const PAGE_SIZE = 50;
const OPTION_CATEGORIES = new Set<OptionEntry["category"]>([
  "MEMORY",
  "GC",
  "COMPILER",
  "DIAGNOSTIC",
  "LOGGING",
  "OTHER",
]);
const SAFE_ORIGIN = /^[A-Z0-9_]{1,64}$/u;
const SAFE_OPTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;

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

function parseBoolean(value: string | undefined, label: string): boolean {
  if (value !== "true" && value !== "false") {
    throw new Error(t("{label} 无效。", { label }));
  }
  return value === "true";
}

function parseResponse(values: Readonly<Record<string, string>>): {
  readonly optionCount: number;
  readonly scannedCount: number;
  readonly writeableCount: number;
  readonly readOnlyCount: number;
  readonly maskedCount: number;
  readonly invalidCount: number;
  readonly sourceTruncated: boolean;
  readonly total: number;
  readonly offset: number;
  readonly entries: readonly OptionEntry[];
} {
  const sourceCount = parseInteger(
    values.optionCount,
    0,
    100_000,
    t("VM Option 总数"),
  );
  const scanned = parseInteger(
    values.scannedCount,
    0,
    Math.min(sourceCount, 10_000),
    t("已扫描 VM Option 数量"),
  );
  const writeable = parseInteger(
    values.writeableCount,
    0,
    scanned,
    t("可写 VM Option 数量"),
  );
  const readOnly = parseInteger(
    values.readOnlyCount,
    0,
    scanned,
    t("只读 VM Option 数量"),
  );
  const masked = parseInteger(
    values.maskedCount,
    0,
    writeable + readOnly,
    t("已遮罩 VM Option 数量"),
  );
  const invalid = parseInteger(
    values.invalidCount,
    0,
    scanned,
    t("无效 VM Option 数量"),
  );
  const truncatedSource = parseBoolean(
    values.sourceTruncated,
    t("VM Option 源截断状态"),
  );
  if (
    writeable + readOnly + invalid !== scanned ||
    truncatedSource !== sourceCount > scanned
  ) {
    throw new Error(t("VM Option 汇总响应无效。"));
  }
  const matched = parseInteger(
    values.total,
    0,
    writeable + readOnly,
    t("VM Option 匹配数量"),
  );
  const pageOffset = parseInteger(
    values.offset,
    0,
    matched,
    t("VM Option 分页偏移"),
  );
  const limit = parseInteger(values.limit, 1, 200, t("VM Option 分页上限"));
  const count = parseInteger(
    values.count,
    0,
    Math.min(limit, matched - pageOffset),
    t("VM Option 结果数量"),
  );
  const names = new Set<string>();
  const parsedEntries = Array.from(
    { length: count },
    (_, index): OptionEntry => {
      const prefix = `option.${String(index).padStart(4, "0")}.`;
      const name = parseText(values[`${prefix}name`], 128, t("VM Option 名称"));
      if (!SAFE_OPTION_NAME.test(name) || names.has(name)) {
        throw new Error(t("VM Option 响应包含无效或重复名称。"));
      }
      names.add(name);
      const entryCategory = values[`${prefix}category`];
      const origin = parseText(
        values[`${prefix}origin`],
        64,
        t("VM Option 来源"),
      );
      const visibility = values[`${prefix}visibility`];
      const writeableValue = parseBoolean(
        values[`${prefix}writeable`],
        t("VM Option 可写状态"),
      );
      const truncated = parseBoolean(
        values[`${prefix}truncated`],
        t("VM Option 截断状态"),
      );
      const mutable = parseBoolean(
        values[`${prefix}mutable`],
        t("VM Option 修改状态"),
      );
      if (
        !OPTION_CATEGORIES.has(entryCategory as OptionEntry["category"]) ||
        !SAFE_ORIGIN.test(origin) ||
        (visibility !== "VISIBLE" && visibility !== "MASKED")
      ) {
        throw new Error(t("VM Option 分类或来源响应无效。"));
      }
      const value = parseText(
        values[`${prefix}value`],
        4_097,
        t("VM Option 值"),
        true,
      );
      const valueLength = parseInteger(
        values[`${prefix}valueLength`],
        0,
        10_000_000,
        t("VM Option 值长度"),
      );
      const expectedMutable =
        writeableValue && visibility === "VISIBLE" && !truncated;
      if (
        mutable !== expectedMutable ||
        (visibility === "MASKED" && (value !== "<masked>" || truncated)) ||
        (visibility === "VISIBLE" &&
          ((truncated &&
            (valueLength <= 4_096 ||
              value.length !== 4_097 ||
              !value.endsWith("…"))) ||
            (!truncated && value.length !== valueLength)))
      ) {
        throw new Error(t("VM Option 值边界响应无效。"));
      }
      return {
        name,
        value,
        category: entryCategory as OptionEntry["category"],
        origin,
        visibility,
        writeable: writeableValue,
        valueLength,
        truncated,
        mutable,
      };
    },
  );
  return {
    optionCount: sourceCount,
    scannedCount: scanned,
    writeableCount: writeable,
    readOnlyCount: readOnly,
    maskedCount: masked,
    invalidCount: invalid,
    sourceTruncated: truncatedSource,
    total: matched,
    offset: pageOffset,
    entries: parsedEntries,
  };
}

function categoryLabel(value: OptionEntry["category"]): string {
  switch (value) {
    case "MEMORY":
      return t("内存与 Heap");
    case "GC":
      return t("垃圾回收");
    case "COMPILER":
      return t("编译器与 Code Cache");
    case "DIAGNOSTIC":
      return t("诊断与故障处理");
    case "LOGGING":
      return t("日志与跟踪");
    case "OTHER":
      return t("其他选项");
  }
}

export default function VmOptionInspector({
  onPrepareMutation,
}: VmOptionInspectorProps) {
  useLocale();
  const selectedTargetId = useTargetsStore((s) => s.selectedTargetId);
  const connection = useTargetsStore(selectConnection);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<OptionCategory>("ALL");
  const [mutability, setMutability] = useState<OptionMutability>("ALL");
  const [entries, setEntries] = useState<readonly OptionEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [optionCount, setOptionCount] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [writeableCount, setWriteableCount] = useState(0);
  const [readOnlyCount, setReadOnlyCount] = useState(0);
  const [maskedCount, setMaskedCount] = useState(0);
  const [invalidCount, setInvalidCount] = useState(0);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const filterFirstRunRef = useRef(true);
  const targetFirstRunRef = useRef(true);

  const selectedOption =
    entries.find((entry) => entry.name === selectedName) ?? null;

  async function load(nextOffset = 0): Promise<void> {
    if (!selectedTargetId || connection?.state !== "READY") {
      setEntries([]);
      setSelectedName(null);
      return;
    }
    const currentRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await window.tanwei.executeAction({
        targetId: selectedTargetId,
        actionId: "vm.option.list",
        parameters: {
          query: query.trim(),
          category,
          mutability,
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
            t("无法读取 VM Option 索引"),
        );
        return;
      }
      const parsed = parseResponse(response.value.values);
      setOptionCount(parsed.optionCount);
      setScannedCount(parsed.scannedCount);
      setWriteableCount(parsed.writeableCount);
      setReadOnlyCount(parsed.readOnlyCount);
      setMaskedCount(parsed.maskedCount);
      setInvalidCount(parsed.invalidCount);
      setSourceTruncated(parsed.sourceTruncated);
      setTotal(parsed.total);
      setOffset(parsed.offset);
      setEntries(parsed.entries);
      setSelectedName(
        (previousName) =>
          parsed.entries.find((entry) => entry.name === previousName)?.name ??
          parsed.entries[0]?.name ??
          null,
      );
    } catch (cause) {
      if (currentRequestId === requestIdRef.current) {
        setError(
          cause instanceof Error ? cause.message : t("无法读取 VM Option 索引"),
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
    setSelectedName(null);
    setOptionCount(0);
    setScannedCount(0);
    setWriteableCount(0);
    setReadOnlyCount(0);
    setMaskedCount(0);
    setInvalidCount(0);
    setSourceTruncated(false);
    setTotal(0);
    setOffset(0);
    setError(null);
    setLoading(false);
  }

  useEffect(() => {
    if (filterFirstRunRef.current) {
      filterFirstRunRef.current = false;
      return;
    }
    setSelectedName(null);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, mutability]);

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
    <section className="vm-option-inspector">
      <header>
        <div>
          <p className="eyebrow">VM OPTION INSPECTOR / R0</p>
          <h2>{t("检查 HotSpot 选项，再决定是否修改。")}</h2>
        </div>
        <StatusPill
          state="ready"
          label={t("{count} 个 VM Option", { count: optionCount })}
        />
      </header>
      <p>
        {t(
          "按名称、运行时领域和可写性检查诊断选项；所有修改仍需进入独立 R3 旧值预检。",
        )}
      </p>

      <form
        className="vm-option-inspector__toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void load(0);
        }}
      >
        <Label>
          <span>{t("VM Option 名称")}</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            maxLength={128}
            autoComplete="off"
            placeholder={t("例如 Heap、GC 或 Compile")}
          />
        </Label>
        <Label>
          <span>{t("选项类别")}</span>
          <SelectControl
            value={category}
            onValueChange={(value) =>
              setCategory(value as OptionCategory)
            }
          >
            <SelectControlItem value="ALL">{t("全部类别")}</SelectControlItem>
            <SelectControlItem value="MEMORY">
              {t("内存与 Heap")}
            </SelectControlItem>
            <SelectControlItem value="GC">{t("垃圾回收")}</SelectControlItem>
            <SelectControlItem value="COMPILER">
              {t("编译器与 Code Cache")}
            </SelectControlItem>
            <SelectControlItem value="DIAGNOSTIC">
              {t("诊断与故障处理")}
            </SelectControlItem>
            <SelectControlItem value="LOGGING">
              {t("日志与跟踪")}
            </SelectControlItem>
            <SelectControlItem value="OTHER">
              {t("其他选项")}
            </SelectControlItem>
          </SelectControl>
        </Label>
        <Label>
          <span>{t("可写性")}</span>
          <SelectControl
            value={mutability}
            onValueChange={(value) =>
              setMutability(value as OptionMutability)
            }
          >
            <SelectControlItem value="ALL">{t("全部选项")}</SelectControlItem>
            <SelectControlItem value="WRITEABLE">
              {t("仅可写")}
            </SelectControlItem>
            <SelectControlItem value="READ_ONLY">
              {t("仅只读")}
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
          {t("搜索选项")}
        </Button>
      </form>

      <dl className="vm-option-inspector__stats">
        <div>
          <dt>{t("匹配")}</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>{t("可写")}</dt>
          <dd>{writeableCount}</dd>
        </div>
        <div>
          <dt>{t("只读")}</dt>
          <dd>{readOnlyCount}</dd>
        </div>
        <div>
          <dt>{t("安全遮罩")}</dt>
          <dd>{maskedCount}</dd>
        </div>
      </dl>

      {sourceTruncated && (
        <Alert className="vm-option-inspector__notice" role="status">
          <AlertDescription>
            {t("VM Option 源超过安全上限，本次检查 {scanned} / {total} 项。", {
              scanned: scannedCount,
              total: optionCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {invalidCount > 0 && (
        <Alert className="vm-option-inspector__notice" role="status">
          <AlertDescription>
            {t("跳过 {count} 个无效 VM Option。", { count: invalidCount })}
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}

      <div className="vm-option-inspector__workspace">
        <section
          className="vm-option-inspector__list"
          aria-label={t("VM Option 列表")}
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
            <div className="vm-option-inspector__rows">
              {entries.map((entry) => (
                <Button
                  variant="ghost"
                  key={entry.name}
                  type="button"
                  aria-pressed={entry.name === selectedName}
                  className="vm-option-row aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                  onClick={() => setSelectedName(entry.name)}
                >
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {categoryLabel(entry.category)} · {entry.origin}
                    </small>
                  </span>
                  <StatusPill
                    state={entry.writeable ? "ready" : "idle"}
                    label={entry.writeable ? t("可写") : t("只读")}
                  />
                </Button>
              ))}
            </div>
          ) : (
            <div className="vm-option-inspector__empty">
              {loading ? t("正在读取 VM Option…") : t("没有匹配的 VM Option。")}
            </div>
          )}
          <footer>
            <StatePagination
              ariaLabel={t("VM Option 分页")}
              previousLabel={t("上一页")}
              nextLabel={t("下一页")}
              previousDisabled={offset === 0 || loading}
              nextDisabled={offset + PAGE_SIZE >= total || loading}
              onPrevious={() => void load(Math.max(0, offset - PAGE_SIZE))}
              onNext={() => void load(offset + PAGE_SIZE)}
            />
          </footer>
        </section>

        <aside className="vm-option-inspector__detail">
          {selectedOption ? (
            <>
              <header>
                <div>
                  <p className="eyebrow">EXACT VM OPTION</p>
                  <h3>{selectedOption.name}</h3>
                </div>
                <StatusPill
                  state={selectedOption.mutable ? "ready" : "idle"}
                  label={
                    selectedOption.mutable ? t("可进入修改预检") : t("仅检查")
                  }
                />
              </header>
              <dl>
                <div>
                  <dt>{t("类别")}</dt>
                  <dd>{categoryLabel(selectedOption.category)}</dd>
                </div>
                <div>
                  <dt>{t("来源")}</dt>
                  <dd>{selectedOption.origin}</dd>
                </div>
                <div>
                  <dt>{t("可写性")}</dt>
                  <dd>{selectedOption.writeable ? t("可写") : t("只读")}</dd>
                </div>
                <div>
                  <dt>{t("返回边界")}</dt>
                  <dd>
                    {selectedOption.visibility === "MASKED"
                      ? t("值未离开 Agent")
                      : selectedOption.truncated
                        ? t("已截断为 4,096 个字符")
                        : t("完整安全值")}
                  </dd>
                </div>
              </dl>
              <pre>
                <code>{selectedOption.value}</code>
              </pre>
              <div className="vm-option-inspector__actions">
                {selectedOption.visibility === "MASKED" ? (
                  <p>{t("命令型或敏感选项不可查看、复制或修改。")}</p>
                ) : !selectedOption.writeable ? (
                  <p>{t("HotSpot 将该选项声明为只读；探微不会尝试写入。")}</p>
                ) : selectedOption.truncated ? (
                  <p>{t("旧值超过精确校验边界，因此只允许检查。")}</p>
                ) : (
                  <p>{t("修改前会重新读取旧值；并发漂移会使预检失效。")}</p>
                )}
                {selectedOption.mutable && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onPrepareMutation(selectedOption.name)}
                  >
                    {t("带入 R3 修改预检")}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="vm-option-inspector__empty">
              {t("选择一个 VM Option 查看来源与修改边界。")}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

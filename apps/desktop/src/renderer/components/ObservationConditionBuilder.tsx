import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import {
  createObservationConditionClause,
  OBSERVATION_CONDITION_MAX_CLAUSES,
  serializeObservationCondition,
  type ObservationConditionClause,
  type ObservationConditionOperator,
  type ObservationConditionSubject,
} from "@shared/observation-condition";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "../i18n";

interface ObservationConditionBuilderProps {
  readonly value: readonly ObservationConditionClause[];
  readonly disabled?: boolean;
  readonly onChange: (value: readonly ObservationConditionClause[]) => void;
}

const SUBJECTS: readonly [ObservationConditionSubject, string][] = [
  ["DURATION", "执行耗时"],
  ["THREAD", "线程名称"],
  ["ARGUMENT", "方法参数"],
  ["OUTCOME", "调用结果"],
  ["EXCEPTION", "异常类型"],
  ["RETURN", "返回值"],
];

const TEXT_OPERATORS: readonly [ObservationConditionOperator, string][] = [
  ["contains", "包含"],
  ["==", "等于"],
];
const DURATION_OPERATORS: readonly [ObservationConditionOperator, string][] = [
  [">=", "大于等于"],
  [">", "大于"],
  ["<=", "小于等于"],
  ["<", "小于"],
  ["==", "等于"],
];
const EXCEPTION_OPERATORS: readonly [ObservationConditionOperator, string][] = [
  ["exists", "存在异常"],
  ["contains", "类型包含"],
  ["==", "类型等于"],
];

export default function ObservationConditionBuilder({
  value,
  disabled = false,
  onChange,
}: ObservationConditionBuilderProps) {
  const compilation = serializeObservationCondition(value);

  function replaceClause(
    index: number,
    clause: ObservationConditionClause,
  ): void {
    onChange(
      value.map((item, itemIndex) =>
        itemIndex === index ? clause : item,
      ),
    );
  }

  function updateClause(
    index: number,
    patch: Partial<ObservationConditionClause>,
  ): void {
    const current = value[index];
    if (!current) {
      return;
    }
    replaceClause(index, { ...current, ...patch });
  }

  function changeSubject(
    index: number,
    subject: ObservationConditionSubject,
  ): void {
    replaceClause(index, createObservationConditionClause(subject));
  }

  return (
    <Card data-testid="observation-condition-builder" className="gap-0">
      <CardHeader className="border-b">
        <div className="flex items-center gap-2">
          <span className="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
            <ShieldCheck className="size-4" />
          </span>
          <div className="grid gap-1">
            <CardTitle>{t("安全事件条件")}</CardTitle>
            <CardDescription>
              {t("仅支持受限字段与 AND；不执行脚本、OGNL 或反射。")}
            </CardDescription>
          </div>
        </div>
        <CardAction className="flex items-center gap-2">
          <Badge variant="secondary">
            {value.length}/{OBSERVATION_CONDITION_MAX_CLAUSES}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              disabled || value.length >= OBSERVATION_CONDITION_MAX_CLAUSES
            }
            onClick={() =>
              onChange([...value, createObservationConditionClause()])
            }
          >
            <Plus />
            {t("添加条件")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 py-5">
        {value.length === 0 ? (
          <div className="border-border text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-sm">
            <p className="text-foreground font-medium">
              {t("当前捕获全部匹配调用")}
            </p>
            <p className="mt-1">
              {t("添加条件后，所有规则同时满足时才生成事件。")}
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {value.map((clause, index) => (
              <div key={index}>
                {index > 0 && (
                  <div className="text-muted-foreground flex h-8 items-center gap-3 text-xs font-medium uppercase">
                    <span className="bg-border h-px flex-1" />
                    {t("且（AND）")}
                    <span className="bg-border h-px flex-1" />
                  </div>
                )}
                <div className="bg-muted/30 grid gap-3 rounded-lg border p-4 lg:grid-cols-[minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(12rem,2fr)_auto]">
                  <div className="grid gap-2">
                    <Label>{t("字段")}</Label>
                    <Select
                      value={clause.subject}
                      disabled={disabled}
                      onValueChange={(nextValue) =>
                        changeSubject(
                          index,
                          nextValue as ObservationConditionSubject,
                        )
                      }
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={t("条件 {index} 字段", { index: index + 1 })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUBJECTS.map(([subject, label]) => (
                          <SelectItem key={subject} value={subject}>
                            {t(label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {clause.subject === "ARGUMENT" ? (
                    <div className="grid grid-cols-[5.5rem_1fr] gap-3">
                      <div className="grid gap-2">
                        <Label htmlFor={`condition-argument-${index}`}>
                          {t("序号")}
                        </Label>
                        <Input
                          id={`condition-argument-${index}`}
                          type="number"
                          min={0}
                          max={15}
                          disabled={disabled}
                          value={clause.argumentIndex}
                          onChange={(event) =>
                            updateClause(index, {
                              argumentIndex: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                      <OperatorSelect
                        index={index}
                        value={clause.operator}
                        items={TEXT_OPERATORS}
                        disabled={disabled}
                        onChange={(operator) =>
                          updateClause(index, { operator })
                        }
                      />
                    </div>
                  ) : (
                    <OperatorSelect
                      index={index}
                      value={clause.operator}
                      items={operatorsFor(clause.subject)}
                      disabled={disabled}
                      onChange={(operator) =>
                        updateClause(index, { operator })
                      }
                    />
                  )}

                  <ConditionValue
                    index={index}
                    clause={clause}
                    disabled={disabled}
                    onChange={(nextValue) =>
                      updateClause(index, { value: nextValue })
                    }
                  />

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="self-end"
                    disabled={disabled}
                    aria-label={t("删除条件 {index}", { index: index + 1 })}
                    onClick={() =>
                      onChange(
                        value.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-2">
          <Label>{t("将发送到 Agent 的受限表达式")}</Label>
          <code
            data-testid="observation-condition-expression"
            className="bg-muted text-foreground min-h-10 overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs leading-5"
          >
            {compilation.ok
              ? compilation.expression || t("无条件（捕获全部）")
              : t(compilation.error)}
          </code>
          {!compilation.ok && (
            <Alert variant="destructive">
              <AlertDescription>{t(compilation.error)}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface OperatorSelectProps {
  readonly index: number;
  readonly value: ObservationConditionOperator;
  readonly items: readonly [ObservationConditionOperator, string][];
  readonly disabled: boolean;
  readonly onChange: (value: ObservationConditionOperator) => void;
}

function OperatorSelect({
  index,
  value,
  items,
  disabled,
  onChange,
}: OperatorSelectProps) {
  return (
    <div className="grid gap-2">
      <Label>{t("判断")}</Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) =>
          onChange(nextValue as ObservationConditionOperator)
        }
      >
        <SelectTrigger
          className="w-full"
          aria-label={t("条件 {index} 判断", { index: index + 1 })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map(([operator, label]) => (
            <SelectItem key={operator} value={operator}>
              {t(label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface ConditionValueProps {
  readonly index: number;
  readonly clause: ObservationConditionClause;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}

function ConditionValue({
  index,
  clause,
  disabled,
  onChange,
}: ConditionValueProps) {
  if (clause.subject === "EXCEPTION" && clause.operator === "exists") {
    return (
      <div className="grid gap-2">
        <Label>{t("值")}</Label>
        <div className="text-muted-foreground flex h-9 items-center rounded-md border border-dashed px-3 text-sm">
          {t("无需填写")}
        </div>
      </div>
    );
  }
  if (clause.subject === "OUTCOME") {
    return (
      <div className="grid gap-2">
        <Label>{t("结果")}</Label>
        <Select value={clause.value} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger
            className="w-full"
            aria-label={t("条件 {index} 值", { index: index + 1 })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="RETURNED">{t("正常返回")}</SelectItem>
            <SelectItem value="THREW">{t("抛出异常")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }
  const inputId = `condition-value-${index}`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={inputId}>
        {clause.subject === "DURATION" ? t("毫秒") : t("值")}
      </Label>
      <Input
        id={inputId}
        type={clause.subject === "DURATION" ? "number" : "text"}
        min={clause.subject === "DURATION" ? 0 : undefined}
        max={clause.subject === "DURATION" ? 60_000 : undefined}
        step={clause.subject === "DURATION" ? 0.001 : undefined}
        maxLength={clause.subject === "THREAD" ? 128 : 256}
        disabled={disabled}
        value={clause.value}
        placeholder={placeholderFor(clause.subject)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function operatorsFor(
  subject: ObservationConditionSubject,
): readonly [ObservationConditionOperator, string][] {
  if (subject === "DURATION") {
    return DURATION_OPERATORS;
  }
  if (subject === "EXCEPTION") {
    return EXCEPTION_OPERATORS;
  }
  if (subject === "OUTCOME") {
    return [["==", "等于"]];
  }
  return TEXT_OPERATORS;
}

function placeholderFor(subject: ObservationConditionSubject): string {
  switch (subject) {
    case "THREAD":
      return t("例如 http-nio");
    case "ARGUMENT":
      return t("例如 order-");
    case "EXCEPTION":
      return t("例如 IllegalArgumentException");
    case "RETURN":
      return t("例如 accepted");
    default:
      return "10";
  }
}

export const OBSERVATION_CONDITION_MAX_CLAUSES = 4;
export const OBSERVATION_CONDITION_MAX_DURATION_MILLIS = 60_000;

export type ObservationConditionSubject =
  | "DURATION"
  | "THREAD"
  | "ARGUMENT"
  | "OUTCOME"
  | "EXCEPTION"
  | "RETURN";

export type ObservationConditionOperator =
  | ">="
  | ">"
  | "<="
  | "<"
  | "=="
  | "contains"
  | "exists";

export interface ObservationConditionClause {
  readonly subject: ObservationConditionSubject;
  readonly operator: ObservationConditionOperator;
  readonly value: string;
  readonly argumentIndex: number;
}

export type ObservationConditionCompilation =
  | {
      readonly ok: true;
      readonly expression: string;
      readonly clauses: readonly ObservationConditionClause[];
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const DURATION_PATTERN =
  /^durationMs\s*(>=|>|<=|<|==)\s*(\d+(?:\.\d+)?)$/u;
const THREAD_PATTERN = /^thread\s*(==|contains)\s*"([^"]{0,128})"$/u;
const ARGUMENT_PATTERN =
  /^arg(\d{1,2})\s*(==|contains)\s*"([^"]{0,256})"$/u;
const OUTCOME_PATTERN = /^outcome\s*==\s*"(RETURNED|THREW)"$/u;
const EXCEPTION_PATTERN =
  /^exception(?:\s*(==|contains)\s*"([^"]{1,256})")?$/u;
const RETURN_PATTERN = /^return\s*(==|contains)\s*"([^"]{0,256})"$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function createObservationConditionClause(
  subject: ObservationConditionSubject = "DURATION",
): ObservationConditionClause {
  switch (subject) {
    case "DURATION":
      return { subject, operator: ">=", value: "10", argumentIndex: 0 };
    case "ARGUMENT":
      return { subject, operator: "contains", value: "", argumentIndex: 0 };
    case "OUTCOME":
      return { subject, operator: "==", value: "RETURNED", argumentIndex: 0 };
    case "EXCEPTION":
      return { subject, operator: "exists", value: "", argumentIndex: 0 };
    default:
      return { subject, operator: "contains", value: "", argumentIndex: 0 };
  }
}

export function serializeObservationCondition(
  clauses: readonly ObservationConditionClause[],
): ObservationConditionCompilation {
  if (clauses.length > OBSERVATION_CONDITION_MAX_CLAUSES) {
    return failure("安全条件最多包含 4 条规则");
  }
  const expressions: string[] = [];
  for (const clause of clauses) {
    const compiled = serializeClause(clause);
    if (!compiled.ok) {
      return compiled;
    }
    expressions.push(compiled.expression);
  }
  const expression = expressions.join(" && ");
  if (expression.length > 512) {
    return failure("安全条件必须是最多 512 字符的单行表达式");
  }
  return {
    ok: true,
    expression,
    clauses: clauses.map((clause) => ({ ...clause })),
  };
}

export function parseObservationCondition(
  condition: string,
): ObservationConditionCompilation {
  const normalized = condition.trim();
  if (normalized.length === 0) {
    return { ok: true, expression: "", clauses: [] };
  }
  if (normalized.length > 512 || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    return failure("安全条件必须是最多 512 字符的单行表达式");
  }
  const parts = splitClauses(normalized);
  if (!parts || parts.length > OBSERVATION_CONDITION_MAX_CLAUSES) {
    return failure("安全条件仅支持最多 4 条 AND 规则");
  }
  const clauses: ObservationConditionClause[] = [];
  for (const part of parts) {
    const clause = parseClause(part);
    if (!clause) {
      return failure("安全条件包含不支持的字段、操作符或值");
    }
    clauses.push(clause);
  }
  return serializeObservationCondition(clauses);
}

export function isObservationConditionValid(condition: string): boolean {
  return parseObservationCondition(condition).ok;
}

function serializeClause(
  clause: ObservationConditionClause,
): ObservationConditionCompilation {
  switch (clause.subject) {
    case "DURATION": {
      if (![">=", ">", "<=", "<", "=="].includes(clause.operator)) {
        return failure("耗时条件使用了不支持的操作符");
      }
      const duration = Number(clause.value);
      if (
        !/^\d+(?:\.\d{1,3})?$/u.test(clause.value) ||
        !Number.isFinite(duration) ||
        duration < 0 ||
        duration > OBSERVATION_CONDITION_MAX_DURATION_MILLIS
      ) {
        return failure("耗时必须是 0–60000 ms，最多 3 位小数");
      }
      return success(`durationMs ${clause.operator} ${clause.value}`);
    }
    case "THREAD":
      return serializeTextClause("thread", clause, 128);
    case "ARGUMENT":
      if (
        !Number.isInteger(clause.argumentIndex) ||
        clause.argumentIndex < 0 ||
        clause.argumentIndex > 15
      ) {
        return failure("参数序号必须在 0–15 之间");
      }
      return serializeTextClause(`arg${clause.argumentIndex}`, clause, 256);
    case "OUTCOME":
      if (
        clause.operator !== "==" ||
        (clause.value !== "RETURNED" && clause.value !== "THREW")
      ) {
        return failure("调用结果只能是正常返回或抛出异常");
      }
      return success(`outcome == "${clause.value}"`);
    case "EXCEPTION":
      if (clause.operator === "exists") {
        return success("exception");
      }
      return serializeTextClause("exception", clause, 256, false);
    case "RETURN":
      return serializeTextClause("return", clause, 256);
  }
}

function serializeTextClause(
  field: string,
  clause: ObservationConditionClause,
  maximumLength: number,
  allowEmpty = true,
): ObservationConditionCompilation {
  if (clause.operator !== "==" && clause.operator !== "contains") {
    return failure("文本条件使用了不支持的操作符");
  }
  if (
    (!allowEmpty && clause.value.length === 0) ||
    clause.value.length > maximumLength ||
    clause.value.includes('"') ||
    CONTROL_CHARACTER_PATTERN.test(clause.value)
  ) {
    return failure(`条件值必须是最多 ${maximumLength} 字符的安全单行文本`);
  }
  return success(`${field} ${clause.operator} "${clause.value}"`);
}

function parseClause(part: string): ObservationConditionClause | null {
  let match = DURATION_PATTERN.exec(part);
  if (match?.[1] && match[2]) {
    return {
      subject: "DURATION",
      operator: match[1] as ObservationConditionOperator,
      value: match[2],
      argumentIndex: 0,
    };
  }
  match = THREAD_PATTERN.exec(part);
  if (match?.[1] && match[2] !== undefined) {
    return {
      subject: "THREAD",
      operator: match[1] as ObservationConditionOperator,
      value: match[2],
      argumentIndex: 0,
    };
  }
  match = ARGUMENT_PATTERN.exec(part);
  if (match?.[1] && match[2] && match[3] !== undefined) {
    return {
      subject: "ARGUMENT",
      operator: match[2] as ObservationConditionOperator,
      value: match[3],
      argumentIndex: Number(match[1]),
    };
  }
  match = OUTCOME_PATTERN.exec(part);
  if (match?.[1]) {
    return {
      subject: "OUTCOME",
      operator: "==",
      value: match[1],
      argumentIndex: 0,
    };
  }
  match = EXCEPTION_PATTERN.exec(part);
  if (match) {
    return {
      subject: "EXCEPTION",
      operator: match[1]
        ? (match[1] as ObservationConditionOperator)
        : "exists",
      value: match[2] ?? "",
      argumentIndex: 0,
    };
  }
  match = RETURN_PATTERN.exec(part);
  if (match?.[1] && match[2] !== undefined) {
    return {
      subject: "RETURN",
      operator: match[1] as ObservationConditionOperator,
      value: match[2],
      argumentIndex: 0,
    };
  }
  return null;
}

function splitClauses(condition: string): string[] | null {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let index = 0; index < condition.length; index += 1) {
    const character = condition[index];
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (
      !quoted &&
      character === "&" &&
      condition[index + 1] === "&"
    ) {
      const part = condition.slice(start, index).trim();
      if (part.length === 0) {
        return null;
      }
      parts.push(part);
      start = index + 2;
      index += 1;
    }
  }
  if (quoted) {
    return null;
  }
  const finalPart = condition.slice(start).trim();
  if (finalPart.length === 0) {
    return null;
  }
  parts.push(finalPart);
  return parts;
}

function success(expression: string): ObservationConditionCompilation {
  return { ok: true, expression, clauses: [] };
}

function failure(error: string): ObservationConditionCompilation {
  return { ok: false, error };
}

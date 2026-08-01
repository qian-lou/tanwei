import type {
  CompiledClassChangeSet,
} from "@shared/contracts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAXIMUM_CLASSES = 8;
const MAXIMUM_TOTAL_BYTECODE = 2 * 1024 * 1024;

export interface ClassChangeSetDraft {
  readonly className: string;
  readonly classLoader: string;
  readonly source: string;
}

export interface ClassChangeSetEvidenceItem {
  readonly className: string;
  readonly classLoader: string;
  readonly previousSha256: string;
  readonly currentSha256: string;
  readonly previousSize: number;
  readonly currentSize: number;
}

export interface ClassChangeSetPreviewEvidence {
  readonly fingerprint: string;
  readonly items: readonly ClassChangeSetEvidenceItem[];
}

export function buildClassChangeSetParameters(
  drafts: readonly ClassChangeSetDraft[],
  compiled: CompiledClassChangeSet,
): Readonly<Record<string, string>> {
  validateDrafts(drafts);
  if (
    compiled.items.length !== drafts.length ||
    compiled.totalSize <= 0 ||
    compiled.totalSize > MAXIMUM_TOTAL_BYTECODE
  ) {
    throw new Error("Host返回的多类编译结果越界");
  }
  const draftsByName = new Map(
    drafts.map((draft) => [draft.className, draft]),
  );
  const parameters: Record<string, string> = {
    count: String(drafts.length),
  };
  let totalSize = 0;
  for (let index = 0; index < compiled.items.length; index += 1) {
    const item = compiled.items[index];
    if (
      !item ||
      !Number.isSafeInteger(item.size) ||
      item.size < 8 ||
      !SHA256_PATTERN.test(item.sha256) ||
      !BASE64_PATTERN.test(item.bytecodeBase64)
    ) {
      throw new Error("Host返回了无效的变更集类文件");
    }
    const draft = draftsByName.get(item.className);
    if (!draft) {
      throw new Error("Host返回了未请求的变更集类");
    }
    totalSize += item.size;
    parameters[`item${index}Name`] = item.className;
    parameters[`item${index}ClassLoader`] = draft.classLoader;
    parameters[`item${index}BytecodeBase64`] =
      item.bytecodeBase64;
  }
  if (
    totalSize !== compiled.totalSize ||
    totalSize > MAXIMUM_TOTAL_BYTECODE
  ) {
    throw new Error("Host返回的变更集总字节数不一致");
  }
  return parameters;
}

export function parseClassChangeSetPreview(
  values: Readonly<Record<string, string>>,
  drafts: readonly ClassChangeSetDraft[],
): ClassChangeSetPreviewEvidence {
  const fingerprint = values.fingerprint ?? "";
  if (
    !SHA256_PATTERN.test(fingerprint) ||
    values.structuralCompatible !== "true"
  ) {
    throw new Error("Agent返回了无效的多类预检指纹");
  }
  return {
    fingerprint,
    items: parseEvidenceItems(values, drafts, "preview"),
  };
}

export function parseClassChangeSetResult(
  values: Readonly<Record<string, string>>,
  drafts: readonly ClassChangeSetDraft[],
): readonly ClassChangeSetEvidenceItem[] {
  return parseEvidenceItems(values, drafts, "result");
}

function validateDrafts(
  drafts: readonly ClassChangeSetDraft[],
): void {
  if (drafts.length < 2 || drafts.length > MAXIMUM_CLASSES) {
    throw new Error("多类变更集必须包含 2 到 8 个精确类");
  }
  const classLoader = drafts[0]?.classLoader;
  const identities = new Set<string>();
  for (const draft of drafts) {
    if (
      !draft.className ||
      !draft.classLoader ||
      !draft.source ||
      draft.classLoader !== classLoader
    ) {
      throw new Error("多类变更集的源码或精确 ClassLoader 无效");
    }
    const identity = `${draft.className}\0${draft.classLoader}`;
    if (identities.has(identity)) {
      throw new Error("多类变更集不能包含重复类");
    }
    identities.add(identity);
  }
}

function parseEvidenceItems(
  values: Readonly<Record<string, string>>,
  drafts: readonly ClassChangeSetDraft[],
  phase: "preview" | "result",
): readonly ClassChangeSetEvidenceItem[] {
  validateDrafts(drafts);
  const count = Number(values.count);
  if (
    !Number.isSafeInteger(count) ||
    count !== drafts.length
  ) {
    throw new Error("Agent返回的变更集类数量不一致");
  }
  const expectedIdentities = new Set(
    drafts.map(
      (draft) => `${draft.className}\0${draft.classLoader}`,
    ),
  );
  const receivedIdentities = new Set<string>();
  const items: ClassChangeSetEvidenceItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const prefix = `item.${String(index).padStart(2, "0")}.`;
    const className = values[`${prefix}className`] ?? "";
    const classLoader = values[`${prefix}classLoader`] ?? "";
    const previousSha256 =
      values[
        `${prefix}${
          phase === "preview" ? "currentSha256" : "previousSha256"
        }`
      ] ?? "";
    const currentSha256 =
      values[
        `${prefix}${
          phase === "preview" ? "proposedSha256" : "currentSha256"
        }`
      ] ?? "";
    const previousSize = Number(
      values[
        `${prefix}${
          phase === "preview" ? "currentSize" : "previousSize"
        }`
      ],
    );
    const currentSize = Number(
      values[
        `${prefix}${
          phase === "preview" ? "proposedSize" : "currentSize"
        }`
      ],
    );
    const identity = `${className}\0${classLoader}`;
    if (
      !expectedIdentities.has(identity) ||
      receivedIdentities.has(identity) ||
      !SHA256_PATTERN.test(previousSha256) ||
      !SHA256_PATTERN.test(currentSha256) ||
      !Number.isSafeInteger(previousSize) ||
      previousSize < 8 ||
      !Number.isSafeInteger(currentSize) ||
      currentSize < 8
    ) {
      throw new Error("Agent返回了无效的变更集类证据");
    }
    receivedIdentities.add(identity);
    items.push({
      className,
      classLoader,
      previousSha256,
      currentSha256,
      previousSize,
      currentSize,
    });
  }
  if (receivedIdentities.size !== expectedIdentities.size) {
    throw new Error("Agent返回的变更集身份集合不完整");
  }
  return items;
}

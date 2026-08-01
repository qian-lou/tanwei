import { z } from "zod";
import type {
  RiskLevel,
  TeamPolicyDescriptor,
  TargetConnection,
} from "../shared/contracts.js";
import { isObservationConditionValid } from "../shared/observation-condition.js";
import {
  publicKeyFingerprint,
  verifyTeamPolicy,
} from "./governance-signatures.js";

interface ActionContract {
  readonly riskLevel: RiskLevel;
  readonly requiredCapability: string;
  readonly parameters: z.ZodType<Readonly<Record<string, string>>>;
}

export interface ActionContractDescriptor {
  readonly actionId: string;
  readonly contractVersion: "1.0";
  readonly riskLevel: RiskLevel;
  readonly requiredCapability: string;
}

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
};

const safeRuntimeName = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\r\n]/u.test(value), "名称不能包含换行符");
const boundedRuntimeValue = z
  .string()
  .max(4_096)
  .refine((value) => !/[\r\n]/u.test(value), "值不能包含换行符");
const watchPhases = z.string().max(64).refine((value) => {
  const phases = value.split(",");
  return (
    phases.length >= 1 &&
    phases.length <= 4 &&
    new Set(phases).size === phases.length &&
    phases.every(
      (phase) =>
        phase === "BEFORE" ||
        phase === "RETURN" ||
        phase === "THROW" ||
        phase === "FINISH",
    )
  );
}, "至少选择一个有效的观测时机");
const profilerRules = z
  .string()
  .max(1_032)
  .refine((value) => {
    const patterns = value
      .split(/\r?\n/u)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    return (
      patterns.length <= 8 &&
      new Set(patterns).size === patterns.length &&
      patterns.every(
        (pattern) =>
          pattern.length <= 128 &&
          pattern !== "*" &&
          !/[\u0000-\u001f,]/u.test(pattern) &&
          /^\*?[^*]+\*?$/u.test(pattern),
      )
    );
  }, "Profiler 过滤器仅支持最多 8 个首尾通配模式");
const jfrRecordingName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "JFR 录制名称不能包含控制字符",
  );
const mbeanObjectName = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => !/[\r\n]/u.test(value), "ObjectName 不能包含换行符");
const mbeanOperationArgument = z
  .string()
  .max(32_768)
  .refine((value) => !value.includes("\0"), "MBean 参数不能包含空字符");
const mbeanOperationArgumentFormat = z
  .enum(["SCALAR", "OPEN_TYPE_JSON"])
  .optional();
const mbeanOperationIdentityParameters = {
  objectName: mbeanObjectName,
  operation: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
  parameterTypes: z
    .string()
    .max(4_096)
    .regex(/^(?:|[A-Za-z_$][A-Za-z0-9_$.]*(?:,[A-Za-z_$][A-Za-z0-9_$.]*)*)$/u),
  argumentCount: z.string().regex(/^[0-8]$/u),
  argument0: mbeanOperationArgument,
  argument1: mbeanOperationArgument,
  argument2: mbeanOperationArgument,
  argument3: mbeanOperationArgument,
  argument4: mbeanOperationArgument,
  argument5: mbeanOperationArgument,
  argument6: mbeanOperationArgument,
  argument7: mbeanOperationArgument,
  argumentFormat0: mbeanOperationArgumentFormat,
  argumentFormat1: mbeanOperationArgumentFormat,
  argumentFormat2: mbeanOperationArgumentFormat,
  argumentFormat3: mbeanOperationArgumentFormat,
  argumentFormat4: mbeanOperationArgumentFormat,
  argumentFormat5: mbeanOperationArgumentFormat,
  argumentFormat6: mbeanOperationArgumentFormat,
  argumentFormat7: mbeanOperationArgumentFormat,
};
function validateMBeanArguments(
  value: Readonly<Record<string, string | undefined>>,
  context: z.RefinementCtx,
): void {
  const argumentCount = Number(value.argumentCount);
  let totalCharacters = 0;
  for (let index = 0; index < argumentCount; index += 1) {
    const argument = value[`argument${index}`] ?? "";
    const format = value[`argumentFormat${index}`] ?? "SCALAR";
    totalCharacters += argument.length;
    if (
      format === "SCALAR" &&
      (argument.length > 512 || /[\r\n]/u.test(argument))
    ) {
      context.addIssue({
        code: "custom",
        message: "标量 MBean 参数必须是最多 512 字符的单行值",
      });
      return;
    }
    if (format === "OPEN_TYPE_JSON" && argument.length === 0) {
      context.addIssue({
        code: "custom",
        message: "OpenType JSON 参数不能为空",
      });
      return;
    }
  }
  if (totalCharacters > 32_768) {
    context.addIssue({
      code: "custom",
      message: "MBean 参数总长度不能超过 32 KiB",
    });
    return;
  }
  for (let index = argumentCount; index < 8; index += 1) {
    if (
      value[`argument${index}`] !== "" ||
      value[`argumentFormat${index}`] !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "未使用的 MBean 参数必须为空",
      });
      return;
    }
  }
}
const mbeanOperationPreviewParameterSchema = z
  .object(mbeanOperationIdentityParameters)
  .strict()
  .superRefine(validateMBeanArguments);
const mbeanOperationInvokeParameterSchema = z
  .object({
    ...mbeanOperationIdentityParameters,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    confirmed: z.literal("true"),
    confirmedSecondary: z.literal("true"),
  })
  .strict()
  .superRefine(validateMBeanArguments);
const mbeanAttributeWriteIdentityParameters = {
  objectName: mbeanObjectName,
  attribute: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !/[\r\n]/u.test(value), "属性名不能包含换行符"),
  valueFormat: z.enum(["SCALAR", "OPEN_TYPE_JSON"]).optional(),
  proposedValue: z.string().max(32_768),
};
function validateMBeanAttributeWrite(
  value: Readonly<Record<string, string | undefined>>,
  context: z.RefinementCtx,
): void {
  const format = value.valueFormat ?? "SCALAR";
  const proposedValue = value.proposedValue ?? "";
  if (
    format === "SCALAR" &&
    (proposedValue.length > 512 || /[\r\n]/u.test(proposedValue))
  ) {
    context.addIssue({
      code: "custom",
      path: ["proposedValue"],
      message: "标量属性值不能超过 512 字符或包含换行符",
    });
  }
  if (format === "OPEN_TYPE_JSON" && proposedValue.includes("\0")) {
    context.addIssue({
      code: "custom",
      path: ["proposedValue"],
      message: "OpenType JSON 不能包含空字符",
    });
  }
}
const mbeanAttributeWritePreviewParameterSchema = z
  .object(mbeanAttributeWriteIdentityParameters)
  .strict()
  .superRefine(validateMBeanAttributeWrite);
const mbeanAttributeWriteParameterSchema = z
  .object({
    ...mbeanAttributeWriteIdentityParameters,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    confirmed: z.literal("true"),
    confirmedSecondary: z.literal("true"),
  })
  .strict()
  .superRefine(validateMBeanAttributeWrite);
const loggerFramework = z.enum(["ALL", "JUL", "LOGBACK", "LOG4J", "LOG4J2"]);
const concreteLoggerFramework = z.enum(["JUL", "LOGBACK", "LOG4J", "LOG4J2"]);
const loggerLevel = z.enum([
  "<inherited>",
  "OFF",
  "FATAL",
  "SEVERE",
  "ERROR",
  "WARNING",
  "WARN",
  "INFO",
  "CONFIG",
  "FINE",
  "FINER",
  "FINEST",
  "DEBUG",
  "TRACE",
  "ALL",
]);
const LOGGER_LEVELS_BY_FRAMEWORK = {
  JUL: new Set([
    "<inherited>",
    "OFF",
    "SEVERE",
    "WARNING",
    "INFO",
    "CONFIG",
    "FINE",
    "FINER",
    "FINEST",
    "ALL",
  ]),
  LOGBACK: new Set([
    "<inherited>",
    "OFF",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
    "TRACE",
    "ALL",
  ]),
  LOG4J: new Set([
    "<inherited>",
    "OFF",
    "FATAL",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
    "TRACE",
    "ALL",
  ]),
  LOG4J2: new Set([
    "OFF",
    "FATAL",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
    "TRACE",
    "ALL",
  ]),
} as const;

function validateLoggerLevel(
  value: {
    readonly framework: keyof typeof LOGGER_LEVELS_BY_FRAMEWORK;
    readonly newLevel: string;
  },
  context: z.RefinementCtx,
): void {
  const allowedLevels: ReadonlySet<string> =
    LOGGER_LEVELS_BY_FRAMEWORK[value.framework];
  if (!allowedLevels.has(value.newLevel)) {
    context.addIssue({
      code: "custom",
      message: `${value.framework} 不支持日志级别 ${value.newLevel}`,
      path: ["newLevel"],
    });
  }
}
const boundedIntegerString = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/u)
    .refine((value) => {
      const parsed = Number(value);
      return (
        Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
      );
    }, `值必须介于 ${minimum} 与 ${maximum} 之间`);
const traceScopePrefix = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u)
  .refine(
    (value) => !/^(?:java|javax|jdk|sun|com\.sun)(?:\.|$)/u.test(value),
    "不允许追踪 JDK 包",
  );
const tracePathRulePattern =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\.\*)?(?:#[A-Za-z_$][A-Za-z0-9_$]*)?$/u;
const tracePathRules = z
  .string()
  .max(8_192)
  .superRefine((value, context) => {
    const rules = value.split("\n").filter((rule) => rule.length > 0);
    if (rules.length > 16) {
      context.addIssue({
        code: "custom",
        message: "Trace 路径规则最多 16 条",
      });
      return;
    }
    for (const rule of rules) {
      if (
        rule !== rule.trim() ||
        rule.length > 512 ||
        !tracePathRulePattern.test(rule) ||
        rule.includes(".*#")
      ) {
        context.addIssue({
          code: "custom",
          message: "Trace 路径规则必须是 package.*、完整类名或完整类名#方法名",
        });
        return;
      }
    }
  });
const perfCounterSnapshotNames = z
  .string()
  .min(1)
  .max(2_055)
  .superRefine((value, context) => {
    const names = value.split("\n");
    if (names.length < 1 || names.length > 8) {
      context.addIssue({
        code: "custom",
        message: "PerfCounter 快照必须包含 1—8 个名称",
      });
      return;
    }
    const unique = new Set<string>();
    for (const name of names) {
      if (
        !name ||
        name !== name.trim() ||
        name.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(name) ||
        unique.has(name)
      ) {
        context.addIssue({
          code: "custom",
          message: "PerfCounter 名称必须唯一、无控制字符且不超过 256 字符",
        });
        return;
      }
      unique.add(name);
    }
  });

function validateTraceFilterScopes(
  value: {
    readonly scopePrefix: string;
    readonly includeRules: string;
    readonly excludeRules: string;
  },
  context: z.RefinementCtx,
): void {
  for (const field of ["includeRules", "excludeRules"] as const) {
    for (const rule of value[field].split("\n")) {
      if (!rule) {
        continue;
      }
      const path = rule.split("#", 1)[0]?.replace(/\.\*$/u, "") ?? "";
      if (
        path !== value.scopePrefix &&
        !path.startsWith(`${value.scopePrefix}.`)
      ) {
        context.addIssue({
          code: "custom",
          message: "Trace 路径规则不能超出包范围",
        });
        return;
      }
    }
  }
}
const classIdentityParameters = {
  name: z.string().min(1).max(1_024),
  classLoader: z.string().min(1).max(4_096),
};
const classLoaderResourceName = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\r\n\0]/u.test(value) &&
      value
        .split("/")
        .every(
          (segment) =>
            segment.length > 0 && segment !== "." && segment !== "..",
        ),
    "资源名必须是无路径穿越的 ClassLoader 相对名称",
  );
const staticFieldIdentityParameters = {
  ...classIdentityParameters,
  declaringClass: z.string().min(1).max(1_024),
  fieldName: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
};
const compiledClassPayload = z
  .string()
  .min(12)
  .max(2_800_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const optionalChangeSetClassName = z.string().min(1).max(1_024).optional();
const optionalChangeSetClassLoader = z.string().min(1).max(4_096).optional();
const optionalChangeSetBytecode = compiledClassPayload.optional();
const classChangeSetItemParameters = {
  item0Name: optionalChangeSetClassName,
  item0ClassLoader: optionalChangeSetClassLoader,
  item0BytecodeBase64: optionalChangeSetBytecode,
  item1Name: optionalChangeSetClassName,
  item1ClassLoader: optionalChangeSetClassLoader,
  item1BytecodeBase64: optionalChangeSetBytecode,
  item2Name: optionalChangeSetClassName,
  item2ClassLoader: optionalChangeSetClassLoader,
  item2BytecodeBase64: optionalChangeSetBytecode,
  item3Name: optionalChangeSetClassName,
  item3ClassLoader: optionalChangeSetClassLoader,
  item3BytecodeBase64: optionalChangeSetBytecode,
  item4Name: optionalChangeSetClassName,
  item4ClassLoader: optionalChangeSetClassLoader,
  item4BytecodeBase64: optionalChangeSetBytecode,
  item5Name: optionalChangeSetClassName,
  item5ClassLoader: optionalChangeSetClassLoader,
  item5BytecodeBase64: optionalChangeSetBytecode,
  item6Name: optionalChangeSetClassName,
  item6ClassLoader: optionalChangeSetClassLoader,
  item6BytecodeBase64: optionalChangeSetBytecode,
  item7Name: optionalChangeSetClassName,
  item7ClassLoader: optionalChangeSetClassLoader,
  item7BytecodeBase64: optionalChangeSetBytecode,
};
type ClassChangeSetParameters = Readonly<Record<string, string | undefined>> & {
  readonly count: string;
};
function validateClassChangeSetParameters(
  value: ClassChangeSetParameters,
  context: z.RefinementCtx,
): void {
  const count = Number(value.count);
  let classLoader: string | undefined;
  let totalEncodedBytes = 0;
  const identities = new Set<string>();
  for (let index = 0; index < 8; index += 1) {
    const name = value[`item${index}Name`];
    const itemClassLoader = value[`item${index}ClassLoader`];
    const bytecode = value[`item${index}BytecodeBase64`];
    if (index >= count) {
      if (
        name !== undefined ||
        itemClassLoader !== undefined ||
        bytecode !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "变更集不能包含计数范围外的类参数",
        });
        return;
      }
      continue;
    }
    if (!name || !itemClassLoader || !bytecode) {
      context.addIssue({
        code: "custom",
        message: "变更集中的每个类都必须提供精确身份和字节码",
      });
      return;
    }
    if (classLoader === undefined) {
      classLoader = itemClassLoader;
    } else if (classLoader !== itemClassLoader) {
      context.addIssue({
        code: "custom",
        message: "变更集中的类必须来自同一个精确 ClassLoader",
      });
      return;
    }
    const identity = `${name}\0${itemClassLoader}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "变更集不能包含重复类",
      });
      return;
    }
    identities.add(identity);
    totalEncodedBytes += bytecode.length;
  }
  if (totalEncodedBytes > 2_800_000) {
    context.addIssue({
      code: "custom",
      message: "变更集编译字节码总量超过 2 MiB 边界",
    });
  }
}
function compactClassChangeSetParameters(
  value: ClassChangeSetParameters,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
const classChangeSetPreviewParameterSchema = z
  .object({
    count: z.enum(["2", "3", "4", "5", "6", "7", "8"]),
    ...classChangeSetItemParameters,
  })
  .strict()
  .superRefine(validateClassChangeSetParameters)
  .transform(compactClassChangeSetParameters);
const classChangeSetApplyParameterSchema = z
  .object({
    count: z.enum(["2", "3", "4", "5", "6", "7", "8"]),
    ...classChangeSetItemParameters,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    confirmed: z.literal("true"),
  })
  .strict()
  .superRefine(validateClassChangeSetParameters)
  .transform(compactClassChangeSetParameters);
const replayIdentityParameters = {
  className: z.string().min(1).max(1_024),
  classLoader: z.string().min(1).max(4_096),
  methodName: z.string().min(1).max(512),
  parameterTypes: z.string().max(4_096),
  argumentCount: z.string().regex(/^[0-8]$/u),
  snapshotId: boundedIntegerString(1, 1_000_000_000).optional(),
  replayMode: z.enum(["STATIC", "INSTANCE"]).optional(),
  argument0: z.string().max(512),
  argument1: z.string().max(512),
  argument2: z.string().max(512),
  argument3: z.string().max(512),
  argument4: z.string().max(512),
  argument5: z.string().max(512),
  argument6: z.string().max(512),
  argument7: z.string().max(512),
};

function validateReplayArguments(
  value: Readonly<Record<string, string | undefined>>,
  context: z.RefinementCtx,
): void {
  if (value.replayMode === "INSTANCE" && value.snapshotId === undefined) {
    context.addIssue({
      code: "custom",
      message: "实例调用重放必须绑定来源快照",
    });
    return;
  }
  const argumentCount = Number(value.argumentCount);
  for (let index = argumentCount; index < 8; index += 1) {
    if (value[`argument${index}`] !== "") {
      context.addIssue({
        code: "custom",
        message: "未使用的调用重放参数必须为空",
      });
      return;
    }
  }
}

const replayPreviewParameterSchema = z
  .object(replayIdentityParameters)
  .strict()
  .superRefine(validateReplayArguments);
const replayExecuteParameterSchema = z
  .object({
    ...replayIdentityParameters,
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    confirmed: z.literal("true"),
    confirmedSecondary: z.literal("true"),
  })
  .strict()
  .superRefine(validateReplayArguments);

const ACTION_CONTRACT_CATALOG = new Map<string, ActionContract>([
  [
    "jvm.info",
    {
      riskLevel: "R0",
      requiredCapability: "overview",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "jvm.arguments",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "system.properties",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "system.property.list",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z
        .object({
          query: z
            .string()
            .max(128)
            .refine(
              (value) => !/[\u0000-\u001f\u007f]/u.test(value),
              "系统属性查询不能包含控制字符",
            ),
          category: z.enum([
            "ALL",
            "JAVA",
            "VM",
            "OS",
            "USER",
            "PATH",
            "APPLICATION",
          ]),
          offset: boundedIntegerString(0, 10_000),
          limit: boundedIntegerString(1, 200),
        })
        .strict(),
    },
  ],
  [
    "environment.summary",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "environment.list",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z
        .object({
          query: z
            .string()
            .max(128)
            .refine(
              (value) => !/[\u0000-\u001f\u007f]/u.test(value),
              "环境变量查询不能包含控制字符",
            ),
          category: z.enum([
            "ALL",
            "JAVA",
            "PATH",
            "LOCALE",
            "PROCESS",
            "OTHER",
          ]),
          offset: boundedIntegerString(0, 10_000),
          limit: boundedIntegerString(1, 200),
        })
        .strict(),
    },
  ],
  [
    "memory.pools",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "gc.collectors",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "jit.compiler.summary",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "perfcounter.list",
    {
      riskLevel: "R0",
      requiredCapability: "perfcounters",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          namespace: z.enum(["ALL", "JAVA", "SUN", "JDK", "OTHER"]),
          offset: boundedIntegerString(0, 20_000),
          limit: boundedIntegerString(1, 200),
        })
        .strict(),
    },
  ],
  [
    "perfcounter.snapshot",
    {
      riskLevel: "R0",
      requiredCapability: "perfcounters",
      parameters: z
        .object({
          names: perfCounterSnapshotNames,
        })
        .strict(),
    },
  ],
  [
    "mbeans.summary",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "mbean.list",
    {
      riskLevel: "R0",
      requiredCapability: "mbeans",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          offset: z.string().regex(/^(?:0|[1-9]\d{0,5})$/u),
          limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/u),
        })
        .strict(),
    },
  ],
  [
    "mbean.describe",
    {
      riskLevel: "R0",
      requiredCapability: "mbeans",
      parameters: z.object({ objectName: mbeanObjectName }).strict(),
    },
  ],
  [
    "mbean.attribute.read",
    {
      riskLevel: "R0",
      requiredCapability: "mbeans",
      parameters: z
        .object({
          objectName: mbeanObjectName,
          attribute: z
            .string()
            .min(1)
            .max(512)
            .refine((value) => !/[\r\n]/u.test(value), "属性名不能包含换行符"),
        })
        .strict(),
    },
  ],
  [
    "mbean.operation.preview",
    {
      riskLevel: "R0",
      requiredCapability: "mbeans",
      parameters: mbeanOperationPreviewParameterSchema,
    },
  ],
  [
    "mbean.attribute.write.preview",
    {
      riskLevel: "R0",
      requiredCapability: "mbeans",
      parameters: mbeanAttributeWritePreviewParameterSchema,
    },
  ],
  [
    "mbean.attribute.write",
    {
      riskLevel: "R4",
      requiredCapability: "mbeans",
      parameters: mbeanAttributeWriteParameterSchema,
    },
  ],
  [
    "mbean.operation.invoke",
    {
      riskLevel: "R4",
      requiredCapability: "mbeans",
      parameters: mbeanOperationInvokeParameterSchema,
    },
  ],
  [
    "logger.list",
    {
      riskLevel: "R0",
      requiredCapability: "loggers",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          framework: loggerFramework,
          offset: z.string().regex(/^(?:0|[1-9]\d{0,5})$/u),
          limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/u),
        })
        .strict(),
    },
  ],
  [
    "logger.describe",
    {
      riskLevel: "R0",
      requiredCapability: "loggers",
      parameters: z
        .object({
          framework: z.enum(["JUL", "LOGBACK", "LOG4J", "LOG4J2"]),
          contextId: safeRuntimeName.max(4_096),
          name: safeRuntimeName,
        })
        .strict(),
    },
  ],
  [
    "logger.level.preview",
    {
      riskLevel: "R1",
      requiredCapability: "loggers",
      parameters: z
        .object({
          framework: concreteLoggerFramework,
          contextId: safeRuntimeName.max(4_096),
          name: safeRuntimeName,
          newLevel: loggerLevel,
        })
        .strict()
        .superRefine(validateLoggerLevel),
    },
  ],
  [
    "logger.level.set",
    {
      riskLevel: "R3",
      requiredCapability: "loggers",
      parameters: z
        .object({
          framework: concreteLoggerFramework,
          contextId: safeRuntimeName.max(4_096),
          name: safeRuntimeName,
          newLevel: loggerLevel,
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
        })
        .strict()
        .superRefine(validateLoggerLevel),
    },
  ],
  [
    "thread.locks",
    {
      riskLevel: "R0",
      requiredCapability: "thread-locks",
      parameters: z
        .object({
          includeUncontended: z.enum(["true", "false"]),
          maximumNodes: boundedIntegerString(1, 500),
        })
        .strict(),
    },
  ],
  [
    "thread.pools",
    {
      riskLevel: "R2",
      requiredCapability: "thread-pools",
      parameters: z
        .object({
          limit: boundedIntegerString(3, 20),
          memberLimit: boundedIntegerString(10, 200),
          includeEvidence: z.enum(["true", "false"]),
          queueTaskLimit: boundedIntegerString(10, 200),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "thread.pool.latency.start",
    {
      riskLevel: "R2",
      requiredCapability: "thread-pool-latency",
      parameters: z.discriminatedUnion("poolClassName", [
        z
          .object({
            poolIdentity: z.string().regex(/^ThreadPoolExecutor@[0-9a-f]+$/u),
            poolClassName: z.literal("java.util.concurrent.ThreadPoolExecutor"),
            durationMillis: boundedIntegerString(10_000, 300_000),
            maximumTrackedTasks: boundedIntegerString(128, 4_096),
            confirmed: z.literal("true"),
          })
          .strict(),
        z
          .object({
            poolIdentity: z
              .string()
              .regex(/^ScheduledThreadPoolExecutor@[0-9a-f]+$/u),
            poolClassName: z.literal(
              "java.util.concurrent.ScheduledThreadPoolExecutor",
            ),
            durationMillis: boundedIntegerString(10_000, 300_000),
            maximumTrackedTasks: boundedIntegerString(128, 4_096),
            confirmed: z.literal("true"),
          })
          .strict(),
        z
          .object({
            poolIdentity: z.string().regex(/^ForkJoinPool@[0-9a-f]+$/u),
            poolClassName: z.literal("java.util.concurrent.ForkJoinPool"),
            durationMillis: boundedIntegerString(10_000, 300_000),
            maximumTrackedTasks: boundedIntegerString(128, 4_096),
            confirmed: z.literal("true"),
          })
          .strict(),
      ]),
    },
  ],
  [
    "thread.pool.latency.snapshot",
    {
      riskLevel: "R0",
      requiredCapability: "thread-pool-latency",
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
    },
  ],
  [
    "thread.pool.latency.stop",
    {
      riskLevel: "R2",
      requiredCapability: "thread-pool-latency",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "thread.dump",
    {
      riskLevel: "R1",
      requiredCapability: "thread-dump",
      parameters: z
        .object({
          maximumThreads: boundedIntegerString(1, 10_000),
          maximumStackDepth: boundedIntegerString(1, 512),
          includeLocks: z.enum(["true", "false"]),
        })
        .strict(),
    },
  ],
  [
    "thread.interrupt.preview",
    {
      riskLevel: "R0",
      requiredCapability: "thread-control",
      parameters: z
        .object({
          threadId: z.string().regex(/^[1-9]\d{0,18}$/u),
        })
        .strict(),
    },
  ],
  [
    "thread.interrupt",
    {
      riskLevel: "R4",
      requiredCapability: "thread-control",
      parameters: z
        .object({
          threadId: z.string().regex(/^[1-9]\d{0,18}$/u),
          expectedName: safeRuntimeName,
          confirmed: z.literal("true"),
          confirmedSecondary: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "vm.options",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "vm.option.list",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z
        .object({
          query: z
            .string()
            .max(128)
            .refine(
              (value) => !/[\u0000-\u001f\u007f]/u.test(value),
              "VM Option 查询不能包含控制字符",
            ),
          category: z.enum([
            "ALL",
            "MEMORY",
            "GC",
            "COMPILER",
            "DIAGNOSTIC",
            "LOGGING",
            "OTHER",
          ]),
          mutability: z.enum(["ALL", "WRITEABLE", "READ_ONLY"]),
          offset: boundedIntegerString(0, 10_000),
          limit: boundedIntegerString(1, 200),
        })
        .strict(),
    },
  ],
  [
    "logging.summary",
    {
      riskLevel: "R0",
      requiredCapability: "runtime",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "system.property.set",
    {
      riskLevel: "R3",
      requiredCapability: "runtime-mutation",
      parameters: z
        .object({
          name: safeRuntimeName.regex(/^[A-Za-z0-9_.-]+$/u),
          expectedOldValue: boundedRuntimeValue,
          newValue: boundedRuntimeValue,
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "logging.set",
    {
      riskLevel: "R3",
      requiredCapability: "runtime-mutation",
      parameters: z
        .object({
          name: safeRuntimeName,
          expectedOldValue: boundedRuntimeValue,
          newValue: z.enum([
            "<inherited>",
            "OFF",
            "SEVERE",
            "WARNING",
            "INFO",
            "CONFIG",
            "FINE",
            "FINER",
            "FINEST",
            "ALL",
          ]),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "vm.option.set",
    {
      riskLevel: "R3",
      requiredCapability: "runtime-mutation",
      parameters: z
        .object({
          name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u),
          expectedOldValue: boundedRuntimeValue,
          newValue: z
            .string()
            .max(1_024)
            .refine((value) => !/[\r\n]/u.test(value), "值不能包含换行符"),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "gc.run",
    {
      riskLevel: "R4",
      requiredCapability: "runtime-mutation",
      parameters: z
        .object({
          confirmed: z.literal("true"),
          confirmedSecondary: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "classloaders.summary",
    {
      riskLevel: "R0",
      requiredCapability: "classloaders",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "classloader.metaspace",
    {
      riskLevel: "R1",
      requiredCapability: "classloader-metaspace",
      parameters: z
        .object({
          durationMillis: boundedIntegerString(250, 3_000),
          periodMillis: boundedIntegerString(50, 1_000),
          limit: boundedIntegerString(1, 100),
        })
        .strict()
        .superRefine((value, context) => {
          if (Number(value.periodMillis) > Number(value.durationMillis)) {
            context.addIssue({
              code: "custom",
              message: "采样周期不能超过采样时长",
              path: ["periodMillis"],
            });
          }
        }),
    },
  ],
  [
    "tasks.list",
    {
      riskLevel: "R0",
      requiredCapability: "tasks",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "tasks.cancel",
    {
      riskLevel: "R1",
      requiredCapability: "tasks",
      parameters: z
        .object({
          kind: z.enum([
            "OBSERVATION",
            "LINE",
            "MONITOR",
            "TRACE",
            "THREAD_POOL_LATENCY",
            "PROFILE",
            "JFR",
          ]),
          taskId: z.string().uuid(),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "session.reset.preview",
    {
      riskLevel: "R0",
      requiredCapability: "tasks",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "session.reset",
    {
      riskLevel: "R4",
      requiredCapability: "tasks",
      parameters: z
        .object({
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
          confirmedSecondary: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "retransform.status",
    {
      riskLevel: "R0",
      requiredCapability: "retransform",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "retransform.retry",
    {
      riskLevel: "R2",
      requiredCapability: "retransform",
      parameters: z
        .object({
          ownerId: z
            .string()
            .min(3)
            .max(128)
            .regex(/^[A-Z_]+:[0-9a-f-]{36}$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "arthas.compatibility",
    {
      riskLevel: "R0",
      requiredCapability: "arthas-ecosystem",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "arthas.resolve",
    {
      riskLevel: "R0",
      requiredCapability: "arthas-ecosystem",
      parameters: z
        .object({
          command: z
            .string()
            .min(1)
            .max(32)
            .regex(/^[a-z][a-z0-9/-]*$/u),
        })
        .strict(),
    },
  ],
  [
    "trace.preview",
    {
      riskLevel: "R0",
      requiredCapability: "trace",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          scopePrefix: traceScopePrefix,
          includeRules: tracePathRules,
          excludeRules: tracePathRules,
        })
        .strict()
        .superRefine(validateTraceFilterScopes),
    },
  ],
  [
    "trace.start",
    {
      riskLevel: "R2",
      requiredCapability: "trace",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          scopePrefix: traceScopePrefix,
          includeRules: tracePathRules,
          excludeRules: tracePathRules,
          maximumTraces: boundedIntegerString(1, 20),
          maximumDepth: boundedIntegerString(1, 32),
          maximumSpans: boundedIntegerString(16, 512),
          minimumDurationMillis: boundedIntegerString(0, 60_000),
          timeoutMillis: boundedIntegerString(1_000, 60_000),
          confirmed: z.literal("true"),
        })
        .strict()
        .superRefine(validateTraceFilterScopes),
    },
  ],
  [
    "trace.events",
    {
      riskLevel: "R0",
      requiredCapability: "trace",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          limit: boundedIntegerString(1, 5),
        })
        .strict(),
    },
  ],
  [
    "trace.threshold.update",
    {
      riskLevel: "R1",
      requiredCapability: "trace",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          minimumDurationMillis: boundedIntegerString(0, 60_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "monitor.preview",
    {
      riskLevel: "R0",
      requiredCapability: "monitor",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
        })
        .strict(),
    },
  ],
  [
    "monitor.start",
    {
      riskLevel: "R1",
      requiredCapability: "monitor",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          intervalMillis: boundedIntegerString(1_000, 60_000),
          durationMillis: boundedIntegerString(10_000, 28_800_000),
          minimumDurationMillis: boundedIntegerString(0, 60_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "monitor.threshold.update",
    {
      riskLevel: "R1",
      requiredCapability: "monitor",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          minimumDurationMillis: boundedIntegerString(0, 60_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "monitor.windows",
    {
      riskLevel: "R0",
      requiredCapability: "monitor",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          afterSequence: boundedIntegerString(0, 1_000_000_000),
          limit: boundedIntegerString(1, 100),
        })
        .strict(),
    },
  ],
  [
    "profile.start",
    {
      riskLevel: "R1",
      requiredCapability: "profiler",
      parameters: z
        .object({
          event: z.enum(["CPU", "WALL", "ALLOCATION", "LOCK"]),
          intervalMillis: z
            .string()
            .regex(/^(?:1\d|[2-9]\d|[1-9]\d{2}|1000)$/u),
          durationMillis: z
            .string()
            .regex(/^(?:[1-9]\d{3}|[1-5]\d{4}|60000)$/u),
          stackDepth: boundedIntegerString(16, 2_048),
          threads: z.enum(["true", "false"]),
          includeRules: profilerRules,
          excludeRules: profilerRules,
        })
        .strict(),
    },
  ],
  [
    "profile.status",
    {
      riskLevel: "R0",
      requiredCapability: "profiler",
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
    },
  ],
  [
    "profile.stop",
    {
      riskLevel: "R1",
      requiredCapability: "profiler",
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
    },
  ],
  [
    "profile.dump",
    {
      riskLevel: "R1",
      requiredCapability: "profiler",
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
    },
  ],
  [
    "jfr.status",
    {
      riskLevel: "R0",
      requiredCapability: "jfr",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "jfr.start",
    {
      riskLevel: "R1",
      requiredCapability: "jfr",
      parameters: z
        .object({
          configuration: z.enum(["PROFILE", "DEFAULT"]),
          maxAgeMillis: boundedIntegerString(0, 86_400_000),
          maxSizeBytes: boundedIntegerString(0, 10_737_418_240),
          recordingName: jfrRecordingName.optional(),
        })
        .strict(),
    },
  ],
  [
    "jfr.dump",
    {
      riskLevel: "R1",
      requiredCapability: "jfr",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "jfr.stop",
    {
      riskLevel: "R1",
      requiredCapability: "jfr",
      parameters: z.object({}).strict(),
    },
  ],
  [
    "heap.dump",
    {
      riskLevel: "R2",
      requiredCapability: "heap-dump",
      parameters: z
        .object({
          confirmed: z.literal("true"),
          live: z.enum(["true", "false"]),
        })
        .strict(),
    },
  ],
  [
    "heap.instances",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          name: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          limit: z.string().regex(/^(?:[1-9]|1\d|20)$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.histogram",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          limit: boundedIntegerString(1, 200),
          scanLimit: boundedIntegerString(10_000, 5_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.retained.classes",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          limit: boundedIntegerString(1, 200),
          maximumNodes: boundedIntegerString(10_000, 500_000),
          maximumEdges: boundedIntegerString(10_000, 2_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.dominator.tree",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          maximumDepth: boundedIntegerString(1, 8),
          maximumViewNodes: boundedIntegerString(10, 200),
          rootLimit: boundedIntegerString(1, 20),
          branchLimit: boundedIntegerString(1, 20),
          maximumNodes: boundedIntegerString(10_000, 500_000),
          maximumEdges: boundedIntegerString(10_000, 2_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.relations",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          objectHandle: z.string().uuid(),
          direction: z.enum(["OUTGOING", "INCOMING"]),
          limit: z.string().regex(/^(?:[1-9]|[1-4]\d|50)$/u),
          scanLimit: z.string().regex(/^(?:[1-9]\d{3,5}|1000000)$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.object.graph",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          objectHandle: z.string().uuid(),
          direction: z.enum(["OUTGOING", "INCOMING"]),
          maximumDepth: boundedIntegerString(1, 5),
          maximumNodes: boundedIntegerString(2, 80),
          maximumEdgesPerNode: boundedIntegerString(1, 8),
          scanLimit: boundedIntegerString(1_000, 1_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.root.path",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          objectHandle: z.string().uuid(),
          maximumDepth: z.string().regex(/^(?:[1-9]|[12]\d|3[0-2])$/u),
          maximumNodes: z.string().regex(/^(?:[1-9]\d{3,4}|100000)$/u),
          maximumEdges: z.string().regex(/^(?:[1-9]\d{3,5}|1000000)$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.root.paths",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          objectHandle: z.string().uuid(),
          maximumPaths: boundedIntegerString(1, 8),
          maximumDepth: boundedIntegerString(1, 32),
          maximumNodes: boundedIntegerString(1_000, 100_000),
          maximumEdges: boundedIntegerString(1_000, 1_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.retained",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          objectHandle: z.string().uuid(),
          maximumNodes: boundedIntegerString(1_000, 100_000),
          maximumEdges: boundedIntegerString(1_000, 1_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "heap.retained.ranking",
    {
      riskLevel: "R2",
      requiredCapability: "heap-instances",
      parameters: z
        .object({
          name: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          instanceLimit: boundedIntegerString(1, 20),
          maximumNodes: boundedIntegerString(10_000, 500_000),
          maximumEdges: boundedIntegerString(10_000, 2_000_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "class.static.fields",
    {
      riskLevel: "R0",
      requiredCapability: "static-fields",
      parameters: z.object(classIdentityParameters).strict(),
    },
  ],
  [
    "classloader.resources",
    {
      riskLevel: "R1",
      requiredCapability: "classloaders",
      parameters: z
        .object({
          ...classIdentityParameters,
          resourceName: classLoaderResourceName,
        })
        .strict(),
    },
  ],
  [
    "class.static.read.preview",
    {
      riskLevel: "R0",
      requiredCapability: "static-fields",
      parameters: z.object(staticFieldIdentityParameters).strict(),
    },
  ],
  [
    "class.static.read",
    {
      riskLevel: "R3",
      requiredCapability: "static-fields",
      parameters: z
        .object({
          ...staticFieldIdentityParameters,
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "class.dump",
    {
      riskLevel: "R2",
      requiredCapability: "class-dump",
      parameters: z
        .object({
          name: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "class.redefine.preview",
    {
      riskLevel: "R2",
      requiredCapability: "class-redefine",
      parameters: z
        .object({
          ...classIdentityParameters,
          bytecodeBase64: compiledClassPayload,
        })
        .strict(),
    },
  ],
  [
    "class.redefine",
    {
      riskLevel: "R3",
      requiredCapability: "class-redefine",
      parameters: z
        .object({
          ...classIdentityParameters,
          bytecodeBase64: compiledClassPayload,
          expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "class.redefine.restore",
    {
      riskLevel: "R3",
      requiredCapability: "class-redefine",
      parameters: z
        .object({
          rollbackToken: z.string().uuid(),
          expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "class.change-set.preview",
    {
      riskLevel: "R2",
      requiredCapability: "class-redefine",
      parameters: classChangeSetPreviewParameterSchema,
    },
  ],
  [
    "class.change-set.apply",
    {
      riskLevel: "R3",
      requiredCapability: "class-redefine",
      parameters: classChangeSetApplyParameterSchema,
    },
  ],
  [
    "class.change-set.restore",
    {
      riskLevel: "R3",
      requiredCapability: "class-redefine",
      parameters: z
        .object({
          rollbackToken: z.string().uuid(),
          expectedCurrentFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "observe.preview",
    {
      riskLevel: "R0",
      requiredCapability: "observe",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
        })
        .strict(),
    },
  ],
  [
    "line.preview",
    {
      riskLevel: "R0",
      requiredCapability: "line-probe",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          lineNumber: boundedIntegerString(1, 1_000_000),
        })
        .strict(),
    },
  ],
  [
    "line.start",
    {
      riskLevel: "R2",
      requiredCapability: "line-probe",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          lineNumber: boundedIntegerString(1, 1_000_000),
          maximumEvents: boundedIntegerString(1, 100),
          timeoutMillis: boundedIntegerString(1_000, 60_000),
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "line.events",
    {
      riskLevel: "R0",
      requiredCapability: "line-probe",
      parameters: z
        .object({
          taskId: z.string().uuid(),
          limit: boundedIntegerString(1, 100),
        })
        .strict(),
    },
  ],
  [
    "snapshot.list",
    {
      riskLevel: "R0",
      requiredCapability: "snapshots",
      parameters: z
        .object({
          query: z
            .string()
            .max(256)
            .refine((value) => !/[\r\n]/u.test(value), "查询不能包含换行符"),
          outcome: z.enum(["ALL", "RETURNED", "THREW"]),
          scope: z.enum(["ROOT", "ALL"]),
          taskId: z
            .string()
            .max(128)
            .refine((value) => !/[\r\n]/u.test(value), "任务 ID 不能包含换行符")
            .optional(),
          threadQuery: z
            .string()
            .max(128)
            .refine((value) => !/[\r\n]/u.test(value), "线程筛选不能包含换行符")
            .optional(),
          replay: z
            .enum(["ALL", "REPLAYABLE", "STATIC", "INSTANCE", "UNAVAILABLE"])
            .optional(),
          minimumDurationMillis: boundedIntegerString(0, 3_600_000).optional(),
          maximumDurationMillis: boundedIntegerString(0, 3_600_000).optional(),
          offset: boundedIntegerString(0, 1_000),
          limit: boundedIntegerString(1, 100),
        })
        .strict()
        .superRefine((value, context) => {
          const minimum = Number(value.minimumDurationMillis ?? "0");
          const maximum = Number(value.maximumDurationMillis ?? "0");
          if (maximum > 0 && maximum < minimum) {
            context.addIssue({
              code: "custom",
              message: "最大耗时必须为 0 或不小于最小耗时",
            });
          }
        }),
    },
  ],
  [
    "snapshot.describe",
    {
      riskLevel: "R0",
      requiredCapability: "snapshots",
      parameters: z
        .object({
          snapshotId: boundedIntegerString(1, 1_000_000_000),
        })
        .strict(),
    },
  ],
  [
    "snapshot.delete",
    {
      riskLevel: "R1",
      requiredCapability: "snapshots",
      parameters: z
        .object({
          snapshotId: boundedIntegerString(1, 1_000_000_000),
        })
        .strict(),
    },
  ],
  [
    "observe.start",
    {
      riskLevel: "R2",
      requiredCapability: "observe",
      parameters: z
        .object({
          className: z.string().min(1).max(1_024),
          classLoader: z.string().min(1).max(4_096),
          methodName: z.string().min(1).max(512),
          parameterTypes: z.string().max(4_096),
          maximumEvents: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/u),
          timeoutMillis: z.string().regex(/^(?:[1-9]\d{3}|[1-5]\d{4}|60000)$/u),
          includeInternal: z.enum(["true", "false"]),
          condition: z
            .string()
            .max(512)
            .refine(isObservationConditionValid, "不支持的观测条件表达式"),
          phases: watchPhases,
          confirmed: z.literal("true"),
        })
        .strict(),
    },
  ],
  [
    "invoke.replay.preview",
    {
      riskLevel: "R0",
      requiredCapability: "invoke-replay",
      parameters: replayPreviewParameterSchema,
    },
  ],
  [
    "invoke.replay",
    {
      riskLevel: "R4",
      requiredCapability: "invoke-replay",
      parameters: replayExecuteParameterSchema,
    },
  ],
]);

export class PolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function listActionContractDescriptors(): readonly ActionContractDescriptor[] {
  return [...ACTION_CONTRACT_CATALOG.entries()]
    .map(([actionId, contract]) => ({
      actionId,
      contractVersion: "1.0" as const,
      riskLevel: contract.riskLevel,
      requiredCapability: contract.requiredCapability,
    }))
    .sort((left, right) => left.actionId.localeCompare(right.actionId));
}

export interface AuthorizedAction {
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly riskLevel: RiskLevel;
}

export function validateDiagnosticTemplateAction(
  actionId: string,
  parameters: Readonly<Record<string, string>>,
): {
  readonly actionId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly riskLevel: "R0" | "R1";
} {
  const policy = ACTION_CONTRACT_CATALOG.get(actionId);
  if (!policy) {
    throw new PolicyError(
      "ACTION_NOT_ALLOWED",
      `主进程策略不允许 Action：${actionId}`,
    );
  }
  if (policy.riskLevel !== "R0" && policy.riskLevel !== "R1") {
    throw new PolicyError(
      "TEMPLATE_RISK_NOT_ALLOWED",
      "诊断模板只允许保存 R0/R1 Action；高风险操作必须逐次预检和确认",
    );
  }
  const parsed = policy.parameters.safeParse(parameters);
  if (!parsed.success) {
    throw new PolicyError(
      "INVALID_ACTION_PARAMETERS",
      "诊断模板参数不符合 Action Schema",
    );
  }
  return {
    actionId,
    parameters: parsed.data,
    riskLevel: policy.riskLevel,
  };
}

export function stricterRiskLevel(
  localMaximum: RiskLevel,
  teamMaximum: RiskLevel,
): RiskLevel {
  return RISK_ORDER[localMaximum] <= RISK_ORDER[teamMaximum]
    ? localMaximum
    : teamMaximum;
}

export function enforceTeamPolicy(
  actionId: string,
  localMaximum: RiskLevel,
  teamPolicy: TeamPolicyDescriptor | null,
  now = Date.now(),
): RiskLevel {
  if (!teamPolicy) {
    return localMaximum;
  }
  if (
    !verifyTeamPolicy(teamPolicy) ||
    publicKeyFingerprint(teamPolicy.publicKey) !==
      teamPolicy.publicKeyFingerprint
  ) {
    throw new PolicyError(
      "TEAM_POLICY_INVALID",
      "已启用的团队策略签名无效，所有 Action 已安全阻断",
    );
  }
  if (teamPolicy.expiresAt && Date.parse(teamPolicy.expiresAt) <= now) {
    throw new PolicyError(
      "TEAM_POLICY_EXPIRED",
      "已启用的团队策略已过期，所有 Action 已安全阻断",
    );
  }
  if (teamPolicy.deniedActions.includes(actionId)) {
    throw new PolicyError(
      "ACTION_DISABLED_BY_TEAM_POLICY",
      `团队策略已禁用 Action：${actionId}`,
    );
  }
  return stricterRiskLevel(localMaximum, teamPolicy.maximumRiskLevel);
}

export function authorizeAction(
  connection: TargetConnection | null,
  actionId: string,
  parameters: Readonly<Record<string, string>>,
  maximumRiskLevel: RiskLevel = "R4",
  contractVersion = "1.0",
): AuthorizedAction {
  if (!connection || connection.state !== "READY") {
    throw new PolicyError("TARGET_NOT_CONNECTED", "目标 JVM 尚未建立可用连接");
  }

  if (contractVersion !== "1.0") {
    throw new PolicyError(
      "ACTION_CONTRACT_VERSION_UNSUPPORTED",
      `不支持 Action Contract 版本：${contractVersion}`,
    );
  }

  const policy = ACTION_CONTRACT_CATALOG.get(actionId);
  if (!policy) {
    throw new PolicyError(
      "ACTION_NOT_ALLOWED",
      `主进程策略不允许 Action：${actionId}`,
    );
  }

  const capability = connection.capabilities.find(
    (item) => item.id === policy.requiredCapability,
  );
  if (!capability || capability.state !== "AVAILABLE") {
    throw new PolicyError(
      "CAPABILITY_UNAVAILABLE",
      capability?.reason ?? `目标不支持能力：${policy.requiredCapability}`,
    );
  }

  if (RISK_ORDER[policy.riskLevel] > RISK_ORDER[maximumRiskLevel]) {
    throw new PolicyError(
      "ACTION_DISABLED_BY_POLICY",
      `本机策略仅允许 ${maximumRiskLevel} 及以下操作，已阻止 ${policy.riskLevel} Action`,
    );
  }

  const parsed = policy.parameters.safeParse(parameters);
  if (!parsed.success) {
    throw new PolicyError(
      "INVALID_ACTION_PARAMETERS",
      "Action 参数不符合策略 Schema",
    );
  }

  return {
    actionId,
    parameters: parsed.data,
    riskLevel: policy.riskLevel,
  };
}

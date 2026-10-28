import type { RiskLevel, TeamPolicyDescriptor, TargetConnection } from "../../src/shared/contracts.js";
import { ACTION_CONTRACT_CATALOG, type ActionContractDescriptor } from "../../src/shared/action-catalog.js";
import { publicKeyFingerprint, verifyTeamPolicy } from "./governance-signatures.js";
const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

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

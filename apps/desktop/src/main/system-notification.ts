import type {
  DiagnosticAlertDescriptor,
  SystemNotificationPolicy,
} from "../shared/contracts.js";

export interface SystemNotificationWindowState {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly minimized: boolean;
}

export interface SystemNotificationContent {
  readonly title: string;
  readonly body: string;
}

export interface SystemNotificationGateway {
  isSupported(): boolean;
  show(content: SystemNotificationContent, onClick: () => void): void;
}

export type SystemNotificationDelivery =
  | "DELIVERED"
  | "DUPLICATE"
  | "ACKNOWLEDGED"
  | "NO_EVIDENCE"
  | "DISABLED"
  | "BELOW_THRESHOLD"
  | "FOREGROUND"
  | "UNSUPPORTED"
  | "FAILED";

interface DeliverSystemNotificationInput {
  readonly alert: DiagnosticAlertDescriptor;
  readonly policy: SystemNotificationPolicy;
  readonly locale: "zh-CN" | "en-US";
  readonly window: SystemNotificationWindowState;
  readonly gateway: SystemNotificationGateway;
  readonly onClick: (alert: DiagnosticAlertDescriptor) => void;
}

const MAXIMUM_PROCESSED_ALERTS = 256;

export class SystemNotificationCoordinator {
  readonly #processedIds = new Set<string>();
  readonly #processedOrder: string[] = [];

  deliver(input: DeliverSystemNotificationInput): SystemNotificationDelivery {
    const { alert } = input;
    if (this.#processedIds.has(alert.id)) {
      return "DUPLICATE";
    }
    this.#remember(alert.id);
    if (alert.acknowledgedAt) {
      return "ACKNOWLEDGED";
    }
    if (!alert.artifactId) {
      return "NO_EVIDENCE";
    }
    if (input.policy === "OFF") {
      return "DISABLED";
    }
    if (
      alert.severity === "INFO" ||
      (alert.severity === "WARNING" && input.policy === "CRITICAL_ONLY")
    ) {
      return "BELOW_THRESHOLD";
    }
    if (
      input.window.visible &&
      input.window.focused &&
      !input.window.minimized
    ) {
      return "FOREGROUND";
    }
    if (!input.gateway.isSupported()) {
      return "UNSUPPORTED";
    }
    try {
      input.gateway.show(notificationContent(alert, input.locale), () =>
        input.onClick(alert),
      );
      return "DELIVERED";
    } catch {
      return "FAILED";
    }
  }

  #remember(alertId: string): void {
    this.#processedIds.add(alertId);
    this.#processedOrder.push(alertId);
    if (this.#processedOrder.length <= MAXIMUM_PROCESSED_ALERTS) {
      return;
    }
    const expired = this.#processedOrder.shift();
    if (expired) {
      this.#processedIds.delete(expired);
    }
  }
}

export function notificationContent(
  alert: DiagnosticAlertDescriptor,
  locale: "zh-CN" | "en-US",
): SystemNotificationContent {
  const isEnglish = locale === "en-US";
  const title = isEnglish ? englishTitle(alert) : chineseTitle(alert);
  const capacity = isEnglish
    ? alert.codeCacheCapacityKind === "MAX"
      ? "maximum capacity"
      : "committed capacity"
    : alert.codeCacheCapacityKind === "MAX"
      ? "最大容量"
      : "已提交容量";
  return {
    title,
    body: isEnglish
      ? `Window peak ${alert.codeCachePercent.toFixed(1)}% of ${capacity}. Click to inspect verified evidence.`
      : `窗口峰值 ${alert.codeCachePercent.toFixed(1)}% · 按${capacity}判断。点击检查校验证据。`,
  };
}

function chineseTitle(alert: DiagnosticAlertDescriptor): string {
  switch (alert.codeCachePressure) {
    case "EXHAUSTED":
      return alert.codeCacheCapacityKind === "MAX"
        ? "探微：Code Cache 最大容量已耗尽"
        : "探微：Code Cache 已提交容量已用尽";
    case "HIGH":
      return "探微：Code Cache 进入高压力";
    case "ELEVATED":
      return "探微：Code Cache 压力升高";
    case "NORMAL":
    default:
      return "探微：JIT 基线已保存";
  }
}

function englishTitle(alert: DiagnosticAlertDescriptor): string {
  switch (alert.codeCachePressure) {
    case "EXHAUSTED":
      return alert.codeCacheCapacityKind === "MAX"
        ? "Tanwei: Code Cache maximum exhausted"
        : "Tanwei: committed Code Cache consumed";
    case "HIGH":
      return "Tanwei: high Code Cache pressure";
    case "ELEVATED":
      return "Tanwei: elevated Code Cache pressure";
    case "NORMAL":
    default:
      return "Tanwei: JIT baseline saved";
  }
}

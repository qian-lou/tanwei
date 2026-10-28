import { describe, expect, it, vi } from "vitest";
import type {
  DiagnosticAlertDescriptor,
  SystemNotificationPolicy,
} from "../../src/shared/contracts.js";
import {
  notificationContent,
  SystemNotificationCoordinator,
  type SystemNotificationGateway,
  type SystemNotificationWindowState,
} from "./system-notification.js";

function alert(
  overrides: Partial<DiagnosticAlertDescriptor> = {},
): DiagnosticAlertDescriptor {
  return {
    id: "1f688754-7ed0-470c-9e06-a8489a017fb7",
    targetId: "local:42",
    kind: "CODE_CACHE_PRESSURE",
    severity: "CRITICAL",
    artifactId: "14597732-e85b-4ddb-bb85-0b23fb2a1433",
    codeCachePercent: 92.25,
    codeCachePressure: "HIGH",
    codeCacheCapacityKind: "MAX",
    createdAt: "2026-07-31T20:00:00.000Z",
    acknowledgedAt: null,
    ...overrides,
  };
}

function harness(options?: {
  readonly policy?: SystemNotificationPolicy;
  readonly window?: Partial<SystemNotificationWindowState>;
  readonly supported?: boolean;
}) {
  const clickHandlers: (() => void)[] = [];
  const show = vi.fn((_, onClick: () => void) => clickHandlers.push(onClick));
  const gateway: SystemNotificationGateway = {
    isSupported: () => options?.supported ?? true,
    show,
  };
  const onClick = vi.fn();
  const input = {
    policy: options?.policy ?? ("CRITICAL_ONLY" as const),
    locale: "zh-CN" as const,
    window: {
      visible: false,
      focused: false,
      minimized: false,
      ...options?.window,
    },
    gateway,
    onClick,
  };
  return { clickHandlers, input, onClick, show };
}

describe("system diagnostic notifications", () => {
  it("delivers one critical background notification and routes its click", () => {
    const coordinator = new SystemNotificationCoordinator();
    const { clickHandlers, input, onClick, show } = harness();
    const event = alert();

    expect(coordinator.deliver({ ...input, alert: event })).toBe("DELIVERED");
    expect(show).toHaveBeenCalledWith(
      {
        title: "探微：Code Cache 进入高压力",
        body: "窗口峰值 92.3% · 按最大容量判断。点击检查校验证据。",
      },
      expect.any(Function),
    );
    clickHandlers[0]?.();
    expect(onClick).toHaveBeenCalledWith(event);
    expect(coordinator.deliver({ ...input, alert: event })).toBe("DUPLICATE");
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("keeps foreground, informational, acknowledged and disabled events quiet", () => {
    const foreground = harness({
      window: { visible: true, focused: true },
    });
    expect(
      new SystemNotificationCoordinator().deliver({
        ...foreground.input,
        alert: alert(),
      }),
    ).toBe("FOREGROUND");

    const quiet = harness();
    expect(
      new SystemNotificationCoordinator().deliver({
        ...quiet.input,
        alert: alert({ severity: "INFO", codeCachePressure: "NORMAL" }),
      }),
    ).toBe("BELOW_THRESHOLD");
    expect(
      new SystemNotificationCoordinator().deliver({
        ...quiet.input,
        alert: alert({ acknowledgedAt: "2026-07-31T20:01:00.000Z" }),
      }),
    ).toBe("ACKNOWLEDGED");
    expect(
      new SystemNotificationCoordinator().deliver({
        ...quiet.input,
        policy: "OFF",
        alert: alert(),
      }),
    ).toBe("DISABLED");
    expect(quiet.show).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in for warning events and fails closed without evidence", () => {
    const warning = alert({
      severity: "WARNING",
      codeCachePressure: "ELEVATED",
      codeCachePercent: 82,
    });
    const defaultPolicy = harness();
    expect(
      new SystemNotificationCoordinator().deliver({
        ...defaultPolicy.input,
        alert: warning,
      }),
    ).toBe("BELOW_THRESHOLD");

    const expandedPolicy = harness({ policy: "WARNING_AND_CRITICAL" });
    expect(
      new SystemNotificationCoordinator().deliver({
        ...expandedPolicy.input,
        alert: warning,
      }),
    ).toBe("DELIVERED");
    expect(expandedPolicy.show).toHaveBeenCalledTimes(1);

    const missingEvidence = harness({ policy: "WARNING_AND_CRITICAL" });
    expect(
      new SystemNotificationCoordinator().deliver({
        ...missingEvidence.input,
        alert: warning,
      }),
    ).toBe("DELIVERED");
    expect(
      new SystemNotificationCoordinator().deliver({
        ...missingEvidence.input,
        alert: alert({
          id: "060d155f-3d5a-43bf-9471-e505dbfd553d",
          artifactId: null,
        }),
      }),
    ).toBe("NO_EVIDENCE");
  });

  it("formats English content without exposing target identifiers", () => {
    const content = notificationContent(
      alert({
        codeCachePressure: "EXHAUSTED",
        codeCachePercent: 100,
        codeCacheCapacityKind: "COMMITTED",
      }),
      "en-US",
    );
    expect(content).toEqual({
      title: "Tanwei: committed Code Cache consumed",
      body: "Window peak 100.0% of committed capacity. Click to inspect verified evidence.",
    });
    expect(JSON.stringify(content)).not.toContain("local:42");
  });
});

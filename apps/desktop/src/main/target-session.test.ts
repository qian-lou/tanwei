import { describe, expect, it, vi } from "vitest";
import type {
  TargetConnection,
  TargetDescriptor,
} from "../shared/contracts.js";
import {
  TargetSessionCancelledError,
  TargetSessionRegistry,
  type TargetSessionResource,
} from "./target-session.js";

const target: TargetDescriptor = {
  id: "local:42",
  pid: 42,
  displayName: "test-target",
  mainClass: "example.Main",
  arguments: [],
  javaPath: null,
  javaVersion: "21",
  user: null,
  startTime: null,
  attachable: true,
  attachReason: null,
};

function readyConnection(): TargetConnection {
  return {
    target,
    state: "READY",
    protocolVersion: "1.0",
    agentVersion: "0.1.0",
    javaVersion: "21",
    capabilities: [],
    connectedAt: "2026-08-01T00:00:00.000Z",
    errorCode: null,
    errorMessage: null,
  };
}

describe("target session registry", () => {
  it("disconnects a pending connection without allowing it to revive", async () => {
    let resolveConnector:
      | ((resource: TargetSessionResource) => void)
      | undefined;
    const close = vi.fn(async () => undefined);
    const registry = new TargetSessionRegistry();
    const connecting = registry.connect(
      target,
      () =>
        new Promise<TargetSessionResource>((resolve) => {
          resolveConnector = resolve;
        }),
    );

    expect(registry.connection(target.id)?.state).toBe("CONNECTING");
    await Promise.resolve();
    const disconnecting = registry.disconnect(target.id);
    resolveConnector?.({ connection: readyConnection(), close });

    await expect(connecting).rejects.toBeInstanceOf(
      TargetSessionCancelledError,
    );
    await disconnecting;

    expect(registry.connection(target.id)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closeAll cancels every pending connection", async () => {
    const registry = new TargetSessionRegistry();
    const secondTarget: TargetDescriptor = {
      ...target,
      id: "local:43",
      pid: 43,
    };
    const connector = (signal: AbortSignal) =>
      new Promise<TargetSessionResource>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    const first = registry.connect(target, connector);
    const second = registry.connect(secondTarget, connector);
    await Promise.resolve();

    await registry.closeAll();

    await expect(first).rejects.toBeInstanceOf(TargetSessionCancelledError);
    await expect(second).rejects.toBeInstanceOf(TargetSessionCancelledError);
    expect(registry.listConnections()).toEqual([]);
  });

  it("rejects state updates from a stale session resource", async () => {
    const registry = new TargetSessionRegistry();
    const firstResource: TargetSessionResource = {
      connection: readyConnection(),
      close: async () => undefined,
    };
    await registry.connect(target, async () => firstResource);
    await registry.disconnect(target.id);
    const currentResource: TargetSessionResource = {
      connection: readyConnection(),
      close: async () => undefined,
    };
    await registry.connect(target, async () => currentResource);

    const updated = registry.updateConnection(target.id, firstResource, {
      ...readyConnection(),
      state: "DEGRADED",
    });

    expect(updated).toBe(false);
    expect(registry.connection(target.id)?.state).toBe("READY");
  });

  it("disconnects only the current session resource", async () => {
    const registry = new TargetSessionRegistry();
    const staleResource: TargetSessionResource = {
      connection: readyConnection(),
      close: async () => undefined,
    };
    const close = vi.fn(async () => undefined);
    const currentResource: TargetSessionResource = {
      connection: readyConnection(),
      close,
    };
    await registry.connect(target, async () => currentResource);

    expect(
      await registry.disconnectResource(target.id, staleResource),
    ).toBe(false);
    expect(registry.connection(target.id)?.state).toBe("READY");
    expect(
      await registry.disconnectResource(target.id, currentResource),
    ).toBe(true);
    expect(registry.connection(target.id)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains a disconnected snapshot after a current resource fails", async () => {
    const registry = new TargetSessionRegistry();
    const close = vi.fn(async () => undefined);
    const resource: TargetSessionResource = {
      connection: readyConnection(),
      close,
    };
    await registry.connect(target, async () => resource);
    const disconnected: TargetConnection = {
      ...readyConnection(),
      state: "DISCONNECTED",
      errorCode: "AGENT_HEARTBEAT_FAILED",
      errorMessage: "target unavailable",
    };

    expect(
      await registry.deactivateResource(target.id, resource, disconnected),
    ).toBe(true);

    expect(registry.connection(target.id)).toEqual(disconnected);
    expect(registry.resource(target.id)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});

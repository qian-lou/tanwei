import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OperationResult,
  TargetConnection,
  TargetDescriptor,
} from "@shared/contracts";
import App from "./App";
import { useTargetsStore } from "./stores/targets";

vi.mock("./components/DiagnosticAlertCenter", () => ({ default: () => null }));
vi.mock("./components/CapabilityPalette", () => ({ default: () => null }));
vi.mock("./components/ExitGuardDialog", () => ({ default: () => null }));

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

const ready: TargetConnection = {
  target,
  state: "READY",
  protocolVersion: "1.0",
  agentVersion: "0.1.0",
  javaVersion: "21",
  capabilities: [],
  connectedAt: "2026-09-12T00:00:00.000Z",
  errorCode: null,
  errorMessage: null,
};

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value, errorCode: null, errorMessage: null };
}

describe("App target connection status", () => {
  let hostConnections: readonly TargetConnection[];
  let listTargets: ReturnType<typeof vi.fn>;
  let listConnections: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useTargetsStore.setState(useTargetsStore.getInitialState(), true);
    hostConnections = [ready];
    listTargets = vi.fn(async () => success([target]));
    listConnections = vi.fn(async () => success(structuredClone(hostConnections)));
    vi.stubGlobal("tanwei", {
      listTargets,
      listConnections,
      getRuntimeInfo: async () => ({ platform: "darwin" }),
      getSettings: async () => success(null),
      onAppExitRequested: () => () => undefined,
      onOpenDiagnosticEvidence: () => () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mountApp() {
    const router = createMemoryRouter(
      [{ path: "*", element: <App /> }],
      { initialEntries: ["/overview"] },
    );
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<RouterProvider router={router} />);
    });
    expect(screen.getByText("PID 42 · 已连接")).toBeTruthy();
    return result!;
  }

  it("updates the connected badge when the host detects JVM exit without manual refresh", async () => {
    await mountApp();
    hostConnections = [
      {
        ...ready,
        state: "DISCONNECTED",
        errorCode: "AGENT_HEARTBEAT_FAILED",
        errorMessage: "target unavailable",
      },
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.queryByText("PID 42 · 已连接")).toBeNull();
    expect(screen.getByText("PID 42 · 未连接")).toBeTruthy();
    expect(useTargetsStore.getState().connections[target.id]?.state).toBe(
      "DISCONNECTED",
    );
    expect(listTargets).toHaveBeenCalledOnce();
  });

  it("reflects heartbeat degradation and recovery on any page", async () => {
    await mountApp();
    hostConnections = [{ ...ready, state: "DEGRADED" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("PID 42 · 未连接")).toBeTruthy();

    hostConnections = [ready];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("PID 42 · 已连接")).toBeTruthy();
  });

  it("keeps unchanged snapshots stable without repeating JVM discovery", async () => {
    await mountApp();
    const previous = useTargetsStore.getState().connections;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(useTargetsStore.getState().connections).toBe(previous);
    expect(listTargets).toHaveBeenCalledOnce();
  });

  it("keeps only one status request in flight and discards its result after unmount", async () => {
    const app = await mountApp();
    const previous = useTargetsStore.getState().connections;
    let finishRequest:
      | ((value: OperationResult<readonly TargetConnection[]>) => void)
      | undefined;
    listConnections.mockClear().mockReturnValueOnce(
      new Promise<OperationResult<readonly TargetConnection[]>>((resolve) => {
        finishRequest = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listConnections).toHaveBeenCalledOnce();

    app.unmount();
    await act(async () => {
      finishRequest?.(success([{ ...ready, state: "DISCONNECTED" }]));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listConnections).toHaveBeenCalledOnce();
    expect(useTargetsStore.getState().connections).toBe(previous);
  });

  it("retries after an IPC failure without dropping the last valid snapshot", async () => {
    await mountApp();
    listConnections.mockRejectedValueOnce(
      new Error("IPC temporarily unavailable"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("PID 42 · 已连接")).toBeTruthy();

    hostConnections = [{ ...ready, state: "DISCONNECTED" }];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText("PID 42 · 未连接")).toBeTruthy();
  });
});

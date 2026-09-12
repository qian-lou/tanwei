import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OperationResult,
  TargetConnection,
  TargetDescriptor,
} from "@shared/contracts";
import { useTargetsStore } from "./targets";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("target connection synchronization", () => {
  const listConnections =
    vi.fn<() => Promise<OperationResult<readonly TargetConnection[]>>>();
  const listTargets =
    vi.fn<() => Promise<OperationResult<readonly TargetDescriptor[]>>>();
  const connectTarget =
    vi.fn<() => Promise<OperationResult<TargetConnection>>>();

  beforeEach(() => {
    vi.resetAllMocks();
    useTargetsStore.setState(
      {
        ...useTargetsStore.getInitialState(),
        targets: [target],
        selectedTargetId: target.id,
        connections: { [target.id]: ready },
      },
      true,
    );
    listConnections.mockResolvedValue(success([ready]));
    listTargets.mockResolvedValue(success([target]));
    connectTarget.mockResolvedValue(success(ready));
    vi.stubGlobal("tanwei", {
      listConnections,
      listTargets,
      connectTarget,
      disconnectTarget: async () => success(null),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function refreshConnections(): Promise<void> {
    return useTargetsStore.getState().refreshConnections(
      new AbortController().signal,
    );
  }

  it("synchronizes every target while retaining unchanged connection identities", async () => {
    const remote: TargetConnection = {
      ...ready,
      target: { ...target, id: "remote:ssh:example", pid: 43 },
    };
    useTargetsStore.getState().registerRemoteConnection(remote);
    listConnections.mockResolvedValue(
      success([
        structuredClone(ready),
        { ...remote, state: "DISCONNECTED" },
      ]),
    );

    await refreshConnections();

    const state = useTargetsStore.getState();
    expect(state.connections[target.id]).toBe(ready);
    expect(state.connections[remote.target.id]?.state).toBe("DISCONNECTED");
    expect(state.selectedTargetId).toBe(remote.target.id);
  });

  it("removes sessions missing from the host snapshot", async () => {
    listConnections.mockResolvedValue(success([]));
    await refreshConnections();
    expect(useTargetsStore.getState().connections).toEqual({});
  });

  it("does not restore a disconnected target from a late status response", async () => {
    const pending = deferred<OperationResult<readonly TargetConnection[]>>();
    listConnections.mockReturnValue(pending.promise);
    const refreshing = refreshConnections();
    await useTargetsStore.getState().disconnect(target.id);

    pending.resolve(success([ready]));
    await refreshing;

    expect(useTargetsStore.getState().connections).toEqual({});
  });

  it("does not overwrite a new session with an old disconnected snapshot", async () => {
    const pending = deferred<OperationResult<readonly TargetConnection[]>>();
    listConnections.mockReturnValue(pending.promise);
    const refreshing = refreshConnections();
    const reconnected = { ...ready, connectedAt: "2026-09-12T00:01:00.000Z" };
    connectTarget.mockResolvedValue(success(reconnected));
    await useTargetsStore.getState().connect(target.id);

    pending.resolve(success([{ ...ready, state: "DISCONNECTED" }]));
    await refreshing;

    expect(useTargetsStore.getState().connections[target.id]).toBe(reconnected);
  });

  it("does not overwrite a new session when slow JVM discovery finishes", async () => {
    const discovery = deferred<OperationResult<readonly TargetDescriptor[]>>();
    listTargets.mockReturnValue(discovery.promise);
    const refreshing = useTargetsStore.getState().refresh();
    const reconnected = { ...ready, connectedAt: "2026-09-12T00:01:00.000Z" };
    connectTarget.mockResolvedValue(success(reconnected));
    await useTargetsStore.getState().connect(target.id);

    discovery.resolve(success([target]));
    await refreshing;

    expect(useTargetsStore.getState().connections[target.id]).toBe(reconnected);
  });

  it("preserves the last valid snapshot if the host cannot list connections", async () => {
    const previous = useTargetsStore.getState().connections;
    listConnections.mockResolvedValue({
      ok: false,
      value: null,
      errorCode: "IPC_FAILED",
      errorMessage: "unavailable",
    });

    await refreshConnections();
    expect(useTargetsStore.getState().connections).toBe(previous);
    await useTargetsStore.getState().refresh();
    expect(useTargetsStore.getState().connections).toBe(previous);
  });
});

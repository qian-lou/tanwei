import { create } from "zustand";
import type {
  OperationResult,
  TargetConnection,
  TargetDescriptor,
} from "@shared/contracts";
import { t } from "../i18n";

export interface TargetsState {
  readonly targets: readonly TargetDescriptor[];
  readonly selectedTargetId: string | null;
  readonly connections: Readonly<Record<string, TargetConnection>>;
  readonly loading: boolean;
  readonly connecting: boolean;
  readonly errorMessage: string | null;
  readonly refresh: () => Promise<void>;
  readonly refreshConnections: (signal: AbortSignal) => Promise<void>;
  readonly select: (targetId: string) => void;
  readonly connect: (
    targetId: string,
  ) => Promise<OperationResult<TargetConnection>>;
  readonly disconnect: (targetId: string) => Promise<OperationResult<null>>;
  readonly registerRemoteConnection: (connection: TargetConnection) => void;
}

export const useTargetsStore = create<TargetsState>()((set, get) => ({
  targets: [],
  selectedTargetId: null,
  connections: {},
  loading: false,
  connecting: false,
  errorMessage: null,

  async refresh(): Promise<void> {
    const previousConnections = get().connections;
    set({ loading: true, errorMessage: null });
    try {
      const [targetResult, connectionResult] = await Promise.all([
        window.tanwei.listTargets(),
        window.tanwei.listConnections(),
      ]);
      const current = get();
      const connections =
        connectionResult.ok &&
        connectionResult.value &&
        current.connections === previousConnections &&
        !current.connecting
          ? reconcileConnections(current.connections, connectionResult.value)
          : current.connections;
      const activeConnections = Object.values(connections);
      const targetById = new Map(
        (targetResult.value ?? []).map((target) => [target.id, target]),
      );
      for (const activeConnection of activeConnections) {
        targetById.set(activeConnection.target.id, activeConnection.target);
      }

      const { selectedTargetId } = get();
      const selectedTargetStillExists =
        selectedTargetId !== null && targetById.has(selectedTargetId);

      let errorMessage: string | null = null;
      if (!targetResult.ok) {
        errorMessage = targetResult.errorMessage ?? t("无法发现Java进程");
      } else if (!connectionResult.ok) {
        errorMessage = connectionResult.errorMessage ?? t("连接失败");
      }

      set({
        targets: [...targetById.values()],
        connections,
        selectedTargetId: selectedTargetStillExists
          ? selectedTargetId
          : (activeConnections.find(
              (activeConnection) => activeConnection.state === "READY",
            )?.target.id ?? null),
        errorMessage,
      });
    } catch (error) {
      set({
        errorMessage:
          error instanceof Error ? error.message : t("无法发现Java进程"),
      });
    } finally {
      set({ loading: false });
    }
  },

  async refreshConnections(signal: AbortSignal): Promise<void> {
    const previous = get();
    if (signal.aborted || previous.loading || previous.connecting) {
      return;
    }
    const result = await window.tanwei.listConnections();
    if (signal.aborted || !result.ok || !result.value) {
      return;
    }
    const snapshot = result.value;
    set((state) => {
      if (
        state.connections !== previous.connections ||
        state.loading ||
        state.connecting
      ) {
        return state;
      }
      const connections = reconcileConnections(state.connections, snapshot);
      return connections === state.connections ? state : { connections };
    });
  },

  select(targetId: string): void {
    set({ selectedTargetId: targetId });
  },

  async connect(targetId: string): Promise<OperationResult<TargetConnection>> {
    set({ connecting: true, errorMessage: null });
    try {
      const result = await window.tanwei.connectTarget(targetId);
      if (result.value) {
        set((state) => ({
          connections: { ...state.connections, [targetId]: result.value! },
        }));
      }
      if (!result.ok) {
        set({ errorMessage: result.errorMessage ?? t("连接失败") });
      }
      return result;
    } finally {
      set({ connecting: false });
    }
  },

  async disconnect(targetId: string): Promise<OperationResult<null>> {
    set({ errorMessage: null });
    try {
      const result = await window.tanwei.disconnectTarget(targetId);
      if (result.ok) {
        set((state) => {
          const nextConnections = { ...state.connections };
          delete nextConnections[targetId];
          const isRemote = targetId.startsWith("remote:");
          return {
            connections: nextConnections,
            targets: isRemote
              ? state.targets.filter((target) => target.id !== targetId)
              : state.targets,
            selectedTargetId:
              isRemote && state.selectedTargetId === targetId
                ? null
                : state.selectedTargetId,
          };
        });
      } else {
        set({ errorMessage: result.errorMessage ?? t("断开失败") });
      }
      return result;
    } catch (error) {
      const errorMessageValue =
        error instanceof Error ? error.message : t("断开失败");
      set({ errorMessage: errorMessageValue });
      return {
        ok: false,
        value: null,
        errorCode: "DISCONNECT_FAILED",
        errorMessage: errorMessageValue,
      };
    }
  },

  registerRemoteConnection(connection: TargetConnection): void {
    if (!connection.target.id.startsWith("remote:")) {
      throw new Error("远程连接标识无效");
    }
    set((state) => ({
      targets: [
        ...state.targets.filter((target) => target.id !== connection.target.id),
        connection.target,
      ],
      connections: {
        ...state.connections,
        [connection.target.id]: connection,
      },
      selectedTargetId: connection.target.id,
    }));
  },
}));

// 按快照总大小线性比较；时间与空间均为 O(S + N)。
// Time/Space: O(S + N), where S is snapshot size and N is session count.
function reconcileConnections(
  previous: TargetsState["connections"],
  snapshot: readonly TargetConnection[],
): TargetsState["connections"] {
  let changed = Object.keys(previous).length !== snapshot.length;
  const entries = snapshot.map((connection) => {
    const current = previous[connection.target.id];
    // 保留未变化的 IPC 快照引用，避免重启诊断页面副作用。
    // Preserve unchanged IPC snapshots to avoid restarting diagnostic effects.
    if (current && JSON.stringify(current) === JSON.stringify(connection)) {
      return [connection.target.id, current] as const;
    }
    changed = true;
    return [connection.target.id, connection] as const;
  });
  return changed ? Object.fromEntries(entries) : previous;
}

export function selectSelectedTarget(
  state: TargetsState,
): TargetDescriptor | null {
  return (
    state.targets.find((target) => target.id === state.selectedTargetId) ??
    null
  );
}

export function selectConnection(
  state: TargetsState,
): TargetConnection | null {
  return state.selectedTargetId
    ? (state.connections[state.selectedTargetId] ?? null)
    : null;
}

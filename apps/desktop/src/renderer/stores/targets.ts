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
    set({ loading: true, errorMessage: null });
    try {
      const [targetResult, connectionResult] = await Promise.all([
        window.tanwei.listTargets(),
        window.tanwei.listConnections(),
      ]);
      const activeConnections = connectionResult.value ?? [];
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
        connections: Object.fromEntries(
          activeConnections.map((activeConnection) => [
            activeConnection.target.id,
            activeConnection,
          ]),
        ),
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

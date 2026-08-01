import { create } from "zustand";
import type {
  MethodDescriptor,
  ObservationBatch,
  ObservationEvent,
} from "@shared/contracts";

export interface ObservationSelection {
  readonly className: string;
  readonly classLoader: string;
  readonly method: MethodDescriptor;
}

interface ObservationsState {
  readonly selection: ObservationSelection | null;
  readonly targetId: string | null;
  readonly taskId: string | null;
  readonly state: ObservationBatch["state"] | null;
  readonly events: readonly ObservationEvent[];
  readonly captured: number;
  readonly dropped: number;
  readonly select: (next: ObservationSelection) => void;
  readonly started: (nextTargetId: string, nextTaskId: string) => void;
  readonly applyBatch: (batch: ObservationBatch) => void;
  readonly setState: (nextState: ObservationBatch["state"]) => void;
}

export const useObservationsStore = create<ObservationsState>()((set) => ({
  selection: null,
  targetId: null,
  taskId: null,
  state: null,
  events: [],
  captured: 0,
  dropped: 0,

  select(next: ObservationSelection): void {
    set((state) => {
      const sameSelection =
        state.selection?.className === next.className &&
        state.selection.classLoader === next.classLoader &&
        state.selection.method.name === next.method.name &&
        state.selection.method.returnType === next.method.returnType &&
        state.selection.method.parameterTypes.join("\u0000") ===
          next.method.parameterTypes.join("\u0000");
      if (sameSelection || state.state === "RUNNING") {
        return { selection: next };
      }
      return {
        selection: next,
        targetId: null,
        taskId: null,
        state: null,
        events: [],
        captured: 0,
        dropped: 0,
      };
    });
  },

  started(nextTargetId: string, nextTaskId: string): void {
    set({
      targetId: nextTargetId,
      taskId: nextTaskId,
      state: "RUNNING",
      events: [],
      captured: 0,
      dropped: 0,
    });
  },

  applyBatch(batch: ObservationBatch): void {
    set((state) => {
      let events = state.events;
      if (batch.events.length > 0) {
        const byEventId = new Map(
          events.map((event) => [event.eventId, event] as const),
        );
        for (const event of batch.events) {
          byEventId.set(event.eventId, event);
        }
        events = [...byEventId.values()]
          .sort(
            (left, right) =>
              left.sequence - right.sequence || left.eventId - right.eventId,
          )
          .slice(-100);
      }
      return {
        state: batch.state,
        captured: batch.captured,
        dropped: batch.dropped,
        events,
      };
    });
  },

  setState(nextState: ObservationBatch["state"]): void {
    set({ state: nextState });
  },
}));

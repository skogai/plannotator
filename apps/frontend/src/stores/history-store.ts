import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { HistoryIndexEntry } from "../daemon/contracts";
import type { DaemonApiClient } from "../daemon/api/client";
import { daemonApiClient } from "../daemon/api/client";

export interface HistoryState {
  entries: HistoryIndexEntry[];
  loading: boolean;
  error?: string;
  lastFetchedAt: number | null;
  /** The project NAME the entries were last fetched for ("" = all projects). */
  lastProjectKey: string;
}

export interface HistoryActions {
  fetchHistory(projectName?: string, client?: DaemonApiClient): Promise<void>;
  clear(): void;
}

export type HistoryStore = HistoryState & HistoryActions;

const initialState: HistoryState = {
  entries: [],
  loading: false,
  lastFetchedAt: null,
  lastProjectKey: "",
};

export const historyStore = createStore<HistoryStore>()(
  immer((set) => ({
    ...initialState,

    async fetchHistory(projectName, client = daemonApiClient) {
      set((state) => {
        state.loading = true;
        state.error = undefined;
      });

      const result = await client.getHistory(projectName);

      if (!result.ok) {
        set((state) => {
          state.loading = false;
          state.error = result.error.message;
        });
        return;
      }

      set((state) => {
        state.entries = result.data.history;
        state.loading = false;
        state.lastFetchedAt = Date.now();
        state.lastProjectKey = projectName ?? "";
      });
    },

    clear() {
      set((state) => {
        state.entries = [];
        state.lastFetchedAt = null;
        state.lastProjectKey = "";
        state.error = undefined;
      });
    },
  })),
);

export function useHistoryStore<T>(selector: (state: HistoryStore) => T): T {
  return useStore(historyStore, selector);
}

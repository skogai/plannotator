import { beforeEach, describe, expect, test } from "vitest";
import { historyStore } from "./history-store";
import type { DaemonApiClient } from "../daemon/api/client";
import type { HistoryIndexEntry } from "../daemon/contracts";

function makeEntry(over: Partial<HistoryIndexEntry> = {}): HistoryIndexEntry {
  return {
    project: "repo",
    slug: "my-plan-2026-05-29",
    versionCount: 2,
    latest: "2026-05-29T00:00:00.000Z",
    latestVersionPath: "/tmp/history/repo/my-plan-2026-05-29/002.md",
    ...over,
  };
}

function fakeClient(impl: Partial<DaemonApiClient>): DaemonApiClient {
  return impl as DaemonApiClient;
}

beforeEach(() => {
  historyStore.getState().clear();
});

describe("historyStore.fetchHistory", () => {
  test("success populates entries, lastFetchedAt and lastProjectKey", async () => {
    const entries = [makeEntry()];
    const client = fakeClient({
      getHistory: async () => ({ ok: true, data: { ok: true, history: entries } }),
    });

    await historyStore.getState().fetchHistory("repo", client);

    const state = historyStore.getState();
    expect(state.entries).toEqual(entries);
    expect(state.loading).toBe(false);
    expect(state.error).toBeUndefined();
    expect(state.lastProjectKey).toBe("repo");
    expect(typeof state.lastFetchedAt).toBe("number");
  });

  test("undefined projectName stores empty-string lastProjectKey", async () => {
    const client = fakeClient({
      getHistory: async () => ({ ok: true, data: { ok: true, history: [] } }),
    });
    await historyStore.getState().fetchHistory(undefined, client);
    expect(historyStore.getState().lastProjectKey).toBe("");
  });

  test("passes the project name to the client", async () => {
    let received: string | undefined = "UNSET";
    const client = fakeClient({
      getHistory: async (name) => {
        received = name;
        return { ok: true, data: { ok: true, history: [] } };
      },
    });
    await historyStore.getState().fetchHistory("alpha", client);
    expect(received).toBe("alpha");
  });

  test("error sets error and clears loading", async () => {
    const client = fakeClient({
      getHistory: async () => ({
        ok: false,
        error: { kind: "network-error", message: "boom" },
      }),
    });

    await historyStore.getState().fetchHistory("repo", client);

    const state = historyStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe("boom");
    expect(state.entries).toEqual([]);
  });

  test("clear() resets entries, timestamp, key and error", async () => {
    const client = fakeClient({
      getHistory: async () => ({ ok: true, data: { ok: true, history: [makeEntry()] } }),
    });
    await historyStore.getState().fetchHistory("repo", client);
    historyStore.getState().clear();

    const state = historyStore.getState();
    expect(state.entries).toEqual([]);
    expect(state.lastFetchedAt).toBeNull();
    expect(state.lastProjectKey).toBe("");
    expect(state.error).toBeUndefined();
  });
});

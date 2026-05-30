import { describe, expect, test } from "vitest";
import { createAppStore } from "./app-store";

describe("appStore expand actions", () => {
  test("expandedProjects starts empty", () => {
    const store = createAppStore();
    expect(store.getState().expandedProjects.size).toBe(0);
  });

  test("toggleProjectExpand adds a project when absent", () => {
    const store = createAppStore();
    expect(store.getState().expandedProjects.has("/a")).toBe(false);
    store.getState().toggleProjectExpand("/a");
    expect(store.getState().expandedProjects.has("/a")).toBe(true);
  });

  test("toggleProjectExpand removes a project when present", () => {
    const store = createAppStore();
    store.getState().toggleProjectExpand("/a");
    expect(store.getState().expandedProjects.has("/a")).toBe(true);
    store.getState().toggleProjectExpand("/a");
    expect(store.getState().expandedProjects.has("/a")).toBe(false);
  });

  test("setProjectExpanded(open=true) is idempotent", () => {
    const store = createAppStore();
    store.getState().setProjectExpanded("/a", true);
    store.getState().setProjectExpanded("/a", true);
    expect(store.getState().expandedProjects.has("/a")).toBe(true);
    expect(store.getState().expandedProjects.size).toBe(1);
  });

  test("setProjectExpanded(open=false) removes and is idempotent", () => {
    const store = createAppStore();
    store.getState().setProjectExpanded("/a", true);
    store.getState().setProjectExpanded("/a", false);
    store.getState().setProjectExpanded("/a", false);
    expect(store.getState().expandedProjects.has("/a")).toBe(false);
    expect(store.getState().expandedProjects.size).toBe(0);
  });

  test("immer produces a new Set reference on mutation (state change is observable)", () => {
    const store = createAppStore();
    const before = store.getState().expandedProjects;
    store.getState().toggleProjectExpand("/a");
    const after = store.getState().expandedProjects;
    expect(after).not.toBe(before);
  });

  test("multiple projects are tracked independently", () => {
    const store = createAppStore();
    store.getState().toggleProjectExpand("/a");
    store.getState().toggleProjectExpand("/b");
    store.getState().toggleProjectExpand("/a");
    expect(store.getState().expandedProjects.has("/a")).toBe(false);
    expect(store.getState().expandedProjects.has("/b")).toBe(true);
  });

  test("instances do not share expansion state", () => {
    const a = createAppStore();
    const b = createAppStore();
    a.getState().toggleProjectExpand("/a");
    expect(a.getState().expandedProjects.has("/a")).toBe(true);
    expect(b.getState().expandedProjects.has("/a")).toBe(false);
  });
});

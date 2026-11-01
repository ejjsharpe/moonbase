import { test, expect, vi } from "vite-plus/test";
import { initialize, persist, flush } from "../src/workspace";

test("rapid edits persist the latest snapshot once and flush waits for durable completion", async () => {
  vi.useFakeTimers();
  const write = vi.fn(async () => {});
  vi.stubGlobal("window", { escode: { lifecycle: write }, dispatchEvent: vi.fn() });
  try {
    const state = { projects: [], selected: "first", views: {}, drafts: [] };
    initialize(state);
    const first = persist();
    state.selected = "latest";
    const second = persist();
    expect(write).not.toHaveBeenCalled();
    await flush();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledExactlyOnceWith("persist", { ...state, selected: "latest" });
    await vi.runAllTimersAsync();
    expect(write).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

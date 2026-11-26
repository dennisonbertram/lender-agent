// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useIsOnScreen, useShowOnScreen } from "./on-screen";

afterEach(cleanup);

describe("on-screen proposals", () => {
  it("registers an id while the page card is mounted and clears it on unmount", () => {
    const watcher = renderHook(() => useIsOnScreen("p1"));
    expect(watcher.result.current).toBe(false);
    const page = renderHook(() => useShowOnScreen("p1"));
    expect(watcher.result.current).toBe(true);
    page.unmount();
    expect(watcher.result.current).toBe(false);
  });
  it("tracks two ids separately", () => {
    const a = renderHook(() => useIsOnScreen("a"));
    const b = renderHook(() => useIsOnScreen("b"));
    const page = renderHook(() => useShowOnScreen("a"));
    expect(a.result.current).toBe(true);
    expect(b.result.current).toBe(false);
    act(() => page.rerender());
    page.unmount();
    expect(a.result.current).toBe(false);
  });
  it("ignores a null id", () => {
    const w = renderHook(() => useIsOnScreen("p1"));
    renderHook(() => useShowOnScreen(null));
    expect(w.result.current).toBe(false);
  });
});

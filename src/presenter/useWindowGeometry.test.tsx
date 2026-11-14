import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  moved: null as null | (() => void),
  resized: null as null | (() => void),
  unlistenMoved: vi.fn(),
  unlistenResized: vi.fn(),
  position: { x: 100, y: 50 },
  size: { width: 900, height: 220 },
  getCurrentWindow: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: win.getCurrentWindow }));
vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));

import { GEOMETRY_SAVE_DELAY_MS, relativeGeometry, useWindowGeometry } from "./useWindowGeometry";
import { usePresenterStore } from "../stores/presenterStore";
import type { DisplayInfo } from "../lib/profileTypes";
import { makeProfile, profileIpcMock as ipc, resetProfileIpcMock } from "../test/profileFixtures";

const display = (index: number, x: number, y = 0, width = 1920, height = 1080): DisplayInfo => ({
  index, name: `D${index}`, x, y, width, height, scaleFactor: 1, isPrimary: index === 0,
});
const TWO = [display(0, 0), display(1, 1920)];

const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(GEOMETRY_SAVE_DELAY_MS + 10); }); };
const tele = () => usePresenterStore.getState().profile!.environment.teleprompter;

beforeEach(() => {
  vi.useFakeTimers();
  resetProfileIpcMock();
  ipc.displays.mockResolvedValue(TWO);
  win.moved = null;
  win.resized = null;
  win.unlistenMoved = vi.fn();
  win.unlistenResized = vi.fn();
  win.position = { x: 100, y: 50 };
  win.size = { width: 900, height: 220 };
  win.getCurrentWindow.mockImplementation(() => ({
    onMoved: (cb: () => void) => { win.moved = cb; return Promise.resolve(win.unlistenMoved); },
    onResized: (cb: () => void) => { win.resized = cb; return Promise.resolve(win.unlistenResized); },
    outerPosition: () => Promise.resolve(win.position),
    outerSize: () => Promise.resolve(win.size),
  }));
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  usePresenterStore.setState({ profile: makeProfile() });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  usePresenterStore.getState().clear();
  vi.useRealTimers();
  win.getCurrentWindow.mockReset();
});

describe("relativeGeometry", () => {
  it("is relative to the display that contains the window", () => {
    expect(relativeGeometry({ x: 2020, y: 80, width: 900, height: 220 }, TWO)).toEqual({ x: 100, y: 80, width: 900, height: 220 });
    expect(relativeGeometry({ x: 100, y: 50, width: 900, height: 220 }, TWO)).toEqual({ x: 100, y: 50, width: 900, height: 220 });
  });

  it("uses the display that holds the window's centre, and none when it is off every display", () => {
    // Centre at x=1990: second display, although most of the left edge hangs over the first.
    expect(relativeGeometry({ x: 1500, y: 0, width: 980, height: 200 }, TWO)?.x).toBe(1500 - 1920);
    expect(relativeGeometry({ x: 100, y: 2000, width: 400, height: 100 }, TWO)).toBeNull();
    // Centre just below the display, but the window still overlaps it: that display.
    expect(relativeGeometry({ x: 100, y: 1000, width: 400, height: 200 }, TWO)).toEqual({ x: 100, y: 1000, width: 400, height: 200 });
    expect(relativeGeometry({ x: 0, y: 0, width: 10, height: 10 }, [])).toBeNull();
  });
});

describe("useWindowGeometry", () => {
  it("saves the position and size after a move settles", async () => {
    renderHook(() => useWindowGeometry());
    await act(async () => { await Promise.resolve(); });
    expect(win.moved).toBeTypeOf("function");
    win.position = { x: 2100, y: 60 };
    win.moved!();
    await flush();
    expect(tele()).toMatchObject({ x: 180, y: 60, width: 900, height: 220 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.updateTeleprompter).toHaveBeenCalledTimes(1);
    expect(ipc.updateTeleprompter).toHaveBeenCalledWith("p1", expect.objectContaining({ x: 180, y: 60 }));
  });

  it("saves after a resize, and one save covers a burst of events", async () => {
    renderHook(() => useWindowGeometry());
    await act(async () => { await Promise.resolve(); });
    win.size = { width: 1000, height: 300 };
    for (let i = 0; i < 5; i++) {
      win.resized!();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(tele().width).toBe(900); // still waiting for the resize to settle
    await flush();
    expect(tele()).toMatchObject({ width: 1000, height: 300 });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.updateTeleprompter).toHaveBeenCalledTimes(1);
  });

  it("saves nothing when the geometry did not change", async () => {
    usePresenterStore.setState({ profile: { ...makeProfile(), environment: { ...makeProfile().environment, teleprompter: { ...makeProfile().environment.teleprompter, x: 100, y: 50, width: 900, height: 220 } } } });
    renderHook(() => useWindowGeometry());
    await act(async () => { await Promise.resolve(); });
    win.moved!();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.updateTeleprompter).not.toHaveBeenCalled();
  });

  it("saves nothing when no display contains the window or the display list fails", async () => {
    renderHook(() => useWindowGeometry());
    await act(async () => { await Promise.resolve(); });
    win.position = { x: 9000, y: 9000 };
    win.moved!();
    await flush();
    ipc.displays.mockRejectedValueOnce(new Error("no displays"));
    win.moved!();
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(ipc.updateTeleprompter).not.toHaveBeenCalled();
    expect(tele().x).toBe(0);
  });

  it("stops listening on unmount and drops a pending save", async () => {
    const { unmount } = renderHook(() => useWindowGeometry());
    await act(async () => { await Promise.resolve(); });
    win.position = { x: 300, y: 300 };
    win.moved!();
    unmount();
    await flush();
    expect(win.unlistenMoved).toHaveBeenCalledTimes(1);
    expect(win.unlistenResized).toHaveBeenCalledTimes(1);
    expect(tele().x).toBe(0);
  });

  it("does nothing outside the desktop app", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    renderHook(() => useWindowGeometry());
    await flush();
    expect(win.getCurrentWindow).not.toHaveBeenCalled();
    expect(ipc.displays).not.toHaveBeenCalled();
  });

  it("does not break when the window API throws", async () => {
    win.getCurrentWindow.mockImplementation(() => { throw new Error("no window"); });
    expect(() => renderHook(() => useWindowGeometry())).not.toThrow();
  });
});

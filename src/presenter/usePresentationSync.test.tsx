import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePresentationSync } from "./usePresentationSync";
import { usePresenterStore } from "../stores/presenterStore";
import type { BindingStatus } from "../lib/profileTypes";

const status = (state: BindingStatus["state"]): BindingStatus => ({
  state, targetTitle: "Deck", targetId: "d", kind: "powerpoint", targetSlide: 1, slideCount: 3, slideshowRunning: true, message: "",
});

function setup(over: Partial<ReturnType<typeof usePresenterStore.getState>> = {}) {
  const poll = vi.fn().mockResolvedValue(undefined);
  usePresenterStore.setState({ phase: "presentation", hidden: false, binding: status("connected"), pollBinding: poll, ...over });
  return poll;
}

const REAL_POLL = usePresenterStore.getState().pollBinding;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  usePresenterStore.setState({ pollBinding: REAL_POLL });
  usePresenterStore.getState().clear();
});

describe("usePresentationSync", () => {
  it("polls every 500 ms while presenting with a connected presentation", async () => {
    const poll = setup();
    renderHook(() => usePresentationSync());
    expect(poll).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("also polls while out of sync", async () => {
    const poll = setup({ binding: status("out_of_sync") });
    renderHook(() => usePresentationSync());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("does not poll without a controllable presentation, in Q&A, or while hidden", async () => {
    for (const over of [{ binding: status("disconnected") }, { binding: status("unsupported") }, { phase: "qa" as const }, { hidden: true }]) {
      const poll = setup(over);
      const { unmount } = renderHook(() => usePresentationSync());
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(poll).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("never overlaps polls", async () => {
    let release!: () => void;
    const poll = setup();
    poll.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    renderHook(() => usePresentationSync());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(500); });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed poll", async () => {
    const poll = setup();
    poll.mockRejectedValueOnce(new Error("boom"));
    renderHook(() => usePresentationSync());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("stops when the presentation view is hidden and when unmounted", async () => {
    const poll = setup();
    const { unmount } = renderHook(() => usePresentationSync());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(poll).toHaveBeenCalledTimes(1);
    act(() => usePresenterStore.setState({ hidden: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(poll).toHaveBeenCalledTimes(1);
    act(() => usePresenterStore.setState({ hidden: false }));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("keeps one timer when the state flips between connected and out of sync", async () => {
    const poll = setup();
    renderHook(() => usePresentationSync());
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    act(() => usePresenterStore.setState({ binding: status("out_of_sync") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

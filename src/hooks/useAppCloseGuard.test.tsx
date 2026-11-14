import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "../lib/types";

type Handler = (e: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<Handler>>());
const calls = vi.hoisted(() => [] as string[]);
const invokeMock = vi.hoisted(() => vi.fn());
const endMeeting = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: Handler) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(cb);
    return () => listeners.get(name)!.delete(cb);
  },
  emit: async () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("./useUpdater", () => ({
  endMeetingFromThisWindow: () => endMeeting(),
  endMeetingInAllWindows: () => endMeeting(),
}));

import { closeNeedsConfirmation, useAppCloseGuard } from "./useAppCloseGuard";
import { APP_CLOSE_REQUESTED_EVENT } from "../lib/appClose";
import { useMeetingStore } from "../stores/meetingStore";
import { useProfileStore } from "../stores/profileStore";

const saveProfile = vi.fn();

async function mount(label = "launcher") {
  const hook = renderHook(() => useAppCloseGuard(label));
  await act(async () => {});
  return hook;
}

/** What the backend does when the launcher is asked to close. */
async function requestClose(meetingActive = false) {
  await act(async () => {
    listeners.get(APP_CLOSE_REQUESTED_EVENT)?.forEach((cb) => cb({ payload: { meetingActive } }));
  });
}

const invoked = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;

beforeEach(() => {
  listeners.clear();
  calls.length = 0;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    calls.push(command);
    return command === "ack_app_close_prompt" ? true : undefined;
  });
  endMeeting.mockReset();
  endMeeting.mockImplementation(async () => {
    calls.push("end_meeting");
    return true;
  });
  saveProfile.mockReset();
  saveProfile.mockImplementation(async () => {
    calls.push("save_profile");
    return true;
  });
  useMeetingStore.setState({ activeMeeting: null });
  useProfileStore.setState({ dirty: false, error: null, save: saveProfile });
});
afterEach(cleanup);

describe("closeNeedsConfirmation", () => {
  it("asks only when something would be lost", () => {
    expect(closeNeedsConfirmation({ meetingActive: false, unsavedSetup: false })).toBe(false);
    expect(closeNeedsConfirmation({ meetingActive: true, unsavedSetup: false })).toBe(true);
    expect(closeNeedsConfirmation({ meetingActive: false, unsavedSetup: true })).toBe(true);
  });
});

describe("useAppCloseGuard", () => {
  it("confirms at once, without a dialog, when there is nothing to lose", async () => {
    const { result } = await mount();
    await requestClose();
    expect(invoked("confirm_app_close")).toBe(1);
    expect(invoked("ack_app_close_prompt")).toBe(0);
    expect(result.current.prompt).toBeNull();
  });

  it("opens the dialog, and tells the backend, while a meeting is active", async () => {
    const { result } = await mount();
    await requestClose(true);
    expect(result.current.prompt).toEqual({ meetingActive: true, unsavedSetup: false });
    expect(invoked("ack_app_close_prompt")).toBe(1);
    expect(invoked("confirm_app_close")).toBe(0);
  });

  it("notices a meeting this window knows about even if the backend did not say so", async () => {
    useMeetingStore.setState({ activeMeeting: { id: "m1" } as Meeting });
    const { result } = await mount();
    await requestClose(false);
    expect(result.current.prompt?.meetingActive).toBe(true);
  });

  it("opens the dialog when the meeting setup has unsaved edits", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount();
    await requestClose();
    expect(result.current.prompt).toEqual({ meetingActive: false, unsavedSetup: true });
    expect(invoked("confirm_app_close")).toBe(0);
  });

  it("closing again with the dialog up answers again but keeps the one dialog", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount();
    await requestClose();
    const shown = result.current.prompt;
    await requestClose();
    expect(result.current.prompt).toBe(shown);
    expect(invoked("ack_app_close_prompt")).toBe(2);
  });

  it("Save and quit ends the meeting, saves the setup, then quits", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.saveAndQuit();
    });
    expect(calls).toEqual(["ack_app_close_prompt", "end_meeting", "save_profile", "confirm_app_close"]);
  });

  it("Save and quit with only unsaved setup does not touch a meeting", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount();
    await requestClose();
    await act(async () => {
      await result.current.saveAndQuit();
    });
    expect(endMeeting).not.toHaveBeenCalled();
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(invoked("confirm_app_close")).toBe(1);
  });

  it("Quit without saving quits and saves nothing", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.quitWithoutSaving();
    });
    expect(endMeeting).not.toHaveBeenCalled();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(invoked("confirm_app_close")).toBe(1);
  });

  it("Cancel closes the dialog and tells the backend, which keeps running", async () => {
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.prompt).toBeNull();
    expect(invoked("cancel_app_close")).toBe(1);
    expect(invoked("confirm_app_close")).toBe(0);
    expect(endMeeting).not.toHaveBeenCalled();
  });

  it("can be asked again after a cancel", async () => {
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.cancel();
    });
    await requestClose(true);
    expect(result.current.prompt).not.toBeNull();
  });

  it("stays open with the reason when the meeting could not be saved", async () => {
    endMeeting.mockResolvedValue(false);
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.saveAndQuit();
    });
    expect(invoked("confirm_app_close")).toBe(0);
    expect(result.current.prompt).not.toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toMatch(/didn't finish saving/);
  });

  it("stays open when ending the meeting throws, and does not save the setup", async () => {
    useProfileStore.setState({ dirty: true });
    endMeeting.mockRejectedValue(new Error("transcript lines not saved"));
    const { result } = await mount();
    await requestClose(true);
    await act(async () => {
      await result.current.saveAndQuit();
    });
    expect(result.current.error).toBe("transcript lines not saved");
    expect(saveProfile).not.toHaveBeenCalled();
    expect(invoked("confirm_app_close")).toBe(0);
  });

  it("stays open with the store's error when the setup could not be saved", async () => {
    useProfileStore.setState({ dirty: true, error: "disk full" });
    saveProfile.mockResolvedValue(false);
    const { result } = await mount();
    await requestClose();
    await act(async () => {
      await result.current.saveAndQuit();
    });
    expect(result.current.error).toBe("disk full");
    expect(invoked("confirm_app_close")).toBe(0);
  });

  it("does nothing in the overlay window", async () => {
    useProfileStore.setState({ dirty: true });
    const { result } = await mount("overlay");
    expect(listeners.get(APP_CLOSE_REQUESTED_EVENT)?.size ?? 0).toBe(0);
    await requestClose(true);
    expect(result.current.prompt).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("stops listening when the window unmounts", async () => {
    const { unmount } = await mount();
    expect(listeners.get(APP_CLOSE_REQUESTED_EVENT)?.size).toBe(1);
    unmount();
    expect(listeners.get(APP_CLOSE_REQUESTED_EVENT)?.size).toBe(0);
  });
});

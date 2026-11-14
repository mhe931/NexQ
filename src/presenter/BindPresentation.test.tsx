import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));

import { BindStatusChip } from "./BindPresentation";
import { palette } from "./theme";
import { usePresenterStore } from "../stores/presenterStore";
import { DISCONNECTED, makeProfile, profileIpcMock as ipc, resetProfileIpcMock } from "../test/profileFixtures";
import type { BindingStatus, PresentationTarget } from "../lib/profileTypes";

const colors = palette(makeProfile().environment.teleprompter);

const CONNECTED: BindingStatus = {
  state: "connected", targetTitle: "Thesis.pptx", targetId: "ppt-1", kind: "powerpoint", targetSlide: 3, slideCount: 12,
  slideshowRunning: true, message: "Connected (slide show running)",
};
const UNSUPPORTED: BindingStatus = {
  state: "unsupported", targetTitle: "Quarterly deck", targetId: "gs-1", kind: "google_slides", targetSlide: null, slideCount: null,
  slideshowRunning: false, message: "Google Slides cannot be controlled from NexQ (Google offers no slideshow-control API).",
};
const OUT_OF_SYNC: BindingStatus = { ...CONNECTED, state: "out_of_sync", targetSlide: 5, message: "The presentation is on slide 5 but NexQ shows slide 3." };
const CLOSED: BindingStatus = {
  ...DISCONNECTED, targetTitle: "Thesis.pptx", targetId: "ppt-1", kind: "powerpoint", message: "“Thesis.pptx” is not open. Open it, then choose Rebind.",
};

const TARGETS: PresentationTarget[] = [
  { id: "ppt-1", kind: "powerpoint", title: "Thesis.pptx", detail: "C:\\Decks\\Thesis.pptx", supportsControl: true, slideshowRunning: true, slideCount: 12, currentSlide: 3 },
  { id: "gs-1", kind: "google_slides", title: "Quarterly deck", detail: "Quarterly deck - Google Slides - Chrome", supportsControl: false, slideshowRunning: false, slideCount: null, currentSlide: null },
];

function show(binding: BindingStatus = DISCONNECTED) {
  usePresenterStore.setState({ profile: makeProfile(), binding });
  render(<BindStatusChip colors={colors} />);
}

const chip = () => screen.getByRole("button", { name: /Bind presentation|CONNECTED|DISCONNECTED|UNSUPPORTED|OUT OF SYNC/ });
const dialog = () => screen.getByRole("dialog", { name: "Bind presentation" });

beforeEach(() => {
  resetProfileIpcMock();
  ipc.presentTargets.mockResolvedValue(TARGETS);
});

afterEach(() => {
  cleanup();
  usePresenterStore.getState().clear();
});

describe("bind status chip", () => {
  it("offers to bind when nothing is bound", () => {
    show();
    expect(chip()).toHaveTextContent("Bind presentation");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    [CONNECTED, "CONNECTED"],
    [CLOSED, "DISCONNECTED"],
    [UNSUPPORTED, "UNSUPPORTED"],
    [OUT_OF_SYNC, "OUT OF SYNC"],
  ])("shows the state as text next to the target name (%#)", (status, label) => {
    show(status);
    expect(chip()).toHaveTextContent(label);
    expect(chip()).toHaveTextContent(status.targetTitle!);
    expect(within(chip()).getByTitle(status.targetTitle!)).toBeInTheDocument();
  });

  it("opens the dialog on click", async () => {
    show();
    fireEvent.click(chip());
    expect(dialog()).toBeInTheDocument();
    await screen.findByRole("radiogroup", { name: "Open presentations" });
  });
});

describe("bind dialog: choosing a presentation", () => {
  it("lists what is open and never binds until the user selects a row and presses Bind", async () => {
    show();
    fireEvent.click(chip());
    expect(screen.getByText("Open PowerPoint or Google Slides first, then choose it here.")).toBeInTheDocument();
    const list = await screen.findByRole("radiogroup", { name: "Open presentations" });
    const rows = within(list).getAllByRole("radio");
    expect(rows).toHaveLength(2);
    expect(list).toHaveTextContent("Thesis.pptx");
    expect(list).toHaveTextContent("PowerPoint");
    expect(list).toHaveTextContent("C:\\Decks\\Thesis.pptx");
    expect(list).toHaveTextContent("12 slides");
    expect(list).toHaveTextContent("currently on slide 3");
    expect(list).toHaveTextContent("slide show running");
    expect(rows.every((r) => !(r as HTMLInputElement).checked)).toBe(true);

    const bindButton = screen.getByRole("button", { name: "Bind" });
    expect(bindButton).toBeDisabled();
    fireEvent.click(bindButton);
    expect(ipc.presentBind).not.toHaveBeenCalled();

    ipc.presentBind.mockResolvedValue(CONNECTED);
    fireEvent.click(rows[0]);
    expect(bindButton).toBeEnabled();
    fireEvent.click(bindButton);
    await waitFor(() => expect(ipc.presentBind).toHaveBeenCalledTimes(1));
    expect(ipc.presentBind).toHaveBeenCalledWith("p1", "ppt-1");
    expect(await within(dialog()).findByRole("status", { name: "Connection state" })).toHaveTextContent("CONNECTED");
  });

  it("labels Google Slides honestly as listed but not controllable", async () => {
    show();
    fireEvent.click(chip());
    const list = await screen.findByRole("radiogroup", { name: "Open presentations" });
    expect(list).toHaveTextContent("Google Slides");
    expect(list.textContent?.match(/Can be listed, cannot be controlled — manual sync/g)).toHaveLength(1);
    expect(within(list).getByText(/Quarterly deck - Google Slides - Chrome/)).toBeInTheDocument();
  });

  it("explains what to do when nothing is open and can refresh", async () => {
    ipc.presentTargets.mockResolvedValueOnce([]);
    show();
    fireEvent.click(chip());
    expect(await screen.findByText("No presentations found. Open your deck in PowerPoint (desktop) or Google Slides in a browser.")).toBeInTheDocument();
    ipc.presentTargets.mockResolvedValueOnce(TARGETS);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("radiogroup", { name: "Open presentations" })).toBeInTheDocument();
    expect(ipc.presentTargets).toHaveBeenCalledTimes(2);
  });

  it("shows a listing failure and a bind failure as alerts", async () => {
    ipc.presentTargets.mockRejectedValueOnce("PowerPoint is not available.");
    show();
    fireEvent.click(chip());
    expect(await screen.findByRole("alert")).toHaveTextContent("PowerPoint is not available.");

    ipc.presentTargets.mockResolvedValue(TARGETS);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click((await screen.findAllByRole("radio"))[0]);
    ipc.presentBind.mockRejectedValue("That window is no longer available. Open it and choose Bind again.");
    fireEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That window is no longer available");
  });
});

describe("bind dialog: a bound presentation", () => {
  it("shows name, state, message and slide N of M", () => {
    show(CONNECTED);
    fireEvent.click(chip());
    const d = dialog();
    expect(d).toHaveTextContent("Thesis.pptx");
    expect(within(d).getByRole("status", { name: "Connection state" })).toHaveTextContent("CONNECTED");
    expect(d).toHaveTextContent("Connected (slide show running)");
    expect(d).toHaveTextContent("Slide 3 of 12");
    expect(ipc.presentTargets).not.toHaveBeenCalled();
  });

  it("tells the user a closed presentation is disconnected and how to recover", () => {
    show(CLOSED);
    fireEvent.click(chip());
    const d = dialog();
    expect(within(d).getByRole("status", { name: "Connection state" })).toHaveTextContent("DISCONNECTED");
    expect(d).toHaveTextContent("“Thesis.pptx” is not open. Open it, then choose Rebind.");
    expect(within(d).getByRole("button", { name: "Test navigation" })).toBeDisabled();
    expect(within(d).getByRole("button", { name: "Sync to current slide" })).toBeDisabled();
  });

  it("is honest that Google Slides cannot be controlled", () => {
    show(UNSUPPORTED);
    fireEvent.click(chip());
    const d = dialog();
    expect(within(d).getByRole("status", { name: "Connection state" })).toHaveTextContent("UNSUPPORTED");
    expect(d).toHaveTextContent(/NexQ cannot control Google Slides/);
    expect(d).toHaveTextContent(/notes follow the slide you select in NexQ/);
    expect(within(d).getByRole("button", { name: "Test navigation" })).toBeDisabled();
  });

  it("Rebind goes back to the list without touching the binding", async () => {
    show(CONNECTED);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Rebind" }));
    expect(await screen.findByRole("radiogroup", { name: "Open presentations" })).toBeInTheDocument();
    expect(ipc.presentDisconnect).not.toHaveBeenCalled();
    expect(ipc.presentBind).not.toHaveBeenCalled();
  });

  it("Disconnect calls the backend once and returns to the list", async () => {
    ipc.presentDisconnect.mockResolvedValue(undefined);
    show(CONNECTED);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(ipc.presentDisconnect).toHaveBeenCalledTimes(1));
    expect(ipc.presentDisconnect).toHaveBeenCalledWith("p1");
    expect(await screen.findByRole("radiogroup", { name: "Open presentations" })).toBeInTheDocument();
    expect(usePresenterStore.getState().binding.state).toBe("disconnected");
    expect(chip()).toHaveTextContent("Bind presentation");
  });

  it("Test navigation runs once and shows the result; a failure is an alert", async () => {
    ipc.presentTestNavigation.mockResolvedValueOnce({ confirmedSlide: 3, status: CONNECTED });
    show(CONNECTED);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Test navigation" }));
    expect(await screen.findByText(/Moved one slide and back; the presentation is on slide 3\./)).toBeInTheDocument();
    expect(ipc.presentTestNavigation).toHaveBeenCalledTimes(1);

    ipc.presentTestNavigation.mockRejectedValueOnce("The presentation needs at least two slides to test navigation.");
    fireEvent.click(screen.getByRole("button", { name: "Test navigation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least two slides");
    expect(ipc.presentTestNavigation).toHaveBeenCalledTimes(2);
  });

  it("Sync to current slide reads the presentation once", async () => {
    ipc.presentStatus.mockResolvedValue({ ...CONNECTED, targetSlide: 7 });
    show(OUT_OF_SYNC);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Sync to current slide" }));
    expect(await screen.findByText("Notes now follow slide 7 of the presentation.")).toBeInTheDocument();
    expect(ipc.presentStatus).toHaveBeenCalledTimes(1);
    expect(ipc.presentStatus).toHaveBeenCalledWith(null);
  });

  it("never navigates the presentation by itself", async () => {
    ipc.presentBind.mockResolvedValue(CONNECTED);
    ipc.presentStatus.mockResolvedValue(CONNECTED);
    show();
    fireEvent.click(chip());
    fireEvent.click((await screen.findAllByRole("radio"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Bind" }));
    await screen.findByRole("button", { name: "Sync to current slide" });
    fireEvent.click(screen.getByRole("button", { name: "Sync to current slide" }));
    await waitFor(() => expect(ipc.presentStatus).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Rebind" }));
    expect(ipc.presentGoto).not.toHaveBeenCalled();
  });
});

describe("bind dialog: keyboard and focus", () => {
  it("Escape closes it and focus returns to the chip", () => {
    show(CONNECTED);
    fireEvent.click(chip());
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip()).toHaveFocus();
  });

  it("the Close button closes it and returns focus to the chip", () => {
    show();
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip()).toHaveFocus();
  });

  it("keeps presenter shortcut keys from reaching the window while open", () => {
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    show(CONNECTED);
    fireEvent.click(chip());
    fireEvent.keyDown(dialog(), { key: "n" });
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });
});

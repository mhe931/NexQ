import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCloseDialog, closeSummary } from "./AppCloseDialog";
import type { AppCloseGuard } from "../hooks/useAppCloseGuard";

function guard(overrides: Partial<AppCloseGuard> = {}): AppCloseGuard {
  return {
    prompt: { meetingActive: true, unsavedSetup: false },
    busy: false,
    error: null,
    saveAndQuit: vi.fn().mockResolvedValue(undefined),
    quitWithoutSaving: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

afterEach(cleanup);

describe("closeSummary", () => {
  it("names what would be lost", () => {
    expect(closeSummary({ meetingActive: true, unsavedSetup: false })).toBe("A meeting is still running.");
    expect(closeSummary({ meetingActive: false, unsavedSetup: true })).toBe(
      "Your meeting setup has unsaved changes.",
    );
    expect(closeSummary({ meetingActive: true, unsavedSetup: true })).toMatch(/meeting is still running and/);
  });
});

describe("AppCloseDialog", () => {
  it("renders nothing while no close is pending", () => {
    const { container } = render(<AppCloseDialog guard={guard({ prompt: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is an accessible modal that names the problem and starts on Save and quit", () => {
    render(<AppCloseDialog guard={guard()} />);
    const dialog = screen.getByRole("alertdialog", { name: "Quit NexQ?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/A meeting is still running/);
    expect(screen.getByRole("button", { name: "Save and quit" })).toHaveFocus();
  });

  it("offers the three answers, each wired to its action", () => {
    const g = guard();
    render(<AppCloseDialog guard={g} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and quit" }));
    fireEvent.click(screen.getByRole("button", { name: "Quit without saving" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(g.saveAndQuit).toHaveBeenCalledTimes(1);
    expect(g.quitWithoutSaving).toHaveBeenCalledTimes(1);
    expect(g.cancel).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels, and only this dialog sees it", () => {
    const g = guard();
    const elsewhere = vi.fn();
    window.addEventListener("keydown", elsewhere);
    render(<AppCloseDialog guard={g} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", elsewhere);
    expect(g.cancel).toHaveBeenCalledTimes(1);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("Escape does nothing while saving", () => {
    const g = guard({ busy: true });
    render(<AppCloseDialog guard={g} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(g.cancel).not.toHaveBeenCalled();
  });

  it("disables Save and Cancel while saving but still allows quitting", () => {
    render(<AppCloseDialog guard={guard({ busy: true })} />);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quit without saving" })).toBeEnabled();
  });

  it("keeps Tab inside the dialog", () => {
    render(<AppCloseDialog guard={guard()} />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const save = screen.getByRole("button", { name: "Save and quit" });
    // Save and quit is last in tab order: Tab wraps to the first button.
    expect(save).toHaveFocus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(cancel).toHaveFocus();
    // Shift+Tab on the first wraps to the last.
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(save).toHaveFocus();
  });

  it("shows why saving failed", () => {
    render(<AppCloseDialog guard={guard({ error: "disk full" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  });

  it("appears when a close is requested after mounting", () => {
    const { rerender } = render(<AppCloseDialog guard={guard({ prompt: null })} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    act(() => rerender(<AppCloseDialog guard={guard()} />));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and quit" })).toHaveFocus();
  });
});

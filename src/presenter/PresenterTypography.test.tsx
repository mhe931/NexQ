import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("../lib/profileIpc", async () => ({ profileIpc: (await import("../test/profileFixtures")).profileIpcMock }));

import { usePresenterStore } from "../stores/presenterStore";
import { DEFAULT_TELEPROMPTER_TEXT } from "../lib/teleprompterDefaults";
import { makeProfile, makeSlide, profileIpcMock as ipc } from "../test/profileFixtures";
import { installPresenterEnv, presentLoaded, resetPresenterEnv, withTeleprompter } from "../test/presenterHarness";

beforeAll(installPresenterEnv);
beforeEach(() => {
  resetPresenterEnv();
});
afterEach(() => {
  cleanup();
  usePresenterStore.getState().clear();
  vi.useRealTimers();
});

const tele = () => usePresenterStore.getState().profile!.environment.teleprompter;
/** The element that carries the notes' typography. */
const column = () => screen.getByRole("region", { name: /Notes for slide/ }).querySelector("[data-direction]") as HTMLElement;
/** The overlay's outer frame, which holds the background colour. */
const frame = () => screen.getByRole("toolbar", { name: "Text controls" }).parentElement!.parentElement as HTMLElement;
const settle = () => act(() => { vi.advanceTimersByTime(400); });
const lastSaved = () => {
  const calls = ipc.updateTeleprompter.mock.calls;
  return calls[calls.length - 1]?.[1];
};

describe("font size", () => {
  it("A+ and A− change the size at once and save it after the debounce", async () => {
    await presentLoaded();
    vi.useFakeTimers();
    expect(column().style.fontSize).toBe("28px");
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(column().style.fontSize).toBe("30px");
    expect(ipc.updateTeleprompter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(column().style.fontSize).toBe("30px");
    settle();
    expect(ipc.updateTeleprompter).toHaveBeenCalledTimes(1);
    expect(ipc.updateTeleprompter).toHaveBeenCalledWith("p1", expect.objectContaining({ fontSize: 30 }));
  });

  it("stops at the limits", async () => {
    await presentLoaded(withTeleprompter({ fontSize: 96 }));
    expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();
    cleanup();
    usePresenterStore.getState().clear();
    await presentLoaded(withTeleprompter({ fontSize: 14 }));
    expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled();
    act(() => usePresenterStore.getState().patchTeleprompter({ fontSize: 15 }));
    fireEvent.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(tele().fontSize).toBe(14);
  });

  it("changes with the - and + keys, but not while typing in a field or while held", async () => {
    await presentLoaded();
    fireEvent.keyDown(window, { key: "+" });
    expect(tele().fontSize).toBe(30);
    fireEvent.keyDown(window, { key: "=" });
    expect(tele().fontSize).toBe(32);
    fireEvent.keyDown(window, { key: "-" });
    expect(tele().fontSize).toBe(30);
    fireEvent.keyDown(window, { key: "-", repeat: true });
    expect(tele().fontSize).toBe(30);
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(tele().fontSize).toBe(30);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "+" });
    expect(tele().fontSize).toBe(30);
    input.remove();
  });

  it("the slider in Settings sets the size too", async () => {
    await presentLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByRole("slider", { name: "Font size" }), { target: { value: "40" } });
    expect(column().style.fontSize).toBe("40px");
  });
});

describe("font family and direction", () => {
  it("lists installed fonts lazily and applies the choice with a fallback stack", async () => {
    await presentLoaded();
    expect(ipc.systemFonts).not.toHaveBeenCalled();
    const select = screen.getByRole("combobox", { name: "Font" });
    fireEvent.focus(select);
    await waitFor(() => expect(within(select).getByRole("option", { name: "Vazirmatn" })).toBeInTheDocument());
    expect(ipc.systemFonts).toHaveBeenCalledTimes(1);
    expect(within(select).getByRole("option", { name: "Default" })).toBeInTheDocument();

    vi.useFakeTimers();
    fireEvent.change(select, { target: { value: "Vazirmatn" } });
    const family = column().style.fontFamily;
    expect(family.indexOf("Vazirmatn")).toBeGreaterThanOrEqual(0);
    expect(family.indexOf("Vazirmatn")).toBeLessThan(family.indexOf("Segoe UI"));
    expect(family).toContain("Tahoma");
    expect(family).toContain("Noto Naskh Arabic");
    expect(family).toContain("sans-serif");
    settle();
    expect(lastSaved()).toMatchObject({ fontFamily: "Vazirmatn" });
  });

  it("keeps Default and says so when the font list cannot be read", async () => {
    ipc.systemFonts.mockRejectedValue(new Error("no fonts"));
    await presentLoaded();
    fireEvent.focus(screen.getByRole("combobox", { name: "Font" }));
    expect(await screen.findByText(/Fonts unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveValue("");
    expect(column().style.fontFamily).toContain("Segoe UI");
  });

  it("keeps a saved font that is not installed any more, rendered with fallbacks", async () => {
    await presentLoaded(withTeleprompter({ fontFamily: "Gone Sans" }));
    expect(screen.getByRole("combobox", { name: "Font" })).toHaveValue("Gone Sans");
    expect(column().style.fontFamily).toContain("Gone Sans");
    expect(column().style.fontFamily).toContain("Noto Sans Arabic");
  });

  it("LTR / RTL / Auto set the direction", async () => {
    await presentLoaded();
    vi.useFakeTimers();
    const auto = screen.getByRole("button", { name: "Auto" });
    expect(auto).toHaveAttribute("aria-pressed", "true");
    expect(column()).not.toHaveAttribute("dir");
    expect(screen.getByText("Notes for slide three")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Notes for slide three").style.unicodeBidi).toBe("plaintext");

    fireEvent.click(screen.getByRole("button", { name: "RTL" }));
    expect(screen.getByRole("button", { name: "RTL" })).toHaveAttribute("aria-pressed", "true");
    expect(auto).toHaveAttribute("aria-pressed", "false");
    expect(column()).toHaveAttribute("dir", "rtl");
    expect(column().style.unicodeBidi).toBe("isolate");
    expect(column().style.textAlign).toBe("start");

    fireEvent.click(screen.getByRole("button", { name: "LTR" }));
    expect(column()).toHaveAttribute("dir", "ltr");
    settle();
    expect(lastSaved()).toMatchObject({ textDirection: "ltr" });

    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    expect(column()).not.toHaveAttribute("dir");
  });

  it("renders mixed Persian and English notes exactly, paragraph by paragraph", async () => {
    const notes = "سلام hello\nhello سلام\n\n  می\u200Cخواهم ۱۲۳ \u200Fok\u200E\nPlain English line";
    await presentLoaded(makeProfile(), { slides: [makeSlide(1, "x"), makeSlide(3, notes)] });
    const paragraphs = Array.from(column().querySelectorAll("p"));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "سلام hello",
      "hello سلام",
      "  می\u200Cخواهم ۱۲۳ \u200Fok\u200E",
      "Plain English line",
    ]);
    expect(paragraphs.every((p) => p.getAttribute("dir") === "auto")).toBe(true);
    expect(paragraphs[2].className).toContain("whitespace-pre-wrap");
    // Forcing a direction keeps the text untouched.
    fireEvent.click(screen.getByRole("button", { name: "RTL" }));
    expect(Array.from(column().querySelectorAll("p")).map((p) => p.textContent)).toEqual(paragraphs.map((p) => p.textContent));
  });
});

describe("opacity", () => {
  it("only changes the background; the text stays solid", async () => {
    await presentLoaded();
    const textBefore = frame().style.color;
    const slider = screen.getByRole("slider", { name: "Background opacity" });
    expect(slider).toHaveAttribute("min", "0.3");
    expect(slider).toHaveAttribute("max", "1");
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(frame().style.background).toContain("rgba(0, 0, 0, 0.5)");
    expect(frame().style.color).toBe(textBefore);
    expect(column().style.opacity).toBe("");
    expect(frame().style.opacity).toBe("");
    expect(screen.getByRole("slider", { name: "Background opacity" })).toHaveAttribute("aria-valuetext", "50%");
  });

  it("never goes below 30 %", async () => {
    await presentLoaded();
    act(() => usePresenterStore.getState().patchTeleprompter({ opacity: 0.05 }));
    expect(frame().style.background).toContain("rgba(0, 0, 0, 0.3)");
    expect(screen.getByRole("slider", { name: "Background opacity" })).toHaveAttribute("aria-valuetext", "30%");
    act(() => usePresenterStore.getState().patchTeleprompter({ opacity: 7 }));
    expect(frame().style.background).toBe("rgb(0, 0, 0)");
  });
});

describe("settings panel", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Settings" }));

  it("opens non-modally, closes with Escape and returns focus to the button", async () => {
    await presentLoaded();
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    open();
    const panel = screen.getByRole("dialog", { name: "Presentation settings" });
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveTextContent(/dragging the top bar/);
    expect(panel).toHaveTextContent(/resize it from its edges/);
    // Opening takes no focus by itself.
    expect(panel.contains(document.activeElement)).toBe(false);
    const slider = within(panel).getByRole("slider", { name: "Font size" });
    slider.focus();
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Presentation settings" })).toBeNull();
    expect(document.activeElement).toBe(button);
    // Escape also works when focus is elsewhere.
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes line spacing, text width, full width, scroll speed and colours live", async () => {
    await presentLoaded();
    open();
    fireEvent.change(screen.getByRole("slider", { name: "Line spacing" }), { target: { value: "2" } });
    expect(column().style.lineHeight).toBe("2");
    fireEvent.change(screen.getByRole("slider", { name: "Text width" }), { target: { value: "40" } });
    expect(column().style.maxWidth).toBe("40ch");
    fireEvent.click(screen.getByRole("checkbox", { name: "Full width" }));
    expect(tele().lineChars).toBe(0);
    expect(column().style.maxWidth).toBe("");
    expect(screen.getByRole("slider", { name: "Text width" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Full width" }));
    expect(tele().lineChars).toBe(60);
    fireEvent.change(screen.getByRole("slider", { name: "Scroll speed" }), { target: { value: "45" } });
    expect(tele().scrollSpeed).toBe(45);

    const before = frame().style.color;
    fireEvent.change(screen.getByRole("combobox", { name: "Colour preset" }), { target: { value: "black_on_white" } });
    expect(frame().style.color).not.toBe(before);
    expect(frame().style.background).toContain("rgba(255, 255, 255");
  });

  it("pauses and resumes the auto-scroll", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    await presentLoaded(withTeleprompter({ scrollSpeed: 60 }));
    expect(raf).toHaveBeenCalled();
    open();
    raf.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Pause scrolling" }));
    expect(usePresenterStore.getState().scrollPaused).toBe(true);
    expect(screen.getByRole("button", { name: "Resume scrolling" })).toBeInTheDocument();
    cleanup();
    raf.mockClear();
    usePresenterStore.getState().clear();
    usePresenterStore.setState({ scrollPaused: true });
    await presentLoaded(withTeleprompter({ scrollSpeed: 60 }));
    usePresenterStore.setState({ scrollPaused: true });
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });

  it("restores the defaults (but keeps the window geometry)", async () => {
    await presentLoaded(withTeleprompter({
      fontSize: 60, fontFamily: "Vazirmatn", textDirection: "rtl", colorPreset: "green_on_black",
      lineSpacing: 2, lineChars: 30, opacity: 0.4, scrollSpeed: 80, x: 12, y: 34, width: 700, height: 300,
    }));
    vi.useFakeTimers();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    expect(tele()).toMatchObject({ ...DEFAULT_TELEPROMPTER_TEXT, x: 12, y: 34, width: 700, height: 300 });
    expect(column().style.fontSize).toBe("28px");
    settle();
    expect(lastSaved()).toMatchObject({ ...DEFAULT_TELEPROMPTER_TEXT, width: 700 });
  });
});

describe("per-meeting persistence", () => {
  it("keeps separate settings for two meetings", async () => {
    const a = { ...withTeleprompter({ fontSize: 40, textDirection: "rtl" }), id: "meeting-a" };
    const b = { ...withTeleprompter({ fontSize: 20, textDirection: "ltr" }), id: "meeting-b" };

    await presentLoaded(a);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    settle();
    expect(ipc.updateTeleprompter).toHaveBeenLastCalledWith("meeting-a", expect.objectContaining({ fontSize: 42, textDirection: "rtl" }));

    cleanup();
    usePresenterStore.getState().clear();
    vi.useRealTimers();
    await presentLoaded(b);
    expect(tele()).toMatchObject({ fontSize: 20, textDirection: "ltr" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Larger text" }));
    settle();
    expect(ipc.updateTeleprompter).toHaveBeenLastCalledWith("meeting-b", expect.objectContaining({ fontSize: 22, textDirection: "ltr" }));
    expect(ipc.updateTeleprompter).toHaveBeenCalledTimes(2);

    // Reopening the first meeting shows its own saved values, not the other's.
    cleanup();
    usePresenterStore.getState().clear();
    vi.useRealTimers();
    await presentLoaded({ ...a, environment: { ...a.environment, teleprompter: { ...a.environment.teleprompter, fontSize: 42 } } });
    expect(tele()).toMatchObject({ fontSize: 42, textDirection: "rtl" });
  });
});

import { describe, expect, it } from "vitest";
import { chooseNexqDisplay, clampToDisplay, screenShareWarnings, teleprompterRect } from "./overlayPlacement";
import type { DisplayInfo, EnvironmentSettings } from "./profileTypes";

const d = (index: number, x: number, width = 1920, height = 1080): DisplayInfo => ({
  index, name: `D${index}`, x, y: 0, width, height, scaleFactor: 1, isPrimary: index === 0,
});

const env = (over: Partial<EnvironmentSettings> = {}): EnvironmentSettings => ({
  monitorCount: 2, autoDetectDisplays: true, primaryMonitor: 0, presentationMonitor: 1, nexqMonitor: 0,
  webcamPosition: "top_center", screenShare: "display",
  teleprompter: {
    fontSize: 28, fontFamily: "", textDirection: "auto", colorPreset: "auto", lineSpacing: 1.45,
    lineChars: 60, opacity: 0.9, scrollSpeed: 0, highContrast: true, x: 0, y: 0, width: 900, height: 220,
  },
  ...over,
});

describe("overlay placement", () => {
  it("centres notes under the webcam on the NexQ monitor, not the shared one", () => {
    const displays = [d(0, 0), d(1, 1920)];
    const nexq = chooseNexqDisplay(displays, env())!;
    expect(nexq.index).toBe(0);
    const r = teleprompterRect(nexq, "top_center", { width: 900, height: 220 });
    expect(r).toEqual({ x: 510, y: 24, width: 900, height: 220 });
  });

  it("supports corner webcams, secondary-monitor offsets and clamping", () => {
    const second = d(1, 1920);
    expect(teleprompterRect(second, "top_right", { width: 900, height: 220 }).x).toBe(1920 + 1920 - 900 - 24);
    expect(teleprompterRect(second, "top_left", { width: 900, height: 220 }).x).toBe(1920 + 24);
    const huge = clampToDisplay({ x: -500, y: 5000, width: 9000, height: 9000 }, second);
    expect(huge).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 });
  });

  it("one monitor always uses the only display", () => {
    expect(chooseNexqDisplay([d(0, 0)], env({ nexqMonitor: 1 }))!.index).toBe(0);
    expect(chooseNexqDisplay([d(0, 0), d(1, 1920)], env({ monitorCount: 1, nexqMonitor: 1 }))!.index).toBe(0);
    expect(chooseNexqDisplay([], env())).toBeNull();
  });
});

describe("screen-share warnings", () => {
  it("never claims invisibility and warns when NexQ shares the shared display", () => {
    const w = screenShareWarnings(env({ monitorCount: 1, screenShare: "display" }), 1);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/does not hide itself/i);
    expect(w[0]).not.toMatch(/\bis hidden\b|invisible/i);
  });

  it("is quiet for the recommended two-monitor layout and flags a missing monitor", () => {
    expect(screenShareWarnings(env(), 2)).toEqual([]);
    expect(screenShareWarnings(env(), 1).some((m) => m.includes("only 1 detected"))).toBe(true);
    expect(screenShareWarnings(env({ nexqMonitor: 1 }), 2)).toHaveLength(1);
  });

  it("covers window sharing and no sharing on one monitor", () => {
    expect(screenShareWarnings(env({ monitorCount: 1, screenShare: "window" }), 1)[0]).toMatch(/one window/);
    expect(screenShareWarnings(env({ monitorCount: 1, screenShare: "none" }), 1)[0]).toMatch(/compact/);
  });
});

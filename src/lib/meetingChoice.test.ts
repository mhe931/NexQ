import { describe, expect, it } from "vitest";
import { findExistingPresentationQa, platformForApp, recentProfiles } from "./meetingChoice";
import type { ProfileSummary } from "./profileTypes";

const p = (id: string, over: Partial<ProfileSummary> = {}): ProfileSummary => ({
  id, name: id, meetingType: "general", platform: "other", meetingDate: null, primaryProvider: null, primaryModel: null,
  documentCount: 0, sessionCount: 0, updatedAt: "2026-01-01T00:00:00Z", lastUsedAt: null, presentationName: null, ...over,
});

describe("recentProfiles", () => {
  it("orders by the last session start, falling back to the last edit", () => {
    const list = [
      p("edited-recently", { updatedAt: "2026-03-01T00:00:00Z" }),
      p("used-long-ago", { updatedAt: "2026-05-01T00:00:00Z", lastUsedAt: "2026-02-01T00:00:00Z" }),
      p("used-yesterday", { updatedAt: "2025-01-01T00:00:00Z", lastUsedAt: "2026-04-01T00:00:00Z" }),
    ];
    expect(recentProfiles(list).map((x) => x.id)).toEqual(["used-yesterday", "edited-recently", "used-long-ago"]);
  });

  it("can be limited to Presentation + Q&A and to a number of rows, without mutating its input", () => {
    const list = [
      p("a", { meetingType: "presentation_qa", lastUsedAt: "2026-01-02T00:00:00Z" }),
      p("b", { meetingType: "interview", lastUsedAt: "2026-01-09T00:00:00Z" }),
      p("c", { meetingType: "presentation_qa", lastUsedAt: "2026-01-05T00:00:00Z" }),
    ];
    const copy = [...list];
    expect(recentProfiles(list, "presentation_qa").map((x) => x.id)).toEqual(["c", "a"]);
    expect(recentProfiles(list, undefined, 1).map((x) => x.id)).toEqual(["b"]);
    expect(list).toEqual(copy);
  });
});

describe("detected-call helpers", () => {
  it("maps the detector's apps onto a profile platform", () => {
    expect(["zoom", "teams", "google_meet", "webex", "jitsi"].map(platformForApp)).toEqual(["zoom", "teams", "meet", "other", "other"]);
  });

  it("finds an existing Presentation + Q&A meeting by name so none is duplicated", () => {
    const list = [p("x", { name: "Thesis defence", meetingType: "presentation_qa" }), p("y", { name: "Thesis defence", meetingType: "general" })];
    expect(findExistingPresentationQa(list, "  thesis DEFENCE ")?.id).toBe("x");
    expect(findExistingPresentationQa(list, "Other")).toBeNull();
  });
});

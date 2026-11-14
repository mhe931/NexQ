import { describe, expect, it } from "vitest";
import { parseAnswer } from "./answerFormat";

describe("parseAnswer", () => {
  it("separates sequential actions from the answer to say aloud", () => {
    const parsed = parseAnswer(
      "[ACTION] Open the project dashboard.\n[ACTION] Share monitor 2.\n[ANSWER] The dashboard shows ice drift.\n[SOURCE] thesis.docx — section \"Results\"\n",
    );
    expect(parsed.actions.map((a) => [a.step, a.text])).toEqual([
      [1, "Open the project dashboard."],
      [2, "Share monitor 2."],
    ]);
    expect(parsed.blocks.map((b) => b.kind)).toEqual(["action", "action", "answer", "source"]);
    expect(parsed.streaming).toBe(false);
  });

  it("keeps a plain reply as text and marks partial streams", () => {
    const parsed = parseAnswer("Direct answer first.\nThen support");
    expect(parsed.blocks).toEqual([{ kind: "text", text: "Direct answer first. Then support" }]);
    expect(parsed.actions).toEqual([]);
    expect(parsed.streaming).toBe(true);
  });

  it("tolerates bullets, bold tags and wrapped action lines", () => {
    const parsed = parseAnswer("- **[ACTION]** Navigate to the\nsettings page.\n* [answer] Done.");
    expect(parsed.actions[0].text).toBe("Navigate to the settings page.");
    expect(parsed.blocks[1]).toEqual({ kind: "answer", text: "Done." });
  });

  it("never treats tags inside a sentence as structure", () => {
    const parsed = parseAnswer("Use the [ACTION] tag sparingly.");
    expect(parsed.actions).toHaveLength(0);
    expect(parsed.blocks[0].kind).toBe("text");
  });
});
